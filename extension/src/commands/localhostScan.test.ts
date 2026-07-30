import { expect, test } from "bun:test";

import {
  parseSsListeners,
  parsePsOutput,
  projectFromCwd,
  guessRole,
  groupListeners,
  scanLocalhosts,
  scanLocalhostsEnriched,
  getProjectsRoot,
  classifyKind,
  prettyCmd,
  formatUptime,
  parsePsFull,
  type RawListener,
} from "./localhostScan";

const ROOT = "/home/u/github.com/owner/projects";

test("parseSsListeners: extracts port+pid for ipv4/ipv6, skips root-owned (no pid)", () => {
  const ss = [
    'LISTEN 0 2048  0.0.0.0:8000  0.0.0.0:*  users:(("python3",pid=15740,fd=3))',
    'LISTEN 0 511   127.0.0.1:3000 0.0.0.0:*  users:(("next-server",pid=15648,fd=21))',
    "LISTEN 0 4096  [::1]:6379    [::]:*",
    'LISTEN 0 128   [::]:3350     [::]:*      users:(("xrdp",pid=900,fd=11))',
  ].join("\n");
  expect(parseSsListeners(ss)).toEqual([
    { port: 8000, pid: 15740 },
    { port: 3000, pid: 15648 },
    { port: 3350, pid: 900 },
  ]);
});

test("parsePsOutput: parses pid/pgid/comm incl. a comm with a space", () => {
  const out = "15740 15371 python3\n15648 15371 next-server v1\n";
  const m = parsePsOutput(out);
  expect(m.get(15740)).toEqual({ pgid: 15371, comm: "python3" });
  expect(m.get(15648)).toEqual({ pgid: 15371, comm: "next-server v1" });
});

test("projectFromCwd: inside → name, outside/null → null", () => {
  expect(projectFromCwd(`${ROOT}/learningPlatform/apps/api`, ROOT)).toBe("learningPlatform");
  expect(projectFromCwd(`${ROOT}/shopApp`, ROOT)).toBe("shopApp");
  expect(projectFromCwd("/home/u", ROOT)).toBeNull();
  expect(projectFromCwd(null, ROOT)).toBeNull();
  expect(projectFromCwd(`${ROOT}`, ROOT)).toBeNull(); // root itself, no project segment
});

test("guessRole: api vs web fallback", () => {
  expect(guessRole("uvicorn", 8000)).toBe("api");
  expect(guessRole("next-server", 3000)).toBe("web");
  expect(guessRole("node", 5173)).toBe("web");
  expect(guessRole("something", 9999)).toBe("srv");
});

test("groupListeners: groups by project, sorts, drops unattributable", () => {
  const raws: RawListener[] = [
    { port: 8000, pid: 2, cwd: `${ROOT}/learningPlatform/apps/api`, pgid: 100, comm: "uvicorn" },
    { port: 3000, pid: 1, cwd: `${ROOT}/learningPlatform/apps/web`, pgid: 100, comm: "next-server" },
    { port: 5173, pid: 3, cwd: `${ROOT}/shopApp`, pgid: 200, comm: "node" },
    { port: 9, pid: 4, cwd: "/home/u", pgid: 300, comm: "code" }, // dropped
  ];
  const groups = groupListeners(raws, ROOT);
  expect(groups.map((g) => g.project)).toEqual(["learningPlatform", "shopApp"]);
  expect(groups[0].entries.map((e) => e.port)).toEqual([3000, 8000]); // sorted by port
  expect(groups[0].entries[0]).toEqual({ port: 3000, pid: 1, pgid: 100, comm: "next-server", role: "web" });
});

test("scanLocalhosts: returns an array and never throws", () => {
  const groups = scanLocalhosts();
  expect(Array.isArray(groups)).toBe(true);
  // getProjectsRoot is null OR an absolute path ending in /projects
  const root = getProjectsRoot();
  expect(root === null || root.endsWith("/projects")).toBe(true);
});

test("scanLocalhostsEnriched: returns an array and never throws", () => {
  expect(Array.isArray(scanLocalhostsEnriched())).toBe(true);
});

test("classifyKind: db/docs win over web/api; args disambiguate node; port fallback; else null", () => {
  expect(classifyKind("postgres", "", 5432)).toBe("db");
  expect(classifyKind("node", "redis-server", 6380)).toBe("db"); // arg wins
  expect(classifyKind("node", "storybook dev -p 6006", 6006)).toBe("docs");
  expect(classifyKind("next-server", "", 3000)).toBe("web");
  expect(classifyKind("node", "vite --host", 5199)).toBe("web"); // vite arg → web, not api
  expect(classifyKind("uvicorn", "app:api", 8000)).toBe("api");
  expect(classifyKind("node", "", 9999)).toBe("api"); // bare node → api
  expect(classifyKind("mystery", "", 5432)).toBe("db"); // port fallback
  expect(classifyKind("mystery", "", 3000)).toBe("web");
  expect(classifyKind("mystery", "", 4000)).toBe("api");
  expect(classifyKind("mystery", "", 9999)).toBeNull();
});

test("prettyCmd: path tokens → basename; falls back to comm when no args", () => {
  expect(prettyCmd("/home/u/.local/bin/uvicorn app:api", "python3")).toBe("uvicorn app:api");
  expect(prettyCmd("/usr/bin/node /p/node_modules/.bin/vite --host", "node")).toBe("node vite --host");
  expect(prettyCmd("", "next-server")).toBe("next-server");
  expect(prettyCmd("   ", "postgres")).toBe("postgres");
});

test("formatUptime: seconds → compact d/h/m/s", () => {
  expect(formatUptime(45)).toBe("45s");
  expect(formatUptime(600)).toBe("10m");
  expect(formatUptime(3720)).toBe("1h 2m");
  expect(formatUptime(90000)).toBe("1d 1h");
  expect(formatUptime(-1)).toBe("");
});

test("parsePsFull: pid/rss/etimes/args incl. args with spaces", () => {
  const m = parsePsFull("15740 123456 3720 /usr/bin/python3 -m uvicorn app:api\n15648 65536 45 node\n");
  expect(m.get(15740)).toEqual({ rssKB: 123456, etimes: 3720, args: "/usr/bin/python3 -m uvicorn app:api" });
  expect(m.get(15648)).toEqual({ rssKB: 65536, etimes: 45, args: "node" });
});
