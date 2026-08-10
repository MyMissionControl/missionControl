// Pure helper: turn a project's raw git facts into the single action button the
// resume list should show. NO vscode/node import — the git commands that gather
// these facts run in gitOps.ts (extension side); this file only DECIDES, so the
// button logic is unit-testable with `bun test`.

export type GitButtonKind =
  | "commit" // working tree dirty → needs a commit
  | "push" // clean, local commits ahead of (or no) upstream → needs a push
  | "pull" // clean, strictly behind upstream (ahead==0) → safe fast-forward pull
  | "diverged" // clean, behind AND ahead → manual reconcile (info only, no auto-action)
  | "create-push" // no remote (or not a repo yet) → create GitHub repo + push
  | "uptodate" // clean, in sync with upstream → nothing to do
  | "none"; // unknown

export interface GitButtonState {
  kind: GitButtonKind;
  label: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
  staleMs?: number; // age of the fetch these ahead/behind numbers came from
}

/** Raw facts gathered by gitOps.readGitStatus (all from `git`). */
export interface GitRawStatus {
  isRepo: boolean;
  porcelain: string; // `git status --porcelain -uall` output
  hasRemote: boolean; // any remote configured
  hasUpstream: boolean; // current branch tracks an upstream
  ahead: number; // commits HEAD is ahead of upstream (0 if no upstream)
  behind: number; // commits HEAD is behind upstream
  staleMs?: number; // ms since the last `git fetch` (undefined = unknown)
}

/** ahead/behind are read from the remote-tracking refs, i.e. from whenever this
 *  repo last fetched — and the Projects list only fetches when the user presses
 *  ⟳. So "up to date" is a claim about that fetch, NOT about GitHub right now,
 *  and a row can sit on a green chip while origin has moved. This is the hover
 *  text that says how old the comparison is. */
export function gitStaleNote(staleMs: number | undefined): string {
  if (staleMs === undefined || !Number.isFinite(staleMs) || staleMs < 0) {
    return "ยังไม่ทราบว่า fetch จาก origin ครั้งล่าสุดเมื่อไหร่ — กดปุ่ม fetch เพื่ออัปเดต";
  }
  const min = Math.floor(staleMs / 60_000);
  if (min < 2) return "เทียบกับ origin เมื่อครู่นี้";
  const tail = " — กดปุ่ม fetch เพื่ออัปเดต";
  if (min < 60) return `เทียบกับ origin เมื่อ ${min} นาทีที่แล้ว${tail}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `เทียบกับ origin เมื่อ ${hr} ชั่วโมงที่แล้ว${tail}`;
  return `เทียบกับ origin เมื่อ ${Math.floor(hr / 24)} วันที่แล้ว${tail}`;
}

/** Count real change lines in porcelain output (blank lines ignored). */
export function countDirty(porcelain: string): number {
  return porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/** Which repos a background auto-fetch should refresh: those whose ahead/behind
 *  is older than `staleMs` AND that we have not already TRIED within the same
 *  window. Keying the cooldown on the attempt rather than on success is what
 *  makes this terminate — an offline repo never updates its FETCH_HEAD, so a
 *  staleness-only rule would re-fetch it on every redraw, and each redraw
 *  schedules the next fetch: a permanent loop. */
export function pickAutoFetch(
  staleByPath: Record<string, number | undefined>,
  attemptedAt: Map<string, number>,
  now: number,
  staleMs: number,
): string[] {
  return Object.keys(staleByPath).filter(
    (p) =>
      (staleByPath[p] ?? Number.POSITIVE_INFINITY) > staleMs &&
      now - (attemptedAt.get(p) ?? 0) > staleMs,
  );
}

/** Decide the one action button for a project from its raw git facts.
 *  Precedence: dirty (commit) > no-remote (create-push) > no-upstream (push) >
 *  diverged (info) > ahead (push) > behind (pull) > in-sync (up to date).
 *  The Pull button appears ONLY on a clean, strictly-behind tree — the exact
 *  case `git pull --ff-only` advances safely. When local AND remote both moved
 *  (diverged) we show an info chip, never an auto-merge, so ff-only can't fail
 *  on a button press. */
export function parseGitButtonState(s: GitRawStatus): GitButtonState {
  const base = { dirtyCount: 0, ahead: s.ahead || 0, behind: s.behind || 0, staleMs: s.staleMs };
  // Not a repo yet → still offer ONE green "Create & Push". The create-push
  // handler (gitOps.createAndPush) git-inits + makes an initial commit before
  // creating the GitHub repo, so a single button covers bare-folder → published.
  // (The orches flow already inits+commits up front, so in practice a non-repo
  // row only appears for a hand-made dir.) No separate "Git init" step.
  if (!s.isRepo) return { ...base, kind: "create-push", label: "Create & Push" };

  const dirtyCount = countDirty(s.porcelain);
  if (dirtyCount > 0) {
    return { ...base, kind: "commit", label: `Commit (${dirtyCount})`, dirtyCount };
  }
  // Clean working tree from here on.
  if (!s.hasRemote) return { ...base, kind: "create-push", label: "Create & Push" };
  if (!s.hasUpstream) return { ...base, kind: "push", label: "Push" };
  // Has an upstream + clean tree — reconcile against it.
  if (s.behind > 0 && s.ahead > 0) {
    return { ...base, kind: "diverged", label: `⚠ diverged ${s.behind}↓ ${s.ahead}↑` };
  }
  if (s.ahead > 0) return { ...base, kind: "push", label: `Push (${s.ahead})` };
  if (s.behind > 0) return { ...base, kind: "pull", label: `Pull (${s.behind})` };
  return { ...base, kind: "uptodate", label: "✓ up to date" };
}
