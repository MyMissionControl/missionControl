import * as vscode from "vscode";

import { openTeamsPanel } from "../webview/teams";

/** Open the Teams panel (browse + edit maw oracle-teams). Thin wrapper mirroring
 *  skillsCommand — the real work lives in webview/teams.ts. */
export async function teamsCommand(context: vscode.ExtensionContext): Promise<void> {
  try {
    // context is threaded through: the team-up buttons open the chosen Claude REPL
    // view, and the chat webview needs it for its media root.
    openTeamsPanel(context, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Teams failed — ${msg}`);
  }
}
