import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  commitAll,
  gitErrorLine,
  pullRepo,
  pushRepo,
  readGitStatus,
  toGithubWebUrl,
  type RunResult,
} from "./gitOps";

test("toGithubWebUrl: ssh scp-like remote → https page", () => {
  expect(toGithubWebUrl("git@github.com:fufu-2345/agentskill-marketplace.git")).toBe(
    "https://github.com/fufu-2345/agentskill-marketplace",
  );
  expect(toGithubWebUrl("git@github.com:fufu-2345/agentskill-marketplace")).toBe(
    "https://github.com/fufu-2345/agentskill-marketplace",
  );
});

test("toGithubWebUrl: https remote → normalized page (strips .git, credentials, trailing slash)", () => {
  expect(toGithubWebUrl("https://github.com/fufu-2345/missionControl.git")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
  expect(toGithubWebUrl("https://github.com/fufu-2345/missionControl/")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
  expect(toGithubWebUrl("https://token@github.com/fufu-2345/missionControl.git")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
});

test("toGithubWebUrl: ssh:// url form", () => {
  expect(toGithubWebUrl("ssh://git@github.com/owner/repo.git")).toBe(
    "https://github.com/owner/repo",
  );
});

test("toGithubWebUrl: non-github or empty remote → null (button hidden)", () => {
  expect(toGithubWebUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  expect(toGithubWebUrl("https://bitbucket.org/owner/repo.git")).toBeNull();
  expect(toGithubWebUrl("")).toBeNull();
  expect(toGithubWebUrl("   ")).toBeNull();
});

// ── index.lock ─────────────────────────────────────────────────────────────
// These drive REAL git in a throwaway repo: the bug only exists at the process
// boundary. A `git status` killed at its timeout orphans .git/index.lock, and
// because status keeps working with a stale lock present, the row still offers
// "Commit (N)" while every commit fails forever.

const made: string[] = [];

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gitops-"));
  made.push(dir);
  const git = (...args: string[]) => cp.execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

const lockPath = (dir: string) => path.join(dir, ".git", "index.lock");

/** An orphaned lock looks exactly like this: empty file, mtime left behind. */
function writeLock(dir: string, ageMs: number) {
  fs.writeFileSync(lockPath(dir), "");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath(dir), when, when);
}

const headSubject = (dir: string) =>
  cp.execFileSync("git", ["-C", dir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();

afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

test("commitAll: stages and commits a dirty tree", async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  const r = await commitAll(dir, "feat: b");
  expect(r.ok).toBe(true);
  expect(headSubject(dir)).toBe("feat: b");
});

test("commitAll: reaps an ORPHANED index.lock and still commits", async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  writeLock(dir, 10 * 60_000); // a killed git left this 10 minutes ago
  const r = await commitAll(dir, "feat: b");
  expect(r.ok).toBe(true);
  expect(headSubject(dir)).toBe("feat: b");
  expect(fs.existsSync(lockPath(dir))).toBe(false);
});

test("commitAll: leaves a FRESH lock alone (another git may hold it)", async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  writeLock(dir, 1_000); // 1s old → assume a live operation, do not steal it
  const r = await commitAll(dir, "feat: b");
  expect(r.ok).toBe(false);
  expect(r.stderr).toContain("index.lock");
  expect(fs.existsSync(lockPath(dir))).toBe(true);
  expect(headSubject(dir)).toBe("init"); // nothing committed
});

// ── gitErrorLine ───────────────────────────────────────────────────────────
// Every fixture below is stderr captured VERBATIM from a real git run. The old
// toast took stderr line 1, which is almost never the reason: git prints the
// `hint:` block, the `To <url>` banner and the fetch summary FIRST, so the user
// saw "hint: Diverging branches can't be fast-forwarded, you need to either:"
// or a bare repo URL instead of what actually went wrong.

const res = (stderr: string, extra: Partial<RunResult> = {}): RunResult => ({
  ok: false,
  stdout: "",
  stderr,
  killed: false,
  ...extra,
});

test("gitErrorLine: ff-only on a diverged branch → the fatal, not the hint block", () => {
  const r = res(
    `hint: Diverging branches can't be fast-forwarded, you need to either:\n` +
      `hint: \n` +
      `hint: \tgit merge --no-ff\n` +
      `hint: \n` +
      `hint: or:\n` +
      `hint: \n` +
      `hint: \tgit rebase\n` +
      `hint: \n` +
      `hint: Disable this message with "git config advice.diverging false"\n` +
      `fatal: Not possible to fast-forward, aborting.\n`,
  );
  expect(gitErrorLine(r)).toBe("fatal: Not possible to fast-forward, aborting.");
});

test("gitErrorLine: rejected push → the [rejected] line, not the 'To <url>' banner", () => {
  const r = res(
    `To https://github.com/owner/repo.git\n` +
      ` ! [rejected]        main -> main (fetch first)\n` +
      `error: failed to push some refs to 'https://github.com/owner/repo.git'\n` +
      `hint: Updates were rejected because the remote contains work that you do not\n` +
      `hint: have locally.\n`,
  );
  const line = gitErrorLine(r);
  expect(line).toContain("[rejected]");
  expect(line).toContain("fetch first");
  expect(line).not.toContain("https://github.com/owner/repo.git");
});

test("gitErrorLine: local changes would be overwritten → names the files", () => {
  const r = res(
    `error: Your local changes to the following files would be overwritten by merge:\n` +
      `\ta.txt\n` +
      `\tsrc/b.ts\n` +
      `Please commit your changes or stash them before you merge.\n` +
      `Aborting\n`,
  );
  const line = gitErrorLine(r);
  expect(line).toContain("would be overwritten by merge");
  expect(line).toContain("a.txt");
  expect(line).toContain("src/b.ts");
});

test("gitErrorLine: untracked files would be overwritten → names the files", () => {
  const r = res(
    `error: The following untracked working tree files would be overwritten by merge:\n` +
      `\tc.txt\n` +
      `Please move or remove them before you merge.\n` +
      `Aborting\n`,
  );
  expect(gitErrorLine(r)).toContain("c.txt");
});

test("gitErrorLine: orphaned index.lock → the Unable-to-create line", () => {
  const r = res(
    `error: Unable to create '/p/.git/index.lock': File exists.\n` +
      `\n` +
      `Another git process seems to be running in this repository, e.g.\n`,
  );
  expect(gitErrorLine(r)).toContain("index.lock");
});

test("gitErrorLine: killed at the timeout with no output → says timeout, never blank", () => {
  expect(gitErrorLine(res("", { killed: true }))).toContain("timeout");
  expect(gitErrorLine(res("", { killed: true }))).not.toBe("");
});

test("gitErrorLine: message with no fatal:/error: prefix still surfaces", () => {
  const r = res(
    `Your configuration specifies to merge with the ref 'refs/heads/main'\n` +
      `from the remote, but no such ref was fetched.\n`,
  );
  expect(gitErrorLine(r)).toContain("no such ref was fetched");
});

test("gitErrorLine: pure noise only → falls back rather than returning blank", () => {
  const r = res(`remote: Invalid username or password.\n`);
  expect(gitErrorLine(r)).toContain("Invalid username or password");
});

test("gitErrorLine: nothing at all → empty (caller supplies its own wording)", () => {
  expect(gitErrorLine(res(""))).toBe("");
});

// ── pull / push at the process boundary ────────────────────────────────────

function tempRepoWithOrigin(): { dir: string; origin: string } {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "mc-origin-"));
  made.push(origin);
  cp.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
  const dir = tempRepo();
  const git = (...args: string[]) => cp.execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("remote", "add", "origin", origin);
  git("push", "-q", "-u", "origin", "main");
  // a second clone commits + pushes → `dir` is now strictly behind origin/main
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mc-other-"));
  made.push(other);
  cp.execFileSync("git", ["clone", "-q", origin, other], { stdio: "pipe" });
  const o = (...args: string[]) => cp.execFileSync("git", ["-C", other, ...args], { stdio: "pipe" });
  o("config", "user.email", "test@example.com");
  o("config", "user.name", "test");
  o("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(other, "remote.txt"), "from origin\n");
  o("add", "-A");
  o("commit", "-qm", "remote work");
  o("push", "-q", "origin", "main");
  git("fetch", "-q");
  return { dir, origin };
}

test("pullRepo: fast-forwards a clean, strictly-behind tree", async () => {
  const { dir } = tempRepoWithOrigin();
  const r = await pullRepo(dir);
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, "remote.txt"))).toBe(true);
});

