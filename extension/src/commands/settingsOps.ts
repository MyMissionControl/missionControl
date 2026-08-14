import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isAutoSkillEnabled, setAutoSkillEnabled } from "./autoSkillOps";
import {
  readMergeModeFile,
  readTestCapNoLimit,
  readTestCapNumber,
  writeMergeModeFile,
  writeTestCapNoLimit,
  writeTestCapNumber,
} from "./orchesConfigFile";
import { DEFAULT_MODEL, MODEL_ALIASES } from "./teamsModel";

// Node-only settings I/O for the Settings page. Pure fs + a schema — no vscode,
// no backend — so it's unit-testable (see settingsOps.test.ts). The knobs live
// on disk at ~/.mission-control/config.json (same file the old QuickPick config
// command edited); this module reads/writes that file and pairs each key with
// display metadata so the webview can render a documented form instead of a
// bare key/value list.
//
// Tests point MC_CONFIG_PATH at a throwaway file so nothing touches the real
// config.

/** Resolve the config file path — overridable for tests. */
export function configPath(): string {
  return (
    process.env.MC_CONFIG_PATH ||
    path.join(os.homedir(), ".mission-control", "config.json")
  );
}

export type FieldType = "select" | "boolean" | "number" | "string";

export type FieldSchema = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  help: string;
  /** For select fields: {value, label} choices. */
  options?: { value: string; label: string }[];
  /** Default applied when the key is absent from the file. */
  default: string | number | boolean;
  /** Saved but no longer drives anything (backend/orchestrator removed). */
  legacy?: boolean;
};

