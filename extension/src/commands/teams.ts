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

/** The kickoff prompt injected into the woken orchestrator so it immediately
 *  runs the /orches-drive loop (NOT the bootstrap) with its team context —
 *  turning the fast code-wake into the full /orches flow.
 *
 *  ⛔ เคยมีพารามิเตอร์ `askMode` ที่ต่อท้าย trigger "โหมดถาม" (grilling + scrutinize)
 *  ถอดออก 2026-08-05 ตามที่ user สั่ง: ทั้งฟีเจอร์ไม่เคยถูกใช้เลย และฝั่ง /orches-drive
 *  ก็ถอดสายออกหมดแล้ว → ส่ง trigger ไปก็ไม่มีใครอ่าน (สกิล grilling/scrutinize ยังอยู่
 *  ในเครื่อง เก็บไว้ implement ที่อื่นในอนาคต) */
export function buildKickoffPrompt(
  team: string,
  orchestrator: string,
  workers: string[],
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
  return lines.join(" ");
}

/** ต่อท้าย kickoff ของ build ใหม่ที่ **clone มาจาก repo ที่มีอยู่แล้ว** (MC clone ให้
 *  เสร็จก่อนปลุก แล้ว rewire remote ทิ้งไปแล้ว — ดู commands/repoClone.ts).
 *
 *  ⛔ ทำไมต้องสั่ง "อ่านให้จบก่อนถาม": kickoff ปกติสั่งให้ถาม requirement ทันที ซึ่งกับ
 *  โปรเจคเปล่าถูกแล้ว แต่กับ repo ที่มีโค้ดอยู่ = ถามโดยไม่รู้ว่ามีอะไรอยู่ แล้วจะเสนอ sprint
 *  ที่ทับของเดิม. user สั่งตรง ๆ 2026-08-11: ให้อ่าน .md + project wiki ให้เข้าใจจริงก่อนถาม.
 *  ⛔⛔ และห้าม push กลับขึ้นต้นทาง — remote ถูกตัดไว้แล้วในระดับ git แต่ต้องบอกด้วย
 *  ไม่ให้ไปเติม remote คืนเอง. */
export function buildCloneKickoffNote(
  projectName: string,
  projectPath: string,
  cloneUrl: string,
): string {
  return [
    ``,
    ``,
    `⭐ โปรเจคนี้ **ไม่ใช่ของเปล่า** — ผม clone repo ที่มีอยู่แล้วมาให้เรียบร้อยแล้วที่ ${projectPath}` +
      ` ชื่อโปรเจคคือ '${projectName}' (เช็คว่างมาแล้ว · ⛔ ห้ามตั้งชื่อใหม่ · ห้าม clone/สร้างซ้ำที่อื่น).`,
    `⛔ อย่าถาม requirement ทันที — **อ่านให้เข้าใจจริงก่อน**: README ทุกตัว, docs/**/*.md,` +
      ` docs/wiki/ ทั้งโฟลเดอร์ถ้ามี, package.json/ไฟล์ config, แล้วไล่โครงโค้ดพอให้รู้ว่าอะไรอยู่ไหน.` +
      ` จากนั้น **สรุปให้ผมฟังสั้น ๆ** ว่า repo นี้ทำอะไร มีอะไรอยู่แล้ว ใช้ stack อะไร แล้วค่อยถามว่าผมอยากเพิ่ม/แก้อะไร.`,
    `ถ้ายังไม่มี docs/wiki/ สร้างได้เลย แต่ **เขียนแค่ที่มั่นใจจากโค้ดจริง — ห้ามเดา**` +
      ` (คนอ่านรอบหน้าจะเชื่อไฟล์นี้ · ไม่แน่ใจก็เว้นไว้ดีกว่าเขียนผิด).`,
    `⛔⛔ ต้นทางที่ clone มาคือ ${cloneUrl} — ถูกเก็บเป็น remote ชื่อ \`upstream\` ที่ push ไม่ได้.` +
      ` **ห้าม push งานขึ้น upstream และห้ามเติม remote คืนเอง** ไม่ว่าด้วยเหตุผลใด` +
      ` (จะ push ขึ้นต้นทางเมื่อผมสั่งเองเท่านั้น). ที่เก็บงาน default ยังเป็น repo ของเราเองใต้ org เหมือนเดิม —` +
      ` ปล่อยให้ orches-integrate.sh สร้าง origin ให้ตามปกติ.`,
  ].join(" ");
}

