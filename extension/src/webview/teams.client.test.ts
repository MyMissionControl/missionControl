import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Team Config's client JS lives inside a template literal, so tsc never sees it —
// and this panel had NO client test at all while a per-member runtime/memory
// picker was added to it. Read the file as TEXT (importing it pulls in `vscode`),
// same as orchestrator.client.test.ts.
//
// ⛔⛔ The bug this file exists for was found by driving real Chromium, not by
//    reading: the memory checkbox rendered `disabled` but still `checked`, which
//    no click / synthetic mouse event / Space could clear, while Save happily
//    posted it as an active grant for a claude worker — a grant that then fires
//    --approve-for-me the day anyone flips that worker back to codex.
const SRC = fs.readFileSync(path.join(__dirname, "teams.ts"), "utf8");

/** The script as the browser really receives it: sliced out of the template
 *  literal and un-escaped (the source writes \' for every quote). */
function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const raw = SRC.slice(start + "<script>".length, end);
  // ⛔ no ${} substitution exists in this block; if one is ever added this cook
  //    would evaluate it, so assert its absence rather than silently running it.
  expect(raw).not.toContain("${");
  return new Function("return `" + raw + "`")() as string;
}

test("client script still parses (a syntax error kills the whole panel, silently)", () => {
  const js = clientScript();
  expect(js.length).toBeGreaterThan(1000);
  expect(() => new Function(js)).not.toThrow();
});

/** Pull one function out of the cooked script and make it callable alone. */
function fn(name: string, deps = ""): (...a: unknown[]) => string {
  const src = clientScript();
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const ESC =
    'function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")' +
    '.replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }';
  return new Function(`${ESC}\n${deps}\n${src.slice(start, end)}\nreturn ${name};`)() as (
    ...a: unknown[]
  ) => string;
}

// ── memoryToggle: "disabled AND checked" must be unreachable ─────────────────
test("memoryToggle: codex + on = enabled and ticked", () => {
  const h = fn("memoryToggle")(true, "codex");
  expect(h).toContain(" checked");
  expect(h).not.toContain("disabled");
});

test("memoryToggle: codex + off = enabled, not ticked", () => {
  const h = fn("memoryToggle")(false, "codex");
  expect(h).not.toContain(" checked");
  expect(h).not.toContain("disabled");
});

test("⛔ memoryToggle: claude can NEVER render a tick, even when asked to", () => {
  const mt = fn("memoryToggle");
  for (const rt of ["claude", "", undefined]) {
    const h = mt(true, rt);
    expect(`${JSON.stringify(rt)} disabled=${h.includes("disabled")}`).toBe(
      `${JSON.stringify(rt)} disabled=true`,
    );
    expect(`${JSON.stringify(rt)} ticked=${h.includes(" checked")}`).toBe(
      `${JSON.stringify(rt)} ticked=false`,
    );
  }
});

// ── runtimeSelect ────────────────────────────────────────────────────────────
const RT_DEPS = 'var OPT = { runtimeOptions: ["claude","codex"] };';

test("runtimeSelect keeps a stored value that is not in the option list", () => {
  // ⛔ dropping it would silently move that worker back to claude — wrong wallet,
  //    no error anywhere.
  const h = fn("runtimeSelect", RT_DEPS)("gemini");
  expect(h).toContain('value="gemini"');
  expect(h).toContain("selected");
});

test("runtimeSelect defaults to claude when unset", () => {
  expect(fn("runtimeSelect", RT_DEPS)("")).toContain('value="claude" selected');
});

// ── the table must not go crooked when a column is added ────────────────────
test("header column count matches a member row's cell count", () => {
  const js = clientScript();
  const rowStart = js.indexOf("function memberRowHtml(");
  const rowSrc = js.slice(rowStart, js.indexOf("function readMembers("));
  // ⛔ match bare `<td` — the oracle cell is built as '<td'+nameAttrs+'>', so a
  //    `[ >]` class silently under-counts it and the test fails for its own reason
  //    instead of the code's (verified against a real DOM render: th=7, td=7).
  // ⛔ `<thead` also starts with `<th` — counting it makes the test off-by-one and
  //    red for its own reason, which is how a real column mismatch gets ignored.
  const th = (js.match(/<th(?![a-z])/g) || []).length;
  const td = (rowSrc.match(/<td/g) || []).length;
  expect(`th=${th} td=${td}`).toBe(`th=${td} td=${td}`);
});

// ── readMembers must not report a value the user cannot act on ──────────────
test("⛔ readMembers reads .memory only when the control is enabled", () => {
  const js = clientScript();
  const rm = js.slice(js.indexOf("function readMembers("));
  expect(rm.slice(0, rm.indexOf("return out;"))).toContain("!c.disabled");
});

// ── the runtime change handler must CLEAR a tick when going back to claude ──
test("⛔ switching back to claude drops the tick instead of carrying it", () => {
  const js = clientScript();
  const h = js.slice(js.indexOf("rtSel.addEventListener('change'"));
  const body = h.slice(0, h.indexOf("});"));
  // keep must be gated on headless — a bare `mem.checked` is the original bug
  expect(body).toContain("headless && mem.checked");
});
