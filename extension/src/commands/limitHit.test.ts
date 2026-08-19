import { describe, expect, test } from "bun:test";

import { limitTargets, nextResetMs, parseLimitRecord } from "./limitHit";

// ⛔⛔ ทุกฟิกซ์เจอร์ในไฟล์นี้ **คัดจาก transcript จริงบนเครื่องนี้** (grep '"error":"rate_limit"' ใน
//   ~/.claude/projects/**/*.jsonl เจอ 5 ระเบียน) — ไม่ใช่รูปที่เดาขึ้นมา:
//     {"error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,
//      "message":{"content":[{"type":"text","text":"You've hit your weekly limit · resets 3pm (UTC)"}]},
//      "cwd":".../projects/agentskill-marketplace-v4/agents/frontend","sessionId":"7f78…"}
//   นี่คือเหตุผลว่าทำไม "จับตอนชน limit" ทำได้จริงโดยไม่ต้องใช้โทเคนของ agent เลย: Claude Code
//   เขียนเหตุการณ์นี้ลงดิสก์เอง พร้อม **เวลาที่จะรีเซ็ต** และ **cwd ที่บอกว่าใคร/โปรเจกต์ไหนตาย**
const REAL_WEEKLY = JSON.stringify({
  timestamp: "2026-08-14T09:12:33.000Z",
  message: { content: [{ type: "text", text: "You've hit your weekly limit · resets 3pm (UTC)" }] },
  error: "rate_limit",
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  cwd: "/home/u/Desktop/soulbrew/github.com/fufu-2345/projects/agentskill-marketplace-v4/agents/frontend",
  sessionId: "7f786504-1f65-4511-a8b5-23da6e10d857",
});
const REAL_SESSION = JSON.stringify({
  timestamp: "2026-08-14T17:40:00.000Z",
  message: { content: [{ type: "text", text: "You've hit your session limit · resets 6:10pm (UTC)" }] },
  error: "rate_limit",
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  cwd: "/home/u/projects/mt10x",
  sessionId: "abc",
});

describe("parseLimitRecord", () => {
  test("อ่านระเบียนจริงของ weekly limit ได้ครบทุกช่องที่ต้องใช้", () => {
    const h = parseLimitRecord(REAL_WEEKLY);
    expect(h).not.toBeNull();
    expect(h?.kind).toBe("weekly");
    expect(h?.resetsAt).toBe("3pm (UTC)");
    expect(h?.cwd).toContain("agents/frontend");
    expect(h?.sessionId).toBe("7f786504-1f65-4511-a8b5-23da6e10d857");
    expect(h?.atMs).toBe(Date.parse("2026-08-14T09:12:33.000Z"));
  });

  test("แยก session limit ออกจาก weekly (คนละหน้าต่างเวลา คนละการตัดสินใจ)", () => {
    expect(parseLimitRecord(REAL_SESSION)?.kind).toBe("session");
    expect(parseLimitRecord(REAL_SESSION)?.resetsAt).toBe("6:10pm (UTC)");
  });

  // ⛔ ต้องไม่ตื่นตูมกับบรรทัดอื่น: transcript หนึ่งไฟล์มีหลายหมื่นบรรทัด และคำว่า rate_limit
  //   โผล่ในเนื้อข้อความได้ (เช่นตอนเราคุยกันเรื่องนี้เอง) — เกณฑ์ต้องเป็น "ฟิลด์" ไม่ใช่ "มีคำนี้"
  test("บรรทัดที่พูดถึงคำว่า rate_limit เฉย ๆ ไม่นับ", () => {
    const chat = JSON.stringify({
      timestamp: "2026-08-14T09:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "ช่วยดู error rate_limit 429 ให้หน่อย" }] },
    });
    expect(parseLimitRecord(chat)).toBeNull();
  });

  test("บรรทัดพัง / ไม่ใช่ JSON = null ไม่ throw", () => {
    expect(parseLimitRecord("")).toBeNull();
    expect(parseLimitRecord("{ไม่ใช่ json")).toBeNull();
    expect(parseLimitRecord(JSON.stringify({ error: "rate_limit" }))?.kind).toBe("unknown");
  });
});

describe("nextResetMs", () => {
  // ⛔ ข้อความบอกแต่ "เวลา" ไม่บอกวัน ⇒ ต้องหมายถึงรอบถัดไปหลัง now เสมอ
  test("บ่าย 3 UTC ที่ยังไม่มาถึงวันนี้", () => {
    const now = Date.parse("2026-08-14T09:12:00.000Z");
    expect(nextResetMs("3pm (UTC)", now)).toBe(Date.parse("2026-08-14T15:00:00.000Z"));
  });
  test("เวลาที่ผ่านไปแล้ววันนี้ = รอบของวันพรุ่งนี้ (ห้ามคืนอดีต ไม่งั้นจะปลุกทันที)", () => {
    const now = Date.parse("2026-08-14T16:00:00.000Z");
    expect(nextResetMs("3pm (UTC)", now)).toBe(Date.parse("2026-08-15T15:00:00.000Z"));
  });
  test("มีนาทีด้วย", () => {
    const now = Date.parse("2026-08-14T17:40:00.000Z");
    expect(nextResetMs("6:10pm (UTC)", now)).toBe(Date.parse("2026-08-14T18:10:00.000Z"));
  });
  test("เที่ยงคืน/เที่ยงวัน ต้องไม่เพี้ยน", () => {
    const now = Date.parse("2026-08-14T05:00:00.000Z");
    expect(nextResetMs("12am (UTC)", now)).toBe(Date.parse("2026-08-15T00:00:00.000Z"));
    expect(nextResetMs("12pm (UTC)", now)).toBe(Date.parse("2026-08-14T12:00:00.000Z"));
  });
  // ⛔ อ่านไม่ออก = null ห้ามเดา: เดาผิดคือ "ปลุกตอนโทเคนยังไม่กลับ" แล้วชน limit ซ้ำทันที
  test("รูปแบบที่ไม่รู้จัก = null", () => {
    expect(nextResetMs("later", 0)).toBeNull();
    expect(nextResetMs("3pm (PDT)", 0)).toBeNull();
    expect(nextResetMs("", 0)).toBeNull();
  });
});

describe("limitTargets", () => {
  // ⭐ cwd ในระเบียนคือของขวัญ: มันบอกทั้งโปรเจกต์และ role ที่ตาย ⇒ checkpoint รู้ว่าต้องเก็บอะไร
  test("worktree ของ role → ได้ทั้ง project และ role", () => {
    const t = limitTargets("/x/projects/agentskill-marketplace-v4/agents/frontend");
    expect(t?.project).toBe("/x/projects/agentskill-marketplace-v4");
    expect(t?.role).toBe("frontend");
  });
  test("ตัว orchestrator เอง (ไม่มี agents/) → project ล้วน", () => {
    const t = limitTargets("/x/projects/mt10x");
    expect(t?.project).toBe("/x/projects/mt10x");
    expect(t?.role).toBe("");
  });
  test("cwd ที่ไม่ได้อยู่ใต้ projects/ = null (ไม่ใช่งาน orches ห้ามไปยุ่ง)", () => {
    expect(limitTargets("/home/u/.claude/skills")).toBeNull();
    expect(limitTargets("")).toBeNull();
  });
});
