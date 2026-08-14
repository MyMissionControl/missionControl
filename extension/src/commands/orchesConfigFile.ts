import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sidecar for /orches-drive knobs that the bash side reads directly. Right now
// the only knob is the verify-gate retry cap (how many times the orchestrator
// bounces a failing sprint back to the worker before it stops and asks the user
// how to proceed). The path mirrors orches-integrate.sh's own resolution EXACTLY:
//   ORCHES_SETTINGS = $ORCHES_SETTINGS || ~/.claude/orches/settings.json
// so a direct write here lands where cmd_test_cap reads it next run. Offline —
// no server, no network. Node-only + a schema → unit-testable (no vscode).
//
// On-disk shape — TWO keys so the count is remembered while "loop until pass"
// is toggled on/off (a slide switch in the UI, not a typed word):
//   { "testCap": <positive int>, "testCapNoLimit": true|false }
// noLimit=true means no cap (cmd_test_cap → 0). We still read the legacy single
// form (testCap = "unlimited"/"none"/0) as noLimit for back-compat.

const ORCHES_SETTINGS_FILE = "settings.json";
const DEFAULT_CAP = "10";

/** Absolute path to the orches settings sidecar (overridable via ORCHES_SETTINGS
 *  for tests / parity with the bash). */
export function orchesSettingsPath(): string {
  return (
    process.env.ORCHES_SETTINGS ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || os.homedir(),
      ".claude",
      "orches",
      ORCHES_SETTINGS_FILE,
    )
  );
}

/** Read the raw sidecar object. Missing/corrupt → {}. */
function readRaw(): Record<string, unknown> {
  try {
    const o = JSON.parse(fs.readFileSync(orchesSettingsPath(), "utf8"));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeRaw(obj: Record<string, unknown>): void {
  const fp = orchesSettingsPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** True when the legacy single-value form meant "no cap". */
function legacyNoLimit(tc: unknown): boolean {
  if (typeof tc === "number") return tc <= 0;
  if (typeof tc === "string") {
    const t = tc.trim().toLowerCase();
    return t === "unlimited" || t === "none" || t === "0";
  }
  return false;
}

/** The finite round count shown in the number field, always a positive-int
 *  string (default "10"). Independent of the no-limit toggle so the value the
 *  user typed survives toggling. */
export function readTestCapNumber(): string {
  const tc = readRaw()["testCap"];
  if (typeof tc === "number" && Number.isFinite(tc) && tc > 0) return String(Math.floor(tc));
  if (typeof tc === "string" && /^\d+$/.test(tc.trim()) && Number(tc) > 0) return String(Number(tc));
  return DEFAULT_CAP;
}

/** Whether "loop until pass" (no cap) is ON — the slide toggle. Reads the
 *  explicit boolean, or infers it from the legacy single-value form. */
export function readTestCapNoLimit(): boolean {
  const raw = readRaw();
  if (raw["testCapNoLimit"] === true) return true;
  if (raw["testCapNoLimit"] === false) return false;
  return legacyNoLimit(raw["testCap"]);
}

/** Validate + persist the finite round count (positive integer), preserving the
 *  no-limit toggle. Throws on anything that isn't a positive integer. */
export function writeTestCapNumber(raw: string | number): string {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0) {
    throw new Error("retry cap must be a positive integer");
  }
  const obj = readRaw();
  obj["testCap"] = Number(s);
  if (typeof obj["testCapNoLimit"] !== "boolean") obj["testCapNoLimit"] = legacyNoLimit(readRaw()["testCap"]);
  writeRaw(obj);
  return readTestCapNumber();
}

// ── merge mode ───────────────────────────────────────────────────────────────
// ⛔⛔ The Settings page used to write `merge_mode` into config.json and nothing
// read it: orches-integrate.sh resolves the global merge mode from a FLAT FILE —
//   GLOBAL_SETTING="$HOME/.config/mission-control/merge-mode"   (contents: online|local)
// — so the toggle was inert and every project resolved `online`. Same class as
// the orches cap knobs above: a knob whose truth lives in a file the bash reads
// directly has to be written to THAT file, not to MC's own config.
//
// Resolution order in the engine (cmd_mode_get) is worth knowing before flipping
// it: the project's own `.orches-mode` pin wins, then $ORCHES_MERGE_MODE, then
// this file, then `online`. Every project pins itself at Step 1.5, so changing
// this affects the NEXT project to start, not one already running.

/** Path to the flat merge-mode file, mirroring the engine's own resolution.
 *  `MC_MERGE_MODE_PATH` exists so tests never touch the real one. */
export function mergeModePath(): string {
  return (
    process.env.MC_MERGE_MODE_PATH ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || os.homedir(),
      ".config",
      "mission-control",
      "merge-mode",
    )
  );
}

/** What the engine would read right now, or null when the file is absent/blank.
 *  Whitespace is stripped the same way `tr -d '[:space:]'` does on the bash side. */
export function readMergeModeFile(): string | null {
  try {
    const v = fs.readFileSync(mergeModePath(), "utf8").replace(/\s+/g, "");
    return v === "online" || v === "local" ? v : null;
  } catch {
    return null;
  }
}

/** Persist the mode where the engine reads it. Caller validates the value first
 *  (setSetting's select check); this refuses anything else outright anyway. */
export function writeMergeModeFile(mode: string): void {
  if (mode !== "online" && mode !== "local") throw new Error(`merge_mode: '${mode}' is not a valid option`);
  const fp = mergeModePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, mode + "\n", "utf8");
}

/** Set the "loop until pass" slide toggle, preserving the finite count (so
 *  turning it off restores the previously-typed number). */
export function writeTestCapNoLimit(on: boolean): boolean {
  const obj = readRaw();
  obj["testCapNoLimit"] = on;
  // Ensure a sane finite count is present regardless, so toggling off later
  // shows a real number rather than nothing.
  if (typeof obj["testCap"] !== "number" || !(Number(obj["testCap"]) > 0)) {
    obj["testCap"] = Number(readTestCapNumber());
  }
  writeRaw(obj);
  return readTestCapNoLimit();
}
