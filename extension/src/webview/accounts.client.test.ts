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

test("โซน SSH: ปุ่มเตรียม host key / ทดสอบ ต่อสายจริง + แถวบอกสถานะ", () => {
  const js = clientScript();
  expect(js).toContain('t.classList.contains("sprep")');
  expect(js).toContain('t.classList.contains("stest")');
  expect(SRC).toContain('id="ssh-rows"');
  expect(SRC).toContain('id="ssh-keys"');
  // ⛔ ปุ่ม "เตรียม host key" ต้องโผล่เฉพาะตอนยังไม่มี — มีแล้วยังโชว์ = ชวนกดของที่ไม่ต้องกด
  expect(js).toContain('(h.known ? "" : ');
  // ⛔ ห้ามส่งชื่อไฟล์ key ไปเป็นเนื้อ key — โชว์แค่ชื่อ
  expect(js).toContain("v.ssh.keys");
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
