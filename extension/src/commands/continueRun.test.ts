import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRunMarker,
  serializeRunMarker,
  runMarkerPath,
  readRunMarker,
  writeRunMarker,
  pendingSprints,
  resolveButtonState,
  resolveContinueTarget,
  decideCancelOutcome,
  decideAbortOutcome,
  decideContinueAction,
  finishedSessions,
  clampSprintCount,
  runSessionLiveForProject,
  resolveCardActions,
  type RunMarker,
} from "./continueRun";
import type { OracleTeam } from "./teams";

const RUNNING: RunMarker = {
  status: "running",
  sprint: 3,
  session: "claude-foreman",
  sessionCreatedAt: 1_700_000_000,
  baseMainSha: "abc1234",
  startedAt: "2026-07-10T08:00:00.000Z",
};

// --- Task 1: marker parse / serialize / read / write ---

test("parseRunMarker: valid JSON round-trips", () => {
  expect(parseRunMarker(serializeRunMarker(RUNNING))).toEqual(RUNNING);
});

test("parseRunMarker: malformed/garbage → null (never throws)", () => {
  expect(parseRunMarker("{not json")).toBeNull();
  expect(parseRunMarker("")).toBeNull();
  expect(parseRunMarker("[1,2,3]")).toBeNull(); // not an object with status
  expect(parseRunMarker('{"foo":1}')).toBeNull(); // no status
});

test("parseRunMarker: bare terminal marker from `/orches-drive --once` parses", () => {
  // orches-drive writes these on completion (no session/startedAt) — they MUST
  // parse so the extension detects the sprint finished and auto-refreshes.
  expect(parseRunMarker('{"status":"done"}')).toEqual({ status: "done" });
  expect(parseRunMarker('{"status":"error","errorMsg":"STOP:gh"}')).toEqual({
    status: "error",
    errorMsg: "STOP:gh",
  });
});

test("parseRunMarker: a RUNNING marker still requires session + startedAt", () => {
  expect(parseRunMarker('{"status":"running"}')).toBeNull(); // no session/startedAt
  expect(parseRunMarker('{"status":"running","session":"s"}')).toBeNull(); // no startedAt
});

test("runMarkerPath: joins .orches-run.json at project root", () => {
  expect(runMarkerPath("/x/proj")).toBe(join("/x/proj", ".orches-run.json"));
});

test("read/write: missing file → null; written file reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "orun-"));
  try {
    expect(readRunMarker(dir)).toBeNull();
    writeRunMarker(dir, RUNNING);
    expect(readRunMarker(dir)).toEqual(RUNNING);
    // atomic write leaves NO stray temp file
    expect(existsSync(join(dir, ".orches-run.json.tmp"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunMarker: corrupt file → null (tolerant)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orun-"));
  try {
    writeFileSync(join(dir, ".orches-run.json"), "{half-written");
    expect(readRunMarker(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Task 2: pendingSprints + resolveButtonState ---

test("pendingSprints: plan wins (total-done); else open worktrees; never <0", () => {
  expect(pendingSprints({ plannedTotal: 5, plannedDone: 2, openWorktrees: 9 })).toBe(3);
  expect(pendingSprints({ plannedDone: 0, openWorktrees: 2 })).toBe(2); // no plannedTotal
  expect(pendingSprints({ plannedTotal: 3, plannedDone: 5, openWorktrees: 0 })).toBe(0);
});

const alive = (createdAt?: number) => ({ alive: true, createdAt });
const dead = { alive: false as const };

test("running + alive + matching session → spinning", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, alive(100)).state).toBe("spinning");
});

test("running + session dead → stale", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, dead).state).toBe("stale");
});

test("running + session name reused (created differs) → stale (zombie guard)", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, alive(999)).state).toBe("stale");
});

test("error → error + message", () => {
  const m = { status: "error", session: "s", startedAt: "x", errorMsg: "STOP:gh" } as const;
  expect(resolveButtonState(2, m, dead)).toEqual({ state: "error", errorMsg: "STOP:gh" });
});

test("done/cancelled/null → idle if pending, hidden if none", () => {
  const done = { status: "done", session: "s", startedAt: "x" } as const;
  expect(resolveButtonState(1, done, dead).state).toBe("idle");
  expect(resolveButtonState(0, done, dead).state).toBe("hidden");
  expect(resolveButtonState(0, null, dead).state).toBe("hidden");
  expect(resolveButtonState(3, null, dead).state).toBe("idle");
});

test("unknown-but-running-ish preserved: alive session with running keeps spinning even if createdAt unknown", () => {
  const m = { status: "running", session: "s", startedAt: "x" } as const; // no sessionCreatedAt
  expect(resolveButtonState(2, m, alive(undefined)).state).toBe("spinning");
});

// --- Task 3: resolveContinueTarget ---

const team = (name: string, orchestrators: string[]): OracleTeam =>
  ({ name, members: [], orchestrators }) as unknown as OracleTeam;

test("resolveContinueTarget: metaTeam + single orchestrator → that orch", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", ["foreman"])]);
  expect(r).toEqual({ team: team("brew", ["foreman"]), orch: "foreman" });
});

