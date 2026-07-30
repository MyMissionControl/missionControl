// Pure helpers for "⏮ ทำต่อ" (resume an existing/paused project). NO vscode/fs
// import here — the filesystem walk that finds candidate projects lives in
// startOrchestrator.ts (vscode side); this file only parses + decides so it can
// be unit-tested standalone with `bun test`.

/** Contents of a project's `.orches-meta.json` — a best-effort marker the
 *  orchestrator writes when it drives a project, used ONLY to default the team
 *  picker to whoever worked it last. Absent/invalid → no default (not an error). */
export interface OrchesMeta {
  team?: string;
  lastRun?: number; // epoch ms of the last drive
  session?: string; // tmux session that drove it last (twin-aware attach)
}

/** A project the "⏮ ทำต่อ" screen can offer to resume. */
export interface ResumableProject {
  name: string; // display name (basename of path)
  path: string; // absolute repo path
  sprintDocs: number; // count of docs/*sprint-*.md (new <project>-sprint-N.md or legacy sprint-N.md)
  openWorktrees: number; // count of `agents/*` git worktrees still open
  plannedTotal?: number; // total sprints declared in docs/plan.md (if any)
  plannedDone?: number; // sprints checked off in docs/plan.md
  metaTeam?: string; // team from .orches-meta.json (default pick)
  lastRun?: number; // lastRun from .orches-meta.json (sort key)
  doing?: boolean; // a worker worktree of this project has a LIVE tmux pane right now
  nextSprintId?: string; // first unchecked plan sprint, e.g. "S19" ("" if unlabeled)
  nextSprintTitle?: string; // its short title, e.g. "payment retry"
}

/** Parse `docs/plan.md` — the checklist the orchestrator writes at plan-time and
 *  checks off per finished sprint (`- [x] Sprint 1 — …` / `- [ ] Sprint 2 — …`).
 *  Returns {total, done} from the checkbox lines, or null if there are none.
 *  This is what lets the dashboard show "did 1 of 3, 2 remaining" — a plan the
 *  build no longer silently loses when it pauses at a sprint checkpoint. */
export function parsePlan(raw: string): { total: number; done: number } | null {
  let total = 0;
  let done = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return total > 0 ? { total, done } : null;
}

/** The next sprint to do = the first UNCHECKED `- [ ] Sprint N — title` line in
 *  docs/plan.md. Returns its id ("S<N>", or "" when the line isn't "Sprint N…")
 *  and short title; null when the plan has no unchecked line (all done / no plan).
 *  This powers the "sprint ถัดไป: S19 · payment retry" string on the Projects tab. */
export function nextSprintFromPlan(raw: string): { id: string; title: string } | null {
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[ \]\s*(.+?)\s*$/.exec(line); // unchecked items only
    if (!m) continue;
    const text = m[1].trim();
    const sm = /^sprint\s*(\d+)\s*(?:[—:.·-]+\s*)?(.*)$/i.exec(text);
    if (sm) return { id: "S" + sm[1], title: sm[2].trim() || text };
    return { id: "", title: text };
  }
  return null;
}

/** Parse `.orches-meta.json`. Tolerant: bad JSON / wrong shape → null. */
export function parseOrchesMeta(raw: string): OrchesMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { team?: unknown; lastRun?: unknown; session?: unknown };
  const meta: OrchesMeta = {};
  if (typeof d.team === "string" && d.team.trim()) meta.team = d.team.trim();
  if (typeof d.lastRun === "number" && Number.isFinite(d.lastRun)) meta.lastRun = d.lastRun;
  if (typeof d.session === "string" && d.session.trim()) meta.session = d.session.trim();
  return meta;
}

/** Serialize `.orches-meta.json` (written when a drive starts/resumes).
 *  `session` records WHICH tmux session drove it (base or twin) so a later
 *  attach lands in the right one; omitted when unknown. */
export function serializeOrchesMeta(team: string, lastRun: number, session?: string): string {
  const meta: OrchesMeta = { team, lastRun };
  if (session && session.trim()) meta.session = session.trim();
  return JSON.stringify(meta, null, 2) + "\n";
}

/** A candidate dir is resumable when it has prior sprint output, an open agents/*
 *  worktree, OR a plan with sprints still unchecked — i.e. real leftover work. */
export function isResumable(info: {
  sprintDocs: number;
  openWorktrees: number;
  plannedTotal?: number;
  plannedDone?: number;
}): boolean {
  const pendingPlan = (info.plannedTotal ?? 0) > (info.plannedDone ?? 0);
  return info.sprintDocs > 0 || info.openWorktrees > 0 || pendingPlan;
}

