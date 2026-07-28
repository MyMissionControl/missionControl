// Pure model for the Teams panel: parse the two team stores, build the maw CLI
// arg-arrays that persist edits, and diff an edited roster against the original
// so Save runs the minimal set of commands. NO vscode/fs/cp import — every
// filesystem + exec side effect lives in teamsOps.ts, so this stays unit-tested
// with `bun test`.

/** Roles the maw oracle store uses in practice (free-text field, but these are
 *  the established vocabulary — offered as a dropdown). */
export const ROLE_OPTIONS = ["orchestrator", "member", "builder"] as const;

/** Member colors — EXACTLY maw's AgentColor palette (maw-js
 *  tmux/layout-manager.ts → AGENT_COLORS). This is the color maw paints the
 *  member's tmux pane border and the ● dot in `maw team status`/`list`; it is
 *  only visible while the team is live. Keep this list in sync with maw. */
export const COLOR_OPTIONS = [
  "blue",
  "green",
  "yellow",
  "cyan",
  "magenta",
  "red",
  "white",
  "orange",
] as const;

/** Model options for `claude --model` — pinned, versioned Claude model IDs so the
 *  dropdown shows an explicit version rather than a bare "opus"/"claude". Trade-off
 *  vs bare aliases (opus/sonnet/haiku, which auto-track the latest tier): these pin
 *  to a specific version and must be hand-bumped when a newer model ships.
 *  teamsOps.availableModels() still merges the real, currently-served model IDs on
 *  top of these when an Anthropic API key is present in the environment. */
export const MODEL_ALIASES = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

export const DEFAULT_ROLE = "member";
// The model a member defaults to when none is stored (or when maw wrote the bare
// engine name "claude" into the model field). Pinned to a versioned id so the
// dropdown pre-selects a concrete version and maw launches `claude --model claude-sonnet-5`.
export const DEFAULT_MODEL = "claude-sonnet-5";

/** Whether an oracle has had its identity set up.
 *  - "identity" — CLAUDE.md has a real identity (via /awaken OR a hand edit)
 *  - "stub"     — still the bare bud scaffold (identity not defined yet)
 *  - "unknown"  — no repo / CLAUDE.md found for this oracle */
export type AwakenStatus = "identity" | "stub" | "unknown";

/** Classify an oracle's awaken state from its CLAUDE.md text. `maw bud` writes
 *  the literal placeholder `(to be defined by /awaken)` into the Purpose stub;
 *  /awaken (or a manual edit) replaces it. So the placeholder's PRESENCE is the
 *  reliable "still bare" signal — it survives regardless of whether identity was
 *  set up by the ritual or by hand (the brew oracles were hand-edited, so a
 *  ritual-only marker like `## Demographics` would false-negative on them). */
export function awakenStatusFromClaudeMd(text: string | null | undefined): AwakenStatus {
  if (text == null || text.trim() === "") return "unknown";
  return text.includes("(to be defined by /awaken)") ? "stub" : "identity";
}

export interface TeamMember {
  oracle: string;
  role: string;
  model?: string; // run-config (tool store); undefined if the team never ran
  color?: string; // run-config (tool store)
  awaken?: AwakenStatus; // identity state, read from the oracle's CLAUDE.md (display-only)
}

/** A tool-store member record — the shape of an entry in
 *  ~/.claude/teams/<t>/config.json → members[]. Unknown keys are preserved. */
export interface ToolMember {
  name: string;
  model?: string;
  color?: string;
  [k: string]: unknown;
}

export interface TeamDetail {
  name: string;
  description: string;
  members: TeamMember[];
}