// The known knobs, grouped for the page. Keys not listed here still show up
// under an "Other" group (read from the raw file) so nothing is ever hidden.
//
// merge_mode + push_mode are NEW keys surfaced here per the standing request to
// give the orchestrator's PR-vs-local merge behaviour a home in the Settings
// page. They default in even when the file predates them.
export const SETTINGS_SCHEMA: FieldSchema[] = [
  {
    key: "merge_mode",
    label: "Merge mode",
    group: "Orchestration",
    type: "select",
    default: "online",
    options: [
      { value: "online", label: "Online — open PR + gh merge (default)" },
      { value: "local", label: "Local — git merge --no-ff, no PR" },
    ],
    help:
      "How /orches-drive integrates a finished sprint. Online = push the agents/<role> branch, open a PR, and gh pr merge --delete-branch on GitHub, then pull --ff-only. Local = merge straight into main with no PR (offline fallback). Online needs the gh CLI logged in; if gh is missing it stops rather than silently downgrading.",
  },
  {
    key: "orches_test_cap",
    label: "จำนวนรอบตีกลับสูงสุด (เมื่อเทสไม่ผ่าน)",
    group: "Orchestration",
    type: "number",
    default: 10,
    help:
      "จำนวนรอบที่ /orches-drive ตีกลับให้ worker แก้เมื่อ verify-gate ไม่ผ่าน ก่อนจะหยุดถาม user. ทุกรอบที่ fail จะ comment ลง draft PR ให้เห็น timeline. ชน cap = orchestrator แจ้ง user + ถามว่าจะไปต่อยังไง (แก้ต่อ / merge ทั้งที่ fail / หยุด) — ไม่ merge เอง. ใช้ค่านี้เฉพาะเมื่อสไลด์ด้านล่างปิดอยู่. เก็บที่ ~/.claude/orches/settings.json (คนละไฟล์กับ knob อื่น เพราะ bash ฝั่ง orches อ่านตรงจากไฟล์นี้).",
  },
  {
    key: "orches_test_cap_nolimit",
    label: "วนแก้จนกว่าจะผ่าน (ไม่หยุดที่จำนวนรอบ)",
    group: "Orchestration",
    type: "boolean",
    default: false,
    help:
      "เปิด = orchestrator ตีกลับให้ worker แก้ไปเรื่อยๆ จนเทสผ่าน (ไม่สนใจจำนวนรอบด้านบน). ปิด = หยุดถาม user เมื่อครบจำนวนรอบด้านบน. เปิด/ปิดได้โดยไม่ลบเลขจำนวนรอบที่ตั้งไว้.",
  },
  {
    key: "push_mode",
    label: "Push timing",
    group: "Orchestration",
    type: "select",
    default: "per-sprint",
    options: [
      { value: "per-sprint", label: "Per sprint — push after each sprint" },
      { value: "on-demand", label: "On demand — only when asked" },
      { value: "at-end", label: "At end — one push when the build closes" },
    ],
    help:
      "When the orchestrator pushes to the remote. Asked up-front at the start of a drive; this sets the default it offers.",
  },
  {
    key: "claude_view_mode",
    label: "หน้าตา Claude REPL",
    group: "Orchestration",
    type: "select",
    default: "chat",
    options: [
      { value: "chat", label: "Claude Chat (ของเรา) — ค่าเริ่มต้น" },
      { value: "native", label: "Terminal (native) — tmux attach ในแท็บ terminal" },
    ],
    help:
      "เลือกว่าปุ่มต่างๆ ใน Mission Control จะเปิด Claude REPL เป็นหน้าไหน. " +
      "Claude Chat (ของเรา) = webview ที่อ่าน transcript มาเรนเดอร์เป็นแชท — ภาษาไทยไม่แตก, ตัด emoji ที่อ่านไม่ออกทิ้ง, แนบไฟล์/ลากไฟล์วางได้, มีปุ่ม /compact, เปิด-ปิด worker ได้; แต่ส่งได้แค่ข้อความ+Enter (กด Esc หรือ Ctrl-C หยุด agent ไม่ได้, ไม่มีเมนู / กับ @, ไม่มี Shift+Tab, ย้อนดูได้เท่าที่ transcript เก็บ). " +
      "Terminal (native) = เปิดแท็บ terminal แล้ว tmux attach ตรงๆ — ได้ TUI เต็ม (Esc, Ctrl-C, Shift+Tab, เมนู / และ @, เลื่อนดูย้อนหลังได้หมด, วางรูปจากคลิปบอร์ดได้); แต่ภาษาไทยแตกและลากไฟล์วางไม่ได้. " +
      "session ที่แชทเรนเดอร์ไม่ได้ (เช่น shell เปล่า) จะเปิดเป็น terminal ให้อัตโนมัติไม่ว่าตั้งค่าไว้แบบไหน.",
  },
  {
    key: "default_member_model",
    label: "Default member model",
    group: "Teams",
    type: "select",
    default: DEFAULT_MODEL,
    // Pinned subset (teamsModel.MODEL_ALIASES), shown without the "claude-" prefix
    // like the Team Config dropdown does. This static array is the INSTANT paint;
    // listSettings(modelIds) swaps in the live served list when the caller has it
    // (see modelOptions below) so the two dropdowns agree.
    options: MODEL_ALIASES.map((m) => ({
      value: m,
      label: m.replace(/^claude-/, ""),
    })),
    help:
      "Model a newly added team member starts on in the Team Config page. You can still override per member; this only sets what a fresh row is pre-selected to (was hard-coded to sonnet-5).",
  },
  {
    key: "agents",
    label: "Worker count",
    group: "Build",
    type: "number",
    default: 3,
    legacy: true,
    help: "Number of parallel worker agents.",
  },
  {
    key: "skills_hierarchical_threshold",
    label: "Skills hierarchical threshold",
    group: "Build",
    type: "number",
    default: 50,
    help:
      "Above this many skills, the loader switches to a hierarchical (grouped) index instead of a flat list.",
  },
  {
    key: "auto_loop",
    label: "Auto loop",
    group: "Orchestration",
    type: "boolean",
    default: false,
    legacy: true,
    help: "Keep driving sprints without pausing for review between them.",
  },
  {
    key: "decentralized_review",
    label: "Decentralized review",
    group: "Orchestration",
    type: "boolean",
    default: false,
    legacy: true,
    help: "Let workers review each other instead of a central review pass.",
  },
  {
    key: "auto_skill_enabled",
    label: "Auto-create skills",
    group: "Skills",
    type: "boolean",
    default: true,
    help:
      "When ON, every Claude Code session self-judges at the end of a task and auto-saves a reusable procedure as a skill (Hermes-style). The switch is the marked block in ~/.claude/CLAUDE.md — this toggle adds/removes it. Applies to ALL sessions, not just oracles.",
  },
];

