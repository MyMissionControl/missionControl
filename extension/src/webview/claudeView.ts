// THE one place that answers "which face do we put on this Claude REPL?".
//
// Two views exist:
//   chat   — our transcript-backed webview (mirror.ts). Thai renders, emoji are
//            stripped, files can be attached/dropped, /compact is a button.
//   native — a VS Code terminal running `tmux attach` (attachTerminal.ts). Full
//            TUI: Esc, Ctrl-C, Shift+Tab, the / and @ menus, real scrollback.
//
// The user picks in Mission Control Settings (claude_view_mode, default "chat").
// Every ambiguous "open the REPL" call site must go through openClaudeView so
// the setting cannot be honoured in some places and ignored in others. The two
// EXPLICIT commands are the deliberate exceptions: missioncontrol.mirror always
// chats, missioncontrol.claudeNative always opens a terminal — escape hatches so
// neither view becomes unreachable whatever the setting says.

import * as cp from "node:child_process";

import * as vscode from "vscode";

import { getClaudeViewMode } from "../commands/settingsOps";
import { attachSessionInTerminal } from "./attachTerminal";
import { openMirrorPanel } from "./mirror";
import { isMirrorableSession, isSafeSessionName, parseTmuxSessions, TMUX_FMT } from "./sessions";

/** Can the chat webview actually render this session, or would it open empty?
 *  Bare shells / `maw` windows have no claude transcript to show. Unknown or
 *  unlistable → assume yes and let the chat's own empty-state explain, rather
 *  than silently overriding the user's choice on a tmux hiccup. */
function chatCanRender(session: string): boolean {
  let raw = "";
  try {
    raw = cp.execFileSync("tmux", ["list-sessions", "-F", TMUX_FMT], {
      encoding: "utf8",
      timeout: 700,
    });
  } catch {
    return true;
  }
  const row = parseTmuxSessions(raw).find((s) => s.name === session);
  return row ? isMirrorableSession(row, isSafeSessionName) : true;
}

export interface OpenClaudeViewOpts {
  /** tmux window index to land on — native only (the chat shows every pane). */
  window?: number;
  /** Editor-tab title for the native terminal. Display-only, never shelled. */
  tabTitle?: string;
  /**
   * "I am launching claude into this session right now." Skips the can-the-chat-
   * render-it probe, which asks what the pane is running AT THIS INSTANT — during
   * a bootstrap that is still a shell (`_boot`, a `maw team up` in flight), so the
   * probe would fall back to a terminal and silently ignore the user's setting.
   * Only for callers that just fired the launch; never for "open whatever is
   * there" surfaces like the dashboard Sessions list.
   */
  launching?: boolean;
}

/**
 * Open the Claude REPL for `session` in whichever view the user chose.
 *
 * Returns false only when NOTHING was opened (bad name, or the session is gone);
 * the caller owns the user-facing message, since the wording differs per surface.
 */
export async function openClaudeView(
  context: vscode.ExtensionContext,
  session: string,
  opts: OpenClaudeViewOpts = {},
): Promise<boolean> {
  if (!isSafeSessionName(session)) return false;

  // A session the chat cannot render falls back to a terminal REGARDLESS of the
  // setting — an empty chat panel reads as a broken button, and this is exactly
  // the case the dashboard Sessions list can hand us (it lists every session,
  // not just claude ones).
  const mode = getClaudeViewMode();
  if (mode === "chat" && (opts.launching || chatCanRender(session))) {
    await openMirrorPanel(context, session);
    return true;
  }
  const r = await attachSessionInTerminal(session, { window: opts.window, tabTitle: opts.tabTitle });
  return r.ok;
}

/** Fire-and-forget variant for launch paths that must not block the UI, and that
 *  need the tmux session to finish coming up first (panes appear a beat after
 *  the session does). Mirrors the old openChatDeferred timing. */
export function openClaudeViewDeferred(
  context: vscode.ExtensionContext,
  session: string,
  opts: OpenClaudeViewOpts = {},
  delayMs = 800,
): void {
  setTimeout(() => {
    void openClaudeView(context, session, opts);
  }, delayMs);
}
