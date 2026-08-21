const PROTECTED_COMM = new Set([
  "code",
  "tmux",
  "tmux: server",
  "bash",
  "-bash",
  "zsh",
  "-zsh",
  "sh",
  "-sh",
  "login",
  "systemd",
  "init",
]);

/** Never signal a shell, the editor, tmux, or init. */
export function isProtectedComm(comm: string): boolean {
  return PROTECTED_COMM.has(comm.trim());
}

/** A process group is safe to kill only if it is a real group (pgid>1), its
 *  leader is not a protected process, and — when the leader is still readable —
 *  its cwd is under the projects root. A missing leader (reparented/exited) is
 *  allowed because the group was discovered via a listener whose cwd was already
 *  confirmed inside the project. */
export function canKillGroup(
  pgid: number,
  leaderCwd: string | null,
  leaderComm: string,
  projectsRoot: string,
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (leaderComm && isProtectedComm(leaderComm)) return false;
  if (leaderCwd) {
    const prefix = projectsRoot.replace(/\/+$/, "") + "/";
    if (!leaderCwd.startsWith(prefix)) return false;
  }
  return true;
}

/** Signal the whole process group: `kill -SIG -<pgid>`. */
export function buildKillCmd(pgid: number, force: boolean): string {
  return `kill -${force ? "KILL" : "TERM"} -${pgid}`;
}

// ── MC-managed services (surfaced + stoppable even though they run OUTSIDE a
//    project, e.g. the CCS dashboard opened from the Connections page) ─────────

export type McService = { id: string; label: string };

/** Recognise a listener as an MC-managed service from its process args. The
 *  signature is deliberately narrow — only OUR own vendored/caged install — so we
 *  never surface or stop an unrelated process. cwd is irrelevant (these run from
 *  home / the workspace, not a project); the args signature is the whole guard. */
export function classifyMcService(args: string): McService | null {
  const s = (args || "").toLowerCase();
  // contained caged CCS lives only here (see ccsLaunch.ts / docs/ccs-evaluation-*)
  if (s.includes("/.mc/vendor/ccs/")) return { id: "ccs", label: "CCS dashboard" };
  return null;
}

/** Safe to stop an MC service group: a real group whose leader is not a protected
 *  process AND whose args match a known MC service. Unlike canKillGroup this does
 *  NOT require a project cwd — the args signature replaces that guard. */
export function canKillMcService(pgid: number, leaderComm: string, args: string): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (leaderComm && isProtectedComm(leaderComm)) return false;
  return classifyMcService(args) !== null;
}
