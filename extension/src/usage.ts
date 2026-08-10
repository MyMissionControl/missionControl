import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Real Claude Code spend, computed locally — no backend. Claude Code writes one
// JSONL transcript per session under ~/.claude/projects/**; every assistant line
// carries message.usage (input/output/cache tokens) + message.model. We turn
// tokens × Anthropic list price into USD. Cost is COMPUTED (the transcripts have
// no costUSD field). This is the data source the removed /budget endpoint never had.
const M = 1_000_000;

export interface Bucket {
  cost: number;
  tokens: number;
}
// Per-project token/cost split by category. input/output/cache-read/cache-write
// are each computed per assistant line anyway (see priceLine); we keep them per
// cwd so the Budget page can show "where did this project's spend go" — cache-read
// is 0.1x input, so a huge-token project can still be cheap.
export interface Breakdown {
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheWriteTok: number;
  inCost: number;
  outCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
}
export interface UsageSummary {
  total: Bucket;
  byDay: Record<string, Bucket>; // key "YYYY-MM-DD" in LOCAL time (matches the user's clock)
  byProject: Record<string, Bucket>; // key = cwd
  byProjectDetail: Record<string, Breakdown>; // key = cwd -> per-category token/cost split
  // cwd -> ("YYYY-MM-DD HH:00" LOCAL) -> bucket. The per-project usage-over-time
  // data the detail page charts. Kept per-cwd (not pre-collapsed) so the SAME
  // resolveProject grouping the budget page uses can fold sub-dir cwds together.
  byProjectHour: Record<string, Record<string, Bucket>>;
  // cwd -> ("YYYY-MM-DD" LOCAL) -> per-category token/cost split. Per-DAY (not
  // hour) is enough for the detail page's range-scoped token pie since the picked
  // range is day-bounded; keeps the payload/cache small.
  byProjectDayDetail: Record<string, Record<string, Breakdown>>;
  projectLastMs: Record<string, number>; // key = cwd -> latest touched session mtime (ms)
  fileCount: number; // every transcript scanned (sessions + their subagent/workflow files)
  sessionCount: number; // real Claude Code sessions = top-level <proj>/<session>.jsonl only
  computedAt: number;
}