/** True when a live tmux pane's cwd sits inside this project's `agents/*`
 *  worktrees — i.e. a worker is actively grinding a sprint RIGHT NOW ("doing",
 *  the third status, distinct from a merely open-but-idle worktree = "ค้าง").
 *  Pure: the caller supplies the live pane cwds (from `tmux list-panes`), so this
 *  stays unit-testable with no tmux/child_process dependency. */
export function isProjectLive(projectPath: string, livePanePaths: string[]): boolean {
  const agents = projectPath.replace(/\/+$/, "") + "/agents";
  return livePanePaths.some((p) => p === agents || p.startsWith(agents + "/"));
}

/** Default team for the picker: the meta's team, but only if it's a real team
 *  the user can actually pick right now. Otherwise null (user picks manually). */
export function defaultTeamForProject(
  meta: OrchesMeta | null,
  teamNames: string[],
): string | null {
  if (meta?.team && teamNames.includes(meta.team)) return meta.team;
  return null;
}

/** Sort resumable projects for the list: most-recently-driven first (by
 *  lastRun), then most sprint activity, then name — so the likely target is on
 *  top. Pure (no Date), sorts a copy. */
export function sortResumable(list: ResumableProject[]): ResumableProject[] {
  return [...list].sort(
    (a, b) =>
      (b.lastRun ?? 0) - (a.lastRun ?? 0) ||
      b.sprintDocs - a.sprintDocs ||
      a.name.localeCompare(b.name),
  );
}

/** Toggle a project path in the starred list: add if absent, remove if present.
 *  Pure — returns a new array, never mutates the input. */
export function toggleStar(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

/** Stable-partition resumable projects so starred ones float to the top, while
 *  preserving the incoming (sortResumable) order within each group. Pure. */
export function partitionStarred(
  list: ResumableProject[],
  starred: ReadonlySet<string>,
): ResumableProject[] {
  const top: ResumableProject[] = [];
  const rest: ResumableProject[] = [];
  for (const p of list) (starred.has(p.path) ? top : rest).push(p);
  return [...top, ...rest];
}

export type DrivenState = "worker" | "run" | "owner" | "labeled" | "none";

/** Which live signal (if any) proves a project is being driven RIGHT NOW, by
 *  priority: worker (a pane grinding under agents/) > run (this button's headless
 *  run) > owner (.orches-state owner-session still in tmux — the ONE signal that
 *  survives a between-sprint checkpoint pause) > labeled (@orches_label session) >
 *  none. Pure: the caller probes the four booleans. */
export function classifyDriven(a: {
  workerLive: boolean;
  runAlive: boolean;
  ownerAlive: boolean;
  labelMatch: boolean;
}): DrivenState {
  if (a.workerLive) return "worker";
  if (a.runAlive) return "run";
  if (a.ownerAlive) return "owner";
  if (a.labelMatch) return "labeled";
  return "none";
}

/** Read a single `key: value` from `.orches-state` (orches-drive's atomic KV file).
 *  First ':' splits key/value so a value with ':' (e.g. an ISO heartbeat) survives.
 *  Trims; null if the key is absent or its value is blank. Pure. */
export function parseStateValue(raw: string, key: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim() || null;
  }
  return null;
}

/** The `projects/` directories to scan for resumable projects, given the owner
 *  root (`.../github.com/<owner>`). Location-tolerant: besides `<ownerRoot>/projects`
 *  it also derives the ghq root (strip the trailing `/github.com/<owner>`) and adds
 *  `<ghqRoot>/projects` — so a project accidentally built in the stray
 *  `soulbrew/projects` still shows up (the agentskill-marketplace-newFlow case),
 *  not just ones under the canonical owner-root. Owner-root's dir comes FIRST so it
 *  wins realpath-dedup (canonical path kept for display). Pure (no fs). */
export function projectScanDirs(ownerRoot: string): string[] {
  const dirs = [`${ownerRoot}/projects`];
  const m = ownerRoot.match(/^(.*)\/github\.com\/[^/]+$/);
  if (m && m[1] && m[1] !== ownerRoot) dirs.push(`${m[1]}/projects`);
  return [...new Set(dirs)];
}

/** Dedupe candidate project paths by their real (symlink-resolved) location,
 *  keeping the FIRST occurrence's path for display. Prevents a symlink that
 *  bridges the two `projects/` dirs (e.g. a soulbrew/projects entry pointing into
 *  owner-root/projects) from listing the same project twice. `realpath` is injected
 *  so this stays pure/testable; if it throws (missing/broken link) we fall back to
 *  the raw path as the key (still deduped against identical raw paths). */
export function dedupeByRealpath(paths: string[], realpath: (p: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    let key: string;
    try {
      key = realpath(p);
    } catch {
      key = p;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
