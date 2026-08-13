import { test, expect } from "bun:test";

import {
  parseCredentialLines,
  upsertCredentialLine,
  removeCredentialLine,
  secretOf,
  providerLabelForHost,
  isSafeCredHost,
  isSafeCredUser,
  credTargetFromUrl,
  isValidExpiryDate,
  patMetaKey,
  patExpiryState,
  PAT_SOON_DAYS,
} from "./gitCredentials";

const AZ = "https://TexploreProject:pat-one@dev.azure.com";
const AZ2 = "https://OtherOrg:pat-two@dev.azure.com";

test("parseCredentialLines: หลาย org บน host เดียวกัน = แยกกันด้วย username", () => {
  const rows = parseCredentialLines([AZ, AZ2].join("\n"));
  expect(rows).toEqual([
    { host: "dev.azure.com", user: "TexploreProject" },
    { host: "dev.azure.com", user: "OtherOrg" },
  ]);
});

test("⛔ parseCredentialLines: ห้ามคืนค่า secret ออกมาเลย (view เห็นได้)", () => {
  const json = JSON.stringify(parseCredentialLines([AZ, AZ2].join("\n")));
  expect(json).not.toContain("pat-one");
  expect(json).not.toContain("pat-two");
});

test("parseCredentialLines: ข้ามบรรทัดเสีย/ว่าง ไม่ล้มทั้งไฟล์", () => {
  const rows = parseCredentialLines(["", "   ", "not-a-url", "https://nouser@host.com", AZ].join("\n"));
  expect(rows).toEqual([
    { host: "host.com", user: "nouser" },
    { host: "dev.azure.com", user: "TexploreProject" },
  ]);
});

test("parseCredentialLines: username ที่ถูก percent-encode ต้องถอดกลับให้ถูก", () => {
  expect(parseCredentialLines("https://a%40b.com:p@dev.azure.com")).toEqual([
    { host: "dev.azure.com", user: "a@b.com" },
  ]);
});

test("⛔ upsertCredentialLine: ทับแค่คู่ host+user เดิม — org อื่นต้องไม่หาย", () => {
  const out = upsertCredentialLine([AZ, AZ2].join("\n"), "dev.azure.com", "TexploreProject", "pat-new");
  const rows = parseCredentialLines(out);
  expect(rows.length).toBe(2);
  expect(secretOf(out, "dev.azure.com", "TexploreProject")).toBe("pat-new");
  expect(secretOf(out, "dev.azure.com", "OtherOrg")).toBe("pat-two"); // ของ org อื่นยังอยู่ครบ
});

test("upsertCredentialLine: ยังไม่มี = เพิ่มต่อท้าย (ไม่ทับใคร)", () => {
  const out = upsertCredentialLine(AZ, "dev.azure.com", "ThirdOrg", "pat-3");
  expect(parseCredentialLines(out).length).toBe(2);
  expect(secretOf(out, "dev.azure.com", "ThirdOrg")).toBe("pat-3");
});

test("upsertCredentialLine: PAT ที่มีอักขระพิเศษต้อง encode แล้วอ่านกลับได้เป๊ะ", () => {
  const pat = "a@b:c/d?e#f%g";
  const out = upsertCredentialLine("", "dev.azure.com", "org", pat);
  expect(out).not.toContain("a@b:c"); // ต้องไม่ถูกเขียนดิบ ๆ ไม่งั้น host เพี้ยน
  expect(parseCredentialLines(out)).toEqual([{ host: "dev.azure.com", user: "org" }]);
  expect(secretOf(out, "dev.azure.com", "org")).toBe(pat);
});

test("upsertCredentialLine: ไฟล์ต้องลงท้ายด้วย newline เดียว ไม่มีบรรทัดว่างงอก", () => {
  let out = upsertCredentialLine("", "h.com", "u", "p");
  out = upsertCredentialLine(out, "h.com", "u2", "p2");
  expect(out.endsWith("\n")).toBe(true);
  expect(out).not.toContain("\n\n");
});

test("removeCredentialLine: ลบแค่คู่ที่ระบุ", () => {
  const out = removeCredentialLine([AZ, AZ2].join("\n"), "dev.azure.com", "OtherOrg");
  expect(parseCredentialLines(out)).toEqual([{ host: "dev.azure.com", user: "TexploreProject" }]);
});

test("providerLabelForHost", () => {
  expect(providerLabelForHost("dev.azure.com")).toBe("Azure DevOps");
  expect(providerLabelForHost("myorg.visualstudio.com")).toBe("Azure DevOps");
  expect(providerLabelForHost("github.com")).toBe("GitHub");
  expect(providerLabelForHost("git.company.internal")).toBe("git.company.internal");
});

test("⛔ isSafeCredUser/isSafeCredHost: กัน newline injection ลงไฟล์ credential", () => {
  expect(isSafeCredUser("TexploreProject")).toBe(true);
  expect(isSafeCredUser("a@b.com")).toBe(true);
  for (const bad of ["a\nhttps://x:y@z", "a\r\nb", "", " ", "a b", "x".repeat(300)]) {
    expect(isSafeCredUser(bad)).toBe(false);
  }
  expect(isSafeCredHost("dev.azure.com")).toBe(true);
  for (const bad of ["dev.azure.com/path", "a\nb", "", "-x.com", "a b.com"]) {
    expect(isSafeCredHost(bad)).toBe(false);
  }
});

