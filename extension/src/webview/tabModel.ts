// What a Mission Control tab looks like in the editor tab bar: which icon it
// carries, and how long its label is allowed to be.
//
// Why this exists: every panel used to open with no icon and a label that could
// run 50 characters ("Claude Chat · agentskill-marketplace-newflow6/brew"). Open
// three of those and the tab bar overflows — VS Code then clips the last tab at
// the scroll edge (and shrinks every tab to 80px if the user set
// `workbench.editor.tabSizing: shrink`), which leaves a tab reading "Ski…" with
// no icon to tell you what it is.
//
// No vscode import on purpose: the mapping is data, and tabModel.test.ts checks
// it against the real source + the real icon files.

/** viewType → icon file base name under media/tabicons/{dark,light}/. */
export const TAB_ICONS: Readonly<Record<string, string>> = {
  "missioncontrol.dashboard": "dashboard",
  "missioncontrol.skills": "skills",
  "missioncontrol.budget": "budget",
  "missioncontrol.budget-detail": "budgetDetail",
  "missioncontrol.teams": "teams",
  "missioncontrol.accounts": "connections",
  "missioncontrol.dataView": "dataView",
  "missioncontrol.localhosts": "localhosts",
  "missioncontrol.settings": "settings",
  "missioncontrol.orchestrator": "projects",
  "missioncontrol.mirror": "chat",
  "missioncontrol.createRequirement": "requirement",
  mcPendingAsk: "ask",
};

export function tabIconFor(viewType: string): string | null {
  return TAB_ICONS[viewType] ?? null;
}

/**
 * A tab label that stays narrow: "Chat · …e-newflow6/brew".
 *
 * The TAIL is kept, not the head — a session or project name is
 * "<long-project-name>/<team>", so the last characters are the ones that tell two
 * tabs apart, while the first ten are the same on every one of them.
 */
export function tabLabel(prefix: string, name: string, max = 20): string {
  const n = (name ?? "").trim();
  const body = n.length > max ? "…" + n.slice(n.length - (max - 1)) : n;
  if (!body) return prefix;
  return prefix ? prefix + " · " + body : body;
}
