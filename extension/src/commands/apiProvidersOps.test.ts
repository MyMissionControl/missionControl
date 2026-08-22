import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  MANAGED_ENV_KEYS,
  activateApiAccount,
  apiAccountSecret,
  clearApiRoute,
  deleteApiAccount,
  apiKeyEnvVar,
  isAnthropicHost,
  isSafeBaseUrl,
  isSafeId,
  listApiProviders,
  liveRoute,
  maskKey,
  saveApiAccount,
} from "./apiProvidersOps";

// CLAUDE_CONFIG_DIR redirects the vault AND the settings.json we write, so nothing
// here can touch the real ~/.claude (which holds the hooks + statusline).
let tmp: string;
const AT = "2026-08-20T00:00:00.000Z";

function settingsPath(): string {
  return path.join(tmp, "settings.json");
}
function writeSettings(obj: unknown): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
}
/** The shape of the real file: hooks + statusline + an unmanaged env var. */
function realisticSettings(): void {
  writeSettings({
    model: "opus",
    env: { ORACLE_EMBED_TIMEOUT_MS: "60000" },
    hooks: { PreToolUse: [{ matcher: "Bash" }] },
    statusLine: { type: "command", command: "node x.mjs" },
    permissions: { allow: ["Bash(ls:*)"] },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-apiprov-"));
  process.env.CLAUDE_CONFIG_DIR = tmp;
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const GLM = { apiKey: "zai-secret-key-1234", baseUrl: "https://api.z.ai/api/anthropic" };

describe("validation", () => {
  test("isSafeId: filename-safe names only, _index reserved", () => {
    expect(isSafeId("zai")).toBe(true);
    expect(isSafeId("work-2")).toBe(true);
    expect(isSafeId("_index")).toBe(false);
    expect(isSafeId("../etc")).toBe(false);
    expect(isSafeId("a/b")).toBe(false);
    expect(isSafeId("")).toBe(false);
    expect(isSafeId("x".repeat(61))).toBe(false);
  });

  test("isSafeBaseUrl: absolute http(s) only — a typo would leak every prompt", () => {
    expect(isSafeBaseUrl("https://api.z.ai/api/anthropic")).toBe(true);
    expect(isSafeBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isSafeBaseUrl("api.z.ai/api/anthropic")).toBe(false); // bare host
    expect(isSafeBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBaseUrl("")).toBe(false);
  });

  test("maskKey: keeps ends only, short keys reveal almost nothing", () => {
    expect(maskKey("zai-secret-key-1234")).toBe("zai-…1234");
    expect(maskKey("abc")).toBe("…bc");
    expect(maskKey("")).toBe("");
  });
});

describe("vault", () => {
  test("save then list: many providers, many accounts each, key never returned", () => {
    expect(saveApiAccount("zai", "work", GLM, AT).ok).toBe(true);
    expect(saveApiAccount("zai", "personal", { ...GLM, apiKey: "zai-other-9999" }, AT).ok).toBe(true);
    expect(
      saveApiAccount("minimax", "main", { apiKey: "mm-key-abcd", baseUrl: "https://api.minimax.io/anthropic" }, AT)
        .ok,
    ).toBe(true);

    const v = listApiProviders();
    expect(v.providers.map((p) => p.provider)).toEqual(["minimax", "zai"]);
    expect(v.providers[1].accounts.map((a) => a.label)).toEqual(["personal", "work"]);
    expect(v.providers[1].name).toBe("Z.AI (GLM)"); // preset display name
    // ไม่ใช่ preset (user พิมพ์ชื่อเอง) → โชว์ id ตรงๆ ไม่ต้องมีในลิสต์ก็ใช้ได้
    expect(v.providers[0].name).toBe("minimax");

    const flat = JSON.stringify(v);
    expect(flat).not.toContain("zai-secret-key-1234"); // ⛔ no raw key toward a webview
    expect(flat).not.toContain("zai-other-9999");
    expect(flat).not.toContain("mm-key-abcd");
    expect(v.providers[1].accounts[1].keyMask).toBe("zai-…1234");
  });

  test("save: rejects a bad key, base URL, or name without writing anything", () => {
    expect(saveApiAccount("zai", "work", { ...GLM, apiKey: "  " }, AT).ok).toBe(false);
    expect(saveApiAccount("zai", "work", { ...GLM, baseUrl: "nope" }, AT).ok).toBe(false);
    expect(saveApiAccount("../esc", "work", GLM, AT).ok).toBe(false);
    expect(saveApiAccount("zai", "_index", GLM, AT).ok).toBe(false);
    expect(listApiProviders().providers).toEqual([]);
  });

  test("account files are 0600 and the vault dir 0700 (they hold live keys)", () => {
    saveApiAccount("zai", "work", GLM, AT);
    const f = path.join(tmp, ".mc-api-providers", "zai", "work.json");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(tmp, ".mc-api-providers")).mode & 0o777).toBe(0o700);
  });

  test("a half-written account (no key or no URL) is not offered", () => {
    const dir = path.join(tmp, ".mc-api-providers", "zai");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ baseUrl: GLM.baseUrl }));
    expect(listApiProviders().providers).toEqual([]);
  });

  test("apiAccountSecret is the host-only path that does return the key", () => {
    saveApiAccount("zai", "work", GLM, AT);
    expect(apiAccountSecret("zai", "work")?.apiKey).toBe(GLM.apiKey);
    expect(apiAccountSecret("zai", "missing")).toBeNull();
    expect(apiAccountSecret("../x", "work")).toBeNull();
  });
});

