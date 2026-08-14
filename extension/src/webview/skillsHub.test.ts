import { expect, test } from "bun:test";

import {
  browseHub,
  fetchHubSkill,
  isSafeHubName,
  isSafeHubVersion,
  normalizeHubItem,
} from "./skillsHub";

// Shapes copied from the live registry (GET /api/v1/packages?family=skill).
const PKG = {
  name: "xrowgmbh-image-generation",
  ownerHandle: "xrowgmbh",
  displayName: "Image Generation",
  summary: "Create or revise images.",
  latestVersion: "1.81.1",
  family: "skill",
  isOfficial: false,
  stats: { downloads: 3358, installs: 14, stars: 2, versions: 63 },
};

test("normalizeHubItem: registry row → card fields", () => {
  expect(normalizeHubItem(PKG)).toEqual({
    name: "xrowgmbh-image-generation",
    owner: "xrowgmbh",
    displayName: "Image Generation",
    summary: "Create or revise images.",
    version: "1.81.1",
    downloads: 3358,
    installs: 14,
    stars: 2,
    official: false,
  });
});

test("normalizeHubItem: drops rows that cannot be installed safely", () => {
  expect(normalizeHubItem({ ...PKG, name: "../../etc/passwd" })).toBeNull();
  expect(normalizeHubItem({ ...PKG, name: "a/b" })).toBeNull();
  expect(normalizeHubItem({ ...PKG, latestVersion: undefined })).toBeNull();
  expect(normalizeHubItem({ ...PKG, family: "plugin" })).toBeNull(); // not a skill
  expect(normalizeHubItem(null)).toBeNull();
  expect(normalizeHubItem({ ...PKG, stats: undefined })?.downloads).toBe(0); // missing stats ≠ crash
});

test("isSafeHubName / isSafeHubVersion: whitelist only", () => {
  expect(isSafeHubName("pskoett-self-improving-agent")).toBe(true);
  expect(isSafeHubName("a..b")).toBe(false);
  expect(isSafeHubName("a b")).toBe(false);
  expect(isSafeHubName("")).toBe(false);
  expect(isSafeHubVersion("1.81.1")).toBe(true);
  expect(isSafeHubVersion("2.0.0-beta.1+build")).toBe(true);
  expect(isSafeHubVersion("../1")).toBe(false);
});

function stubHub(opts: {
  items?: unknown[];
  results?: unknown[];
  nextCursor?: string;
  files?: Array<{ path: string; size?: number }>;
  fileBody?: (path: string) => string;
  fail?: number;
}) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (opts.fail) {
      return { ok: false, status: opts.fail, statusText: "Boom" } as unknown as Response;
    }
    const json = (b: unknown) =>
      ({ ok: true, status: 200, statusText: "OK", json: async () => b }) as unknown as Response;
    if (url.includes("/packages/search")) return json({ results: opts.results ?? [] });
    if (url.includes("/versions/")) return json({ version: { files: opts.files ?? [] } });
    if (url.includes("/file?")) {
      const p = decodeURIComponent(new URL(url).searchParams.get("path") ?? "");
      const body = opts.fileBody ? opts.fileBody(p) : "content of " + p;
      return {
        ok: true, status: 200, statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      } as unknown as Response;
    }
    return json({ items: opts.items ?? [], nextCursor: opts.nextCursor });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("browseHub: no query → most-downloaded first page, cursor carried", async () => {
  const { impl, calls } = stubHub({ items: [PKG], nextCursor: "CUR1" });
  const res = await browseHub({ fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.items.map((i) => i.name)).toEqual(["xrowgmbh-image-generation"]);
  expect(res.value.nextCursor).toBe("CUR1");
  expect(calls[0]).toContain("family=skill");
  expect(calls[0]).toContain("sort=downloads");
});

test("browseHub: a cursor continues the same browse", async () => {
  const { impl, calls } = stubHub({ items: [PKG] });
  await browseHub({ cursor: "CUR1", fetchImpl: impl });
  expect(calls[0]).toContain("cursor=CUR1");
});

test("browseHub: a query switches to search (results[].package, no cursor)", async () => {
  const { impl, calls } = stubHub({ results: [{ score: 65, package: PKG }], nextCursor: "X" });
  const res = await browseHub({ q: "image gen", fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.items.map((i) => i.name)).toEqual(["xrowgmbh-image-generation"]);
  expect(res.value.nextCursor).toBeNull(); // search has no pagination
  expect(calls[0]).toContain("/packages/search");
  expect(calls[0]).toContain("q=image%20gen");
});

test("browseHub: a dead registry is a typed message, never a throw", async () => {
  const { impl } = stubHub({ fail: 503 });
  const res = await browseHub({ fetchImpl: impl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toContain("503");
});

test("fetchHubSkill: downloads every listed file, keyed relative to the skill root", async () => {
  const { impl } = stubHub({
    files: [{ path: "SKILL.md", size: 10 }, { path: "scripts/run.py", size: 20 }],
  });
  const res = await fetchHubSkill("xrowgmbh-image-generation", "1.81.1", "xrowgmbh", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.value.name).toBe("xrowgmbh-image-generation"); // local folder = package name
  expect(res.value.files.map((f) => f.rel)).toEqual(["SKILL.md", "scripts/run.py"]);
  expect(res.value.files[0].data.toString()).toBe("content of SKILL.md");
});

test("fetchHubSkill: a package with no SKILL.md is refused before any file is pulled", async () => {
  const { impl, calls } = stubHub({ files: [{ path: "README.md" }] });
  const res = await fetchHubSkill("some-pkg", "1.0.0", "o", { fetchImpl: impl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toContain("No SKILL.md");
  expect(calls.some((c) => c.includes("/file?"))).toBe(false);
});

test("fetchHubSkill: hostile paths in the listing are dropped, not written", async () => {
  const { impl } = stubHub({
    files: [{ path: "SKILL.md" }, { path: "../../.bashrc" }, { path: "/etc/passwd" }],
  });
  const res = await fetchHubSkill("p", "1.0.0", "o", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.value.files.map((f) => f.rel)).toEqual(["SKILL.md"]);
});

test("fetchHubSkill: every call carries ?owner= (names are not unique on ClawHub)", async () => {
  const { impl, calls } = stubHub({ files: [{ path: "SKILL.md" }] });
  await fetchHubSkill("self-improving-agent", "4.0.2", "pskoett", { fetchImpl: impl });
  expect(calls[0]).toContain("owner=pskoett"); // version listing → 409 without it
  expect(calls[1]).toContain("owner=pskoett"); // file download too
});

test("fetchHubSkill: unsafe name/version never reach the network", async () => {
  const { impl, calls } = stubHub({ files: [{ path: "SKILL.md" }] });
  expect((await fetchHubSkill("../evil", "1.0.0", "o", { fetchImpl: impl })).ok).toBe(false);
  expect((await fetchHubSkill("ok", "../1", "o", { fetchImpl: impl })).ok).toBe(false);
  expect(calls.length).toBe(0);
});

test("fetchHubSkill: caps stop an oversized package", async () => {
  const { impl } = stubHub({ files: [{ path: "SKILL.md", size: 99_000_000 }] });
  const res = await fetchHubSkill("p", "1.0.0", "o", {
    fetchImpl: impl,
    caps: { maxFileBytes: 1e9, maxSkillBytes: 1000, maxTotalBytes: 1e9, maxFilesPerSkill: 10, maxSkills: 10 },
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toContain("Too big");
});
