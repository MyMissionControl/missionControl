import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HEARTBEAT_STALE_SEC,
  heartbeatAgeMs,
  isoAgeMs,
  heartbeatFreshness,
  parseOrchesState,
  parseSprintPair,
  readOrchesState,
} from "./orchesSignals";

// The engine (orches-integrate.sh) publishes a liveness verdict MC never read: it
// stamps `heartbeat` into `.orches-state` on EVERY poll tick (_stamp_heartbeat), plus
// `status: in-progress|paused-checkpoint|done` and `sprint: N/total`. MC read exactly
// one key of that file (owner-session), so a run whose session is alive but wedged —
// and a run parked at a checkpoint waiting for a human — both render as `⟳ กำลังทำ`,
// forever, indistinguishable from real work.
//
// ⛔ Every verdict here must be ADVISORY. It may label a card; it must never gate a
// destructive action. The engine's own `driver-alive` treats a stale heartbeat as
// "ask the user", not as "it died" — because the stamp only happens inside engine
// verbs, so the orchestrator's own LLM turns (4.7/4.8 docs + memory) legitimately go
// quiet for minutes. Anything unparsable or absent answers "unknown" and says nothing.

const TMPDIRS: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "orches-signals-"));
  TMPDIRS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMPDIRS) rmSync(d, { recursive: true, force: true });
});

