// Pure logic + marker fs for the inline "▶ continue" button on the "⏮ ทำต่อ"
// (Orchestrator Projects) screen. NO vscode import here so the state machine can
// be unit-tested standalone with `bun test`; the tmux/git glue lives in
// startOrchestrator.ts. The single source of truth for a run is the per-project
// marker file `.orches-run.json`; button state is derived purely from
// (pending, marker, tmux-liveness).

import * as fs from "node:fs";
import * as path from "node:path";

import type { Freshness, OrchesStatus } from "./orchesSignals";
import type { SessionState } from "./tmuxProbe";
import { labelNamesProject } from "../webview/sessions";
import type { DrivenState, ResumableProject } from "./orchestratorResume";
import type { OracleTeam } from "./teams";

export type RunStatus = "running" | "done" | "error" | "cancelled";

export interface RunMarker {
  status: RunStatus;
  sprint?: number;
  sprints?: number; // how many sprints THIS run does (▶▶ = N); with `sprint`, tells
  //                   orches-drive which boundary is the last one of the run
  session?: string; // present for a live run; the bare terminal marker orches-drive
  sessionCreatedAt?: number; // tmux #{session_created}, epoch seconds
  baseMainSha?: string;
  startedAt?: string; // writes ({"status":"done"|"error"}) omits session/startedAt
  errorMsg?: string;
}

const STATUSES: readonly RunStatus[] = ["running", "done", "error", "cancelled"];

/** Tolerant parse: any bad input returns null, never throws. */
export function parseRunMarker(raw: string): RunMarker | null {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (!STATUSES.includes(o.status)) return null;
    // Only a live run must identify its tmux session + start time (the zombie
    // guard needs them). Terminal markers written by `/orches-drive --once` are
    // bare — `{"status":"done"}` / `{"status":"error","errorMsg":"…"}` — and must
    // still parse, else the extension never learns the sprint finished.
    if (o.status === "running" && (typeof o.session !== "string" || typeof o.startedAt !== "string"))
      return null;
    return o as RunMarker;
  } catch {
    return null;
  }
}

export function serializeRunMarker(m: RunMarker): string {
  return JSON.stringify(m, null, 2);
}

/** The `running` marker for a headless run. Pure so the numbers orches-drive
 *  depends on are unit-tested here, not only observable after a 5-sprint run.
 *  ⛔ `sprint` + `sprints` are a CONTRACT with the engine (`compact-should`): a
 *  multi-sprint run keeps this marker `running` the whole time, so status alone
 *  cannot tell an intermediate boundary (panes live on) from the final one (MC
 *  reaps the session). The engine skips its sprint-boundary /compact only once
 *  `(sprint-1)+sprints` sprints are ticked in plan.md. Dropping either field
 *  makes it fall back to skipping at EVERY boundary — which is how a worker rode
 *  to ctx 100% mid-run on newflow8 (2026-08-16). */
export function buildRunningMarker(o: {
  plannedDone?: number;
  sprints?: number;
  session?: string;
  sessionCreatedAt?: number;
  baseMainSha?: string;
  startedAt?: string;
}): RunMarker {
  const done = Number.isFinite(o.plannedDone) ? Math.max(0, Math.floor(o.plannedDone as number)) : 0;
  const n = Number.isFinite(o.sprints) ? Math.max(1, Math.floor(o.sprints as number)) : 1;
  return {
    status: "running",
    sprint: done + 1,
    sprints: n,
    session: o.session,
    sessionCreatedAt: o.sessionCreatedAt,
    baseMainSha: o.baseMainSha,
    startedAt: o.startedAt,
  };
}

export function runMarkerPath(projectPath: string): string {
  return path.join(projectPath, ".orches-run.json");
}

export function readRunMarker(projectPath: string): RunMarker | null {
  try {
    return parseRunMarker(fs.readFileSync(runMarkerPath(projectPath), "utf8"));
  } catch {
    return null; // ENOENT or any read error → treated as "no run"
  }
}

