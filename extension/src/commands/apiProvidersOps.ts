// API-key providers for the Connections panel. NO vscode import here so the vault
// + settings-merge logic can be unit-tested standalone with `bun test`.
//
// This is the OTHER half of "switch provider / switch account", and it works by a
// different mechanism than accountsOps.ts:
//
//   accountsOps.ts     subscription logins  -> swap a credentials FILE
//   apiProvidersOps.ts API-key endpoints    -> write the `env` block of settings.json
//
// Claude Code reads `env` out of ~/.claude/settings.json and exports it for every
// run, so pointing ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN at an
// Anthropic-compatible endpoint (z.ai/GLM, MiniMax, …) routes the whole machine to
// that provider. Only NEWLY-started processes pick it up, same as a credential swap.
//
// ⛔⛔ Why this is deliberately NOT delegated to a third-party switcher (ccs and
//    friends), decided 2026-08-20 after reading their source: their account mode
//    switches by injecting CLAUDE_CONFIG_DIR, which relocates ~/.claude/projects and
//    blinds Mirror/statusline/budget; and adopting the CLI means owning its contract
//    (1,064 published versions, 33 in the last 30 days). The mechanism itself — these
//    env vars and that credentials file — is Claude Code's own, so there is nothing to
//    buy. Keep this module dependency-free.
//
// SECURITY: an account file holds a live API key. Vault dir 0700, files 0600, and NO
// key value is ever returned to a webview — only a mask (see maskKey).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Env keys this module OWNS: they are rewritten on activate and deleted on clear.
 *  Everything else in `env` (ORACLE_*, anything the user put there) is preserved.
 *  ⛔ Never add a key here that we do not also set — a stale key would silently
 *  survive a provider switch and half-route the machine. */
export const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

/** Starter list for the "add" form. Only endpoints whose Anthropic-compatible URL is
 *  confirmed get a prefilled `baseUrl`; the rest are named shells the user completes,
 *  because a wrong base URL silently breaks every claude on the machine.
 *  A provider does NOT have to be in here — any id the user types is valid. */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string; // "" = user must paste it
  note: string;
}
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic (API key)",
    baseUrl: "https://api.anthropic.com",
    note: "เลือกว่าจะให้ token ลง key ไหน — endpoint เดิม ไม่ได้เปลี่ยนโมเดล",
  },
  {
    id: "zai",
    name: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/anthropic",
    note: "GLM coding plan — endpoint พูดภาษา Anthropic ตรงๆ",
  },
  { id: "custom", name: "อื่นๆ (กรอก base URL เอง)", baseUrl: "", note: "endpoint ต้องรับ /v1/messages แบบ Anthropic" },
];

// Honor CLAUDE_CONFIG_DIR so tests can point everything at a temp dir, and so the
// vault always sits next to the settings.json we actually write.
function claudeDir(): string {
  const e = process.env.CLAUDE_CONFIG_DIR;
  return e && e.trim() ? e.trim() : path.join(os.homedir(), ".claude");
}
export function settingsFile(): string {
  return path.join(claudeDir(), "settings.json");
}
function settingsBackupFile(): string {
  return settingsFile() + ".mc-bak";
}
function vaultDir(): string {
  return path.join(claudeDir(), ".mc-api-providers");
}
function providerDir(provider: string): string {
  return path.join(vaultDir(), provider);
}
function acctFile(provider: string, label: string): string {
  return path.join(providerDir(provider), label + ".json");
}
function indexFile(): string {
  return path.join(vaultDir(), "_index.json");
}

const ID_RE = /^[A-Za-z0-9._-]+$/;
/** Safe as a directory/file name and as an index key. `_index` is reserved so a
 *  provider or label can never collide with the index file. */
export function isSafeId(v: unknown): v is string {
  return (
    typeof v === "string" && v.length > 0 && v.length <= 60 && v !== "_index" && ID_RE.test(v)
  );
}

/** Only http(s) absolute URLs, and never a bare host: a typo that resolves to
 *  something unexpected would send every prompt (and the key) to it. */
export function isSafeBaseUrl(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim()) return false;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return false;
  }
  return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
}

/** Never return a raw key to a webview. Keeps enough tail to tell two keys apart. */
export function maskKey(key: string): string {
  const k = String(key ?? "");
  if (!k) return "";
  if (k.length <= 8) return "…" + k.slice(-2);
  return k.slice(0, 4) + "…" + k.slice(-4);
}

export interface ApiAccountInput {
  apiKey: string;
  baseUrl: string;
  model?: string; // "" = let the endpoint pick its default
  smallFastModel?: string; // the cheap model Claude Code uses for side tasks
}
/** One saved API-key account. NEVER carries the key itself. */
export interface ApiAccountMeta {
  provider: string;
  label: string;
  baseUrl: string;
  model: string;
  smallFastModel: string;
  keyMask: string;
  savedAt: string; // ISO 8601, "" if unknown
}
export interface ApiProviderState {
  provider: string;
  name: string; // preset display name, or the id itself for a custom provider
  accounts: ApiAccountMeta[];
}
/** What settings.json ACTUALLY routes to right now — the source of truth, which can
 *  disagree with the vault's `active` (someone edited settings.json by hand). */
