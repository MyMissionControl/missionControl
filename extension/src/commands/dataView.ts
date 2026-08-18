import * as fs from "node:fs";
import * as path from "node:path";

import { listBackedUpProjects } from "./docsBackup";
import { getGithubWebUrl } from "./gitOps";
import { listProjectTree, type TreeNode } from "./projectDocs";
import { dedupeByRealpath, parsePlan, projectScanDirs } from "./orchestratorResume";
// NOTE: resolveOwnerRoot lives in startOrchestrator.ts, which imports `vscode`.
// It is pulled in via dynamic import() inside loadDataIndex() only, so this module's
// tested core (buildProjectRow/parse*) stays loadable under `bun test` (no vscode).

/** One project's row in the Data View. The unit of the whole page: every view
 *  (table / kanban / timeline) is a different render of this same array. Derived
 *  entirely from the project's `.md` docs — never from live prose parsing. */
export interface ProjectRow {
  name: string; // project folder basename
  path: string; // absolute path
  sprintsTotal: number;
  sprintsDone: number;
  percentDone: number; // 0..100, rounded; 0 when total is 0
  status: "not-started" | "in-progress" | "done";
  sprints: { n: number; name: string; date: string | null }[]; // all sprint docs, ascending — powers the timeline
  latestSprint: { n: number; name: string; date: string | null } | null;
  updated: string | null; // ISO date (YYYY-MM-DD) of latest activity, best-effort
  hasPreview: boolean; // has .orches-preview.sh
  githubUrl: string | null;
  deleted?: boolean; // true = reconstructed from a backup, not a live project on disk
  deletedAt?: string | null; // ISO date the project was deleted (backups only)
}

const SPRINT_FILE_RX = /^(?:.+-)?sprint-(\d+).*\.md$/i;

interface SprintDoc {
  n: number;
  name: string;
  date: string | null;
  done: boolean;
  mtime: number;
}

/** Extract sprint metadata from one sprint doc. `n` comes from the filename (the
 *  authoritative ordering); name/date/done are best-effort from the doc heading and
 *  the `_YYYY-MM-DD · สถานะ: …_` status line. `done` is only used as a fallback when
 *  the project has no plan.md checklist. */
export function parseSprintDoc(filename: string, raw: string, mtime = 0): SprintDoc | null {
  const fm = SPRINT_FILE_RX.exec(filename);
  if (!fm) return null;
  const n = Number(fm[1]);
  const heading = /^#\s*Sprint\s+\d+\s*[—:\-]\s*(.+?)\s*$/im.exec(raw);
  const name = heading ? heading[1].trim() : `Sprint ${n}`;
  const dateM = /(\d{4}-\d{2}-\d{2})/.exec(raw);
  const date = dateM ? dateM[1] : null;
  const statusM = /สถานะ:\s*([^\n_·|]+)/.exec(raw);
  const statusText = statusM ? statusM[1] : "";
  // A written sprint doc means that sprint shipped — orches authors it on merge — so
  // treat it as done UNLESS its status line explicitly flags in-progress. Only the
  // status line is inspected, never the body (the todo/doing/done board always contains
  // the word "doing"). `done` is a fallback signal, used only when there is no plan.md.
  const done = !/(ยัง|ค้าง|กำลังทำ|กําลังทำ|in[\s-]?progress|doing)/i.test(statusText);
  return { n, name, date, done, mtime };
}

/** One sprint's task lists — the unit of the project-scoped (single-project) view,
 *  the way ProjectRow is the unit of the cross-project one. */
export interface SprintTasks {
  n: number;
  name: string;
  date: string | null;
  file: string; // absolute path of the sprint doc, so the view can open it
  rel: string; // project-relative POSIX path ("docs/x-sprint-1.md") — keys the row in the file tree
  done: string[];
  pending: string[];
}

// `Delivered` / `Built` are the older English orches docs' name for the same list.
// The pending side gets no English alias on purpose: those docs' `Notes for later
// sprints` / `Gotchas harvested` are commentary, not outstanding work.
const DONE_HEADING_RX = /ทำอะไรเสร็จบ้าง|^##\s+(?:Delivered|Built)\b/;
const PENDING_HEADING_RX = /ยังค้าง/;

/** Pull the task bullets out of one sprint doc. orches writes two lists at sprint
 *  close: `## ทำอะไรเสร็จบ้าง` (shipped) and `## ⚠️ ข้อควรรู้ / ยังค้าง` (known gaps) —
 *  headings are matched by substring because the emoji prefix varies. Only TOP-LEVEL
 *  `- ` bullets count; an indented one is detail about the bullet above it, not its
 *  own task. Docs in another format (older English ones) yield two empty lists —
 *  the view says so rather than showing a misleading zero. */
