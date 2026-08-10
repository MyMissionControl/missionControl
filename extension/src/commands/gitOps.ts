import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { type GitRawStatus } from "./gitStatus";

// Extension-side git/gh/claude runners for the resume list's per-project action
// buttons. Everything uses execFile with an ARG ARRAY (never a shell string), so
// a repo path or commit message can't inject. All are best-effort: a failure
// resolves to a typed error the caller surfaces to the webview, never throws.

const GIT_TIMEOUT = 8000;
const FETCH_TIMEOUT = 20000;
const CLAUDE_TIMEOUT = 60000;
// Staging a whole project can genuinely take a while (big worktrees, cold page
// cache). Killing a write mid-flight is what orphans .git/index.lock, so the
// write path gets a lot more room than the read polls.
const WRITE_TIMEOUT = 60000;
// A lock this old with no live git in the repo can only be an orphan.
const STALE_LOCK_MS = 30000;

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** true when the child was killed (execFile `timeout` fired), not when it
   *  exited non-zero. A kill usually leaves stderr empty, so the failure toast
   *  has to say "timeout" itself or it reads as a blank error. */
  killed: boolean;
}

export function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = cp.execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
        // undefined → child inherits process.env; an object REPLACES it, so
        // callers wanting extra vars must spread process.env themselves.
        env: opts.env,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          killed: !!(err as { killed?: boolean } | null)?.killed,
        });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

// GIT_OPTIONAL_LOCKS=0 is the whole reason the status polls are safe to kill:
// without it `git status` rewrites the index to refresh its stat cache, so it
// holds .git/index.lock — and a poll SIGTERM'd at its timeout leaves that lock
// behind, which then blocks every commit in the repo forever (status keeps
// working, so the row still says "Commit (N)"). Mandatory locks (add, commit)
// are unaffected by this env var.
const git = (dir: string, args: string[], timeout?: number) =>
  run("git", ["-C", dir, ...args], {
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

// Lines git emits BEFORE the actual error: the advice block, the push banner,
// the fetch summary and transfer progress. Taking stderr line 1 (what the
// failure toast used to do) almost always lands on one of these instead of the
// reason — e.g. a failed ff-pull reported "hint: Diverging branches can't be
// fast-forwarded…" and a rejected push reported nothing but the repo URL.
const GIT_NOISE =
  /^(hint:|remote:|To\s|From\s|Fetching\s|Aborting\b|Please\s|(Enumerating|Counting|Compressing|Writing|Receiving|Resolving|Unpacking|Total)\b)/;

/** The one line of a failed git run that actually says what went wrong.
 *  Priority: the `! [rejected]` refspec line (push) > `fatal:` > `error:` >
 *  the first non-noise line. When the chosen line ends in ':' git put the
 *  detail (usually the offending file names) on the indented lines below it,
 *  so those get folded in — "would be overwritten by merge:" alone is useless.
 *  Returns "" only when git said nothing at all. */
export function gitErrorLine(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  const signal = lines.filter((l) => !GIT_NOISE.test(l.trim()));
  const from = signal.length ? signal : lines;
  const pick =
    from.find((l) => /^!\s*\[(rejected|remote rejected)\]/.test(l.trim())) ??
    from.find((l) => /^fatal:/.test(l)) ??
    from.find((l) => /^error:/.test(l)) ??
    from[0];
  if (pick === undefined) {
    return r.killed ? "หมดเวลา (timeout) — git ถูกหยุดกลางคัน ลองใหม่อีกครั้ง" : "";
  }
  let out = pick.trim();
  if (out.endsWith(":")) {
    const detail = lines
      .slice(lines.indexOf(pick) + 1)
      .filter((l) => /^\s+\S/.test(l))
      .slice(0, 4)
      .map((l) => l.trim());
    if (detail.length) out += ` ${detail.join(", ")}`;
  } else if (!/[.)!?]$/.test(out)) {
    // git hard-wraps long messages, so the reason can be split across lines
    // ("…with the ref 'refs/heads/main'" / "from the remote, but no such ref
    // was fetched."). Line 1 on its own is a sentence fragment.
    for (const next of from.slice(from.indexOf(pick) + 1, from.indexOf(pick) + 3)) {
      if (/^(fatal:|error:|!\s*\[)/.test(next.trim())) break;
      out += ` ${next.trim()}`;
      if (/[.)!?]$/.test(out)) break;
    }
  }
  return out.slice(0, 300);
}

const indexLock = (dir: string) => path.join(dir, ".git", "index.lock");

/** Best-effort: is a live `git` actually working in this repo right now?
 *  Linux /proc only — elsewhere we fall back to the age check alone. */
function gitRunningIn(dir: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return false; // no procfs → cannot tell, rely on mtime age
  }
  for (const pid of pids) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "git") continue;
      if (fs.readlinkSync(`/proc/${pid}/cwd`) === real) return true; // `git -C dir` chdirs
    } catch {
      /* process exited mid-scan, or not ours to read — ignore */
    }
  }
  return false;
}

