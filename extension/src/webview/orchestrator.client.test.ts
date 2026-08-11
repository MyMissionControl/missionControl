import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// orchestrator.ts's client JS lives inside a template literal, so tsc never sees it —
// a single stray bracket bricks the ENTIRE Projects page at runtime with no build error.
// Read the file as TEXT (importing it pulls in `vscode`) and at minimum prove the script
// still PARSES, plus that the name-popup's clone wiring is actually connected.
const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");

function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start + "<script>".length, end);
}

test("client script ยัง parse ได้ (syntax error = หน้า Projects ตายทั้งหน้า เงียบ ๆ)", () => {
  const js = clientScript();
  expect(js.length).toBeGreaterThan(1000);
  // ⛔ Function() แค่ parse ไม่ได้รัน — พอสำหรับจับ syntax error ซึ่งเป็นความพังที่ tsc มองไม่เห็น
  expect(() => new Function(js)).not.toThrow();
});

test("name-popup: ช่อง URL ต่อสายจริงทั้งเส้น (ไม่ใช่ input ลอย)", () => {
  const js = clientScript();
  expect(SRC).toContain('id="nm-url"'); // ช่องกรอกมีอยู่ใน HTML
  expect(SRC).toContain('id="nm-urlstatus"'); // และมีที่โชว์ verdict
  // ส่ง url ไปกับทั้ง check_name และ name_confirmed — ขาดตัวใดตัวหนึ่ง = กรอกแล้วไม่มีผล
  expect(js).toContain("post('check_name',{name:el('nm-input').value,url:el('nm-url').value})");
  expect(js).toContain("post('name_confirmed',{name:n,url:u})");
  expect(js).toContain("el('nm-url').addEventListener('input', nmSchedule)");
});

test("name-popup: ปุ่มถัดไปต้องติดทั้งชื่อว่าง AND url ใช้ได้", () => {
  const js = clientScript();
  expect(js).toContain("el('nm-ok').disabled=!(free && _nmUrlOk)");
  // ว่าง = สร้างเปล่า ต้องผ่าน (ห้ามบังคับกรอก URL)
  expect(js).toContain("if(!u){");
  expect(js).toContain("_nmUrlOk=true");
});