const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((f) => [f.key, f]));

export type SettingEntry = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  help: string;
  options?: { value: string; label: string }[];
  legacy: boolean;
  value: string | number | boolean;
  known: boolean; // false = extra key found in the file but not in the schema
};

/** Read the raw config object. Missing/corrupt file → {}. */
export function readConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The model a newly-added Team Config member is pre-selected to. Configurable
 *  via the Settings page (default_member_model); falls back to DEFAULT_MODEL
 *  when unset or blank. Read by the Teams panel — this is what wires the knob to
 *  actual behaviour (unlike the removed build_model, which nothing consumed). */
export function getDefaultMemberModel(): string {
  const v = readConfig()["default_member_model"];
  return typeof v === "string" && v.trim() ? v : DEFAULT_MODEL;
}

// ── Claude REPL view mode ────────────────────────────────────────────────────
/** Which face Mission Control puts on a running Claude REPL.
 *  "chat"   — our transcript-backed webview (src/webview/mirror.ts)
 *  "native" — a VS Code terminal running `tmux attach` */
export type ClaudeViewMode = "chat" | "native";
export const CLAUDE_VIEW_MODE_KEY = "claude_view_mode";
export const DEFAULT_CLAUDE_VIEW_MODE: ClaudeViewMode = "chat";

/** TOTAL: any stored/hand-edited/absent value collapses to one of the two modes.
 *  Only the exact string "native" opts out — a typo degrades to the default
 *  rather than becoming a silent third state that no caller handles. */
export function normalizeClaudeViewMode(v: unknown): ClaudeViewMode {
  return v === "native" ? "native" : DEFAULT_CLAUDE_VIEW_MODE;
}

/** THE single answer to "which view?". Every REPL-opening path reads this one
 *  function (via webview/claudeView.ts) so the modes cannot drift apart. */
export function getClaudeViewMode(): ClaudeViewMode {
  return normalizeClaudeViewMode(readConfig()[CLAUDE_VIEW_MODE_KEY]);
}

/** The key whose select options come from the live model list, not the schema. */
const LIVE_MODEL_KEY = "default_member_model";

/** modelOptions — PURE: {value,label} rows for the model dropdown.
 *  ⛔ Why this is injected rather than fetched here: the served list arrives from an
 *  async `GET /v1/models` (teamsOps.availableModels), and settingsOps must stay
 *  sync + vscode-free + importable by bun test — and importing teamsOps would also
 *  couple the settings page to git/oracle-path code it has no business knowing.
 *  Caller passes what it already has; empty/absent falls back to the pinned subset. */
export function modelOptions(
  modelIds?: readonly string[],
): { value: string; label: string }[] {
  const ids = modelIds && modelIds.length ? modelIds : MODEL_ALIASES;
  return ids.map((m) => ({ value: m, label: m.replace(/^claude-/, "") }));
}

/** Schema-driven view: every known field (file value or default) plus any
 *  unknown keys still on disk, so the page shows the whole file.
 *  `modelIds` (optional) = the live served model list; when given, the
 *  "Default member model" dropdown shows it instead of the pinned subset, so this
 *  page and the Team Config per-member picker can no longer disagree. */