// ── Local-day helpers ────────────────────────────────────────────────────────
// Transcript timestamps are UTC ISO. Budgets should align to the user's wall
// clock, so we bucket by LOCAL date and derive "today"/"this month" the same way
// — otherwise late-evening work (after 00:00 local = 17:00 UTC for UTC+7) would
// land on the wrong UTC day.
function fmtLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function localDayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : fmtLocalDay(d);
}
function localHourKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:00`;
}
/** Local "YYYY-MM-DD" for now. */
export function localTodayKey(): string {
  return fmtLocalDay(new Date());
}
/** Local "YYYY-MM" for now. */
export function localMonthKey(): string {
  return localTodayKey().slice(0, 7);
}

// Per-token USD rates by model family. Anthropic list pricing (per MTok):
// opus $5/$25, sonnet $3/$15, haiku $1/$5, fable $10/$50. Cache write = 1.25×in
// (5-min) / 2×in (1-hour); cache read = 0.1×in. <synthetic> lines are free.
// Matched by substring so older ids (claude-3-5-haiku-…, claude-3-opus-…) also hit.

// Sonnet 5 launched with an introductory list price of $2/$10 per MTok, applied
// to usage through 2026-08-31 (UTC) — $3/$15 from 2026-09-01 on. This is a rate
// that varies by WHEN the tokens were spent, not by when we compute: a line from
// August stays at the intro price forever, so this rule is permanent history and
// must not be deleted once the window closes (removing it would silently reprice
// every past August line by +50%). Priced flat at $3/$15, Sonnet 5 was
// overstated by $292 here. A line with no usable timestamp falls back to the
// standard rate.
const SONNET5_INTRO_END_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00Z, exclusive
function isSonnet5(m: string): boolean {
  return m.includes("sonnet-5") || m.includes("sonnet5");
}
interface Rate {
  i: number;
  o: number;
  w5: number;
  w1: number;
  r: number;
}
function ratesFor(model: string, fast = false, atMs?: number): Rate | null {
  const m = model.toLowerCase();
  if (!m || m.indexOf("synthetic") !== -1) return null;
  let inp: number;
  let out: number;
  if (!fast && isSonnet5(m) && atMs !== undefined && Number.isFinite(atMs) && atMs < SONNET5_INTRO_END_MS) {
    inp = 2; // introductory rate — see SONNET5_INTRO_END_MS
    out = 10;
  } else if (fast) {
    // Fast mode (`/fast`, Opus 5 / 4.8) runs the SAME model at premium pricing —
    // $10/$50 per MTok. The transcript records it as usage.speed = "fast"; without
    // this branch a fast-mode session is billed at half its real cost.
    inp = 10;
    out = 50;
  } else if (m.includes("fable") || m.includes("mythos")) {
    inp = 10;
    out = 50;
  } else if (m.includes("opus")) {
    inp = 5;
    out = 25;
  } else if (m.includes("sonnet")) {
    inp = 3;
    out = 15;
  } else if (m.includes("haiku")) {
    inp = 1;
    out = 5;
  } else {
    inp = 5; // unknown → opus-tier (safe over-estimate)
    out = 25;
  }
  return {
    i: inp / M,
    o: out / M,
    w5: (inp * 1.25) / M,
    w1: (inp * 2) / M,
    r: (inp * 0.1) / M,
  };
}

// The token counts carried on one assistant line's message.usage.
interface UsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  speed?: string; // "standard" | "fast" — fast mode is billed at premium rates
}

export function emptyBreakdown(): Breakdown {
  return {
    inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0,
    inCost: 0, outCost: 0, cacheReadCost: 0, cacheWriteCost: 0,
  };
}

export function addBreakdown(a: Breakdown, b: Breakdown): Breakdown {
  return {
    inTok: a.inTok + b.inTok,
    outTok: a.outTok + b.outTok,
    cacheReadTok: a.cacheReadTok + b.cacheReadTok,
    cacheWriteTok: a.cacheWriteTok + b.cacheWriteTok,
    inCost: a.inCost + b.inCost,
    outCost: a.outCost + b.outCost,
    cacheReadCost: a.cacheReadCost + b.cacheReadCost,
    cacheWriteCost: a.cacheWriteCost + b.cacheWriteCost,
  };
}

// Price ONE assistant line: total cost + total tokens + the 4-way split.
// The four costs always sum to `cost`; the four token counts sum to `tokens`.
// Returns null for models with no rate (synthetic / free) so callers skip them.
// This is the single source of the budget pricing math (aggregateFile uses it).
export function priceLine(
  model: string,
  u: UsageCounts,
  atMs?: number, // when the tokens were spent — some list prices are date-scoped
): { cost: number; tokens: number; bd: Breakdown } | null {
  const rate = ratesFor(model, u.speed === "fast", atMs);
  if (!rate) return null;
  const cc = u.cache_creation || {};
  const c5 = cc.ephemeral_5m_input_tokens ?? 0;
  const c1 = cc.ephemeral_1h_input_tokens ?? 0;
  const ccTot = u.cache_creation_input_tokens ?? 0;
  const inp = u.input_tokens ?? 0;
  const outp = u.output_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const inCost = inp * rate.i;
  const outCost = outp * rate.o;
  const cacheReadCost = cr * rate.r;
  // Prefer the 5m/1h split when present; otherwise price all cache-creation at 5m.
  const cacheWriteCost = c5 || c1 ? c5 * rate.w5 + c1 * rate.w1 : ccTot * rate.w5;
  const cost = inCost + outCost + cacheReadCost + cacheWriteCost;
  const tokens = inp + outp + cr + ccTot;
  return {
    cost,
    tokens,
    bd: { inTok: inp, outTok: outp, cacheReadTok: cr, cacheWriteTok: ccTot, inCost, outCost, cacheReadCost, cacheWriteCost },
  };
}

interface FileAgg extends Bucket {
  mtimeMs: number;
  size: number;
  byDay: Record<string, Bucket>;
  byProject: Record<string, Bucket>;
  byProjectHour: Record<string, Record<string, Bucket>>;
  // Per-cwd NEWEST line timestamp (ms). Recency MUST come from the transcript's
  // own timestamps, NOT the file's mtime: one long-lived session file (an orches
  // foreman/worker oracle) touches many projects across many days, so its single
  // mtime would tag every project it ever visited as "last active = now",
  // collapsing all their recencies together and scrambling the "ล่าสุด" sort.
  projectLastMs: Record<string, number>;
  byProjectDetail: Record<string, Breakdown>;
  byProjectDayDetail: Record<string, Record<string, Breakdown>>;
}

// Per-file cache keyed by path → re-read a transcript only when its mtime/size
// change. In steady state only the active session's file is dirty, so a refresh
// re-reads one file and sums the rest from cache. A short TTL on the whole
// summary keeps the dashboard's 10s poll from re-stat'ing 300+ files each tick.
// All I/O is async (fs.promises) so a cold scan never blocks the extension host.
const fileCache = new Map<string, FileAgg>();
let summaryCache: UsageSummary | null = null;
let summaryAt = 0;
let inFlight: Promise<UsageSummary> | null = null;
const SUMMARY_TTL = 15_000;

// Persist the per-file cache across extension reloads (F5 / window reload).
// Without this, every reload does a cold full parse of ALL transcripts
// (~450MB / 1000+ files → several seconds); with it, only files whose
// mtime/size changed since last run get re-parsed. Best-effort: any read/write
// error just falls back to an in-memory-only cold scan.
const CACHE_FILE = path.join(os.homedir(), ".cache", "mission-control", "usage-filecache.json");
// Bump whenever cached numbers become wrong wholesale — e.g. the ratesFor price
// table changes or the scan itself changes shape (v2: depth limit 4→12; v3:
// FileAgg gained projectLastMs — per-project recency now derives from line
// timestamps, not file mtime; v4: FileAgg/UsageSummary gained byProjectDetail —
// per-project input/output/cache token+cost split; v5: added a global byHour;
// v6: replaced global byHour with byProjectHour — the hourly series is now kept
// PER cwd so the detail page can chart one project's usage over time, not the
// whole machine's; v8: cached day/hour keys are LOCAL, so the host's timezone is
// part of the cache identity — see CACHE_TZ) — so hydrate discards the stale
// cache and the next scan recomputes everything.
const CACHE_VERSION = 8;
// Every cached byDay / byProjectHour / byProjectDayDetail key was rendered in the
// timezone the extension host happened to run in. That makes the TZ part of the
// cache key: when the machine's zone changes (a fresh cloud VM is UTC until it's
// configured), entries written before the change keep their old day boundaries
// FOREVER, because the per-file cache only re-parses on mtime/size change. That
// really happened here — the box moved UTC→Asia/Bangkok and ~a third of all
// spend stayed bucketed 7 hours early. Storing the zone alongside the version
// makes the next scan rebuild instead of silently mixing two calendars.
function hostTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}
const CACHE_TZ = hostTz();
let hydrated = false;

async function hydrateFileCache(): Promise<void> {
  if (hydrated) return;
  hydrated = true; // attempt once per process; a miss just means a cold scan
  try {
    const raw = await fs.promises.readFile(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as { v?: number; tz?: string; entries?: [string, FileAgg][] };
    if (obj?.v === CACHE_VERSION && obj.tz === CACHE_TZ && Array.isArray(obj.entries)) {
      for (const [k, v] of obj.entries) fileCache.set(k, v);
    }
  } catch {
    // no cache yet / unreadable — the cold scan below will rebuild it
  }
}

async function saveFileCache(currentFiles: string[]): Promise<void> {
  try {
    const keep = new Set(currentFiles); // drop entries for vanished transcripts
    const entries = [...fileCache].filter(([k]) => keep.has(k));
    await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, tz: CACHE_TZ, entries }));
  } catch {
    // best-effort — a failed write just means the next reload cold-scans
  }
}

// Persist the COMPUTED SUMMARY too (not just per-file aggregates), so the UI can
// paint last-known totals INSTANTLY on open — even on the very first open after
// a reload, before any scan runs. A cold parse of 450MB is CPU-bound (~5s) and
// must not block the popup; getInstantUsage() serves this snapshot and kicks a
// background refresh. Same version gate as the file cache.
const SUMMARY_FILE = path.join(os.homedir(), ".cache", "mission-control", "usage-summary.json");
let summaryHydrated = false;

async function hydrateSummary(): Promise<void> {
  if (summaryHydrated) return;
  summaryHydrated = true;
  if (summaryCache) return; // a scan already produced one this process
  try {
    const raw = await fs.promises.readFile(SUMMARY_FILE, "utf8");
    const obj = JSON.parse(raw) as { v?: number; tz?: string; summary?: UsageSummary };
    if (obj?.v === CACHE_VERSION && obj.tz === CACHE_TZ && obj.summary) {
      summaryCache = obj.summary;
      summaryAt = obj.summary.computedAt || 0; // real age → staleness triggers a refresh
    }
  } catch {
    // no persisted summary yet — first open will have to await a cold scan
  }
}

async function saveSummary(s: UsageSummary): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(SUMMARY_FILE), { recursive: true });
    await fs.promises.writeFile(SUMMARY_FILE, JSON.stringify({ v: CACHE_VERSION, tz: CACHE_TZ, summary: s }));
  } catch {
    // best-effort
  }
}

// Durable per-project ledger — the last-known totals for every project ever
// seen, keyed by its resolved root ("…/projects/<name>"). Unlike the file
// cache and summary snapshot above (both scoped to what's CURRENTLY on disk),
// this file is append-only from the Budget page's point of view: every scan
// OVERWRITES each present project's row with fresh (already all-time) totals,
// but never deletes a row for a project that's gone missing this scan. That's
// what lets a project keep showing its last-known spend on the Budget page
// after its folder — or eventually even its transcripts — are cleaned up
// locally; see resolveProject's dropped disk-existence check, above.
export interface LedgerEntry {
  name: string;
  cost: number;
  tokens: number;
  lastMs: number;
  detail: Breakdown;
  updatedAt: number; // ms — when this row was last refreshed from a live scan
}
const LEDGER_FILE = path.join(os.homedir(), ".cache", "mission-control", "project-ledger.json");
const LEDGER_VERSION = 1;
let ledgerCache: Record<string, LedgerEntry> | null = null;
let ledgerHydrated = false;

async function hydrateLedger(): Promise<Record<string, LedgerEntry>> {
  if (ledgerCache) return ledgerCache;
  if (!ledgerHydrated) {
    ledgerHydrated = true;
    try {
      const raw = await fs.promises.readFile(LEDGER_FILE, "utf8");
      const obj = JSON.parse(raw) as { v?: number; entries?: Record<string, LedgerEntry> };
      if (obj?.v === LEDGER_VERSION && obj.entries) {
        ledgerCache = obj.entries;
        return ledgerCache;
      }
    } catch {
      // no ledger yet — the first scan below creates one
    }
  }
  return (ledgerCache = ledgerCache ?? {});
}

async function saveLedger(): Promise<void> {
  if (!ledgerCache) return;
  try {
    await fs.promises.mkdir(path.dirname(LEDGER_FILE), { recursive: true });
    await fs.promises.writeFile(LEDGER_FILE, JSON.stringify({ v: LEDGER_VERSION, entries: ledgerCache }));
  } catch {
    // best-effort — losing one write just delays the next persisted update
  }
}

/** Merge this scan's live per-project totals into the durable ledger. Awaited
 *  by scan() so the in-memory ledgerCache is fully up to date by the time it
 *  returns (getProjectLedger() right after must see this scan's numbers, not
 *  last scan's) — only the disk WRITE is fire-and-forget. */
async function updateProjectLedger(grouped: Record<string, ProjectAgg>): Promise<void> {
  const ledger = await hydrateLedger();
  const now = Date.now();
  for (const root of Object.keys(grouped)) {
    const g = grouped[root];
    ledger[root] = { name: g.name, cost: g.cost, tokens: g.tokens, lastMs: g.lastMs, detail: g.det, updatedAt: now };
  }
  void saveLedger();
}

/** Read-only view of the durable project ledger — every project ever seen,
 *  including ones whose folder (or transcripts) are gone now. The Budget page
 *  merges this with the live grouping so a cleaned-up project still shows its
 *  last-known spend instead of silently disappearing. */
export function getProjectLedger(): Promise<Record<string, LedgerEntry>> {
  return hydrateLedger();
}

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

async function collectJsonl(dir: string, out: string[], depth = 0): Promise<void> {
  // 12, not 4: workflow subagent transcripts live at
  // <proj>/<session>/subagents/workflows/wf_*/agent-*.jsonl (depth 5) — the old
  // limit of 4 silently dropped ~2/3 of all transcripts (~$260 undercounted).
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectJsonl(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

function bump(map: Record<string, Bucket>, key: string, cost: number, tokens: number): void {
  const b = map[key] || (map[key] = { cost: 0, tokens: 0 });
  b.cost += cost;
  b.tokens += tokens;
}

// bump() into a two-level map (outer key -> inner key -> bucket) — used for the
// per-project hourly series (cwd -> hour -> bucket).
function bumpNested(
  map: Record<string, Record<string, Bucket>>,
  outer: string,
  inner: string,
  cost: number,
  tokens: number,
): void {
  const m = map[outer] || (map[outer] = {});
  bump(m, inner, cost, tokens);
}

async function aggregateFile(file: string): Promise<FileAgg | null> {
  const agg: FileAgg = {
    mtimeMs: 0,
    size: 0,
    cost: 0,
    tokens: 0,
    byDay: {},
    byProject: {},
    byProjectHour: {},
    projectLastMs: {},
    byProjectDetail: {},
    byProjectDayDetail: {},
  };
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    // null = "don't know", NOT "$0" — caching an empty agg here would freeze a
    // finished session at $0 forever (its mtime never changes again).
    return null;
  }
  // Dedupe within a file on requestId:message.id — compaction re-logs assistant
  // lines, and counting them twice would inflate the bill (ccusage does the same).
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let d: {
      type?: string;
      requestId?: string;
      timestamp?: string;
      cwd?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_creation?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
          };
        };
      };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "assistant") continue;
    const msg = d.message;
    const usage = msg && msg.usage;
    if (!msg || !usage) continue;
    if (d.requestId || msg.id) {
      const key = `${d.requestId ?? ""}:${msg.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    // Parsed once: the line's own clock decides which list price applied.
    const tsMs = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : Number.NaN;
    const pl = priceLine(String(msg.model ?? ""), usage, Number.isNaN(tsMs) ? undefined : tsMs);
    if (!pl) continue;
    agg.cost += pl.cost;
    agg.tokens += pl.tokens;
    const day = typeof d.timestamp === "string" ? localDayKey(d.timestamp) : "unknown";
    bump(agg.byDay, day, pl.cost, pl.tokens);
    const proj = typeof d.cwd === "string" && d.cwd ? d.cwd : "unknown";
    bump(agg.byProject, proj, pl.cost, pl.tokens);
    agg.byProjectDetail[proj] = addBreakdown(agg.byProjectDetail[proj] ?? emptyBreakdown(), pl.bd);
    // Per-project, per-DAY split — feeds the detail page's range-scoped token pie.
    const ddet = agg.byProjectDayDetail[proj] || (agg.byProjectDayDetail[proj] = {});
    ddet[day] = addBreakdown(ddet[day] ?? emptyBreakdown(), pl.bd);
    // Per-project hour bucket — the detail page's usage-over-time series.
    const hour = typeof d.timestamp === "string" ? localHourKey(d.timestamp) : "unknown";
    bumpNested(agg.byProjectHour, proj, hour, pl.cost, pl.tokens);
    // Track this cwd's newest line timestamp (ms) for recency — see FileAgg.
    if (!Number.isNaN(tsMs) && tsMs > (agg.projectLastMs[proj] ?? 0)) {
      agg.projectLastMs[proj] = tsMs;
    }
  }
  return agg;
}

