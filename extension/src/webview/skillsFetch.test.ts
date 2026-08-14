import { expect, test } from "bun:test";

import {
  fetchSkillsFromGitHub,
  isSafeRelPath,
  looksLikeSkill,
  parseGitHubSkillUrl,
  rawUrl,
  skillDirsUnder,
  skillFileEntries,
  skillNameFromDir,
  type TreeEntry,
} from "./skillsFetch";

// ── URL parsing ─────────────────────────────────────────────────────────────

test("parseGitHubSkillUrl: folder link → owner/repo/ref/subPath (trailing slash ok)", () => {
  expect(parseGitHubSkillUrl("https://github.com/anthropics/skills/tree/main/skills/")).toEqual({
    owner: "anthropics",
    repo: "skills",
    ref: "main",
    subPath: "skills",
  });
});

test("parseGitHubSkillUrl: bare repo → no ref (caller asks for the default branch)", () => {
  expect(parseGitHubSkillUrl("https://github.com/anthropics/skills")).toEqual({
    owner: "anthropics",
    repo: "skills",
    ref: undefined,
    subPath: "",
  });
  expect(parseGitHubSkillUrl("https://github.com/anthropics/skills.git")?.repo).toBe("skills");
});

test("parseGitHubSkillUrl: blob/raw link points at a FILE → search its folder", () => {
  expect(parseGitHubSkillUrl("https://github.com/o/r/blob/main/skills/pdf/SKILL.md")).toEqual({
    owner: "o",
    repo: "r",
    ref: "main",
    subPath: "skills/pdf",
  });
  expect(parseGitHubSkillUrl("https://raw.githubusercontent.com/o/r/main/skills/pdf/SKILL.md")).toEqual({
    owner: "o",
    repo: "r",
    ref: "main",
    subPath: "skills/pdf",
  });
});

test("parseGitHubSkillUrl: rejects other hosts, non-tree paths, and traversal", () => {
  expect(parseGitHubSkillUrl("https://gitlab.com/o/r")).toBeNull();
  expect(parseGitHubSkillUrl("https://github.com/o/r/issues/12")).toBeNull();
  expect(parseGitHubSkillUrl("https://github.com/o")).toBeNull();
  expect(parseGitHubSkillUrl("not a url")).toBeNull();
  expect(parseGitHubSkillUrl("https://github.com/o/r/tree/main/../../etc")).toBeNull();
});

// ── Finding the skills in a tree ────────────────────────────────────────────

const blob = (path: string, size = 10): TreeEntry => ({ path, type: "blob", size });
const REAL_SHAPE: TreeEntry[] = [
  { path: "skills", type: "tree" },
  blob("README.md"),
  blob("skills/pdf/SKILL.md"),
  blob("skills/pdf/scripts/fill.py"),
  blob("skills/pdf/references/forms.md"),
  blob("skills/xlsx/SKILL.md"),
  blob("template/SKILL.md"),
];

test("skillDirsUnder: every SKILL.md folder under the pasted subPath, and only those", () => {
  expect(skillDirsUnder(REAL_SHAPE, "skills")).toEqual(["skills/pdf", "skills/xlsx"]);
  expect(skillDirsUnder(REAL_SHAPE, "skills/")).toEqual(["skills/pdf", "skills/xlsx"]);
  // whole repo → template/ counts too
  expect(skillDirsUnder(REAL_SHAPE, "")).toEqual(["skills/pdf", "skills/xlsx", "template"]);
  // one skill's own folder
  expect(skillDirsUnder(REAL_SHAPE, "skills/pdf")).toEqual(["skills/pdf"]);
});

test("skillDirsUnder: SKILL.md at the repo root → the root itself", () => {
  expect(skillDirsUnder([blob("SKILL.md"), blob("scripts/run.sh")], "")).toEqual([""]);
});

test("skillDirsUnder: MYSKILL.md is not SKILL.md; a nested skill is not installed twice", () => {
  expect(skillDirsUnder([blob("a/MYSKILL.md")], "")).toEqual([]);
  // a skill that ships a sample skill inside it → only the outer one
  expect(skillDirsUnder([blob("a/SKILL.md"), blob("a/example/SKILL.md")], "")).toEqual(["a"]);
});

test("skillFileEntries: every blob of the folder, relative, unsafe paths dropped", () => {
  const rels = skillFileEntries(REAL_SHAPE, "skills/pdf").map((e) => e.rel);
  expect(rels).toEqual(["SKILL.md", "scripts/fill.py", "references/forms.md"]);
  // a submodule (type commit) and a hostile name never make it out
  const dirty = [blob("a/SKILL.md"), { path: "a/sub", type: "commit" }, blob("a/../../etc/passwd")];
  expect(skillFileEntries(dirty, "a").map((e) => e.rel)).toEqual(["SKILL.md"]);
});

