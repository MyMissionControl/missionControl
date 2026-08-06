import * as vscode from "vscode";

// Which sidebar nav item should glow — decided by the ACTUAL frontmost editor
// tab, not the last thing the user clicked. Only the three panels below light a
// nav item; any other tab (Home/Projects/Budget/a file) clears it. Kept out of
// sidebar.ts so the panel modules never have to depend on the sidebar.

export type NavId = "skills" | "accounts" | "localhosts";

const VIEWTYPE_TO_NAV: Record<string, NavId> = {
  "missioncontrol.skills": "skills",
  "missioncontrol.accounts": "accounts",
  "missioncontrol.localhosts": "localhosts",
};

/** Map an editor tab's webview viewType to a nav id. VS Code can report panel
 *  webview viewTypes with a host prefix (e.g. "mainThreadWebview-missioncontrol.skills"),
 *  so match by substring rather than exact equality. Returns null for anything
 *  that isn't one of the three tracked panels. */
export function navForViewType(viewType: string | undefined): NavId | null {
  const vt = typeof viewType === "string" ? viewType : "";
  for (const key of Object.keys(VIEWTYPE_TO_NAV)) {
    if (vt.indexOf(key) >= 0) return VIEWTYPE_TO_NAV[key];
  }
  return null;
}

type Listener = (nav: NavId | null) => void;
let _active: NavId | null = null;
const _listeners = new Set<Listener>();
let _wired = false;

export function getActiveNav(): NavId | null {
  return _active;
}

export function onActiveNavChange(fn: Listener): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

function activeTabViewType(): string | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const input = tab?.input as { viewType?: unknown } | undefined;
  return input && typeof input.viewType === "string" ? input.viewType : undefined;
}

function recompute(): void {
  const next = navForViewType(activeTabViewType());
  if (next !== _active) {
    _active = next;
    _listeners.forEach((fn) => fn(_active));
  }
}

/** Begin watching the active editor tab. Idempotent — safe to call once at
 *  activation; extra calls are no-ops. */
export function initNavTracking(context: vscode.ExtensionContext): void {
  if (_wired) return;
  _wired = true;
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabGroups(() => recompute()),
    vscode.window.tabGroups.onDidChangeTabs(() => recompute()),
  );
  recompute();
}
