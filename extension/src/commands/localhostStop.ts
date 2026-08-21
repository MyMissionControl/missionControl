import * as cp from "node:child_process";
import * as fs from "node:fs";

import * as vscode from "vscode";

import { scanLocalhosts, getProjectsRoot, scanMcServices } from "./localhostScan";
import { canKillGroup, buildKillCmd, isProtectedComm } from "./localhostKill";

// Stop-all orchestration for a project's localhost servers. Kept separate from
// localhostKill.ts (the pure guardrails) because this module imports `vscode`,
// which cannot be resolved under `bun test` — the guardrails stay unit-testable.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the group leader's cwd + comm (pid == pgid). Both may be missing. */
function leaderInfo(pgid: number): { cwd: string | null; comm: string } {
  let cwd: string | null = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pgid}/cwd`);
  } catch {
    cwd = null;
  }
  let comm = "";
  try {
    comm = cp.execSync(`ps -o comm= -p ${pgid}`, { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    comm = "";
  }
  return { cwd, comm };
}

/** Distinct, guardrail-approved pgids for a project's current listeners. */
function killablePgids(project: string, projectsRoot: string): number[] {
  const g = scanLocalhosts().find((x) => x.project === project);
  if (!g) return [];
  const pgids = [...new Set(g.entries.map((e) => e.pgid))];
  return pgids.filter((pgid) => {
    const { cwd, comm } = leaderInfo(pgid);
    return canKillGroup(pgid, cwd, comm, projectsRoot);
  });
}

/** TERM every guardrail-approved pgid, wait a grace period, then force-KILL any
 *  that survive. Shared by every stop path; `resurvey` re-lists so the second
 *  pass only force-kills groups still holding a port. */
async function termThenKill(
  pgids: number[],
  resurvey: () => number[],
): Promise<void> {
  for (const pgid of pgids) {
    try {
      cp.execSync(buildKillCmd(pgid, false), { timeout: 3000 });
    } catch {
      /* group may already be gone */
    }
  }
  await sleep(2000);
  for (const pgid of resurvey()) {
    if (!pgids.includes(pgid)) continue;
    try {
      cp.execSync(buildKillCmd(pgid, true), { timeout: 3000 });
    } catch {
      /* best effort */
    }
  }
}

/** Kill a project's servers WITHOUT a native modal — the Localhosts panel
 *  inline-confirms on its own button, so a second confirm would be redundant. */
export async function stopGroupLocalhosts(project: string): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;
  await termThenKill(killablePgids(project, projectsRoot), () =>
    killablePgids(project, projectsRoot),
  );
}

/** Kill the process group holding a single port (inline-confirmed client-side).
 *  Note: kill is process-group scoped, so if two ports share one pgid this stops
 *  both — that's the same safe mechanism the group stop uses. */
export async function stopPortLocalhost(port: number): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;
  let target: { pgid: number } | undefined;
  for (const g of scanLocalhosts()) {
    const e = g.entries.find((x) => x.port === port);
    if (e) { target = e; break; }
  }
  if (!target) return;
  const { cwd, comm } = leaderInfo(target.pgid);
  if (!canKillGroup(target.pgid, cwd, comm, projectsRoot)) return;
  const pgid = target.pgid;
  await termThenKill([pgid], () =>
    scanLocalhosts().flatMap((g) => g.entries.map((e) => e.pgid)),
  );
}

/** Stop an MC-managed service (e.g. the CCS dashboard) by the port it listens on.
 *  scanMcServices only returns our own vendored processes (args-signature guard in
 *  classifyMcService), so a port found there is safe to stop; we still refuse if the
 *  pgid leader is a protected process (shell/editor/tmux). No project scoping — these
 *  run outside any project, which is exactly why the normal stopPort path can't. */
export async function stopMcServiceByPort(port: number): Promise<void> {
  const svc = scanMcServices().flatMap((g) => g.ports).find((p) => p.port === port);
  if (!svc) return;
  const { comm } = leaderInfo(svc.pgid);
  if (isProtectedComm(comm)) return;
  await termThenKill([svc.pgid], () =>
    scanMcServices().flatMap((g) => g.ports.map((p) => p.pgid)),
  );
}

/** Kill every listed server across all projects (inline-confirmed client-side). */
export async function stopAllLocalhosts(): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;
  const projects = scanLocalhosts().map((g) => g.project);
  const pgids = [
    ...new Set(projects.flatMap((p) => killablePgids(p, projectsRoot))),
  ];
  await termThenKill(pgids, () =>
    projects.flatMap((p) => killablePgids(p, projectsRoot)),
  );
}

/** Confirm, then TERM every process group of the project's servers; force-KILL
 *  survivors after a grace period. Bounded to the project by process group +
 *  cwd/comm guardrails — cannot reach VS Code / tmux / the shell. Kept for
 *  non-panel callers that want a native confirmation modal. */
export async function stopProjectLocalhosts(project: string): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;

  const group = scanLocalhosts().find((x) => x.project === project);
  if (!group || group.entries.length === 0) {
    void vscode.window.showInformationMessage(
      `Mission Control: nothing running for ${project}.`,
    );
    return;
  }

  const portList = group.entries.map((e) => `:${e.port}`).join(" ");
  const choice = await vscode.window.showWarningMessage(
    `Stop ${group.entries.length} server(s) in ${project}?  (${portList})`,
    { modal: true },
    "Stop all",
  );
  if (choice !== "Stop all") return;

  await termThenKill(killablePgids(project, projectsRoot), () =>
    killablePgids(project, projectsRoot),
  );

  void vscode.window.showInformationMessage(`Mission Control: stopped ${project}.`);
}
