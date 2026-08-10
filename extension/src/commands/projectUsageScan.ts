import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type Breakdown, filesTouchingProject, priceLine, resolveProject } from "../usage";

// On-demand, single-project scan for the Project Usage drill-down page. Kept OUT
// of the global UsageSummary/cache (which the dashboard polls every 10s) so the
// heavier per-session / per-model / per-skill detail is only computed when the
// user actually opens one project's page. The core (buildProjectUsage) is a pure
// fold over already-parsed transcript records so it unit-tests without any FS.

export interface CatVal { tokens: number; usd: number; }
export interface CatSplit { cacheRead: CatVal; output: CatVal; cacheWrite: CatVal; input: CatVal; }
export interface HourBucket { cost: number; tokens: number; cats: CatSplit; }
export interface SessionRow { startMs: number; durationMs: number; model: string; branch: string; cost: number; }
export interface SkillRun { name: string; runs: number; cost: number; }
export interface ProjectUsage {
  hourly: Record<string, HourBucket>; // key "YYYY-MM-DD HH" (local) — client rolls up per scope
  models: Record<string, { cost: number; tokens: number }>;
  sessions: SessionRow[]; // newest first
  skills: SkillRun[]; // most runs first
}

/** One parsed transcript line (only the fields we read). */
export interface UsageRecord {
  type?: string;
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  requestId?: string;
  attributionSkill?: unknown;
  promptId?: unknown;
  message?: {
    id?: string;
    model?: string;
    usage?: Record<string, unknown>;
  };
}

export function emptyCats(): CatSplit {
  return {
    cacheRead: { tokens: 0, usd: 0 },
    output: { tokens: 0, usd: 0 },
    cacheWrite: { tokens: 0, usd: 0 },
    input: { tokens: 0, usd: 0 },
  };
}

/** Fold a priced line's Breakdown into a CatSplit accumulator. */
function addBd(cats: CatSplit, bd: Breakdown): void {
  cats.cacheRead.tokens += bd.cacheReadTok; cats.cacheRead.usd += bd.cacheReadCost;
  cats.output.tokens += bd.outTok; cats.output.usd += bd.outCost;
  cats.cacheWrite.tokens += bd.cacheWriteTok; cats.cacheWrite.usd += bd.cacheWriteCost;
  cats.input.tokens += bd.inTok; cats.input.usd += bd.inCost;
}

/** Local "YYYY-MM-DD HH" for an ISO timestamp (empty/invalid → "unknown"). */
export function hourKeyLocal(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours());
}

function topKey(counts: Record<string, number>): string {
  let best = "", n = -1;
  for (const k of Object.keys(counts)) if (counts[k] > n) { n = counts[k]; best = k; }
  return best;
}

/** Pure core: fold parsed transcript records for ONE project (by resolved root)
 *  into hourly buckets (with token-category split), per-model totals, per-session
 *  rows and per-skill run counts. De-dupes on requestId:message.id like the main
 *  aggregator. Records not resolving to `root`, or with no priced usage, are skipped. */
