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
