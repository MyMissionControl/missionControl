import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CLAUDE_VIEW_MODE_KEY,
  DEFAULT_CLAUDE_VIEW_MODE,
  getClaudeViewMode,
  getDefaultMemberModel,
  listSettings,
  modelOptions,
  normalizeClaudeViewMode,
  readConfig,
  SETTINGS_SCHEMA,
  setSetting,
} from "./settingsOps";
import { DEFAULT_MODEL, MODEL_ALIASES } from "./teamsModel";

// Point MC_CONFIG_PATH at a throwaway file so nothing touches the real
// ~/.mission-control/config.json.
let tmp: string;
let cfgPath: string;

function writeCfg(obj: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-settings-"));
  cfgPath = path.join(tmp, "config.json");
  process.env.MC_CONFIG_PATH = cfgPath;
});

afterEach(() => {
  delete process.env.MC_CONFIG_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("listSettings", () => {
  test("missing file → known keys fall back to defaults", () => {
    const s = listSettings();
    const merge = s.find((e) => e.key === "merge_mode");
    expect(merge?.value).toBe("online"); // the remembered default
    expect(merge?.known).toBe(true);
    // every schema field is present even with no file
    expect(s.some((e) => e.key === "default_member_model")).toBe(true);
    // the removed dead knob must not resurface
    expect(s.some((e) => e.key === "build_model")).toBe(false);
    // default_member_model falls back to the shared DEFAULT_MODEL constant
    expect(s.find((e) => e.key === "default_member_model")?.value).toBe(
      DEFAULT_MODEL,
    );
  });

  test("file value overrides the default", () => {
    writeCfg({ merge_mode: "local", default_member_model: "claude-opus-4-8" });
    const s = listSettings();
    expect(s.find((e) => e.key === "merge_mode")?.value).toBe("local");
    expect(s.find((e) => e.key === "default_member_model")?.value).toBe(
      "claude-opus-4-8",
    );
  });

  test("unknown on-disk key surfaces under Other, typed from its value", () => {
    writeCfg({ mystery: 42, flag: true });
    const s = listSettings();
    const mystery = s.find((e) => e.key === "mystery");
    expect(mystery?.group).toBe("Other");
    expect(mystery?.known).toBe(false);
    expect(mystery?.type).toBe("number");
    expect(s.find((e) => e.key === "flag")?.type).toBe("boolean");
  });

  test("search.* intent keys do not leak into the generic settings list", () => {
    writeCfg({ "search.hybrid_enabled": true, "search.mode": "graph", mystery: 42 });
    const s = listSettings();
    expect(s.some((e) => e.key === "search.hybrid_enabled")).toBe(false);
    expect(s.some((e) => e.key === "search.mode")).toBe(false);
    expect(s.find((e) => e.key === "mystery")?.group).toBe("Other"); // genuine unknown key still shows
  });
});

describe("setSetting", () => {
  test("select persists and preserves other keys", () => {
    writeCfg({ agents: 3 });
    setSetting("merge_mode", "local");
    const raw = readConfig();
    expect(raw.merge_mode).toBe("local");
    expect(raw.agents).toBe(3); // untouched
  });

  test("rejects an invalid select option", () => {
    expect(() => setSetting("merge_mode", "sideways")).toThrow();
  });

  test("boolean coerces from string 'true'/'false'", () => {
    setSetting("auto_loop", "true");
    expect(readConfig().auto_loop).toBe(true);
    setSetting("auto_loop", "false");
    expect(readConfig().auto_loop).toBe(false);
  });

  test("number rejects non-numeric input", () => {
    expect(() => setSetting("agents", "lots")).toThrow();
    setSetting("agents", "5");
    expect(readConfig().agents).toBe(5);
  });

  test("writes a fresh file (with dir) when none exists", () => {
    const deep = path.join(tmp, "nested", "config.json");
    process.env.MC_CONFIG_PATH = deep;
    setSetting("merge_mode", "online");
    expect(JSON.parse(fs.readFileSync(deep, "utf8")).merge_mode).toBe("online");
  });

  test("default_member_model accepts a known model, rejects a bogus one", () => {
    setSetting("default_member_model", "claude-opus-4-8");
    expect(readConfig().default_member_model).toBe("claude-opus-4-8");
    expect(() => setSetting("default_member_model", "gpt-9")).toThrow();
  });
});

describe("getDefaultMemberModel", () => {
  test("falls back to DEFAULT_MODEL when unset or blank", () => {
    expect(getDefaultMemberModel()).toBe(DEFAULT_MODEL); // no file
    writeCfg({ default_member_model: "   " });
    expect(getDefaultMemberModel()).toBe(DEFAULT_MODEL);
  });

  test("returns the configured model when set", () => {
    writeCfg({ default_member_model: "claude-haiku-4-5" });
    expect(getDefaultMemberModel()).toBe("claude-haiku-4-5");
  });
});

describe("orches_test_cap special-case (orches sidecar, not config.json)", () => {
  let settingsPath: string;
  beforeEach(() => {
    settingsPath = path.join(tmp, "orches-settings.json");
    process.env.ORCHES_SETTINGS = settingsPath;
  });
  afterEach(() => {
    delete process.env.ORCHES_SETTINGS;
  });

  test("number field + slide toggle listed under Orchestration with defaults", () => {
    const num = listSettings().find((x) => x.key === "orches_test_cap");
    expect(num?.group).toBe("Orchestration");
    expect(num?.type).toBe("number");
    expect(num?.value).toBe(10);
    const tog = listSettings().find((x) => x.key === "orches_test_cap_nolimit");
    expect(tog?.type).toBe("boolean"); // renders as the slide switch
    expect(tog?.value).toBe(false);
  });

  test("number writes the sidecar (not config.json) and reads back", () => {
    setSetting("orches_test_cap", "20");
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).testCap).toBe(20);
    expect("orches_test_cap" in readConfig()).toBe(false); // special-cased away
    expect(listSettings().find((x) => x.key === "orches_test_cap")?.value).toBe(20);
    expect(() => setSetting("orches_test_cap", "nope")).toThrow();
  });

  test("slide toggle sets no-limit without disturbing the number", () => {
    setSetting("orches_test_cap", "20");
    setSetting("orches_test_cap_nolimit", true);
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(raw.testCapNoLimit).toBe(true);
    expect(raw.testCap).toBe(20); // number preserved
    expect(
      listSettings().find((x) => x.key === "orches_test_cap_nolimit")?.value,
    ).toBe(true);
  });
});

