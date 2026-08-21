import { describe, expect, test } from "bun:test";
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
  buildRunningMarker,
  runSessionLiveForProject,
  resolveCardActions,
  type RunMarker,
  classifyRunTransition,
  resolveRunHealth,
  silentSinceStart,
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

// ⛔⛔ บั๊กจริง newflow8 (2026-08-16): ปุ่ม "▶▶ ทำหลาย sprint" ปล่อย marker running ค้างทั้งรัน
//   → engine (compact-should) ที่ดูแค่ status ปิด sprint-boundary /compact ทุกรอยต่อ ทั้งที่ MC
//   เก็บ session ทิ้งแค่ตอนจบรัน → worker ชน ctx 100% กลางทาง · marker ต้องบอก "รันนี้กี่ sprint"
//   ให้ engine คำนวณเองได้ว่ารอยต่อไหนคือรอบสุดท้าย (ติ๊กครบ sprint-1+sprints)
test("buildRunningMarker: พก sprint แรก + จำนวน sprint ของรันนี้ (engine ใช้หาว่ารอบไหนคือรอบสุดท้าย)", () => {
  const m = buildRunningMarker({
    plannedDone: 2,
    sprints: 3,
    session: "claude-foreman",
    sessionCreatedAt: 1_700_000_000,
    baseMainSha: "abc1234",
    startedAt: "2026-08-16T08:00:00.000Z",
  });
  expect(m.status).toBe("running");
  expect(m.sprint).toBe(3); // plannedDone+1 = sprint แรกของรันนี้
  expect(m.sprints).toBe(3);
  expect(parseRunMarker(serializeRunMarker(m))).toEqual(m); // round-trip ผ่าน parser เดิม
});