/** Resume kickoff — injected when the user picks "⏮ ทำต่อ" / "▶ ทำต่อ" instead of
 *  a fresh build. Unlike buildKickoffPrompt (which tells the orchestrator to ASK
 *  for a new requirement), this points it at an EXISTING project, tells it to read
 *  the leftover state, report, and then WAIT.
 *
 *  ⛔ It used to open with "รัน skill /orches-drive แบบ RESUME", so every visit to a
 *  project became a sprint. user 2026-08-14: "บางครั้ง user แค่อยากเข้ามาเช็คหรือหาบัค
 *  ไม่ได้จะทำเป็น sprint อย่างเดียว" → the button now opens the door, it doesn't start
 *  the machine. Sprint-on-purpose still has its own buttons (ทำ 1 sprint / ทำ N
 *  sprint → buildContinueKickoff, which really is `/orches-drive --once`).
 *
 *  ⛔ The fragile half is the way BACK IN, which is why it is spelled out here: an
 *  agent cannot run a slash command by writing "/orches-drive" in its own reply —
 *  it must invoke the SKILL. And the user is not going to say a magic word, so the
 *  kickoff carries the skill name, how to call it, and a spread of phrasings to
 *  read as intent. Locked by orchestratorResume.test.ts. */
export function buildResumeKickoff(
  projectName: string,
  projectPath: string,
  team: string,
  orchestrator: string,
  workers: string[],
): string {
  const w = workers.length
    ? workers.join(", ")
    : "(ทีมนี้ยังไม่มี worker — เชิญเพิ่มก่อนแจกงาน)";
  const lines = [
    `คุณคือ orchestrator ชื่อ ${orchestrator} ของทีม ${team}.`,
    `Workers ที่ dispatch ได้: ${w}.`,
    `ผมเปิด project ที่ค้างอยู่: "${projectName}" (absolute path: ${projectPath}) — ยังไม่ได้สั่งให้ทำ sprint นะ.`,
    `เริ่มด้วยการอ่าน state เดิม` +
      ` (docs/*sprint-*.md — ชื่อใหม่ <project>-sprint-N.md หรือชื่อเก่า sprint-N.md, git log --oneline, git worktree list, .orches-notes.md ใน worktree agents/* ที่ยังเปิด) →` +
      ` สรุปให้ผมฟังสั้นๆ ว่าทำถึง sprint ไหน ค้างอะไร เหลืออะไร → แล้วรอคำสั่งผม.`,
    `⛔ อย่าเพิ่งเริ่ม sprint อย่าแจกงาน worker และอย่าถาม build requirement ใหม่ จนกว่าผมจะสั่ง —` +
      ` รอบนี้ผมอาจแค่เข้ามาดูของ ตามหาบัค หรือถามอะไรบางอย่าง. ถามตอบ อ่านโค้ด debug แก้เล็กๆ` +
      ` ทำตรงนั้นได้เลย ไม่ต้องตั้ง sprint ไม่ต้องปลุก worker.`,
    `พอผมสั่งให้ไปต่อจริง ให้เรียก skill ชื่อ 'orches-drive' ผ่าน Skill tool แล้วเดินโหมด resume ตามปกติ` +
      ` (ข้าม Step 0-1 → อ่าน state → เสนอ sprint ถัดไป → แจกงาน worker → poll .orches-done → verify →` +
      ` git merge เข้า main → capture memory) และอย่า dispatch งานให้ตัวเอง.`,
    `ไม่มีคำสั่งที่ต้องพูดเป๊ะ — ตีความจากความหมาย เช่น "ไปต่อ", "ทำ sprint ต่อ", "ลุยเลย", "แจกงานได้",` +
      ` "ทำ sprint N", "resume", "เอาต่อจากที่ค้าง" ล้วนแปลว่าให้เข้าโหมด sprint. กำกวมก็ถามผมสั้นๆ ก่อนหนึ่งคำถาม.`,
    `⛔ การพิมพ์ข้อความว่า "/orches-drive" ในคำตอบของคุณเองไม่ทำให้ skill ทำงาน — ต้องเรียกผ่าน Skill tool เท่านั้น.`,
    `อย่ารัน /orches (bootstrap เลือกทีม/ปลุก — คุณผ่านมาแล้ว).`,
  ];
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

/**
 * env prefix for every interactive `claude` MC launches itself.
 *
 * ⛔⛔ Ghost text is Claude Code guessing what a human would type next and drawing
 * it as the DIM placeholder on an idle pane's `❯` line. The orches engine turns it
 * off for every pane it opens (orches-integrate.sh `cmd_launch_env`, 2026-08-13) —
 * panes MC opens never went through that path, so they kept it on. MC is the one
 * that gets hurt most: `pendingAsk` sends the key `Right`, which is ghost text's
 * ACCEPT key (bare Enter is safe; accept is Tab/Right only), and `capture-pane -p`
 * strips the dim attribute so every probe reads the suggestion as text a human left
 * in the prompt. Measured on newflow6 2026-08-12: 8 distinct strings nobody typed.
 *
 * Deliberately a literal and not a shell-out to `orches-integrate.sh launch-env`:
 * this builder is pure (bun-tested, no fs/child_process) and MC must still launch
 * on a machine where the skill is not installed. `tests` pin the string on both
 * sides, so drift shows up as a red test rather than a silently re-enabled feature.
 */
const LAUNCH_ENV = "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0 ";

/**
 * `--settings` payload for every interactive `claude` MC launches itself.
 *
 * Byte-identical to `orches-integrate.sh launch-settings --orch` (re-read from
 * the live skill 2026-08-14). Same hole as ghost text above: the engine attaches
 * this to every pane IT opens, but the orchestrator pane is opened by MC and never
 * went through `cmd_launch_cmd` — so the driver ran UNTRIMMED while its own workers
 * ran trimmed. Measured on the 08-13 21:58 run: worker `skill_listing` 8,294 tok vs
 * orchestrator 9,778 tok, with dataviz / code-review / artifact-* / update-config /
 * claude-api / security-review visible only to the orchestrator (~1.5k tok it pays
 * every turn for tools its workers cannot even see).
 *
 *  · `autoCompactWindow` — the sprint-boundary /compact design is a package with
 *    this cap; raising the ceiling alone creates no headroom, it just moves the
 *    level the pane floats at.
 *  · `disableBundledSkills` — bundled skills were invoked 0 times across all 9
 *    newflow6 sessions (2026-08-12); the skills actually used live in ~/.claude/skills.
 *  · `disableClaudeAiConnectors` — 14 `mcp__claude_ai_*` tool names for connectors
 *    whose auth does not even pass. ⛔ Does NOT touch `mcpServers` in ~/.claude.json,
 *    so arra-oracle-v3 + skills stay available (the closing protocol needs them).
 *
 * Same reasoning as LAUNCH_ENV for keeping it a literal instead of shelling out to
 * the skill: this builder must stay pure (bun-tested, no fs/child_process) and MC
 * must still launch on a machine where the skill is not installed. Both sides are
 * pinned by tests — orches side in `skills/orches-drive/tests/context-bounding.sh`.
 */
const LAUNCH_SETTINGS =
  '{"autoCompactWindow":500000,"disableBundledSkills":true,"disableClaudeAiConnectors":true}';

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
  // `--settings` sits after --dangerously-skip-permissions (the engine puts it first)
  // purely so the flag pins in teams.test.ts stay contiguous substrings; claude does
  // not care about flag order, and the kickoff stays the trailing positional.
  const inner =
    `cd ${shSingleQuote(repoPath)} && ` +
    `${LAUNCH_ENV}claude ${modelFlag}--dangerously-skip-permissions ` +
    `--settings ${shSingleQuote(LAUNCH_SETTINGS)} ${shSingleQuote(kickoff)}`;
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