describe("activate / clear", () => {
  test("activate writes the managed env and PRESERVES hooks, statusline, other env", () => {
    realisticSettings();
    saveApiAccount("zai", "work", { ...GLM, model: "glm-5.1", smallFastModel: "glm-5.1-air" }, AT);
    expect(activateApiAccount("zai", "work").ok).toBe(true);

    const s = readSettings();
    expect(s.hooks).toEqual({ PreToolUse: [{ matcher: "Bash" }] }); // ⛔ the whole point
    expect(s.statusLine).toEqual({ type: "command", command: "node x.mjs" });
    expect(s.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(s.model).toBe("opus");
    const env = s.env as Record<string, string>;
    expect(env.ORACLE_EMBED_TIMEOUT_MS).toBe("60000"); // unmanaged env survives
    expect(env.ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GLM.apiKey);
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.1");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("glm-5.1-air");
  });

  test("activate backs settings.json up first", () => {
    realisticSettings();
    const before = fs.readFileSync(settingsPath(), "utf8");
    saveApiAccount("zai", "work", GLM, AT);
    activateApiAccount("zai", "work");
    expect(fs.readFileSync(settingsPath() + ".mc-bak", "utf8")).toBe(before);
  });

  test("switching accounts leaves NO stale managed key behind", () => {
    realisticSettings();
    saveApiAccount("zai", "work", { ...GLM, model: "glm-5.1", smallFastModel: "glm-air" }, AT);
    activateApiAccount("zai", "work");
    // the next provider sets no model at all — the previous one must not linger
    saveApiAccount("minimax", "main", { apiKey: "mm-key", baseUrl: "https://api.minimax.io/anthropic" }, AT);
    expect(activateApiAccount("minimax", "main").ok).toBe(true);

    const env = readSettings().env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimax.io/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("mm-key");
    expect("ANTHROPIC_MODEL" in env).toBe(false);
    expect("ANTHROPIC_SMALL_FAST_MODEL" in env).toBe(false);
    expect(listApiProviders().active).toEqual({ provider: "minimax", label: "main" });
  });

  test("clear removes every managed key and nothing else", () => {
    realisticSettings();
    saveApiAccount("zai", "work", { ...GLM, model: "glm-5.1" }, AT);
    activateApiAccount("zai", "work");
    expect(clearApiRoute().ok).toBe(true);

    const s = readSettings();
    const env = s.env as Record<string, string>;
    expect(env).toEqual({ ORACLE_EMBED_TIMEOUT_MS: "60000" });
    for (const k of MANAGED_ENV_KEYS) expect(k in env).toBe(false);
    expect(s.hooks).toBeDefined();
    expect(listApiProviders().active).toBeNull();
    expect(liveRoute()).toBeNull(); // back to native Anthropic
  });

  test("clear drops the env key entirely when nothing unmanaged is left", () => {
    writeSettings({ model: "opus" });
    saveApiAccount("zai", "work", GLM, AT);
    activateApiAccount("zai", "work");
    clearApiRoute();
    expect("env" in readSettings()).toBe(false);
  });

  test("⛔ refuses to write when settings.json is not a JSON object", () => {
    fs.writeFileSync(settingsPath(), "{ this is not json");
    saveApiAccount("zai", "work", GLM, AT);
    const res = activateApiAccount("zai", "work");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("settings.json");
    expect(fs.readFileSync(settingsPath(), "utf8")).toBe("{ this is not json"); // untouched
    expect(listApiProviders().settingsReadable).toBe(false);
  });

  test("a missing settings.json is created, not treated as an error", () => {
    saveApiAccount("zai", "work", GLM, AT);
    expect(activateApiAccount("zai", "work").ok).toBe(true);
    expect((readSettings().env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(GLM.baseUrl);
    expect(fs.existsSync(settingsPath() + ".mc-bak")).toBe(false); // nothing to back up
  });

  test("activate refuses an account that does not exist", () => {
    expect(activateApiAccount("zai", "ghost").ok).toBe(false);
  });
});

describe("liveRoute", () => {
  test("reads back what settings.json actually routes to, masked", () => {
    realisticSettings();
    saveApiAccount("zai", "work", { ...GLM, model: "glm-5.1" }, AT);
    activateApiAccount("zai", "work");
    expect(liveRoute()).toEqual({
      baseUrl: GLM.baseUrl,
      model: "glm-5.1",
      keyMask: "zai-…1234",
    });
  });

  test("sees a hand-edited settings.json the vault knows nothing about", () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: "https://elsewhere.example/anthropic" } });
    expect(liveRoute()?.baseUrl).toBe("https://elsewhere.example/anthropic");
    expect(listApiProviders().active).toBeNull(); // vault never activated anything
  });

  test("native Anthropic = null, not an empty route", () => {
    realisticSettings();
    expect(liveRoute()).toBeNull();
  });
});