test("isSafeRelPath: absolute, traversal, backslash, NUL and deep nesting rejected", () => {
  expect(isSafeRelPath("SKILL.md")).toBe(true);
  expect(isSafeRelPath("references/a-b_c.1.md")).toBe(true);
  expect(isSafeRelPath("/etc/passwd")).toBe(false);
  expect(isSafeRelPath("../x")).toBe(false);
  expect(isSafeRelPath("a/../../x")).toBe(false);
  expect(isSafeRelPath("a\\b")).toBe(false);
  expect(isSafeRelPath("a\0b")).toBe(false);
  expect(isSafeRelPath("a/ b")).toBe(false); // space → not in the whitelist
  expect(isSafeRelPath("a/".repeat(13) + "x")).toBe(false);
});

test("skillNameFromDir: folder name, or the repo name at the root; slugified", () => {
  expect(skillNameFromDir("skills/pdf", "skills")).toBe("pdf");
  expect(skillNameFromDir("", "my-skill")).toBe("my-skill");
  expect(skillNameFromDir("skills/My Skill!", "r")).toBe("My-Skill");
});

test("rawUrl: each path segment encoded separately so / stays a separator", () => {
  expect(rawUrl("o", "r", "main", "skills/my pdf/SKILL.md")).toBe(
    "https://raw.githubusercontent.com/o/r/main/skills/my%20pdf/SKILL.md",
  );
});

// ── End-to-end against a stubbed GitHub ─────────────────────────────────────

function stubGitHub(
  tree: TreeEntry[],
  opts: {
    truncated?: boolean;
    defaultBranch?: string;
    /** repo path of a SKILL.md → body. Anything unlisted gets a valid skill. */
    skillMd?: Record<string, string>;
  } = {},
) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) =>
      ({ ok: true, status: 200, statusText: "OK", json: async () => body }) as unknown as Response;
    if (url.includes("/git/trees/")) return json({ tree, truncated: !!opts.truncated });
    if (url.startsWith("https://api.github.com/repos/")) {
      return json({ default_branch: opts.defaultBranch ?? "main" });
    }
    let body = "body of " + url;
    if (url.endsWith("/SKILL.md")) {
      const repoPath = url.split("/").slice(6).join("/"); // …/<owner>/<repo>/<ref>/<path>
      body = opts.skillMd?.[repoPath] ?? "---\nname: x\ndescription: d\n---\nbody of " + url;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("fetchSkillsFromGitHub: one folder link → every skill under it, files intact", async () => {
  const { impl, calls } = stubGitHub(REAL_SHAPE);
  const res = await fetchSkillsFromGitHub("https://github.com/anthropics/skills/tree/main/skills/", {
    fetchImpl: impl,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.skills.map((s) => s.name)).toEqual(["pdf", "xlsx"]);
  expect(res.skills[0].files.map((f) => f.rel)).toEqual([
    "SKILL.md",
    "scripts/fill.py",
    "references/forms.md",
  ]);
  expect(res.skills[0].files[0].data.toString()).toContain("skills/pdf/SKILL.md");
  // the ref came from the URL → no repo lookup needed
  expect(calls.some((c) => c === "https://api.github.com/repos/anthropics/skills")).toBe(false);
});

test("fetchSkillsFromGitHub: no ref in the URL → default branch is looked up and used", async () => {
  const { impl, calls } = stubGitHub(REAL_SHAPE, { defaultBranch: "trunk" });
  const res = await fetchSkillsFromGitHub("https://github.com/o/r", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  expect(calls.some((c) => c.includes("/git/trees/trunk?recursive=1"))).toBe(true);
  expect(calls.some((c) => c.includes("raw.githubusercontent.com/o/r/trunk/"))).toBe(true);
});

test("fetchSkillsFromGitHub: already-installed names are skipped BEFORE any download", async () => {
  const { impl, calls } = stubGitHub(REAL_SHAPE);
  const res = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/skills", {
    fetchImpl: impl,
    skipName: (n) => n === "pdf",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.skills.map((s) => s.name)).toEqual(["xlsx"]);
  expect(res.skipped).toEqual(["pdf"]);
  expect(calls.some((c) => c.includes("/skills/pdf/"))).toBe(false); // nothing downloaded for it
});

test("fetchSkillsFromGitHub: progress is reported per skill", async () => {
  const { impl } = stubGitHub(REAL_SHAPE);
  const seen: string[] = [];
  await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/skills", {
    fetchImpl: impl,
    onProgress: (p) => seen.push(p.done + "/" + p.total + ":" + p.name),
  });
  expect(seen).toEqual(["0/2:pdf", "1/2:xlsx", "2/2:"]);
});

