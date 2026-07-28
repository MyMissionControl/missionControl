// Pure helpers for the "Start Orchestrator" command. NO vscode import here so
// the parsing + validation logic can be unit-tested standalone with `bun test`.
// The filesystem directory-walk lives in startOrchestrator.ts (vscode side).

import { isSafeModelId } from "./teamsModel";

export interface OracleMember {
  oracle: string;
  role: string;
}

export interface OracleTeam {
  name: string;
  members: OracleMember[];
  orchestrators: string[]; // member names whose role === "orchestrator"
}

/** Parse one `~/.maw/teams/<name>/oracle-members.json` file's content into an
 *  OracleTeam. Tolerant: bad JSON or missing `members` → null. */
export function parseTeamRoster(name: string, raw: string): OracleTeam | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const rawMembers = (data as { members?: unknown })?.members;
  if (!Array.isArray(rawMembers)) return null;
  const members: OracleMember[] = [];
  for (const m of rawMembers) {
    if (!m || typeof (m as { oracle?: unknown }).oracle !== "string") continue;
    const oracle = (m as { oracle: string }).oracle;
    const role =
      typeof (m as { role?: unknown }).role === "string"
        ? (m as { role: string }).role
        : "";
    members.push({ oracle, role });
  }
  const orchestrators = members
    .filter((m) => m.role === "orchestrator")
    .map((m) => m.oracle);
  return { name, members, orchestrators };
}

/** True when a name is safe to single-quote into a shell `maw wake '<name>'`.
 *  Whitelist only — letters, digits, dot, underscore, hyphen. */
