import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The sidebar's browser JS lives inside a TS template literal, so nothing ever parses it:
 * a typo ships as a silently dead panel (no error anywhere — the webview just stops
 * responding to clicks). This repo already has that scar twice over on the engine side,
 * where `\s` inside a template literal was eaten and a backtick in a comment closed the
 * string mid-script.
 *
 * ⛔ Both halves matter: syntax AND the DOM contract. A script that parses fine but calls
 * getElementById on an id the markup does not contain is the same dead panel.
 */
const SRC = readFileSync(join(import.meta.dir, "sidebar.ts"), "utf8");

/** The <script> body of panelHtml (the one with the settings button). */
function panelScript(): string {
  const blocks = [...SRC.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.includes("settingsBtn"));
  expect(hit).toBeTruthy();
  // Template interpolations are extension-side values, not JS the browser parses —
  // swap each for a literal so `node --check` sees the shape the browser will get.
  return (hit as string).replace(/\$\{[^}]*\}/g, "0");
}

test("sidebar panel script parses as real JS (template literals hide syntax errors)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-script-"));
  try {
    const f = join(dir, "panel.js");
    writeFileSync(f, panelScript());
    // throws (non-zero exit) on a syntax error, with the line
    execFileSync("node", ["--check", f], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every id the panel script reaches for exists in the panel markup", () => {
  const script = panelScript();
  const ids = [...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(SRC).toContain(`id="${id}"`);
});

// ⛔⛔ USER 2026-08-17: the agent's question must render INSIDE this panel, never by
//   opening a new editor group. These pin the wiring that makes that true.
test("the ask card has a home in the panel, and the script fills it", () => {
  expect(SRC).toContain('<div id="askWrap"></div>');
  const script = panelScript();
  expect(script).toContain("askWrap.innerHTML = m.card");
  expect(script).toContain("ask_clear");
});

test("clicking an option posts back the shape pendingAskWatch handles", () => {
  const script = panelScript();
  expect(script).toContain("type: 'ask_answer'");
  expect(script).toContain("type: 'ask_submit'");
  // multi-select must send every ticked key, not just the last clicked one
  expect(script).toContain("keys: picked()");
});

test("the card is styled inside the panel (an unstyled card reads as broken)", () => {
  expect(SRC).toContain("#askWrap .card");
  expect(SRC).toContain("#askWrap:empty { display: none; }");
});