test("buildRunningMarker: ปุ่ม 1 sprint / โปรเจกต์ยังไม่ติ๊กอะไร = sprint 1 sprints 1", () => {
  const m = buildRunningMarker({ session: "s", startedAt: "t" });
  expect(m.sprint).toBe(1);
  expect(m.sprints).toBe(1);
  // ค่าเพี้ยน (NaN/0/ติดลบ/เศษ) ต้องไม่หลุดลง marker — engine ใช้เลขนี้คำนวณโควตารัน
  expect(buildRunningMarker({ session: "s", startedAt: "t", sprints: 0 }).sprints).toBe(1);
  expect(buildRunningMarker({ session: "s", startedAt: "t", sprints: -4 }).sprints).toBe(1);
  expect(buildRunningMarker({ session: "s", startedAt: "t", sprints: 2.7 }).sprints).toBe(2);
  expect(buildRunningMarker({ session: "s", startedAt: "t", sprints: NaN }).sprints).toBe(1);
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

// ⛔⛔ 2b: the spin poll reaped a DEATH exactly like a clean finish. A run whose
// session vanished with its marker still saying `running` was rewritten as a normal
// completion — the card went green, the button unlocked, and nothing said the sprint
// had died mid-flight. The classification has to be explicit, and it has to be pure
// so it is testable without the webview.
describe("classifyRunTransition", () => {
  const live: RunMarker = { status: "running", session: "claude-bob", startedAt: "2026-08-21T00:00:00.000Z" };

  test("R1 marker ยัง running + tmux ยืนยันว่า session หายไป = ตายกลางรัน", () => {
    expect(classifyRunTransition({ marker: live, sessionState: "absent", trackedSession: "claude-bob" })).toBe(
      "died",
    );
  });

  test("R2 marker เขียน done/error/cancelled แล้ว = จบตามปกติ", () => {
    for (const status of ["done", "error", "cancelled"] as const) {
      expect(
        classifyRunTransition({ marker: { status }, sessionState: "absent", trackedSession: "claude-bob" }),
      ).toBe("finished");
    }
  });

  test("R3 ไม่มี marker แล้ว = จบตามปกติ (ถูกลบ/ถูกเขียนทับ)", () => {
    expect(classifyRunTransition({ marker: null, sessionState: "absent", trackedSession: "claude-bob" })).toBe(
      "finished",
    );
  });

  test("R4 ถาม tmux ไม่ได้ = ยังถือว่ารันอยู่ ห้ามประกาศว่าตาย", () => {
    expect(
      classifyRunTransition({ marker: live, sessionState: "unknown", trackedSession: "claude-bob" }),
    ).toBe("running");
    expect(
      classifyRunTransition({ marker: live, sessionState: "present", trackedSession: "claude-bob" }),
    ).toBe("running");
  });

  test("R5 marker เป็นของรันใหม่ (session ไม่ตรงกับตัวที่เราตาม) = ห้ามแตะ", () => {
    // A second run can start for the same project between two ticks. Writing an
    // error into ITS marker would kill a healthy run's card.
    expect(
      classifyRunTransition({
        marker: { status: "running", session: "claude-bob-2", startedAt: "2026-08-21T01:00:00.000Z" },
        sessionState: "absent",
        trackedSession: "claude-bob",
      }),
    ).toBe("finished");
  });
});

// --- Task 12: resolveRunHealth — แยก "รอคนรีวิว" กับ "อาจค้าง" ออกจาก "กำลังทำ" ---
//
// ⛔⛔ ก่อนหน้านี้การ์ดมีคำเดียวคือ `⟳ กำลังทำ` สำหรับ 3 สถานะที่ต่างกันสิ้นเชิง:
//   (1) ทำงานอยู่จริง (2) จบ sprint แล้วจอดรอคนรีวิว (engine เขียน status:paused-checkpoint
//   ไว้ตั้งแต่ก่อน checkpoint ทุกครั้ง) (3) session ยังอยู่แต่ไม่มีอะไรขยับแล้ว
//   → run LP 08-20/21 บล็อกรอคนสองครั้ง โดยไม่มีอะไรบอกใครเลย
// ⛔ ผลลัพธ์ที่นี่เป็น "ป้าย" เท่านั้น — ห้ามเอาไปสั่ง reap/kill/ลบ (heartbeat ปั๊มแค่ตอน
//   engine verb ทำงาน → เทิร์นที่ orchestrator เขียนเอกสาร/เก็บ memory เงียบได้เป็นนาที
//   โดยชอบธรรม · engine เองก็ใช้ค่านี้แค่ "ถาม user" ไม่ใช่ "ตายแล้ว")
test("resolveRunHealth: การ์ดที่ไม่ busy ไม่มีป้ายสุขภาพ (ปุ่มปกติอธิบายตัวเองอยู่แล้ว)", () => {
  expect(resolveRunHealth({ busy: false, orchesStatus: "paused-checkpoint", heartbeat: "stale" })).toBeNull();
  expect(resolveRunHealth({ busy: false, orchesStatus: "in-progress", heartbeat: "stale" })).toBeNull();
});

test("resolveRunHealth: paused-checkpoint = 'รอรีวิว' ไม่ใช่ค้าง (แม้ heartbeat เก่า)", () => {
  // จอดรอคนตอบ = heartbeat ต้องเก่าอยู่แล้วโดยธรรมชาติ (turn จบไปแล้ว) → ถ้าเรียงกลับ
  // จะกลายเป็น "อาจค้าง" ทุกครั้งที่ user ไปกินข้าว ซึ่งเป็นการโบ้ยผิด
  expect(resolveRunHealth({ busy: true, orchesStatus: "paused-checkpoint", heartbeat: "stale" })).toBe("checkpoint");
  expect(resolveRunHealth({ busy: true, orchesStatus: "paused-checkpoint", heartbeat: "fresh" })).toBe("checkpoint");
});

test("resolveRunHealth: status done + heartbeat เก่า = ไม่ต้องเตือน (จบแล้ว เก่าเป็นเรื่องปกติ)", () => {
  expect(resolveRunHealth({ busy: true, orchesStatus: "done", heartbeat: "stale" })).toBeNull();
});

test("resolveRunHealth: heartbeat เก่าระหว่าง in-progress = 'อาจค้าง'", () => {
  expect(resolveRunHealth({ busy: true, orchesStatus: "in-progress", heartbeat: "stale" })).toBe("stalled");
  expect(resolveRunHealth({ busy: true, orchesStatus: "in-progress", heartbeat: "fresh" })).toBeNull();
  // unknown = อ่านไม่ได้/ไม่มีไฟล์ → เงียบ ห้ามเดา
  expect(resolveRunHealth({ busy: true, orchesStatus: "in-progress", heartbeat: "unknown" })).toBeNull();
  expect(resolveRunHealth({ busy: true, orchesStatus: null, heartbeat: "unknown" })).toBeNull();
});

test("resolveRunHealth: ไม่มีคีย์ status แต่มี heartbeat เก่า = ยังเตือนได้ (build เก่า)", () => {
  expect(resolveRunHealth({ busy: true, orchesStatus: null, heartbeat: "stale" })).toBe("stalled");
});

test("resolveCardActions: busy พก health ไปให้ webview · การ์ดที่ไม่ busy ไม่พก", () => {
  expect(resolveCardActions("spinning", false, 3, "stalled")).toEqual({ kind: "busy", health: "stalled" });
  expect(resolveCardActions("idle", true, 3, "checkpoint")).toEqual({ kind: "busy", health: "checkpoint" });
  expect(resolveCardActions("spinning", false, 3, null)).toEqual({ kind: "busy" });
  expect(resolveCardActions("spinning", false, 3)).toEqual({ kind: "busy" });
  // ป้ายสุขภาพต้องไม่รั่วไปโหมดที่มีปุ่มจริง (ปุ่มบอกอยู่แล้วว่ารันไม่จบ)
  expect(resolveCardActions("stale", false, 2, "stalled")).toEqual({ kind: "actions", runNEnabled: true, crash: "stale" });
});

// --- Task 13: silentSinceStart — รันที่ตายก่อนปั๊ม heartbeat ครั้งแรก (startedAt ที่ไม่มีใครอ่าน) ---
const SS = { spinning: true, heartbeat: "unknown" as const, staleMs: 600_000 };

test("silentSinceStart: เงียบเกิน 2 เท่าของเส้น stale = ผิดปกติ · ต่ำกว่านั้น = ยังบูตอยู่", () => {
  expect(silentSinceStart({ ...SS, runAgeMs: 1_200_001 })).toBe(true);
  expect(silentSinceStart({ ...SS, runAgeMs: 1_200_000 })).toBe(false); // เส้นพอดี = ยังไม่ฟ้อง
  expect(silentSinceStart({ ...SS, runAgeMs: 60_000 })).toBe(false); // เพิ่งเริ่ม
  expect(silentSinceStart({ ...SS, runAgeMs: null })).toBe(false); // อ่าน startedAt ไม่ได้ = เงียบ
});

test("silentSinceStart: ใช้ได้เฉพาะตอนไม่มี heartbeat จริง ๆ และ session ยังอยู่", () => {
  // มี heartbeat อ่านได้ = ให้ heartbeat ตัดสิน (อันนี้เป็นช่องเสริม ไม่ใช่ตัวแทน)
  expect(silentSinceStart({ ...SS, heartbeat: "fresh", runAgeMs: 9_999_999 })).toBe(false);
  expect(silentSinceStart({ ...SS, heartbeat: "stale", runAgeMs: 9_999_999 })).toBe(false);
  // ไม่ spinning = marker ไม่ running / session ไม่อยู่ / zombie → ปุ่มอื่นอธิบายอยู่แล้ว
  expect(silentSinceStart({ ...SS, spinning: false, runAgeMs: 9_999_999 })).toBe(false);
  // staleMs 0 = ปิดฟีเจอร์
  expect(silentSinceStart({ ...SS, staleMs: 0, runAgeMs: 9_999_999 })).toBe(false);
});

test("resolveRunHealth: silentStart ทำงานเฉพาะเมื่อ heartbeat = unknown", () => {
  expect(resolveRunHealth({ busy: true, orchesStatus: null, heartbeat: "unknown", silentStart: true })).toBe("stalled");
  expect(resolveRunHealth({ busy: true, orchesStatus: null, heartbeat: "fresh", silentStart: true })).toBeNull();
  // จอดรอรีวิวยังชนะเสมอ — ห้ามป้ายว่าค้างเพราะ user ยังไม่มาตอบ
  expect(
    resolveRunHealth({ busy: true, orchesStatus: "paused-checkpoint", heartbeat: "unknown", silentStart: true }),
  ).toBe("checkpoint");
});
