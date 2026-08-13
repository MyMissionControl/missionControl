import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// หน้า Connections มี client JS อยู่ใน template literal → tsc มองไม่เห็น
// syntax พังทีเดียว = ทั้งหน้าตาย เงียบ ๆ · เทสนี้พิสูจน์ว่ายัง parse ได้ + โซน Git ต่อสายจริง
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

test("โซน Git: ปุ่มทุกตัวมี handler จริง (ไม่ใช่ปุ่มตาย)", () => {
  const js = clientScript();
  for (const cls of ["git-add", "gtest", "gedit", "gdel", "gexp"]) {
    expect(js).toContain('t.classList.contains("' + cls + '")');
  }
  // สลับโซนต้องซ่อน/โชว์ทั้งสองฝั่ง ไม่ใช่โชว์ทับกัน
  expect(js).toContain('document.getElementById("zone-ai").style.display');
  expect(js).toContain('document.getElementById("zone-git").style.display');
  expect(SRC).toContain('data-z="git"');
  expect(SRC).toContain('id="zone-git"');
});

test("⛔ view ของโซน Git ต้องไม่มีคำว่า secret/pat ที่เป็นค่าจริงไหลเข้า client", () => {
  // host ส่งแค่ host/user/provider/sub/testable — ถ้ามีวันไหนเผลอส่ง secret เทสนี้จะจับได้
  const idx = SRC.indexOf('type: "git"');
  expect(idx).toBeGreaterThan(0);
  // ตัดเฉพาะ payload ของ postMessage (ถึง `});` ที่ปิด object) — กว้างกว่านั้นจะไปกิน
  // docstring ของฟังก์ชันข้าง ๆ ที่พูดถึง PAT แล้วเทสจะ fail แบบไม่มีความหมาย
  const end = SRC.indexOf("\n  });", idx);
  expect(end).toBeGreaterThan(idx);
  const block = SRC.slice(idx, end);
  expect(block).not.toContain("secretOf");
  expect(block).not.toMatch(/secret|password|token/i);
});

test("โซน Git: ปุ่ม 'วันหมดอายุ' เปิด modal โหมด exp + พาวันเดิมไปด้วย", () => {
  const js = clientScript();
  expect(js).toContain('openCred("exp", h, u, t.getAttribute("data-e")');
  // ⛔ gexp ต้องถูกเช็คก่อน .del ตัวท้าย (ปุ่มลบของ account AI) ไม่งั้นคลิกผิดเรื่อง
  expect(js.indexOf('contains("gexp")')).toBeLessThan(js.lastIndexOf('contains("del")'));
});

// ⛔ user ไม่ชอบ showInputBox ของ host: มันโผล่เป็นแถบเล็ก ๆ ที่ขอบบนจอ (ที่เดียวกับ command
//    palette) ย้ายไปกลางจอไม่ได้ → 2026-08-13 เปลี่ยนเป็น modal ใน webview ทั้ง 3 ทาง
test("ใส่ credential ต้องผ่าน modal กลางจอ ไม่ใช่ showInputBox ของ host", () => {
  const js = clientScript();
  expect(SRC).toContain('id="cmodal"');
  expect(SRC).toContain('class="modal-backdrop"');
  expect(SRC).toContain(".modal-card {");
  // ทั้ง 3 ทางเข้าเปิด modal ตัวเดียวกัน คนละโหมด
  for (const mode of ['openCred("add")', 'openCred("pat"', 'openCred("exp"']) {
    expect(js).toContain(mode);
  }
  // host ต้องไม่มี showInputBox สำหรับ PAT/วันหมดอายุเหลืออยู่
  expect(SRC).not.toContain("promptPat");
  expect(SRC).not.toContain("promptExpiry");
});

test("modal: ปุ่มบันทึกติดไว้จนกรอกครบ + เช็ค URL ผ่าน host", () => {
  const js = clientScript();
  expect(js).toContain('post("git_url_check"');
  expect(js).toContain('m.type === "git_url_result"');
  expect(js).toContain('post("git_cred_save"');
  expect(js).toContain('post("git_expiry_save"');
  // ⛔ ผลของ URL เก่าที่มาช้าต้องถูกทิ้ง ไม่ใช่เขียนทับสถานะของ URL ปัจจุบัน
  expect(js).toContain('if (m.url !== cmEl("cm-url").value.trim()) return;');
  // ⛔ PAT ต้องถูกล้างออกจาก DOM ตอนปิด (retainContextWhenHidden ทำให้หน้าค้างอยู่)
  expect(js).toContain('cmEl("cm-pat").value = "";');
  expect(SRC).toContain('type="password"');
});

