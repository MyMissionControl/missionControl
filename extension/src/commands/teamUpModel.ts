// Pure (vscode-free) logic for the "Team up" bootstrap, split out so it is unit
// testable under bun:test. The vscode-facing shell lives in teamUp.ts.

import { isSafeModelId } from "./teamsModel";

/** The `session:` value from a charter yaml (null if the file has none). Matches
 *  how `maw team up` resolves its default session (charter.session). */
export function parseCharterSession(yaml: string): string | null {
  const m = yaml.match(/^\s*session:\s*([^\s#]+)/m);
  return m ? m[1] : null;
}

/** Resolve which session to team up into. Base free → use it. Base already live
 *  → mint the first free `base-N` (N=2..9) so this is a fresh instance, not a
 *  reconcile into the running one. Same walk as startOrchestrator.nextTwinSession. */
export function resolveInstanceSession(
  base: string,
  has: (session: string) => boolean,
  now: () => number = Date.now,
): { session: string; minted: boolean } {
  if (!has(base)) return { session: base, minted: false };
  for (let i = 2; i <= 9; i++) {
    if (!has(`${base}-${i}`)) return { session: `${base}-${i}`, minted: true };
  }
  return { session: `${base}-${now() % 1000}`, minted: true }; // 9 instances?! — just don't collide
}

/** Shell command: ensure the target tmux session (and thus a tmux server)
 *  exists, wake the team into it, then attach the user.
 *
 *  The `new-session -A -d` bootstrap is essential: `maw team up` lists panes as a
 *  precondition and HARD-FAILS with "no server running" on a cold VM (no live
 *  tmux) — which is exactly what happens after a reboot / snapshot. `-A` makes it
 *  idempotent (no-op if the session is already live, e.g. a warm server), `-d`
 *  keeps it detached. team up then adds each member as its own WINDOW of this
 *  session, named `<repo-stem>-<oracle>` (e.g. `missioncontrol-bob`).
 *
 *  Two cleanups keep the tmux status bar short and readable:
 *   - each member window is renamed to just the bare oracle (`${w#*-}` strips the
 *     `<repo-stem>-` prefix). SAFE for maw: classifyMember matches a window whose
 *     name equals a member candidate, and the bare oracle IS a candidate — so
 *     `maw team status/send/enter` still resolve these panes, and per-agent git
 *     worktree isolation is untouched (only the display name changes).
 *   - the `_boot` bootstrap window is KILLED once members exist (`; kill-window`),
 *     so it doesn't linger as a phantom member. The session survives on its
 *     member windows.
 *  On a failed up the rename/kill are skipped and attach still drops the user on
 *  the `_boot` shell with the error in scrollback.
 *
 *  `--force` + `--only` per member is what makes the button reliable:
 *   - `--force` stops team up RESUMING a member whose pane lingers from a prior
 *     run (it would send `claude … --continue` and, on the default engine, hit the
 *     unconfigured `default-resume`).
 *   - waking ONE member per invocation (`--only`) serializes the launches. Plain
 *     `maw team up` fans every member out through `Promise.all`, and those
 *     concurrent tmux `send-keys` race — keystrokes cross panes and concatenate
 *     (→ `--dangerously-skip-permissionsclaude` / `--continueclaude`, "unknown
 *     option", member never boots). Sequential `--only` waking is deterministic:
 *     each member's claude is up before the next is launched.
 *  Live members of an ALREADY-up team aren't clobbered — the caller mints a new
 *  `-N` session for those. `members` is the roster (bare oracle names); empty →
 *  fall back to a single plain up (charter decides who wakes).
 *  team/session/members are validated (isSafeTeamName / SAFE_SESSION) and cwd is a
 *  fixed local path before this. */
export function buildTeamUpCommand(
  team: string,
  session: string,
  cwd: string,
  members: string[],
  models: Record<string, string> = {}, // member → Team Config model (config.json members[].model)
): string {
  const up = members.length
    ? members
        .map((m) => `maw team up '${team}' --session '${session}' --force --only '${m}'`)
        .join(" ; ")
    : `maw team up '${team}' --session '${session}' --force`;
  // maw team up has NO --model and this setup uses the legacy "commands" config
  // (no engine mechanism), so every member otherwise inherits the global
  // ~/.claude/settings.json default (e.g. opus[1m]) — the reason the picker never
  // took effect. After the wake+rename (windows are now the bare member name),
  // switch each member to its configured model via the `/model` slash command.
  // Best-effort: one settle wait for the last sequential wake to reach its prompt,
  // then a send per member with a SAFE configured model (reject, don't sanitize, so
  // a tampered config.json can't smuggle shell into the command).
  // Shared validator (teamsModel.isSafeModelId) — it allows the bracketed window
  // suffix (`opus[1m]`). The local regex here used to reject brackets while the
  // orchestrator launch path accepted them, so a bracketed pick was silently
  // dropped for workers and the member quietly inherited the global default.
  const sends = members
    .filter((m) => models[m] && isSafeModelId(models[m]))
    .map((m) => `tmux send-keys -t '=${session}:${m}' '/model ${models[m]}' Enter`);
  const modelStep = sends.length ? `sleep 5 ; ${sends.join(" ; ")} ; ` : "";
  return (
    `tmux new-session -A -d -s '${session}' -n _boot -c '${cwd}' && { ` +
    `${up} ; ` +
    `for w in $(tmux list-windows -t '=${session}' -F '#{window_name}'); do ` +
    `tmux rename-window -t "=${session}:$w" "\${w#*-}" 2>/dev/null ; done ; ` +
    `${modelStep}` +
    `tmux kill-window -t '=${session}:_boot' 2>/dev/null ; ` +
    `tmux attach -t '=${session}' ; }`
  );
}

/** Wake ONE freshly-created member into the team session — same session
 *  bootstrap / window-rename / attach as buildTeamUpCommand, but the roster is
 *  just this oracle (`--only`, the rest of the team untouched) — then fire
 *  `/awaken` into that member's window so the birth ritual runs in the pane the
 *  user is attached to. The `/awaken` send is BEST-EFFORT: one settle wait for
 *  claude to reach its prompt (the ritual then prompts for language/mode in-pane);
 *  a cold start slower than the wait means /awaken lands in the shell and the user
 *  re-sends it manually. team/session/oracle are validated by the caller. */
export function buildAwakenMemberCommand(
  team: string,
  session: string,
  cwd: string,
  oracle: string,
): string {
  return (
    `tmux new-session -A -d -s '${session}' -n _boot -c '${cwd}' && { ` +
    `maw team up '${team}' --session '${session}' --force --only '${oracle}' ; ` +
    `for w in $(tmux list-windows -t '=${session}' -F '#{window_name}'); do ` +
    `tmux rename-window -t "=${session}:$w" "\${w#*-}" 2>/dev/null ; done ; ` +
    `tmux kill-window -t '=${session}:_boot' 2>/dev/null ; ` +
    `sleep 10 ; tmux send-keys -t '=${session}:${oracle}' '/awaken' Enter ; ` +
    `tmux attach -t '=${session}' ; }`
  );
}

export const SAFE_SESSION = /^[\w.-]+$/;