export function buildProjectUsage(records: UsageRecord[], root: string): ProjectUsage {
  const hourly: Record<string, HourBucket> = {};
  const models: Record<string, { cost: number; tokens: number }> = {};
  const sessionsMap: Record<string, { startMs: number; endMs: number; cost: number; branch: string; models: Record<string, number> }> = {};
  const skillsMap: Record<string, { cost: number; lines: number; prompts: Set<string> }> = {};
  const seen = new Set<string>();

  for (const d of records) {
    if (d.type !== "assistant") continue;
    const cwd = typeof d.cwd === "string" ? d.cwd : "";
    const rp = resolveProject(cwd);
    if (!rp || rp.root !== root) continue;
    const msg = d.message;
    const usage = msg && msg.usage;
    if (!msg || !usage) continue;
    if (d.requestId || msg.id) {
      const k = (d.requestId ?? "") + ":" + (msg.id ?? "");
      if (seen.has(k)) continue;
      seen.add(k);
    }
    const model = String(msg.model ?? "");
    const ts = typeof d.timestamp === "string" ? d.timestamp : "";
    // Same date-scoped pricing as the global aggregator (Sonnet 5's intro rate).
    const tsMsForPrice = Date.parse(ts);
    const pl = priceLine(model, usage, Number.isNaN(tsMsForPrice) ? undefined : tsMsForPrice);
    if (!pl) continue;

    const hk = hourKeyLocal(ts);
    const hb = hourly[hk] || (hourly[hk] = { cost: 0, tokens: 0, cats: emptyCats() });
    hb.cost += pl.cost; hb.tokens += pl.tokens; addBd(hb.cats, pl.bd);

    const mm = models[model] || (models[model] = { cost: 0, tokens: 0 });
    mm.cost += pl.cost; mm.tokens += pl.tokens;

    const sid = typeof d.sessionId === "string" && d.sessionId ? d.sessionId : "?";
    const s = sessionsMap[sid] || (sessionsMap[sid] = { startMs: Infinity, endMs: 0, cost: 0, branch: "", models: {} });
    const tsMs = Date.parse(ts);
    if (!Number.isNaN(tsMs)) { if (tsMs < s.startMs) s.startMs = tsMs; if (tsMs > s.endMs) s.endMs = tsMs; }
    s.cost += pl.cost;
    if (typeof d.gitBranch === "string" && d.gitBranch) s.branch = d.gitBranch;
    s.models[model] = (s.models[model] ?? 0) + 1;

    const sk = d.attributionSkill;
    if (typeof sk === "string" && sk) {
      const k = skillsMap[sk] || (skillsMap[sk] = { cost: 0, lines: 0, prompts: new Set() });
      k.cost += pl.cost; k.lines++;
      if (typeof d.promptId === "string" && d.promptId) k.prompts.add(d.promptId);
    }
  }

  const sessions: SessionRow[] = Object.keys(sessionsMap)
    .map((sid) => {
      const s = sessionsMap[sid];
      const start = Number.isFinite(s.startMs) ? s.startMs : 0;
      return { startMs: start, durationMs: Math.max(0, s.endMs - start), model: topKey(s.models), branch: s.branch, cost: s.cost };
    })
    .filter((x) => x.cost > 0)
    .sort((a, b) => b.startMs - a.startMs);

  const skills: SkillRun[] = Object.keys(skillsMap)
    .map((name) => ({ name, runs: skillsMap[name].prompts.size || skillsMap[name].lines, cost: skillsMap[name].cost }))
    .sort((a, b) => b.runs - a.runs || b.cost - a.cost);

  return { hourly, models, sessions, skills };
}

// ── impure driver: read this project's transcripts, then fold ────────────────

function collectJsonl(dir: string, out: string[], depth: number): void {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/** Read + fold one project's transcripts.
 *
 *  File selection is the union of two sources, because neither alone is complete:
 *   1. the global usage cache's own answer (`filesTouchingProject`) — every file
 *      the last full scan saw record a cwd inside this project, wherever it lives;
 *   2. transcript dirs whose name starts with the project's encoded cwd — these
 *      catch a session started since that scan, which the cache can't know about.
 *
 *  The name filter used to be the ONLY source, and it is not sound on its own: a
 *  directory is named after the cwd the session STARTED in, so an orchestrated
 *  build (oracle session in its own repo, writing into the project) has no
 *  matching directory and the page showed $0.00 for a real $452 project. Falls
 *  back to a full walk when both come up empty. The per-line resolveProject check
 *  in buildProjectUsage stays the correctness gate — extra files are harmless. */
export async function scanProjectUsage(root: string): Promise<ProjectUsage> {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectsDir = path.join(base, "projects");
  let topDirs: string[];
  try {
    topDirs = fs.readdirSync(projectsDir).map((n) => path.join(projectsDir, n));
  } catch {
    return { hourly: {}, models: {}, sessions: [], skills: [] };
  }
  const encoded = root.replace(/[/.]/g, "-");
  const named = topDirs.filter((d) => path.basename(d).startsWith(encoded));

  const set = new Set<string>();
  for (const d of named) {
    const found: string[] = [];
    collectJsonl(d, found, 0);
    for (const f of found) set.add(f);
  }
  let cached: string[] | null = null;
  try {
    cached = await filesTouchingProject(root);
  } catch {
    cached = null;
  }
  for (const f of cached ?? []) set.add(f);
  if (!set.size) {
    // Nothing known yet (first run, or a project the cache has never seen) —
    // read everything and let the per-line check sort it out.
    const all: string[] = [];
    for (const d of topDirs) collectJsonl(d, all, 0);
    for (const f of all) set.add(f);
  }
  const files = [...set];

  const records: UsageRecord[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      try {
        const o = JSON.parse(line) as UsageRecord;
        if (o.type === "assistant") records.push(o);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return buildProjectUsage(records, root);
}
