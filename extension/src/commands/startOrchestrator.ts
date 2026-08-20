import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  buildContinueKickoff,
  buildCloneKickoffNote,
  buildKickoffPrompt,
  buildResumeKickoff,
  buildTmuxLaunchCommand,
  formatOrchesLabel,
  resolveOrchesLabel,
  isSafeOracleName,
  type OracleTeam,
  parseOraclePath,
  parseSessionPin,
  parseTeamRoster,
} from "./teams";
import { readTeamDetailSync } from "./teamsOps";
import { listProjectDirsIn } from "./projectScan";
import {
  decideCancelOutcome,
  decideAbortOutcome,
  decideContinueAction,
  readRunMarker,
  resolveContinueTarget,
  runSessionLiveForProject,
  buildRunningMarker,
  writeRunMarker,
} from "./continueRun";
import {
  classifyDriven,
  dedupeByRealpath,
  defaultTeamForProject,
  type DrivenState,
  isProjectLive,
  isResumable,
  nextSprintFromPlan,
  parseOrchesMeta,
  parsePlan,
  parseStateValue,
  projectScanDirs,
  type ResumableProject,
  serializeOrchesMeta,
  sortResumable,
} from "./orchestratorResume";
import {
  labelNamesProject,
  parseTmuxSessions,
  sessionForProjectLabel,
  TMUX_FMT,
  type TmuxSession,
} from "../webview/sessions";

const ORACLES_JSON = path.join(os.homedir(), ".maw", "oracles.json");
const MAW_CONFIG_DIR = path.join(os.homedir(), ".config", "maw");

/** The orchestrator's configured model from the Team Config picker
 *  (~/.claude/teams/<team>/config.json members[].model), or undefined when unset
 *  / unreadable → orchestrator inherits the global default model. This is the
 *  bridge the picker was missing: the value the panel writes now reaches launch. */
function orchestratorModel(teamName: string, orch: string): string | undefined {
  try {
    return readTeamDetailSync(teamName).members.find((m) => m.oracle === orch)?.model || undefined;
  } catch {
    return undefined;
  }
}

// Same rule as maw itself (src/config/load.ts CONFIG_FILE_REGEX): weighted
// numbered files, NOT newest-mtime — a touched legacy maw.config.json must not
// shadow the real weighted config, or the button and `maw wake` would resolve
// different sessions (the split-brain the pin exists to prevent).
const MAW_CONFIG_FILE_REGEX = /^maw\.config\.(\d+)(\.local)?\.json$/;

/** The oracle's pinned tmux session from maw's weighted config files, highest
 *  weight first (`.local` overlays its base). null → no pin → `claude-<orch>`. */
function readSessionPin(oracle: string): string | null {
  try {
    const ranked = fs
      .readdirSync(MAW_CONFIG_DIR)
      .map((f) => MAW_CONFIG_FILE_REGEX.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ f: m[0], num: parseInt(m[1], 10), local: m[2] ? 1 : 0 }))
      .sort((a, b) => b.num - a.num || b.local - a.local);
    for (const c of ranked) {
      const pin = parseSessionPin(
        fs.readFileSync(path.join(MAW_CONFIG_DIR, c.f), "utf8"),
        oracle,
      );
      if (pin) return pin;
    }
    return null;
  } catch {
    return null;
  }
}

// "Start Orchestrator" — a CODE-ONLY bootstrap (no LLM / no skill): read the
// oracle-team rosters off disk, let the user pick a team + orchestrator, then
// open an editor terminal that wakes+attaches JUST the orchestrator oracle
// (`maw wake <orch> --attach`). Workers are left asleep — the orchestrator
// wakes them lazily when it dispatches a sprint. Instant, zero tokens.
const TEAMS_DIR = path.join(os.homedir(), ".maw", "teams");

/** Read every `~/.maw/teams/<name>/oracle-members.json` off disk (skips bad
 *  ones), sorted by name. Empty [] if the dir is missing. */
function readTeams(): OracleTeam[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(TEAMS_DIR);
  } catch {
    return [];
  }
  const out: OracleTeam[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(TEAMS_DIR, entry, "oracle-members.json"), "utf8");
    } catch {
      continue; // no roster in this dir
    }
    const team = parseTeamRoster(entry, raw);
    if (team && team.members.length) out.push(team);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Teams the dashboard "start/continue" screens list. Exported wrapper. */
