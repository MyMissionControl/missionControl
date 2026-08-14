import { expect, test } from "bun:test";

import { buildResumeKickoff } from "./teams";
import {
  classifyDriven,
  dedupeByRealpath,
  defaultTeamForProject,
  isProjectLive,
  isResumable,
  nextSprintFromPlan,
  parseOrchesMeta,
  parsePlan,
  parseStateValue,
  orderForProjectScreen,
  partitionStarred,
  projectScanDirs,
  type ResumableProject,
  serializeOrchesMeta,
  sortResumable,
  toggleStar,
} from "./orchestratorResume";

test("classifyDriven: priority worker > run > owner > labeled > none", () => {
  const base = { workerLive: false, runAlive: false, ownerAlive: false, labelMatch: false };
  expect(classifyDriven({ workerLive: true, runAlive: true, ownerAlive: true, labelMatch: true })).toBe("worker");
  expect(classifyDriven({ ...base, runAlive: true, ownerAlive: true, labelMatch: true })).toBe("run");
  expect(classifyDriven({ ...base, ownerAlive: true, labelMatch: true })).toBe("owner");
  expect(classifyDriven({ ...base, labelMatch: true })).toBe("labeled");
  expect(classifyDriven(base)).toBe("none");
});

test("parseStateValue: read a key from .orches-state colon format (trim; null if absent)", () => {
  const raw = "owner-session: 09-foreman\nteam: brew\nstatus: in-progress\n";
  expect(parseStateValue(raw, "owner-session")).toBe("09-foreman");
  expect(parseStateValue(raw, "team")).toBe("brew");
  expect(parseStateValue(raw, "sprint")).toBeNull(); // absent
  expect(parseStateValue("", "owner-session")).toBeNull();
  expect(parseStateValue("owner-session:    05-bob   ", "owner-session")).toBe("05-bob"); // trims
});

test("parsePlan: counts total + done from checkbox lines", () => {
  const raw = [
    "# แผน build — demo",
    "",
    "- [x] Sprint 1 — engine",
    "- [X] Sprint 2 — api",
    "- [ ] Sprint 3 — ui",
    "* [ ] Sprint 4 — polish", // asterisk bullet also counts
    "- not a checkbox line",
  ].join("\n");
  expect(parsePlan(raw)).toEqual({ total: 4, done: 2 });
});

test("parsePlan: no checkbox lines → null", () => {
  expect(parsePlan("# แผน\n\nไม่มี checkbox เลย")).toBeNull();
  expect(parsePlan("")).toBeNull();
});

test("nextSprintFromPlan: first unchecked sprint → {id,title}; parses number + em-dash title", () => {
  const raw = [
    "- [x] Sprint 1 — engine",
    "- [X] Sprint 2 — api",
    "- [ ] Sprint 3 — payment retry",
    "- [ ] Sprint 4 — polish",
  ].join("\n");
  expect(nextSprintFromPlan(raw)).toEqual({ id: "S3", title: "payment retry" });
});

test("nextSprintFromPlan: unlabeled item → id '' with the raw text as title", () => {
  expect(nextSprintFromPlan("- [x] Sprint 1 — a\n- [ ] wire up the checkout flow")).toEqual({
    id: "",
    title: "wire up the checkout flow",
  });
});

test("nextSprintFromPlan: all done / no plan → null", () => {
  expect(nextSprintFromPlan("- [x] Sprint 1 — a\n- [X] Sprint 2 — b")).toBeNull();
  expect(nextSprintFromPlan("")).toBeNull();
});

test("isResumable: a plan with unchecked sprints alone makes it resumable", () => {
  expect(isResumable({ sprintDocs: 0, openWorktrees: 0, plannedTotal: 3, plannedDone: 1 })).toBe(true);
  // fully-done plan, nothing else pending → not resumable
  expect(isResumable({ sprintDocs: 0, openWorktrees: 0, plannedTotal: 3, plannedDone: 3 })).toBe(false);
});

test("parseOrchesMeta: valid", () => {
  expect(parseOrchesMeta('{"team":"brew","lastRun":123}')).toEqual({
    team: "brew",
    lastRun: 123,
  });
});

