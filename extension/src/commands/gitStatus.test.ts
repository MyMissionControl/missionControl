import { expect, test } from "bun:test";

import {
  countDirty,
  gitStaleNote,
  parseGitButtonState,
  pickAutoFetch,
  type GitRawStatus,
} from "./gitStatus";

const clean: GitRawStatus = {
  isRepo: true,
  porcelain: "",
  hasRemote: true,
  hasUpstream: true,
  ahead: 0,
  behind: 0,
};

test("countDirty ignores blank lines", () => {
  expect(countDirty("")).toBe(0);
  expect(countDirty(" M a.ts\n?? b.ts\n")).toBe(2);
  expect(countDirty("\n\n")).toBe(0);
});

test("dirty tree → Commit with count (wins over everything)", () => {
  const s = { ...clean, porcelain: " M a.ts\n?? b.ts\n M c.ts", ahead: 3 };
  const r = parseGitButtonState(s);
  expect(r.kind).toBe("commit");
  expect(r.label).toBe("Commit (3)");
  expect(r.dirtyCount).toBe(3);
});

test("clean + no remote → Create & Push", () => {
  const r = parseGitButtonState({ ...clean, hasRemote: false, hasUpstream: false });
  expect(r.kind).toBe("create-push");
  expect(r.label).toBe("Create & Push");
});

test("clean + remote but no upstream → Push", () => {
  const r = parseGitButtonState({ ...clean, hasUpstream: false });
  expect(r.kind).toBe("push");
  expect(r.label).toBe("Push");
});

test("clean + ahead of upstream → Push with count", () => {
  const r = parseGitButtonState({ ...clean, ahead: 4 });
  expect(r.kind).toBe("push");
  expect(r.label).toBe("Push (4)");
});

test("clean + in sync → up to date", () => {
  expect(parseGitButtonState(clean).kind).toBe("uptodate");
});

test("clean + behind only (no ahead) → Pull with count (safe fast-forward)", () => {
  const r = parseGitButtonState({ ...clean, behind: 2 });
  expect(r.kind).toBe("pull");
  expect(r.label).toBe("Pull (2)");
  expect(r.behind).toBe(2);
});

test("clean + diverged (behind AND ahead) → diverged info, not push/pull", () => {
  const r = parseGitButtonState({ ...clean, behind: 2, ahead: 1 });
  expect(r.kind).toBe("diverged");
  expect(r.label).toContain("diverged");
  expect(r.behind).toBe(2);
  expect(r.ahead).toBe(1);
});

test("dirty wins over behind (commit before pull)", () => {
  const r = parseGitButtonState({ ...clean, porcelain: " M a.ts", behind: 5 });
  expect(r.kind).toBe("commit");
});

// ── pickAutoFetch ──────────────────────────────────────────────────────────
// The background fetch reschedules itself off its own redraw, so the cooldown
// is the only thing standing between "fresh chips" and a permanent fetch loop.

const FIVE_MIN = 5 * 60_000;
const NOW = 1_000_000_000;

test("pickAutoFetch: only repos staler than the window", () => {
  const picked = pickAutoFetch(
    { fresh: 60_000, stale: 30 * 60_000, never: undefined },
    new Map(),
    NOW,
    FIVE_MIN,
  );
  expect(picked.sort()).toEqual(["never", "stale"]); // never-fetched counts as infinitely stale
});

test("pickAutoFetch: a repo just ATTEMPTED is skipped even though still stale", () => {
  // the offline case: the fetch failed, FETCH_HEAD never moved, so staleness
  // alone would pick it again on the very redraw its own fetch triggered
  const attempted = new Map([["offline", NOW - 1_000]]);
  expect(pickAutoFetch({ offline: 60 * 60_000 }, attempted, NOW, FIVE_MIN)).toEqual([]);
});

test("pickAutoFetch: the cooldown expires, so a stuck repo is retried later", () => {
  const attempted = new Map([["offline", NOW - FIVE_MIN - 1]]);
  expect(pickAutoFetch({ offline: 60 * 60_000 }, attempted, NOW, FIVE_MIN)).toEqual(["offline"]);
});

test("pickAutoFetch: everything fresh → nothing to do (loop terminates)", () => {
  expect(pickAutoFetch({ a: 1_000, b: 2_000 }, new Map(), NOW, FIVE_MIN)).toEqual([]);
});

// ── gitStaleNote ───────────────────────────────────────────────────────────
// The list never fetches on its own, so "up to date" only means "up to date as
// of the last fetch". These are the hover texts that say how old that is.

test("gitStaleNote: unknown fetch time → says so and points at the fetch button", () => {
  expect(gitStaleNote(undefined)).toContain("fetch");
  expect(gitStaleNote(NaN)).toContain("fetch");
  expect(gitStaleNote(-5)).toContain("fetch");
});

test("gitStaleNote: just fetched → no nag", () => {
  expect(gitStaleNote(30_000)).toBe("เทียบกับ origin เมื่อครู่นี้");
});

test("gitStaleNote: minutes / hours / days", () => {
  expect(gitStaleNote(7 * 60_000)).toContain("7 นาที");
  expect(gitStaleNote(3 * 3_600_000)).toContain("3 ชั่วโมง");
  expect(gitStaleNote(2 * 86_400_000)).toContain("2 วัน");
});

test("staleMs rides through parseGitButtonState onto every kind", () => {
  expect(parseGitButtonState({ ...clean, staleMs: 90_000 }).staleMs).toBe(90_000);
  expect(parseGitButtonState({ ...clean, behind: 2, staleMs: 90_000 }).staleMs).toBe(90_000);
  expect(parseGitButtonState({ ...clean, isRepo: false, staleMs: 90_000 }).staleMs).toBe(90_000);
});

test("not a repo → Create & Push (single button folds in git-init)", () => {
  const r = parseGitButtonState({ ...clean, isRepo: false });
  expect(r.kind).toBe("create-push");
  expect(r.label).toBe("Create & Push");
});
