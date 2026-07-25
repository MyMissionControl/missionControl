import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { run, type RunResult } from "./gitOps";
import { parseOraclePath } from "./teams";
import { readTeamModels, writeTeamModels } from "./teamModels";
import {
  awakenStatusFromClaudeMd,
  createArgs,
  deleteArgs,
  diffMembers,
  inviteArgs,
  isSafeTeamName,
  mergeTeamStores,
  MODEL_ALIASES,
  reconcileToolMembers,
  removeArgs,
  syncCharterMembers,
  type AwakenStatus,
  type TeamDetail,
  type TeamMember,
  type ToolMember,
} from "./teamsModel";

// Extension-side team CRUD. Membership + roles persist through the maw CLI
// (oracle-invite / oracle-remove / create / delete — arg arrays, no shell).
// Two things have no CLI verb, so they are data-file writes into maw's OWN
// stores (allowed — data, not maw source): the team description and per-member
// run-config (model/color) live in ~/.claude/teams/<t>/config.json.

const MAW_TEAMS_DIR = path.join(os.homedir(), ".maw", "teams");
const TOOL_TEAMS_DIR = path.join(os.homedir(), ".claude", "teams");
// The team CHARTER yaml `maw team up` reads (resolveCharterPath →
// <root>/.maw/teams/<t>.yaml, with root = the soulbrew tree we run maw from).
// Kept in sync with the UI roster on every save so `team up` spawns the same
// members the panel shows — NOT ~/.maw/teams (the oracle-registry store).
const CHARTER_DIR = path.join(os.homedir(), "Desktop", "soulbrew", ".maw", "teams");
const ORACLES_JSON = path.join(os.homedir(), ".maw", "oracles.json");
const MAW_TIMEOUT = 15000;
const BUD_TIMEOUT = 90000; // scaffolding an oracle (repo + ψ vault) is slower
// Target org for a NEW oracle's GitHub repo. `maw bud --org` couples the two:
// the repo is created under this owner AND the local checkout lands in
// `<ghq-root>/github.com/<org>/<name>-oracle`. Every repo of this stack was
// migrated to the MyMissionControl org, so new oracles are born there too — the
// five pre-migration oracles keep their `fufu-2345` folder + oracles.json entry
// (maw resolves each one's path from its own recorded org, so mixing is safe).
const ORACLE_ORG = "MyMissionControl";

// maw resolves its ψ vault (where `team create` writes/checks the uniqueness
// manifest) RELATIVE TO CWD. With no cwd, it resolved against the opaque
// extension-host cwd — scattering stray ~/ψ vaults and making the "already
// exists" check target a different vault than a later invocation. Pin every maw
// call to the soulbrew tree (the same root terminal.ts/status.ts/claude.ts use)
// so create/delete/existence all agree on ONE deterministic vault.
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");
// MAW_QUIET=1 suppresses maw's per-invocation stderr banner ("loaded config: 0
// triggers…" + "loaded N plugins…"). Without it, firstLine() surfaces the banner
// instead of the real error on any failure. Spread process.env — env REPLACES.
const MAW_ENV = { ...process.env, MAW_QUIET: "1" };
const MAW_OPTS = { timeout: MAW_TIMEOUT, cwd: SOULBREW_DIR, env: MAW_ENV };

const runMaw = (args: string[]): Promise<RunResult> => run("maw", args, MAW_OPTS);

/** Resolve maw's ψ vault dir the way maw's resolvePsi() does, from a base cwd:
 *  walk up for a dir that has BOTH CLAUDE.md and ψ/; else fall back to <base>/ψ.
 *  We invoke maw with cwd=SOULBREW_DIR, so this MUST use the same base to agree
 *  with where maw actually writes/checks the manifest. */