test("resolveContinueTarget: >1 orchestrator → orchestrators[0] deterministic", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", ["foreman", "mike"])]);
  expect("orch" in r && r.orch).toBe("foreman");
});

test("resolveContinueTarget: metaTeam not among teams → error", () => {
  const r = resolveContinueTarget({ metaTeam: "ghost" }, [team("brew", ["foreman"])]);
  expect("error" in r).toBe(true);
});

test("resolveContinueTarget: no metaTeam → error (never asks/blocks)", () => {
  const r = resolveContinueTarget({}, [team("brew", ["foreman"])]);
  expect("error" in r).toBe(true);
});

test("resolveContinueTarget: team has no orchestrators → error", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", [])]);
  expect("error" in r).toBe(true);
});

// --- Task 4: decideCancelOutcome ---

test("decideCancelOutcome: status became done → keep_done (no revert)", () => {
  expect(decideCancelOutcome("done", false)).toBe("keep_done");
});
test("decideCancelOutcome: sprint already merged → keep_done", () => {
  expect(decideCancelOutcome("running", true)).toBe("keep_done");
});
test("decideCancelOutcome: still running, not merged → revert", () => {
  expect(decideCancelOutcome("running", false)).toBe("revert");
  expect(decideCancelOutcome(undefined, false)).toBe("revert");
});

// --- Task 4b: decideAbortOutcome — marker ต้องพูดตามที่ abort ทำจริง ---
// ⛔ เดิม cancel เขียน status "cancelled" ทุกกรณี แม้ execFileSync จะโยน (สคริปต์ engine
//    ไม่มีในเครื่อง / bash ตาย) — คือ "ยกเลิกแล้วย้อนของคืนแล้ว" ทั้งที่ worktree agents/*
//    กับ main ยังค้างอยู่ครบ · abort มี 3 คำตอบและมันหมายคนละอย่างกัน จึงต้องอ่านมัน

test("decideAbortOutcome: ABORTED (ย้อน main กลับ base จริง) → cancelled", () => {
  expect(decideAbortOutcome("ABORTED")).toEqual({ status: "cancelled" });
});

test("decideAbortOutcome: ABORT_NOOP_AT_BASE (main อยู่ที่ base อยู่แล้ว) → cancelled", () => {
  expect(decideAbortOutcome("ABORT_NOOP_AT_BASE")).toEqual({ status: "cancelled" });
});

test("decideAbortOutcome: ABORT_SKIP_PUSHED → done — งานถูก push แล้ว abort จงใจไม่ย้อน", () => {
  // เรียกว่า cancelled = โกหกว่าถูกย้อนคืน · คำที่ถูกคือ keep-done ตัวเดียวกับ decideCancelOutcome
  expect(decideAbortOutcome("ABORT_SKIP_PUSHED")).toEqual({ status: "done" });
});

test("decideAbortOutcome: abort ไม่ได้รัน/พัง → error พร้อมบอกว่าอาจมีของค้าง", () => {
  const r = decideAbortOutcome(null);
  expect(r.status).toBe("error");
  expect(r.errorMsg ?? "").not.toBe("");
});

test("decideAbortOutcome: คำตอบที่ไม่รู้จัก = ไม่เดาว่าสำเร็จ", () => {
  expect(decideAbortOutcome("").status).toBe("error");
  expect(decideAbortOutcome("fatal: not a git repository").status).toBe("error");
});

test("decideAbortOutcome: verdict คือบรรทัดสุดท้าย (คำเตือนก่อนหน้าไม่กวน)", () => {
  expect(decideAbortOutcome("land: hard-guard SKIP:no-base\nABORTED\n")).toEqual({ status: "cancelled" });
});

// --- Task 5: decideContinueAction (▶ ทำต่อ collision guard, state-based) ---
// Decided from the ONE detector's DrivenState so the button never forks a twin
// onto a project already being driven (incl. checkpoint-pause = "owner").

test("decideContinueAction: run→already-running (this button's own live run) ", () => {
  expect(decideContinueAction("run")).toBe("already-running");
});

test("decideContinueAction: worker|owner|labeled → attach (a session already drives it)", () => {
  expect(decideContinueAction("worker")).toBe("attach"); // worker pane grinding
  expect(decideContinueAction("owner")).toBe("attach"); // orchestrator session alive (e.g. checkpoint pause)
  expect(decideContinueAction("labeled")).toBe("attach"); // @orches_label session
});

test("decideContinueAction: none → launch (nothing live)", () => {
  expect(decideContinueAction("none")).toBe("launch");
});

// --- Task 6: finishedSessions (reap a headless run's session once it completes) ---
// The done/error marker is rewritten bare (drops .session), so the session name
// must be captured WHILE the run is live (prev tick) and reaped on the transition.

test("finishedSessions: sessions of runs that left 'running' since last tick (skips blank session)", () => {
  const prev = new Map([
    ["/a", "sa"], // still running → not reaped
    ["/b", "sb"], // finished → reap sb
    ["/c", ""], // finished but no session captured → skip
  ]);
  expect(finishedSessions(prev, new Set(["/a"]))).toEqual(["sb"]);
});