// ── Provider sources ─────────────────────────────────────────────────────────
// A "usage source" is one CLI's local transcript store. The scan machinery
// (concurrency, per-file cache, recency, day/week/month buckets) is fully
// provider-agnostic, so ALL a new provider needs is: where its files live +
// how to turn one file into a FileAgg (its own token/pricing math). Its spend
// then just sums into the SAME grand total — giving the "all accounts, all
// providers, one number" the budget page shows.
interface UsageSource {
  id: string; // "claude", "codex", "gemini"
  root(): string; // dir scanned recursively for *.jsonl; skipped if it doesn't exist
  aggregate(file: string): Promise<FileAgg | null>; // parse one file (own pricing)
}

// Wired sources today: Claude Code only. To add a provider LATER:
//   1. write aggregate<Provider>File() (parse its log lines + its pricing),
//   2. push { id, root, aggregate } here,
//   3. remove its entry from UNWIRED_PROVIDER_HINTS below.
// Example (uncomment + implement when Codex/Gemini transcripts are available):
//   { id: "codex",  root: () => path.join(os.homedir(), ".codex", "sessions"), aggregate: aggregateCodexFile },
//   { id: "gemini", root: () => path.join(os.homedir(), ".gemini", "tmp"),      aggregate: aggregateGeminiFile },
const SOURCES: UsageSource[] = [{ id: "claude", root: projectsDir, aggregate: aggregateFile }];