test("credTargetFromUrl: Azure — org มาจาก user@ ถ้ามี", () => {
  expect(
    credTargetFromUrl("https://TexploreProject@dev.azure.com/TexploreProject/Sandbox/_git/FITs"),
  ).toEqual({ host: "dev.azure.com", user: "TexploreProject" });
});

test("credTargetFromUrl: Azure — ไม่มี user@ ให้เอา org จาก path แรก (ปุ่ม Clone บางแบบไม่ใส่มา)", () => {
  expect(credTargetFromUrl("https://dev.azure.com/TexploreProject/Sandbox/_git/FITs")).toEqual({
    host: "dev.azure.com",
    user: "TexploreProject",
  });
});

test("credTargetFromUrl: visualstudio.com — org อยู่ใน host", () => {
  expect(credTargetFromUrl("https://myorg.visualstudio.com/Sandbox/_git/FITs")).toEqual({
    host: "myorg.visualstudio.com",
    user: "myorg",
  });
});

test("credTargetFromUrl: host อื่นใช้ owner ตัวแรกของ path", () => {
  expect(credTargetFromUrl("https://github.com/MyMissionControl/repo.git")).toEqual({
    host: "github.com",
    user: "MyMissionControl",
  });
});

test("credTargetFromUrl: ของเสีย = null (ไม่เดา)", () => {
  for (const bad of ["", "not a url", "ssh://git@dev.azure.com/v3/o/p/r", "https://dev.azure.com"]) {
    expect(credTargetFromUrl(bad)).toBeNull();
  }
});

// ── วันหมดอายุของ PAT ────────────────────────────────────────────────────────
// ⛔ ทำไมไม่ดึงจาก Azure: PAT ถามอายุของตัวเองไม่ได้ (PAT lifecycle API รับแต่ Entra token)
//    จึงเก็บวันที่ user กรอกไว้เอง แล้วนับถอยหลัง — ตัวนับนี้จึงต้องถูกเป๊ะ

test("isValidExpiryDate: รับแค่ YYYY-MM-DD ที่เป็นวันจริง", () => {
  expect(isValidExpiryDate("2026-09-30")).toBe(true);
  expect(isValidExpiryDate("2028-02-29")).toBe(true); // ปีอธิกสุรทิน
  expect(isValidExpiryDate("2026-02-30")).toBe(false); // ⛔ ก.พ. ไม่มีวันที่ 30
  expect(isValidExpiryDate("2026-13-01")).toBe(false);
  expect(isValidExpiryDate("2026-9-30")).toBe(false); // ต้อง zero-pad
  expect(isValidExpiryDate("30/09/2026")).toBe(false);
  expect(isValidExpiryDate("")).toBe(false);
});

const NOON = Date.UTC(2026, 7, 13, 12, 0, 0); // 2026-08-13 เที่ยง UTC
const LATE = Date.UTC(2026, 7, 13, 23, 30, 0); // วันเดียวกัน ดึก

test("patExpiryState: ไม่มีวัน = unknown (ไม่ใช่ expired)", () => {
  for (const v of [null, undefined, "", "พรุ่งนี้"]) {
    const s = patExpiryState(v as string | null, NOON);
    expect(s.level).toBe("unknown");
    expect(s.days).toBeNull();
    expect(s.text).toContain("ไม่รู้");
  }
});

test("patExpiryState: เลยวันมาแล้ว = expired + บอกวันที่", () => {
  const s = patExpiryState("2026-08-01", NOON);
  expect(s.level).toBe("expired");
  expect(s.days).toBe(-12);
  expect(s.text).toContain("หมดอายุแล้ว");
  expect(s.text).toContain("2026-08-01");
});

test("⛔ patExpiryState: วันสุดท้ายต้องยัง 'ไม่หมด' แม้ตอนดึก (นับเป็นวันปฏิทิน)", () => {
  for (const now of [NOON, LATE]) {
    const s = patExpiryState("2026-08-13", now);
    expect(s.level).toBe("soon");
    expect(s.days).toBe(0);
    expect(s.text).toContain("วันนี้");
  }
});

test("patExpiryState: ขอบเขต soon อยู่ที่ PAT_SOON_DAYS พอดี", () => {
  const soon = patExpiryState("2026-08-27", NOON); // +14
  expect(PAT_SOON_DAYS).toBe(14);
  expect(soon.days).toBe(14);
  expect(soon.level).toBe("soon");
  const ok = patExpiryState("2026-08-28", NOON); // +15
  expect(ok.days).toBe(15);
  expect(ok.level).toBe("ok");
});

test("patExpiryState: ยังไกล = ok + บอกจำนวนวันที่เหลือ", () => {
  const s = patExpiryState("2027-08-13", NOON);
  expect(s.level).toBe("ok");
  expect(s.days).toBe(365);
  expect(s.text).toContain("อีก 365 วัน");
});

test("patMetaKey: แยกตามคู่ (host, user) เหมือนที่ ~/.git-credentials แยก", () => {
  expect(patMetaKey("dev.azure.com", "TexploreProject")).toBe("dev.azure.com TexploreProject");
  // สอง org บน host เดียวกันต้องได้คีย์ต่างกัน — ไม่งั้นตั้งวันของ org หนึ่งไปทับอีก org
  expect(patMetaKey("dev.azure.com", "OtherOrg")).not.toBe(patMetaKey("dev.azure.com", "TexploreProject"));
});
