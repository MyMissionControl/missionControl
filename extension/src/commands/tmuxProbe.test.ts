import { describe, expect, test } from "bun:test";

import {
  sessionStateFromError,
  tmuxSessionFree,
  tmuxSessionState,
  tmuxSessionTaken,
} from "./tmuxProbe";

// `tmux has-session` was asked everywhere through a `try { … } catch { return false }`,
// so "no such session", "tmux is not installed", "the box is too loaded to fork" and
// "the call was killed" all answered the same word: absent. That single collapse is
// what lets a failed probe do damage — it is not only the reap path:
//   · nextTwinSession / launchOrchestrator read absent as "this NAME is free" and
//     launch a second orchestrator into a session another run is already driving
//   · the ✕ kill verification reads absent as "it really died" and reports ปิดแล้ว
//   · the orchestrator panel's poll reads absent as "the run died on its own"
// Only exit status 1 is tmux ANSWERING. Everything else means we did not get an answer.
describe("sessionStateFromError", () => {
  test("T1 exit 1 = tmux ตอบแล้วว่าไม่มี session นี้", () => {
    expect(sessionStateFromError({ status: 1, stderr: "can't find session: nope" })).toBe("absent");
    // "no server running" also exits 1 — no server means no session, which is an answer.
    expect(sessionStateFromError({ status: 1, stderr: "no server running on /tmp/tmux-1000/default" })).toBe(
      "absent",
    );
  });

  test("T2 ENOENT (ไม่มี tmux ใน PATH) = ตอบไม่ได้ ไม่ใช่ไม่มี", () => {
    expect(sessionStateFromError({ code: "ENOENT", status: null })).toBe("unknown");
  });

  test("T3 ถูกฆ่า / EAGAIN / rc อื่น = ตอบไม่ได้", () => {
    expect(sessionStateFromError({ status: null, signal: "SIGKILL" })).toBe("unknown");
    expect(sessionStateFromError({ code: "EAGAIN", status: undefined })).toBe("unknown");
    expect(sessionStateFromError({ status: 127, stderr: "tmux: command not found" })).toBe("unknown");
    expect(sessionStateFromError({})).toBe("unknown");
  });
});

describe("tmuxSessionState", () => {
  const ok = () => "";
  const fail = (e: unknown) => () => {
    throw e;
  };

  test("T4 รันผ่าน = present", () => {
    expect(tmuxSessionState("claude-bob", ok)).toBe("present");
  });

  test("T5 exit 1 = absent · อย่างอื่น = unknown", () => {
    expect(tmuxSessionState("claude-bob", fail({ status: 1 }))).toBe("absent");
    expect(tmuxSessionState("claude-bob", fail({ code: "ENOENT" }))).toBe("unknown");
  });

  test("T6 ชื่อที่เป็น session ไม่ได้ = unknown ไม่ใช่ absent", () => {
    // ⛔ absent would read as "the name is FREE" at the minting call sites, and a
    // name tmux can never hold must never be handed to `new-session`.
    let called = 0;
    const spy = () => {
      called++;
      return "";
    };
    expect(tmuxSessionState("bad name; rm -rf /", spy)).toBe("unknown");
    expect(called).toBe(0); // and it must not shell out at all
  });
});

describe("นโยบายต่อ call site", () => {
  const fail = (e: unknown) => () => {
    throw e;
  };
  const ok = () => "";

  test("T7 ตั้งชื่อ session ใหม่: ไม่รู้ = ถือว่าไม่ว่าง", () => {
    // The dangerous direction. Reading unknown as free makes MC launch into a live
    // session; reading it as taken only costs a `-2` suffix on a name.
    expect(tmuxSessionTaken("claude-bob", fail({ code: "ENOENT" }))).toBe(true);
    expect(tmuxSessionTaken("claude-bob", fail({ status: 1 }))).toBe(false);
    expect(tmuxSessionTaken("claude-bob", ok)).toBe(true);
  });

  test("T8 ยืนยันว่าตายแล้ว: ไม่รู้ = ยังยืนยันไม่ได้", () => {
    expect(tmuxSessionFree("claude-bob", fail({ code: "EAGAIN" }))).toBe(false);
    expect(tmuxSessionFree("claude-bob", fail({ status: 1 }))).toBe(true);
    expect(tmuxSessionFree("claude-bob", ok)).toBe(false);
  });
});