// Providers we can DETECT but don't parse yet — so the UI can nudge the user to
// wire them in once they start using one (their spend isn't in the total until
// then). Drop an entry when its source is added to SOURCES above.
const UNWIRED_PROVIDER_HINTS: { name: string; marker: string }[] = [
  { name: "Codex (OpenAI)", marker: path.join(os.homedir(), ".codex") },
  { name: "Gemini", marker: path.join(os.homedir(), ".gemini") },
];

/** Names of providers present on disk whose usage is NOT yet summed into the
 *  total — the budget UI surfaces this as a reminder. */
export function unwiredProviders(): string[] {
  return UNWIRED_PROVIDER_HINTS.filter((p) => {
    try {
      return fs.existsSync(p.marker);
    } catch {
      return false;
    }
  }).map((p) => p.name);
}

async function scan(): Promise<UsageSummary> {
  // Gather files from every AVAILABLE source, tagging each with its parser.
  // `session` marks a real Claude Code session — one `<projectDir>/<uuid>.jsonl`
  // directly under the source root. Everything deeper is a subagent / workflow
  // transcript belonging to one of those sessions, so counting every file as a
  // "session" overstates it several times over (1832 files ≈ 448 sessions here).
  const items: { file: string; src: UsageSource; session: boolean }[] = [];
  for (const src of SOURCES) {
    const found: string[] = [];
    const base = src.root();
    await collectJsonl(base, found); // missing dir → yields nothing
    for (const f of found) {
      const rel = path.relative(base, f);
      items.push({ file: f, src, session: rel.split(path.sep).length === 2 });
    }
  }
  await hydrateFileCache(); // reuse last run's per-file aggregates across reloads
  const total: Bucket = { cost: 0, tokens: 0 };
  const byDay: Record<string, Bucket> = {};
  const byProject: Record<string, Bucket> = {};
  const byProjectDetail: Record<string, Breakdown> = {};
  const byProjectHour: Record<string, Record<string, Bucket>> = {};
  const byProjectDayDetail: Record<string, Record<string, Breakdown>> = {};
  const projectLastMs: Record<string, number> = {};

  // Read/parse transcripts CONCURRENTLY (bounded) — they're independent, and a
  // cold scan is otherwise I/O-bound on 1000+ serial reads (the old `for await`
  // loop took ~6s cold). A shared index feeds a fixed pool of workers; the
  // per-file aggregates are merged serially afterwards (cheap, no map races).
  const CONCURRENCY = 48;
  const parsed: (FileAgg | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      // Yield to the event loop each file. JSON.parse of a transcript is
      // SYNCHRONOUS CPU work that doesn't yield on its own; without this, a cold
      // scan saturates the extension host for ~5s and blocks it from sending the
      // "open QuickPick"/repaint IPC — so the budget popup appears to hang even
      // though its data is already cached. setImmediate lets pending IPC/timer
      // callbacks run between files, keeping the UI responsive during the scan.
      await new Promise<void>((r) => setImmediate(r));
      const { file, src } = items[i];
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        continue;
      }
      let agg = fileCache.get(file);
      if (!agg || agg.mtimeMs !== st.mtimeMs || agg.size !== st.size) {
        const fresh = await src.aggregate(file);
        if (!fresh) continue; // transient read failure — retry next scan, don't cache $0
        fresh.mtimeMs = st.mtimeMs;
        fresh.size = st.size;
        fileCache.set(file, fresh);
        agg = fresh;
      }
      parsed[i] = agg;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length || 1) }, worker));

  for (const agg of parsed) {
    if (!agg) continue;
    total.cost += agg.cost;
    total.tokens += agg.tokens;
    for (const k of Object.keys(agg.byDay)) bump(byDay, k, agg.byDay[k].cost, agg.byDay[k].tokens);
    for (const cwd of Object.keys(agg.byProjectHour)) {
      const inner = agg.byProjectHour[cwd];
      const dst = byProjectHour[cwd] || (byProjectHour[cwd] = {});
      for (const hk of Object.keys(inner)) bump(dst, hk, inner[hk].cost, inner[hk].tokens);
    }
    for (const k of Object.keys(agg.byProject)) {
      bump(byProject, k, agg.byProject[k].cost, agg.byProject[k].tokens);
    }
    for (const k of Object.keys(agg.byProjectDetail)) {
      byProjectDetail[k] = addBreakdown(byProjectDetail[k] ?? emptyBreakdown(), agg.byProjectDetail[k]);
    }
    for (const cwd of Object.keys(agg.byProjectDayDetail)) {
      const inner = agg.byProjectDayDetail[cwd];
      const dst = byProjectDayDetail[cwd] || (byProjectDayDetail[cwd] = {});
      for (const dk of Object.keys(inner)) dst[dk] = addBreakdown(dst[dk] ?? emptyBreakdown(), inner[dk]);
    }
    // "recency" = the newest LINE timestamp recorded for that cwd, across every
    // file — a per-project signal, unlike the file's mtime which one shared
    // oracle session file would smear across all the projects it ever touched.
    for (const k of Object.keys(agg.projectLastMs)) {
      if (agg.projectLastMs[k] > (projectLastMs[k] ?? 0)) projectLastMs[k] = agg.projectLastMs[k];
    }
  }
  const files = items.map((x) => x.file);
  summaryCache = {
    total,
    byDay,
    byProject,
    byProjectDetail,
    byProjectHour,
    byProjectDayDetail,
    projectLastMs,
    fileCount: files.length,
    sessionCount: items.reduce((n, x) => n + (x.session ? 1 : 0), 0),
    computedAt: Date.now(),
  };
  summaryAt = summaryCache.computedAt;
  void saveFileCache(files); // persist for the next reload (fire-and-forget)
  void saveSummary(summaryCache); // persist totals for instant paint next open
  await updateProjectLedger(groupByProjectRoot(summaryCache)); // durable per-project totals
  return summaryCache;
}