/** Atomic write: temp file + rename, so a concurrent reader never sees a
 *  half-written file (extension and orches-drive both write this path). */
export function writeRunMarker(projectPath: string, m: RunMarker): void {
  const dst = runMarkerPath(projectPath);
  const tmp = dst + ".tmp";
  fs.writeFileSync(tmp, serializeRunMarker(m));
  fs.renameSync(tmp, dst);
}

export type ButtonState = "hidden" | "idle" | "spinning" | "stale" | "error";
export interface Live {
  alive: boolean;
  createdAt?: number; // tmux #{session_created}, epoch seconds
}

/** Pending sprints: plan.md count wins (total-done), else open agents/* worktrees. */
export function pendingSprints(
  p: Pick<ResumableProject, "plannedTotal" | "plannedDone" | "openWorktrees">,
): number {
  const n =
    (p.plannedTotal ?? 0) > 0
      ? (p.plannedTotal as number) - (p.plannedDone ?? 0)
      : p.openWorktrees;
  return n < 0 ? 0 : n;
}

/** Button state derived purely from marker + tmux liveness.
 *  running is trusted ONLY when the live session's creation time matches the
 *  one recorded at launch — a reused session name (created ≠ recorded) is a
 *  zombie, so the run is stale, not spinning. */
export function resolveButtonState(
  pending: number,
  marker: RunMarker | null,
  live: Live,
): { state: ButtonState; errorMsg?: string } {
  if (marker?.status === "running") {
    const zombie =
      marker.sessionCreatedAt !== undefined &&
      live.createdAt !== undefined &&
      live.createdAt !== marker.sessionCreatedAt;
    return live.alive && !zombie ? { state: "spinning" } : { state: "stale" };
  }
  if (marker?.status === "error") return { state: "error", errorMsg: marker.errorMsg };
  // done / cancelled / null → not running
  return { state: pending > 0 ? "idle" : "hidden" };
}

/** Resolve which team + orchestrator to launch WITHOUT asking the user.
 *  Uses the project's last-driven team (.orches-meta.json → metaTeam) and the
 *  team's first orchestrator. Returns an error string for the rare edge where a
 *  pending project has no resolvable team (caller shows a toast, never a picker). */
export function resolveContinueTarget(
  project: Pick<ResumableProject, "metaTeam">,
  teams: OracleTeam[],
): { team: OracleTeam; orch: string } | { error: string } {
  if (!project.metaTeam) {
    return {
      error:
        "ไม่รู้ว่าจะใช้ทีมไหน (project นี้ยังไม่มี .orches-meta.json) — เปิดด้วย ⏮ ทำต่อ สักครั้งก่อน",
    };
  }
  const team = teams.find((t) => t.name === project.metaTeam);
  if (!team) return { error: `ไม่พบทีม '${project.metaTeam}' ใน ~/.maw/teams` };
  if (!team.orchestrators.length) {
    return { error: `ทีม '${team.name}' ไม่มี orchestrator — tag ก่อน` };
  }
  return { team, orch: team.orchestrators[0] };
}

/** A "running" marker counts as THIS project's live run only when a live tmux
 *  session with the marker's name is @orches_label'd for this project. Name-only
 *  liveness is wrong: a cold-tmux launch records the orchestrator's base pin (e.g.
 *  "09-foreman") as the session, so two projects launched across cold starts both
 *  record the SAME session name — then one live session lights every such project's
 *  card green (the observed cross-project bug). The label is set at session-create,
 *  so it is reliable from t0. Pure. */
export function runSessionLiveForProject(
  marker: RunMarker | null,
  liveSessions: readonly { name: string; orchesLabel?: string }[],
  basename: string,
): boolean {
  if (marker?.status !== "running" || !marker.session) return false;
  const name = marker.session;
  return liveSessions.some((s) => s.name === name && labelNamesProject(s.orchesLabel, basename));
}

export type ContinueAction = "already-running" | "attach" | "launch";