export interface LiveRoute {
  baseUrl: string;
  model: string;
  keyMask: string;
}
export interface ApiProvidersView {
  providers: ApiProviderState[];
  active: { provider: string; label: string } | null; // what WE last activated
  live: LiveRoute | null; // null = native Anthropic (no managed keys present)
  settingsReadable: boolean; // false = settings.json unparseable; every write refuses
}
export interface OpResult {
  ok: boolean;
  error?: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort; a shared FS may not honor chmod */
  }
}
function writeSecure(file: string, data: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

interface IndexFile {
  active: { provider: string; label: string } | null;
}
function readIndex(): IndexFile {
  const j = readJson(indexFile());
  const a = j?.active;
  if (a && typeof a === "object") {
    const rec = a as Record<string, unknown>;
    if (isSafeId(rec.provider) && isSafeId(rec.label)) {
      return { active: { provider: rec.provider, label: rec.label } };
    }
  }
  return { active: null };
}
function writeIndex(idx: IndexFile): void {
  writeSecure(indexFile(), JSON.stringify(idx, null, 2));
}

function presetOf(provider: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === provider);
}
function displayName(provider: string): string {
  const p = presetOf(provider);
  return p && p.id !== "custom" ? p.name : provider;
}

// ---- settings.json -------------------------------------------------------------

/** Read settings.json for editing. `null` means "exists but is not a JSON object" —
 *  that is a REFUSAL condition, never a reason to start from {}: this file carries
 *  the hooks, statusLine and permissions, and rewriting it from scratch would wipe
 *  them. A missing file is fine and starts empty. */
function readSettingsForEdit(): { settings: Record<string, unknown> | null; missing: boolean } {
  const file = settingsFile();
  if (!fs.existsSync(file)) return { settings: {}, missing: true };
  const j = readJson(file);
  return { settings: j, missing: false };
}

