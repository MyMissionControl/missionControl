import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Same scar as `sidebar.script.test.ts`, one panel over: the Skills panel's browser JS
 * lives inside a TS template literal, so `tsc` never parses it and `bun test` has no
 * module to import — 1,100+ lines with no test coverage at all.
 *
 * ⛔ The DOM contract is the half that rots silently. A handler that calls
 * getElementById on an id the markup no longer contains does not throw: the guard
 * `if (d)` makes it a no-op, so the feature just stops responding with nothing in any
 * log. Found live 2026-08-20: drag-and-drop still accepted the file but the highlight
 * element `drop` had been removed from the markup AND the stylesheet, so the panel gave
 * the user no sign it takes a drop at all.
 */
const SRC = readFileSync(join(import.meta.dir, "skills.ts"), "utf8");

/** The client <script> body (the one that owns the upload handler). */
function panelScript(): string {
  const blocks = [...SRC.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.includes("handleFile"));
  expect(hit).toBeTruthy();
  return hit as string;
}

test("every id the skills panel script reaches for exists in the markup", () => {
  const ids = [...panelScript().matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(
    (m) => m[1],
  );
  expect(ids.length).toBeGreaterThan(0);
  const missing = [...new Set(ids)].filter((id) => !SRC.includes(`id="${id}"`));
  expect(missing).toEqual([]);
});

test("the drop target the drag handlers highlight is a real element with a real style", () => {
  // Both halves or the highlight is invisible: the element must exist AND `.drag`
  // must resolve to a rule, otherwise adding the class paints nothing.
  const script = panelScript();
  expect(script).toContain('getElementById("drop")');
  expect(SRC).toContain('id="drop"');
  expect(SRC).toMatch(/\.drag\b[^{]*\{/);
});