/** `date +%FT%T` — no offset, so BOTH sides read it as local time. Formatting from an
 *  epoch here (instead of hardcoding a string) keeps the test timezone-independent. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const NOW = Date.UTC(2026, 7, 21, 7, 30, 0); // any fixed instant; every case is relative

describe("parseOrchesState", () => {
  test("O1 อ่านคีย์ที่ engine เขียนจริงครบ (state file จริงมีคีย์อื่นปนเยอะ)", () => {
    const raw = [
      "owner-session: 09-foreman",
      "team: brew",
      "orchestrator: foreman",
      "heartbeat: 2026-08-21T14:30:05",
      "status: in-progress",
      "sprint: 3/5",
      "open-roles: api ui",
      "poll-result-api: SILENT_EXIT@1754180283",
      "sprint-3-start: 1754180000",
    ].join("\n");
    const s = parseOrchesState(raw);
    expect(s.ownerSession).toBe("09-foreman");
    expect(s.heartbeat).toBe("2026-08-21T14:30:05");
    expect(s.status).toBe("in-progress");
    expect(s.sprint).toEqual({ n: 3, total: 5 });
  });

  test("O2 status ค่าอื่นที่ไม่ใช่ 3 ค่าของ engine = null (ไม่เดา)", () => {
    // The state file is free text — the parity suite itself writes `status: กำลังรอ
    // worker`. An unrecognised value must not be coerced into one of the three.
    expect(parseOrchesState("status: กำลังรอ worker").status).toBeNull();
    expect(parseOrchesState("status: paused-checkpoint").status).toBe("paused-checkpoint");
    expect(parseOrchesState("status: done").status).toBe("done");
    expect(parseOrchesState("").status).toBeNull();
  });

  test("O3 sprint ที่ไม่ใช่ N/total = null", () => {
    expect(parseSprintPair("2/5")).toEqual({ n: 2, total: 5 });
    expect(parseSprintPair("2 / 5")).toEqual({ n: 2, total: 5 });
    expect(parseSprintPair("2")).toBeNull();
    expect(parseSprintPair("a/b")).toBeNull();
    expect(parseSprintPair(null)).toBeNull();
  });

  test("O4 readOrchesState: ไม่มีไฟล์ = null (ไม่ throw)", () => {
    const d = tmp();
    expect(readOrchesState(d)).toBeNull();
    writeFileSync(join(d, ".orches-state"), "owner-session: s\nstatus: done\n");
    expect(readOrchesState(d)?.status).toBe("done");
  });
});

describe("heartbeatAgeMs", () => {
  test("H1 %FT%T ถูกอ่านเป็นเวลา 'ท้องถิ่น' เหมือน `date -d` ของ engine", () => {
    // Engine: `date +%FT%T` writes local time with NO offset, and reads it back with
    // `date -d`. If MC parsed it as UTC, every verdict would be off by the timezone
    // (7h here) — always "stale" in one direction, never stale in the other.
    expect(heartbeatAgeMs(stamp(NOW), NOW)).toBe(0);
    expect(heartbeatAgeMs(stamp(NOW - 90_000), NOW)).toBe(90_000);
  });

  test("H2 อ่านค่าไม่ได้ = null (ไม่ใช่ 0 และไม่ใช่ค่ามหาศาล)", () => {
    expect(heartbeatAgeMs(null, NOW)).toBeNull();
    expect(heartbeatAgeMs("", NOW)).toBeNull();
    expect(heartbeatAgeMs("ไม่ใช่เวลา", NOW)).toBeNull();
    // ⛔ date-ONLY is parsed as UTC midnight by JS (a spec quirk) → it would read as
    // hours/days old on a local-time clock. The engine never writes it; refuse it.
    expect(heartbeatAgeMs("2026-08-21", NOW)).toBeNull();
  });

  test("H3 heartbeat อยู่ในอนาคต (นาฬิกาเพี้ยน) = 0 ไม่ใช่ค่าลบ", () => {
    expect(heartbeatAgeMs(stamp(NOW + 600_000), NOW)).toBe(0);
  });

  // ⛔⛔ `bun test` FORCES TZ=UTC (measured 2026-08-21: getTimezoneOffset() === 0 inside
  //   bun test, -420 under plain `bun` on this +07 box). So H1 above cannot see a
  //   local-vs-UTC bug at all: under UTC both readings coincide, and a mutant that
  //   parses the stamp as UTC passes every assertion in this file. VS Code runs the
  //   extension in the real zone. So the only honest proof is a CHILD process in a
  //   non-UTC zone — this test is red against that mutant, H1 is not.
  test("H4 ในโซนเวลาจริง (+07) ยังอ่านถูก — bun test บังคับ UTC จึงต้องยิงลูกใหม่", () => {
    const mod = join(import.meta.dir, "orchesSignals.ts");
    const code = `const m = await import(${JSON.stringify(mod)});\n` +
      `console.log(String(new Date().getTimezoneOffset()), String(m.heartbeatAgeMs("2026-08-21T14:28:30", Date.UTC(2026,7,21,7,30,0))));`;
    const out = execFileSync(process.execPath, ["-e", code], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Bangkok" },
      timeout: 20_000,
    }).trim();
    // guard the guard: if the child did NOT get the zone, the assertion below would be
    // vacuous for the same reason H1 is.
    expect(out.split(/\s+/)[0]).toBe("-420");
    expect(out.split(/\s+/)[1]).toBe("90000");
  });
});

describe("heartbeatFreshness", () => {
  const STALE = HEARTBEAT_STALE_SEC * 1000;

  test("F1 ค่าเริ่มต้นตรงกับ engine (ORCHES_HEARTBEAT_STALE default 600s)", () => {
    expect(HEARTBEAT_STALE_SEC).toBe(600);
  });

  test("F2 สดกว่า/เท่ากับเส้น = fresh · เก่ากว่า = stale", () => {
    expect(heartbeatFreshness(stamp(NOW - 60_000), NOW, STALE)).toBe("fresh");
    expect(heartbeatFreshness(stamp(NOW - STALE), NOW, STALE)).toBe("fresh"); // เส้นพอดี = ยังไม่ค้าง
    expect(heartbeatFreshness(stamp(NOW - STALE - 1000), NOW, STALE)).toBe("stale");
  });

  test("F3 ไม่มี heartbeat = unknown (ห้ามเดาว่าค้าง)", () => {
    // A build older than _stamp_heartbeat, or a run in the window before its first
    // engine verb. Reporting "อาจค้าง" here would be a pure false positive.
    expect(heartbeatFreshness(null, NOW, STALE)).toBe("unknown");
    expect(heartbeatFreshness("junk", NOW, STALE)).toBe("unknown");
  });

  test("F4 staleMs <= 0 = ปิดฟีเจอร์ (unknown ทุกกรณี)", () => {
    expect(heartbeatFreshness(stamp(NOW - 86_400_000), NOW, 0)).toBe("unknown");
    expect(heartbeatFreshness(stamp(NOW - 86_400_000), NOW, -5)).toBe("unknown");
  });
});

// `startedAt` on the run marker is written by MC itself as `new Date().toISOString()` —
// a DIFFERENT format from the engine's heartbeat. It was written, made mandatory by the
// parse guard, and then never read by anything (audit item 2c).
describe("isoAgeMs", () => {
  test("I1 ISO ที่มีโซนเวลา (Z / ±HH:MM) อ่านได้ตรง", () => {
    expect(isoAgeMs("2026-08-21T07:28:30.000Z", NOW)).toBe(90_000);
    expect(isoAgeMs("2026-08-21T14:28:30.000+07:00", NOW)).toBe(90_000); // เวลาเดียวกัน คนละโซน
  });

  test("I2 ไม่มีโซนเวลา = null (ห้ามเดา — เดาผิดคือพลาดเป็นชั่วโมง)", () => {
    // นี่คือรูปของ heartbeat (`date +%FT%T`) ซึ่งมี heartbeatAgeMs ดูแลอยู่แล้ว
    expect(isoAgeMs("2026-08-21T14:28:30", NOW)).toBeNull();
    expect(isoAgeMs("2026-08-21", NOW)).toBeNull();
    expect(isoAgeMs(null, NOW)).toBeNull();
    expect(isoAgeMs(undefined, NOW)).toBeNull();
    expect(isoAgeMs("t", NOW)).toBeNull(); // ค่าที่เทสเก่าใช้เป็น placeholder
  });

  test("I3 อยู่ในอนาคต = 0 ไม่ใช่ค่าลบ", () => {
    expect(isoAgeMs("2026-08-21T08:00:00.000Z", NOW)).toBe(0);
  });
});