/** What the "▶ ทำต่อ" / "▶▶ ทำหลาย sprint" button should do, decided from the ONE
 *  detector's `DrivenState`, so it NEVER forks a second orchestrator onto a project
 *  already being driven (the 1-project-1-session rule):
 *   - `run` → `already-running`: this button's own headless run is live; the
 *     spinner already reflects it — don't relaunch or reopen a terminal.
 *   - `worker | owner | labeled` → `attach`: a session already drives it (incl. a
 *     checkpoint-paused orchestrator = `owner`) → re-enter it, never spawn a twin.
 *   - `none` → `launch`: nothing live → start a fresh detached run. */
export function decideContinueAction(state: DrivenState): ContinueAction {
  if (state === "run") return "already-running";
  if (state === "none") return "launch";
  return "attach";
}

/** Parse the "ทำหลาย sprint" popup input into a sprint count, clamped to what's
 *  actually left (`remaining`). Returns null for junk / <1 so the InputBox can
 *  reject it (or the caller can cancel). parseInt floors "2.5" → 2. */
export function clampSprintCount(raw: string, remaining: number): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, Math.max(1, remaining));
}

/** Sessions of headless runs that left "running" since the previous poll tick —
 *  i.e. their `.orches-run.json` flipped to done/error (or vanished). The done
 *  marker is rewritten bare (no `.session`), so the caller captured each run's
 *  session name WHILE it was live; this returns the ones to reap now. Blank
 *  sessions are skipped (nothing safe to kill). Pure — the tmux kill is the
 *  caller's job. */
/** What happened to a run that stopped being live between two poll ticks. */
export type RunTransition = "running" | "finished" | "died";

/**
 * Did that run FINISH, or did it DIE?
 *
 * ⛔⛔ The poll used to treat both identically: a run that dropped out of the live
 * set was reaped and re-rendered as a completion, so a session killed out-of-band
 * (OOM, a closed terminal, `tmux kill-server`) with its marker still saying
 * `running` showed up as a clean green finish. Hours of sprint could end that way
 * with nothing on screen saying so.
 *
 * The distinction is only ever safe to draw from a CONFIRMED absence — `unknown`
 * (we could not ask tmux) must read as "still running", never as a death. See
 * tmuxProbe.ts.
 *
 * `trackedSession` is the session this poll was following. A marker naming a
 * DIFFERENT session belongs to a run that started after we last looked, and writing
 * an error into it would break a healthy run's card.
 */
export function classifyRunTransition(o: {
  marker: RunMarker | null;
  sessionState: SessionState;
  trackedSession: string;
}): RunTransition {
  if (o.sessionState !== "absent") return "running";
  const m = o.marker;
  if (!m || m.status !== "running") return "finished";
  if (m.session && o.trackedSession && m.session !== o.trackedSession) return "finished";
  return "died";
}

export function finishedSessions(
  prev: ReadonlyMap<string, string>,
  nowRunningPaths: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [path, session] of prev) {
    if (!nowRunningPaths.has(path) && session) out.push(session);
  }
  return out;
}

/** Cancel precedence: if the sprint finished/merged in the race between the
 *  user clicking cancel and orches-drive landing it, DON'T fake a cancel or
 *  revert merged work — keep the done outcome. */
export function decideCancelOutcome(
  statusAfterKill: RunStatus | undefined,
  alreadyMerged: boolean,
): "keep_done" | "revert" {
  if (statusAfterKill === "done" || alreadyMerged) return "keep_done";
  return "revert";
}

