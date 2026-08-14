// Writes media/tabicons/{dark,light}/*.svg — one line icon per webview panel.
//
// ⛔ These are NOT free-drawn. A tab icon must be the SAME glyph the panel is
// reached by, or the tab reads as a different feature: the sidebar's Skills is an
// asterisk, so the Skills tab is an asterisk (it was a puzzle piece for one build
// and the user caught it immediately). Each entry below cites where its shape
// comes from — keep them in sync when the sidebar changes.
//
// VS Code draws a tab's iconPath as an image and never recolors it, so each icon
// is emitted once per theme colour. Run with:  node scripts/gen-tabicons.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "tabicons");

// Stroke paths on a 24x24 grid. `w` overrides the stroke width where the source
// icon uses a different one.
const GLYPHS = {
  // media/zap.svg — the Mission Control mark, same as the panel header
  dashboard: { d: '<path d="M13 2 L4 13.5 h6 l-1 8.5 9-11.5 h-6 z" fill="COLOR" stroke="none"/>' },
  // sidebar.ts ICON_SPARK — nav item "Skills"
  skills: { d: '<path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/>' },
  // sidebar.ts ICON_GLOBE — nav item "Connections" (the user's pick, 2026-08-14:
  // the half-filled circle read as a theme/contrast toggle, not as a connection)
  connections: {
    d: '<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9s1.3-6.4 3.9-9z"/>',
  },
  // sidebar.ts ICON_SERVER — nav item "Localhosts"
  localhosts: {
    d: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  },
  // sidebar.ts ICON_DOC — nav item "Requirement"
  requirement: {
    d: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  },
  // sidebar.ts ICON_FOLDER — nav item "Projects"
  projects: { d: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
  // sidebar.ts ICON_GEAR — nav item "Settings"
  settings: {
    w: 1.8,
    d: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  },
  // dashboard.ts — the "Team Config" tile
  teams: {
    w: 1.8,
    d: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/>',
  },
  // dashboard.ts — the "Data View" tile
  dataView: { w: 1.8, d: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>' },
  // No icon of its own anywhere in the UI — these three keep a plain line glyph.
  budget: { d: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 10v4M18 10v4"/>' },
  budgetDetail: { d: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
  chat: { d: '<path d="M20.5 12.4c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L3.5 20.5l1.6-3.9C4 15.4 3.5 14 3.5 12.4c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>' },
  ask: { d: '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.4 3.9c-.6.4-.9.9-.9 1.6"/><path d="M12 17.6h.01"/>' },
};

const THEMES = { dark: "#C5C5C5", light: "#424242" };

// ⛔ The file NAME carries a hash of the file's own contents, and tabIcon.ts
// resolves it through manifest.json. Reason, learned the hard way 2026-08-14:
// VS Code turns a tab's iconPath into one CSS background-image URL and the
// renderer caches it by URL, so redrawing an icon UNDER THE SAME NAME shows the
// old picture even after a full window reload — three icon revisions in a row
// looked like "you forgot to compile". A changed drawing = a changed URL now.
const manifest = {};
for (const [theme, color] of Object.entries(THEMES)) {
  const dir = join(ROOT, theme);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".svg")) rmSync(join(dir, f)); // no orphans from older hashes
  for (const [name, g] of Object.entries(GLYPHS)) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      `stroke="${color}" stroke-width="${g.w ?? 2}" stroke-linecap="round" stroke-linejoin="round">` +
      g.d.replaceAll("COLOR", color) +
      "</svg>\n";
    const file = `${name}.${createHash("sha1").update(svg).digest("hex").slice(0, 8)}.svg`;
    writeFileSync(join(dir, file), svg);
    (manifest[name] ??= {})[theme] = `${theme}/${file}`;
  }
}
writeFileSync(join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${Object.keys(GLYPHS).length} icons x ${Object.keys(THEMES).length} themes + manifest.json into ${ROOT}`);