// ── live model list injection (2026-07-29) ────────────────────────────────────
// The Settings dropdown used to render the pinned MODEL_ALIASES only, while Team
// Config merged the live GET /v1/models list — so the two pages disagreed and a
// newly-served model (claude-fable-5) could not be chosen as the default at all.
const LIVE = ["claude-opus-5", "claude-fable-5", "claude-sonnet-5"];
const modelField = (ids?: readonly string[]) =>
  listSettings(ids).find((e) => e.key === "default_member_model");

describe("Settings: live model list", () => {
  test("no ids passed → pinned subset (the instant paint, unchanged behaviour)", () => {
    expect(modelField()?.options?.map((o) => o.value)).toEqual([...MODEL_ALIASES]);
  });

  test("ids passed → dropdown shows the served list instead", () => {
    expect(modelField(LIVE)?.options?.map((o) => o.value)).toEqual(LIVE);
  });

  test("empty served list falls back to pinned (never renders an empty dropdown)", () => {
    expect(modelField([])?.options?.map((o) => o.value)).toEqual([...MODEL_ALIASES]);
  });

  test("labels stay stripped of the claude- prefix in both modes", () => {
    expect(modelField(LIVE)?.options?.map((o) => o.label)).toEqual([
      "opus-5",
      "fable-5",
      "sonnet-5",
    ]);
  });

  test("modelOptions is pure and mirrors that fallback rule", () => {
    expect(modelOptions([]).length).toBe(MODEL_ALIASES.length);
    expect(modelOptions(["claude-x"])).toEqual([{ value: "claude-x", label: "x" }]);
  });

  test("setSetting ACCEPTS a live-only model when the list is supplied", () => {
    setSetting("default_member_model", "claude-fable-5", LIVE);
    expect(getDefaultMemberModel()).toBe("claude-fable-5");
  });

  test("setSetting still REJECTS a model nobody serves", () => {
    expect(() => setSetting("default_member_model", "claude-made-up", LIVE)).toThrow();
  });

  test("without the list, a live-only model is rejected — the bug this fixes", () => {
    expect(() => setSetting("default_member_model", "claude-fable-5")).toThrow();
  });

  test("setSetting echoes back the ENRICHED options, not the pinned ones", () => {
    const out = setSetting("default_member_model", "claude-opus-5", LIVE);
    const f = out.find((e) => e.key === "default_member_model");
    expect(f?.options?.map((o) => o.value)).toEqual(LIVE);
  });

  test("other select keys are untouched by the injection", () => {
    const merge = listSettings(LIVE).find((e) => e.key === "merge_mode");
    expect(merge?.options?.map((o) => o.value)).toEqual(["online", "local"]);
    expect(() => setSetting("merge_mode", "claude-fable-5", LIVE)).toThrow();
  });
});