test("parseOrchesMeta: bad JSON / wrong shape → null-ish", () => {
  expect(parseOrchesMeta("not json")).toBeNull();
  expect(parseOrchesMeta("[]")).toEqual({}); // object-ish array → no fields
  expect(parseOrchesMeta('{"team":42}')).toEqual({}); // wrong type dropped
  expect(parseOrchesMeta('{"team":"  "}')).toEqual({}); // blank trimmed away
});

test("serializeOrchesMeta round-trips", () => {
  const s = serializeOrchesMeta("carbon", 999);
  expect(parseOrchesMeta(s)).toEqual({ team: "carbon", lastRun: 999 });
  expect(s.endsWith("\n")).toBe(true);
});

test("isResumable: sprint docs OR open worktrees", () => {
  expect(isResumable({ sprintDocs: 0, openWorktrees: 0 })).toBe(false);
  expect(isResumable({ sprintDocs: 2, openWorktrees: 0 })).toBe(true);
  expect(isResumable({ sprintDocs: 0, openWorktrees: 1 })).toBe(true);
});

test("isProjectLive: true only when a live pane sits inside <project>/agents/*", () => {
  const proj = "/home/u/projects/rpn";
  // a worker worktree pane → doing
  expect(isProjectLive(proj, ["/home/u/projects/rpn/agents/bob"])).toBe(true);
  // deeper cwd inside the worktree still counts
  expect(isProjectLive(proj, ["/home/u/projects/rpn/agents/jack/src"])).toBe(true);
  // trailing slash on the project path is tolerated
  expect(isProjectLive(proj + "/", ["/home/u/projects/rpn/agents/bob"])).toBe(true);
  // the project root itself (or its docs) is NOT a live worker → not doing
  expect(isProjectLive(proj, ["/home/u/projects/rpn", "/home/u/projects/rpn/docs"])).toBe(false);
  // a DIFFERENT project's worktree must not leak in (prefix-collision guard)
  expect(isProjectLive(proj, ["/home/u/projects/rpn-v2/agents/bob"])).toBe(false);
  // no panes at all → not doing
  expect(isProjectLive(proj, [])).toBe(false);
});

test("defaultTeamForProject: only when team exists in the list", () => {
  expect(defaultTeamForProject({ team: "brew" }, ["brew", "carbon"])).toBe("brew");
  expect(defaultTeamForProject({ team: "gone" }, ["brew"])).toBeNull();
  expect(defaultTeamForProject(null, ["brew"])).toBeNull();
});

test("sortResumable: recent lastRun first, then sprint count, then name", () => {
  const p = (name: string, lastRun?: number, sprintDocs = 0): ResumableProject => ({
    name,
    path: "/x/" + name,
    sprintDocs,
    openWorktrees: 0,
    lastRun,
  });
  const out = sortResumable([
    p("morse", 100, 1),
    p("expense", 200, 3),
    p("aaa", undefined, 5),
    p("bbb", undefined, 5),
  ]);
  expect(out.map((x) => x.name)).toEqual(["expense", "morse", "aaa", "bbb"]);
});

test("buildResumeKickoff: names project + tells it NOT to ask a new requirement", () => {
  const k = buildResumeKickoff(
    "expense-tracker",
    "/home/u/projects/expense-tracker",
    "brew",
    "foreman",
    ["bob", "jack"],
  );
  expect(k).toContain("expense-tracker");
  expect(k).toContain("/home/u/projects/expense-tracker");
  expect(k).toContain("RESUME");
  expect(k).toContain("อย่าถาม build requirement ใหม่");
  expect(k).toContain("foreman");
  expect(k).toContain("bob, jack");
});

test("projectScanDirs: scans owner-root/projects AND the derived ghq-root/projects (location-tolerant)", () => {
  // owner root = <ghqRoot>/github.com/<owner> → also scan <ghqRoot>/projects
  // (a project built in the stray soulbrew/projects still gets surfaced)
  expect(projectScanDirs("/home/u/soulbrew/github.com/acme")).toEqual([
    "/home/u/soulbrew/github.com/acme/projects",
    "/home/u/soulbrew/projects",
  ]);
  // no /github.com/<owner> segment → cannot derive ghq root → only own projects
  expect(projectScanDirs("/weird/root")).toEqual(["/weird/root/projects"]);
});