test("⛔ host ต้องไม่เชื่อ host/user ที่ webview ส่งมาโดยไม่ validate", () => {
  // setGitCredential เป็นด่าน (whitelist + กัน newline) — ต้องถูกเรียกจาก case ที่รับ pat
  const i = SRC.indexOf('case "git_cred_save"');
  const j = SRC.indexOf('case "git_expiry_save"');
  expect(i).toBeGreaterThan(0);
  expect(SRC.slice(i, j)).toContain("setGitCredential(host, user, pat, exp)");
});

test("โซน Git: แถวโชว์สถานะหมดอายุ + แยกสีตาม level", () => {
  const js = clientScript();
  expect(js).toContain("r.expiryLevel");
  for (const lv of ["expired", "soon", "ok"]) expect(js).toContain('"' + lv + '"');
  // หมดอายุแล้วต้องบอกทางแก้ ไม่ใช่บอกแค่ว่าหมด
  expect(js).toContain("เปลี่ยน PAT");
  expect(SRC).toContain(".tres.warn");
});

test("⛔ วันหมดอายุที่ส่งเข้า client ต้องไม่พา secret มาด้วย", () => {
  const idx = SRC.indexOf('type: "git"');
  const end = SRC.indexOf("\n  });", idx);
  const block = SRC.slice(idx, end);
  expect(block).toContain("expiry");        // ส่งสถานะมาแล้วจริง
  expect(block).not.toMatch(/secret|password|token/i);
});

// ⛔ กฎของ user: เครื่องเขาเรนเดอร์ emoji/สัญลักษณ์พิเศษเป็น **กล่องเปล่า** → ใช้สื่อความหมายไม่ได้เลย
//    (เจอจริง 2026-08-13: ข้อความ "⛔ clone ผ่าน ssh จะล้ม" โผล่บนหน้าจอเป็นกล่อง อ่านไม่รู้เรื่อง)
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

// user สั่งลบบล็อกคำอธิบายของโซน Git ทิ้ง 2026-08-13 ("อะไรเยอะจัง อ่านแล้วงง" → "ลบในรูปออก")
// สิ่งที่มันบอกย้ายไปอยู่จุดที่ผู้ใช้เจอตอนต้องใช้: prompt ของช่องกรอก, สถานะในแถว, error ของ clone
test("โซน Git ต้องไม่มีบล็อกคำอธิบายกลับมา", () => {
  const b = SRC.indexOf('<div id="zone-git"');
  const en = SRC.indexOf("<script>", b);
  const zone = SRC.slice(b, en);
  expect(b).toBeGreaterThan(0);
  for (const gone of ["ทำไมต้องมี", "หลาย organization", "ความปลอดภัย", "<details"]) {
    expect(zone).not.toContain(gone);
  }
});

// ⛔ user ถาม "วันหมดอายุมันดึงจาก PAT เองไม่ได้หรอ ต้องให้ผมมากรอกตัวเตือนเฉย" —
//    ดึงด้วย PAT ไม่ได้จริง แต่ดึงด้วย Entra token ของ az ได้ (ทดสอบของจริงได้ HTTP 200)
//    API ไม่คืนค่า token กลับมา จับคู่อัตโนมัติไม่ได้ → ให้เลือกจากรายการที่มีวันจริงติดมา
test("modal: ดึงวันหมดอายุจริงจาก Azure มาให้เลือก ไม่ต้องพิมพ์เอง", () => {
  const js = clientScript();
  expect(SRC).toContain('id="cm-pick"');
  expect(js).toContain('post("git_pat_dates"');
  expect(js).toContain('m.type === "git_pat_dates_result"');
  // ถามทันทีที่รู้ org — ทั้งทางผลเช็ค URL และทางโหมดที่รู้ host/org อยู่แล้ว
  expect(js).toContain("askDates(m.user)");
  expect(js).toContain("if (!isAdd && _cmUser) askDates(_cmUser)");
  // เลือกแล้วต้องเติมช่องวันที่ให้จริง
  expect(js).toContain('cmEl("cm-exp").value = cmEl("cm-pick").value');
  // token เดียว = ใส่ให้เลย ไม่ต้องคลิก
  expect(js).toContain("if (pats.length === 1)");
});

