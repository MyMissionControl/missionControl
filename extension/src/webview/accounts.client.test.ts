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
  for (const cls of ["git-add", "gtest", "gedit", "gdel"]) {
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

test("โซน Git: ปุ่ม 'วันหมดอายุ' มี handler + ส่งวันเดิมไปด้วย", () => {
  const js = clientScript();
  expect(js).toContain('t.classList.contains("gexp")');
  expect(js).toContain('post("git_expiry"');
  // ต้องพาวันเดิมไปให้ช่องกรอกตั้งค่าไว้ ไม่ใช่ให้พิมพ์ใหม่ทุกครั้ง
  expect(js).toContain('t.getAttribute("data-e")');
  // ⛔ gexp ต้องถูกเช็คก่อน .del ตัวท้าย (ปุ่มลบของ account AI) ไม่งั้นคลิกผิดเรื่อง
  expect(js.indexOf('contains("gexp")')).toBeLessThan(js.lastIndexOf('contains("del")'));
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
