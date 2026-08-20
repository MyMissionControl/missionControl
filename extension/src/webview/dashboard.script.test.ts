import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dashboard's browser JS is a 1,500-line template literal — no parser, no import,
 * no coverage. This pins the DOM contract between the host's postMessage handlers and
 * the markup they write into.
 *
 * ⛔ Why an allowlist instead of "every id must exist": two ids are missing ON PURPOSE.
 * The status pill was removed while its poll kept firing, and the handler guards the
 * lookup so the poll is a harmless no-op (`dashboard.ts`, the `m.type === "status"`
 * branch says so). Anything NOT on this list that goes missing is the bad kind — a
 * receiver whose element is gone, i.e. work the host does for nobody. Found live
 * 2026-08-20: `skillsSub` had been gone since the Skills card was removed, while the
 * host kept calling `listSkills()` — 150 synchronous SKILL.md reads, every 10 seconds.
 */
const SRC = readFileSync(join(import.meta.dir, "dashboard.ts"), "utf8");

/** Ids the markup deliberately does not contain (removed card, guarded no-op poll). */
const DELIBERATELY_ABSENT = new Set(["dot", "statusText"]);

/** The client <script> body (the one that owns the message handler). */
function panelScript(): string {
  const blocks = [...SRC.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.find((b) => b.includes("renderSessions"));
  expect(hit).toBeTruthy();
  return hit as string;
}

test("every id the dashboard script reaches for exists in the markup", () => {
  const ids = [...panelScript().matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(
    (m) => m[1],
  );
  expect(ids.length).toBeGreaterThan(0);
  const missing = [...new Set(ids)]
    .filter((id) => !SRC.includes(`id="${id}"`))
    .filter((id) => !DELIBERATELY_ABSENT.has(id));
  expect(missing).toEqual([]);
});

test("the host does not compute a card nobody renders", () => {
  // listSkills() walks ~/.claude/skills with synchronous readFileSync per skill. It is
  // only worth paying for while something displays the number.
  const hasReceiver = SRC.includes('id="skillsSub"');
  const hasProducer = SRC.includes("pushSkillCount");
  expect(hasProducer).toBe(hasReceiver);
});