describe("delete", () => {
  test("deleting the ACTIVE account also clears the route (no dangling key)", () => {
    realisticSettings();
    saveApiAccount("zai", "work", GLM, AT);
    activateApiAccount("zai", "work");
    expect(deleteApiAccount("zai", "work").ok).toBe(true);

    expect(liveRoute()).toBeNull();
    expect(listApiProviders().active).toBeNull();
    expect(listApiProviders().providers).toEqual([]);
    expect((readSettings().env as Record<string, string>).ORACLE_EMBED_TIMEOUT_MS).toBe("60000");
  });

  test("deleting an inactive account leaves the active route alone", () => {
    realisticSettings();
    saveApiAccount("zai", "work", GLM, AT);
    saveApiAccount("zai", "spare", { ...GLM, apiKey: "zai-spare-0000" }, AT);
    activateApiAccount("zai", "work");
    expect(deleteApiAccount("zai", "spare").ok).toBe(true);
    expect(liveRoute()?.keyMask).toBe("zai-…1234");
    expect(listApiProviders().active).toEqual({ provider: "zai", label: "work" });
  });

  test("deleting a missing account is not an error, and bad names are refused", () => {
    expect(deleteApiAccount("zai", "ghost").ok).toBe(true);
    expect(deleteApiAccount("../x", "y").ok).toBe(false);
  });
});

describe("which env var carries the key", () => {
  // ⛔ วัดสด 2026-08-21 (claude 2.1.237 + base URL ปลอม): ทั้งสองตัวแปรออกมาเป็น
  //   `Authorization: Bearer <key>` และไม่มี x-api-key ⇒ เกณฑ์นี้คือ "ใช้ตัวแปรที่เจ้านั้น
  //   เอกสารตัวเองบอก" ไม่ใช่การเดา header
  test("Anthropic's own host gets ANTHROPIC_API_KEY, gateways get ANTHROPIC_AUTH_TOKEN", () => {
    expect(apiKeyEnvVar("https://api.anthropic.com")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyEnvVar("https://api.z.ai/api/anthropic")).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(apiKeyEnvVar("")).toBe("ANTHROPIC_AUTH_TOKEN");
  });

  test("host match is parsed, never a substring — a look-alike host is NOT Anthropic", () => {
    expect(isAnthropicHost("https://api.anthropic.com/v1")).toBe(true);
    expect(isAnthropicHost("https://API.Anthropic.COM")).toBe(true);
    expect(isAnthropicHost("https://api.anthropic.com.evil.test")).toBe(false); // ⛔ suffix trick
    expect(isAnthropicHost("https://api.z.ai/api/anthropic")).toBe(false); // path, not host
    expect(isAnthropicHost("not a url")).toBe(false);
  });

  test("activating an Anthropic account writes API_KEY and leaves NO AUTH_TOKEN behind", () => {
    realisticSettings();
    saveApiAccount("zai", "work", GLM, AT);
    activateApiAccount("zai", "work"); // gateway first: sets ANTHROPIC_AUTH_TOKEN
    saveApiAccount("anthropic", "work", { apiKey: "sk-ant-xyz", baseUrl: "https://api.anthropic.com" }, AT);
    expect(activateApiAccount("anthropic", "work").ok).toBe(true);
    const env = readSettings().env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined(); // ⛔ half-routed machine otherwise
    expect(env.ORACLE_EMBED_TIMEOUT_MS).toBe("60000");
  });
});
