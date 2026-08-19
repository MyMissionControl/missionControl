// "โทเคนหมดกลางงาน" — ตัวอ่านเหตุการณ์ + เวลาที่โทเคนจะกลับ + ใครตาย.
// NO vscode import — unit-tested standalone with `bun test`.
//
// ⛔⛔ ทำไมอ่านจาก transcript ไม่ใช่จอ: Claude Code เขียนเหตุการณ์ 429 ลงไฟล์ของมันเองอยู่แล้ว
//   (~/.claude/projects/<enc>/<session>.jsonl) เป็นระเบียนที่เครื่องอ่านได้ พร้อมของสามอย่างที่
//   ต้องใช้ทั้งหมด: ข้อความ + **เวลาที่จะรีเซ็ต** + **cwd** ซึ่งบอกว่าโปรเจกต์/role ไหนตาย
//   ⇒ ตรวจได้โดยไม่ต้องแคปจอ ไม่ต้องพาร์ส TUI และสำคัญที่สุด **ไม่ต้องใช้โทเคนของ agent เลย**
//   (agent ที่โทเคนหมดทำอะไรไม่ได้อีกแล้ว — คนที่ต้องทำ checkpoint คือ extension ไม่ใช่ agent)
//   ระเบียนจริงบนเครื่องนี้ (5 ระเบียน) มีรูปแบบนี้เป๊ะ:
//     {"error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,
//      "message":{"content":[{"type":"text","text":"You've hit your weekly limit · resets 3pm (UTC)"}]},
//      "cwd":".../projects/<proj>/agents/<role>","sessionId":"…","timestamp":"…"}
//
// ⛔ เกณฑ์ต้องเป็น "ฟิลด์" ไม่ใช่ "มีคำว่า rate_limit ในบรรทัด": transcript เก็บบทสนทนาไว้ด้วย
//   และเราคุยกันเรื่องนี้เองในนั้น — จับด้วย substring คือ false positive ตั้งแต่วันแรก

export interface LimitHit {
  /** `session` = หน้าต่าง 5 ชม. · `weekly` = 7 วัน · คนละการตัดสินใจกันโดยสิ้นเชิง */
  kind: "session" | "weekly" | "unknown";
  /** ข้อความเต็มที่ Claude Code เขียนไว้ (เอาไปแสดงตรง ๆ ได้) */
  text: string;
  /** ส่วนหลังคำว่า "resets" ดิบ ๆ เช่น `3pm (UTC)` — ยังไม่แปลงเป็นเวลา (ดู nextResetMs) */
  resetsAt: string;
  /** ที่ที่ agent ตัวนั้นทำงานอยู่ = เบาะแสว่าโปรเจกต์/role ไหนค้าง */
  cwd: string;
  sessionId: string;
  /** เวลาที่ชน limit (epoch ms) · 0 = ระเบียนไม่มี timestamp */
  atMs: number;
}

interface RawRecord {
  error?: unknown;
  apiErrorStatus?: unknown;
  isApiErrorMessage?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
  }
  return "";
}

/** หนึ่งบรรทัดของ transcript → เหตุการณ์ "โทเคนหมด" หรือ null. ห้าม throw: ผู้เรียกไล่ทุกบรรทัด. */
export function parseLimitRecord(line: string): LimitHit | null {
  if (!line || line.length < 2) return null;
  let o: RawRecord;
  try {
    o = JSON.parse(line) as RawRecord;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const is429 = o.error === "rate_limit" || o.apiErrorStatus === 429;
  if (!is429) return null;
  const text = firstText(o.message?.content);
  const kind: LimitHit["kind"] = /weekly limit/i.test(text)
    ? "weekly"
    : /session limit/i.test(text)
      ? "session"
      : "unknown";
  // "…limit · resets 3pm (UTC)" → "3pm (UTC)" · ไม่มีคำว่า resets ก็คืนค่าว่าง (ยังนับเป็น hit)
  const m = /resets?\s+(.+)$/i.exec(text);
  const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
  return {
    kind,
    text,
    resetsAt: (m?.[1] ?? "").trim(),
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    sessionId:
      typeof o.sessionId === "string" ? o.sessionId : typeof o.session_id === "string" ? o.session_id : "",
    atMs: Number.isFinite(ts) ? ts : 0,
  };
}

/** `3pm (UTC)` + เวลาปัจจุบัน → epoch ms ของรอบถัดไป · null = อ่านไม่ออก.
 *
 *  ⛔ ข้อความบอกแต่เวลา ไม่บอกวัน ⇒ ต้องหมายถึง "รอบถัดไปหลัง now" เสมอ ไม่ใช่วันนี้เฉย ๆ
 *  ⛔ อ่านไม่ออก = null ห้ามเดา: เดาเร็วไป = ปลุกตอนโทเคนยังไม่กลับแล้วชน limit ซ้ำทันที
 *     (ตอนนี้รองรับเฉพาะ (UTC) เพราะนั่นคือรูปเดียวที่พบในของจริง — โซนอื่นให้ null ไว้ก่อน) */
export function nextResetMs(resetsAt: string, nowMs: number): number | null {
  const s = String(resetsAt ?? "").trim();
  if (!/\(utc\)\s*$/i.test(s)) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(utc\)/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (!Number.isInteger(h) || h < 0 || min < 0 || min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  const now = new Date(nowMs);
  const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, 0, 0);
  return at > nowMs ? at : at + 24 * 60 * 60 * 1000;
}

/** cwd ของ agent ที่ตาย → โปรเจกต์ + role · null = ไม่ใช่งานใต้ `projects/` (ไม่ใช่เรื่องของเรา).
 *  ⛔ ต้องยึด segment ชื่อ `projects` ตัวสุดท้าย ไม่ใช่ regex ลอย: path ของ worktree คือ
 *     `<…>/projects/<proj>/agents/<role>` และ orchestrator คือ `<…>/projects/<proj>` */
export function limitTargets(cwd: string): { project: string; role: string } | null {
  const p = String(cwd ?? "");
  if (!p) return null;
  const parts = p.split("/");
  const i = parts.lastIndexOf("projects");
  if (i === -1 || !parts[i + 1]) return null;
  const project = parts.slice(0, i + 2).join("/");
  const role = parts[i + 2] === "agents" && parts[i + 3] ? parts[i + 3] : "";
  return { project, role };
}