/** Names safe to pass to a maw CLI arg / use as a store dir. Whitelist only. */
export function isSafeTeamName(name: string): boolean {
  if (!name || name.length > 100) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Model ids safe to interpolate into a shell command (`claude --model X`,
 *  `tmux send-keys '/model X'`). Whitelist only — reject, never sanitize, so a
 *  tampered store cannot smuggle shell metacharacters into the command line.
 *
 *  Allows an optional bracketed window suffix (`opus[1m]`) because that IS a real
 *  model spec Claude Code accepts. Two divergent regexes used to guard this same
 *  value: the orchestrator launch path allowed brackets while the per-member
 *  `/model` send did not, so any bracketed pick was silently dropped for workers
 *  and the member fell back to the global default. One validator now, and it
 *  matches the bash side (orches-integrate.sh `cmd_worker_model`) exactly. */
export function isSafeModelId(model: string): boolean {
  if (!model || model.length > 100) return false;
  return /^[A-Za-z0-9._-]+(\[[A-Za-z0-9]+\])?$/.test(model);
}

/** Canonical oracle name: trim, then strip ONE trailing `-oracle` — the exact
 *  normalization the save path applies (a typed "fusion-oracle" becomes the
 *  oracle stem "fusion", since `maw bud fusion` makes the repo fusion-oracle).
 *  Shared so the panel's duplicate check compares the SAME forms that would
 *  actually collide on Save. Mirror any change into the webview's inline copy. */
export function normalizeOracle(name: string): string {
  const s = (name ?? "").trim();
  return s.endsWith("-oracle") ? s.slice(0, -"-oracle".length) : s;
}

/** Normalized oracle names that appear 2+ times in the roster, sorted. Blank
 *  rows are ignored (never a duplicate). Case-sensitive — the fleet registry and
 *  filesystem treat "Bob" and "bob" as distinct oracles. Drives the panel's
 *  "duplicate member" guard so Save can be blocked before it reaches maw. */
export function findDuplicateOracleNames(names: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const raw of names) {
    const key = normalizeOracle(raw);
    if (!key) continue;
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes].sort((a, b) => a.localeCompare(b));
}

/** A tool-store entry that is actually a LIVE tmux worker maw registered while a
 *  team was up (`maw team up` writes these into the SAME config.json the panel
 *  uses for model/color) — NOT a roster member. Identified by the live-session
 *  fields maw stamps (tmuxPaneId / backendType). Its `name` is the tmux WINDOW
 *  identity (e.g. `missioncontrol-bob`, or a bootstrap `team` window), not an
 *  oracle name, so surfacing it as a member is wrong — and a Save would then try
 *  to scaffold a bogus oracle from it. These are filtered out of the roster. */
function isLiveWorkerEntry(t: ToolMember): boolean {
  return t.tmuxPaneId !== undefined || t.backendType !== undefined;
}

/** Merge the oracle store (roles, primary source of membership) with the tool
 *  store (per-member model/color run-config) into the panel's member list. The
 *  oracle store drives roles; tool config decorates with model/color. Members
 *  present in ONLY the tool store (the two stores can diverge — e.g. after
 *  repeated create/delete cycles) are appended too, so a divergence is visible
 *  and reconcilable in the panel rather than silently hidden — EXCEPT maw's
 *  live-worker entries (isLiveWorkerEntry), which are live tmux windows, not
 *  members, and must never appear in or decorate the roster. */