export function listSettings(modelIds?: readonly string[]): SettingEntry[] {
  const raw = readConfig();
  const entries: SettingEntry[] = SETTINGS_SCHEMA.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    type: f.type,
    help: f.help,
    options: f.key === LIVE_MODEL_KEY ? modelOptions(modelIds) : f.options,
    legacy: !!f.legacy,
    value: f.key in raw ? (raw[f.key] as string | number | boolean) : f.default,
    known: true,
  }));
  // auto_skill_enabled is not a config.json knob — its truth is the CLAUDE.md block.
  const autoSkill = entries.find((e) => e.key === "auto_skill_enabled");
  if (autoSkill) autoSkill.value = isAutoSkillEnabled();
  // orches cap knobs live in the orches sidecar (~/.claude/orches/settings.json),
  // not config.json — the bash side reads it directly. Show that file's truth.
  const testCap = entries.find((e) => e.key === "orches_test_cap");
  if (testCap) testCap.value = Number(readTestCapNumber());
  const testCapNoLimit = entries.find((e) => e.key === "orches_test_cap_nolimit");
  if (testCapNoLimit) testCapNoLimit.value = readTestCapNoLimit();
  // merge_mode's truth is the flat file the bash engine reads, not config.json —
  // show what the engine would actually obey. Absent file → config.json/default.
  const mergeMode = entries.find((e) => e.key === "merge_mode");
  const mergeOnDisk = readMergeModeFile();
  if (mergeMode && mergeOnDisk) mergeMode.value = mergeOnDisk;
  for (const k of Object.keys(raw)) {
    if (SCHEMA_BY_KEY.has(k)) continue;
    if (k.startsWith("search.")) continue; // owned by the Search/Oracle section, not a generic knob
    const v = raw[k];
    entries.push({
      key: k,
      label: k,
      group: "Other",
      type:
        typeof v === "boolean"
          ? "boolean"
          : typeof v === "number"
            ? "number"
            : "string",
      help: "Extra key found in config.json (not part of the known schema).",
      legacy: false,
      value: v as string | number | boolean,
      known: false,
    });
  }
  return entries;
}

/** Coerce+validate an incoming value against the known type, then persist it.
 *  Preserves every other key. Throws on an invalid number or bad select value. */
export function setSetting(
  key: string,
  value: string | number | boolean,
  modelIds?: readonly string[],
): SettingEntry[] {
  // auto_skill_enabled toggles the CLAUDE.md block, not a config.json value.
  if (key === "auto_skill_enabled") {
    setAutoSkillEnabled(value === true || value === "true");
    return listSettings(modelIds);
  }
  // orches cap knobs write the orches sidecar, not config.json. The number field
  // validates a positive integer (throw → UI error toast); the slide toggle sets
  // "loop until pass" without disturbing the number.
  if (key === "orches_test_cap") {
    writeTestCapNumber(value as string | number);
    return listSettings(modelIds);
  }
  if (key === "orches_test_cap_nolimit") {
    writeTestCapNoLimit(value === true || value === "true");
    return listSettings(modelIds);
  }

  const schema = SCHEMA_BY_KEY.get(key);
  const raw = readConfig();
  let next: string | number | boolean = value;

  if (schema) {
    if (schema.type === "boolean") {
      next = value === true || value === "true";
    } else if (schema.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      next = n;
    } else if (schema.type === "select") {
      // ⛔ the model dropdown's valid set is the LIVE list, not the schema's pinned
      //   subset — otherwise picking a newly-served model (claude-fable-5) throws
      //   "not a valid option" and the save silently fails in the UI.
      const allowed =
        key === LIVE_MODEL_KEY
          ? modelOptions(modelIds).map((o) => o.value)
          : (schema.options ?? []).map((o) => o.value);
      if (!allowed.includes(String(value)))
        throw new Error(`${key}: '${String(value)}' is not a valid option`);
      next = String(value);
    } else {
      next = String(value);
    }
  } else {
    // Unknown key already on disk — keep its existing JSON type.
    const cur = raw[key];
    if (typeof cur === "boolean") next = value === true || value === "true";
    else if (typeof cur === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      next = n;
    } else next = String(value);
  }

  // Mirror into the flat file orches-integrate.sh actually reads. Written AFTER
  // validation (so an invalid option never reaches disk) and BEFORE config.json,
  // because the file the engine obeys is the one that must not be missed.
  if (key === "merge_mode") writeMergeModeFile(String(next));

  raw[key] = next;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return listSettings(modelIds);
}