describe("claude_view_mode (which face the Claude REPL gets)", () => {
  test("no config file → chat, the user-requested default", () => {
    const f = listSettings().find((e) => e.key === CLAUDE_VIEW_MODE_KEY);
    expect(f?.value).toBe("chat");
    expect(f?.known).toBe(true);
    expect(f?.type).toBe("select");
    expect(f?.options?.map((o) => o.value)).toEqual(["chat", "native"]);
    expect(getClaudeViewMode()).toBe("chat");
  });

  test("a stored value wins over the default", () => {
    writeCfg({ [CLAUDE_VIEW_MODE_KEY]: "native" });
    expect(listSettings().find((e) => e.key === CLAUDE_VIEW_MODE_KEY)?.value).toBe("native");
    expect(getClaudeViewMode()).toBe("native");
  });

  test("setSetting persists the choice and leaves other keys alone", () => {
    writeCfg({ agents: 3 });
    setSetting(CLAUDE_VIEW_MODE_KEY, "native");
    expect(readConfig()[CLAUDE_VIEW_MODE_KEY]).toBe("native");
    expect(readConfig().agents).toBe(3);
    expect(getClaudeViewMode()).toBe("native");
  });

  test("setSetting rejects anything outside the two options", () => {
    expect(() => setSetting(CLAUDE_VIEW_MODE_KEY, "mirror")).toThrow();
    expect(() => setSetting(CLAUDE_VIEW_MODE_KEY, "terminal")).toThrow();
    expect(() => setSetting(CLAUDE_VIEW_MODE_KEY, "")).toThrow();
  });

  // A hand-edited / stale file must degrade to the default, never become a third
  // state: every caller branches chat-vs-native and nothing handles "mirror".
  test("a junk stored value degrades to chat rather than becoming a third state", () => {
    for (const junk of ["mirror", "Native", "NATIVE", "", 0, null, [], {}]) {
      writeCfg({ [CLAUDE_VIEW_MODE_KEY]: junk as unknown });
      expect(getClaudeViewMode()).toBe("chat");
    }
  });

  test("normalizeClaudeViewMode is total — only exact 'native' opts out", () => {
    expect(normalizeClaudeViewMode("native")).toBe("native");
    for (const v of ["chat", "Native", "NATIVE", " native", "mirror", "", null, undefined, 0, {}, []]) {
      expect(normalizeClaudeViewMode(v as unknown)).toBe("chat");
    }
  });

  test("the schema default and the accessor default cannot drift apart", () => {
    const schema = SETTINGS_SCHEMA.find((f) => f.key === CLAUDE_VIEW_MODE_KEY);
    expect(schema?.default).toBe(DEFAULT_CLAUDE_VIEW_MODE);
    // every offered option must survive normalization unchanged
    for (const o of schema?.options ?? []) {
      expect(normalizeClaudeViewMode(o.value)).toBe(o.value);
    }
  });
});