const isIndexLockError = (r: RunResult) => /index\.lock/.test(r.stderr + r.stdout);

/** Remove an ORPHANED index.lock — never one that something may still hold.
 *  Returns true only when a lock was actually reaped. */
function reapStaleIndexLock(dir: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - fs.statSync(indexLock(dir)).mtimeMs;
  } catch {
    return false; // gone already (or unreadable) → nothing to reap
  }
  if (ageMs < STALE_LOCK_MS || gitRunningIn(dir)) return false;
  try {
    fs.unlinkSync(indexLock(dir));
    return true;
  } catch {
    return false;
  }
}

/** An index-writing git call that heals itself once past an orphaned lock. */
async function writeGit(dir: string, args: string[], timeout = WRITE_TIMEOUT): Promise<RunResult> {
  const first = await git(dir, args, timeout);
  if (first.ok || !isIndexLockError(first) || !reapStaleIndexLock(dir)) return first;
  return git(dir, args, timeout);
}

/** ms since this repo last ran `git fetch`/`git pull`, from FETCH_HEAD's mtime
 *  (git rewrites it on every fetch). undefined when it has never fetched, or
 *  when `.git` is a worktree pointer file rather than a real dir. Cheap: one
 *  stat, no git process — this runs on every render tick. */
function lastFetchAgeMs(dir: string): number | undefined {
  try {
    return Date.now() - fs.statSync(path.join(dir, ".git", "FETCH_HEAD")).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Gather the raw git facts parseGitButtonState needs. Never throws. */
export async function readGitStatus(dir: string): Promise<GitRawStatus> {
  const off: GitRawStatus = {
    isRepo: false,
    porcelain: "",
    hasRemote: false,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
  };
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return off;

  const [porc, remotes, upstream] = await Promise.all([
    git(dir, ["status", "--porcelain", "-uall"]),
    git(dir, ["remote"]),
    git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);
  const hasRemote = remotes.stdout.trim().length > 0;
  const hasUpstream = upstream.ok && upstream.stdout.trim().length > 0;
  let ahead = 0;
  let behind = 0;
  if (hasUpstream) {
    const lr = await git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (lr.ok) {
      const m = lr.stdout.trim().split(/\s+/);
      behind = parseInt(m[0] ?? "0", 10) || 0;
      ahead = parseInt(m[1] ?? "0", 10) || 0;
    }
  }
  return {
    isRepo: true,
    porcelain: porc.stdout,
    hasRemote,
    hasUpstream,
    ahead,
    behind,
    staleMs: lastFetchAgeMs(dir),
  };
}

/** `git fetch` (quiet) so ahead/behind is accurate. Best-effort. */
export function fetchRepo(dir: string): Promise<RunResult> {
  return git(dir, ["fetch", "--quiet"], FETCH_TIMEOUT);
}

/** Initialize a non-repo project dir as a git repo on `main`. Leaves files
 *  untracked so the row becomes "Commit (N)" for the user to commit next. */
export function gitInit(dir: string): Promise<RunResult> {
  return git(dir, ["init", "-b", "main"]);
}

/** Stage everything + commit with the given message (arg array — no shell).
 *  Both steps write the index, so both go through writeGit: a stale lock left
 *  by an earlier killed git is reaped and the step retried once. A lock that
 *  something still holds is reported as-is, never stolen. */
export async function commitAll(dir: string, message: string): Promise<RunResult> {
  const add = await writeGit(dir, ["add", "-A"]);
  if (!add.ok) return add;
  return writeGit(dir, ["commit", "-m", message]);
}

/** Fast-forward pull. `--ff-only` refuses (harmless error) if the branch can't
 *  advance cleanly — but the UI only offers Pull on a clean, strictly-behind
 *  tree, so in practice it always fast-forwards without a merge or conflict.
 *  Goes through writeGit for the same reason commitAll does: a fast-forward
 *  writes the index, so a pull killed at its timeout can orphan .git/index.lock
 *  and then every later git in that repo fails. Same timeout as before. */
export function pullRepo(dir: string): Promise<RunResult> {
  return writeGit(dir, ["pull", "--ff-only"], FETCH_TIMEOUT);
}

/** Push current branch. Sets upstream on first push when none is configured.
 *  No upstream can also mean a DETACHED head (`@{u}` fails either way), where
 *  `push -u origin HEAD` dies on "not a full refname" — a message that reads
 *  like a bug in Mission Control. Name the branch explicitly and refuse early
 *  when there isn't one. For a normal branch this is the same push as before. */
export async function pushRepo(dir: string, hasUpstream: boolean): Promise<RunResult> {
  if (hasUpstream) return git(dir, ["push"], FETCH_TIMEOUT);
  const head = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = head.stdout.trim();
  if (!branch) {
    return {
      ok: false,
      stdout: "",
      stderr: "error: HEAD ไม่ได้ชี้ที่ branch ใด (detached HEAD) — checkout branch ก่อนถึงจะ push ได้",
      killed: false,
    };
  }
  return git(dir, ["push", "-u", "origin", branch], FETCH_TIMEOUT);
}

/** Create a GitHub repo from this local repo and push (external — caller
 *  confirms first). Uses gh; requires gh auth.
 *
 *  The single "Create & Push" button folds in the old "Git init" step, so this
 *  may be handed a bare folder OR a repo with no commit yet. `gh repo create
 *  --push` needs a branch to push, so ensure a local repo with ≥1 commit first:
 *  `git init` if not a repo, then an initial commit if HEAD is still unborn.
 *  (orches projects arrive already inited + committed → both checks are no-ops.) */
export async function createAndPush(
  dir: string,
  repoName: string,
  isPrivate: boolean,
): Promise<RunResult> {
  const status = await readGitStatus(dir);
  if (!status.isRepo) {
    const init = await gitInit(dir);
    if (!init.ok) return init;
  }
  // Unborn HEAD (fresh init, or a repo that never committed) → stage + commit.
  const head = await git(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    const commit = await commitAll(dir, "Initial commit");
    if (!commit.ok) return commit;
  }
  return run(
    "gh",
    [
      "repo",
      "create",
      repoName,
      "--source",
      dir,
      "--remote",
      "origin",
      "--push",
      isPrivate ? "--private" : "--public",
    ],
    { cwd: dir, timeout: FETCH_TIMEOUT },
  );
}

/** Default repo name for Create & Push = the folder basename. */
export function defaultRepoName(dir: string): string {
  return path.basename(dir.replace(/\/+$/, ""));
}

/** Normalize a git remote URL (ssh or https, github.com) into a browsable
 *  https://github.com/<owner>/<repo> page URL. Returns null for a non-github
 *  remote or an unrecognized form so callers can hide the "open on GitHub" UI. */
export function toGithubWebUrl(remote: string): string | null {
  const r = remote.trim();
  if (!r) return null;
  // scp-like ssh:  git@github.com:owner/repo(.git)
  let m = /^git@github\.com:(.+?)(?:\.git)?\/?$/.exec(r);
  if (m) return `https://github.com/${m[1]}`;
  // ssh://git@github.com/owner/repo(.git)  or  https://github.com/owner/repo(.git)
  m = /^(?:ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com\/(.+?)(?:\.git)?\/?$/.exec(r);
  if (m) return `https://github.com/${m[1]}`;
  return null;
}

/** Browsable GitHub URL for a project's `origin` remote, or null if the repo
 *  has no origin / a non-github remote. Best-effort; never throws. */
export async function getGithubWebUrl(dir: string): Promise<string | null> {
  const res = await git(dir, ["remote", "get-url", "origin"]);
  if (!res.ok) return null;
  return toGithubWebUrl(res.stdout);
}

/** Ask `claude -p` to READ the diff and propose ONE commit-message line — used
 *  only to draft the message a human then reviews. Diff is bounded to keep the
 *  token cost tiny. Returns "" if claude is unavailable or produced nothing. */
export async function autoCommitMessage(dir: string): Promise<string> {
  // Bounded context: status summary + a truncated diff of tracked changes.
  const [stat, diff] = await Promise.all([
    git(dir, ["status", "--short"]),
    git(dir, ["diff", "--stat", "HEAD"]),
  ]);
  let body = git(dir, ["diff", "HEAD"], GIT_TIMEOUT);
  const diffText = (await body).stdout.slice(0, 6000);
  const context = [
    "Changed files:",
    stat.stdout.trim(),
    "",
    "Diffstat:",
    diff.stdout.trim(),
    "",
    "Diff (truncated):",
    diffText,
  ].join("\n");
  const prompt =
    "Write ONE concise git commit message line (Conventional Commits style, " +
    "<=72 chars, imperative). Output ONLY the message, no quotes, no explanation.\n\n" +
    context;
  const res = await run("claude", ["-p", prompt], {
    timeout: CLAUDE_TIMEOUT,
    maxBuffer: 512 * 1024,
  });
  if (!res.ok) return "";
  // claude -p sometimes ignores "output ONLY the message" and prepends a preamble
  // line (e.g. "Here is a concise ... commit message ...:"). Taking the first
  // non-empty line then commits the PREAMBLE as the subject (this is exactly what
  // produced commit c8bc703). So: prefer a real Conventional-Commits line; else the
  // first non-preamble line; else the last non-empty line (preambles sit on top).
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const conventional =
    /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?!?:\s*\S/i;
  const isPreamble = (l: string) =>
    /:$/.test(l) || /\b(commit message|here (is|are|'s)|based on|sure|certainly)\b/i.test(l);
  const line =
    lines.find((l) => conventional.test(l)) ??
    lines.find((l) => !isPreamble(l)) ??
    lines[lines.length - 1];
  return (line ?? "").replace(/^["'`]+|["'`]+$/g, "").slice(0, 120);
}
