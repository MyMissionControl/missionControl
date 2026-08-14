import * as vscode from "vscode";

import { accountsCommand } from "./commands/accountsPanel";
import { approveCommand } from "./commands/approve";
import { budgetCommand } from "./commands/budget";
import { attachToClaudeCommand, pasteImageToClaudeCommand } from "./commands/attachToClaude";
import { attachToFocusedClaudeCommand, initAttachStatusBar } from "./commands/attachStatusBar";
import { claudeCommand } from "./commands/claude";
import { initClaudeTerminalRegistry } from "./commands/claudeTerminals";
import { dashboardCommand } from "./commands/dashboard";
import { installCommand } from "./commands/install";
import { localhostsCommand } from "./commands/localhostsPanel";
import { mawToggleCommand } from "./commands/mawServe";
import { openObsidianCommand } from "./commands/openObsidian";
import { initPendingAskWatch, pendingAskCommand } from "./commands/pendingAskWatch";
import { settingsCommand } from "./commands/settingsPanel";
import { setupCommand } from "./commands/setup";
import { skillsCommand } from "./commands/skills";
import { teamsCommand } from "./commands/teamsPanel";
import { startCommand } from "./commands/start";
import { startOrchestratorCommand } from "./commands/startOrchestrator";
import { statusCommand } from "./commands/status";
import { terminalCommand } from "./commands/terminal";
import { PROJECT_STATE_KEY, setCurrentProjectId } from "./projectState";
import { registerStatusBar } from "./statusBar";
import { openBudgetPanel } from "./webview/budget";
import { openCreateRequirementPanel } from "./webview/createRequirement";
import { openDataViewPanel } from "./webview/dataView";
import { openMirrorPanel } from "./webview/mirror";
import { openOrchestratorPanel } from "./webview/orchestrator";
import { registerSidebar } from "./webview/sidebar";
import { initTabIcons } from "./webview/tabIcon";

export function activate(context: vscode.ExtensionContext) {
  // Restore the last-used project_id from the workspace's globalState BEFORE
  // wiring up the sidebar — so the project dropdown renders already pointing
  // at the right project. Without this, the user sees an empty dropdown for a
  // beat on startup.
  const savedPid = context.globalState.get<string | null>(PROJECT_STATE_KEY, null);
  if (savedPid) setCurrentProjectId(savedPid);

  // Where the per-panel tab icons live. Must run before any panel opens.
  initTabIcons(context.extensionUri);

  const registrations: vscode.Disposable[] = [
    vscode.commands.registerCommand("missioncontrol.install", () => installCommand(context)),
    vscode.commands.registerCommand("missioncontrol.setup", () => setupCommand(context)),
    vscode.commands.registerCommand("missioncontrol.start", () => startCommand(context)),
    vscode.commands.registerCommand("missioncontrol.status", () => statusCommand(context)),
    vscode.commands.registerCommand("missioncontrol.approve", () => approveCommand(context)),
    vscode.commands.registerCommand("missioncontrol.budget", () => budgetCommand(context)),
    // Dashboard's Budget tile opens the full page directly via this; the QuickPick
    // (missioncontrol.budget) stays for the command palette + cap-warning action.
    vscode.commands.registerCommand("missioncontrol.budgetPanel", () => openBudgetPanel()),
    // Cross-project Data View — project status parsed from each project's .md docs
    // (table / kanban / timeline). Opened from a Project Detail button + palette.
    vscode.commands.registerCommand("missioncontrol.dataView", () => openDataViewPanel()),
    // Draft the requirement .md that gets handed to /orches: templated textarea,
    // a `claude -p` review answered one question at a time, and a save that turns
    // the button into Copy-absolute-path until the draft is edited.
    vscode.commands.registerCommand("missioncontrol.createRequirement", () =>
      openCreateRequirementPanel(context),
    ),
    // Refresh the project vault (one folder per project) and launch Obsidian on it.
    vscode.commands.registerCommand("missioncontrol.openObsidian", () => openObsidianCommand()),
    vscode.commands.registerCommand("missioncontrol.skills", () => skillsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.teams", () => teamsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.accounts", () => accountsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.localhosts", () => localhostsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.settings", () => settingsCommand(context)),
    vscode.commands.registerCommand("missioncontrol.dashboard", () => dashboardCommand(context)),
    // Opens the REPL in whichever view Settings says (หน้าตา Claude REPL, default chat).
    vscode.commands.registerCommand("missioncontrol.claude", () => claudeCommand(context)),
    // ── The two ALWAYS-<x> escape hatches, so neither view can become unreachable
    //    whatever the setting is. Everything else routes through webview/claudeView.ts.
    // Always the chat webview (transcript-backed, Thai-safe composer, file attach).
    vscode.commands.registerCommand("missioncontrol.mirror", () => openMirrorPanel(context)),
    // Always a real terminal (full TUI: Esc / Ctrl-C / Shift+Tab / the / and @ menus).
    vscode.commands.registerCommand("missioncontrol.claudeNative", () => claudeCommand(context, true)),
    // Attach a file/image to a live Claude REPL: pick it in VS Code, type its
    // absolute path into the tmux pane; Claude Code reads it from disk.
    vscode.commands.registerCommand("missioncontrol.attachToClaude", () => attachToClaudeCommand()),
    // Paste an image off the OS clipboard into the Claude REPL (saves to a temp
    // file, injects its path). VS Code clipboard is text-only, so this shells
    // out to xclip/wl-paste.
    vscode.commands.registerCommand("missioncontrol.pasteImageToClaude", () => pasteImageToClaudeCommand()),
    // Paperclip button (status bar) → attach file(s) to the focused Claude REPL
    // via the native dialog. (Context lives in each REPL's own in-pane statusLine
    // bar; there is deliberately no VS Code context pill — see statusline-context.mjs.)
    vscode.commands.registerCommand("missioncontrol.attachToFocusedClaude", () => attachToFocusedClaudeCommand()),
    vscode.commands.registerCommand("missioncontrol.mawToggle", () => mawToggleCommand(context)),
    vscode.commands.registerCommand("missioncontrol.terminal", () => terminalCommand(context)),
    vscode.commands.registerCommand("missioncontrol.startOrchestrator", () => startOrchestratorCommand(context)),
    vscode.commands.registerCommand("missioncontrol.orchestratorContinue", () =>
      openOrchestratorPanel(context),
    ),
    // "N รอตอบ" in the status bar → re-open the choice box of whichever agent is
    // blocked on an AskUserQuestion (also recovers one dismissed with Esc).
    vscode.commands.registerCommand("missioncontrol.pendingAsk", () => pendingAskCommand()),
  ];
  context.subscriptions.push(...registrations);

  registerStatusBar(context);
  registerSidebar(context);
  // Terminal→session registry + the paperclip attach button. (No context pill —
  // context is shown in each REPL's own in-pane statusLine bar.)
  initClaudeTerminalRegistry(context);
  initAttachStatusBar(context);
  // Poll every live Claude pane's SCREEN for an open choice box and pop it as a
  // native QuickPick — the agents ask inside tmux, where nothing else in VS Code
  // was ever going to show it. (The transcript is not usable for this: Claude
  // Code only writes the ask once it has been answered — see pendingAsk.ts.)
  initPendingAskWatch(context);
}

export function deactivate() {}