test("fetchSkillsFromGitHub: typed messages for bad URL / no skills / http failure", async () => {
  const { impl } = stubGitHub(REAL_SHAPE);
  const bad = await fetchSkillsFromGitHub("https://gitlab.com/o/r", { fetchImpl: impl });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.message).toContain("GitHub");

  const empty = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/docs", { fetchImpl: impl });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.message).toContain("No skill found");

  const dead = (async () =>
    ({ ok: false, status: 404, statusText: "Not Found" }) as unknown as Response) as unknown as typeof fetch;
  const gone = await fetchSkillsFromGitHub("https://github.com/o/r", { fetchImpl: dead });
  expect(gone.ok).toBe(false);
  if (!gone.ok) expect(gone.message).toContain("404");
});

test("fetchSkillsFromGitHub: a truncated tree warns instead of silently under-installing", async () => {
  const { impl } = stubGitHub(REAL_SHAPE, { truncated: true });
  const res = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/skills", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.warning).toBeTruthy();
});

// ── "is there really a skill here?" — checked before anything bulky is pulled ──

test("looksLikeSkill: frontmatter with a name is the bar; a plain markdown file is not a skill", () => {
  expect(looksLikeSkill("---\nname: pdf\ndescription: d\n---\nbody")).toBe(true);
  expect(looksLikeSkill("---\r\nname: pdf\r\n---\r\nbody")).toBe(true); // CRLF
  expect(looksLikeSkill("---\ndescription: d\n---\nbody")).toBe(false); // no name
  expect(looksLikeSkill("---\nname:\n---\nbody")).toBe(false); // empty name
  expect(looksLikeSkill("# How to write a SKILL.md\nsome docs")).toBe(false);
  expect(looksLikeSkill("")).toBe(false);
});

test("fetchSkillsFromGitHub: a URL with no real skill downloads NOTHING and says so", async () => {
  const tree = [blob("docs/SKILL.md"), blob("docs/big.bin", 5_000_000), blob("docs/more.md")];
  const { impl, calls } = stubGitHub(tree, { skillMd: { "docs/SKILL.md": "# just a doc about skills" } });
  const res = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/docs", { fetchImpl: impl });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toContain("No skill found");
  // only the tree + that one SKILL.md were fetched — no bulk files
  expect(calls.filter((c) => c.includes("raw.githubusercontent.com"))).toEqual([
    "https://raw.githubusercontent.com/o/r/main/docs/SKILL.md",
  ]);
});

test("fetchSkillsFromGitHub: mixed folder → real skills installed, fakes reported not installed", async () => {
  const tree = [
    blob("skills/real/SKILL.md"),
    blob("skills/real/notes.md"),
    blob("skills/fake/SKILL.md"),
    blob("skills/fake/huge.bin", 9_000_000),
  ];
  const { impl, calls } = stubGitHub(tree, { skillMd: { "skills/fake/SKILL.md": "no frontmatter here" } });
  const res = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/skills", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.skills.map((s) => s.name)).toEqual(["real"]);
  expect(res.warning).toContain("fake");
  expect(calls.some((c) => c.includes("huge.bin"))).toBe(false); // never paid for the fake's files
});

test("fetchSkillsFromGitHub: SKILL.md from the check pass is reused, not downloaded twice", async () => {
  const { impl, calls } = stubGitHub(REAL_SHAPE);
  const res = await fetchSkillsFromGitHub("https://github.com/o/r/tree/main/skills/pdf", { fetchImpl: impl });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.skills[0].files.map((f) => f.rel)).toEqual([
    "SKILL.md",
    "scripts/fill.py",
    "references/forms.md",
  ]);
  expect(calls.filter((c) => c.endsWith("/skills/pdf/SKILL.md")).length).toBe(1);
});

test("fetchSkillsFromGitHub: caps stop a runaway repo", async () => {
  const many = Array.from({ length: 5 }, (_, i) => blob(`s${i}/SKILL.md`));
  const { impl } = stubGitHub(many);
  const res = await fetchSkillsFromGitHub("https://github.com/o/r", {
    fetchImpl: impl,
    caps: { maxFileBytes: 1, maxSkillBytes: 1e9, maxTotalBytes: 1e9, maxFilesPerSkill: 100, maxSkills: 3 },
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.message).toContain("5");
});