/** Compute real Claude Code USD spend from local transcripts. Async (never blocks
 *  the extension host). Cached for SUMMARY_TTL; pass force=true (e.g. the Budget
 *  command) to bypass the TTL. Concurrent callers share a single in-flight scan. */
export function computeUsage(force = false): Promise<UsageSummary> {
  const now = Date.now();
  if (!force && summaryCache && now - summaryAt < SUMMARY_TTL) {
    return Promise.resolve(summaryCache);
  }
  if (inFlight) return inFlight;
  inFlight = scan().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** INSTANT usage for the UI: returns the last-known snapshot (in-memory, else the
 *  persisted one from a previous session) WITHOUT waiting for a scan, and kicks a
 *  background refresh when it's stale. Returns null only when nothing has ever
 *  been computed (very first run) — callers then fall back to computeUsage(). */
export async function getInstantUsage(): Promise<UsageSummary | null> {
  await hydrateSummary();
  if (!summaryCache) return null;
  // Defer the stale-revalidate scan to the next tick so the caller can finish
  // painting (send the "open popup"/repaint IPC) BEFORE the scan starts using
  // the CPU — otherwise the very open we're trying to speed up waits on it.
  if (Date.now() - summaryAt >= SUMMARY_TTL) {
    setTimeout(() => void computeUsage(true).catch(() => {}), 0);
  }
  return summaryCache;
}

/** Force a fresh scan (for an explicit refresh button). Resolves with the new
 *  snapshot; callers repaint from it. */
export function refreshUsage(): Promise<UsageSummary> {
  return computeUsage(true);
}

/** Sum spend for every day key whose string starts with `prefix` ("YYYY-MM" for
 *  a month, "YYYY-MM-DD" for a day) — keys are LOCAL dates. */
export function sumByPrefix(s: UsageSummary, prefix: string): number {
  let c = 0;
  for (const k of Object.keys(s.byDay)) if (k.startsWith(prefix)) c += s.byDay[k].cost;
  return c;
}

/** A "project" is any directory that lives under a `projects/` folder — that's
 *  where the /orches build projects go (github.com/…/projects/<name>). Given a
 *  recorded cwd, resolve it to that project (root = `…/projects/<name>`, so all
 *  the sub-dir cwds Claude Code logs — <name>/src, <name>/src/cmds, … — collapse
 *  onto one entry). Returns null for anything not under a projects/ folder
 *  (oracles, tools, home) or that is transient / gone. Shared by the budget page
 *  (row grouping) and the detail page (per-project hour series) so both group
 *  cwds the same way and their totals line up. */
export function resolveProject(cwd: string): { root: string; name: string } | null {
  const segs = cwd.split(path.sep);
  // last "projects" segment that still has a child (the project name)
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === "projects" && i + 1 < segs.length) idx = i;
  }
  if (idx < 0) return null;
  const root = segs.slice(0, idx + 2).join(path.sep);
  // Drop Claude Code's own session store (~/.claude/projects/*) and temp dirs —
  // they contain a "projects" segment too but aren't user projects.
  const home = os.homedir();
  const rel = root.startsWith(home) ? root.slice(home.length) : root;
  if (rel.split(path.sep).some((s) => s.startsWith("."))) return null;
  if (root === "/tmp" || root.startsWith("/tmp/")) return null;
  // NOT gated on the directory still existing on disk: a finished project's
  // folder is routinely deleted long before its Claude Code transcripts (and
  // its ledger row — see updateProjectLedger) are. Requiring the directory
  // here used to make the Budget page silently drop that project's spend the
  // moment it was cleaned up locally.
  return { root, name: segs[idx + 1] };
}