test("dedupeByRealpath: a symlink and its target collapse to ONE (first occurrence kept)", () => {
  // ghq/projects/newFlow is a symlink INTO owner/projects/newFlow → one entry, owner path kept
  const realpath = (p: string) =>
    p === "/ghq/projects/newFlow" ? "/owner/projects/newFlow" : p;
  expect(
    dedupeByRealpath(
      ["/owner/projects/newFlow", "/ghq/projects/newFlow", "/ghq/projects/other"],
      realpath,
    ),
  ).toEqual(["/owner/projects/newFlow", "/ghq/projects/other"]);
  // realpath throws (missing/broken symlink) → fall back to the path itself, still deduped
  const throwing = (p: string) => {
    if (p === "/gone") throw new Error("ENOENT");
    return p;
  };
  expect(dedupeByRealpath(["/gone", "/gone", "/a"], throwing)).toEqual(["/gone", "/a"]);
});

test("toggleStar: add if absent, remove if present, never mutates input", () => {
  const base = ["/x/one"];
  expect(toggleStar(base, "/x/two")).toEqual(["/x/one", "/x/two"]); // add
  expect(toggleStar(["/x/one", "/x/two"], "/x/one")).toEqual(["/x/two"]); // remove
  expect(base).toEqual(["/x/one"]); // input untouched
  expect(toggleStar(toggleStar(base, "/x/two"), "/x/two")).toEqual(["/x/one"]); // round-trip
});

test("partitionStarred: starred float to top, sub-order preserved within groups", () => {
  const p = (name: string): ResumableProject => ({
    name,
    path: "/x/" + name,
    sprintDocs: 0,
    openWorktrees: 0,
  });
  const list = [p("a"), p("b"), p("c"), p("d")];
  expect(partitionStarred(list, new Set(["/x/b", "/x/d"])).map((x) => x.name)).toEqual([
    "b",
    "d",
    "a",
    "c",
  ]);
  expect(partitionStarred(list, new Set()).map((x) => x.name)).toEqual(["a", "b", "c", "d"]); // none → unchanged
  expect(
    partitionStarred(list, new Set(["/x/a", "/x/b", "/x/c", "/x/d"])).map((x) => x.name),
  ).toEqual(["a", "b", "c", "d"]); // all → order unchanged
});

// The hero card claims "ทำต่อจากล่าสุด". A star must never buy that slot.
const proj = (name: string): ResumableProject => ({
  name,
  path: "/x/" + name,
  sprintDocs: 0,
  openWorktrees: 0,
});

test("orderForProjectScreen: starring an old project does NOT make it the hero", () => {
  const list = [proj("newest"), proj("b"), proj("ancient"), proj("d")];
  // ⛔ the bug: partitionStarred put 'ancient' at index 0, i.e. in the hero card.
  expect(partitionStarred(list, new Set(["/x/ancient"])).map((x) => x.name)[0]).toBe("ancient");
  // fixed: hero stays 'newest', the star pins 'ancient' to the top of the queue.
  expect(orderForProjectScreen(list, new Set(["/x/ancient"])).map((x) => x.name)).toEqual([
    "newest",
    "ancient",
    "b",
    "d",
  ]);
});

test("orderForProjectScreen: several stars keep their relative order under the hero", () => {
  const list = [proj("newest"), proj("b"), proj("c"), proj("d")];
  expect(orderForProjectScreen(list, new Set(["/x/d", "/x/b"])).map((x) => x.name)).toEqual([
    "newest",
    "b",
    "d",
    "c",
  ]);
});

test("orderForProjectScreen: starring the hero itself changes nothing (no duplicate)", () => {
  const list = [proj("newest"), proj("b"), proj("c")];
  expect(orderForProjectScreen(list, new Set(["/x/newest"])).map((x) => x.name)).toEqual([
    "newest",
    "b",
    "c",
  ]);
});

test("orderForProjectScreen: no stars → untouched; 0/1 project → untouched copy", () => {
  const list = [proj("a"), proj("b"), proj("c")];
  expect(orderForProjectScreen(list, new Set()).map((x) => x.name)).toEqual(["a", "b", "c"]);
  expect(orderForProjectScreen([], new Set(["/x/a"]))).toEqual([]);
  expect(orderForProjectScreen([proj("only")], new Set(["/x/only"])).map((x) => x.name)).toEqual(["only"]);
  expect(orderForProjectScreen(list, new Set())).not.toBe(list); // copy, never mutates
});
