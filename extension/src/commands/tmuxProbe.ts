// Does a tmux session exist — with "we could not find out" kept SEPARATE from "no".
// NO vscode import: unit-tested standalone with `bun test`.
//
// ⛔⛔ Why this module exists. Three copies of the same probe lived in
// startOrchestrator.ts, teamUp.ts and webview/mirror.ts, all shaped like:
//
//     try { cp.execFileSync("tmux", ["has-session", "-t", `=${s}`]); return true }
//     catch { return false }
//
// so "tmux says there is no such session", "tmux is not installed", "the box is too
// loaded to fork", and "the child was killed" all answered `false`. Eleven call sites
// read that `false` — and for five of them `false` means "this NAME is free", which
// makes MC launch a second orchestrator into a session another run is already driving;
// for the ✕ button it means "it really died", so MC reports ปิดแล้ว and drops the
// attach terminal while the session lives; and for the orchestrator panel's poll it
// means "the run died on its own", which is the one that can destroy live work.
//
// A destructive or irreversible decision must never be driven by a probe that failed.
// So: three states, and the caller picks which way "unknown" should fall.
import * as cp from "node:child_process";

export type SessionState = "present" | "absent" | "unknown";

/** tmux can only ever hold a session whose name looks like this. */
const SAFE_NAME = /^[\w.-]+$/;

/** Run `tmux has-session` for real. Throws exactly like `execFileSync`. */
function realProbe(session: string): string {
  return String(
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
      encoding: "utf8",
    }) ?? "",
  );
}

/**
 * Read an `execFileSync` failure: did tmux ANSWER, or did we never get an answer?
 *
 * `has-session` exits **1** to say "not there" (that covers `can't find session` and
 * `no server running` — no server means no session, which is still an answer).
 * Anything else is us failing to ask: `ENOENT` (no tmux in PATH), a `null` status
 * (killed by a signal or the 2s timeout), or any other exit code.
 */
export function sessionStateFromError(err: unknown): SessionState {
  const e = (err ?? {}) as { status?: number | null; code?: unknown; signal?: unknown };
  return e.status === 1 ? "absent" : "unknown";
}

/**
 * present | absent | unknown for one session name.
 *
 * `probe` is injectable so the decision logic is testable without tmux.
 * An unsafe name returns **unknown**, never absent: absent reads as "the name is
 * free" at the minting call sites, and a name tmux can never hold must not be handed
 * to `new-session`.
 */
export function tmuxSessionState(session: string, probe: (s: string) => string = realProbe): SessionState {
  if (!session || !SAFE_NAME.test(session)) return "unknown";
  try {
    probe(session);
    return "present";
  } catch (e) {
    return sessionStateFromError(e);
  }
}

/**
 * "Assume it is in use unless tmux told us it is not" — for choosing a session NAME.
 *
 * Fail-safe direction: a wrong `true` costs a `-2` suffix on a name; a wrong `false`
 * stacks a second team into a live session (and skips `twinKickoffNote`, so two
 * instances of one oracle then write the same ψ files with no provenance tag).
 */
export function tmuxSessionTaken(session: string, probe?: (s: string) => string): boolean {
  return tmuxSessionState(session, probe) !== "absent";
}

/** "tmux confirmed it is gone" — the only state that may drive a cleanup/teardown. */
export function tmuxSessionFree(session: string, probe?: (s: string) => string): boolean {
  return tmuxSessionState(session, probe) === "absent";
}