export interface ProjectAgg {
  name: string;
  cost: number;
  tokens: number;
  lastMs: number;
  det: Breakdown;
}

/** Collapse every recorded cwd onto its project root (via resolveProject),
 *  summing cost/tokens and keeping the newest activity + category breakdown.
 *  Shared by the ledger writer (scan, below) and the Budget page's row builder
 *  so both agree on exactly the same per-project totals. */
export function groupByProjectRoot(u: UsageSummary): Record<string, ProjectAgg> {
  const byKey: Record<string, ProjectAgg> = {};
  for (const cwd of Object.keys(u.byProject)) {
    const proj = resolveProject(cwd);
    if (!proj) continue;
    const cur = byKey[proj.root] ?? (byKey[proj.root] = {
      name: proj.name, cost: 0, tokens: 0, lastMs: 0, det: emptyBreakdown(),
    });
    cur.cost += u.byProject[cwd].cost;
    cur.tokens += u.byProject[cwd].tokens;
    cur.lastMs = Math.max(cur.lastMs, u.projectLastMs[cwd] ?? 0);
    cur.det = addBreakdown(cur.det, u.byProjectDetail[cwd] ?? emptyBreakdown());
  }
  return byKey;
}

/** One project row as the Budget page carries it: the aggregate plus whether the
 *  numbers came from this scan (`live`) or only from the durable ledger. */