function envOf(settings: Record<string, unknown>): Record<string, string> {
  const e = settings.env;
  if (!e || typeof e !== "object" || Array.isArray(e)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Merge a managed env patch into settings.json, preserving every other key and
 *  every unmanaged env var. Backs the file up first. `patch` values of undefined
 *  delete that managed key. */
function writeManagedEnv(patch: Record<string, string | undefined>): OpResult {
  const { settings, missing } = readSettingsForEdit();
  if (!settings) {
    return {
      ok: false,
      error: "อ่าน settings.json ไม่ออก (ไม่ใช่ JSON object) — ไม่แก้ไฟล์นี้จนกว่าจะซ่อมด้วยมือ",
    };
  }
  const env = envOf(settings);
  for (const k of MANAGED_ENV_KEYS) delete env[k];
  for (const [k, v] of Object.entries(patch)) if (typeof v === "string" && v) env[k] = v;

  if (!missing) {
    try {
      fs.copyFileSync(settingsFile(), settingsBackupFile());
      try {
        fs.chmodSync(settingsBackupFile(), 0o600);
      } catch {
        /* best-effort */
      }
    } catch (e) {
      // No backup = no write. Losing this file costs the hooks and the statusline.
      return { ok: false, error: "สำรอง settings.json ไม่สำเร็จ: " + String((e as Error)?.message ?? e) };
    }
  }
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(env).length) next.env = env;
  else delete next.env;
  try {
    ensureDir(path.dirname(settingsFile()));
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
  return { ok: true };
}

/** What the machine is routed to right now, read back from settings.json. */
export function liveRoute(): LiveRoute | null {
  const j = readJson(settingsFile());
  if (!j) return null;
  const env = envOf(j);
  const baseUrl = env.ANTHROPIC_BASE_URL ?? "";
  const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  if (!baseUrl && !token) return null; // native Anthropic
  return { baseUrl, model: env.ANTHROPIC_MODEL ?? "", keyMask: maskKey(token) };
}

// ---- queries -------------------------------------------------------------------

function listProviderAccounts(provider: string): ApiAccountMeta[] {
  const out: ApiAccountMeta[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(providerDir(provider));
  } catch {
    return out; // provider has no dir yet
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const label = f.slice(0, -".json".length);
    if (!isSafeId(label)) continue;
    const full = path.join(providerDir(provider), f);
    const j = readJson(full);
    const key = typeof j?.apiKey === "string" ? j.apiKey : "";
    const baseUrl = typeof j?.baseUrl === "string" ? j.baseUrl : "";
    if (!key || !baseUrl) continue; // half-written file: not usable, do not offer it
    let savedAt = typeof j?.savedAt === "string" ? j.savedAt : "";
    if (!savedAt) {
      try {
        savedAt = fs.statSync(full).mtime.toISOString();
      } catch {
        savedAt = "";
      }
    }
    out.push({
      provider,
      label,
      baseUrl,
      model: typeof j?.model === "string" ? j.model : "",
      smallFastModel: typeof j?.smallFastModel === "string" ? j.smallFastModel : "",
      keyMask: maskKey(key),
      savedAt,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Every saved provider + its accounts, plus what settings.json actually routes to.
 *  Never returns an API key. Providers come from the vault (what the user really
 *  added), not from PROVIDER_PRESETS — presets are only a form helper. */
export function listApiProviders(): ApiProvidersView {
  ensureDir(vaultDir());
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(vaultDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeId(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    dirs = [];
  }
  const providers = dirs
    .map((provider) => ({
      provider,
      name: displayName(provider),
      accounts: listProviderAccounts(provider),
    }))
    .filter((p) => p.accounts.length > 0);
  const { settings } = readSettingsForEdit();
  return {
    providers,
    active: readIndex().active,
    live: liveRoute(),
    settingsReadable: settings !== null,
  };
}

/** HOST-ONLY: the raw key of a saved account (for a connection test). Never post
 *  the result to a webview. */
export function apiAccountSecret(
  provider: string,
  label: string,
): { apiKey: string; baseUrl: string; model: string } | null {
  if (!isSafeId(provider) || !isSafeId(label)) return null;
  const j = readJson(acctFile(provider, label));
  const apiKey = typeof j?.apiKey === "string" ? j.apiKey : "";
  const baseUrl = typeof j?.baseUrl === "string" ? j.baseUrl : "";
  if (!apiKey || !baseUrl) return null;
  return { apiKey, baseUrl, model: typeof j?.model === "string" ? j.model : "" };
}

// ---- mutations -----------------------------------------------------------------

/** Add or overwrite one account under a provider. Does NOT activate it: saving a key
 *  and re-routing the whole machine are separate decisions. */
export function saveApiAccount(
  provider: string,
  label: string,
  input: ApiAccountInput,
  at: string,
): OpResult {
  if (!isSafeId(provider)) return { ok: false, error: "ชื่อ provider ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)" };
  if (!isSafeId(label)) return { ok: false, error: "ชื่อ account ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)" };
  const apiKey = String(input?.apiKey ?? "").trim();
  if (!apiKey) return { ok: false, error: "ยังไม่ได้กรอก API key" };
  const baseUrl = String(input?.baseUrl ?? "").trim();
  if (!isSafeBaseUrl(baseUrl)) return { ok: false, error: "base URL ต้องเป็น http(s) เต็มรูปแบบ" };
  writeSecure(
    acctFile(provider, label),
    JSON.stringify(
      {
        apiKey,
        baseUrl,
        model: String(input?.model ?? "").trim(),
        smallFastModel: String(input?.smallFastModel ?? "").trim(),
        savedAt: at,
      },
      null,
      2,
    ),
  );
  return { ok: true };
}

/** Route the machine at this account by writing the managed env keys. Affects only
 *  NEWLY-started claude processes. */
export function activateApiAccount(provider: string, label: string): OpResult {
  const secret = apiAccountSecret(provider, label);
  if (!secret) {
    return { ok: false, error: `account '${label}' ไม่มี key/base URL ที่ใช้ได้ — แก้แล้วบันทึกใหม่` };
  }
  const j = readJson(acctFile(provider, label)) ?? {};
  const small = typeof j.smallFastModel === "string" ? j.smallFastModel : "";
  const res = writeManagedEnv({
    ANTHROPIC_BASE_URL: secret.baseUrl,
    ANTHROPIC_AUTH_TOKEN: secret.apiKey,
    ANTHROPIC_MODEL: secret.model || undefined,
    ANTHROPIC_SMALL_FAST_MODEL: small || undefined,
  });
  if (!res.ok) return res;
  writeIndex({ active: { provider, label } });
  return { ok: true };
}

/** Back to native Anthropic: drop every managed key, leave the rest of settings.json
 *  (and every unmanaged env var) exactly as it was. */
export function clearApiRoute(): OpResult {
  const res = writeManagedEnv({});
  if (!res.ok) return res;
  writeIndex({ active: null });
  return { ok: true };
}

/** Forget a saved account. If it is the one currently routed, the route is cleared
 *  too — leaving the machine pointed at a key we just deleted would be a rug-pull
 *  that only shows up as auth errors inside every agent. */
export function deleteApiAccount(provider: string, label: string): OpResult {
  if (!isSafeId(provider) || !isSafeId(label)) return { ok: false, error: "ชื่อไม่ถูกต้อง" };
  const active = readIndex().active;
  const wasActive = active?.provider === provider && active?.label === label;
  if (wasActive) {
    const res = clearApiRoute();
    if (!res.ok) return res;
  }
  try {
    fs.unlinkSync(acctFile(provider, label));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") return { ok: false, error: String((e as Error)?.message ?? e) };
  }
  try {
    if (!fs.readdirSync(providerDir(provider)).length) fs.rmdirSync(providerDir(provider));
  } catch {
    /* leaving an empty dir behind is harmless */
  }
  return { ok: true };
}