export function parseSprintTasks(raw: string): { done: string[]; pending: string[] } {
  const done: string[] = [];
  const pending: string[] = [];
  let bucket: string[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      bucket = DONE_HEADING_RX.test(line) ? done : PENDING_HEADING_RX.test(line) ? pending : null;
      continue;
    }
    if (!bucket) continue;
    const m = /^[-*]\s+(.*\S)\s*$/.exec(line); // no leading space → top level only
    if (m) bucket.push(m[1].replace(/\*\*(.+?)\*\*/g, "$1").trim());
  }
  return { done, pending };
}

/** Every sprint of one project with its tasks, ascending. Read on demand (when the
 *  user drills into a project), never as part of the cross-project index — that would
 *  mean reading every sprint doc of every project up front for data usually unseen. */
export function loadProjectTasks(projectPath: string): SprintTasks[] {
  const docsDir = path.join(projectPath, "docs");
  let names: string[];
  try {
    names = fs.readdirSync(docsDir);
  } catch {
    return []; // no docs/ → nothing to show
  }
  const out: SprintTasks[] = [];
  for (const fn of names) {
    if (!SPRINT_FILE_RX.test(fn)) continue;
    const abs = path.join(docsDir, fn);
    let raw = "";
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      /* unreadable → still list the sprint, just with no tasks */
    }
    const meta = parseSprintDoc(fn, raw);
    if (!meta) continue;
    const { done, pending } = parseSprintTasks(raw);
    out.push({
      n: meta.n,
      name: meta.name,
      date: meta.date,
      file: abs,
      rel: "docs/" + fn,
      done,
      pending,
    });
  }
  return out.sort((a, b) => a.n - b.n);
}

/** The project's real file tree — the SAME call the Project Detail explorer makes, so
 *  the Data View lists exactly what that page lists: every `.md` wherever it sits, plus
 *  the `.orches-shots/` screenshots, with the folder structure the repo actually has.
 *  ⛔ It used to be `loadProjectDocList`: a flat, alphabetised list of non-sprint docs.
 *     User's call 2026-08-18 — one table showing the real structure, nothing invented,
 *     nothing hidden. Sprint docs and plan.md are ordinary files IN this tree now; the
 *     view keys their task drill-down off `rel` (see SprintTasks.rel / PlanDoc.rel). */
export function loadProjectDocTree(projectPath: string): TreeNode[] {
  return listProjectTree(projectPath, { shots: true });
}

/** plan.md surfaced as a {done,pending} pair — its checklist items — so the Data
 *  View can show it as an expandable row above the sprints, in the same shape a
 *  sprint expands into. `[x]`/`[X]` → done, `[ ]` → pending. Null when there is no
 *  plan.md (its `.md` link still opens the file even if the checklist is empty). */
export interface PlanDoc {
  file: string; // absolute path to docs/plan.md
  rel: string; // "docs/plan.md"
  done: string[];
  pending: string[];
}
export function loadProjectPlan(projectPath: string): PlanDoc | null {
  const abs = path.join(projectPath, "docs", "plan.md");
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    return null; // no plan.md
  }
  const done: string[] = [];
  const pending: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/\*\*(.+?)\*\*/g, "$1").trim();
    (m[1] === " " ? pending : done).push(text);
  }
  return { file: abs, rel: "docs/plan.md", done, pending };
}