test("finishedSessions: nothing left running-set → empty", () => {
  expect(finishedSessions(new Map([["/a", "sa"]]), new Set(["/a"]))).toEqual([]);
  expect(finishedSessions(new Map(), new Set(["/a"]))).toEqual([]);
});

// --- Task 7: clampSprintCount (multi-sprint "ทำหลาย sprint" popup input) ---

test("clampSprintCount: parses + caps at remaining", () => {
  expect(clampSprintCount("2", 4)).toBe(2);
  expect(clampSprintCount("4", 4)).toBe(4);
  expect(clampSprintCount("9", 4)).toBe(4); // more than remaining → cap
  expect(clampSprintCount("1", 4)).toBe(1);
  expect(clampSprintCount("  3 ", 4)).toBe(3); // trims
});

test("clampSprintCount: <1 / NaN / empty → null (invalid)", () => {
  expect(clampSprintCount("0", 4)).toBeNull();
  expect(clampSprintCount("-2", 4)).toBeNull();
  expect(clampSprintCount("abc", 4)).toBeNull();
  expect(clampSprintCount("", 4)).toBeNull();
  expect(clampSprintCount("2.5", 4)).toBe(2); // parseInt floors
});

// --- run-liveness must be scoped to THIS project by @orches_label, not just the
//     session name (cold-launch records the base pin, so two projects can record
//     the SAME session name → name-only liveness cross-lights both green) ---

const RUN_ON: RunMarker = { status: "running", sprint: 3, session: "09-foreman", startedAt: "x" };

test("runSessionLiveForProject: session labeled for THIS project → live", () => {
  const sessions = [{ name: "09-foreman", orchesLabel: "proj-v10 / brew" }];
  expect(runSessionLiveForProject(RUN_ON, sessions, "proj-v10")).toBe(true);
});

test("runSessionLiveForProject: same session name but labeled for ANOTHER project → NOT live (the bug)", () => {
  // 09-foreman is alive but driving proj-v9; proj-v10's marker names the same base
  // session — name-only match would falsely light proj-v10 green.
  const sessions = [{ name: "09-foreman", orchesLabel: "proj-v9 / brew" }];
  expect(runSessionLiveForProject(RUN_ON, sessions, "proj-v10")).toBe(false);
});

test("runSessionLiveForProject: session name not live at all → NOT live", () => {
  expect(runSessionLiveForProject(RUN_ON, [{ name: "other", orchesLabel: "proj-v10 / brew" }], "proj-v10")).toBe(false);
});

test("runSessionLiveForProject: marker not running / no session / null → NOT live", () => {
  const s = [{ name: "09-foreman", orchesLabel: "proj-v10 / brew" }];
  expect(runSessionLiveForProject({ status: "done" }, s, "proj-v10")).toBe(false);
  expect(runSessionLiveForProject({ status: "running", startedAt: "x" } as RunMarker, s, "proj-v10")).toBe(false);
  expect(runSessionLiveForProject(null, s, "proj-v10")).toBe(false);
});

test("runSessionLiveForProject: unlabeled live session → NOT live (can't prove ownership)", () => {
  expect(runSessionLiveForProject(RUN_ON, [{ name: "09-foreman" }], "proj-v10")).toBe(false);
});

// --- Task 8: resolveCardActions (2 ปุ่มถาวร + crash indicator) ---

test("resolveCardActions: spinning หรือ driven → busy (คงปุ่ม 'กำลังทำ' เดิม)", () => {
  expect(resolveCardActions("spinning", false, 3)).toEqual({ kind: "busy" });
  expect(resolveCardActions("idle", true, 3)).toEqual({ kind: "busy" }); // driven ชนะ
  expect(resolveCardActions("stale", true, 3)).toEqual({ kind: "busy" }); // driven ชนะ state
});

test("resolveCardActions: ไม่มีงานค้าง (pending<=0) → none แม้ marker stale/error", () => {
  expect(resolveCardActions("idle", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("stale", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("error", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("hidden", false, 0)).toEqual({ kind: "none" });
});

test("resolveCardActions: idle+ค้าง → actions ไม่มี crash; ปุ่ม N เปิดเมื่อเหลือ>=2", () => {
  expect(resolveCardActions("idle", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: null });
  expect(resolveCardActions("idle", false, 2)).toEqual({ kind: "actions", runNEnabled: true, crash: null });
  expect(resolveCardActions("idle", false, 5)).toEqual({ kind: "actions", runNEnabled: true, crash: null });
});

test("resolveCardActions: stale → actions + crash 'stale' (session ดับ)", () => {
  expect(resolveCardActions("stale", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: "stale" });
  expect(resolveCardActions("stale", false, 3)).toEqual({ kind: "actions", runNEnabled: true, crash: "stale" });
});

test("resolveCardActions: error → actions + crash 'error'", () => {
  expect(resolveCardActions("error", false, 2)).toEqual({ kind: "actions", runNEnabled: true, crash: "error" });
  expect(resolveCardActions("error", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: "error" });
});
