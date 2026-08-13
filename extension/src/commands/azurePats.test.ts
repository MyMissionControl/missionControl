import { expect, test } from "bun:test";

import { AZDO_RESOURCE, GLOBAL_PAT_SUNSET, dayOf, isSafeOrg, parsePatList } from "./azurePats";

// ⛔ บริบทที่ทำให้ไฟล์นี้มีอยู่ (ยืนยันของจริง 2026-08-13): เอา PAT ไปถามอายุของ PAT ไม่ได้
//    (MS: "the PAT Management Lifecycle APIs support only Microsoft Entra tokens") แต่ Entra token
//    จาก `az account get-access-token` ยิงได้จริง — ทดสอบบน org ของ user แล้วได้ HTTP 200
//    ที่เทสได้ตรงนี้คือส่วน pure: แปลง response + กัน org ที่ไม่ปลอดภัย

test("AZDO_RESOURCE คือ resource id ของ Azure DevOps (ค่าคงที่ของ Microsoft)", () => {
  expect(AZDO_RESOURCE).toBe("499b84ac-1321-427f-aa17-267ca6975798");
});

test("dayOf: ตัดเวลาออกเหลือวัน · อ่านไม่ออก = ว่าง (ไม่เดา)", () => {
  expect(dayOf("2026-11-30T04:04:38.5233333Z")).toBe("2026-11-30");
  expect(dayOf("2026-11-30")).toBe("2026-11-30");
  expect(dayOf("")).toBe("");
  expect(dayOf("30/11/2026")).toBe("");
  expect(dayOf(undefined as unknown as string)).toBe("");
});

const RES = {
  continuationToken: "",
  patTokens: [
    { displayName: "ci", validTo: "2026-09-01T04:04:38.5233333Z", scope: "vso.code", token: null },
    { displayName: "laptop", validTo: "2027-01-15T00:00:00Z", scope: "vso.code_write", token: null },
    { displayName: "old", validTo: "2026-08-20T00:00:00Z", scope: "app_token", token: null },
  ],
};

test("parsePatList: เรียงวันหมดอายุจากไกลไปใกล้ (ตัวที่เพิ่งสร้างมักอายุยาวสุด)", () => {
  const p = parsePatList(RES);
  expect(p.map((x) => x.name)).toEqual(["laptop", "ci", "old"]);
  expect(p[0].expiresAt).toBe("2027-01-15");
  expect(p[0].scope).toBe("vso.code_write");
});

test("⛔ parsePatList: ตัวที่อ่านวันไม่ออกต้องถูกทิ้ง ไม่ใช่ใส่ค่าว่างเข้า UI", () => {
  const p = parsePatList({ patTokens: [{ displayName: "x", validTo: "ไม่รู้" }, RES.patTokens[0]] });
  expect(p.length).toBe(1);
  expect(p[0].name).toBe("ci");
});

test("parsePatList: token ไม่มีชื่อยังต้องเลือกได้ (ไม่หายไปเงียบ ๆ)", () => {
  const p = parsePatList({ patTokens: [{ validTo: "2026-12-01T00:00:00Z" }] });
  expect(p).toEqual([{ name: "(ไม่มีชื่อ)", expiresAt: "2026-12-01", scope: "", global: true }]);
});

// ⛔ ประกาศบนหน้า PAT ของ Azure (user เห็นเอง 2026-08-13): "Beginning December 1, 2026, Global
//    Personal Access Tokens (PATs) scoped to all accessible organizations will no longer be
//    supported." · เอกสาร MS: targetAccounts = null แปลว่า token ครอบทุก org = Global PAT
//    ⇒ ต้องตรวจจาก targetAccounts เท่านั้น ห้ามเดาจากชื่อ (ชื่อ user ตั้งเองอิสระ)
test("GLOBAL_PAT_SUNSET ตรงกับวันที่ Azure ประกาศ", () => {
  expect(GLOBAL_PAT_SUNSET).toBe("2026-12-01");
});

test("parsePatList: targetAccounts มี org = org-scoped (ไม่ใช่ global)", () => {
  const p = parsePatList({
    patTokens: [{ displayName: "mc", validTo: "2027-01-01T00:00:00Z", targetAccounts: ["38aaa865-2c70-4bf7-a308-0c6539c38c1a"] }],
  });
  expect(p[0].global).toBe(false);
});

test("⛔ parsePatList: targetAccounts null / ไม่มีคีย์ / ลิสต์ว่าง = Global PAT", () => {
  for (const t of [
    { displayName: "g1", validTo: "2027-01-01T00:00:00Z", targetAccounts: null },
    { displayName: "g2", validTo: "2027-01-01T00:00:00Z" },
    { displayName: "g3", validTo: "2027-01-01T00:00:00Z", targetAccounts: [] },
  ]) {
    expect(parsePatList({ patTokens: [t] })[0].global).toBe(true);
  }
});

test("parsePatList: response รูปแบบอื่น = ลิสต์ว่าง ไม่ throw", () => {
  for (const bad of [null, undefined, {}, { patTokens: null }, { patTokens: "x" }, [], "nope"]) {
    expect(parsePatList(bad)).toEqual([]);
  }
});

test("⛔ isSafeOrg: org มาจาก URL ที่ user วางใน webview → ต่อเป็น URL ได้ต้อง whitelist", () => {
  expect(isSafeOrg("TexploreProject")).toBe(true);
  expect(isSafeOrg("my-org_1.2")).toBe(true);
  for (const bad of ["", " ", "a/b", "a?b", "a b", "../x", "-lead", "x".repeat(210)]) {
    expect(isSafeOrg(bad)).toBe(false);
  }
});
