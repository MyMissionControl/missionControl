import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { tmuxSessionTaken } from "./tmuxProbe";
import { openClaudeView } from "../webview/claudeView";
import { getClaudeViewMode } from "./settingsOps";
import { isSafeTeamName } from "./teamsModel";
import { readTeamDetailSync } from "./teamsOps";
import {
  buildAwakenMemberCommand,
  buildTeamUpCommand,
  parseCharterSession,
  resolveInstanceSession,
  SAFE_SESSION,
} from "./teamUpModel";

// "Team up" — a CODE-ONLY bootstrap (no LLM / no skill): run `maw team up <team>`
// into a tmux session, then put the user in front of it in whichever REPL view
// they chose (Settings → หน้าตา Claude REPL). `maw team up` reads the team's
// charter (bob/jack/john for brew) and fresh-wakes each member into the session.
//
// The wake is SLOW (sequential per-member launches + settle sleeps), so unlike
// the orchestrator launch it can never run through cp.execSync — it would block
// the extension host for minutes. A terminal hosts it in both views; what the
// view changes is the terminal's ROLE:
//   native — an editor terminal, revealed, whose command ends in `tmux attach`:
//            the terminal IS the REPL.
//   chat   — a background (panel) terminal, never revealed, whose command stops
//            after the wake: it is only the bootstrap LOG, and the Claude Chat
//            webview is the interface. Revealing it here would be actively bad —
//            an attached terminal reacts to every send-keys the chat makes and
//            yanks focus back to the garbled-Thai TUI (the reason the
//            orchestrator launch went detached).
//
// 1 session = 1 team instance (the /orches model): the base session is the
// team's charter.session (falls back to the team name — which is also what
// `maw team up` targets by default). If that base session is already live
// (this team was up'd before), we don't reconcile into it — we MINT a fresh
// instance `base-2`, `base-3`, … so a second click gives a separate run, exactly
// like startOrchestrator's twin-session logic.
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");

// One terminal per team-up SESSION (keyed by session name), so minting a second
// instance never closes the first — many team instances run side by side.
const _teamTerminals = new Map<string, vscode.Terminal>();

/** The base tmux session `maw team up <team>` targets by default: the team's
 *  charter.session if a charter yaml declares one, else the team name. Mirrors
 *  maw's resolveCharterPath (<root>/.maw/teams/<t>.yaml, then <root>/ψ/teams/…)
 *  so our "already up" check agrees with the session maw would actually use. */
function baseSessionForTeam(team: string): string {
  const candidates = [
    path.join(SOULBREW_DIR, ".maw", "teams", `${team}.yaml`),
    path.join(SOULBREW_DIR, "ψ", "teams", `${team}.yaml`),
  ];
  for (const file of candidates) {
    try {
      const session = parseCharterSession(fs.readFileSync(file, "utf8"));
      if (session) return session;
    } catch {
      /* try next / fall back to the team name */
    }
  }
  return team;
}

/** ⛔ Removed: a private `try/catch → false` copy of the session probe. It read a
 *  FAILED tmux call as "this name is free", which is how `maw team up` could fire a
 *  second instance into a session another team was already using. The shared
 *  tri-state probe lives in ./tmuxProbe — unknown falls to "taken" here. */

/** Run a command in a terminal once shell integration is ready (or after a short
 *  fallback) so the long-running team-up survives. The fallback matters doubly for
 *  the chat-mode terminal, which is never revealed — if a hidden terminal never
 *  reports shell integration, sendText still delivers the command. */
function runInTerminal(term: vscode.Terminal, command: string): void {
  let done = false;
  const go = () => {
    if (done || term.exitStatus !== undefined) return;
    done = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand(command);
    else term.sendText(command);
  };
  if (term.shellIntegration) {
    go();
  } else {
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) {
        sub.dispose();
        go();
      }
    });
    setTimeout(() => {
      sub.dispose();
      go();
    }, 2500);
  }
}

export interface TeamUpResult {
  error?: string;
  session?: string;
  minted?: boolean;
  /** true → the chat webview was opened; false → an editor terminal is the view.
   *  The caller words its toast from this (where the user should be looking). */
  chat?: boolean;
}

/** Host the bootstrap command and open the view the user picked. Shared by every
 *  team wake path so a new one cannot honour the setting differently. Returns
 *  whether the chat view took it (the caller words its toast from that — the mode
 *  is read ONCE here, so message and reality can never disagree). */