test("⛔ ดึงวันไม่ได้ต้องไม่บล็อกการใส่ PAT (ของแถม ห้ามกลายเป็นด่าน)", () => {
  const js = clientScript();
  // ล้มแล้วแค่ซ่อน dropdown + บอกเหตุผล ไม่แตะปุ่มบันทึก
  expect(js).toContain('wrap.style.display = "none"');
  expect(js).toContain("m.reason");
  // cmSync (ตัวคุมปุ่มบันทึก) ต้องไม่อ้างอิงผลการดึงวันเลย
  const i = js.indexOf("function cmSync()");
  const seg = js.slice(i, js.indexOf("function cmUrlChanged()"));
  for (const dep of ["cm-pick", "_cmDatesOrg", "cm-exp"]) expect(seg).not.toContain(dep);
});

test("⛔ ผลดึงวันของ org เก่าที่มาช้าต้องถูกทิ้ง", () => {
  const js = clientScript();
  expect(js).toContain("if (m.org !== _cmDatesOrg) return;");
});

// user: "มันยังขึ้นให้ผมกรอกอยู่เลย ถ้าดึงจริงไม่ต้องให้มันแสดงปฏิทินก็ได้"
// ⇒ ปฏิทินต้องซ่อนเป็นค่าเริ่มต้น และโผล่เฉพาะตอนดึงวันจาก Azure ไม่ได้ (หรือกดขอเอง)
test("ปฏิทินต้องซ่อนไว้ก่อน โผล่เฉพาะตอนดึงวันไม่ได้", () => {
  const js = clientScript();
  // เริ่มต้นซ่อนใน HTML
  expect(SRC).toContain('<div id="cm-expwrap" style="display:none">');
  // เปิด modal = ซ่อนอีกครั้ง (เผื่อรอบก่อนเปิดค้างไว้)
  expect(js).toContain('cmEl("cm-expwrap").style.display = "none";');
  // ดึงได้ = ยังซ่อน · ดึงไม่ได้ = โชว์
  const i = js.indexOf("function cmDatesResult");
  const seg = js.slice(i, js.indexOf("cmEl(\"cm-cancel\")"));
  expect(seg).toContain('cmEl("cm-expwrap").style.display = "";');   // สาขาที่ล้ม
  expect(seg).toContain('cmEl("cm-expwrap").style.display = "none";'); // สาขาที่สำเร็จ
});

// user: "กรอกวันหมดอายุเองห้ามแสดงให้กดด้วย ให้มันแสดงแค่ตอนแปะลิ้งแล้วดึงไม่ได้จริงๆเท่านั้น"
// ⇒ ตัดลิงก์กรอกเองออกทั้งหมด (ตอนดึงไม่ได้ ปฏิทินโผล่เองอยู่แล้ว ลิงก์จึงไม่มีประโยชน์)
//   และตอนเปิด modal ต้องไม่มีข้อความเรื่องวันหมดอายุเลย
test("ห้ามมีลิงก์ 'กรอกวันหมดอายุเอง' และเปิด modal ต้องเงียบเรื่องวันหมดอายุ", () => {
  const js = clientScript();
  expect(SRC).not.toContain("cm-manual");
  expect(SRC).not.toContain("กรอกวันหมดอายุเอง");
  expect(SRC).not.toContain("linkbtn");
  // openCred ต้องไม่ตั้งข้อความสถานะวันหมดอายุใด ๆ (สถานะมาได้จาก cmDatesResult เท่านั้น)
  const i = js.indexOf("function openCred(");
  const seg = js.slice(i, js.indexOf("function closeCred("));
  expect(seg).toContain('cmEl("cm-expstatus").textContent = "";');
  expect(seg).not.toContain("จะดึงจาก Azure");
});

// Azure ประกาศบนหน้า PAT: Global PAT (ครอบทุก org) เลิกรองรับ 1 ธ.ค. 2026
// ⇒ ต้องเห็นก่อนเลือก ไม่ใช่รู้ตอน clone ล้มวันนั้น
test("dropdown ติดป้าย Global PAT + เตือนเมื่อเลือกตัวนั้น", () => {
  const js = clientScript();
  expect(js).toContain("pats[i].global");
  expect(js).toContain("Global PAT");
  expect(js).toContain("1 ธ.ค. 2026");
  expect(js).toContain('data-g="');
  expect(js).toContain("function cmGlobalWarn()");
  // เตือนทั้งตอนรายการมาถึง และตอน user เปลี่ยนตัวเลือก
  expect(js.match(/cmGlobalWarn\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  // ⛔ เตือนแล้วต้องยังบันทึกได้ (ตอนนี้ token ยังใช้งานได้จริง) — ห้ามไปแตะปุ่มบันทึก
  const i = js.indexOf("function cmGlobalWarn()");
  const seg = js.slice(i, i + 600);
  expect(seg).not.toContain("cm-ok");
});
