// The NATIVE Claude REPL view: a VS Code editor terminal running `tmux attach`.
//
// This logic used to live inline in dashboard.ts's "attach_session" handler. It
// was lifted out unchanged so every caller that wants a native terminal — the
// dashboard rows, the Projects/orchestrator buttons, "Open Claude", and the
// view-mode dispatcher in claudeView.ts — shares ONE implementation and ONE
// terminal registry. Two registries would mean the dashboard reusing a tab the
// orchestrator opened (or not) depending on which button you pressed.
//
// Pure decision helpers (pickAttachAction / sessionClients / buildAttachCommand)
// stay in sessions.ts, which is vscode-free and unit-tested.

import * as cp from "node:child_process";

import * as vscode from "vscode";

import { trackClaudeTerminal } from "../commands/claudeTerminals";
import {
  buildAttachCommand,
  isSafeSessionName,
  parseTmuxSessions,
  pickAttachAction,
  sessionClients,
  TMUX_FMT,
  type TmuxSession,
} from "./sessions";

/** One editor terminal per tmux session, so a second click reveals the tab we
 *  already opened instead of stacking duplicates. Entries are dropped when the
 *  terminal closes (see registerAttachTerminalCleanup). */
const _sessionTerminals = new Map<string, vscode.Terminal>();

/** Wire the close listener once, from activate(). Without it a closed tab stays
 *  in the map and later clicks try to reveal a disposed terminal. */
export function registerAttachTerminalCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      for (const [k, v] of _sessionTerminals) if (v === t) _sessionTerminals.delete(k);
    }),
  );
}

/** The terminal we hold for `session`, if it is still alive. */
export function sessionTerminal(session: string): vscode.Terminal | undefined {
  const t = _sessionTerminals.get(session);
  return t && t.exitStatus === undefined ? t : undefined;
}

/** Forget a session's terminal (used by the kill path, which disposes the tab). */
export function forgetSessionTerminal(session: string): void {
  _sessionTerminals.delete(session);
}

export function listTmuxSessions(): Promise<TmuxSession[]> {
  return new Promise((resolve) => {
    cp.execFile("tmux", ["list-sessions", "-F", TMUX_FMT], { timeout: 700 }, (err, stdout) => {
      // No server / error → treat as zero sessions (not a failure).
      resolve(err ? [] : parseTmuxSessions(stdout.toString()));
    });
  });
}

export interface AttachResult {
  /** false = nothing was opened; the caller should surface why (session gone). */
  ok: boolean;
  reason?: "unsafe-name" | "gone";
}

/**
 * Open (or reveal) a native terminal attached to `session`.
 *
 * `window` optionally selects a tmux window index, so a click on a window row
 * lands on that window rather than wherever the session was left.
 * `tabTitle` is display-only — it never reaches a shell.
 */
export async function attachSessionInTerminal(
  session: string,
  opts: { window?: number; tabTitle?: string } = {},
): Promise<AttachResult> {
  if (!isSafeSessionName(session)) return { ok: false, reason: "unsafe-name" };
  const { window: win, tabTitle } = opts;

  // A terminal we already hold for this session, or an orchestrator tab already
  // pointed at it (opened by "⏮ ทำต่อ" / launchOrchestrator, which titles its
  // terminals `orchestrator: <orch>` for a base session `NN-<orch>`, or
  // `… · <session>` for a twin).
  const orchStem = session.replace(/^\d+-/, "");
  const reusable =
    sessionTerminal(session) ??
    vscode.window.terminals.find(
      (t) =>
        t.exitStatus === undefined &&
        (t.name === `orchestrator: ${orchStem}` || t.name.endsWith(` · ${session}`)),
    );

  // ⛔ "terminal ยังไม่ตาย" ไม่ใช่คำถามที่ถูก — `tmux attach` จบไปได้โดยที่แท็บยัง
  //    เปิดอยู่เป็นเชลล์เปล่า แล้วโค้ดเดิม show() แท็บซากนั้นแล้ว return =
  //    กดแล้วไม่มีอะไรขึ้นตลอดกาล · ถามให้ถูกคือ "เดี๋ยวนี้มี client เกาะ session
  //    อยู่ไหม" แล้วยิง attach ซ้ำลงแท็บเดิมเมื่อไม่มี.
  const action = pickAttachAction(!!reusable, sessionClients(await listTmuxSessions(), session));
  if (action === "gone") return { ok: false, reason: "gone" };

  if (action === "focus") {
    // ⛔ แท็บที่เกาะอยู่แล้วโชว์หน้าต่างเดิม → กด "1:john" แล้วจะไม่มีอะไรเปลี่ยน
    //    (กดแล้วเหมือนไม่ทำงาน) · สั่ง tmux สลับหน้าต่างก่อน show
    if (win !== undefined) {
      await new Promise<void>((resolve) => {
        cp.execFile("tmux", ["select-window", "-t", `=${session}:${win}`], { timeout: 2000 }, () =>
          resolve(),
        );
      });
    }
    reusable!.show(false);
    return { ok: true };
  }

  let term: vscode.Terminal;
  if (action === "reattach") {
    // Typing into the husk is safe here: a tab still RUNNING `tmux attach` would
    // mean clients > 0, which routes to "focus" above — so reaching this branch
    // means that shell is back at a prompt.
    term = reusable!;
    term.show(false);
  } else {
    term = vscode.window.createTerminal({
      name: tabTitle || "tmux: " + session,
      location: vscode.TerminalLocation.Editor,
    });
    _sessionTerminals.set(session, term);
    trackClaudeTerminal(term, session); // context pill follows this attached REPL
    term.show(false);
  }

  const command = buildAttachCommand(session, win);
  let launched = false;
  const launch = () => {
    if (launched || term.exitStatus !== undefined) return;
    launched = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand(command);
    else term.sendText(command);
  };
  if (term.shellIntegration) {
    launch();
  } else {
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) {
        sub.dispose();
        launch();
      }
    });
    setTimeout(() => {
      sub.dispose();
      launch();
    }, 2500);
  }
  return { ok: true };
}