export interface ProjectAggLive extends ProjectAgg {
  live: boolean;
}

/** Collapse rows whose roots are DIFFERENT PATHS TO THE SAME DIRECTORY into one.
 *
 *  A project that gets moved leaves a symlink at its old location so older
 *  transcripts keep resolving; both paths then appear as separate rows and the
 *  project's spend shows up split in two (agentskill-marketplace-newFlow: $46.70
 *  + $0.97). Keyed on realpath, so two genuinely different projects that merely
 *  share a name are never merged. The surviving key is the real directory when
 *  one of the candidates is it, else the first seen; `realpath` is injected so
 *  this stays pure and testable. */
export function mergeProjectsByRealpath(
  rows: Record<string, ProjectAggLive>,
  realpath: (p: string) => string,
): Record<string, ProjectAggLive> {
  const real = (p: string): string => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  const byReal = new Map<string, { key: string; agg: ProjectAggLive }>();
  for (const root of Object.keys(rows)) {
    const rp = real(root);
    const hit = byReal.get(rp);
    if (!hit) {
      byReal.set(rp, { key: root, agg: { ...rows[root], det: { ...rows[root].det } } });
      continue;
    }
    const add = rows[root];
    hit.agg.cost += add.cost;
    hit.agg.tokens += add.tokens;
    hit.agg.lastMs = Math.max(hit.agg.lastMs, add.lastMs);
    hit.agg.det = addBreakdown(hit.agg.det, add.det);
    hit.agg.live = hit.agg.live || add.live;
    // Prefer the canonical path (the one that IS the real directory) as the row's
    // identity — the detail page and the ledger both key off it.
    if (root === rp && hit.key !== rp) {
      hit.key = root;
      hit.agg.name = add.name;
    }
  }
  const out: Record<string, ProjectAggLive> = {};
  for (const { key, agg } of byReal.values()) out[key] = agg;
  return out;
}

/** Every transcript the last scan saw that recorded work in project `absRoot`,
 *  derived from the per-file cache (each FileAgg already knows its own cwds).
 *
 *  The Project Usage page needs this because a transcript directory is named
 *  after the cwd the SESSION STARTED in, not the cwd each line records: an
 *  orchestrated build runs inside the oracle's own repo and writes the project's
 *  spend from there, so filtering directories by the project's encoded path
 *  misses it entirely (learningPlatform: $452 of spend, zero matching dirs).
 *  Returns null when nothing has been scanned yet so callers can fall back. */
