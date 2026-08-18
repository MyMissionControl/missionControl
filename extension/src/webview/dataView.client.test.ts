import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// dataView.ts's client JS lives inside a template literal, so tsc never sees it — one
// stray bracket bricks the whole Data View at runtime with no build error. Read the file
// as TEXT (importing it pulls in `vscode`) and prove the script parses, plus that the
// single-table wiring is actually connected.
const SRC = fs.readFileSync(path.join(__dirname, "dataView.ts"), "utf8");

function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // the file is a template literal: swap ${...} substitutions for a literal so the raw
  // text is parseable JS (that is exactly what the browser ends up receiving).
  return SRC.slice(start + "<script>".length, end).replace(/\$\{[^}]*\}/g, "0");
}

test("client script ยัง parse ได้ (syntax error = หน้า Data View ตายทั้งหน้า เงียบ ๆ)", () => {
  const js = clientScript();
  expect(js.length).toBeGreaterThan(1000);
  expect(() => new Function(js)).not.toThrow();
});

test("project mode = ตารางเดียว: ไม่เหลือกลุ่ม plan / sprint / เอกสารอื่นๆ", () => {
  const js = clientScript();
  // the three old row classes are gone — one row type (.frow) renders the whole tree
  for (const dead of ["planrow", "sprow", "docrow", "docsOpen", "planOpen"]) {
    expect(js).not.toContain(dead);
  }
  expect(js).toContain('class="frow');
  // exactly one <table> is emitted by the project view
  const body = js.slice(js.indexOf("function renderProjectTable"));
  expect(body.slice(0, body.indexOf("function renderProjectKanban")).match(/<table>/g)).toHaveLength(
    1,
  );
});

test("rows come from the real tree the host sends, not a flattened doc list", () => {
  const js = clientScript();
  expect(js).toContain("S.tree = m.tree || []");
  expect(js).toContain("prune(S.tree || [], q, taskIndex())");
  expect(js).not.toContain("S.docs");
  // the host answers get_tasks with that tree
  expect(SRC).toContain("tree: p ? loadProjectDocTree(p) : []");
});

test("open_doc ส่ง {project, rel} ให้ extension resolve เอง (กัน path traversal)", () => {
  const js = clientScript();
  expect(js).toContain('vscode.postMessage({ type: "open_doc", project: S.proj.path, rel: doc.dataset.rel })');
  expect(js).toContain('vscode.postMessage({ type: "open_doc", project: S.proj.path, rel })');
  expect(js).not.toContain("file: doc.dataset.f"); // the old absolute-path message
  // and the host side really does guard + branch image vs markdown
  expect(SRC).toContain("resolveProjectFile(proj, rel)");
  expect(SRC).toContain("IMG_RX.test(abs)");
  expect(SRC).toContain('vscode.commands.executeCommand("vscode.open"');
});

test("โฟลเดอร์เปิดไว้ก่อน ไฟล์ปิดไว้ก่อน .orches-shots ปิดไว้ก่อน ค้นหาเปิดทุกอย่าง", () => {
  const js = clientScript();
  const fn = js.slice(js.indexOf("function isOpen("), js.indexOf("function fileRows("));
  expect(fn).toContain("if (searching) return true;");
  expect(fn).toContain("if (!isDir) return false;"); // files: drill-down closed
  // top-level dot-folder (= .orches-shots) closed; anything nested inside it open
  expect(fn).toContain('return !(rel.charAt(0) === "." && rel.indexOf("/") === -1);');
  expect(js).toContain("fileRows(rows, 0, !!q)");
});

test("ไฟล์ที่ไม่มี task ก็ยังกดเปิดได้ (แถวคลิกได้ทั้งแถว)", () => {
  const js = clientScript();
  const h = js.slice(js.indexOf('const row = e.target.closest(".frow")'));
  expect(h.slice(0, 400)).toContain("if (row.dataset.x)"); // expandable → toggle
  expect(h.slice(0, 400)).toContain('type: "open_doc"'); // plain file → open
});