/**
 * What the run marker must say once `orches-integrate.sh abort` has spoken.
 *
 * ⛔ Cancel used to write `status: "cancelled"` unconditionally — including from
 * the `catch`, i.e. when bash never ran (engine not installed on this machine) or
 * died. "cancelled" reads as "the run was stopped AND the tree was put back", so
 * the card went quiet while `agents/*` worktrees and a moved `main` were still
 * sitting there. Same unearned-success class as a gate reporting OK it never ran.
 *
 * abort has three answers and they mean different things:
 *   ABORTED            — main was reset back to base. Reverted.
 *   ABORT_NOOP_AT_BASE — main was already at base; nothing to rewind. Reverted.
 *   ABORT_SKIP_PUSHED  — origin/main is ahead of base, so abort DELIBERATELY left
 *                        history alone: the sprint's work is merged upstream and
 *                        kept. That is keep-done, the same word decideCancelOutcome
 *                        uses — calling it "cancelled" would claim a revert that
 *                        was never even attempted.
 * Anything else (throw, empty, unknown token) = we do not know what state the
 * repo is in, so say so: `error` renders as a chip carrying errorMsg and leaves
 * every button enabled, so it informs without blocking.
 */
export function decideAbortOutcome(verdict: string | null): { status: RunStatus; errorMsg?: string } {
  const v = (verdict ?? "").trim().split("\n").pop()?.trim() ?? "";
  if (v === "ABORTED" || v === "ABORT_NOOP_AT_BASE") return { status: "cancelled" };
  if (v === "ABORT_SKIP_PUSHED") return { status: "done" };
  return {
    status: "error",
    errorMsg: `ยกเลิก session แล้ว แต่ย้อนของกลับไม่สำเร็จ — abort ตอบว่า "${v || "ไม่ได้ตอบอะไรเลย"}" · worktree agents/* และ main อาจยังค้างอยู่ ต้องตรวจเอง`,
  };
}

/** สิ่งที่การ์ด project โชว์ จาก 2 สัญญาณเดิม (ButtonState + driven) + จำนวนงานค้าง:
 *  - busy (spinning/driven) → คงปุ่ม "กำลังทำ" เดิม (คลิกยกเลิก/เข้า session) + ป้าย
 *    health ถ้ามี (รอรีวิว / อาจค้าง — ดู resolveRunHealth · ป้ายเท่านั้น ไม่แตะปุ่ม)
 *  - none (ไม่มีงานค้าง) → ไม่มีปุ่ม แม้ marker ค้าง stale/error (0 เหลือ = จบจริง)
 *  - actions → โชว์ 2 ปุ่มถาวร: "ทำ 1 sprint" เสมอ + "ทำ N sprint" (เปิดเมื่อเหลือ>=2)
 *    · crash = สาเหตุที่รอบก่อนไม่จบ (stale = session ดับกลางคัน · error = orches-drive
 *      เขียน marker error) → webview โชว์ chip + ขอบเตือน · null = ค้างปกติ
 *  Pure — host คำนวณตัวนี้ก่อนส่งการ์ดให้ webview (webview import host TS ไม่ได้). */
export type CardActions =
  | { kind: "busy"; health?: RunHealth }
  | { kind: "none" }
  | { kind: "actions"; runNEnabled: boolean; crash: "stale" | "error" | null };

/** ป้ายกำกับการ์ดที่ "กำลังทำ" อยู่ — checkpoint = จบ sprint จอดรอคนรีวิว ·
 *  stalled = session ยังอยู่แต่ engine ไม่ปั๊ม heartbeat มานานแล้ว */
export type RunHealth = "checkpoint" | "stalled";

/**
 * แยก 3 สถานะที่การ์ดเคยเรียกว่า `⟳ กำลังทำ` เหมือนกันหมดออกจากกัน จากสัญญาณที่
 * engine เขียนลง `.orches-state` อยู่แล้ว (ดู orchesSignals.ts).
 *
 * ⛔⛔ ลำดับสำคัญ: `paused-checkpoint` ต้องมาก่อน heartbeat — การจอดรอคนตอบทำให้
 *   heartbeat เก่าโดยธรรมชาติ (เทิร์นจบไปแล้ว ไม่มี verb ไหนวิ่ง) ถ้าเรียงกลับกัน
 *   ทุกครั้งที่ user ลุกไปกินข้าวจะถูกป้ายว่า "อาจค้าง" = โบ้ยผิด
 * ⛔ `done` + heartbeat เก่า = เรื่องปกติ (จบรันแล้ว session ยังเปิดอยู่) → เงียบ
 * ⛔ ผลลัพธ์นี้เป็น "ป้าย" เท่านั้น ห้ามเอาไปสั่ง reap/kill/ลบ — heartbeat ปั๊มแค่ตอน
 *   engine verb ทำงาน เทิร์นที่ orchestrator เขียน sprint doc/เก็บ memory (Step 4.7–4.8)
 *   เงียบได้เป็นนาทีโดยชอบธรรม · engine เองใช้ค่าเดียวกันนี้แค่เพื่อ "ถาม user"
 */
