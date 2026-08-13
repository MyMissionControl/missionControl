import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  type ClaudeTarget,
  buildClaudeDetachedArgs,
  buildClaudeTmuxCommand,
  projectSessionName,
} from "./claudeSessions";
import { trackClaudeTerminal } from "./claudeTerminals";
import { getClaudeViewMode } from "./settingsOps";
import { tmuxHasSession } from "./startOrchestrator";
import { openClaudeView } from "../webview/claudeView";

// "Open Claude" pops a picker of targets, then opens Claude Code CLI inside a
// tmux session in the EDITOR area. Running inside tmux means closing the tab
// only DETACHES — claude keeps running, shows up in the dashboard Sessions
// panel, and re-picking (or clicking it in the panel) re-attaches the same
// session. The targets are:
//   • soulbrew (orchestrator) — cwd ~/Desktop/soulbrew, the workbench brain
//   • each built project under github.com/fufu-2345/projects/*
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");
// All built software lives under this single root (see the project-consolidation
// commit). Add more roots here if the convention ever grows.
const PROJECT_ROOTS = [path.join(SOULBREW_DIR, "github.com", "fufu-2345", "projects")];

// Reuse one editor terminal per tmux session so repeated picks focus the open
// tab instead of stacking duplicates.
const _claudeTerminals = new Map<string, vscode.Terminal>();
let _cleanupRegistered = false;

/** soulbrew (orchestrator) followed by each immediate sub-directory of the
 *  project roots, alphabetical. Skips files, dotfiles, and the "ψ" oracle
 *  marker. Missing roots are ignored. */
function discoverTargets(): ClaudeTarget[] {
  const targets: ClaudeTarget[] = [
    { label: "soulbrew (orchestrator)", cwd: SOULBREW_DIR, session: "claude-soulbrew" },
  ];
  const seen = new Set<string>();
  for (const root of PROJECT_ROOTS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist — skip
    }
    const names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith(".") && n !== "ψ")
      .sort();
    for (const name of names) {
      if (seen.has(name)) continue; // de-dupe across roots
      seen.add(name);
      targets.push({ label: name, cwd: path.join(root, name), session: projectSessionName(name) });
    }
  }
  return targets;
}

/**
 * "Open Claude" — pick a project, then open its REPL in whichever view the user
 * chose (Settings → หน้าตา Claude REPL; default = our chat).
 *
 * `forceNative` is the always-terminal escape hatch behind
 * missioncontrol.claudeNative, so a raw TUI stays reachable in chat mode.
 */
export async function claudeCommand(context: vscode.ExtensionContext, forceNative = false) {
  // Drop closed terminals from the reuse map (registered once per session).
  if (!_cleanupRegistered) {
    _cleanupRegistered = true;
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [k, v] of _claudeTerminals) {
          if (v === t) _claudeTerminals.delete(k);
        }
      }),
    );
  }

  const targets = discoverTargets();
  const pick = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: t.label, description: t.cwd, target: t })),
    { placeHolder: "เปิด Claude ใน tmux — เลือก project (soulbrew = orchestrator)" },
  );
  if (!pick) return; // cancelled
  const { session, cwd } = pick.target;

  // Chat mode: the webview can only MIRROR a session, so bring it up headless
  // (create-or-noop, detached) and then open the chat on it. A tmux failure
  // falls through to the terminal path rather than leaving the user with nothing.
  if (!forceNative && getClaudeViewMode() === "chat") {
    let up = false;
    try {
      cp.execFileSync("tmux", buildClaudeDetachedArgs(session, cwd), { stdio: "ignore" });
      up = true;
    } catch {
      up = tmuxHasSession(session); // `-A` races another opener → fine if it exists now
    }
    if (up) {
      await openClaudeView(context, session);
      return;
    }
    void vscode.window.showWarningMessage(
      `เปิด session '${session}' แบบ headless ไม่สำเร็จ — เปิดเป็น terminal ให้แทน`,
    );
  }

  // Reuse a still-open terminal for this session instead of stacking tabs.
  const existing = _claudeTerminals.get(session);
  if (existing && existing.exitStatus === undefined) {
    existing.show(false);
    return;
  }

  const term = vscode.window.createTerminal({
    name: "tmux: " + session,
    location: vscode.TerminalLocation.Editor, // main editor area, not the panel
  });
  _claudeTerminals.set(session, term);
  trackClaudeTerminal(term, session); // so the context pill can follow this REPL
  term.show(false);

  // Run the tmux create-or-attach command exactly once, cleanly. Sending text
  // into a freshly-created terminal races the shell's first prompt and gets
  // echoed TWICE; shell integration waits until the shell is ready and runs it
  // once. Fall back to a delayed sendText if shell integration never inits.
  const command = buildClaudeTmuxCommand(session, cwd);
  let launched = false;
  const launch = () => {
    if (launched || term.exitStatus !== undefined) return;
    launched = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand(command);
    else term.sendText(command);
  };

  if (term.shellIntegration) {
    launch();
    return;
  }
  const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
    if (e.terminal === term) {
      sub.dispose();
      launch();
    }
  });
  // Shell integration disabled/unavailable → send after the prompt has had
  // time to render (the delay is what avoids the double-echo race).
  setTimeout(() => {
    sub.dispose();
    launch();
  }, 2500);
}
