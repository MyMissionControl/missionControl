import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isAutoSkillEnabled, setAutoSkillEnabled } from "./autoSkillOps";
import {
  readTestCapNoLimit,
  readTestCapNumber,
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
    key: "default_member_model",
    label: "Default member model",
    group: "Teams",
    type: "select",
    default: DEFAULT_MODEL,
    // Pinned subset only (teamsModel.MODEL_ALIASES), shown without the "claude-"
    // prefix like the Team Config dropdown does.
    // ⚠️ NOT a full mirror of that dropdown any more: Team Config merges the live
    // `GET /v1/models` list on top of these (teamsOps.availableModels), which this
    // SCHEMA can't do — it's a static module-level array and the fetch is async.
    // So a brand-new model shows up per-member before it shows up as the default.
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

/** Schema-driven view: every known field (file value or default) plus any
 *  unknown keys still on disk, so the page shows the whole file. */
export function listSettings(): SettingEntry[] {
  const raw = readConfig();
  const entries: SettingEntry[] = SETTINGS_SCHEMA.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    type: f.type,
    help: f.help,
    options: f.options,
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
): SettingEntry[] {
  // auto_skill_enabled toggles the CLAUDE.md block, not a config.json value.
  if (key === "auto_skill_enabled") {
    setAutoSkillEnabled(value === true || value === "true");
    return listSettings();
  }
  // orches cap knobs write the orches sidecar, not config.json. The number field
  // validates a positive integer (throw → UI error toast); the slide toggle sets
  // "loop until pass" without disturbing the number.
  if (key === "orches_test_cap") {
    writeTestCapNumber(value as string | number);
    return listSettings();
  }
  if (key === "orches_test_cap_nolimit") {
    writeTestCapNoLimit(value === true || value === "true");
    return listSettings();
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
      const ok = (schema.options ?? []).some((o) => o.value === value);
      if (!ok) throw new Error(`${key}: '${String(value)}' is not a valid option`);
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

  raw[key] = next;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return listSettings();
}