export function resolveRunHealth(a: {
  busy: boolean;
  orchesStatus: OrchesStatus | null;
  heartbeat: Freshness;
  /** ไม่มี heartbeat ให้อ่านเลย แม้รันเปิดมานานพอที่ engine ควรปั๊มครั้งแรกไปแล้ว
   *  (ดู silentSinceStart) = รันที่ตายตั้งแต่ต้น ซึ่ง heartbeat มองไม่เห็นโดยนิยาม */
  silentStart?: boolean;
}): RunHealth | null {
  if (!a.busy) return null;
  if (a.orchesStatus === "paused-checkpoint") return "checkpoint";
  if (a.orchesStatus === "done") return null;
  if (a.heartbeat === "stale") return "stalled";
  if (a.heartbeat === "unknown" && a.silentStart) return "stalled";
  return null;
}

/**
 * "รันนี้ไม่เคยปั๊ม heartbeat แม้แต่ครั้งเดียว ทั้งที่เปิดมานานแล้ว" — ช่องที่ heartbeat
 * เพียว ๆ มองไม่เห็น: ถ้า orchestrator ตายก่อนจะเรียก verb แรก ก็ไม่มีค่าให้เทียบอายุ
 * แล้วการ์ดจะขึ้น `⟳ กำลังทำ` ค้างตลอดกาล (นี่คือ `startedAt` ที่ถูกเขียน + ถูกบังคับ
 * ให้มีใน parseRunMarker แต่ไม่มีใครอ่าน — audit item 2c)
 *
 * ⛔ ต้อง `spinning` เท่านั้น = marker running + session ที่ label ตรงโปรเจกต์นี้ยังอยู่
 *   + ไม่ใช่ zombie · รันที่ MC ยิงเองทุกตัวเดินผ่าน orches-drive ซึ่ง stamp heartbeat
 *   ที่ prep-repo (Step 2.1/4.0) ก่อนงาน sprint ใด ๆ → เงียบเกิน 2 เท่าของเส้น stale
 *   คือผิดปกติจริง ไม่ใช่ sprint ที่ยาว
 * ⛔ เผื่อ 2 เท่าเสมอ (ไม่ใช่เส้นเดียวกับ heartbeat) เพราะช่วงบูต tmux + โหลด CLAUDE.md
 *   + gate แผน กินเวลาก่อนถึง verb แรกได้จริง · ราคาของการโบ้ยผิดคือป้ายหนึ่งใบ
 *   แต่ยังไม่มีเหตุให้ยิงเร็วกว่านั้น
 */
export function silentSinceStart(a: {
  spinning: boolean;
  heartbeat: Freshness;
  runAgeMs: number | null;
  staleMs: number;
}): boolean {
  if (!a.spinning || a.heartbeat !== "unknown" || !(a.staleMs > 0)) return false;
  return a.runAgeMs !== null && a.runAgeMs > a.staleMs * 2;
}

export function resolveCardActions(
  state: ButtonState,
  driven: boolean,
  pending: number,
  health?: RunHealth | null,
): CardActions {
  if (state === "spinning" || driven) return health ? { kind: "busy", health } : { kind: "busy" };
  if (pending <= 0) return { kind: "none" };
  const crash = state === "stale" ? "stale" : state === "error" ? "error" : null;
  return { kind: "actions", runNEnabled: pending >= 2, crash };
}