export async function filesTouchingProject(absRoot: string): Promise<string[] | null> {
  await hydrateFileCache();
  if (!fileCache.size) return null;
  const out: string[] = [];
  for (const [file, agg] of fileCache) {
    for (const cwd of Object.keys(agg.byProject)) {
      const p = resolveProject(cwd);
      if (p && p.root === absRoot) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}

/** Merge every cwd that belongs to project `absRoot` into ONE hour-keyed series
 *  ("YYYY-MM-DD HH:00" LOCAL -> bucket) — the per-project usage-over-time data
 *  the detail page charts. Uses the same resolveProject grouping as the budget
 *  page, so a project's sub-dir cwds fold together and the series totals match
 *  that project's row. */
export function collapseProjectHours(u: UsageSummary, absRoot: string): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  for (const cwd of Object.keys(u.byProjectHour)) {
    const p = resolveProject(cwd);
    if (!p || p.root !== absRoot) continue;
    const inner = u.byProjectHour[cwd];
    for (const hk of Object.keys(inner)) bump(out, hk, inner[hk].cost, inner[hk].tokens);
  }
  return out;
}

/** Per-project, per-DAY Breakdown ("YYYY-MM-DD" LOCAL -> split), merged across the
 *  project's cwds (same resolveProject grouping as collapseProjectHours). The
 *  detail page sums these over the picked date range to draw the token-cost pie. */
export function collapseProjectDayDetail(u: UsageSummary, absRoot: string): Record<string, Breakdown> {
  const out: Record<string, Breakdown> = {};
  const src = u.byProjectDayDetail || {};
  for (const cwd of Object.keys(src)) {
    const p = resolveProject(cwd);
    if (!p || p.root !== absRoot) continue;
    const inner = src[cwd];
    for (const dk of Object.keys(inner)) out[dk] = addBreakdown(out[dk] ?? emptyBreakdown(), inner[dk]);
  }
  return out;
}

/** Per-DAY Breakdown for the WHOLE bill — every recorded cwd, not just the ones
 *  under a projects/ folder. Deliberately unfiltered: the budget page's
 *  "แยกตามประเภท token" card used to sum the project ROWS, which silently scoped
 *  it to the ~20% of spend that resolveProject accepts, while the hero above it
 *  showed 100% — same screen, two different totals. Feeding the card from here
 *  makes it agree with the hero to the cent (byProjectDayDetail is bumped from
 *  the same priced lines as byDay/total; a cwd-less line lands under "unknown"
 *  and is counted in all-time only, exactly like the hero). */
export function allDayDetail(u: UsageSummary): Record<string, Breakdown> {
  const out: Record<string, Breakdown> = {};
  const src = u.byProjectDayDetail || {};
  for (const cwd of Object.keys(src)) {
    const inner = src[cwd];
    for (const dk of Object.keys(inner)) out[dk] = addBreakdown(out[dk] ?? emptyBreakdown(), inner[dk]);
  }
  return out;
}

/** Top-N projects by summed cost over the hours on/after `cutoffMs` (a local-day
 *  boundary — same rolling-window convention as buildBudgetView's `last7`). Folds
 *  every cwd onto its project root via resolveProject; cwds with no resolvable
 *  project are skipped. Powers the dashboard Bento budget card's weekly breakdown. */
export function topProjectsByRange(
  byProjectHour: Record<string, Record<string, Bucket>>,
  cutoffMs: number,
  n: number,
): { name: string; cost: number }[] {
  const byRoot: Record<string, { name: string; cost: number }> = {};
  for (const cwd of Object.keys(byProjectHour)) {
    const proj = resolveProject(cwd);
    if (!proj) continue;
    const hours = byProjectHour[cwd];
    for (const hourKey of Object.keys(hours)) {
      // hourKey is "YYYY-MM-DD HH:00" LOCAL; compare the day at local midnight.
      const t = new Date(hourKey.slice(0, 10) + "T00:00:00").getTime();
      if (Number.isNaN(t) || t < cutoffMs) continue;
      const cur = byRoot[proj.root] ?? (byRoot[proj.root] = { name: proj.name, cost: 0 });
      cur.cost += hours[hourKey].cost;
    }
  }
  return Object.values(byRoot)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, n);
}

export interface PeriodBreakdown {
  cost: number;
  tokens: number;
  cats: {
    cacheRead: { tokens: number; usd: number };
    output: { tokens: number; usd: number };
    cacheWrite: { tokens: number; usd: number };
    input: { tokens: number; usd: number };
  };
}
export interface ProjectPeriods {
  today: PeriodBreakdown;
  week: PeriodBreakdown;
  month: PeriodBreakdown;
  all: PeriodBreakdown;
}
function emptyPeriod(): PeriodBreakdown {
  return {
    cost: 0,
    tokens: 0,
    cats: {
      cacheRead: { tokens: 0, usd: 0 },
      output: { tokens: 0, usd: 0 },
      cacheWrite: { tokens: 0, usd: 0 },
      input: { tokens: 0, usd: 0 },
    },
  };
}
function addToPeriod(p: PeriodBreakdown, bd: Breakdown): void {
  p.cats.cacheRead.tokens += bd.cacheReadTok; p.cats.cacheRead.usd += bd.cacheReadCost;
  p.cats.output.tokens += bd.outTok; p.cats.output.usd += bd.outCost;
  p.cats.cacheWrite.tokens += bd.cacheWriteTok; p.cats.cacheWrite.usd += bd.cacheWriteCost;
  p.cats.input.tokens += bd.inTok; p.cats.input.usd += bd.inCost;
  p.cost += bd.inCost + bd.outCost + bd.cacheReadCost + bd.cacheWriteCost;
  p.tokens += bd.inTok + bd.outTok + bd.cacheReadTok + bd.cacheWriteTok;
}

/** Bucket a project's per-day Breakdown series into today / rolling-week /
 *  this-month / all-time totals + the 4-category (cache-read / output / cache-
 *  write / input) cost+token split for each period. Pure — the caller passes the
 *  local day keys (todayKey, weekStartKey = today-6d, monthPrefix "YYYY-MM"), so
 *  no clock is read here. Powers the Budget page's period filter, which re-scopes
 *  each project's spend, bar, and breakdown pie. */
export function projectPeriods(
  dayDetail: Record<string, Breakdown>,
  todayKey: string,
  weekStartKey: string,
  monthPrefix: string,
): ProjectPeriods {
  const out: ProjectPeriods = {
    today: emptyPeriod(),
    week: emptyPeriod(),
    month: emptyPeriod(),
    all: emptyPeriod(),
  };
  for (const day of Object.keys(dayDetail)) {
    const bd = dayDetail[day];
    addToPeriod(out.all, bd);
    // A line with no parseable timestamp lands in the "unknown" bucket. It has to
    // be skipped explicitly: the week test below is a LEXICAL compare, and
    // "unknown" > any "YYYY-MM-DD", so it would silently count as this week.
    if (day === "unknown") continue;
    if (day === todayKey) addToPeriod(out.today, bd);
    if (day >= weekStartKey) addToPeriod(out.week, bd); // fixed-width YYYY-MM-DD → lexical = chronological
    if (day.startsWith(monthPrefix)) addToPeriod(out.month, bd);
  }
  return out;
}