function resolvePsi(base: string): string {
  let dir = base;
  for (;;) {
    if (fs.existsSync(path.join(dir, "ψ")) && fs.existsSync(path.join(dir, "CLAUDE.md"))) {
      return path.join(dir, "ψ");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return path.join(base, "ψ");
}

/** A team's ψ-vault dir — the store maw enforces `create` uniqueness against
 *  (its manifest.json is what makes maw say "already exists"). */
function teamVaultDir(name: string): string {
  return path.join(resolvePsi(SOULBREW_DIR), "memory", "mailbox", "teams", name);
}

/** An oracle's repo dir from the fleet registry (oracles.json local_path).
 *  Expands a leading ~; returns null if the oracle isn't registered / has no path. */
function oracleLocalPath(name: string): string | null {
  const data = readJson<{ oracles?: { name?: string; local_path?: string }[] }>(ORACLES_JSON);
  const p = (data?.oracles ?? []).find((o) => o?.name === name)?.local_path;
  if (!p) return null;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Whether an oracle has a real identity or is still a bare bud scaffold, read
 *  from its CLAUDE.md (best-effort — missing repo/file → "unknown"). Display-only:
 *  drives the panel's "identity set up" highlight. */
function readAwakenStatus(name: string): AwakenStatus {
  const dir = oracleLocalPath(name);
  if (!dir) return "unknown";
  let text: string | null = null;
  try {
    text = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  } catch {
    return "unknown";
  }
  return awakenStatusFromClaudeMd(text);
}

/** Existing oracle names from the fleet registry (used to decide whether an
 *  added member is a brand-new oracle to scaffold, or one that already exists). */
function existingOracleNames(): Set<string> {
  const data = readJson<{ oracles?: { name?: string }[] }>(ORACLES_JSON);
  return new Set(
    (data?.oracles ?? [])
      .map((o) => o?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  );
}

/** Create a NEW oracle's structure (repo + ψ vault + CLAUDE.md + fleet config)
 *  but STOP before commit/push/wake/awaken — it gets waked later, when the team
 *  is actually put to work. `--scaffold-only` is what makes it not wake. */
function scaffoldOracle(name: string): Promise<RunResult> {
  return run(
    "maw",
    ["bud", name, "--root", "--org", ORACLE_ORG, "--scaffold-only"],
    { timeout: BUD_TIMEOUT, cwd: SOULBREW_DIR, env: MAW_ENV },
  );
}

/** For each member to add: scaffold the oracle first if it doesn't exist yet,
 *  then oracle-invite it (invite also upserts the role for existing members). */
async function ensureAndInvite(
  team: string,
  members: TeamMember[],
  errors: string[],
): Promise<void> {
  const existing = existingOracleNames();
  for (const m of members) {
    if (!existing.has(m.oracle)) {
      if (!isSafeTeamName(m.oracle)) {
        errors.push(`create ${m.oracle}: ชื่อไม่ถูกต้อง (A-Z a-z 0-9 . _ -)`);
        continue;
      }
      const c = await scaffoldOracle(m.oracle);
      if (!c.ok) {
        errors.push(`create ${m.oracle}: ${firstLine(c)}`);
        continue; // don't invite a phantom the scaffold failed to create
      }
      existing.add(m.oracle);
    }
    const r = await runMaw(inviteArgs(m.oracle, team, m.role));
    if (!r.ok) errors.push(`invite ${m.oracle}: ${firstLine(r)}`);
  }
}

interface ToolConfig {
  name?: string;
  description?: string;
  createdAt?: string;
  members?: ToolMember[];
  [k: string]: unknown;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every known team name, sorted. Unions the oracle-registry store (teams with
 *  members) with the tool store (`maw team create` writes ~/.claude/teams/<t>/
 *  config.json for EVERY team, including 0-member ones) — so a memberless team
 *  created from the panel actually shows up on the list, not just teams that got
 *  an oracle-invite. */
export function listTeamNames(): string[] {
  const names = new Set<string>();
  const collect = (base: string, marker: string): void => {
    try {
      for (const e of fs.readdirSync(base)) {
        if (fs.existsSync(path.join(base, e, marker))) names.add(e);
      }
    } catch {
      /* dir may not exist yet */
    }
  };
  collect(MAW_TEAMS_DIR, "oracle-members.json");
  collect(TOOL_TEAMS_DIR, "config.json");
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** True if a team of this name already exists in ANY store the panel or maw care
 *  about — oracle-registry, tool store, OR the ψ-vault manifest maw enforces
 *  `create` uniqueness against. The create pre-guard uses this so a vault-only
 *  "ghost" (e.g. left after a delete before P1, or a 0-member create) is caught
 *  with a clean "already exists" message instead of a cryptic maw failure. */
export function teamExists(name: string): boolean {
  return (
    fs.existsSync(path.join(MAW_TEAMS_DIR, name, "oracle-members.json")) ||
    fs.existsSync(path.join(TOOL_TEAMS_DIR, name, "config.json")) ||
    fs.existsSync(path.join(teamVaultDir(name), "manifest.json"))
  );
}

/** Summaries for the list screen (name + counts + role preview). */
export function listTeamSummaries(): { name: string; memberCount: number; roles: string[] }[] {
  return listTeamNames().map((name) => {
    const d = readTeamDetailSync(name);
    return {
      name,
      memberCount: d.members.length,
      roles: [...new Set(d.members.map((m) => m.role))],
    };
  });
}

/** Read + merge both stores for one team. Sync (small local JSON reads). */
export function readTeamDetailSync(name: string): TeamDetail {
  const oracle = readJson<{ members?: { oracle: string; role?: string }[] }>(
    path.join(MAW_TEAMS_DIR, name, "oracle-members.json"),
  );
  const tool = readJson<ToolConfig>(path.join(TOOL_TEAMS_DIR, name, "config.json"));
  const merged = mergeTeamStores(oracle?.members ?? [], tool?.members ?? []);
  // Overlay the durable model sidecar (models.json). config.json's model is
  // unreliable — `maw team up` clobbers members[] with live-worker entries — so the
  // sidecar is the source of truth for a member's picked model. This makes the panel
  // AND every launch reader (teamUp, orchestrator) see the model that survives a Team up.
  const models = readTeamModels(name);
  const members = merged.map((m) => {
    const withModel = models[m.oracle] ? { ...m, model: models[m.oracle] } : m;
    return { ...withModel, awaken: readAwakenStatus(m.oracle) };
  });
  return { name, description: tool?.description ?? "", members };
}

/** Existing oracle names (add-member picker source), sorted, minus a team's
 *  current members if given. */
export function oracleCandidates(exclude: string[] = []): string[] {
  const data = readJson<{ oracles?: { name?: string }[] }>(ORACLES_JSON);
  const ex = new Set(exclude);
  const names = (data?.oracles ?? [])
    .map((o) => o?.name)
    .filter((n): n is string => typeof n === "string" && !ex.has(n));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Upsert the tool-store config.json — description and/or per-member run-config
 *  (model/color), and PRUNE members named in `remove`. Creates the dir/file if
 *  the team never ran. Removing here is essential: `oracle-remove` only cleans
 *  the maw store, so a removed member left in this store is re-surfaced by
 *  mergeTeamStores and appears to "come back" after Save. */
function writeToolConfig(
  name: string,
  patch: { description?: string; members?: TeamMember[]; remove?: string[] },
): void {
  const dir = path.join(TOOL_TEAMS_DIR, name);
  const file = path.join(dir, "config.json");
  const cfg: ToolConfig = readJson<ToolConfig>(file) ?? { name, members: [] };
  if (!Array.isArray(cfg.members)) cfg.members = [];
  if (patch.description !== undefined) cfg.description = patch.description;
  cfg.members = reconcileToolMembers(cfg.members, { upsert: patch.members, remove: patch.remove });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

/** Rewrite the team's charter yaml so `maw team up` spawns the SAME roster the
 *  UI shows. Without this the charter (bob/jack/john) drifts from the registry
 *  the UI edits (foreman/bob/jack/john/mike) and team up under-spawns. Preserves
 *  the charter's session/project/etc.; best-effort (push, don't throw). */
function syncCharter(team: string, members: TeamMember[], errors: string[]): void {
  const file = path.join(CHARTER_DIR, `${team}.yaml`);
  try {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      /* no charter yet — a minimal one is generated */
    }
    const yaml = syncCharterMembers(existing, team, members.map((m) => m.oracle));
    fs.mkdirSync(CHARTER_DIR, { recursive: true });
    fs.writeFileSync(file, yaml);
  } catch (e) {
    errors.push(`charter sync: ${String(e)}`);
  }
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
}

/** Apply an edited roster + description to an EXISTING team (minimal commands). */
export async function saveTeam(
  name: string,
  description: string,
  edited: TeamMember[],
): Promise<SaveResult> {
  const original = readTeamDetailSync(name);
  const diff = diffMembers(original.members, edited);
  const errors: string[] = [];

  for (const oracle of diff.removed) {
    const r = await runMaw(removeArgs(oracle, name));
    // Tolerate "not found" (like deleteTeam): the member may already be absent
    // from the maw store — e.g. a prior desync where it lingered only in the tool
    // store. The tool-store prune below still runs, so the delete completes either
    // way and the recovery Save doesn't surface a spurious error.
    if (!r.ok && !/not found/i.test(r.stderr + r.stdout)) {
      errors.push(`remove ${oracle}: ${firstLine(r)}`);
    }
  }
  // Added members may be brand-new oracles (scaffold them first); roleChanged
  // are always existing, so ensureAndInvite just re-invites to upsert the role.
  await ensureAndInvite(name, [...diff.added, ...diff.roleChanged], errors);
  // Description + run-config (model/color) are data-file writes. Include the
  // added members' config too so a brand-new member's model/color persists, and
  // PRUNE removed members from the tool store in the same write — otherwise
  // mergeTeamStores re-appends them and the delete appears to undo itself.
  try {
    const cfgMembers = [...diff.added, ...diff.configChanged];
    writeToolConfig(name, {
      description: description !== original.description ? description : undefined,
      members: cfgMembers,
      remove: diff.removed,
    });
  } catch (e) {
    errors.push(`config write: ${String(e)}`);
  }
  // Keep the yaml charter (what `maw team up` reads) matching the saved roster.
  syncCharter(name, edited, errors);
  // Durable model sidecar — the ONE store `maw team up` won't clobber. Written
  // from the FULL edited roster so every member's pick survives a Team up.
  try {
    const modelMap: Record<string, string> = {};
    for (const m of edited) if (m.oracle && m.model) modelMap[m.oracle] = m.model;
    writeTeamModels(name, modelMap);
  } catch (e) {
    errors.push(`models sidecar: ${String(e)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Prepare a BRAND-NEW oracle for the awaken ritual: scaffold its repo, invite it
 *  to the team with the given role, and sync the charter so `maw team up --only
 *  <oracle>` can wake it. Does NOT wake or fire /awaken — the vscode launcher runs
 *  that in a terminal. REFUSES an oracle that already exists: awaken (birth) would
 *  clobber an existing identity, so this path is birth-only. */
export async function prepareAwakenMember(
  team: string,
  oracle: string,
  role: string,
): Promise<SaveResult> {
  if (!isSafeTeamName(oracle)) return { ok: false, errors: [`ชื่อ oracle ไม่ถูกต้อง: '${oracle}'`] };
  if (existingOracleNames().has(oracle)) {
    return {
      ok: false,
      errors: [`'${oracle}' มีอยู่แล้ว — awaken เปล่าจะทับ identity เดิม (ทำได้เฉพาะ oracle เกิดใหม่)`],
    };
  }
  const errors: string[] = [];
  // scaffold (maw bud --scaffold-only) + oracle-invite with the role — same path Save uses.
  await ensureAndInvite(team, [{ oracle, role: role || "member" }], errors);
  // Charter must list the new member or `maw team up --only <oracle>` finds nothing.
  const roster = readTeamDetailSync(team).members.map((m) => ({ oracle: m.oracle, role: m.role }));
  syncCharter(team, roster, errors);
  return { ok: errors.length === 0, errors };
}

/** Create a new team + invite its members. */
export async function createTeam(
  name: string,
  description: string,
  members: TeamMember[],
): Promise<SaveResult> {
  const errors: string[] = [];
  const created = await runMaw(createArgs(name, description));
  if (!created.ok) return { ok: false, errors: [`create: ${firstLine(created)}`] };
  await ensureAndInvite(name, members, errors);
  if (members.some((m) => m.model || m.color) || description) {
    try {
      writeToolConfig(name, { description, members });
    } catch (e) {
      errors.push(`config write: ${String(e)}`);
    }
  }
  // Seed the yaml charter so `maw team up <team>` works immediately after create.
  syncCharter(name, members, errors);
  // Durable model sidecar (see saveTeam) — survives `maw team up` clobbering config.json.
  try {
    const modelMap: Record<string, string> = {};
    for (const m of members) if (m.oracle && m.model) modelMap[m.oracle] = m.model;
    writeTeamModels(name, modelMap);
  } catch (e) {
    errors.push(`models sidecar: ${String(e)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Delete a team from ALL THREE stores: `maw team delete` (tool store) + rm the
 *  oracle-registry dir + rm the ψ-vault manifest dir. Removing the ψ vault is
 *  essential — `maw team delete` leaves it behind, and that lingering "ghost"
 *  manifest is what made a later create of the same name fail "already exists". */
export async function deleteTeam(name: string): Promise<SaveResult> {
  const errors: string[] = [];
  const del = await runMaw(deleteArgs(name));
  if (!del.ok && !/not found/i.test(del.stderr + del.stdout)) {
    errors.push(`delete: ${firstLine(del)}`);
  }
  // oracle-registry dir = maw's own team state (regenerable) → remove wholesale.
  try {
    fs.rmSync(path.join(MAW_TEAMS_DIR, name), { recursive: true, force: true });
  } catch (e) {
    errors.push(`rm ${path.join(MAW_TEAMS_DIR, name)}: ${String(e)}`);
  }
  // ψ vault holds TEAM MEMORY, not just the uniqueness manifest — drop ONLY the
  // "ghost" manifest.json (what blocks re-create), then rmdir the vault only if
  // it is now empty. A non-empty vault (real memory files present) makes rmdir
  // throw ENOTEMPTY → caught → memory preserved. (Previously this rm -rf'd the
  // whole vault, destroying team memory with no confirm.)
  const vault = teamVaultDir(name);
  try {
    fs.rmSync(path.join(vault, "manifest.json"), { force: true });
    fs.rmdirSync(vault);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") {
      errors.push(`rm manifest ${vault}: ${String(e)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** First MEANINGFUL line of a maw result. maw prints a plugin-loading banner
 *  ("loaded config: …" / "loaded N plugins …") to stderr on every invocation;
 *  MAW_QUIET=1 (see MAW_ENV) suppresses it, but strip any banner line that slips
 *  through so the real error surfaces instead of the meaningless banner. */
export function firstLine(r: RunResult): string {
  const lines = (r.stderr || r.stdout || "failed")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.filter((l) => !/^loaded /.test(l));
  return meaningful[0] ?? lines[0] ?? "failed";
}

// ── Model options for the per-member dropdown (live, not hardcoded IDs) ───────

let _modelsCache: Promise<string[]> | null = null;

/** Options for the member "model" dropdown. Base = the version-proof provider
 *  aliases (opus/sonnet/haiku). If an Anthropic API key is in the environment,
 *  augment with the concrete model IDs the provider currently serves (GET
 *  /v1/models) so the list reflects reality even after the provider renames or
 *  adds models. Cached for the panel's lifetime; never throws. */
export function availableModels(): Promise<string[]> {
  if (!_modelsCache) _modelsCache = computeModels();
  return _modelsCache;
}

async function computeModels(): Promise<string[]> {
  const base: string[] = [...MODEL_ALIASES];
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!key) return base; // no key → offer the aliases only (already version-proof)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return base;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Aliases first (recommended), then concrete IDs not already covered.
    return [...base, ...ids.filter((id) => !base.includes(id))];
  } catch {
    return base;
  }
}

// Re-export so the panel can resolve an oracle's repo (future: open its dir).
export { parseOraclePath };
