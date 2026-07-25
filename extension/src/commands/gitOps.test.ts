import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { commitAll, readGitStatus, toGithubWebUrl } from "./gitOps";

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
