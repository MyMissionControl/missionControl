#!/usr/bin/env node
// Claude Code statusLine: shows how full the context window is — as "% until
// auto-compact" — with a color-fading bar INSIDE the REPL (bottom line). Wire it
// in ~/.claude/settings.json (global → every claude session shows it):
//   "statusLine": { "type": "command", "command": "<abs>/statusline-context.mjs" }
//
// Claude pipes session JSON on stdin. We use context_window.total_input_tokens
// (current context size, includes cache) and divide by the auto-compact TRIGGER so
// that 100% == the exact moment Claude auto-compacts.
//
// Finding the REAL trigger — pulled live every refresh, NOT assumed:
//   Claude does NOT auto-compact at min(context_window_size, autoCompactWindow).
//   The `autoCompactWindow` setting is effectively ignored — measured across recent
//   sessions, auto-compact fires at ~267k tokens even on a [1m]/1M window (and the
//   exact point can shift as Claude changes). The one authoritative source is the
//   transcript itself: on every auto-compaction Claude writes a system line with
//   `compactMetadata.trigger:"auto"` + `preTokens` (the token count it compacted
//   at). So each refresh we tail this session's transcript and read the last such
//   `preTokens` — that IS the 100% point. We cache it globally so fresh panes (no
//   compaction yet) inherit the latest known trigger, and only fall back to the old
//   window−33k FORMULA (a ~20k output reserve + 13k compaction buffer, reverse-
//   engineered from claude.exe) when nothing has been learned yet. Manual /compact
//   lines are ignored — only trigger:"auto" defines the real auto point.
//
// Output: `ctx [██████░░░░] NN%`, hue fading green→yellow→red with %.
//
// Self-contained: no deps, no imports from the extension build, never throws to
// the UI. Block chars █░ render fine in terminals (NOT emoji).

import { readFileSync, writeFileSync, unlinkSync, realpathSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WINDOW = 200000; // Claude Code's non-1M model default
const BAR_LEN = 10;
// Tokens held back off the effective window before auto-compact fires: ~20k output
// reserve (min(maxOutput, 20000)) + 13k buffer. Verified from claude.exe. Only used
// by the FORMULA fallback now (see the header) — the real trigger is read live from
// the transcript. Keep in sync with COMPACT_RESERVE_TOKENS in webview/contextMeter.ts.
const COMPACT_RESERVE = 33000;
// Bytes to tail-read off the end of the transcript when hunting the last auto-compact
// marker. The marker line is ~1 KB and, right after a compaction, sits at the tail;
// this is just the catch-window before the cache takes over, so 1 MiB is a wide
// margin (matches the old pill's tail size) while staying memory-cheap: the buffer is
// transient and GC'd each run, never a sustained allocation across panes.
const TAIL_CAP = 1048576;
// Global last-known auto trigger, so a fresh pane (no compaction of its own yet)
// inherits the most recent real compact point instead of the wrong formula value.
const TRIGGER_CACHE = join(homedir(), ".claude", ".mc-ctx-trigger");

/** The token count at which auto-compact fires for an effective window =
 *  `window − reserve` (floored at 1). Feed THIS to contextPct so 100% == compact. */
export function autoCompactTrigger(window) {
  return Math.max(1, window - COMPACT_RESERVE);
}

/** Context fill as 0–100% of its denominator. Pass `autoCompactTrigger(window)` so
 *  100% lines up with the point auto-compact fires. */
export function contextPct(tokens, window) {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

/** The most recent AUTO auto-compact point from a transcript's JSONL text: the
 *  `compactMetadata.preTokens` of the last line whose `compactMetadata.trigger` is
 *  "auto" (the token count Claude actually compacted at). null when none. Manual
 *  /compact lines are ignored — they fire at arbitrary points and would poison the
 *  learned auto trigger. Scans from the end (cheap indexOf pre-filter, JSON.parse
 *  only candidates) and tolerates a truncated first line from a tail-read slice. */
export function parseLastAutoCompactPreTokens(jsonl) {
  if (!jsonl) return null;
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf("compactMetadata") === -1 || line.indexOf('"auto"') === -1) continue;
    try {
      const cm = JSON.parse(line).compactMetadata;
      if (cm && cm.trigger === "auto" && typeof cm.preTokens === "number" && cm.preTokens > 0) {
        return cm.preTokens;
      }
    } catch {
      /* partial/garbled line (e.g. tail cut mid-line) — keep scanning */
    }
  }
  return null;
}

/** The denominator that makes 100% == the real compact point, most-authoritative
 *  first: the live trigger read from THIS session's transcript, else the globally
 *  cached last-known trigger, else the reverse-engineered window−reserve formula.
 *
 *  `tokens` (current context size) is used to DISPROVE a stale cache: sailing past
 *  a trigger without Claude compacting means that number is wrong — it was learned
 *  on a different model/window and never expired. Measured 2026-08-04: a cache of
 *  147,686 from 11 days earlier pinned three live sessions (220k/163k/138k, zero
 *  auto-compacts) at a fake 100%. Treating "past it" as "near full" inverts the
 *  meaning of the gauge, so we drop the cache and fall back to the formula instead.
 *  A LIVE trigger is exempt — it comes from this session's own transcript. */
