// Gives a webview panel its tab icon. Kept apart from tabModel.ts so the mapping
// stays testable without vscode.

import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { tabIconFor } from "./tabModel";

/** name → { dark: "dark/<name>.<hash>.svg", light: … }, written by
 *  scripts/gen-tabicons.mjs. */
type IconManifest = Record<string, { dark?: string; light?: string }>;

let _root: vscode.Uri | null = null;
let _manifest: IconManifest = {};

/** Called once from activate(); without it setTabIcon is a silent no-op (a panel
 *  with no icon is exactly what shipped before, so this can never break a panel). */
export function initTabIcons(extensionUri: vscode.Uri): void {
  _root = vscode.Uri.joinPath(extensionUri, "media", "tabicons");
  try {
    _manifest = JSON.parse(fs.readFileSync(path.join(_root.fsPath, "manifest.json"), "utf8")) as IconManifest;
  } catch {
    _manifest = {}; // no manifest = no icons, never a broken image
  }
}

/** VS Code draws iconPath as an image and never recolors it, hence a file per
 *  theme. Safe to call on any panel — an unmapped viewType keeps the default.
 *
 *  ⛔ The file names are content-hashed (see gen-tabicons.mjs): the tab icon URL
 *  is cached by the renderer, so a redrawn icon MUST arrive under a new name or
 *  the old picture survives window reloads. Never hardcode "<name>.svg" here. */
export function setTabIcon(panel: vscode.WebviewPanel): void {
  const name = tabIconFor(panel.viewType);
  if (!name || !_root) return;
  const files = _manifest[name];
  if (!files?.dark || !files?.light) return;
  panel.iconPath = {
    light: vscode.Uri.joinPath(_root, ...files.light.split("/")),
    dark: vscode.Uri.joinPath(_root, ...files.dark.split("/")),
  };
}