export function mergeTeamStores(
  oracleMembers: { oracle: string; role?: string }[],
  toolMembers: ToolMember[],
): TeamMember[] {
  const decor = toolMembers.filter((m) => !isLiveWorkerEntry(m));
  const byName = new Map(decor.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const out: TeamMember[] = [];
  for (const m of oracleMembers) {
    seen.add(m.oracle);
    const tool = byName.get(m.oracle);
    out.push({
      oracle: m.oracle,
      role: (m.role && m.role.trim()) || DEFAULT_ROLE,
      model: tool?.model,
      color: tool?.color,
    });
  }
  for (const t of decor) {
    if (seen.has(t.name)) continue;
    out.push({ oracle: t.name, role: DEFAULT_ROLE, model: t.model, color: t.color });
  }
  return out;
}

/** Reconcile a tool-store member list against a save: DROP the `remove` names
 *  first, then upsert model/color for each `upsert` member (append if absent).
 *  Returns a NEW array — never mutates the input. Pure; teamsOps.writeToolConfig
 *  owns the fs read/write.
 *
 *  The drop step is the fix for members reappearing after delete: Save clears the
 *  maw oracle store via `oracle-remove`, but the tool store must be pruned in the
 *  same pass — otherwise mergeTeamStores re-appends the tool-only leftover and the
 *  "deleted" member bounces back on the next detail read. */
export function reconcileToolMembers(
  existing: ToolMember[],
  opts: { upsert?: TeamMember[]; remove?: string[] },
): ToolMember[] {
  const drop = new Set(opts.remove ?? []);
  const out: ToolMember[] = existing.filter((m) => !drop.has(m.name)).map((m) => ({ ...m }));
  for (const m of opts.upsert ?? []) {
    let entry = out.find((x) => x.name === m.oracle);
    if (!entry) {
      entry = { name: m.oracle };
      out.push(entry);
    }
    if (m.model !== undefined) entry.model = m.model;
    if (m.color !== undefined) entry.color = m.color;
  }
  return out;
}

// ── Charter sync: keep `maw team up`'s yaml roster == the UI roster ───────────

/** Rewrite a maw team CHARTER yaml (<root>/.maw/teams/<t>.yaml) so its `members:`
 *  block matches the UI roster. This is the fix for the two sources of truth
 *  drifting: the UI edits the oracle registry (oracle-members.json), but
 *  `maw team up` reads ONLY the yaml charter — so members invited after the
 *  charter was written (e.g. mike, foreman) never spawn until the charter is
 *  synced.
 *
 *  Preserves EVERY other line of an existing charter — crucially `session:`
 *  (the tmux session team up targets) and `project:` (where member worktrees
 *  land); only the members block is replaced. A brand-new team (no charter yet)
 *  gets a minimal one keyed on the team name. Charter members are written as
 *  `- role: <oracle>`: maw's charter format uses the `role` field as the member
 *  identity (→ tmux window `<repo>-<oracle>`), matching the existing brew.yaml. */
export function syncCharterMembers(
  existing: string | null,
  team: string,
  oracles: string[],
): string {
  const block = ["members:", ...oracles.map((o) => `  - role: ${o}`)].join("\n");

  if (!existing || !existing.trim()) {
    return `name: ${team}\nsession: ${team}\n${block}\n`;
  }

  const lines = existing.replace(/\n+$/, "").split("\n");
  const membersIdx = lines.findIndex((l) => /^members:/.test(l));
  if (membersIdx < 0) {
    return `${lines.join("\n")}\n${block}\n`; // no members block yet → append
  }
  // Keep everything before `members:`; drop the old block (its line + all
  // following blank/indented lines); keep any later top-level keys.
  const head = lines.slice(0, membersIdx);
  let i = membersIdx + 1;
  while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) i++;
  const tail = lines.slice(i);
  return [...head, block, ...tail].join("\n").replace(/\n*$/, "\n");
}

// ── maw CLI arg builders (return arg arrays for execFile — no shell) ──────────

export function inviteArgs(oracle: string, team: string, role: string): string[] {
  const a = ["team", "oracle-invite", oracle, "--team", team];
  if (role && role.trim()) a.push("--role", role.trim());
  return a;
}

export function removeArgs(oracle: string, team: string): string[] {
  return ["team", "oracle-remove", oracle, "--team", team];
}

export function createArgs(name: string, description: string): string[] {
  const a = ["team", "create", name];
  if (description && description.trim()) a.push("--description", description.trim());
  return a;
}

export function deleteArgs(name: string): string[] {
  return ["team", "delete", name];
}

// ── Save diff: original roster → edited roster → minimal command plan ─────────

export interface MemberDiff {
  added: TeamMember[]; // oracle-invite (with role)
  removed: string[]; // oracle-remove (oracle names)
  roleChanged: TeamMember[]; // oracle-invite (re-invite upserts role)
  configChanged: TeamMember[]; // write tool config (model/color differs)
}

/** Compute the minimal change set between the original and edited member lists.
 *  `added`/`roleChanged` reuse oracle-invite (idempotent upsert); `removed` uses
 *  oracle-remove; `configChanged` is a tool-store write (model/color). */
export function diffMembers(
  original: TeamMember[],
  edited: TeamMember[],
): MemberDiff {
  const origByName = new Map(original.map((m) => [m.oracle, m]));
  const editByName = new Map(edited.map((m) => [m.oracle, m]));
  const diff: MemberDiff = { added: [], removed: [], roleChanged: [], configChanged: [] };

  for (const m of edited) {
    const orig = origByName.get(m.oracle);
    if (!orig) {
      diff.added.push(m);
      continue;
    }
    if ((orig.role || DEFAULT_ROLE) !== (m.role || DEFAULT_ROLE)) diff.roleChanged.push(m);
    if ((orig.model ?? "") !== (m.model ?? "") || (orig.color ?? "") !== (m.color ?? "")) {
      diff.configChanged.push(m);
    }
  }
  for (const m of original) {
    if (!editByName.has(m.oracle)) diff.removed.push(m.oracle);
  }
  return diff;
}