function hostBootstrap(
  context: vscode.ExtensionContext,
  session: string,
  termName: string,
  build: (attach: boolean) => string,
): boolean {
  const chat = getClaudeViewMode() === "chat";
  const prev = _teamTerminals.get(session);
  if (prev && prev.exitStatus === undefined) prev.dispose();
  const term = vscode.window.createTerminal({
    // "log · " marks the chat-mode terminal as the place to read a failed wake —
    // it is not shown, so the name is how the user finds it in the dropdown.
    name: chat ? `log · ${termName}` : termName,
    // chat → default (panel) location and never shown: a bootstrap log, not a view.
    location: chat ? undefined : vscode.TerminalLocation.Editor,
    cwd: SOULBREW_DIR,
  });
  _teamTerminals.set(session, term);
  if (!chat) term.show(false);
  runInTerminal(term, build(!chat));
  // Open the chat NOW rather than on a delay: the panes appear minutes later (a
  // team wake is sequential) and the chat polls for them itself — waiting would
  // only leave the user staring at nothing. `launching` tells it not to probe the
  // pane for `claude` first; at this instant the session is still a `_boot` shell,
  // which would fall back to a terminal and quietly ignore the setting.
  if (chat) void openClaudeView(context, session, { launching: true });
  return chat;
}

/** Shared tail of teamUp/teamUpMember: resolve the target session, build the wake
 *  command for the given roster, and hand it to hostBootstrap. One terminal per
 *  SESSION (a minted instance gets its own) — never touch another instance's. */
function launchTeamSession(
  context: vscode.ExtensionContext,
  team: string,
  members: string[],
  models: Record<string, string>,
  label: string,
): TeamUpResult {
  const base = baseSessionForTeam(team);
  const { session, minted } = resolveInstanceSession(base, (s) => tmuxSessionTaken(s));
  // base = charter.session / team name (safe), + numeric -N suffix → always
  // matches SAFE_SESSION; guard anyway so a hand-edited charter can't inject.
  if (!SAFE_SESSION.test(session)) return { error: `ชื่อ session ไม่ปลอดภัย: ${session}` };

  const chat = hostBootstrap(
    context,
    session,
    `team: ${label}${minted ? ` · ${session}` : ""}`,
    (attach) => buildTeamUpCommand(team, session, SOULBREW_DIR, members, models, attach),
  );
  return { session, minted, chat };
}

/** `maw team up <team>` into a tmux session, shown in the chosen REPL view. Mints
 *  a `-N` instance session when the team's base session is already live. */
export function teamUp(context: vscode.ExtensionContext, team: string): TeamUpResult {
  if (!isSafeTeamName(team)) return { error: `ชื่อทีมไม่ปลอดภัย: ${team}` };
  // Roster → sequential per-member `--only` wakes (see buildTeamUpCommand).
  // Only shell-safe oracle names; unsafe ones are dropped rather than injected.
  const detail = readTeamDetailSync(team);
  const members = detail.members.map((m) => m.oracle).filter((o) => isSafeTeamName(o));
  // Per-member model from the Team Config picker → applied via /model after wake
  // (maw team up can't carry it). Only safe names; buildTeamUpCommand re-guards the value.
  const models: Record<string, string> = {};
  for (const m of detail.members) if (m.oracle && m.model) models[m.oracle] = m.model;
  return launchTeamSession(context, team, members, models, team);
}

/** Wake a single member of the team, same session semantics as teamUp (base
 *  free → use it, base live → mint a fresh `-N` instance) but the roster is
 *  just this one oracle — the rest of the team is untouched. */
export function teamUpMember(
  context: vscode.ExtensionContext,
  team: string,
  oracle: string,
): TeamUpResult {
  if (!isSafeTeamName(team)) return { error: `ชื่อทีมไม่ปลอดภัย: ${team}` };
  if (!isSafeTeamName(oracle)) return { error: `ชื่อ oracle ไม่ปลอดภัย: ${oracle}` };
  const detail = readTeamDetailSync(team);
  const member = detail.members.find((m) => m.oracle === oracle);
  if (!member) return { error: `ไม่พบ '${oracle}' ในทีม '${team}'` };
  const models = member.model ? { [oracle]: member.model } : {};
  return launchTeamSession(context, team, [oracle], models, `${team} · ${oracle}`);
}

/** Wake a freshly-created oracle into the team session (same session semantics as
 *  teamUpMember — only THIS oracle, rest of the team untouched) and fire /awaken
 *  into its pane. The caller (webview handler) has already confirmed with the user
 *  and run prepareAwakenMember (scaffold + invite + charter). One terminal per
 *  session and the same view choice as teamUp. */
export function awakenMember(
  context: vscode.ExtensionContext,
  team: string,
  oracle: string,
): TeamUpResult {
  if (!isSafeTeamName(team)) return { error: `ชื่อทีมไม่ปลอดภัย: ${team}` };
  if (!isSafeTeamName(oracle)) return { error: `ชื่อ oracle ไม่ปลอดภัย: ${oracle}` };
  const base = baseSessionForTeam(team);
  const { session, minted } = resolveInstanceSession(base, (s) => tmuxSessionTaken(s));
  if (!SAFE_SESSION.test(session)) return { error: `ชื่อ session ไม่ปลอดภัย: ${session}` };
  const chat = hostBootstrap(context, session, `awaken: ${oracle}`, (attach) =>
    buildAwakenMemberCommand(team, session, SOULBREW_DIR, oracle, attach),
  );
  return { session, minted, chat };
}
