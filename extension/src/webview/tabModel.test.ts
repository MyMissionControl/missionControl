import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { TAB_ICONS, tabIconFor, tabLabel } from "./tabModel";

const SRC = path.join(import.meta.dir, "..");
const ICONS = path.join(import.meta.dir, "..", "..", "media", "tabicons");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

/** Every viewType the extension actually opens a panel with. */
function declaredViewTypes(): string[] {
  const out: string[] = [];
  for (const f of tsFiles(SRC)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/createWebviewPanel\(\s*"([^"]+)"/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

// A new panel added without an icon is the bug this whole module exists to stop:
// it opens as an unlabelled tab the moment the tab bar is crowded.
test("every webview panel in the source has a tab icon", () => {
  const missing = declaredViewTypes().filter((v) => !tabIconFor(v));
  expect(missing).toEqual([]);
});

const MANIFEST: Record<string, { dark?: string; light?: string }> = JSON.parse(
  fs.readFileSync(path.join(ICONS, "manifest.json"), "utf8"),
);

test("every mapped icon exists for both themes", () => {
  const missing: string[] = [];
  for (const name of Object.values(TAB_ICONS)) {
    for (const theme of ["dark", "light"] as const) {
      const rel = MANIFEST[name]?.[theme];
      if (!rel || !fs.existsSync(path.join(ICONS, rel))) missing.push(`${theme}/${name}`);
    }
  }
  expect(missing).toEqual([]);
});

// The bug this guards: three icon revisions in a row landed under the same file
// name, so VS Code kept painting the FIRST drawing from its URL cache and every
// redraw looked like a failed build.
test("icon file names carry a content hash, so a redraw changes the URL", () => {
  for (const [name, files] of Object.entries(MANIFEST)) {
    for (const theme of ["dark", "light"] as const) {
      const rel = files[theme] ?? "";
      expect(rel).toMatch(new RegExp(`^${theme}/${name}\\.[0-9a-f]{8}\\.svg$`));
    }
  }
  // dark and light differ in content → they must differ in hash too
  const dark = MANIFEST.skills.dark ?? "";
  const light = MANIFEST.skills.light ?? "";
  expect(dark.split(".")[1]).not.toBe(light.split(".")[1]);
});

test("icons are drawn in a fixed colour per theme (VS Code never recolors them)", () => {
  const dark = fs.readFileSync(path.join(ICONS, MANIFEST.skills.dark ?? ""), "utf8");
  const light = fs.readFileSync(path.join(ICONS, MANIFEST.skills.light ?? ""), "utf8");
  expect(dark).toContain("#C5C5C5");
  expect(light).toContain("#424242");
  expect(dark).not.toContain("currentColor"); // would render invisible in a tab
});

test("tabIconFor: an unknown panel keeps the default icon", () => {
  expect(tabIconFor("someone.else.panel")).toBeNull();
});

test("tabLabel: short names are left alone", () => {
  expect(tabLabel("Chat", "brew")).toBe("Chat · brew");
  expect(tabLabel("", "Skills")).toBe("Skills");
});

test("tabLabel: a long name keeps its TAIL — that is the part that differs", () => {
  const label = tabLabel("Chat", "agentskill-marketplace-newflow6/brew");
  expect(label.length).toBeLessThanOrEqual("Chat · ".length + 20);
  expect(label.endsWith("newflow6/brew")).toBe(true);
  expect(label.startsWith("Chat · …")).toBe(true);
});

test("tabLabel: two sessions of the same project stay distinguishable", () => {
  const a = tabLabel("Chat", "agentskill-marketplace-newflow6/brew");
  const b = tabLabel("Chat", "agentskill-marketplace-newflow6/john");
  expect(a).not.toBe(b);
});

test("tabLabel: an empty name degrades to the prefix, not to a dangling separator", () => {
  expect(tabLabel("Usage", "")).toBe("Usage");
});