export function isSafeOracleName(name: string): boolean {
  if (!name || name.length > 200) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Wrap a string as a safe single-quoted shell argument (escapes embedded '). */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Appended to the kickoff when the "โหมดถาม" toggle is on. The literal word
 *  "โหมดถาม" here is the trigger the /orches-drive skill scans for to switch on
 *  ask mode: Step 1 runs the `grilling` interview, Step 3 runs the `scrutinize`
 *  plan review. Keep "โหมดถาม" in this string or the skill won't detect it. */
const ASK_MODE_KICKOFF =
  "[โหมดถาม เปิด] Step 1: สัมภาษณ์ requirement ให้ชัดด้วยสกิล grilling (ถามทีละคำถาม รอคำตอบก่อนถามต่อ)." +
  " Step 3: ก่อนแจกงาน worker รีวิวแผน sprint ด้วยสกิล scrutinize (ถาม intent/ทางที่ง่ายกว่า + verdict).";

/** The kickoff prompt injected into the woken orchestrator so it immediately
 *  runs the /orches-drive loop (NOT the bootstrap) with its team context —
 *  turning the fast code-wake into the full /orches flow. `askMode` appends the
 *  โหมดถาม trigger (grilling interview + scrutinize plan review). */
export function buildKickoffPrompt(
  team: string,
  orchestrator: string,
  workers: string[],
  askMode = false,
): string {
  const w = workers.length
    ? workers.join(", ")
    : "(ทีมนี้ยังไม่มี worker — เชิญเพิ่มก่อนแจกงาน)";
  const lines = [
    `คุณคือ orchestrator ชื่อ ${orchestrator} ของทีม ${team}.`,
    `Workers ที่ dispatch ได้: ${w}.`,
    `รัน skill /orches-drive เดี๋ยวนี้: ทักผมสั้นๆ → ถาม build requirement → discuss ให้ชัด →` +
      ` แตกเป็น sprint (คุณกำหนดจำนวนเอง) → แจกงาน worker ด้วย tmux send-keys → poll .orches-done →` +
      ` verify → git merge เข้า main → วนจนจบ → capture memory.`,
    `worker ที่ยังหลับ: ปลุกด้วย maw wake <ชื่อ> — มันจะตื่นใน repo ของมันเอง ปกติ ไม่ต้องย้าย` +
      ` เพราะตัวงานที่ dispatch พิน absolute worktree path ของ project อยู่แล้ว.`,
    `อย่ารัน /orches (นั่นคือ bootstrap เลือกทีม/ปลุก — คุณผ่านมาแล้ว) และอย่า dispatch งานให้ตัวเอง.`,
  ];
  if (askMode) lines.push(ASK_MODE_KICKOFF);
  return lines.join(" ");
}

/** Resume kickoff — injected when the user picks "⏮ ทำต่อ" instead of a fresh
 *  build. Unlike buildKickoffPrompt (which tells the orchestrator to ASK for a
 *  new requirement), this points it at an EXISTING project and tells it to read
 *  the leftover state and pick up where the last run stopped. Pairs with the
 *  `/orches-drive` resume mode (skip Step 0-1, read state → propose next sprint). */
export function buildResumeKickoff(
  projectName: string,
  projectPath: string,
  team: string,
  orchestrator: string,
  workers: string[],
  askMode = false,
): string {
  const w = workers.length
    ? workers.join(", ")
    : "(ทีมนี้ยังไม่มี worker — เชิญเพิ่มก่อนแจกงาน)";
  const lines = [
    `คุณคือ orchestrator ชื่อ ${orchestrator} ของทีม ${team}.`,
    `Workers ที่ dispatch ได้: ${w}.`,
    `รัน skill /orches-drive แบบ RESUME กับ project ที่ค้างอยู่: "${projectName}" (absolute path: ${projectPath}).`,
    `อย่าถาม build requirement ใหม่ — แทนที่ด้วย: อ่าน state เดิมก่อน` +
      ` (docs/*sprint-*.md — ชื่อใหม่ <project>-sprint-N.md หรือชื่อเก่า sprint-N.md, git log --oneline, git worktree list, .orches-notes.md ใน worktree agents/* ที่ยังเปิด) →` +
      ` สรุปให้ user ฟังสั้นๆ ว่าทำถึง sprint ไหน ค้างอะไร → เสนอ sprint ถัดไป → รอ user สั่งไปต่อ.`,
    `จากนั้นวน /orches-drive ปกติ: แจกงาน worker → poll .orches-done → verify → git merge เข้า main → capture memory. อย่า dispatch งานให้ตัวเอง.`,
    `อย่ารัน /orches (bootstrap — คุณผ่านมาแล้ว).`,
  ];
  // RESUME ข้าม Step 0-1 (ไม่สัมภาษณ์ใหม่) → grilling ไม่ทำงาน; แต่ trigger นี้ยังเปิด
  // scrutinize ที่ plan gate ตอนเสนอ sprint ถัดไป.
  if (askMode) lines.push(ASK_MODE_KICKOFF);
  return lines.join(" ");
}

/** Kickoff for the inline "▶ continue" BUTTON: resume this project and run
 *  exactly ONE sprint headless, then stop. No requirement discussion, no --ask,
 *  no sprint-checkpoint UI. The marker contract (.orches-run.json done/error) is
 *  what the extension polls; MERGE_MODE stays whatever Settings says (never
 *  passed/hardcoded here). */
export function buildContinueKickoff(
  projectName: string,
  projectPath: string,
  team: string,
  orch: string,
  workers: string[],
  sprints = 1, // >1 → "▶▶ ทำหลาย sprint": N sprints headless, no checkpoint between
): string {
  const n = Math.max(1, Math.floor(sprints));
  const flag = n > 1 ? `--once ${n}` : `--once`;
  const scope =
    n > 1
      ? `ทำ ${n} sprint ถัดไปใน docs/plan.md รวดเดียว (เหลือน้อยกว่านั้น = ทำเท่าที่เหลือ) — ⛔ ไม่จอด checkpoint ระหว่างทาง ไม่โชว์ปุ่ม. `
      : `ทำ sprint ถัดไปใน docs/plan.md อันเดียวแล้วหยุด — ห้ามวน sprint ต่อ ไม่โชว์ปุ่ม checkpoint. `;
  return (
    `/orches-drive ${flag} ` +
    `resume project "${projectName}" ที่ ${projectPath} (team ${team}, ผม=${orch}). ` +
    scope +
    `MERGE_MODE อ่านจาก Settings (อย่าถาม). worker: ${workers.join(", ") || "(none)"}. ` +
    `เมื่อจบ${n > 1 ? "ครบ" : " 1 sprint"} เขียน .orches-run.json {"status":"done"} แล้ว exit; ` +
    `ถ้าล้ม เขียน {"status":"error","errorMsg":"<เหตุผล>"} แล้ว exit.`
  );
}

/** Find an oracle's pinned tmux session name from maw config content
 *  (`sessions` map in `~/.config/maw/maw.config.*.json`). The pin is what
 *  `maw wake` resolves FIRST, so the button launching into the same name means
 *  every entry point (button, wake, team bring) converges on ONE session and
 *  the fleet registry never mints a conflicting `01-*` twin. */
export function parseSessionPin(mawConfigJson: string, oracle: string): string | null {
  try {
    const data = JSON.parse(mawConfigJson) as { sessions?: Record<string, unknown> };
    const pin = data?.sessions?.[oracle];
    return typeof pin === "string" && pin.trim() ? pin.trim() : null;
  } catch {
    return null;
  }
}

/** Find an oracle's local repo path from `~/.maw/oracles.json` content. */
export function parseOraclePath(oraclesJson: string, name: string): string | null {
  try {
    const data = JSON.parse(oraclesJson) as {
      oracles?: { name?: string; local_path?: string }[];
    };
    const list = Array.isArray(data?.oracles) ? data.oracles : [];
    const hit = list.find(
      (o) => o?.name === name && typeof o.local_path === "string",
    );
    return hit?.local_path ?? null;
  } catch {
    return null;
  }
}

/** Shell snippet that arranges the freshly-launched orchestrator session into
 *  the 2-column /orches layout — orchestrator pane fixed on the left, oracle
 *  toggle buttons on the tmux status bar (clicking one opens/closes its pane on
 *  the right, up to 3). Delegates to the tested `pane-layout.sh` (pure tmux) —
 *  NOT reimplemented in TS: tmux has no API (any impl just shells out to `tmux`),
 *  and the status-bar click handler MUST be a shell-callable script regardless.
 *  Empty string when there are no workers (no buttons to show). Guarded on the
 *  script being executable so a missing skill silently skips the layout instead
 *  of breaking the launch. */
export function buildPaneLayoutInitCommand(
  session: string,
  window: string,
  workers: string[],
): string {
  if (!workers.length) return "";
  const args = [session, window, ...workers].map(shSingleQuote).join(" ");
  return (
    `LAY="$HOME/.claude/skills/orches-drive/pane-layout.sh" && ` +
    `[ -x "$LAY" ] && bash "$LAY" init ${args}`
  );
}

/** Command to launch the orchestrator INSIDE a tmux session, as a FRESH
 *  interactive claude in its own repo dir (loads its CLAUDE.md + ψ + global
 *  skills), with the kickoff as the first message.
 *  Session name: the maw `sessions` pin when one exists (e.g. `09-foreman`) so
 *  the button, `maw wake` and `maw team bring` all converge on ONE session —
 *  a pin WITHOUT the `NN-` prefix would get auto-numbered by maw on cold
 *  create (mints `01-…` fleet twins = the recurring CONFLICT). Fallback:
 *  `claude-<orch>` for unpinned orchestrators.
 *  Why tmux (not a bare editor terminal): (1) closing the tab only DETACHES —
 *  the orchestrator survives; (2) its Bash subprocesses inherit $TMUX so
 *  `maw team bring` / `tmux send-keys` dispatch works (a bare terminal has no
 *  $TMUX → bring fails "not in tmux"); (3) it shows up in the Sessions panel.
 *  `-A -d` creates the session detached (no-op if it already exists) so
 *  pane-layout can arrange it before we attach; the inner claude runs only on
 *  first creation, while the layout-init + `tmux attach` run every invocation
 *  (both idempotent — safe to re-click). No `--continue` (exits for a fresh
 *  oracle with no prior conversation). All layers single-quote-escaped. */
/** The `@orches_label` value the Sessions panel shows for a session driving a
 *  project — "<project> / <team>" (bare "<project>" when the team is unknown).
 *  Mirrors the display fallback in webview/sessions.ts computeSessionLabel so a
 *  label the extension stamps and one the dashboard derives look identical. */
export function formatOrchesLabel(project: string, team?: string): string {
  const t = team?.trim();
  return t ? `${project} / ${t}` : project;
}

/** The `@orches_label` to stamp at session-create, or undefined to defer to the
 *  orchestrator's own runtime set. A known project name — a resume, OR a NEW build
 *  whose name was chosen up-front in the dashboard name popup — gets
 *  "<project> / <team>" immediately. A nameless new build returns undefined (the
 *  orchestrator picks a name at runtime and sets the label itself). */
export function resolveOrchesLabel(
  projectName: string | undefined,
  team: string,
): string | undefined {
  const n = projectName?.trim();
  return n ? formatOrchesLabel(n, team) : undefined;
}

export function buildTmuxLaunchCommand(
  orchestrator: string,
  repoPath: string,
  kickoff: string,
  sessionName?: string,
  workers: string[] = [],
  attach = true, // continue-button passes false → detached, no attach
  orchesLabel?: string, // set @orches_label at create so the Sessions panel shows "<project> / <team>", not the raw NN-<oracle> pin
  model?: string, // per-member model from the Team Config picker (config.json members[].model); omitted → inherits global default
): string {
  const session = sessionName?.trim() || `claude-${orchestrator}`;
  // -n names the initial window after the repo (e.g. foreman-oracle): maw wake
  // recognizes a live oracle by its WINDOW name — without this, `maw wake
  // foreman -p` sees no foreman window and opens a SECOND claude (twin) on the
  // same repo/conversation instead of injecting into this one.
  const window = repoPath.replace(/\/+$/, "").split("/").pop() || orchestrator;
  // Per-member model from the Team Config picker. Guard against injection: real
  // model ids are alnum/dot/hyphen plus an optional [1m] window suffix — anything
  // else is dropped so a tampered config.json can't smuggle shell into the launch
  // command. Shared with the per-member `/model` send (teamUpModel) so the two
  // paths can no longer disagree about what a valid model id is.
  const modelFlag = model && isSafeModelId(model) ? `--model ${model} ` : "";
  const inner =
    `cd ${shSingleQuote(repoPath)} && ` +
    `claude ${modelFlag}--dangerously-skip-permissions ${shSingleQuote(kickoff)}`;
  // Detached create → lay out → attach (mirrors buildTeamUpCommand). A plain
  // attached `new-session` blocks until the user detaches, so the layout could
  // only run afterward. `-A -d` creates (or no-ops if the session is already
  // live) WITHOUT attaching, so pane-layout runs against the session first; then
  // we attach into the finished 2-column view. Re-clicking stays safe: `-A -d`
  // no-ops and pane-layout init is idempotent (re-applies the same layout).
  const layout = buildPaneLayoutInitCommand(session, window, workers);
  const head =
    `tmux new-session -A -d -s ${shSingleQuote(session)} ` +
    `-n ${shSingleQuote(window)} ${shSingleQuote(inner)}`;
  // The trailing block runs post-create steps: layout (idempotent) then, unless
  // detached (attach=false, the continue button), attach into the finished view.
  const parts: string[] = [];
  // Stamp the session-scoped display label FIRST (before layout/attach) so the
  // Sessions panel shows "<project> / <team>" the moment the session appears —
  // deterministic, not waiting on the orchestrator LLM to run its own set. Plain
  // `-t <session>` (NO '=' prefix): tmux 3.4 set-option reads '=name' literally.
  const label = orchesLabel?.trim();
  if (label) parts.push(`tmux set-option -t ${shSingleQuote(session)} @orches_label ${shSingleQuote(label)} ;`);
  if (layout) parts.push(`${layout} ;`);
  if (attach) parts.push(`tmux attach -t ${shSingleQuote(`=${session}`)} ;`);
  // Trailing `true;` so the brace group's exit status is ALWAYS 0 once `new-session`
  // succeeded: the label/layout steps are best-effort and their non-zero exit must NOT make
  // the headless launcher (cp.execSync, which throws on non-zero) report a false "launch
  // failed" while leaving the session orphaned. new-session failure still propagates (it is
  // before the &&, so the group never runs).
  return parts.length ? `${head} && { ${parts.join(" ")} true; }` : head;
}
