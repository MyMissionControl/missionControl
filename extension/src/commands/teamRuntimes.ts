import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Two more durable per-team sidecars, siblings of models.json and owned by the
// same picker for the same reason: `maw team up` overwrites config.json's
// members[] with live-worker entries, so anything stored only there is lost the
// first time the team is woken. See teamModels.ts for the full story.
//
//   runtimes.json  { "<oracle>": "codex" }   — which agent CLI drives this worker
//   memory.json    { "<oracle>": true }      — may this worker reach oracle memory
//
// ⛔ These are a CROSS-REPO CONTRACT, not private state: the orches engine reads
//   the same two files (`worker-runtime` / `worker-memory` in orches-integrate.sh)
//   and orchesParity.test.ts pins that both sides agree. Changing a filename, a
//   value shape, or the pruning rule here silently changes what a dispatched
//   worker is, so change both sides together or not at all.

/** Agent runtimes the picker offers. "claude" is the default and is never written. */
export const RUNTIME_OPTIONS = ["claude", "codex"] as const;

/** Canonical form of a runtime id: trim + lowercase.
 *  ⛔ The engine does `.strip().lower()` BEFORE its charset check, so bash happily
 *  turns a hand-edited "Codex" into "codex". A TS guard that merely rejected the
 *  uppercase form would disagree with the engine about the same file — caught by
 *  orchesParity.test.ts on the very first run of that test. Mirror the engine:
 *  normalize first, validate second, and store the normalized value. */
export function normalizeRuntimeId(runtime: string): string {
  return (runtime ?? "").trim().toLowerCase();
}

/** True when the CANONICAL form is one the engine will accept. The value ends up
 *  interpolated into a shell command line that gets typed into a tmux pane, so the
 *  charset is deliberately tiny: `^[a-z][a-z0-9-]*$`. */
export function isSafeRuntimeId(runtime: string): boolean {
  const v = normalizeRuntimeId(runtime);
  if (!v || v.length > 40) return false;
  return /^[a-z][a-z0-9-]*$/.test(v);
}

export function teamRuntimesFile(team: string): string {
  return path.join(os.homedir(), ".claude", "teams", team, "runtimes.json");
}

export function teamMemoryFile(team: string): string {
  return path.join(os.homedir(), ".claude", "teams", team, "memory.json");
}

/** Parse runtimes.json → { oracle: runtime }. Unsafe/empty values and malformed
 *  JSON are dropped, so a bad file degrades to "everyone is claude" rather than
 *  breaking a dispatch. */
export function parseTeamRuntimes(raw: string): Record<string, string> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string" && isSafeRuntimeId(v)) out[k] = normalizeRuntimeId(v);
      }
      return out;
    }
  } catch {
    /* malformed → everyone defaults to claude */
  }
  return {};
}

/** Serialize, pruning empties AND "claude" — claude is the engine's default, so
 *  storing it would only create a second place that has to be kept in sync. */
export function serializeTeamRuntimes(runtimes: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(runtimes)) {
    const t = normalizeRuntimeId(v);
    if (t && t !== "claude" && isSafeRuntimeId(t)) clean[k] = t;
  }
  return JSON.stringify(clean, null, 2) + "\n";
}

export function readTeamRuntimes(team: string): Record<string, string> {
  try {
    return parseTeamRuntimes(fs.readFileSync(teamRuntimesFile(team), "utf8"));
  } catch {
    return {};
  }
}

export function writeTeamRuntimes(team: string, runtimes: Record<string, string>): void {
  const file = teamRuntimesFile(team);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeTeamRuntimes(runtimes));
}

/** Parse memory.json → { oracle: true }. Only a real `true` counts: the bash side
 *  also accepts "on"/"yes"/"1" from a hand-edited file, but the picker only ever
 *  writes booleans, so anything else read back here is treated as off. */
export function parseTeamMemory(raw: string): Record<string, boolean> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v === true) out[k] = true;
        else if (typeof v === "string" && ["on", "true", "yes", "1"].includes(v.trim().toLowerCase()))
          out[k] = true;
      }
      return out;
    }
  } catch {
    /* malformed → nobody gets memory (fail closed: this grants privilege) */
  }
  return {};
}

/** Serialize, keeping only the members explicitly turned ON. `false` is the
 *  default and is never written — an absent key and a `false` key must not be
 *  two different states, or "off" starts meaning two things. */
export function serializeTeamMemory(memory: Record<string, boolean>): string {
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(memory)) if (v === true) clean[k] = true;
  return JSON.stringify(clean, null, 2) + "\n";
}

export function readTeamMemory(team: string): Record<string, boolean> {
  try {
    return parseTeamMemory(fs.readFileSync(teamMemoryFile(team), "utf8"));
  } catch {
    return {};
  }
}

export function writeTeamMemory(team: string, memory: Record<string, boolean>): void {
  const file = teamMemoryFile(team);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeTeamMemory(memory));
}

/** Project a full roster into the two sidecar maps. PURE — the interesting rule
 *  lives here so it can be tested without a filesystem or a fake $HOME.
 *  ⛔ Takes the WHOLE roster, never a diff: a diff cannot express "this key should
 *  no longer exist", and for `memory` that failure mode leaves a privilege granted
 *  after the user revoked it. Absent key == off is the only definition of off. */
export function rosterToSidecars(
  members: { oracle?: string; runtime?: string; memory?: boolean }[],
): { runtimes: Record<string, string>; memory: Record<string, boolean> } {
  const runtimes: Record<string, string> = {};
  const memory: Record<string, boolean> = {};
  for (const m of members) {
    if (!m.oracle) continue;
    if (m.runtime) runtimes[m.oracle] = normalizeRuntimeId(m.runtime);
    if (m.memory === true) memory[m.oracle] = true;
  }
  return { runtimes, memory };
}

/** Write BOTH sidecars from a full roster in one call. Thin IO over rosterToSidecars. */
export function writeTeamRuntimeSidecars(
  team: string,
  members: { oracle?: string; runtime?: string; memory?: boolean }[],
): void {
  const { runtimes, memory } = rosterToSidecars(members);
  writeTeamRuntimes(team, runtimes);
  writeTeamMemory(team, memory);
}