test("pullRepo: reaps an ORPHANED index.lock and still pulls (parity with commitAll)", async () => {
  const { dir } = tempRepoWithOrigin();
  writeLock(dir, 10 * 60_000); // a pull killed at its timeout left this behind
  const r = await pullRepo(dir);
  expect(r.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, "remote.txt"))).toBe(true);
  expect(fs.existsSync(lockPath(dir))).toBe(false);
});

test("pullRepo: leaves a FRESH lock alone (another git may hold it)", async () => {
  const { dir } = tempRepoWithOrigin();
  writeLock(dir, 1_000);
  const r = await pullRepo(dir);
  expect(r.ok).toBe(false);
  expect(gitErrorLine(r)).toContain("index.lock");
  expect(fs.existsSync(lockPath(dir))).toBe(true);
});

test("pushRepo: detached HEAD fails fast with a readable reason, no refname gibberish", async () => {
  const dir = tempRepo();
  cp.execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", "HEAD"], { stdio: "pipe" });
  const r = await pushRepo(dir, false);
  expect(r.ok).toBe(false);
  expect(r.stderr).toContain("detached HEAD");
  expect(r.stderr).not.toContain("refname");
});

test("pushRepo: no upstream on a real branch still sets one (unchanged behaviour)", async () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "mc-origin-"));
  made.push(origin);
  cp.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
  const dir = tempRepo();
  cp.execFileSync("git", ["-C", dir, "remote", "add", "origin", origin], { stdio: "pipe" });
  const r = await pushRepo(dir, false);
  expect(r.ok).toBe(true);
  const up = cp
    .execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      encoding: "utf8",
    })
    .trim();
  expect(up).toBe("origin/main");
});

test("readGitStatus: never takes index.lock, so a killed poll cannot orphan one", async () => {
  const dir = tempRepo();
  // Touch without changing content: plain `git status` rewrites the index to
  // refresh its stat cache — that write is what takes index.lock.
  const stamp = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "a.txt"), stamp, stamp);
  const before = fs.statSync(path.join(dir, ".git", "index")).mtimeMs;
  const st = await readGitStatus(dir);
  const after = fs.statSync(path.join(dir, ".git", "index")).mtimeMs;
  expect(st.isRepo).toBe(true);
  expect(after).toBe(before); // index untouched → no lock was ever created
});