/** Read + parse every sprint doc under <project>/docs. Sorted ascending by N. */
function readSprintDocs(projectPath: string): SprintDoc[] {
  const docsDir = path.join(projectPath, "docs");
  const out: SprintDoc[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(docsDir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!SPRINT_FILE_RX.test(fn)) continue;
    let raw = "";
    let mtime = 0;
    try {
      const abs = path.join(docsDir, fn);
      raw = fs.readFileSync(abs, "utf8");
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      /* unreadable sprint doc → still count it, best-effort */
    }
    const parsed = parseSprintDoc(fn, raw, mtime);
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Latest mtime (ms) of any file directly under <project>/docs (non-recursive). */
function latestDocsMtime(projectPath: string): number {
  const docsDir = path.join(projectPath, "docs");
  let max = 0;
  try {
    for (const fn of fs.readdirSync(docsDir)) {
      try {
        const st = fs.statSync(path.join(docsDir, fn));
        if (st.isFile() && st.mtimeMs > max) max = st.mtimeMs;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no docs dir */
  }
  return max;
}

function isoDate(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build one project's row from its `.md` docs. Synchronous + git-free so it stays
 *  pure and unit-testable; `githubUrl` is filled in later by the async index build.
 *  Returns null for a folder with no `docs/` (not a build project). */
export function buildProjectRow(projectPath: string): ProjectRow | null {
  const docsDir = path.join(projectPath, "docs");
  try {
    if (!fs.statSync(docsDir).isDirectory()) return null;
  } catch {
    return null; // no docs/ → not a project we surface
  }

  let planRaw: string | null = null;
  try {
    planRaw = fs.readFileSync(path.join(docsDir, "plan.md"), "utf8");
  } catch {
    /* no plan.md → sprint-doc fallback below */
  }

  const sprints = readSprintDocs(projectPath);

  // total / done: plan.md checklist is authoritative; else fall back to sprint docs.
  let sprintsTotal: number;
  let sprintsDone: number;
  const plan = planRaw ? parsePlan(planRaw) : null;
  if (plan) {
    sprintsTotal = plan.total;
    sprintsDone = plan.done;
  } else {
    sprintsTotal = sprints.length;
    sprintsDone = sprints.filter((s) => s.done).length;
  }

  const percentDone = sprintsTotal > 0 ? Math.round((sprintsDone / sprintsTotal) * 100) : 0;
  const status: ProjectRow["status"] =
    sprintsTotal > 0 && sprintsDone >= sprintsTotal
      ? "done"
      : sprintsDone <= 0
        ? "not-started"
        : "in-progress";

  const last = sprints.length ? sprints[sprints.length - 1] : null;
  const latestSprint = last ? { n: last.n, name: last.name, date: last.date } : null;
  const updated = latestSprint?.date ?? isoDate(latestDocsMtime(projectPath));

  const hasPreview = fs.existsSync(path.join(projectPath, ".orches-preview.sh"));

  return {
    name: path.basename(projectPath),
    path: projectPath,
    sprintsTotal,
    sprintsDone,
    percentDone,
    status,
    sprints: sprints.map((s) => ({ n: s.n, name: s.name, date: s.date })),
    latestSprint,
    updated,
    hasPreview,
    githubUrl: null,
  };
}

/** Enumerate every project dir the same way the Projects screen does (owner-root
 *  + ghq-root `projects/`, symlink-deduped, skipping ψ and dotfiles). */
function enumerateProjectDirs(ownerRoot: string): string[] {
  const candidates: string[] = [];
  for (const projectsDir of projectScanDirs(ownerRoot)) {
    try {
      for (const n of fs.readdirSync(projectsDir)) {
        if (n === "ψ" || n.startsWith(".")) continue;
        candidates.push(path.join(projectsDir, n));
      }
    } catch {
      /* no such projects/ dir */
    }
  }
  return dedupeByRealpath(candidates, (q) => fs.realpathSync(q));
}

/** One tagged ProjectRow per durable backup whose docs still parse. The row
 *  points at the backup folder (so a click opens the preserved copy) and is
 *  flagged `deleted` so the UI can mark it. Backups with no parseable docs
 *  (e.g. README-only) are skipped here — they still appear in the Orchestrator's
 *  deleted-projects list, which reads listBackedUpProjects() directly. */
export function loadBackupRows(): ProjectRow[] {
  const out: ProjectRow[] = [];
  for (const entry of listBackedUpProjects()) {
    let row: ProjectRow | null = null;
    try {
      row = buildProjectRow(entry.backupDir);
    } catch {
      /* corrupt backup → skip, never sink the index */
    }
    if (!row) continue;
    row.name = entry.name; // trust the manifest name over the folder basename
    row.path = entry.backupDir; // click → open the backup copy
    row.githubUrl = null; // a backup has no .git
    row.deleted = true;
    row.deletedAt = entry.deletedAt;
    out.push(row);
  }
  return out;
}

/** Build the full Data View index for a given owner root. Async only because of the
 *  per-project GitHub URL lookup; the row shape itself is computed synchronously. */
export async function buildDataIndex(ownerRoot: string): Promise<ProjectRow[]> {
  const rows: ProjectRow[] = [];
  for (const dir of enumerateProjectDirs(ownerRoot)) {
    let row: ProjectRow | null = null;
    try {
      row = buildProjectRow(dir);
    } catch {
      /* one bad project must not sink the whole index */
    }
    if (row) rows.push(row);
  }
  await Promise.all(
    rows.map(async (r) => {
      try {
        r.githubUrl = await getGithubWebUrl(r.path);
      } catch {
        r.githubUrl = null;
      }
    }),
  );
  // merge in deleted projects from the durable backup — skip any whose name is
  // still live on disk (the live row is authoritative).
  const liveNames = new Set(rows.map((r) => r.name));
  for (const br of loadBackupRows()) if (!liveNames.has(br.name)) rows.push(br);
  // most-recently-updated first, then name
  rows.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name));
  return rows;
}

/** Resolve the owner root from config and build the index. Empty array if the
 *  owner root can't be resolved (no oracles.json / unexpected layout). */
export async function loadDataIndex(): Promise<ProjectRow[]> {
  const { resolveOwnerRoot } = await import("./startOrchestrator");
  const root = resolveOwnerRoot();
  if (!root) return [];
  return buildDataIndex(root);
}
