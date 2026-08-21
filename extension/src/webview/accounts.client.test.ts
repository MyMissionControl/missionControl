import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// หน้า Connections มี client JS อยู่ใน template literal → tsc มองไม่เห็น
// syntax พังทีเดียว = ทั้งหน้าตาย เงียบ ๆ · เทสนี้พิสูจน์ว่ายัง parse ได้
const SRC = fs.readFileSync(path.join(__dirname, "accounts.ts"), "utf8");

function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  return SRC.slice(start + "<script>".length, end);
}

test("client script ของหน้า Connections ยัง parse ได้", () => {
  const js = clientScript();
  expect(js.length).toBeGreaterThan(500);
  expect(() => new Function(js)).not.toThrow();
});

// user สั่งลบโซน SSH ทิ้ง 2026-08-13 — เหลือทาง https + PAT ทางเดียว
// ⛔ ลบแค่ UI: cloneRepoInto ยังเรียก ensureKnownHost เองอยู่ (repoClone.ts) ดังนั้น
//    clone ผ่าน ssh ยังเตรียม host key ให้อัตโนมัติ ไม่ได้พังเพราะปุ่มหาย
test("โซน SSH ต้องไม่กลับมา (ทั้ง HTML, handler และ payload)", () => {
  const js = clientScript();
  for (const gone of ['id="ssh-rows"', 'id="ssh-keys"', "<h2>SSH</h2>"]) {
    expect(SRC).not.toContain(gone);
  }
  for (const gone of ["sprep", "stest", "ssh_prepare", "ssh_test", "ssh_result", "renderSsh"]) {
    expect(js).not.toContain(gone);
  }
});

// user สั่งลบ tab Git ทิ้ง 2026-08-21 ("ยกเลิกละ ไม่ใช้ connect ในเครื่อง")
// ⛔ ลบแค่ UI ใน extension เท่านั้น — ไม่แตะระบบ git จริง (git config / credential
//    helper / ~/.git-credentials / gh auth) และไม่เกี่ยวปุ่ม Push หน้า Projects
//    (นั่นคือ gitOps.pushRepo คนละ path) · เทสนี้กันไม่ให้ tab กลับมาเงียบ ๆ
test("tab Git ต้องไม่กลับมา (tab, zone, modal, handlers, modules)", () => {
  const js = clientScript();
  for (const gone of ['data-z="git"', 'id="zone-git"', 'id="cmodal"', 'id="git-rows"', 'id="cm-pat"']) {
    expect(SRC).not.toContain(gone);
  }
  for (const gone of ["renderGit", "openCred", "cmDatesResult", 'post("git_', 'm.type === "git']) {
    expect(js).not.toContain(gone);
  }
  for (const gone of ['case "git_cred_save"', 'case "git_del"', "gitCredentials", "azurePats", "pushGit"]) {
    expect(SRC).not.toContain(gone);
  }
  // โมดูลที่รองรับ tab นี้ถูกลบออกจากดิสก์ (ไม่มีไฟล์ไหนอื่น import แล้ว)
  expect(fs.existsSync(path.join(__dirname, "../commands/gitCredentials.ts"))).toBe(false);
  expect(fs.existsSync(path.join(__dirname, "../commands/azurePats.ts"))).toBe(false);
});

// ⛔ กฎของ user: เครื่องเขาเรนเดอร์ emoji/สัญลักษณ์พิเศษเป็น **กล่องเปล่า** → ใช้สื่อความหมายไม่ได้เลย
//    ห้ามมีในสิ่งที่ผู้ใช้เห็น — คอมเมนต์ในโค้ดมีได้ (ไม่ถูกเรนเดอร์)
const BANNED = /[⛔⚠✅❌✔✖\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u;

function visibleParts(): { name: string; text: string }[] {
  const b = SRC.indexOf("<body>");
  const sc = SRC.indexOf("<script>", b);
  const en = SRC.lastIndexOf("</script>");
  // client script: ตัดบรรทัดคอมเมนต์ // ออกก่อน (คอมเมนต์ไม่ถึงตาผู้ใช้)
  const js = SRC.slice(sc, en)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [
    { name: "HTML body", text: SRC.slice(b, sc) },
    { name: "client script (ไม่รวมคอมเมนต์)", text: js },
  ];
}

test("⛔ ห้าม emoji/สัญลักษณ์ในข้อความที่ผู้ใช้เห็น (เครื่อง user เรนเดอร์เป็นกล่องเปล่า)", () => {
  for (const p of visibleParts()) {
    const bad = p.text.split("\n").filter((l) => BANNED.test(l));
    expect(bad.join("\n")).toBe(""); // ถ้า fail จะโชว์บรรทัดที่ผิดให้เห็นตรง ๆ
    expect(p.name.length).toBeGreaterThan(0);
  }
});
