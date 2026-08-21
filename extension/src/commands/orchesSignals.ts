// Signals the orches engine ALREADY writes into `<project>/.orches-state`, read by MC.
// Pure + `node:fs` only, NO vscode import: unit-tested standalone with `bun test`.
//
// ⛔⛔ Why this module exists. `orches-integrate.sh` publishes a liveness verdict and MC
// never read it: `_stamp_heartbeat` (orches-integrate.sh:4113) writes `heartbeat` on
// EVERY poll tick, `status` moves through `in-progress` → `paused-checkpoint` → `done`,
// and `sprint` carries `N/total`. MC read exactly ONE key of that file — `owner-session`
// (startOrchestrator.ts:338). So two very different situations both render as the same
// `⟳ กำลังทำ` forever: a run wedged with its session still alive, and a run parked at a
// checkpoint waiting for a human who was never told. The information was on disk the
// whole time.
//
// ⛔ Everything here is ADVISORY. It may label a card; it must NEVER gate a destructive
// action (reap / kill / delete). The engine's own `driver-alive` treats a stale
// heartbeat as "ask the user", not "it died" — and for a good reason: the stamp only
// happens inside engine verbs, so the orchestrator's own LLM turns (Step 4.7/4.8 sprint
// doc + memory capture) legitimately go quiet for minutes. Absent or unparsable answers
// "unknown" and says nothing at all.
import * as fs from "node:fs";
import * as path from "node:path";

import { parseStateValue } from "./orchestratorResume";

/** The three values `orches-integrate.sh` + SKILL.md Layer C actually stamp.
 *  (in-progress: prep-repo/open-sprint · paused-checkpoint: Step 5 · done: Step 6) */
export type OrchesStatus = "in-progress" | "paused-checkpoint" | "done";
const STATUSES: readonly string[] = ["in-progress", "paused-checkpoint", "done"];

/** Seconds after which the engine calls a heartbeat old — `ORCHES_HEARTBEAT_STALE`
 *  defaults to 600 at orches-integrate.sh:6075. Pinned by orchesParity.test.ts so the
 *  two sides cannot drift into reporting different verdicts on the same run. */
export const HEARTBEAT_STALE_SEC = 600;

export interface OrchesState {
  ownerSession: string | null;
  /** null when the key is absent OR holds anything outside the engine's three values. */
  status: OrchesStatus | null;
  /** raw text, for a tooltip — the key is free-form and other writers exist. */
  statusRaw: string | null;
  heartbeat: string | null;
  sprint: { n: number; total: number } | null;
}

/** `sprint: N/total` → the pair; null for anything else (never a half-read guess). */
export function parseSprintPair(v: string | null): { n: number; total: number } | null {
  const m = /^(\d{1,4})\s*\/\s*(\d{1,4})$/.exec((v ?? "").trim());
  if (!m) return null;
  return { n: Number(m[1]), total: Number(m[2]) };
}

export function parseOrchesState(raw: string): OrchesState {
  const statusRaw = parseStateValue(raw, "status");
  return {
    ownerSession: parseStateValue(raw, "owner-session"),
    status: statusRaw && STATUSES.includes(statusRaw) ? (statusRaw as OrchesStatus) : null,
    statusRaw,
    heartbeat: parseStateValue(raw, "heartbeat"),
    sprint: parseSprintPair(parseStateValue(raw, "sprint")),
  };
}

/** null on ENOENT or any read error — a project the engine never touched is normal. */
export function readOrchesState(projectPath: string): OrchesState | null {
  try {
    return parseOrchesState(fs.readFileSync(path.join(projectPath, ".orches-state"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Age of an engine heartbeat in ms — null when it cannot be read.
 *
 * ⛔ The engine writes `date +%FT%T`: local time, NO offset, and reads it back with
 * `date -d`. So MC must read it as LOCAL too — hence explicit components instead of
 * `Date.parse`, whose date-only form (`2026-08-21`) is UTC midnight by spec and would
 * come out hours off. Only the engine's exact shape is accepted; anything else is
 * unknown, which makes the feature fail QUIET (say nothing) rather than fail loud.
 * A heartbeat in the future (clock skew) clamps to 0, never a negative age.
 */
export function heartbeatAgeMs(heartbeat: string | null, nowMs: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec((heartbeat ?? "").trim());
  if (!m) return null;
  const t = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/**
 * Age of an ISO-8601 instant that CARRIES a zone — `new Date().toISOString()`, which is
 * what MC's own run marker writes for `startedAt` (startOrchestrator.ts:564).
 *
 * ⛔ Deliberately a different function from heartbeatAgeMs: the two inputs come from
 * different writers in different formats (engine `date +%FT%T` = zone-LESS local vs
 * MC `toISOString()` = UTC with `Z`). One lenient parser for both would have to guess a
 * zone for the ambiguous case, and guessing wrong is a silent multi-hour error. A
 * zone-less string is refused here — heartbeatAgeMs is the function that owns that shape.
 */
export function isoAgeMs(iso: string | null | undefined, nowMs: number): number | null {
  const v = (iso ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

export type Freshness = "fresh" | "stale" | "unknown";

/** `staleMs <= 0` turns the whole verdict off (the setting's "0 = ปิด" convention,
 *  same as pendingAsk.nagMinutes). Exactly ON the line still counts as fresh. */
export function heartbeatFreshness(heartbeat: string | null, nowMs: number, staleMs: number): Freshness {
  if (!(staleMs > 0)) return "unknown";
  const age = heartbeatAgeMs(heartbeat, nowMs);
  if (age === null) return "unknown";
  return age > staleMs ? "stale" : "fresh";
}