export function listOrchestratorTeams(): OracleTeam[] {
  return readTeams();
}

/** The `.../github.com/<owner>` dir that holds `projects/` + tool repos,
 *  derived from any oracle's repo path in oracles.json (robust to where soulbrew
 *  lives / owner renames). null if it can't be resolved. */
export function resolveOwnerRoot(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(ORACLES_JSON, "utf8")) as {
      oracles?: { local_path?: string }[];
    };
    for (const o of data?.oracles ?? []) {
      const p = o?.local_path;
      if (typeof p !== "string" || !p) continue;
      const m = p.replace(/\/+$/, "").match(/^(.*\/github\.com\/[^/]+)\/[^/]+$/);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

function countSprintDocs(dir: string): number {
  try {
    return fs
      .readdirSync(path.join(dir, "docs"))
      .filter((f) => /^(?:.+-)?sprint-\d+.*\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** Count open `agents/*` git worktrees (leftover in-progress sprint work). */
function countOpenAgentWorktrees(dir: string): number {
  try {
    const out = cp
      .execFileSync("git", ["-C", dir, "worktree", "list"], { timeout: 1500 })
      .toString();
    return out.split("\n").filter((l) => /\/agents\//.test(l)).length;
  } catch {
    return 0;
  }
}

function readMeta(dir: string) {
  try {
    return parseOrchesMeta(fs.readFileSync(path.join(dir, ".orches-meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Read the planned/done sprint counts + the next unchecked sprint from
 *  docs/plan.md (null if no plan). One file read feeds both parsers. */
function readPlan(
  dir: string,
): { total: number; done: number; next: { id: string; title: string } | null } | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "docs", "plan.md"), "utf8");
    const counts = parsePlan(raw);
    if (!counts) return null;
    return { ...counts, next: nextSprintFromPlan(raw) };
  } catch {
    return null;
  }
}

/** Every project under projects/ (owner-root and ghq-root). NOT filtered by team
 *  (user picks the team after). Sorted so the most-recently-driven is first.
 *  By default nothing is filtered out — the Projects screen is a full inventory, so
 *  a project with no docs/plan/worktree still lists (as a plain row: no sprint rail,
 *  no continue button, since pending = 0). Hiding those made the list look like it
 *  had silently dropped projects.
 *  `opts.resumableOnly` = keep only dirs with real leftover work (`isResumable`) —
 *  used by the dashboard's "ทำต่อ" wizard, where an unstartable project is noise. */
export function scanProjects(opts?: { resumableOnly?: boolean }): ResumableProject[] {
  const root = resolveOwnerRoot();
  if (!root) return [];
  const candidates: string[] = [];
  // Location-tolerant: scan the canonical owner-root/projects AND the ghq-root/projects
  // (derived by projectScanDirs) so a project accidentally built in the stray
  // soulbrew/projects still appears — matching where the Budget page attributes it.
  // owner-root's dir is scanned FIRST so it wins the realpath-dedup below.
  for (const projectsDir of projectScanDirs(root)) {
    candidates.push(...listProjectDirsIn(projectsDir));
  }
  // Only projects/ (walked above) holds build targets — every other org-root
  // sibling (bob-oracle, missionControl, orches-skills, ...) is a tool/agent
  // repo, not a project, so it must never be scanned here.
  // Collapse symlink duplicates: a soulbrew/projects entry that points into
  // owner-root/projects (e.g. a bridge symlink) must not list the project twice.
  const out: ResumableProject[] = [];
  for (const p of dedupeByRealpath(candidates, (q) => fs.realpathSync(q))) {
    const sprintDocs = countSprintDocs(p);
    const openWorktrees = countOpenAgentWorktrees(p);
    const plan = readPlan(p);
    if (
      opts?.resumableOnly &&
      !isResumable({ sprintDocs, openWorktrees, plannedTotal: plan?.total, plannedDone: plan?.done })
    )
      continue;
    const meta = readMeta(p);
    out.push({
      name: path.basename(p),
      path: p,
      sprintDocs,
      openWorktrees,
      plannedTotal: plan?.total,
      plannedDone: plan?.done,
      metaTeam: meta?.team,
      lastRun: meta?.lastRun,
      nextSprintId: plan?.next?.id,
      nextSprintTitle: plan?.next?.title,
    });
  }
  return sortResumable(out);
}

/** Live tmux pane cwds across every session (empty if tmux is absent/errors).
 *  One cheap `tmux list-panes` — no LLM, no tokens. */
function listLiveAgentPanePaths(): string[] {
  try {
    return cp
      .execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_current_path}"], { timeout: 1500 })
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Refresh each project's `doing` flag from the CURRENT tmux pane set. Cheap
 *  (one `tmux list-panes`), so the "⠋ กำลังทำ" indicator re-evaluates on every
 *  screen refresh without re-walking the filesystem. Mutates in place. */
export function annotateLiveState(projects: ResumableProject[]): void {
  const live = listLiveAgentPanePaths();
  for (const p of projects) p.doing = isProjectLive(p.path, live);
}

/** Default team for a resumable project (whoever drove it last), given the
 *  currently-pickable teams. null → user picks with no default. */
export function defaultTeamFor(project: ResumableProject, teams: OracleTeam[]): string | null {
  return defaultTeamForProject(
    { team: project.metaTeam, lastRun: project.lastRun },
    teams.map((t) => t.name),
  );
}

// This module no longer owns any terminal: launches are headless and the one
// place that opens a REPL view is webview/claudeView.ts (which delegates the
// native flavour to webview/attachTerminal.ts). The per-orchestrator terminal
// map and its runInTerminal helper went with attachToProject.

/** If `project` is already being driven by a live orchestrator (its team's
 *  orchestrator tmux session is up), open/reveal THAT session's terminal —
 *  ATTACH ONLY, no new kickoff, no re-dispatch — and return true. Returns false
 *  when nothing live is found → caller runs the normal team → orchestrator →
 *  launch flow. This is what makes clicking a "doing" project re-enter its
 *  running session instead of spawning a conflicting one on top. Returns the
 *  attached session name (truthy) so the caller can open the chat for it; null
 *  when nothing live was found. */
/** WHICH live session is driving `project` — the resolution half of
 *  attachToProject, with no terminal side effect. Split out so a caller can ask
 *  "what session?" and then open it in whichever view the user chose (see
 *  webview/claudeView.ts); attachToProject itself is now the native-only path. */
export function resolveProjectSession(
  project: ResumableProject,
  preferSession?: string,
): string | null {
  const meta = readMeta(project.path);
  const team = meta?.team ? readTeams().find((t) => t.name === meta.team) : undefined;
  const orch = team?.orchestrators[0];
  // `preferSession` (the authoritative session the detector picked — owner/labeled/
  // run) wins, so we attach even when .orches-meta.json has no team (the gap where
  // the old guard returned false → caller spawned a twin). Then the stamped meta
  // session, then the orchestrator's pin/default.
  const candidates = [
    ...(preferSession ? [preferSession] : []),
    ...(meta?.session ? [meta.session] : []),
    ...(orch && isSafeOracleName(orch) ? [readSessionPin(orch)?.trim() || `claude-${orch}`] : []),
  ];
  return candidates.find((s) => /^[\w.-]+$/.test(s) && tmuxHasSession(s)) ?? null;
}

// ⛔ attachToProject (resolve + force-open an editor terminal) was REMOVED once the
//    view became a user setting: it was the last path that decided the view for the
//    user, and leaving a dead exported terminal-opener around is how a later caller
//    silently bypasses the setting. Callers now use resolveProjectSession above and
//    hand the session to webview/claudeView.openClaudeView.

export function tmuxHasSession(session: string): boolean {
  try {
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** owner-session recorded in <project>/.orches-state (fs read, NO subprocess). */
export function ownerSessionFromState(projectPath: string): string | null {
  try {
    return parseStateValue(
      fs.readFileSync(path.join(projectPath, ".orches-state"), "utf8"),
      "owner-session",
    );
  } catch {
    return null;
  }
}

/** Every live tmux session (name + @orches_label + …). ONE `tmux list-sessions`;
 *  [] if tmux is absent. Callers share one list across rows (avoid N subprocesses). */
export function listTmuxSessionsSafe(): TmuxSession[] {
  try {
    return parseTmuxSessions(
      cp.execFileSync("tmux", ["list-sessions", "-F", TMUX_FMT], { timeout: 1500 }).toString(),
    );
  } catch {
    return [];
  }
}

/** THE single "is project X being driven right now?" detector — reused by every
 *  spawn path AND the green-row render, so enforcement + display never disagree.
 *  Priority worker > run > owner > labeled (see classifyDriven). `owner`
 *  (.orches-state owner-session still in tmux) is the signal that catches a
 *  checkpoint-paused orchestrator (worker + run both dead then). Returns the
 *  winning session so the caller attaches the RIGHT one.
 *  PRECOND: caller ran annotateLiveState([project]) so project.doing is fresh.
 *  Pass a shared `sessions` list to avoid a tmux call per row; `cheap:true` skips
 *  the owner/labeled probe (spin-poll tick — a live run already short-circuits). */
export function projectDrivenState(
  project: ResumableProject,
  ctx?: { sessions?: TmuxSession[]; runAlive?: boolean },
): { state: DrivenState; session?: string } {
  const workerLive = project.doing ?? false;
  const marker = readRunMarker(project.path);
  // runAlive may be precomputed by the render (which already probed the marker's
  // session for the button state) → avoids a duplicate has-session/created probe.
  let runAlive = ctx?.runAlive;
  if (runAlive === undefined) {
    runAlive = false;
    // liveness scoped to THIS project by @orches_label (not bare session-name): a
    // cold-launch base-name collision must NOT let project B's live session light A.
    const sess = ctx?.sessions ?? listTmuxSessionsSafe();
    if (marker?.session && runSessionLiveForProject(marker, sess, project.name)) {
      const created = sessionCreatedAt(marker.session);
      const zombie =
        marker.sessionCreatedAt !== undefined && created !== undefined && created !== marker.sessionCreatedAt;
      runAlive = !zombie;
    }
  }
  let ownerAlive = false;
  let ownerSess: string | undefined;
  let labeled: TmuxSession | null = null;
  if (!workerLive && !runAlive) {
    const sessions = ctx?.sessions ?? listTmuxSessionsSafe();
    const os = ownerSessionFromState(project.path);
    // The owner-session must ALSO be @orches_label'd for THIS project. An
    // orchestrator reuses ONE base session name across every project it drives,
    // so name-only matching would light up project A on project B's live session
    // (false "owner" → attach to the wrong project, block A's real resume).
    const ownerS = os
      ? sessions.find((s) => s.name === os && labelNamesProject(s.orchesLabel, project.name))
      : undefined;
    if (ownerS) {
      ownerAlive = true;
      ownerSess = ownerS.name;
    } else {
      labeled = sessionForProjectLabel(project.name, sessions);
    }
  }
  const state = classifyDriven({ workerLive, runAlive, ownerAlive, labelMatch: !!labeled });
  const session =
    state === "run" ? marker!.session : state === "owner" ? ownerSess : state === "labeled" ? labeled!.name : undefined;
  return { state, session };
}

/** Best-effort teardown of a finished headless run's tmux session. Exact-match
 *  (`=`) so it can NEVER hit another run's / a prefix-matched session, and a safe
 *  name guard so a junk value can't turn into an unexpected target. A `--once`
 *  button-run has no one attached, so once its done/error marker lands the
 *  session is just a husk (dead orchestrator window + maybe idle worker windows)
 *  — reaping it is what actually "closes the session when the run finishes". */
export function reapSession(session: string): void {
  if (!/^[\w.-]+$/.test(session)) return;
  try {
    cp.execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
  } catch {
    /* already gone / no tmux server */
  }
}

/** First free twin session name: base-2, base-3, … (base itself is taken). */
function nextTwinSession(base: string): string {
  for (let i = 2; i <= 9; i++) {
    if (!tmuxHasSession(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now() % 1000}`; // 9 twins already?! — just don't collide
}

// ── inline "▶ continue" button: detached one-sprint launch + safe cancel ──────
// These are tmux/git side-effect wrappers — NOT bun-unit-tested. Their pure
// inputs (resolveContinueTarget, marker fns, decideCancelOutcome) are covered by
// continueRun.test.ts; verification here is `npm run compile` + manual E2E.

/** tmux #{session_created} (epoch seconds) for a session, or undefined.
 *  Target is `=<session>:` (exact session + active window) — a bare `=<session>` makes
 *  display-message resolve built-in session vars to EMPTY for a DETACHED session (tmux
 *  3.4 quirk), which would return undefined here and poison the zombie-guard now that
 *  orchestrator sessions are created detached. The `:` restores session context. */
export function sessionCreatedAt(session: string): number | undefined {
  try {
    const out = cp
      .execFileSync("tmux", ["display-message", "-p", "-t", `=${session}:`, "#{session_created}"], {
        encoding: "utf8",
      })
      .trim();
    if (!out) return undefined; // empty output → undefined, NOT Number("")===0 (a bogus 0 poisons the zombie-guard: 0===0 makes stale runs read as live)
    const n = Number(out);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Launch ONE headless sprint for `project` with its last-used team, detached in
 *  tmux (attachable but no editor terminal opened). No-ask: team/orchestrator are
 *  auto-resolved from .orches-meta.json. Writes the .orches-run.json marker the
 *  webview polls. Idempotent-ish: if a run is already live for this project it is
 *  a no-op that returns the existing session. */
export function launchContinueRun(
  project: ResumableProject,
  sprints = 1, // >1 → "▶▶ ทำหลาย sprint": N sprints headless in one detached run
): { error?: string; session?: string; attached?: boolean } {
  const teams = readTeams();
  const target = resolveContinueTarget(project, teams);
  if ("error" in target) return { error: target.error };

  // 1-project-1-session guard: ONE detector decides if this project is already
  // being driven (worker / run / owner-at-checkpoint / labeled). NEVER fork a
  // twin onto a repo a session already drives — attach to the winning session.
  annotateLiveState([project]);
  const driven = projectDrivenState(project);
  const action = decideContinueAction(driven.state);
  if (action === "already-running") return { session: driven.session };
  if (action === "attach") {
    // Resolve only — the CALLER opens it in whichever view the setting says
    // (webview/claudeView.ts). Opening a terminal from in here would ignore it.
    const live = resolveProjectSession(project, driven.session);
    if (live) return { attached: true, session: live };
    return {
      error: `'${project.name}' กำลังถูกขับอยู่ (session ${driven.session ?? "?"}) — เปิด session นั้น ไม่ launch ซ้ำ`,
    };
  }
  // action === "launch" (state none) → spawn below.

  // The orchestrator runs in ITS OWN oracle repo (loads its CLAUDE.md + ψ), not
  // the project repo — the project path travels in the kickoff. Same resolution
  // as launchOrchestrator so the button, `maw wake`, and resume all converge.
  let orchRepo: string | null = null;
  try {
    orchRepo = parseOraclePath(fs.readFileSync(ORACLES_JSON, "utf8"), target.orch);
  } catch {
    orchRepo = null;
  }
  if (!orchRepo) {
    return {
      error: `หา repo ของ '${target.orch}' ไม่เจอใน ~/.maw/oracles.json — ลองรัน \`maw oracle scan\` ก่อน`,
    };
  }

  const baseSession = readSessionPin(target.orch)?.trim() || `claude-${target.orch}`;
  const session = tmuxHasSession(baseSession) ? nextTwinSession(baseSession) : baseSession;

  const workers = target.team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle)
    .filter(isSafeOracleName);
  const kickoff = buildContinueKickoff(
    project.name,
    project.path,
    target.team.name,
    target.orch,
    workers,
    sprints,
  );
  const command = buildTmuxLaunchCommand(
    target.orch,
    orchRepo,
    kickoff,
    session,
    workers,
    false,
    formatOrchesLabel(project.name, target.team.name),
    orchestratorModel(target.team.name, target.orch),
  );

  let baseMainSha = "";
  try {
    baseMainSha = cp
      .execFileSync("git", ["-C", project.path, "rev-parse", "HEAD"], { encoding: "utf8" })
      .trim();
  } catch {
    /* fresh repo with no commit — abort revert will simply skip the reset */
  }
  try {
    cp.execFileSync("bash", ["-lc", command]);
  } catch (e) {
    return { error: `launch ล้มเหลว: ${String(e)}` };
  }
  writeRunMarker(
    project.path,
    buildRunningMarker({
      plannedDone: project.plannedDone,
      sprints, // ⛔ ต้องส่ง: engine ใช้คู่กับ sprint หาว่ารอยต่อไหนคือรอบสุดท้ายของรัน
      session,
      sessionCreatedAt: sessionCreatedAt(session),
      baseMainSha,
      startedAt: new Date().toISOString(),
    }),
  );
  return { session };
}

/** Cancel a running continue-run: kill its session, then decide keep-done vs
 *  revert. Never rewrites already-merged/pushed history — the safe local revert
 *  is delegated to `orches-integrate.sh abort`, whose own guard skips when
 *  origin/main is ahead of the recorded base. */
export async function cancelContinueRun(project: ResumableProject): Promise<void> {
  const marker = readRunMarker(project.path);
  if (!marker) return;
  try {
    cp.execFileSync("tmux", ["kill-session", "-t", `=${marker.session}`], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  // Re-read AFTER the kill — the sprint's "done" may have landed in the race
  // between the user clicking cancel and orches-drive finishing.
  const after = readRunMarker(project.path);
  const intg = `${os.homedir()}/.claude/skills/orches-drive/orches-integrate.sh`;
  if (decideCancelOutcome(after?.status, false) === "keep_done") {
    writeRunMarker(project.path, { ...(after ?? marker), status: "done" });
    return;
  }
  // ⛔ ต้องอ่านคำตอบของ abort ไม่ใช่ทิ้ง stdout แล้วเขียน "cancelled" ทุกกรณี:
  //    execFileSync โยนได้จริง (เครื่องที่ยังไม่ได้ลง skill = ไม่มีไฟล์ engine) แล้วเดิม catch
  //    กลืนไว้ → การ์ดเงียบเหมือนย้อนของคืนเรียบร้อย ทั้งที่ worktree agents/* ยังอยู่ครบ
  let verdict: string | null = null;
  try {
    verdict = cp.execFileSync("bash", [intg, "abort", project.path, marker.baseMainSha ?? ""], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    verdict = null; // ไม่ได้รัน / รันแล้วพัง — decideAbortOutcome จะตีเป็น error ไม่ใช่ cancelled
  }
  writeRunMarker(project.path, { ...marker, ...decideAbortOutcome(verdict) });
}

/** Extra kickoff block for a twin session — same oracle, second brain-thread.
 *  ψ + the oracle DB are ONE shared store per oracle, so the twin must tag its
 *  captures (provenance) and append-not-overwrite shared files; worker clashes
 *  are guarded by orches-drive but the twin is told to yield, not steal. */
function twinKickoffNote(session: string, base: string, orch: string): string {
  return (
    `\n\n[instance] คุณคือ instance '${session}' ของ ${orch} — instance '${base}' ของ ${orch} กำลังรัน run อื่นอยู่ · 1 session = 1 team run แยกขาดกัน:\n` +
    `- ψ/DB ของ ${orch} เป็นก้อนเดียวแชร์กัน → แท็กทุก memory capture (oracle_learn / oracle_trace / /rrr) ด้วย "[${session}]" + project ใน summary เพื่อไม่ปนกับ run อื่น\n` +
    `- ไฟล์ ψ ที่แชร์ (เช่น ψ/inbox/pending-rrr.md) → append เท่านั้น ห้ามเขียนทับ/แก้ไฟล์เดิม\n` +
    `- worker ที่ run อื่นใช้อยู่ = ห้ามแย่ง/ห้าม wake ซ้ำ → เปิด instance window ของ worker ใน session นี้ (orches-drive Step 3.5)`
  );
}

/** Wake + attach the orchestrator with the right kickoff (fresh build vs
 *  resume). Shared by the command palette flow and the dashboard screens.
 *  1 session = 1 team run: a resume of an already-live project re-attaches to
 *  its session; otherwise this run gets its own session (base pin if free, else
 *  a fresh `base-N` instance) — no modal, no twin/inject prompt.
 *  On resume it also stamps `.orches-meta.json` (team + session) so the team
 *  picker defaults and attach-on-doing find the right session next time. */
export async function launchOrchestrator(opts: {
  orch: string;
  team: OracleTeam;
  mode: "new" | "resume";
  project?: ResumableProject;
  projectName?: string;
  /** โปรเจคใหม่ที่ MC clone มาให้แล้ว (path + ต้นทาง) — เปลี่ยน kickoff เป็นแบบ brownfield */
  cloned?: { url: string; path: string };
}): Promise<{ error?: string; cancelled?: boolean; session?: string; terminal?: vscode.Terminal }> {
  const { orch, team, mode, project, projectName, cloned } = opts;
  if (!isSafeOracleName(orch)) return { error: `ชื่อ orchestrator ไม่ปลอดภัย: ${orch}` };
  if (mode === "resume" && !project) return { error: "resume แต่ไม่มี project" };

  let repoPath: string | null = null;
  try {
    repoPath = parseOraclePath(fs.readFileSync(ORACLES_JSON, "utf8"), orch);
  } catch {
    repoPath = null;
  }
  if (!repoPath) {
    return {
      error: `หา repo ของ '${orch}' ไม่เจอใน ~/.maw/oracles.json — ลองรัน \`maw oracle scan\` ก่อน`,
    };
  }

  // 1 project = 1 session: a resume of a project ALREADY being driven (worker /
  // headless run / owner-session live at a checkpoint / @orches_label) re-attaches
  // to THAT session instead of forking a twin. Uses the same detector as the
  // button, so the project's own owner-session is resolved precisely (not merely
  // "the orchestrator has some live session" that might be another project).
  // mode:"new" is NOT gated → a fresh build still mints its own instance.
  if (mode === "resume" && project) {
    annotateLiveState([project]);
    const driven = projectDrivenState(project);
    if (driven.state !== "none") {
      // Resolve only; every caller opens `session` through claudeView, so the
      // view-mode setting decides chat-vs-terminal (this used to force a terminal).
      const attached = resolveProjectSession(project, driven.session);
      if (attached) return { session: attached }; // real attached session (driven.session is undefined for the 'worker' state)
      return {
        error: `'${project.name}' กำลังถูกขับโดย session '${driven.session ?? "?"}' อยู่แล้ว — เข้า session นั้นแทน (ไม่สร้างซ้ำ)`,
      };
    }
  }

  const workers = team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle)
    .filter(isSafeOracleName); // same whitelist as the orchestrator name — keeps unsafe roster entries out of the dispatch list AND the pane-layout shell args
  let kickoff =
    mode === "resume" && project
      ? buildResumeKickoff(project.name, project.path, team.name, orch, workers)
      : buildKickoffPrompt(team.name, orch, workers);
  if (mode === "new" && projectName && projectName.trim())
    kickoff += `\n\nโปรเจคชื่อ '${projectName.trim()}' — ใช้ชื่อนี้เป๊ะเป็นชื่อ project/repo (ผ่านการเช็คว่างแล้ว) · ⛔ ห้ามตั้งชื่อใหม่/ห้าม bump -vN เอง`;
  // clone มาแล้ว = โฟลเดอร์มีโค้ดของคนอื่นอยู่ → ต้องอ่านก่อนถาม และห้าม push กลับต้นทาง
  if (mode === "new" && cloned)
    kickoff += buildCloneKickoffNote(projectName?.trim() || path.basename(cloned.path), cloned.path, cloned.url);

  const baseSession = readSessionPin(orch)?.trim() || `claude-${orch}`;
  let session = baseSession;

  if (tmuxHasSession(baseSession)) {
    // Base session is busy with ANOTHER run — no modal, no twin/inject choice.
    // This run gets its own fresh instance session (1 session = 1 team instance);
    // the orchestrator pulls its workers into THIS session (orches-drive Step 3.5).
    session = nextTwinSession(baseSession); // base-2, base-3, …
    kickoff += twinKickoffNote(session, baseSession, orch);
  }

  if (mode === "resume" && project) {
    try {
      fs.writeFileSync(
        path.join(project.path, ".orches-meta.json"),
        serializeOrchesMeta(team.name, Date.now(), session),
      );
    } catch {
      /* marker is best-effort */
    }
  }

  // Stamp "<project> / <team>" as the session label at create-time whenever the
  // name is already known: a resume (project loaded) OR a new build named up-front
  // in the dashboard popup (projectName). Only a nameless new build defers to the
  // orchestrator's own runtime @orches_label set (it picks a name at runtime).
  const orchesLabel = resolveOrchesLabel(
    mode === "resume" && project ? project.name : projectName,
    team.name,
  );
  // Safe: session = maw pin (NN-oracle) / claude-<safe-orch> (+ "-N" twin suffix).
  // ⛔ There was an `inject` branch here that send-keys'd the kickoff into a live pane
  // instead of creating a session. It was dead (`inject` was never assigned true after
  // the twin-session redesign) and it carried a trap: its target was a bare
  // `=${session}`, the one form tmux 3.4 rejects for send-keys, inside a silent
  // try/catch. Removed 2026-08-20; `commands/tmuxTarget.guard.test.ts` keeps the shape out.
  const command = buildTmuxLaunchCommand(
    // attach=FALSE → create the session DETACHED. The chat webview is the sole
    // interface; an ATTACHED terminal reacts to every send-keys keystroke + pane
    // toggle and yanks editor focus back to the (garbled-Thai) terminal. Detached
    // → the terminal only bootstraps, then doLaunch disposes it once the session is up.
    orch, repoPath, kickoff, session, workers, false, orchesLabel,
    orchestratorModel(team.name, orch),
  );

  // CHAT-FIRST: the launch command creates the tmux session DETACHED (attach=false),
  // so it is fire-and-forget — tmux daemonizes the session and the command returns at
  // once. There is nothing interactive to host, so we run it HEADLESS (no editor
  // terminal). A terminal here was vestigial once attach became false AND could not be
  // disposed reliably — it lingered as a stray tab and, being the only other editor tab,
  // kept yanking focus back to the garbled-Thai REPL whenever the user typed in the
  // chat. The chosen REPL view (Settings → หน้าตา Claude REPL) is opened by the
  // caller once this returns the session name.
  try {
    cp.execSync(command, { stdio: "ignore", env: process.env, timeout: 15000 });
  } catch (e) {
    return { error: `เปิด session ไม่สำเร็จ: ${(e as Error).message}` };
  }
  return { session };
}

export async function startOrchestratorCommand(_context: vscode.ExtensionContext) {
  const teams = readTeams();
  if (!teams.length) {
    vscode.window.showWarningMessage(
      "Mission Control: ไม่พบ oracle-team ใน ~/.maw/teams — สร้างก่อนด้วย `maw bud <ชื่อ>` + `maw team oracle-invite <ชื่อ> --team <t> --role orchestrator`",
    );
    return;
  }

  // 1) pick a team (clean list straight from disk — no analysis)
  const teamPick = await vscode.window.showQuickPick(
    teams.map((t) => ({
      label: t.name,
      description: `${t.members.length} members · orchestrator: ${
        t.orchestrators.join(", ") || "(none)"
      }`,
      team: t,
    })),
    { title: "Start Orchestrator — เลือกทีม", placeHolder: "เลือก oracle-team" },
  );
  if (!teamPick) return;
  const team = teamPick.team;

  // 2) resolve the orchestrator (1 → auto, >1 → pick, 0 → guide)
  let orch: string | undefined;
  if (team.orchestrators.length === 1) {
    orch = team.orchestrators[0];
  } else if (team.orchestrators.length > 1) {
    orch = await vscode.window.showQuickPick(team.orchestrators, {
      title: `${team.name} — เลือก orchestrator`,
      placeHolder: "ทีมนี้มี orchestrator หลายตัว",
    });
  } else {
    vscode.window.showWarningMessage(
      `Mission Control: ทีม '${team.name}' ไม่มี member role:orchestrator — tag ก่อน: ` +
        `maw team oracle-invite <ชื่อ> --team ${team.name} --role orchestrator`,
    );
    return;
  }
  if (!orch) return;

  // 3) wake + attach (fresh build kickoff). Resume flow goes through the
  //    dashboard screens (launchOrchestrator with mode:"resume").
  //    ⛔ เคยมีขั้นถาม "ปกติ vs โหมดถาม" (grilling + scrutinize) คั่นตรงนี้ — ถอดออก 2026-08-05
  //    (user สั่ง: ไม่เคยได้ใช้เลย) · ถอดทั้งขั้น ไม่ใช่เหลือ QuickPick ที่มีตัวเลือกเดียวให้กดผ่าน
  const r = await launchOrchestrator({ orch, team, mode: "new" });
  if (r.cancelled) return;
  if (r.error) {
    vscode.window.showErrorMessage(`Mission Control: ${r.error}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Mission Control: ปลุก orchestrator '${orch}' (team ${team.name}) + เริ่ม /orches-drive — ` +
      `foreman จะถาม requirement ใน terminal เอง · worker ปลุกตอนแจกงาน`,
  );
}