export function pickTrigger(liveTrigger, cachedTrigger, effectiveWindow, tokens = 0) {
  if (typeof liveTrigger === "number" && liveTrigger > 0) return liveTrigger;
  if (typeof cachedTrigger === "number" && cachedTrigger > 0 && !(tokens > cachedTrigger)) return cachedTrigger;
  return autoCompactTrigger(effectiveWindow);
}

// Fade anchors: green → yellow-green(75) → orange(90) → red(100), matching the
// green<75 / yellow 75–90 / red>90 zones but continuous between.
const HUE_ANCHORS = [
  [0, 130],
  [75, 80],
  [90, 40],
  [100, 0],
];

/** Gauge hue (HSL degrees) for a fill pct, interpolated across HUE_ANCHORS. */
export function fillHue(pct) {
  const p = Math.max(0, Math.min(100, pct));
  for (let i = 1; i < HUE_ANCHORS.length; i++) {
    const [x0, h0] = HUE_ANCHORS[i - 1];
    const [x1, h1] = HUE_ANCHORS[i];
    if (p <= x1) {
      const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0);
      return Math.round(h0 + (h1 - h0) * t);
    }
  }
  return 0;
}

/** HSL (h 0–360, s/l 0–1) → {r,g,b} 0–255. */
export function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** The rendered status line: `ctx [██████░░░░] NN%` in a truecolor faded hue. */
export function renderBar(pct, len = BAR_LEN) {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  const { r, g, b } = hslToRgb(fillHue(pct), 0.7, 0.55);
  return `\x1b[38;2;${r};${g};${b}mctx [${bar}] ${pct}%\x1b[0m`;
}

/** Effective autoCompactWindow for a cwd: walk up to $HOME collecting each
 *  level's .claude/settings.local.json then settings.json (most-specific first),
 *  then global ~/.claude/settings.json. First numeric autoCompactWindow wins;
 *  null when none is configured. */
export function resolveAutoCompactWindow(cwd) {
  const home = homedir();
  const files = [];
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    files.push(join(dir, ".claude", "settings.local.json"));
    files.push(join(dir, ".claude", "settings.json"));
    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  files.push(join(home, ".claude", "settings.json"));
  for (const f of files) {
    try {
      const v = JSON.parse(readFileSync(f, "utf8")).autoCompactWindow;
      if (typeof v === "number" && v > 0) return v;
    } catch {
      /* missing/garbled — try the next */
    }
  }
  return null;
}

/** Last auto-compact preTokens from a transcript file, reading only the last
 *  TAIL_CAP bytes (bounded memory — safe to call every refresh across many panes).
 *  null on any error / missing file / no auto marker in the tail. */
function readAutoTriggerFromTranscript(file) {
  if (!file) return null;
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_CAP);
      const len = size - start;
      if (len <= 0) return null;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      return parseLastAutoCompactPreTokens(buf.toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Read the globally-cached last-known auto trigger (a bare integer). */
function readTriggerCache() {
  try {
    const n = parseInt(readFileSync(TRIGGER_CACHE, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Persist the latest observed auto trigger for other/fresh panes (best-effort;
 *  a bare integer so concurrent last-writer-wins can never corrupt it). */
function writeTriggerCache(n) {
  try {
    writeFileSync(TRIGGER_CACHE, String(n));
  } catch {
    /* best-effort cache — never break the status line over it */
  }
}

/** Drop a disproved trigger cache. Best-effort — never break the status line. */
function clearTriggerCache() {
  try {
    unlinkSync(TRIGGER_CACHE);
  } catch {
    /* already gone / not writable — the pickTrigger guard still ignores it */
  }
}

/** Build the status line from Claude's stdin JSON object. */
export function computeLine(input) {
  const cw = (input && input.context_window) || {};
  const tokens = cw.total_input_tokens || 0;
  const modelWindow = cw.context_window_size || DEFAULT_WINDOW;
  const cwd = (input && (input.cwd || (input.workspace && input.workspace.current_dir))) || process.cwd();
  const acw = resolveAutoCompactWindow(cwd);
  const effective = acw ? Math.min(modelWindow, acw) : modelWindow;

  // Pull the REAL compact point live: last trigger:"auto" preTokens from this
  // session's transcript. Cache it for fresh panes; formula only as last resort.
  const live = readAutoTriggerFromTranscript(input && input.transcript_path);
  if (live) writeTriggerCache(live);
  const cached = live ? null : readTriggerCache();
  // A cache this session has already passed is disproved — delete it so every OTHER
  // pane stops inheriting the same wrong denominator (it re-learns on the next real
  // auto-compact). Best-effort: a failed unlink just means we ignore it locally.
  if (cached !== null && tokens > cached) clearTriggerCache();
  const trigger = pickTrigger(live, cached, effective, tokens);

  return renderBar(contextPct(tokens, trigger));
}

// Run only when executed directly (not when imported by tests).
const invoked = process.argv[1] ? safeReal(process.argv[1]) : "";
if (invoked && invoked === safeReal(fileURLToPath(import.meta.url))) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw);
    } catch {
      /* no/garbled stdin — render an empty gauge rather than crash */
    }
    try {
      process.stdout.write(computeLine(input));
    } catch {
      /* never break the REPL's status line */
    }
  });
}

function safeReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
