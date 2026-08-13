// Pure naming helpers for the new-project popup. NO vscode/fs/gh import — the
// extension injects local folder names + a gh-view probe, so this unit-tests with
// `bun test`. Both-source collision check (local + GitHub org) lives here as pure
// logic; the impure fs.readdir + `gh repo view` wrappers live in orchestrator.ts.

export const ORG = "MyMissionControl";
const SAFE = /^[A-Za-z0-9._-]+$/;

export function isValidName(name: string): boolean {
  return typeof name === "string" && SAFE.test(name);
}

export function sanitizeName(raw: string): string {
  return (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** strip a single trailing `-vN` → base ("x-v8"→"x", "x"→"x"). */
export function bumpBase(name: string): string {
  return name.replace(/-v\d+$/, "");
}

/** candidate #n: n≤1 → base, else `base-v{n}`. */
export function nextCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-v${n}`;
}

export interface NameCheck {
  valid: boolean;
  localTaken: boolean;
  githubChecked: boolean;
  githubTaken: boolean;
}

/** ghView(name): true = repo exists (taken), false = 404 (free), null = couldn't
 *  check (gh missing / not-authed / error) → treated as "not blocking". */
export function checkProjectName(
  name: string,
  localNames: string[],
  ghView: (n: string) => boolean | null,
): NameCheck {
  if (!isValidName(name))
    return { valid: false, localTaken: false, githubChecked: false, githubTaken: false };
  const gh = ghView(name);
  return {
    valid: true,
    localTaken: localNames.includes(name),
    githubChecked: gh !== null,
    githubTaken: gh === true,
  };
}

/** free = valid + not local + (github free OR gh not checked). */
export function isNameFree(c: NameCheck): boolean {
  return c.valid && !c.localTaken && !(c.githubChecked && c.githubTaken);
}

/** first free name derived from `base`: base itself if free, else `base-v2`, `-v3`…
 *  free = ว่างทั้ง local และ github. capped at 40 rounds.
 *
 *  ⛔ n เริ่มที่ 1 เสมอ (nextCandidate(base,1) === base) — ชื่อที่ว่างอยู่แล้วต้องได้ตัวเปล่า
 *  ไม่ใช่ `-v2` ทันที ไม่งั้น clone repo ครั้งแรกจะได้โฟลเดอร์ชื่อไม่ตรงกับ repo. */
export function suggestFromBase(
  base: string,
  localNames: string[],
  ghView: (n: string) => boolean | null,
): string {
  for (let n = 1; n <= 40; n++) {
    const cand = nextCandidate(base, n);
    if (isNameFree(checkProjectName(cand, localNames, ghView))) return cand;
  }
  return `${base}-new`;
}

/** first free name: base of most-recent project (recentNames[0], strip -vN) or
 *  "my-project", bumped until free in BOTH local + github. capped at 40 rounds. */
export function suggestDefaultName(
  recentNames: string[],
  localNames: string[],
  ghView: (n: string) => boolean | null,
): string {
  return suggestFromBase(recentNames.length ? bumpBase(recentNames[0]) : "my-project", localNames, ghView);
}
