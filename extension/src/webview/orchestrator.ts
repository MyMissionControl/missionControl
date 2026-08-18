import * as vscode from "vscode";

import * as gitOps from "../commands/gitOps";
import {
  gitStaleNote,
  parseGitButtonState,
  pickAutoFetch,
  type GitButtonState,
} from "../commands/gitStatus";
import {
  annotateLiveState,
  cancelContinueRun,
  defaultTeamFor,
  launchContinueRun,
  launchOrchestrator,
  listOrchestratorTeams,
  listTmuxSessionsSafe,
  projectDrivenState,
  reapSession,
  resolveProjectSession,
  scanProjects,
  sessionCreatedAt,
  resolveOwnerRoot,
  tmuxHasSession,
} from "../commands/startOrchestrator";
import { orderForProjectScreen, sortResumable, toggleStar, type ResumableProject } from "../commands/orchestratorResume";
import { removeProjectDir, summarizeUnsaved, unsavedWarning } from "../commands/deleteProject";
import {
  listDetailDocs,
  resolveProjectFile,
  renderMarkdown,
  hasMermaid,
} from "../commands/projectDocs";
import { listBackedUpProjects, type BackupEntry } from "../commands/docsBackup";
import { openDataViewPanel } from "./dataView";
import { openClaudeViewDeferred } from "./claudeView";
import {
  isPreviewAvailable,
  isPreviewRunning,
  togglePreview,
  waitForPreviewUrl,
} from "../commands/previewOps";
import {
  clampSprintCount,
  finishedSessions,
  pendingSprints,
  readRunMarker,
  resolveButtonState,
  resolveCardActions,
  runSessionLiveForProject,
} from "../commands/continueRun";
import type { OracleTeam } from "../commands/teams";
import {
  ORG,
  checkProjectName,
  suggestDefaultName,
  suggestFromBase,
  sanitizeName,
  type NameCheck,
} from "../commands/projectName";
import { cloneRepoInto, parseRepoUrl } from "../commands/repoClone";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTabIcon } from "./tabIcon";

// Single "Projects" webview panel (its OWN editor tab, mirroring teams.ts) — the
// one entry point for both continuing a project and starting a new build:
//   resume: pick a project → team → orchestrator → launch (mode resume)
//   new:    "+ เริ่มโปรเจคใหม่" (no project) → team → orchestrator → launch (mode new)
// The distinction is purely whether a project was picked (_st.project). The
// project rows carry the per-repo git buttons (Commit/Push/Create&Push).
let _panel: vscode.WebviewPanel | undefined;

interface WizState {
  projects: ResumableProject[];
  project?: ResumableProject; // set → resume that project; unset → fresh build
  team?: OracleTeam;
  newName?: string; // ชื่อ project ที่ user ตั้งใน name-popup (mode "new") → ส่งเข้า kickoff
  // repo ที่ clone มาให้แล้ว (name-popup กรอก URL) — เปลี่ยน kickoff เป็น brownfield
  newClone?: { url: string; path: string };
  archivedView?: boolean; // showing the deleted-projects list instead of live projects
  archived?: boolean; // currently viewing a deleted project's docs (read-only)
  backups?: BackupEntry[]; // cached deleted-projects list for pick_archived
}
let _st: WizState | undefined;
// Which screen is currently showing. The spin-poll only re-renders the projects list
// when it is the visible screen — otherwise a running project's 2.5s tick would clobber
// the Detail / teams / orch screen the user navigated to.
let _screen: "projects" | "detail" | "teams" | "orch" | "archived" = "projects";

const STARRED_KEY = "missioncontrol.starredProjects";
let _ctx: vscode.ExtensionContext | undefined;

/** Starred project paths from per-user globalState (empty if context missing). */
function starredList(): string[] {
  return _ctx?.globalState.get<string[]>(STARRED_KEY, []) ?? [];
}
async function setStarred(list: string[]): Promise<void> {
  await _ctx?.globalState.update(STARRED_KEY, list);
}

// ── background auto-fetch ────────────────────────────────────────────────────
// ahead/behind come from the remote-tracking refs, i.e. from whenever this repo
// last fetched — so without this the list only ever showed how things stood at
// the last manual ⟳, and a row could sit on a green "up to date" chip while
// origin had moved on (press Push → rejected → now genuinely diverged).
//
// Measured on 16 real projects: fetching them all in parallel takes ~2.5s, and
// a `git status` sweep (what the list already does every tick) takes 53ms. The
// cost is not the wall-clock, it is the ONE bad network state — a route that
// accepts the connection and never answers (VPN dropped, captive wifi) — where
// git hangs until the 20s timeout kills it. DNS failure and missing credentials
// both fail in under a third of a second. So the fetch never blocks a render:
// the screen is drawn from what is on disk, the fetch happens after, and the
// list is redrawn only if the user is still looking at it.
const AUTOFETCH_STALE_MS = 5 * 60_000;
let _autoFetching = false;
/** path → when we last ATTEMPTED an auto-fetch. Keyed on the attempt, not on
 *  success: a repo that is offline never refreshes its FETCH_HEAD, so keying on
 *  staleness alone would re-fetch it on every single redraw. */
const _autoFetchedAt = new Map<string, number>();

function scheduleAutoFetch(
  panel: vscode.WebviewPanel,
  states: Record<string, GitButtonState>,
): void {
  if (_autoFetching) return;
  const now = Date.now();
  const staleByPath: Record<string, number | undefined> = {};
  for (const p of Object.keys(states)) staleByPath[p] = states[p]?.staleMs;
  const stale = pickAutoFetch(staleByPath, _autoFetchedAt, now, AUTOFETCH_STALE_MS);
  if (!stale.length) return;
  _autoFetching = true;
  for (const p of stale) _autoFetchedAt.set(p, now);
  void (async () => {
    try {
      await Promise.all(stale.map((p) => gitOps.fetchRepo(p)));
    } finally {
      _autoFetching = false;
    }
    // Redraw only if this panel is still the live one AND still showing the
    // list — posting to a disposed webview throws, and clobbering the Detail
    // screen the user navigated to mid-fetch would be worse than a stale chip.
    if (_panel === panel && _screen === "projects") await pushProjectsScreen(panel);
  })();
}

async function computeGitStates(
  projects: ResumableProject[],
  fetch = false,
): Promise<Record<string, GitButtonState>> {
  const out: Record<string, GitButtonState> = {};
  await Promise.all(
    projects.map(async (p) => {
      if (fetch) await gitOps.fetchRepo(p.path);
      out[p.path] = parseGitButtonState(await gitOps.readGitStatus(p.path));
    }),
  );
  return out;
}

// ── name-popup: local + github availability probes (impure; pure logic = projectName.ts) ──
// รายชื่อโฟลเดอร์ทั้งหมดใต้ projects root (local-taken = ทุกโฟลเดอร์ ไม่ใช่แค่ resumable)
function localProjectNames(): string[] {
  const first = scanProjects()[0];
  if (!first) return [];
  try {
    return fs
      .readdirSync(path.dirname(first.path), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return scanProjects().map((p) => p.name);
  }
}
let _ghOk: boolean | undefined;
function ghAvailable(): boolean {
  if (_ghOk === undefined) {
    try {
      cp.execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 4000 });
      _ghOk = true;
    } catch {
      _ghOk = false;
    }
  }
  return _ghOk;
}
// true = repo exists (taken) · false = 404 (free) · null = gh ไม่พร้อม/ตรวจไม่ได้
function ghView(name: string): boolean | null {
  if (!ghAvailable()) return null;
  try {
    cp.execFileSync("gh", ["repo", "view", `${ORG}/${name}`, "--json", "name"], {
      stdio: "ignore",
      timeout: 6000,
    });
    return true;
  } catch {
    return false; // non-zero = 404 (free) · ensure-remote ยัง guard org ตอน push (safety net)
  }
}

// Navigation token — bumped by every screen push. A push that awaits (git status
// per project, a GitHub remote lookup) checks it again before posting and drops
// its result if the user has navigated since.
//
// ⛔ Why: on a cold open, pushProjectsScreen spends ~1s reading git state. The user
// clicks a project during that second, Detail renders — and then the stale list
// post lands and throws them back to the list, so every project needs TWO clicks
// (reported 2026-08-14). A screen-name check alone is not enough: clicking project
// B while A's Detail push is in flight leaves both on "detail", and A could still
// win. Always compare the token immediately before postMessage, never before the
// awaits.
let _nav = 0;
function stillCurrent(panel: vscode.WebviewPanel, token: number): boolean {
  return _panel === panel && _nav === token;
}

async function pushProjectsScreen(panel: vscode.WebviewPanel, fetch: boolean | "spin" = false) {
  _screen = "projects";
  const token = ++_nav;
  const projects = _st?.projects ?? [];
  annotateLiveState(projects); // refresh the live "doing" flag each render (cheap: one tmux call)
  const starred = new Set(starredList());
  // hero (index 0) stays the most-recent project; stars pin to the top of the
  // queue UNDER it — the hero card is labelled "ทำต่อจากล่าสุด".
  const ordered = orderForProjectScreen(projects, starred);
  const states = await computeGitStates(ordered, fetch === true);
  // Green-row detector: share ONE `tmux list-sessions` across all rows, computed
  // every render (incl. spin ticks) so an owner/label-driven project doesn't
  // flicker gray between full renders. `fetch==="spin"` only skips the git fetch.
  const sessions = listTmuxSessionsSafe();
  if (!stillCurrent(panel, token)) return; // user drilled into a project while we read git
  panel.webview.postMessage({
    type: "screen_projects",
    // Full inventory — every dir under projects/, no filter, no view toggle.
    title: "โปรเจกต์ทั้งหมด",
    // No legend when projects exist (the client leaves the subtitle empty); only
    // the empty-list message is still shown.
    subtitle: projects.length
      ? ""
      : "ไม่พบโปรเจกต์เลยใต้ projects/ — สร้างใหม่ด้วยปุ่ม '+ new project'",
    items: ordered.map((p) => {
      // continue-button state derived purely (marker + tmux liveness) — the
      // zombie guard compares the live session's creation time to the recorded one.
      const marker = readRunMarker(p.path);
      // liveness scoped to THIS project by @orches_label (not bare session-name):
      // a cold-launch records the base pin as the session, so two projects can
      // share a session name — name-only match cross-lights both cards green.
      const aliveForThis = runSessionLiveForProject(marker, sessions, p.name);
      const live = marker?.session
        ? { alive: aliveForThis, createdAt: sessionCreatedAt(marker.session) }
        : { alive: false };
      const pending = pendingSprints(p);
      const btn = resolveButtonState(pending, marker, live);
      // a run is live iff its session is up, labeled for this project, and not a
      // zombie (reused name, created ≠ recorded).
      const runAlive =
        aliveForThis &&
        !(marker?.sessionCreatedAt !== undefined && live.createdAt !== undefined && live.createdAt !== marker.sessionCreatedAt);
      const driven = projectDrivenState(p, { sessions, runAlive }).state !== "none";
      return {
        path: p.path,
        name: p.name,
        sprints: p.sprintDocs,
        worktrees: p.openWorktrees,
        plannedTotal: p.plannedTotal,
        plannedDone: p.plannedDone,
        nextSprintId: p.nextSprintId,
        nextSprintTitle: p.nextSprintTitle,
        lastRun: p.lastRun,
        doing: p.doing,
        // green row: is a session driving this project right now? (shared list + reused runAlive)
        driven,
        starred: starred.has(p.path),
        run: { state: btn.state, errorMsg: btn.errorMsg },
        actions: resolveCardActions(btn.state, driven, pending),
        // `note` = how old the ahead/behind comparison is, shown on hover: the
        // list does not fetch on its own, so a green "up to date" chip can be
        // hours stale (see gitStaleNote).
        git: { path: p.path, ...states[p.path], note: gitStaleNote(states[p.path]?.staleMs) },
      };
    }),
  });
  // Keep polling while any run is live so the spinner + git panel stay fresh.
  if (ordered.some((p) => readRunMarker(p.path)?.status === "running")) startSpinPoll(panel);
  // The screen is already posted above — this only ever redraws it later. Not
  // on a spin tick (that fires every 2.5s), and not right after a manual fetch
  // (nothing would be stale anyway).
  if (fetch === false) scheduleAutoFetch(panel, states);
}

/** The deleted-projects list — every durable backup, read-only. Reuses the
 *  projects screen's client renderer via a distinct message type. */
function pushArchivedScreen(panel: vscode.WebviewPanel) {
  _screen = "archived";
  const backups: BackupEntry[] = listBackedUpProjects().sort((a, b) =>
    (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
  );
  if (_st) _st.backups = backups; // cache for pick_archived (typed below)
  panel.webview.postMessage({
    type: "screen_archived",
    title: "โปรเจกต์ที่ลบไปแล้ว",
    subtitle: backups.length
      ? "สำเนาสำรอง (README + docs) ตอนกดลบ — อ่านอย่างเดียว · กดปุ่มเดิมเพื่อกลับหน้าปกติ"
      : "ยังไม่มีโปรเจกต์ที่ถูกลบผ่านปุ่มลบในโปรแกรม",
    items: backups.map((b) => ({ name: b.name, path: b.backupDir, deletedAt: b.deletedAt })),
  });
}

// ── continue-run spin poll: re-render while any project's run is live ─────────
let _spinPoll: ReturnType<typeof setInterval> | undefined;
let _runningRuns = new Map<string, string>(); // path → session, for runs live on the previous tick
function startSpinPoll(panel: vscode.WebviewPanel) {
  if (_spinPoll) return;
  _spinPoll = setInterval(async () => {
    const projs = _st?.projects ?? [];
    // Capture each live run's session WHILE it is running — the done/error marker
    // is rewritten bare (drops .session), so this is the only chance to learn it.
    const nowRunning = new Map<string, string>();
    for (const p of projs) {
      const m = readRunMarker(p.path);
      // Only a marker whose session is ACTUALLY alive counts as running. A marker
      // stuck at "running" (session killed out-of-band, no done/error written)
      // would otherwise pin the poll forever — treat it as finished so the poll
      // stops and its (dead) session gets reaped once.
      if (m?.status === "running" && m.session && tmuxHasSession(m.session))
        nowRunning.set(p.path, m.session);
    }
    // A run live last tick but not this one JUST finished — `/orches-drive --once`
    // overwrote its marker with a bare done/error (or it vanished). The extension
    // gets no callback, so this transition is the only completion signal.
    const someFinished = [..._runningRuns.keys()].some((path) => !nowRunning.has(path));
    // Reap the finished headless run's tmux session — `--once` writes its marker
    // then exits WITHOUT the Step-6 teardown, so the session (dead orchestrator +
    // idle worker windows) lingers. This is what closes it when the run finishes.
    for (const s of finishedSessions(_runningRuns, new Set(nowRunning.keys()))) reapSession(s);
    // Re-scan so "ค้าง N sprint" drops, and render with fetch=true so the git panel
    // (Commit / up-to-date) reflects what landed — no manual "fetch" click needed.
    if (someFinished && _st) _st.projects = scanProjects();
    _runningRuns = nowRunning;
    // finished → full render (fresh scan + git fetch + green re-probe); otherwise a
    // cheap spin tick (spinner only, skip the owner/label probe).
    // Only re-render when the projects list is the visible screen — otherwise the tick
    // would clobber the Detail / teams / orch screen the user navigated to. Reaping +
    // rescan above still run; the render resumes when they return to the list.
    if (_panel && _screen === "projects") await pushProjectsScreen(_panel, someFinished ? true : "spin");
    if (nowRunning.size === 0) stopSpinPoll();
  }, 2500);
}
function stopSpinPoll() {
  if (_spinPoll) {
    clearInterval(_spinPoll);
    _spinPoll = undefined;
  }
  _runningRuns = new Map();
}

/** โปรเจคนี้กำลัง run จริงไหม (marker running + session live + ไม่ zombie) —
 *  reuse resolveButtonState ให้ตรงกับปุ่ม ▶ ทำต่อ ที่ user เห็น (delete guard ชั้น extension). */
function isRunning(p: ResumableProject): boolean {
  const marker = readRunMarker(p.path);
  // label-gated liveness (see render): a base-name session-collision must not make
  // this project read as running off another project's live session.
  const aliveForThis = runSessionLiveForProject(marker, listTmuxSessionsSafe(), p.name);
  const live = marker?.session
    ? { alive: aliveForThis, createdAt: sessionCreatedAt(marker.session) }
    : { alive: false };
  return resolveButtonState(pendingSprints(p), marker, live).state === "spinning";
}

/** โปรเจคนี้ busy ไหม (headless run กำลัง spin หรือ session ไหนก็ตามขับอยู่) — ตรงกับ
 *  `busy` ฝั่ง webview (run.state==='spinning' || it.driven). ใช้ guard ปุ่ม git
 *  (commit/push/pull/create&push) เหมือนที่ deleteProjectFlow guard ปุ่มลบ. */
function isProjectBusy(p: ResumableProject): boolean {
  if (isRunning(p)) return true;
  annotateLiveState([p]);
  return projectDrivenState(p).state !== "none";
}

/** ประโยคเตือน "งานที่จะหายถาวร" สำหรับ modal ยืนยันลบ — "" = ไม่มีอะไรเสี่ยง.
 *  ⛔ ยิง git 3 ครั้งเฉพาะตอน user เปิด modal (ไม่ใช่ตอน scan รายการ): ถ้าไปคิดตอน scan
 *  จะกลายเป็น 3 git ต่อโปรเจคต่อรอบ poll · async ล้วน — ห้าม execFileSync ใน extension host
 *  ⛔ GIT_OPTIONAL_LOCKS=0 เหมือน gitOps: `git status` ที่ถูกฆ่าตอน timeout ทิ้ง index.lock ค้าง
 *  แล้วบล็อก commit ของ repo นั้นตลอดไป (เคยเกิดจริงกับ 7 repo) */
async function probeUnsaved(projectPath: string): Promise<string> {
  const g = async (args: string[]): Promise<string | null> => {
    const r = await gitOps.run("git", ["-C", projectPath, ...args], {
      timeout: 8000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return r.ok ? r.stdout : null;
  };
  const wt = await g(["worktree", "list", "--porcelain"]);
  const log = await g(["log", "--branches", "--not", "--remotes", "--oneline"]);
  const st = await g(["status", "--porcelain"]);
  return unsavedWarning(
    summarizeUnsaved(projectPath, (args) =>
      args.includes("worktree") ? wt : args.includes("log") ? log : st,
    ),
  );
}

/** ลบโปรเจค: กัน running → confirm modal → พิมพ์ชื่อยืนยัน → ลบโฟลเดอร์ local.
 *  ⛔ ไม่แตะ GitHub. คืน {deleted:false} เงียบเมื่อ user ยกเลิก. */
function deleteProjectFlow(p: ResumableProject): { deleted: boolean; reason?: string } {
  // ยืนยัน + พิมพ์ชื่อ ทำใน webview modal แล้ว → host แค่ guard ซ้ำ (running + path) แล้วลบ.
  if (isRunning(p)) return { deleted: false, reason: `'${p.name}' กำลัง run อยู่ — กด stop ก่อนถึงจะลบได้` };
  // นอกจาก headless run: interactive session ที่ขับโปรเจคนี้อยู่ (การ์ดเขียว) ก็ห้ามลบ —
  // ลบโฟลเดอร์ทั้งที่ session ใช้อยู่ = พัง session นั้น. UI เทาปุ่มไว้แล้ว; นี่คือ guard ซ้ำ.
  annotateLiveState([p]);
  if (projectDrivenState(p).state !== "none")
    return { deleted: false, reason: `'${p.name}' กำลังถูกขับโดย session อยู่ — ปิด session ก่อนถึงจะลบได้` };
  const r = removeProjectDir(p.path);
  if (r.deleted) vscode.window.showInformationMessage(`ลบ '${p.name}' แล้ว`);
  return r;
}

/** guard ปุ่ม git ฝั่ง host: หา project จาก path แล้วเช็ค busy ซ้ำ (UI ซ่อนปุ่มไปแล้ว
 *  แต่ webview state อาจ stale) — คืน project ถ้าทำต่อได้, null ถ้าต้อง bail (แจ้ง warning แล้ว). */
/** One mutating git action per project at a time. The buttons are not disabled
 *  while the extension works, so two quick clicks used to start two `git`s in
 *  the same repo — they then collide on .git/index.lock and the second reports
 *  a scary "another git process seems to be running". */
const _gitBusy = new Set<string>();
async function withGitLock(path: string, fn: () => Promise<void>): Promise<void> {
  if (_gitBusy.has(path)) return;
  _gitBusy.add(path);
  try {
    await fn();
  } finally {
    _gitBusy.delete(path);
  }
}

/** Re-render after a git action. A FAILED push/pull almost always means the
 *  local view of origin is stale — and ahead/behind is computed from the last
 *  fetch, so a plain re-render leaves the SAME failing button on the row (a
 *  rejected push keeps saying "Push (1)" and fails again on every click, until
 *  the user happens to press ⟳ fetch). One fetch of just this repo, only on the
 *  failure path, is what lets the row become the "diverged" chip. */
async function settleAfterGit(
  panel: vscode.WebviewPanel,
  path: string,
  ok: boolean,
): Promise<void> {
  if (!ok) await gitOps.fetchRepo(path);
  await pushProjectsScreen(panel);
}

function requireIdleProject(path: string): ResumableProject | null {
  const p = _st?.projects.find((x) => x.path === path);
  if (!p) return null;
  if (isProjectBusy(p)) {
    vscode.window.showWarningMessage(`'${p.name}' กำลังทำอยู่ — รอให้เสร็จก่อนถึงจะ commit/push/pull ได้`);
    return null;
  }
  return p;
}

async function pushTeamsScreen(panel: vscode.WebviewPanel) {
  _screen = "teams";
  const teams = listOrchestratorTeams();
  const def = _st?.project ? defaultTeamFor(_st.project, teams) : null;
  // Last-used team floats to the top; the rest keep their existing order.
  const ordered = def
    ? [...teams.filter((t) => t.name === def), ...teams.filter((t) => t.name !== def)]
    : teams;
  // "เปิดใน GitHub" link — only when resuming a project that has a github origin.
  const githubUrl = _st?.project ? await gitOps.getGithubWebUrl(_st.project.path) : null;
  panel.webview.postMessage({
    type: "screen_teams",
    title: (_st?.project ? "ทำต่อ" : "เริ่มใหม่") + " — เลือกทีม",
    subtitle: _st?.project ? `project: ${_st.project.name}` : "เลือก oracle-team",
    canBack: true, // มาจากหน้า Projects เสมอ → กลับได้ตลอด
    githubUrl, // null → the client hides the GitHub button
    items: ordered.map((t) => ({
      name: t.name,
      isDefault: t.name === def, // most-recently-used on this project → the "ล่าสุด" card
      memberCount: t.members.length,
      orchestrator: t.orchestrators.join(", ") || "(none)",
    })),
  });
}

/** Project Detail screen — the hub for one project: a README dropdown + an icon-grid
 *  file-explorer of docs/ (wiki/ · a virtual sprint/ folder · plan.md; click a folder to
 *  drill in, click a file to open it as a full page over the grid) + nav (.. / close /
 *  localhost / ▶ ทำต่อ / GitHub). Reached by picking any project card; ▶ ทำต่อ carries
 *  the attach-or-team-picker logic. */
const IMG_EXT_RX = /\.(?:png|jpe?g|gif|webp)$/i;
// ภาพจาก gate จริงอยู่ราว 28-160KB · เพดานนี้กันไฟล์ที่คนวางไว้เองในโฟลเดอร์เดียวกัน
const IMG_MAX_BYTES = 8 * 1024 * 1024;

async function pushDetailScreen(panel: vscode.WebviewPanel) {
  const p = _st?.project;
  if (!p) return;
  _screen = "detail";
  const token = ++_nav;
  const archived = _st?.archived === true;
  const githubUrl = archived ? null : await gitOps.getGithubWebUrl(p.path);
  const docs = listDetailDocs(p.path);
  const deletedAt = archived
    ? (_st?.backups?.find((b) => b.backupDir === p.path)?.deletedAt ?? null)
    : null;
  // Mirror of the guard in pushProjectsScreen: the GitHub-remote lookup above is a
  // git call. A Back during it must not drag the user into Detail, and picking a
  // second project must not land on the first.
  if (!stillCurrent(panel, token)) return;
  panel.webview.postMessage({
    type: "screen_detail",
    // No folder emoji: it renders as a blank tofu box in this webview's font, and
    // the subtitle is the FULL PATH rather than the name again — the old
    // "project: <name>" line was the title a second time, and the one thing that
    // page could not tell you was where the project actually lives. Click = copy.
    title: p.name,
    subtitle: archived
      ? `${p.path} · ลบไปแล้วเมื่อ ${(deletedAt ?? "").slice(0, 10) || "?"}`
      : p.path,
    path: p.path,
    githubUrl,
    archived, // client hides git/preview/continue/delete when true
    preview: archived
      ? { available: false, running: false }
      : { available: isPreviewAvailable(p.path), running: isPreviewRunning(p.path) },
    tree: docs.tree,
    readme: docs.readme,
  });
}

function pushOrchScreen(panel: vscode.WebviewPanel, team: OracleTeam) {
  _screen = "orch";
  panel.webview.postMessage({
    type: "screen_orch",
    title: `${team.name} — เลือก orchestrator`,
    subtitle: "ทีมนี้มี orchestrator หลายตัว",
    items: team.orchestrators.map((o) => ({ name: o })),
  });
}

/** Team chosen → 1 orchestrator auto-launches; >1 asks; 0 guides. */
function pickTeam(panel: vscode.WebviewPanel, name: string) {
  if (!_st) return;
  const team = listOrchestratorTeams().find((t) => t.name === name);
  if (!team) return;
  _st.team = team;
  if (!team.orchestrators.length) {
    vscode.window.showWarningMessage(
      `Orchestrator: ทีม '${team.name}' ไม่มี member role:orchestrator — เพิ่มก่อนในหน้า Teams`,
    );
    return;
  }
  if (team.orchestrators.length === 1) {
    void doLaunch(panel, team.orchestrators[0]);
  } else {
    pushOrchScreen(panel, team);
  }
}

/** Open the Claude REPL for `sess` AUTOMATICALLY, in whichever view the user chose
 *  (Settings → หน้าตา Claude REPL; default = our chat), deferred a short beat so the
 *  just-created (detached) tmux session has a moment to come up before the chat's
 *  first poll. The launch itself runs HEADLESS (see launchOrchestrator), so this is
 *  the sole interface — no poll, no user click. */
function openViewDeferred(ctx: vscode.ExtensionContext, sess: string): void {
  openClaudeViewDeferred(ctx, sess, {}, 800);
}

async function doLaunch(panel: vscode.WebviewPanel, orch: string) {
  if (!_st?.team) return;
  const r = await launchOrchestrator({
    orch,
    team: _st.team,
    // project picked → resume it; none → fresh build
    mode: _st.project ? "resume" : "new",
    project: _st.project,
    projectName: _st.newName,
    cloned: _st.newClone,
  });
  if (r.cancelled) return; // user backed out of the twin/inject choice — keep the wizard
  if (r.error) {
    vscode.window.showErrorMessage(`Orchestrator: ${r.error}`);
    return;
  }
  // Auto-open the chosen Claude view (deferred a short beat so the detached session
  // comes up first). The launch is headless, so this is the only tab it gets.
  if (_ctx && r.session) openViewDeferred(_ctx, r.session);
  vscode.window.showInformationMessage(
    `Orchestrator: ปลุก '${orch}' (team ${_st.team.name})` +
      (_st.project ? ` · resume ${_st.project.name}` : "") +
      " — กำลังเปิด Claude…",
  );
  panel.dispose();
}

export function openOrchestratorPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  _ctx = context;
  _st = { projects: scanProjects() };
  if (_panel) {
    _panel.title = titleFor();
    _panel.reveal();
    void pushProjectsScreen(_panel); // always land on the Projects list
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.orchestrator",
    titleFor(),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  setTabIcon(panel);
  _panel = panel;
  panel.onDidDispose(() => {
    stopSpinPoll();
    _panel = undefined;
    _st = undefined;
  });
  // ซ่อน panel / สลับไป tab อื่น = ยกเลิก auto-commit+push ที่ arm ค้าง — กัน grace-timer ยิง
  // commit+push ตอน user ไม่ได้มองหน้า projects อยู่ (เสี่ยงยิงผิดจังหวะ/ผิด repo)
  panel.onDidChangeViewState(() => {
    if (!panel.visible) panel.webview.postMessage({ type: "disarm_all" });
  });
  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string" || !_st) return;
    switch (msg.type) {
      case "ready":
        await pushProjectsScreen(panel);
        return;
      case "start_new": {
        // "+ เริ่มโปรเจคใหม่" → เปิด name popup ก่อน (ตั้งชื่อ + เช็คว่าง local+github)
        // → ยืนยันแล้วค่อยไป team-picker (mode "new"). default ระบบคิดให้.
        _st.project = undefined;
        _st.team = undefined;
        _st.newName = undefined;
        _st.newClone = undefined;
        const def = suggestDefaultName(
          sortResumable(scanProjects()).map((p) => p.name),
          localProjectNames(),
          ghView,
        );
        panel.webview.postMessage({ type: "open_namemodal", default: def });
        return;
      }
      case "check_name": {
        const name = sanitizeName(typeof msg.name === "string" ? msg.name : "");
        const check: NameCheck = checkProjectName(name, localProjectNames(), ghView);
        // ช่อง URL ว่าง = สร้างโปรเจคเปล่าเหมือนเดิม (url: undefined) — ไม่ใช่ "ไม่ถูกต้อง"
        const rawUrl = typeof msg.url === "string" ? msg.url.trim() : "";
        const url = rawUrl ? parseRepoUrl(rawUrl) : undefined;
        // ชื่อที่จะเสนอจาก URL: ชื่อ repo ตรง ๆ ถ้าว่าง, ไม่ว่างก็ bump -vN ให้ — ไม่ใช่โยน
        // ชื่อแดง ๆ ใส่หน้า user แล้วให้ไปแก้เอง (เกิดจริงเมื่อ clone repo เดิมซ้ำรอบสอง)
        const urlSuggest =
          url?.valid && url.repo ? suggestFromBase(url.repo, localProjectNames(), ghView) : undefined;
        panel.webview.postMessage({ type: "name_result", name, check, url, urlSuggest });
        return;
      }
      case "name_confirmed": {
        const name = sanitizeName(typeof msg.name === "string" ? msg.name : "");
        if (!checkProjectName(name, localProjectNames(), ghView).valid) return;
        const rawUrl = typeof msg.url === "string" ? msg.url.trim() : "";
        _st.newName = name;
        _st.newClone = undefined;
        if (rawUrl) {
          // ⛔ clone ที่นี่ ไม่ใช่ปล่อยให้ oracle ทำ: error (URL ผิด/auth ไม่ผ่าน) ต้องเด้ง
          //    ให้ user เห็นทันที และห้ามเดินหน้าไป team-picker ถ้ายังไม่มีโค้ดจริงบนดิสก์
          const root = resolveOwnerRoot();
          if (!root) {
            vscode.window.showErrorMessage("Clone: หา owner-root ไม่เจอ (ลอง `maw oracle scan`)");
            return;
          }
          const dest = path.join(root, "projects", name);
          const out = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `clone ${rawUrl} …` },
            async () => cloneRepoInto(rawUrl, dest),
          );
          if (!out.ok) {
            vscode.window.showErrorMessage(`Clone ไม่สำเร็จ: ${out.error}`);
            // nameFromUser: ชื่อนี้ผ่านมือ user มาแล้ว → ห้ามให้ URL เติมทับตอนเปิดใหม่
            panel.webview.postMessage({
              type: "open_namemodal",
              default: name,
              url: rawUrl,
              nameFromUser: true,
            });
            return;
          }
          _st.newClone = { url: rawUrl, path: dest };
          vscode.window.showInformationMessage(
            `Clone แล้ว: ${name} (branch ${out.branch}) · ต้นทางเก็บเป็น upstream ที่ push ไม่ได้`,
          );
        }
        await pushTeamsScreen(panel);
        return;
      }
      case "pick_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        _st.project = p;
        // New: every card (incl. green/live) opens the Detail page first. The old
        // attach-or-team logic now lives behind the ▶ ทำต่อ button (continue_to_team).
        await pushDetailScreen(panel);
        return;
      }
      case "continue_to_team": {
        // The OLD pick_project behavior: 1 project = 1 session. Already being driven
        // (worker / run / owner at a checkpoint / labeled) → ATTACH to THAT session,
        // never spawn on top. Falls through to the team picker only when nothing live.
        const p = _st.project;
        if (!p) return;
        if (_st.archived) return; // read-only backup — no continue/preview/github
        annotateLiveState([p]);
        const driven = projectDrivenState(p);
        if (driven.state !== "none") {
          // ⛔ เดิมเรียก attachToProject (เปิด terminal) แล้วเปิด chat ตามอีกที =
          //    กดปุ่มเดียวได้สองหน้าต่างบน session เดียวกัน · ตอนนี้แค่ "หา session"
          //    แล้วเปิดหน้าเดียวตามที่ user ตั้งไว้
          const attached = resolveProjectSession(p, driven.session);
          if (attached) {
            // deferred auto-open (session already live).
            if (_ctx) openViewDeferred(_ctx, attached);
            vscode.window.showInformationMessage(
              `Orchestrator: attach เข้า session '${attached}' ที่ขับ '${p.name}' อยู่ (ไม่สร้างใหม่)`,
            );
            panel.dispose();
            return;
          }
          vscode.window.showWarningMessage(
            `'${p.name}' กำลังถูกขับ (session ${driven.session ?? "?"}) แต่ attach ไม่ได้ — เปิด session นั้นเอง`,
          );
          return; // do NOT fall through to spawn a twin
        }
        await pushTeamsScreen(panel);
        return;
      }
      case "copy_path": {
        // Subtitle click on the Detail screen. The path is taken from the HOST's
        // own state, never from the message — the webview only says "copy it", so
        // a stray/forged message cannot put arbitrary text on the clipboard.
        const p = _st.project;
        if (!p) return;
        void vscode.env.clipboard.writeText(p.path).then(() => {
          panel.webview.postMessage({ type: "path_copied" });
        });
        return;
      }
      case "open_doc": {
        // Detail explorer opened a file → read + render markdown, send HTML back.
        const p = _st.project;
        const rel = typeof msg.rel === "string" ? msg.rel : "";
        if (!p || !rel) return;
        const abs = resolveProjectFile(p.path, rel); // guards traversal + .md-only, project-rooted
        if (!abs) {
          panel.webview.postMessage({ type: "doc_html", rel, error: "ไม่พบไฟล์" });
          return;
        }
        // รูปจาก .orches-shots: ส่งเป็น data: URI ไม่ใช่ asWebviewUri
        // ⛔ ทำไมไม่ใช้ webview uri: มันต้องมี localResourceRoots ครอบ path ของ "โปรเจกต์"
        //    ซึ่งอยู่นอก workspace ได้ (MC เปิดที่ไหนก็จัดการโปรเจกต์ที่อื่นได้) ⇒ ต้องไปแก้ options
        //    ของ panel ทุกครั้งที่เลือกโปรเจกต์ใหม่ · data URI ทำงานเหมือนกันทุกที่ และ webview นี้
        //    ไม่มี CSP meta จึงโหลดได้ · ส่งทีละไฟล์ที่ถูกเลือกเท่านั้น (ภาพ gate จริง ~30-160KB)
        if (IMG_EXT_RX.test(abs)) {
          try {
            const st = fs.statSync(abs);
            if (st.size > IMG_MAX_BYTES) {
              panel.webview.postMessage({
                type: "doc_html",
                rel,
                error: `ไฟล์รูปใหญ่เกิน ${Math.round(IMG_MAX_BYTES / 1024 / 1024)}MB — เปิดใน editor แทน`,
              });
              return;
            }
            const b64 = fs.readFileSync(abs).toString("base64");
            const mime = abs.toLowerCase().endsWith(".png")
              ? "image/png"
              : /\.jpe?g$/i.test(abs)
                ? "image/jpeg"
                : abs.toLowerCase().endsWith(".gif")
                  ? "image/gif"
                  : "image/webp";
            panel.webview.postMessage({
              type: "doc_html",
              rel,
              imgSrc: `data:${mime};base64,${b64}`,
            });
          } catch {
            panel.webview.postMessage({ type: "doc_html", rel, error: "อ่านไฟล์รูปไม่ได้" });
          }
          return;
        }
        try {
          const html = renderMarkdown(fs.readFileSync(abs, "utf8"));
          // mermaid bundle ส่งเป็น webview uri "เฉพาะเอกสารที่มีบล็อกจริง" — ไฟล์ 3.4MB ไม่ควรถูกโหลด
          // ให้คนที่เปิดแต่เอกสารข้อความล้วน · ไฟล์อยู่ใน media/ (vendored) ไม่ใช่ node_modules:
          // ตัว dep เต็มคือ 85MB และ extension นี้ไม่ได้ bundle → มันจะไหลเข้า .vsix ทั้งก้อน
          const mermaidUri =
            hasMermaid(html) && _ctx
              ? panel.webview
                  .asWebviewUri(vscode.Uri.joinPath(_ctx.extensionUri, "media", "mermaid.min.js"))
                  .toString()
              : undefined;
          panel.webview.postMessage({ type: "doc_html", rel, html, mermaidUri });
        } catch {
          panel.webview.postMessage({ type: "doc_html", rel, error: "อ่านไฟล์ไม่ได้" });
        }
        return;
      }
      case "open_in_editor": {
        // Split-explorer "เปิดใน editor" → open the .md as a normal VS Code tab beside.
        const p = _st.project;
        const rel = typeof msg.rel === "string" ? msg.rel : "";
        if (!p || !rel) return;
        const abs = resolveProjectFile(p.path, rel); // guards traversal + .md / shots-image only
        if (!abs) return;
        // ⛔ showTextDocument กับ .png = เปิดไบต์ดิบเป็นข้อความ · `vscode.open` ใช้ image preview ของ VS Code
        if (IMG_EXT_RX.test(abs)) {
          void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs), {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
          });
          return;
        }
        void vscode.window.showTextDocument(vscode.Uri.file(abs), {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
        });
        return;
      }
      case "run_localhost": {
        // Toggle the project's dev server (background) + open the browser when it starts.
        const p = _st.project;
        if (!p) return;
        if (_st.archived) return; // read-only backup — no continue/preview/github
        if (!isPreviewAvailable(p.path)) {
          vscode.window.showWarningMessage(
            `'${p.name}' ไม่มี .orches-preview.sh — เปิด localhost ไม่ได้`,
          );
          panel.webview.postMessage({ type: "preview_state", running: false });
          return;
        }
        const { started } = togglePreview(p.path);
        if (started) {
          const url = await waitForPreviewUrl(p.path);
          void vscode.env.openExternal(vscode.Uri.parse(url));
          panel.webview.postMessage({ type: "preview_state", running: true, url });
          vscode.window.setStatusBarMessage(`Orchestrator: localhost '${p.name}' → ${url}`, 5000);
        } else {
          panel.webview.postMessage({ type: "preview_state", running: false });
          vscode.window.setStatusBarMessage(`Orchestrator: หยุด localhost '${p.name}'`, 5000);
        }
        return;
      }
      case "open_data_view": {
        // Detail → Data View scoped to THIS project (its sprints broken into tasks);
        // its back button reaches the cross-project view. No project picked → cross-project.
        void openDataViewPanel(_st.project?.path);
        return;
      }
      case "toggle_archived": {
        _st.archivedView = !_st.archivedView;
        _st.project = undefined;
        _st.archived = false;
        if (_st.archivedView) pushArchivedScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      }
      case "pick_archived": {
        const b = _st.backups?.find((x) => x.backupDir === msg.path);
        if (!b) return;
        // synthetic ResumableProject pointing at the backup folder
        _st.project = {
          name: b.name,
          path: b.backupDir,
          sprintDocs: 0,
          openWorktrees: 0,
        };
        _st.archived = true;
        await pushDetailScreen(panel);
        return;
      }
      case "to_projects": {
        _st.project = undefined;
        _st.team = undefined;
        _st.archived = false;
        if (_st.archivedView) pushArchivedScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      }
      case "close":
        panel.dispose();
        return;
      case "open_github": {
        // เปิด repo ของ project นี้ใน browser จริง. Re-resolve host-side (don't trust
        // the client URL) so we only ever open this project's github origin.
        if (!_st.project) return;
        if (_st.archived) return; // read-only backup — no continue/preview/github
        const url = await gitOps.getGithubWebUrl(_st.project.path);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        else vscode.window.showWarningMessage(`'${_st.project.name}' ไม่มี GitHub remote (origin)`);
        return;
      }
      case "toggle_star": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !_ctx) return;
        // await update: durable; Memento.get reflects it synchronously so the
        // re-partition below is already correct — no ordering bug elsewhere.
        await setStarred(toggleStar(starredList(), p));
        await pushProjectsScreen(panel);
        return;
      }
      case "pick_team":
        if (typeof msg.name === "string") pickTeam(panel, msg.name);
        return;
      case "pick_orch":
        if (typeof msg.name === "string") void doLaunch(panel, msg.name);
        return;
      case "back":
        // From the team picker: back to Detail when resuming a project (project set),
        // else back to the Projects list (a fresh build has no Detail page).
        _st.team = undefined;
        if (_st.project) await pushDetailScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      case "git_refresh":
        // Full manual refresh: re-scan sprint state too (so "ค้าง N sprint"
        // reflects reality), not just git — the one-time open snapshot is stale.
        if (_st) _st.projects = scanProjects();
        await pushProjectsScreen(panel, true);
        return;
      case "continue_run": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const r = launchContinueRun(p);
        if (r.error) vscode.window.showWarningMessage(`Continue: ${r.error}`);
        else if (r.attached) {
          if (_ctx && r.session) openViewDeferred(_ctx, r.session);
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' กำลังทำอยู่แล้ว — เปิด session เดิมให้ (ไม่ launch ซ้ำ)`,
          );
        }
        await pushProjectsScreen(panel);
        startSpinPoll(panel);
        return;
      }
      case "continue_multi": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        // Count comes from the in-webview modal; clamp defensively (never trust the
        // client value) against what's actually left.
        const remaining = pendingSprints(p);
        const n = clampSprintCount(String(msg.count ?? ""), remaining);
        if (remaining < 2 || n === null) {
          await pushProjectsScreen(panel);
          return;
        }
        const r = launchContinueRun(p, n);
        if (r.error) vscode.window.showWarningMessage(`Continue: ${r.error}`);
        else if (r.attached) {
          if (_ctx && r.session) openViewDeferred(_ctx, r.session);
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' กำลังทำอยู่แล้ว — เปิด session เดิมให้ (ไม่ launch ซ้ำ)`,
          );
        }
        else
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' เริ่มทำ ${n} sprint รวด (background)`,
          );
        await pushProjectsScreen(panel);
        startSpinPoll(panel);
        return;
      }
      case "cancel_run": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        await cancelContinueRun(p);
        await pushProjectsScreen(panel);
        return;
      }
      // ⛔ path มาจาก webview → ต้อง lookup ใน _st.projects เหมือน delete_project ห้ามยิง git ตาม path ดิบ
      case "del_probe": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const text = await probeUnsaved(p.path);
        if (text) await panel.webview.postMessage({ type: "del_unsaved", path: p.path, text });
        return;
      }
      case "delete_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const r = deleteProjectFlow(p);
        if (r.deleted) {
          _st.projects = scanProjects(); // re-scan → การ์ดหลุดจาก list
          await pushProjectsScreen(panel);
        } else if (r.reason) {
          vscode.window.showWarningMessage(r.reason);
        }
        return;
      }
      case "git_auto": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        // gen = client's per-project request generation. Echoed back verbatim so
        // the client can DROP results of cancelled/superseded runs (without it, a
        // cancelled run's stale message could get auto-committed by the next run).
        const gen = typeof msg.gen === "number" ? msg.gen : 0;
        panel.webview.postMessage({
          type: "git_auto_result",
          path: p,
          gen,
          message: await gitOps.autoCommitMessage(p),
        });
        return;
      }
      case "git_commit": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message || !requireIdleProject(p)) return;
        await withGitLock(p, async () => {
          const r = await gitOps.commitAll(p, message);
          notify(r.ok, `commit ${short(p)}`, r);
          await settleAfterGit(panel, p, r.ok);
        });
        return;
      }
      case "git_push": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !requireIdleProject(p)) return;
        await withGitLock(p, async () => {
          const st = await gitOps.readGitStatus(p);
          const r = await gitOps.pushRepo(p, st.hasUpstream);
          notify(r.ok, `push ${short(p)}`, r);
          await settleAfterGit(panel, p, r.ok);
        });
        return;
      }
      case "git_commit_push": {
        // Armed auto-commit+push (the glowing Commit+Push buttons). One case so
        // the push STRICTLY follows a successful commit — two separate posted
        // messages would race (both handlers start independently).
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message || !requireIdleProject(p)) return;
        await withGitLock(p, async () => {
          const c = await gitOps.commitAll(p, message);
          notify(c.ok, `commit ${short(p)}`, c);
          let ok = c.ok;
          if (c.ok) {
            const st = await gitOps.readGitStatus(p);
            const r = await gitOps.pushRepo(p, st.hasUpstream);
            notify(r.ok, `push ${short(p)}`, r);
            ok = r.ok;
          }
          await settleAfterGit(panel, p, ok);
        });
        return;
      }
      case "git_pull": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !requireIdleProject(p)) return;
        await withGitLock(p, async () => {
          const r = await gitOps.pullRepo(p);
          notify(r.ok, `pull ${short(p)}`, r);
          await settleAfterGit(panel, p, r.ok);
        });
        return;
      }
      case "git_createpush": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const repoName = typeof msg.repoName === "string" ? msg.repoName.trim() : "";
        const isPrivate = msg.isPrivate !== false;
        if (!p || !repoName || !requireIdleProject(p)) return;
        const pick = await vscode.window.showWarningMessage(
          `สร้าง GitHub repo ${isPrivate ? "(private)" : "(public)"} '${repoName}' จาก ${short(
            p,
          )} แล้ว push?`,
          { modal: true },
          "Create & Push",
        );
        if (pick !== "Create & Push") return;
        await withGitLock(p, async () => {
          const r = await gitOps.createAndPush(p, repoName, isPrivate);
          notify(r.ok, `create+push '${repoName}'`, r);
          await pushProjectsScreen(panel);
        });
        return;
      }
    }
  });
  return panel;
}

function titleFor(): string {
  return "Projects";
}
function short(p: string): string {
  return p.split("/").pop() || p;
}
function notify(ok: boolean, what: string, r: gitOps.RunResult): void {
  if (ok) {
    // สำเร็จ = แจ้งชั่วคราวใน status bar หายเองใน 5 วิ — ไม่ค้างเป็น toast ให้กดปิดเอง
    // (showInformationMessage ไม่การันตี auto-hide → ค้างเต็มจอตอน commit/push บ่อยๆ)
    vscode.window.setStatusBarMessage(`Orchestrator: ${what} สำเร็จ`, 5000);
    return;
  }
  // ล้มเหลว = toast ค้างไว้ให้เห็นชัด (ต้องรู้ว่า commit/push พัง)
  //   ⛔ เดิมหยิบ stderr บรรทัดแรก ซึ่งแทบไม่เคยเป็นสาเหตุจริง: git พิมพ์ hint:/`To <url>`
  //      ขึ้นก่อนเสมอ → ff-pull ที่ diverged ขึ้นเป็น "hint: Diverging branches…"
  //      และ push ที่ถูก reject ขึ้นเป็น URL เปล่าๆ · gitErrorLine เลือกบรรทัดจริง
  const why = gitOps.gitErrorLine(r);
  vscode.window.showErrorMessage(
    `Orchestrator: ${what} ล้มเหลว${why ? ` — ${why}` : " (git ไม่ได้บอกสาเหตุ)"}`,
  );
}

function renderShell(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); display: flex; flex-direction: column; overflow: hidden; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
  /* The title block may shrink; the buttons may not. Without this pair, a long
     absolute path (monospace, no break opportunities) won the space fight and
     squeezed the action row until "ทำต่อ" wrapped onto two lines. */
  .topbar > div:first-child { min-width: 0; }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topbar .sub { font-size: 11px; opacity: 0.6; margin-top: 3px; font-weight: 400; }
  /* Detail screen: the sub-line is the project's absolute path — click copies it.
     Monospace because it is a path, and inline-block so the hover target is the
     text itself, not the full-width row. ONE line, ellipsised: the full path is a
     click away (and the folder it ends in is already the title above it). */
  .topbar .sub.copyable { font-family: 'JetBrains Mono', var(--vscode-editor-font-family), ui-monospace, monospace;
    cursor: pointer; display: inline-block; max-width: 100%; vertical-align: bottom;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px dashed transparent; }
  .topbar .sub.copyable:hover { opacity: 0.95; border-bottom-color: currentColor; }
  .topbar .sub.copied { opacity: 1; color: #3fb950; }
  .topbar .actions { display: flex; gap: 6px; flex: none; }
  .topbar .actions button { white-space: nowrap; }
  button { background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 4px 10px; border-radius: 3px;
    font-size: 11px; cursor: pointer; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  .content { flex: 1; overflow-y: auto; padding: 14px 18px 28px; box-sizing: border-box; }
  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }
  .card { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 8px;
    border-radius: 8px; background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .card .pick { flex: 1; display: flex; flex-direction: column; cursor: pointer; background: none;
    border: none; text-align: left; color: inherit; padding: 0; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  /* project has a live session driving it right now → green (same palette as .chip.doing/.cont) */
  .card.live { border-color: #2ea043; background: rgba(63,185,80,0.10); }
  .card.live:hover { background: rgba(63,185,80,0.16); }
  .card.crash { border-color: #f85149; box-shadow: 0 0 0 1px rgba(248,81,73,0.35); }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .csub { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  /* team-picker cards are the main action here → bigger + button-like */
  .teamcard { padding: 16px 18px; }
  .teamcard .cname { font-size: 15px; }
  .teamcard .csub { font-size: 12px; margin-top: 4px; }
  .card.default { border-color: #3fb950; background: rgba(63,185,80,0.12); }
  .card.default:hover { background: rgba(63,185,80,0.18); }
  .card.default .cname { color: #56d364; }

  /* ── Team Select grid (TEAM_SELECT.md) — scoped Bento tokens like .proj-track,
       so it doesn't disturb the other .card screens that use vscode vars ── */
  .tsgrid { max-width: 640px; margin: 0 auto; display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;
    --accent:#2f9dc4; --accentSoft:rgba(47,157,196,.15);
    --tcard:#161f28; --tborder:rgba(255,255,255,.08); --ttxt:#e7eef5; --tmuted:#8a97a4; --tfaint:#5c6773;
    --tmono:'JetBrains Mono', var(--vscode-editor-font-family), ui-monospace, monospace; }
  body.vscode-light .tsgrid, body.vscode-high-contrast-light .tsgrid {
    --accent:#0e88ad; --accentSoft:rgba(14,136,173,.10);
    --tcard:#ffffff; --tborder:rgba(15,30,45,.12); --ttxt:#132029; --tmuted:#5a6b78; --tfaint:#94a1ad; }
  .tscard { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center;
    gap: 10px; padding: 22px 16px 18px; border-radius: 14px; cursor: pointer;
    background: var(--tcard); border: 1px solid var(--tborder); color: var(--ttxt); }
  .tscard:hover { border-color: var(--accent); }
  .tscard.last { background: var(--accentSoft); border-color: var(--accent); }
  .tscard.solo { grid-column: 1 / -1; width: calc(50% - 6px); margin: 0 auto; }
  .tsbadge { position: absolute; top: 12px; right: 12px; display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--tmono); font-size: 9px; font-weight: 700; letter-spacing: .6px; color: #3fd39a;
    background: rgba(63,211,154,.14); border: 1px solid rgba(63,211,154,.35); padding: 2px 7px; border-radius: 999px; }
  .tsdot { width: 5px; height: 5px; border-radius: 50%; background: #3fd39a; box-shadow: 0 0 5px #3fd39a; }
  .tsav { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-family: var(--tmono); font-size: 18px; font-weight: 700; color: #fff; }
  .tsname { font-size: 15px; font-weight: 700; }
  .tsmeta { display: flex; flex-direction: column; gap: 4px; }
  .tsmeta .tsm1 { font-size: 11.5px; color: var(--tmuted); }
  .tsmeta .tsm2 { font-family: var(--tmono); font-size: 10.5px; color: var(--tfaint); }
  .del { display:none; background:none; border:1px solid #f85149; cursor:pointer; font-size:11px;
         font-weight:600; padding:3px 12px; border-radius:6px; color:#f85149; margin:0 6px; white-space:nowrap; }
  #content.edit .del { display:inline-flex; align-items:center; }
  .del:hover { background:rgba(248,81,73,0.15); }
  .del.disabled { color:#6e7681; border-color:#6e7681; cursor:not-allowed; }
  .del.disabled:hover { background:none; }
  #editBtn.on { background:rgba(248,81,73,0.15); color:#f85149; border-color:#f85149; }
  #archBtn.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .archbadge { font-size: 11px; color: #e3a13a; align-self: center; margin-left: 4px; }
  /* The one button that destroys something keeps red — but as the same tinted
     shape the rest of the panel uses, not a solid block. */
  .modal-card .mbtn.danger { border-color: rgba(248,81,73,.6); color: #ff7b72; background: rgba(248,81,73,.14); }
  .modal-card .mbtn.danger:hover { border-color: #f85149; color: #fff; background: #da3633; }
  /* Round 2 only — the press that actually deletes is the solid one. */
  .modal-card .mbtn.danger.hot { border-color: #f85149; color: #fff; background: #da3633; }
  .modal-card .mbtn.danger.hot:hover { background: #f85149; }
  .modal-card .mbtn.danger:disabled, .modal-card .mbtn.danger.hot:disabled {
    background: transparent; border-color: var(--pborder); color: var(--pfaint); cursor: not-allowed; }
  .modal-card .merr.ok { color:#3fb950; }
  .modal-card .merr.bad { color:#f85149; }
  .modal-card .merr.warn { color:#e3a13a; }
  .badge-last { font-size: 10px; font-weight: 700; color: #0d1117; background: #3fb950;
    padding: 1px 8px; border-radius: 8px; margin-left: 8px; vertical-align: middle; }
  .star { flex: 0 0 auto; font-size: 19px; line-height: 1; cursor: pointer; user-select: none;
    opacity: 0.4; padding: 5px 7px; margin: -3px -1px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center; }
  .star:hover { opacity: 0.8; background: var(--vscode-list-hoverBackground); }
  .star.on { color: #e3b341; opacity: 1; }
  .chip { font-size: 10px; padding: 1px 7px; border-radius: 8px; margin-left: 8px;
    vertical-align: middle; font-weight: 600; }
  .chip.act { background: rgba(196,127,26,0.22); color: #e3a13a; }
  .chip.idle { background: rgba(125,133,144,0.18); color: #9aa4af; }
  .chip.crash { background: rgba(248,81,73,0.2); color: #f85149; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; display: inline-block; }
  /* "doing" = a worker is grinding right now → green + a live text spinner */
  .chip.doing { background: rgba(63,185,80,0.18); color: #56d364;
    display: inline-flex; align-items: center; gap: 4px; }
  .chip.doing .spin { font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 700; width: 1ch; display: inline-block; text-align: center; }
  /* inline "▶ ทำต่อ" continue button — green idle, amber stale, spinning ⟳ */
  .cont { flex: 0 0 auto; align-self: center; margin: 0 6px; font-size: 11px; font-weight: 600;
    border: 1px solid #2ea043; color: #3fb950; background: rgba(63,185,80,0.12);
    border-radius: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px; }
  .cont:hover { background: rgba(63,185,80,0.22); }
  .cont.spin { border-color: #c47f1a; color: #e3a13a; background: rgba(196,127,26,0.14); }
  /* driven by a live INTERACTIVE session → spinning "กำลังทำ"; click OPENS that
     session (no headless run to cancel), so green (not amber like .spin). */
  .cont.busy { border-color: #2ea043; color: #56d364; background: rgba(63,185,80,0.14); cursor: pointer; }
  .cont.busy:hover { background: rgba(63,185,80,0.24); }
  .cont.multi { border-color: #3f7bd0; color: #6ca6ff; background: rgba(63,123,208,0.12); }
  .cont.multi:hover { background: rgba(63,123,208,0.22); }
  .cont.multi.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
  .cont-rot { display: inline-block; animation: contspin 1.1s linear infinite; }
  @keyframes contspin { to { transform: rotate(360deg); } }
  /* ── Commit form (inside a project card) ──────────────────────────────────
     Dressed in the card's own Bento tokens instead of raw GitHub colours: the
     box used to be a 4px-radius vscode input and the row was a green fill, a
     blue fill and a bare default button — three unrelated shapes sitting inside
     an 11px-radius card. Everything here is one family now: 9px corners, the
     card's border, and the panel accent for anything that acts. */
  .git-editor { margin-top: 8px; }
  .git-editor textarea, .git-editor input {
    background: var(--gfield, rgba(255,255,255,.04)); color: var(--ptxt, var(--vscode-input-foreground));
    border: 1px solid var(--pborder, var(--vscode-panel-border)); border-radius: 9px;
    padding: 8px 10px; font-size: 11.5px; line-height: 1.5; box-sizing: border-box;
    font-family: var(--pmono, var(--vscode-editor-font-family), ui-monospace, monospace);
    cursor: auto; outline: none; transition: border-color .15s, box-shadow .15s; }
  .git-editor textarea { resize: vertical; min-height: 46px; }
  .git-editor textarea::placeholder, .git-editor input::placeholder { color: var(--pfaint, #5c6773); }
  .git-editor textarea:focus, .git-editor input:focus {
    border-color: var(--accent, #2f9dc4); box-shadow: 0 0 0 3px var(--accentSoft, rgba(47,157,196,.15)); }
  body.vscode-light .git-editor textarea, body.vscode-light .git-editor input,
  body.vscode-high-contrast-light .git-editor textarea, body.vscode-high-contrast-light .git-editor input {
    --gfield: rgba(15,30,45,.03); }

  .barrow { display: flex; align-items: center; gap: 7px; margin-top: 7px; }
  /* One button shape for the whole row; only the emphasis differs. */
  .barrow button { height: 28px; padding: 0 12px; border-radius: 8px; font-size: 11.5px; font-weight: 600;
    line-height: 1; white-space: nowrap; cursor: pointer;
    background: transparent; color: var(--pmuted, var(--vscode-foreground));
    border: 1px solid var(--pborder, var(--vscode-panel-border)); transition: .15s; }
  .barrow button:hover { color: var(--ptxt, var(--vscode-foreground)); border-color: var(--accent, #2f9dc4);
    background: var(--accentSoft, rgba(47,157,196,.15)); }
  /* The yellow ring was the browser default — this one belongs to the panel. */
  .barrow button:focus-visible { outline: 2px solid var(--accent2, #40c8ea); outline-offset: 2px; }
  .git-editor .gpriv { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
    color: var(--pmuted, var(--vscode-foreground)); }
  /* ⛔ These three stay scoped under .barrow: an unscoped .git-pushx loses to the
     .barrow button rule on specificity and silently renders as a plain grey
     button — measured, not guessed. */
  /* Commit / Create & Push = the action each form exists for. */
  .barrow .git-go, .barrow .git-go2 { color: #fff; border-color: transparent;
    background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4));
    box-shadow: 0 2px 8px var(--accentGlow, rgba(64,200,234,.28)); }
  .barrow .git-go:hover, .barrow .git-go2:hover { filter: brightness(1.06);
    background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4)); border-color: transparent; }
  /* "Push ด้วย" = the same commit plus a push — outlined accent, one step below. */
  .barrow .git-pushx { color: var(--accent2, #40c8ea); border-color: var(--accent, #2f9dc4); }
  .barrow .git-pushx:hover { color: var(--accent2, #40c8ea); }
  .barrow .git-x { color: var(--pfaint, #5c6773); border-color: transparent; }
  .barrow .git-x:hover { color: var(--ptxt, var(--vscode-foreground)); background: transparent;
    border-color: var(--pborder, var(--vscode-panel-border)); }

  /* Git action chip on the card row (Commit ▾ / Push / Pull / Create & Push):
     tinted, not a solid block of colour — it sits beside muted metadata text. */
  .git-act { height: 26px; padding: 0 11px; border-radius: 8px; font-size: 11px; font-weight: 600;
    line-height: 1; white-space: nowrap; cursor: pointer;
    background: var(--gtint); color: var(--gink); border: 1px solid var(--gline); }
  .git-act:hover { filter: brightness(1.15); }
  .git-act.k-commit { --gtint: rgba(196,127,26,.16); --gink: #e0a33d; --gline: rgba(196,127,26,.55); }
  .git-act.k-push { --gtint: rgba(31,111,235,.16); --gink: #6ca6ff; --gline: rgba(31,111,235,.55); }
  .git-act.k-pull { --gtint: rgba(27,154,170,.16); --gink: #45c3d1; --gline: rgba(27,154,170,.55); }
  .git-act.k-create-push { --gtint: rgba(35,134,54,.16); --gink: #56c46a; --gline: rgba(35,134,54,.55); }
  body.vscode-light .git-act.k-commit { --gink: #9a6410; } body.vscode-light .git-act.k-push { --gink: #1f6feb; }
  body.vscode-light .git-act.k-pull { --gink: #147c88; } body.vscode-light .git-act.k-create-push { --gink: #1a7f37; }
  /* แสงวิ่งรอบปุ่ม = arm แล้ว (auto คิดเสร็จจะยิงเองหลัง grace 3 วิ) — a light dot
     orbiting the button border via an animated conic ring on ::after */
  @property --gl { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
  .glow { position: relative; }
  .glow::after { content: ''; position: absolute; inset: -2px; border-radius: 8px; padding: 1.5px;
    opacity: 0.66;
    background: conic-gradient(from var(--gl), transparent 0deg 284deg, #ecc94b 310deg,
      #f7e59a 332deg, #ecc94b 350deg, transparent 360deg);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    animation: glspin 1.2s linear infinite; pointer-events: none; }
  @keyframes glspin { to { --gl: 360deg; } }
  /* "ทำหลาย sprint" — centered floating modal (host showInputBox can't center). */
  /* ── Modals (ลบโปรเจค / ทำ N sprint / ตั้งชื่อโปรเจค) ─────────────────────
     They sit at the top of <body>, OUTSIDE .proj-track, so the Bento tokens are
     not inherited — the card declares them itself. Same shapes as the cards
     behind it: 14px corners on the card, 9px on fields and buttons, the panel
     accent for the action, red kept for the one button that destroys something. */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(6,11,16,.66);
    backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 100;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --pcard:#161f28; --pborder:rgba(255,255,255,.10); --ptxt:#e7eef5; --pmuted:#8a97a4; --pfaint:#5c6773;
    --pfield:rgba(255,255,255,.04);
    --pmono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  body.vscode-light .modal-backdrop, body.vscode-high-contrast-light .modal-backdrop {
    background: rgba(15,30,45,.34);
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --pcard:#ffffff; --pborder:rgba(15,30,45,.12); --ptxt:#132029; --pmuted:#5a6b78; --pfaint:#94a1ad;
    --pfield:rgba(15,30,45,.03); }
  .modal-card { background: var(--pcard); color: var(--ptxt);
    border: 1px solid var(--pborder); border-radius: 14px;
    padding: 20px 22px; width: 380px; max-width: 86vw;
    box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  .modal-card .mt { font-size: 15px; font-weight: 700; margin-bottom: 7px; letter-spacing: .2px; }
  .modal-card .mh { font-size: 11.5px; color: var(--pmuted); margin-bottom: 13px; line-height: 1.6; }
  .modal-card input { width: 100%; box-sizing: border-box; font-size: 12.5px; padding: 10px 12px;
    font-family: var(--pmono); background: var(--pfield); color: var(--ptxt);
    border: 1px solid var(--pborder); border-radius: 9px; outline: none;
    transition: border-color .15s, box-shadow .15s; }
  .modal-card input::placeholder { color: var(--pfaint); }
  .modal-card input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accentSoft); }
  .modal-card .merr { font-size: 11px; color: #f85149; min-height: 14px; margin-top: 7px; }
  .modal-card .mact { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .modal-card .mbtn { height: 30px; padding: 0 14px; border-radius: 9px; font-size: 12px; font-weight: 600;
    line-height: 1; white-space: nowrap; cursor: pointer; transition: .15s;
    border: 1px solid var(--pborder); background: transparent; color: var(--pmuted); }
  .modal-card .mbtn:hover { color: var(--ptxt); border-color: var(--accent); background: var(--accentSoft); }
  .modal-card .mbtn:focus-visible { outline: 2px solid var(--accent2); outline-offset: 2px; }
  .modal-card .mbtn.primary { border-color: transparent; color: #fff;
    background: linear-gradient(180deg, var(--accent2), var(--accent)); box-shadow: 0 2px 8px var(--accentGlow); }
  .modal-card .mbtn.primary:hover { filter: brightness(1.06); border-color: transparent;
    background: linear-gradient(180deg, var(--accent2), var(--accent)); }
  /* ── Project Detail: markdown file-explorer (icon grid, OS file-manager style) ── */
  .fx { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 4px; padding: 10px 2px 4px; }
  .fx-tile { display: flex; flex-direction: column; align-items: center; gap: 9px;
    padding: 14px 6px 12px; border-radius: 8px; cursor: pointer; user-select: none; text-align: center; }
  .fx-tile:hover { background: var(--vscode-list-hoverBackground); }
  .fx-ic { height: 48px; display: flex; align-items: center; justify-content: center; }
  .fx-svg { display: block; }
  .fx-svg-folder { width: 52px; height: 52px; }
  .fx-svg-md { width: 46px; height: 46px; opacity: 0.85; }
  .fx-svg-up { width: 15px; height: 15px; }
  .fx-label { font-size: 12px; line-height: 1.3; word-break: break-word; max-width: 100%; }
  .fx-dir .fx-label { font-weight: 600; }
  /* back button = icon + ".." */
  .iconbtn { display: inline-flex; align-items: center; gap: 5px; }
  .iconbtn svg { display: block; }
  /* README inline dropdown */
  .rm { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; margin-bottom: 4px; }
  .rm-head { width: 100%; text-align: left; background: var(--vscode-editor-inactiveSelectionBackground);
    border: none; color: inherit; padding: 8px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
    display: flex; gap: 6px; align-items: center; }
  .rm-head:hover { background: var(--vscode-list-hoverBackground); }
  .rm-caret { width: 1ch; display: inline-block; opacity: 0.7; }
  .rm-body { padding: 4px 16px 12px; border-top: 1px solid var(--vscode-panel-border); }
  /* ── Project Detail: a single doc opened as a full page ── */
  .doc-page { padding: 4px 2px 24px; }
  .doc-body { font-size: 13px; line-height: 1.55; }
  /* ภาพจาก .orches-shots: กว้างเต็มพื้นที่แต่ไม่ล้น · พื้นตารางหมากรุกอ่อน ๆ ให้เห็นขอบภาพที่โปร่งใส */
  .shot { padding: 4px 0; }
  .shot img { max-width: 100%; height: auto; display: block; border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; background: rgba(127,127,127,0.08); }
  .doc-empty { opacity: 0.55; font-size: 12px; padding: 8px 2px; }
  .doc-body h1, .doc-body h2, .doc-body h3 { margin: 12px 0 6px; line-height: 1.3; }
  .doc-body h1 { font-size: 18px; } .doc-body h2 { font-size: 16px; } .doc-body h3 { font-size: 14px; }
  .doc-body p { margin: 6px 0; }
  .doc-body ul, .doc-body ol { margin: 6px 0; padding-left: 22px; }
  .doc-body code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
    padding: 1px 5px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .doc-body pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  .doc-body pre code { background: none; padding: 0; }
  .doc-body blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--vscode-panel-border); opacity: 0.85; }
  .doc-body table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
  .doc-body th, .doc-body td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .doc-body a { color: var(--vscode-textLink-foreground); }
  .doc-body hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  button.disabled, button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.disabled:hover, button:disabled:hover { background: transparent; }

  /* ── Projects tab — Bento "Hero + Sprint Track" (scoped to .proj-track so the
       teams/orch/detail screens that share .card keep their vscode-var styling) ── */
  .proj-track { max-width: 980px; margin: 0 auto;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --pcard:#161f28; --pborder:rgba(255,255,255,.08); --ptxt:#e7eef5; --pmuted:#8a97a4; --pfaint:#5c6773; --good:#3fd39a;
    --pmono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  body.vscode-light .proj-track, body.vscode-high-contrast-light .proj-track {
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --pcard:#ffffff; --pborder:rgba(15,30,45,.12); --ptxt:#132029; --pmuted:#5a6b78; --pfaint:#94a1ad; --good:#2fa96a; }

  /* Page header (§1) — Bento styling scoped to the projects topbar via :has(),
     so the teams/orch/detail topbars that share .topbar/#title keep their look.
     #newProjBtn/#reloadBtn/#editBtn/#archBtn only ever render on this screen. */
  .topbar:has(#archBtn) { --accent:#2f9dc4; --accent2:#40c8ea; --accentGlow:rgba(64,200,234,.28); align-items: flex-start; }
  body.vscode-light .topbar:has(#archBtn), body.vscode-high-contrast-light .topbar:has(#archBtn) {
    --accent:#0e88ad; --accent2:#0e7fa3; --accentGlow:rgba(14,136,173,.18); }
  .topbar:has(#archBtn) h1 { font-size: 19px; font-weight: 700; }
  .topbar:has(#archBtn) .sub { opacity: 1; margin-top: 7px; }
  .hdr-legend { font-size: 12px; line-height: 1.6; color: var(--vscode-descriptionForeground, #8a97a4); }
  .hdr-legend .d { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
  .hdr-legend .d.run { background: #3fd39a; box-shadow: 0 0 5px #3fd39a; }
  .hdr-legend .d.wait { background: #e8a33d; }
  .hdr-legend .sep { margin: 0 8px; opacity: .5; }
  #newProjBtn { border: none; color: #fff; font-weight: 600; padding: 6px 14px; border-radius: 8px;
    background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4)); box-shadow: 0 2px 8px var(--accentGlow, rgba(64,200,234,.28)); }
  #newProjBtn:hover { filter: brightness(1.06); background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4)); }
  #reloadBtn, #editBtn { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 12px; }
  #reloadBtn:hover, #editBtn:hover { border-color: var(--accent, #2f9dc4); }
  #archBtn { border: 1px solid transparent; opacity: .55; border-radius: 8px; padding: 6px 12px; }
  #archBtn:hover { opacity: 1; border-color: var(--vscode-panel-border); background: transparent; }

  /* ── Project Detail — Split Explorer (header scoped via :has(#dvBtn); body = .psplit) ── */
  .topbar:has(#dvBtn) { --accent:#2f9dc4; --accent2:#40c8ea; --accentGlow:rgba(64,200,234,.28); align-items: flex-start; }
  body.vscode-light .topbar:has(#dvBtn), body.vscode-high-contrast-light .topbar:has(#dvBtn) {
    --accent:#0e88ad; --accent2:#0e7fa3; --accentGlow:rgba(14,136,173,.18); }
  .topbar:has(#dvBtn) h1 { font-size: 17px; font-weight: 600; font-family: 'JetBrains Mono', var(--vscode-editor-font-family), monospace; }
  .dt-cont { border: none; color: #fff; font-weight: 700; padding: 6px 14px; border-radius: 8px;
    background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4)); box-shadow: 0 2px 8px var(--accentGlow, rgba(64,200,234,.28)); }
  .dt-cont:hover { filter: brightness(1.06); background: linear-gradient(180deg, var(--accent2, #40c8ea), var(--accent, #2f9dc4)); }
  .dt-back { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 12px; }
  .dt-back:hover { border-color: var(--accent, #2f9dc4); }
  .dt-back .bk { width: 12px; height: 12px; }
  #dvBtn, #ghBtn, #lhBtn { border-radius: 8px; padding: 6px 12px; }
  #dvBtn:hover, #ghBtn:hover, #lhBtn:hover { border-color: var(--accent, #2f9dc4); }

  .psplit { display: flex; gap: 14px; align-items: stretch; max-width: 1000px; margin: 0 auto;
    height: calc(100vh - 150px); min-height: 420px;
    --pcard:#161f28; --pborder:rgba(255,255,255,.08); --ptxt:#e7eef5; --pmuted:#8a97a4; --pfaint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15);
    --pmono:'JetBrains Mono', var(--vscode-editor-font-family), ui-monospace, monospace; }
  body.vscode-light .psplit, body.vscode-high-contrast-light .psplit {
    --pcard:#ffffff; --pborder:rgba(15,30,45,.12); --ptxt:#132029; --pmuted:#5a6b78; --pfaint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); }
  .psplit .tree { width: 252px; flex: none; overflow: auto; background: var(--pcard); border: 1px solid var(--pborder); border-radius: 12px; padding: 10px; }
  .psplit .feye { font-family: var(--pmono); font-size: 9.5px; letter-spacing: 1.6px; font-weight: 600; color: var(--pfaint); padding: 4px 9px 9px; }
  .psplit .trow { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 7px; cursor: pointer; color: var(--pmuted); }
  .psplit .trow:hover { background: var(--accentSoft); color: var(--ptxt); }
  .psplit .trow.sel { background: var(--accentSoft); color: var(--ptxt); box-shadow: inset 2px 0 0 var(--accent); }
  .psplit .trow .tri { flex: none; width: 8px; font-size: 8px; text-align: center; color: var(--pfaint); transition: transform .2s; }
  .psplit .trow .tri.open { transform: rotate(90deg); }
  .psplit .trow .tri.hide { visibility: hidden; }
  .psplit .trow .ti { width: 13px; height: 13px; flex: none; }
  .psplit .trow.file .ti { color: var(--accent2); }
  .psplit .trow .tname { font-family: var(--pmono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .psplit .tempty { color: var(--pfaint); font-size: 11.5px; padding: 12px 9px; }
  .psplit .prev { flex: 1; min-width: 0; overflow: auto; background: var(--pcard); border: 1px solid var(--pborder); border-radius: 12px; }
  .psplit .pbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 11px 18px; background: var(--pcard); border-bottom: 1px solid var(--pborder); }
  .psplit .pbar .ti { width: 13px; height: 13px; flex: none; color: var(--accent2); }
  .psplit .pbar .pfname { font-family: var(--pmono); font-size: 11.5px; font-weight: 600; color: var(--ptxt); }
  .psplit .pbar .pfill { flex: 1; }
  .psplit .pbar .opened { font-family: var(--pmono); font-size: 10px; color: var(--pfaint); background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 2px 7px; }
  .psplit .pbar .opened:hover { color: var(--ptxt); border-color: var(--accent); }
  .psplit .pbody { padding: 22px 26px 28px; }
  .psplit .doc-empty { color: var(--pfaint); font-size: 12px; padding: 24px 4px; }

  /* Resume hero */
  .proj-track .card.hero { display: block; background: var(--accentSoft); border: 1px solid var(--accent);
    border-radius: 14px; padding: 18px 20px; margin-bottom: 20px; cursor: default; }
  .proj-track .card.hero:hover { background: var(--accentSoft); }
  .proj-track .hero .h-eye { display: flex; align-items: center; gap: 9px; }
  .proj-track .hero .h-eye .lbl { font-family: var(--pmono); font-size: 9.5px; letter-spacing: 1.8px; font-weight: 700; color: var(--accent2); text-transform: uppercase; }
  .proj-track .hero .h-eye .star { margin-left: auto; }
  .proj-track .runbadge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--pmono); font-size: 9px; font-weight: 700;
    padding: 2px 7px; border-radius: 5px; background: rgba(63,211,154,.14); color: var(--good); border: 1px solid rgba(63,211,154,.35); }
  .proj-track .runbadge .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--good); box-shadow: 0 0 5px var(--good); }
  .proj-track .hero .h-body { display: flex; align-items: flex-end; gap: 20px; margin-top: 12px; }
  .proj-track .hero .h-left { flex: 1; min-width: 0; }
  .proj-track .hero .h-name { font-family: var(--pmono); font-size: 19px; font-weight: 600; color: var(--ptxt); }
  .proj-track .hero .h-meta { font-size: 12px; color: var(--pmuted); margin-top: 6px; }
  .proj-track .hero .h-meta b { color: var(--ptxt); font-weight: 600; }
  .proj-track .hero .h-bar { max-width: 420px; height: 6px; border-radius: 3px; background: var(--pborder); margin-top: 12px; overflow: hidden; }
  .proj-track .hero .h-bar > span { display: block; height: 100%; background: linear-gradient(90deg,var(--accent),var(--accent2)); box-shadow: 0 0 8px var(--accentGlow); }
  .proj-track .hero .h-cta { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .proj-track .hero .h-cta > span { margin-right: 8px; } /* git badge (e.g. "✓ up to date") — keep it off the action buttons */
  .proj-track .resume { height: 36px; padding: 0 18px; border-radius: 9px; border: none; color: #fff; font-size: 13px; font-weight: 700;
    background: linear-gradient(180deg,var(--accent2),var(--accent)); box-shadow: 0 2px 12px var(--accentGlow); cursor: pointer; white-space: nowrap; }
  .proj-track .resume:hover { filter: brightness(1.06); }

  /* Queue */
  .proj-track .qeyebrow { font-family: var(--pmono); font-size: 10.5px; letter-spacing: 2px; font-weight: 600; color: var(--pfaint); text-transform: uppercase; margin-bottom: 10px; }
  .proj-track .qlist { display: flex; flex-direction: column; gap: 8px; }
  .proj-track .qlist .card { display: flex; flex-direction: column; gap: 0; align-items: stretch; margin-bottom: 0;
    padding: 13px 16px; border-radius: 11px; background: var(--pcard); border: 1px solid var(--pborder); cursor: pointer; }
  .proj-track .qlist .card:hover { background: var(--pcard); border-color: var(--accent); }
  .proj-track .qlist .card.live { border-color: var(--good); }
  .proj-track .rowmain { display: flex; align-items: center; gap: 16px; width: 100%; }
  .proj-track .qrow .star { font-size: 14px; }
  .proj-track .namecol { width: 230px; flex: none; min-width: 0; }
  .proj-track .namecol.wide { width: auto; flex: 1; }
  .proj-track .namecol .nm { font-family: var(--pmono); font-size: 12px; font-weight: 600; color: var(--ptxt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-track .namecol .nx { font-size: 10.5px; color: var(--pmuted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-track .railcol { flex: 1; min-width: 0; }
  .proj-track .rail { display: flex; align-items: flex-end; gap: 3px; height: 16px; }
  .proj-track .rail .sg { flex: 1; min-width: 0; border-radius: 2px; }
  .proj-track .rail .sg.done { height: 10px; background: var(--accent); }
  .proj-track .rail .sg.cur { height: 16px; background: var(--accent2); box-shadow: 0 0 8px var(--accent2); }
  .proj-track .rail .sg.todo { height: 10px; background: var(--pborder); }
  .proj-track .railcap { display: flex; justify-content: space-between; margin-top: 7px; font-family: var(--pmono); font-size: 9px; color: var(--pfaint); }
  .proj-track .lastcol { width: 88px; flex: none; text-align: right; font-family: var(--pmono); font-size: 10px; color: var(--pfaint); }
  /* min-width, not width: "Create & Push ▾" needs ~130px and a fixed 104px box
     wrapped it onto two lines. Short states (up to date / Commit ▾) still take
     the same 104px, so the column stays lined up down the list. */
  .proj-track .gitcol { min-width: 104px; flex: none; text-align: center; }
  .proj-track .rowacts { flex: none; display: inline-flex; align-items: center; }
</style></head>
<body>
  <div class="topbar">
    <div><h1 id="title">Orchestrator</h1><div class="sub" id="subtitle"></div></div>
    <div class="actions" id="actions"></div>
  </div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
  <div id="multimodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt" id="mm-title">ทำหลาย sprint</div>
      <div class="mh" id="mm-hint"></div>
      <input id="mm-input" type="number" min="1" step="1" />
      <div class="merr" id="mm-err"></div>
      <div class="mact">
        <button class="mbtn" id="mm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="mm-ok">ทำ</button>
      </div>
    </div>
  </div>
  <div id="delmodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt" id="dm-title">ลบโปรเจค</div>
      <div class="mh" id="dm-hint"></div>
      <input id="dm-input" type="text" placeholder="พิมพ์ชื่อโปรเจค" />
      <div class="merr" id="dm-err"></div>
      <div class="mact">
        <button class="mbtn" id="dm-cancel">ยกเลิก</button>
        <button class="mbtn danger" id="dm-ok">ลบถาวร</button>
      </div>
    </div>
  </div>
  <div id="namemodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt">ตั้งชื่อโปรเจคใหม่</div>
      <div class="mh">พิมพ์ชื่อ (เช็คว่างทั้งในเครื่องและ GitHub org) — แก้ได้</div>
      <input id="nm-input" type="text" placeholder="ชื่อโปรเจค" />
      <div class="merr" id="nm-status"></div>
      <div class="mh" style="margin-top:10px">เริ่มจาก repo ที่มีอยู่แล้ว (ไม่ใส่ = สร้างโปรเจคเปล่าเหมือนเดิม)</div>
      <input id="nm-url" type="text" placeholder="https://github.com/org/repo.git · https://dev.azure.com/org/project/_git/repo" />
      <div class="merr" id="nm-urlstatus"></div>
      <div class="mact">
        <button class="mbtn" id="nm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="nm-ok">ถัดไป</button>
      </div>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function el(id){ return document.getElementById(id); }
  function post(t,x){ vscode.postMessage(Object.assign({type:t}, x||{})); }

  // ── Subtitle ──
  // One setter for every screen, because the Detail screen makes it CLICKABLE
  // (copies the project's absolute path) and any screen that set it the old way
  // would inherit a live copy affordance pointing at the previous project.
  var _subCopy = false;
  function setSubtitle(text, copyable){
    var s = el("subtitle");
    s.textContent = text || '';
    _subCopy = !!copyable;
    s.classList.toggle('copyable', _subCopy);
    s.title = _subCopy ? 'คลิกเพื่อคัดลอก path' : '';
  }
  el("subtitle").addEventListener('click', function(){ if(_subCopy) post('copy_path'); });
  // Confirmation comes from the HOST after the clipboard write actually resolved —
  // a click that flashes "คัดลอกแล้ว" on its own would be a claim, not a fact.
  var _copiedT = null;
  function flashCopied(){
    var s = el("subtitle"); if(!_subCopy) return;
    var was = s.textContent;
    s.classList.add('copied'); s.textContent = 'คัดลอก path แล้ว';
    if(_copiedT) clearTimeout(_copiedT);
    _copiedT = setTimeout(function(){ s.classList.remove('copied'); s.textContent = was; }, 1200);
  }

  // "ทำหลาย sprint" centered modal (in-webview so it floats center, not the
  // top command-palette bar that host showInputBox is stuck in). Confirm posts
  // continue_multi{path,count}; host clamps + launches N sprints headless.
  var _mmPath=null, _mmMax=2;
  function openMultiModal(path, name, pending){
    _mmPath=path; _mmMax=Math.max(2, pending||2);
    el('mm-title').textContent='ทำหลาย sprint — '+(name||'');
    el('mm-hint').textContent='จะทำกี่ sprint รวดเดียว (headless, ไม่ attach)? เหลือ '+pending;
    el('mm-err').textContent='';
    var inp=el('mm-input'); inp.max=String(pending); inp.value=String(pending);
    el('multimodal').style.display='flex'; inp.focus(); inp.select();
  }
  function closeMultiModal(){ el('multimodal').style.display='none'; _mmPath=null; }
  function mmConfirm(){
    var v=parseInt(el('mm-input').value,10);
    if(!(v>=1)){ el('mm-err').textContent='ใส่ตัวเลข 1-'+_mmMax; return; }
    if(v>_mmMax){ el('mm-err').textContent='เหลือแค่ '+_mmMax+' sprint'; return; }
    var p=_mmPath; var c=cardOf(p); if(c) c.classList.add('live'); // optimistic: green now
    closeMultiModal(); post('continue_multi',{path:p, count:v});
  }
  el('mm-cancel').addEventListener('click', closeMultiModal);
  el('mm-ok').addEventListener('click', mmConfirm);
  el('multimodal').addEventListener('click', function(e){ if(e.target===el('multimodal')) closeMultiModal(); });
  el('mm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); mmConfirm(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeMultiModal(); } });

  // ── ลบโปรเจค modal (กลางจอ) — 2 รอบในกล่องเดียว: (1) ถามยืนยัน → (2) พิมพ์ชื่อ ──
  var _delPath=null, _delName='', _delPhase=1, _delUnsaved='';
  function openDelModal(path, name){
    _delPath=path; _delName=name||''; _delPhase=1; _delUnsaved='';
    post('del_probe',{path:path});   // ⭐ ถามงานที่จะหาย (worktree/commit ที่ยังไม่ push) — ตอบมาทีหลังได้
    el('dm-title').textContent='ลบโปรเจค '+(name||'')+'?';
    el('delmodal').style.display='flex';
    renderDelPhase();
  }
  // ข้อความ hint ของแต่ละรอบ + คำเตือน "งานที่จะหายถาวร" (ถ้ามี) ต่อท้ายทั้งสองรอบ
  function delHint(){
    var base = _delPhase===1
      ? 'ลบถาวรจากเครื่อง (รวม git + worktrees ข้างใน) · ไม่แตะ GitHub · แน่ใจไหม?'
      : 'พิมพ์ชื่อให้ตรงเพื่อยืนยัน: '+_delName;
    return base + (_delUnsaved ? ' — ' + _delUnsaved : '');
  }
  function renderDelPhase(){
    var inp=el('dm-input'); el('dm-err').textContent='';
    if(_delPhase===1){
      // รอบ 1: แค่ถาม "แน่ใจไหม" (ยังไม่พิมพ์ชื่อ)
      el('dm-hint').textContent=delHint();
      inp.style.display='none'; inp.value='';
      // รอบ 1 = แดงแบบจาง (พาไปสู่การลบ) · รอบ 2 ค่อยเป็นแดงเต็ม (ปุ่มที่ลบจริง)
      el('dm-ok').textContent='ใช่ ลบต่อ'; el('dm-ok').disabled=false;
      el('dm-ok').classList.add('danger'); el('dm-ok').classList.remove('hot');
    } else {
      // รอบ 2: พิมพ์ชื่อให้ตรงถึงจะกด "ลบถาวร" ได้
      el('dm-hint').textContent=delHint();
      inp.style.display=''; inp.value=''; inp.dataset.expect=_delName;
      el('dm-ok').textContent='ลบถาวร'; el('dm-ok').classList.add('danger'); el('dm-ok').classList.add('hot');
      dmSync(); inp.focus();
    }
  }
  function closeDelModal(){ el('delmodal').style.display='none'; _delPath=null; _delPhase=1; }
  function dmSync(){ if(_delPhase===2) el('dm-ok').disabled = el('dm-input').value.trim()!==_delName; }
  function dmOk(){
    if(_delPhase===1){ _delPhase=2; renderDelPhase(); return; }      // รอบ 1 → ไปรอบ 2
    if(el('dm-input').value.trim()!==_delName){ el('dm-err').textContent='ชื่อไม่ตรง'; return; }
    var p=_delPath; closeDelModal(); post('delete_project',{path:p}); // รอบ 2 ผ่าน → ลบจริง
  }
  el('dm-cancel').addEventListener('click', closeDelModal);
  el('dm-ok').addEventListener('click', dmOk);
  el('dm-input').addEventListener('input', dmSync);
  el('delmodal').addEventListener('click', function(e){ if(e.target===el('delmodal')) closeDelModal(); });
  el('dm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); dmOk(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeDelModal(); } });

  // ── ตั้งชื่อโปรเจคใหม่ modal — พิมพ์ + เช็คว่าง (local+github) debounce 400ms ──
  var _nmTimer=null;
  var _nmUrlOk=true;     // ว่าง = ถือว่าโอเค (สร้างเปล่า)
  // _nmNameTouched = "user ตั้งชื่อเอง" เท่านั้น. ⛔ เดิมเป็น !!def ซึ่งจริงตลอด (modal เปิดมา
  // พร้อมชื่อที่ระบบเสนอทุกครั้ง) → บล็อกการเติมชื่อจาก URL ข้างล่างไว้หมด ฟีเจอร์นี้จึงไม่เคยทำงาน
  var _nmNameTouched=false;
  var _nmAutoTries=0;      // กันลูป: ถ้า suggest จากฝั่ง extension แกว่ง (gh ตอบไม่นิ่ง) ให้หยุด
  function openNameModal(def,url,fromUser){
    el('nm-input').value=def||''; el('nm-ok').disabled=true;
    el('nm-status').textContent=''; el('nm-status').className='merr';
    el('nm-url').value=url||''; el('nm-urlstatus').textContent=''; el('nm-urlstatus').className='merr';
    _nmUrlOk=!url; _nmNameTouched=!!fromUser; _nmAutoTries=0;
    el('namemodal').style.display='flex'; el('nm-input').focus(); el('nm-input').select();
    nmSchedule();
  }
  function closeNameModal(){ el('namemodal').style.display='none'; if(_nmTimer) clearTimeout(_nmTimer); }
  function nmSchedule(){
    el('nm-ok').disabled=true; el('nm-status').textContent='กำลังเช็ค…'; el('nm-status').className='merr';
    if(_nmTimer) clearTimeout(_nmTimer);
    _nmTimer=setTimeout(function(){ post('check_name',{name:el('nm-input').value,url:el('nm-url').value}); }, 400);
  }
  function nmResult(m){
    var c=m.check||{}, s=el('nm-status');
    if(!c.valid){ s.textContent='ชื่อไม่ถูกต้อง (ใช้ A-Z a-z 0-9 . _ - เท่านั้น)'; s.className='merr bad'; el('nm-ok').disabled=true; return; }
    var free = !c.localTaken && !(c.githubChecked && c.githubTaken);
    var used = (m.name && m.name!==el('nm-input').value) ? ' (จะใช้ชื่อ "'+m.name+'")' : '';
    if(c.localTaken){ s.textContent='ซ้ำ: มีในเครื่องแล้ว'+used; s.className='merr bad'; }
    else if(c.githubChecked && c.githubTaken){ s.textContent='ซ้ำ: มีบน GitHub org แล้ว'+used; s.className='merr bad'; }
    else if(!c.githubChecked){ s.textContent='ว่างในเครื่อง · เช็ค GitHub ไม่ได้ (gh ไม่พร้อม)'+used; s.className='merr warn'; }
    else { s.textContent='ว่าง ใช้ได้'+used; s.className='merr ok'; }
    // ── verdict ของช่อง URL (ไม่ใส่ = สร้างเปล่า ไม่ใช่ error) ──
    var u=m.url, us=el('nm-urlstatus');
    if(!u){ us.textContent=''; us.className='merr'; _nmUrlOk=true; }
    else if(u.valid){ us.textContent='clone จาก '+u.providerLabel+' → repo "'+u.repo+'"'; us.className='merr ok'; _nmUrlOk=true; }
    else { us.textContent=u.reason||'URL ใช้ไม่ได้'; us.className='merr bad'; _nmUrlOk=false; }
    // URL พา repo มาแล้วและ user ยังไม่ได้ตั้งชื่อเอง → เติมชื่อจาก repo ให้ แล้วเช็คใหม่
    // (m.urlSuggest = ชื่อ repo ที่ bump -vN ให้ว่างแล้ว · ไม่มีก็ถอยไปใช้ชื่อ repo ดิบ)
    var want = u && u.valid ? (m.urlSuggest || u.repo) : '';
    if(want && !_nmNameTouched && el('nm-input').value!==want && _nmAutoTries<3){
      _nmAutoTries++; el('nm-input').value=want; nmSchedule(); return;
    }
    el('nm-ok').disabled=!(free && _nmUrlOk);
  }
  function nmConfirm(){ if(el('nm-ok').disabled) return; var n=el('nm-input').value, u=el('nm-url').value; closeNameModal(); post('name_confirmed',{name:n,url:u}); }
  el('nm-cancel').addEventListener('click', closeNameModal);
  el('nm-ok').addEventListener('click', nmConfirm);
  el('nm-input').addEventListener('input', function(){ _nmNameTouched=true; nmSchedule(); });
  el('nm-url').addEventListener('input', nmSchedule);
  el('nm-url').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); nmConfirm(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeNameModal(); } });
  el('namemodal').addEventListener('click', function(e){ if(e.target===el('namemodal')) closeNameModal(); });
  el('nm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); nmConfirm(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeNameModal(); } });

  // ⛔ เคยมีปุ่ม toggle "โหมดถาม" ตรงนี้ (ส่ง askMode:true ไปกับ launch → kickoff ได้ trigger
  //    grilling+scrutinize) — ถอดออก 2026-08-05 ตามที่ user สั่ง: ไม่เคยได้ใช้เลย และฝั่งสกิล
  //    /orches-drive ก็ถอดสายออกหมดแล้ว (สกิลยังอยู่ในเครื่อง เก็บไว้ implement ที่อื่น)

  // Text-animate the "doing" spinner(s): one shared ticker cycles a braille glyph
  // through every .spin on screen (re-queried each tick so it survives re-render).
  var _SPIN="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split(""), _sp=0;
  setInterval(function(){ _sp=(_sp+1)%_SPIN.length; var f=_SPIN[_sp];
    var ns=document.querySelectorAll('.spin'); for(var i=0;i<ns.length;i++) ns[i].textContent=f;
  }, 90);

  function actionsHtml(canBack, showFetch, showNew, showEdit, githubUrl, showArch, archLabel){
    // showNew = the "+ เริ่มโปรเจคใหม่" button (Projects screen only) → runs the
    // same team→orchestrator→launch flow with no project = a fresh build.
    // fetch = git-refresh of the PROJECTS screen only (dead-end elsewhere).
    // showEdit = "Edit" toggle (Projects screen only) → เผยปุ่มลบต่อการ์ด.
    // githubUrl (teams screen, resume only) → "เปิดใน GitHub" opens the repo in the browser.
    return (canBack ? '<button id="backBtn">← กลับ</button>' : '')
      + (githubUrl ? '<button id="ghBtn" title="เปิด repo นี้ใน GitHub (browser)">🔗 GitHub</button>' : '')
      + (showNew ? '<button id="newProjBtn" title="เริ่ม build โปรเจคใหม่">+ new project</button>' : '')
      + (showFetch ? '<button id="reloadBtn">fetch</button>' : '')
      + (showEdit ? '<button id="editBtn" title="เปิดเพื่อลบโปรเจคที่ไม่ใช้">Edit</button>' : '')
      + (showArch ? '<button id="archBtn" title="สลับดูโปรเจกต์ปกติ / ที่ลบไปแล้ว">'+(archLabel||'deleted')+'</button>' : '');
  }
  function wireActions(canBack){
    if (canBack){ var b=el("backBtn"); if(b) b.addEventListener('click',function(){post('back');}); }
    var gh=el("ghBtn"); if(gh) gh.addEventListener('click',function(){post('open_github');});
    var nb=el("newProjBtn"); if(nb) nb.addEventListener('click',function(){post('start_new');});
    var rb=el("reloadBtn"); if(rb) rb.addEventListener('click',function(){post('git_refresh');});
    var eb=el("editBtn"); if(eb) eb.addEventListener('click',function(){
      var c=el("content"); var on=c.classList.toggle('edit'); eb.classList.toggle('on', on); });
    var arb=el("archBtn"); if(arb) arb.addEventListener('click',function(){post('toggle_archived');});
  }

  // ── git button (project rows) ────────────────────────────────────────────
  function gitCell(g){
    if (!g || g.kind==='none') return '';
    // note = อายุของข้อมูล ahead/behind (หน้านี้ไม่ fetch เอง) — ติดไว้ทุกแบบ
    // เพราะ "up to date" คือคำตอบที่ค้างที่สุด ไม่ใช่คำตอบที่สดที่สุด
    var note = g.note ? esc(g.note) : '';
    if (g.kind==='uptodate') return '<span style="color:#7d8590;font-size:11px;" title="'+note+'">'+esc(g.label)+'</span>';
    // diverged = local AND remote both moved → no safe auto-action. Show an info
    // chip (not a button); the user reconciles in a terminal (pull --rebase/merge).
    if (g.kind==='diverged') return '<span style="color:#e3a13a;font-size:11px;" title="local + remote ต่างมี commit ใหม่ — reconcile เองใน terminal (git pull --rebase หรือ merge)'+(note?' · '+note:'')+'">'+esc(g.label)+'</span>';
    // commit / create-push open an inline form (message / repo name) — the caret
    // signals that, so the orange button doesn't read as "commit right now".
    var caret = (g.kind==='commit'||g.kind==='create-push') ? ' ▾' : '';
    // Styling lives in .git-act / .k-<kind> (see the stylesheet) — inline colours
    // beat every rule, which is how this chip stayed a solid GitHub-green block
    // inside a Bento card.
    return '<button class="git-act k-'+esc(g.kind)+'" data-kind="'+g.kind+'" title="'+note+'">'
      +esc(g.label)+caret+'</button>';
  }
  function gitEditor(g){
    if (g.kind==='commit') return '<div class="git-editor" style="display:none">'
      +'<textarea class="git-msg" rows="2" style="width:100%" placeholder="commit message…"></textarea>'
      +'<div class="barrow"><button class="git-auto">✨ auto</button>'
      +'<button class="git-go">✓ Commit</button>'
      +'<button class="git-pushx" style="display:none" title="auto เสร็จแล้ว commit + push ให้เลย · กดตอนแสงคู่ = ยกเลิกแสงทั้งหมด">⇧ Push ด้วย</button>'
      +'<button class="git-x">ยกเลิก</button></div></div>';
    if (g.kind==='create-push'){ var _p=String(g.path||'').split('/').filter(Boolean); var def=_p[_p.length-1]||'';
      return '<div class="git-editor" style="display:none">'
      +'<input class="git-repo" value="'+esc(def)+'" style="width:55%"> '
      +'<label class="gpriv"><input type="checkbox" class="git-priv" checked> private</label>'
      +'<div class="barrow"><button class="git-go2">Create & Push</button><button class="git-x">ยกเลิก</button></div></div>'; }
    return '';
  }

  // ── Project Detail screen (Split Explorer: persistent tree + markdown preview) ──
  var _docCache = {};        // rel → rendered HTML (or error markup), cached per open
  var _previewRunning = false, _previewAvail = false;
  var _detail = {};          // {title, subtitle, githubUrl, archived}
  var _tree = [];            // TreeNode[] (docs-rooted; README prepended client-side)
  var _readme = null;        // {rel,label} of the project README, or null
  var _selected = null;      // rel of the .md shown in the right pane
  var _expanded = {};        // folder rel -> is it expanded

  // Inline stroke icons (emoji-free): folder = amber outline, doc = accent outline.
  var _icoFolder = '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="#e8a33d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var _icoDoc = '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  var _bkArrow = '<svg class="bk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';

  function detailActionsHtml(githubUrl){
    // Back always exits to the project list (to_projects) — the tree keeps parents
    // reachable, so there is no per-level ".." control anymore.
    var back = '<button id="backBtn" class="dt-back">'+_bkArrow+'Back</button>';
    if(_detail.archived){
      return back + '<span class="archbadge" title="สำเนาสำรองของโปรเจกต์ที่ถูกลบ">อ่านอย่างเดียว (ลบไปแล้ว)</span>';
    }
    var lh = _previewAvail
      ? '<button id="lhBtn" title="รัน dev server แล้วเปิด browser (กดซ้ำ = หยุด)">'+(_previewRunning ? '⏹ หยุด' : '🌐 localhost')+'</button>'
      : '<button id="lhBtn" class="disabled" disabled title="โปรเจคนี้ไม่มี .orches-preview.sh — เปิด localhost ไม่ได้">🌐 localhost</button>';
    return back
      + lh
      + '<button id="contBtn" class="dt-cont" title="เข้า session ของโปรเจกต์นี้ (คุยกับ orchestrator / หาบัค) — ไม่เริ่ม sprint ให้เอง สั่งเองทีหลังได้">▶ ทำต่อ</button>'
      + '<button id="dvBtn" title="ดู sprint/task ของโปรเจกต์นี้ (กดปุ่มกลับเพื่อดูทุกโปรเจกต์)">Data View</button>'
      + (githubUrl ? '<button id="ghBtn" title="เปิด repo นี้ใน GitHub (browser)">GitHub</button>' : '');
  }
  function wireDetailActions(){
    var b=el("backBtn"); if(b) b.addEventListener('click',function(){ post('to_projects'); });
    var lh=el("lhBtn"); if(lh && _previewAvail) lh.addEventListener('click',function(){ lh.disabled=true; lh.textContent='⏳ …'; post('run_localhost'); });
    var ct=el("contBtn"); if(ct) ct.addEventListener('click',function(){ post('continue_to_team'); });
    var dv=el("dvBtn"); if(dv) dv.addEventListener('click',function(){ post('open_data_view'); });
    var gh=el("ghBtn"); if(gh) gh.addEventListener('click',function(){ post('open_github'); });
  }

  function renderDetail(m){
    disarmAll();                       // leaving the projects screen → drop any armed git action
    _lastProjKey = null;               // invalidate skip-guard → a return to projects re-renders
    _detail = { title:m.title, subtitle:m.subtitle, githubUrl:m.githubUrl, archived: !!m.archived };
    _previewRunning = !!(m.preview && m.preview.running);
    _previewAvail   = !!(m.preview && m.preview.available);
    _docCache = {};
    _readme = m.readme || null;
    var base = m.tree || [];
    // ทรีเป็นโครงจริงของโปรเจกต์แล้ว ⇒ README.md อยู่ในนั้นตามที่มันอยู่จริง
    // ⛔ เติมหัวให้เฉพาะกรณีที่หามันในทรีไม่เจอ (เช่น README อยู่ใน docs/ ที่ถูกเลือกเป็น readme
    //    แต่ทรีถูก prune) ไม่งั้นจะโผล่สองแถว — แถวปลอมหนึ่งแถวที่ path ไม่ตรงกับของจริง
    _tree = (_readme && !relExists(base, _readme.rel))
      ? [{ name: (_readme.rel.split('/').pop()||'README.md'), rel:_readme.rel, kind:'file' }].concat(base)
      : base;
    _expanded = {};
    if(hasDir(_tree, 'docs/wiki')) _expanded['docs/wiki'] = true;  // wiki open by default
    _selected = defaultSel();
    expandAncestors(_selected);
    renderSplit();
    if(_selected) loadDoc(_selected);
  }
  function hasDir(nodes, rel){
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.kind==='dir'){ if(n.rel===rel) return true; if(hasDir(n.children||[], rel)) return true; } }
    return false;
  }
  function firstFile(nodes){
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.kind==='file') return n.rel; if(n.kind==='dir'){ var r=firstFile(n.children||[]); if(r) return r; } }
    return null;
  }
  function relExists(nodes, rel){
    for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.rel===rel && n.kind==='file') return true; if(n.kind==='dir' && relExists(n.children||[], rel)) return true; }
    return false;
  }
  // Default = plan.md (the file the user usually wants) → README → first .md.
  function defaultSel(){
    if(relExists(_tree,'docs/plan.md')) return 'docs/plan.md';
    if(_readme && relExists(_tree,_readme.rel)) return _readme.rel;
    return firstFile(_tree);
  }
  function expandAncestors(rel){
    if(!rel) return;
    (function walk(nodes){
      for(var i=0;i<nodes.length;i++){ var n=nodes[i];
        if(n.kind==='dir'){ if(rel===n.rel || rel.indexOf(n.rel+'/')===0) _expanded[n.rel]=true; walk(n.children||[]); } }
    })(_tree);
  }
  function treeRowsHtml(nodes, depth){
    var out='';
    for(var i=0;i<nodes.length;i++){ var n=nodes[i];
      var pad = 9 + depth*14;
      if(n.kind==='dir'){
        var open = !!_expanded[n.rel];
        out += '<div class="trow" data-dir="'+esc(n.rel)+'" style="padding-left:'+pad+'px">'
          + '<span class="tri'+(open?' open':'')+'">▶</span>'+_icoFolder
          + '<span class="tname">'+esc(n.name)+'</span></div>';
        if(open) out += treeRowsHtml(n.children||[], depth+1);
      } else {
        out += '<div class="trow file'+(_selected===n.rel?' sel':'')+'" data-file="'+esc(n.rel)+'" style="padding-left:'+pad+'px">'
          + '<span class="tri hide">▶</span>'+(isImg(n.name)?_icoImg:_icoDoc)
          + '<span class="tname">'+esc(n.name)+'</span></div>';
      }
    }
    return out;
  }
  function selName(){
    if(!_selected) return '';
    var found='';
    (function walk(nodes){ for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(n.rel===_selected && n.kind==='file'){ found=n.name; return; } if(n.kind==='dir') walk(n.children||[]); } })(_tree);
    return found || (_selected.split('/').pop()||_selected);
  }
  function renderSplit(){
    el("title").textContent = _detail.title;
    setSubtitle(_detail.subtitle, true); // Detail: the absolute path, click to copy
    el("actions").innerHTML = detailActionsHtml(_detail.githubUrl); wireDetailActions();
    var treeHtml = treeRowsHtml(_tree, 0) || '<div class="tempty">ไม่มีไฟล์ .md</div>';
    var body = _selected
      ? (_docCache[_selected]!==undefined ? _docCache[_selected] : '<div class="doc-empty">กำลังโหลด…</div>')
      : '<div class="doc-empty">เลือกไฟล์จากด้านซ้าย</div>';
    var bar = _selected
      ? '<div class="pbar">'+(isImg(selName())?_icoImg:_icoDoc)+'<span class="pfname">'+esc(selName())+'</span><span class="pfill"></span><button class="opened" title="เปิดไฟล์นี้เป็นแท็บ editor">เปิดใน editor</button></div>'
      : '';
    el("content").innerHTML = '<div class="psplit">'
      + '<div class="tree"><div class="feye">FILES</div>'+treeHtml+'</div>'
      + '<div class="prev">'+bar+'<div class="pbody doc-body">'+body+'</div></div>'
      + '</div>';
    var tree = el("content").querySelector('.tree');
    if(tree) tree.addEventListener('click', function(e){
      var row = e.target.closest ? e.target.closest('.trow') : null; if(!row) return;
      if(row.hasAttribute('data-dir')){ var r=row.getAttribute('data-dir'); _expanded[r]=!_expanded[r]; renderTreeOnly(); }
      else if(row.hasAttribute('data-file')){ selectFile(row.getAttribute('data-file')); }
    });
    var op = el("content").querySelector('.opened');
    if(op) op.addEventListener('click', function(){ if(_selected) post('open_in_editor',{rel:_selected}); });
    // full render ก็ยัด HTML จาก cache เข้า DOM เหมือนกัน → ต้อง render mermaid ด้วย ไม่งั้นกลับมาหน้านี้แล้วไดอะแกรมหาย
    renderMermaidIn(el("content").querySelector('.pbody'));
  }
  // Re-render only the tree (folder toggle / selection change) — leaves the right
  // pane + its scroll position untouched. The click listener is on .tree (delegated).
  function renderTreeOnly(){
    var tree = el("content").querySelector('.tree'); if(!tree) return;
    tree.innerHTML = '<div class="feye">FILES</div>' + (treeRowsHtml(_tree,0) || '<div class="tempty">ไม่มีไฟล์ .md</div>');
  }
  function selectFile(rel){
    if(_selected===rel) return;
    _selected = rel;
    renderTreeOnly();
    var bar = el("content").querySelector('.pbar');
    if(bar){ var f=bar.querySelector('.pfname'); if(f) f.textContent=selName(); }
    else { renderSplit(); return; }   // pane had no file selected yet → full render
    var body = el("content").querySelector('.pbody');
    if(body){
      // cache hit = HTML เดิมถูกยัดกลับเข้า DOM → ต้อง render mermaid ใหม่ (SVG ที่เคย render หายไปกับ innerHTML)
      paintDocBody(_docCache[rel]!==undefined ? _docCache[rel] : '<div class="doc-empty">กำลังโหลด…</div>');
      body.scrollTop=0;
    }
    loadDoc(rel);
  }
  function loadDoc(rel){ if(_docCache[rel]===undefined) post('open_doc',{rel:rel}); }

  // ── mermaid: โหลดบันเดิล 3.4MB แบบ lazy "ครั้งเดียวต่อ panel" และเฉพาะตอนเปิดเอกสารที่มีไดอะแกรมจริง
  //   ⛔ ห้ามใส่ <script src> ไว้ในหน้าเลย: คนที่ไม่เคยเปิดเอกสารที่มีไดอะแกรม (ส่วนใหญ่) จะจ่าย
  //      เวลา parse ทุกครั้งที่เปิด panel ฟรี ๆ · host ส่ง uri มาพร้อม doc_html เฉพาะเอกสารที่มี block
  //   ⛔ พังต้องพังแบบเห็น: โหลดไม่ได้/parse ไม่ผ่าน = ขึ้นข้อความบอกเหตุ แล้ว **คงข้อความไดอะแกรมไว้**
  //      (เงียบ ๆ แล้วเหลือกล่องว่าง = แยกไม่ออกจาก "ไม่มีไดอะแกรม")
  var _mmUri=null, _mmLoaded=false, _mmLoading=null;
  function loadMermaid(){
    if(_mmLoaded) return Promise.resolve();
    if(_mmLoading) return _mmLoading;
    if(!_mmUri) return Promise.reject(new Error('ไม่ได้รับที่อยู่ไฟล์ mermaid'));
    _mmLoading = new Promise(function(res,rej){
      var s=document.createElement('script');
      s.src=_mmUri;
      s.onload=function(){
        try{
          var b=document.body.classList;
          var dark=b.contains('vscode-dark')||b.contains('vscode-high-contrast');
          window.mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme: dark?'dark':'default'});
          _mmLoaded=true; res();
        }catch(e){ rej(e); }
      };
      s.onerror=function(){ rej(new Error('โหลดไฟล์ mermaid ไม่ได้')); };
      document.head.appendChild(s);
    });
    return _mmLoading;
  }
  function renderMermaidIn(root){
    if(!root) return;
    var nodes=root.querySelectorAll('pre.mermaid:not([data-processed])');
    if(!nodes.length) return;
    loadMermaid().then(function(){ return window.mermaid.run({nodes:nodes}); })
      .catch(function(e){
        var msg='แสดงไดอะแกรมไม่ได้: '+esc(String((e&&e.message)||e))+' — ข้อความไดอะแกรมยังอยู่ด้านล่าง';
        for(var i=0;i<nodes.length;i++) nodes[i].insertAdjacentHTML('beforebegin','<div class="doc-empty">'+msg+'</div>');
      });
  }
  var _icoImg = '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="#6bbf6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-6 6"/></svg>';
  function isImg(name){ return /\.(png|jpe?g|gif|webp)$/i.test(name||''); }
  function paintDocBody(html){
    var body=el("content").querySelector('.pbody');
    if(!body) return;
    body.innerHTML=html;
    renderMermaidIn(body);
  }
  function handleDocHtml(rel, html, error, mermaidUri, imgSrc){
    if(mermaidUri) _mmUri=mermaidUri;
    var out = error ? '<div class="doc-empty">'+esc(error)+'</div>'
      : imgSrc ? '<div class="shot"><img src="'+imgSrc+'" alt="'+esc(rel)+'"/></div>'
      : (html||'');
    _docCache[rel]=out;
    if(_selected===rel) paintDocBody(out);
  }
  function handlePreviewState(running){
    _previewRunning=!!running;
    var lh=el("lhBtn"); if(lh){ lh.disabled=false; lh.textContent=_previewRunning?'⏹ หยุด':'🌐 localhost'; }
  }

  // Skip-guard for no-op re-renders. The spin poll (startSpinPoll, host side) resends
  // the ENTIRE card list every ~2.5s while a run is live; renderProjects rebuilds
  // content.innerHTML wholesale, which tears down + recreates the animated spinner
  // nodes (.cont-rot CSS rotation + .spin glyph) so their animation restarts from 0 →
  // the ⟳ "กำลังทำ" visibly หยุดหมุน/กระตุก every tick. When the payload is byte-identical
  // (the common case: a stable running sprint) there is nothing to redraw, so skip the
  // rebuild and let the spinner run continuously. A real change (git state, sprint done,
  // worker start/stop) differs and falls through to a normal render. Reset to null when
  // leaving the projects screen (renderDetail/Teams/Orch) so returning always re-renders.
  var _lastProjKey = null;
  function renderProjects(m){
    var _key = JSON.stringify([m.title, m.subtitle, m.items]);
    if (_lastProjKey !== null && _key === _lastProjKey) return;
    _lastProjKey = _key;
    el("title").textContent = m.title;
    // No legend when there are projects (keeps the header clean); the plain
    // "no projects" line still shows when the list is empty.
    setSubtitle((m.items && m.items.length) ? "" : m.subtitle, false);
    el("actions").innerHTML = actionsHtml(false, true, true, true, false, true, 'active'); wireActions(false);
    var items = m.items||[];
    // การ์ด project ที่หลุดจาก list (เสร็จ/หาย) ระหว่างที่ยัง arm ค้าง → เลิก arm+timer ทิ้ง (กันยิงตอนการ์ดไม่อยู่แล้ว)
    var _live={}; items.forEach(function(it){ _live[it.path]=1; });
    for(var _k in AUTO){ if(Object.prototype.hasOwnProperty.call(AUTO,_k) && !_live[_k]) disarmHard(_k); }
    // Per-item controls — the SAME elements + class names the wiring loop below
    // expects (.star/.cont/.cont.multi/.del/.git-act/.git-editor), just laid out
    // Bento-style. Nothing about the git-arm / continue-run / delete behaviour
    // changes; only the surrounding markup does.
    function controls(it){
      var wt = it.worktrees||0, sp = it.sprints||0;
      var pt = it.plannedTotal||0, pd = it.plannedDone||0;
      var pending = pt > 0 ? (pt - pd) : wt; if (pending < 0) pending = 0;
      var done = pt > 0 ? pd : sp;
      var run = it.run || { state: 'hidden' };
      var act = it.actions || { kind: 'none' };
      var busy = act.kind === 'busy';
      var contBtn = '', multiBtn = '', crashChip = '', crashCls = '';
      if (busy) {
        contBtn = run.state === 'spinning'
          ? '<button class="cont spin" title="กำลังทำต่อ — คลิกเพื่อยกเลิก"><span class="cont-rot">⟳</span> กำลังทำ</button>'
          : '<button class="cont busy" title="กำลังทำอยู่ (มี session ขับโปรเจคนี้) — คลิกเพื่อเปิด/เข้า session"><span class="cont-rot">⟳</span> กำลังทำ</button>';
      } else if (act.kind === 'actions') {
        contBtn = '<button class="cont" title="ทำต่อ 1 sprint ด้วยทีมล่าสุด (auto, background)">ทำ 1 sprint</button>';
        multiBtn = act.runNEnabled
          ? '<button class="cont multi" data-pending="'+pending+'" data-name="'+esc(it.name)+'" title="ทำหลาย sprint รวดเดียว (auto, background) — เลือกจำนวน">ทำ N sprint</button>'
          : '<button class="cont multi disabled" disabled title="เหลือ sprint เดียว — ทำได้ทีละ 1">ทำ N sprint</button>';
        if (act.crash === 'stale') { crashChip = '<span class="chip crash">รันไม่จบ · session ดับ</span>'; crashCls = ' crash'; }
        else if (act.crash === 'error') { crashChip = '<span class="chip crash" title="error: '+esc(run.errorMsg||'?')+'">error: '+esc(run.errorMsg||'?')+'</span>'; crashCls = ' crash'; }
      }
      var delBtn = busy
        ? '<button class="del disabled" title="กำลังทำอยู่ — กด stop / ปิด session ก่อนถึงจะลบได้">ลบ</button>'
        : '<button class="del" data-name="'+esc(it.name)+'" title="ลบโปรเจคออกจากเครื่อง">ลบ</button>';
      return { pt: pt, pd: pd, done: done, pending: pending, busy: busy, crashChip: crashChip, crashCls: crashCls,
        contBtn: contBtn, multiBtn: multiBtn, delBtn: delBtn,
        gitBadge: busy ? '' : gitCell(it.git), gitEd: busy ? '' : gitEditor(it.git) };
    }
    function relTime(ms){
      if (!ms) return '';
      var s = Math.floor((Date.now()-ms)/1000); if (s < 0) s = 0;
      if (s < 60) return 'เมื่อครู่';
      var mm = Math.floor(s/60); if (mm < 60) return mm+' นาทีที่แล้ว';
      var h = Math.floor(mm/60); if (h < 24) return h+' ชม.ที่แล้ว';
      var d = Math.floor(h/24); if (d < 30) return d+' วันก่อน';
      var mo = Math.floor(d/30); if (mo < 12) return mo+' เดือนก่อน';
      return Math.floor(mo/12)+' ปีก่อน';
    }
    function nextText(it){
      var id = it.nextSprintId||'', t = it.nextSprintTitle||'';
      if (id && t) return id+' · '+t; if (id) return id; if (t) return t; return 'พร้อมเริ่ม';
    }
    function railHtml(pd, pt){
      var segs = '';
      for (var i=0;i<pt;i++){ var cls = i<pd ? 'done' : (i===pd ? 'cur' : 'todo'); segs += '<span class="sg '+cls+'"></span>'; }
      var pct = Math.round(pd/pt*100);
      return '<div class="rail">'+segs+'</div><div class="railcap"><span>S1</span><span>'+pd+' / '+pt+' sprint · '+pct+'%</span><span>S'+pt+'</span></div>';
    }
    function runBadge(it){ return (it.driven||it.doing) ? '<span class="runbadge"><span class="dot"></span>RUN</span>' : ''; }
    function heroHtml(it){
      var c = controls(it);
      var star = '<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>';
      var meta = 'sprint ถัดไป: <b>'+esc(nextText(it))+'</b>'+(c.pending>0?' · ค้าง '+c.pending:'')+(it.lastRun?' · แก้ล่าสุด '+esc(relTime(it.lastRun)):'');
      var bar = c.pt>0 ? '<div class="h-bar"><span style="width:'+Math.round(c.pd/c.pt*100)+'%"></span></div>' : '';
      return '<div class="card hero'+(it.driven?' live':'')+c.crashCls+'" data-path="'+esc(it.path)+'">'
        +'<div class="h-eye"><span class="lbl">ทำต่อจากล่าสุด</span>'+runBadge(it)+star+'</div>'
        +'<div class="h-body"><div class="h-left"><div class="h-name">'+esc(it.name)+c.crashChip+'</div>'
        +'<div class="h-meta">'+meta+'</div>'+bar+'</div>'
        +'<div class="h-cta">'+c.gitBadge+c.contBtn+c.multiBtn+'<button class="resume" title="เข้า session ของโปรเจกต์นี้ (คุยกับ orchestrator / หาบัค) — ไม่เริ่ม sprint ให้เอง">ทำต่อ →</button>'+c.delBtn+'</div></div>'
        +c.gitEd+'</div>';
    }
    function rowHtml(it){
      var c = controls(it);
      var star = '<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>';
      var rail = c.pt>0 ? railHtml(c.pd, c.pt)
        : '<div class="railcap"><span>'+(c.done>0?('ทำไปแล้ว '+c.done+' sprint'):'พร้อมเริ่ม')+'</span><span>ไม่มี plan.md</span></div>';
      var main = '<div class="rowmain">'+star
        +'<div class="namecol"><div class="nm">'+esc(it.name)+runBadge(it)+c.crashChip+'</div><div class="nx">ถัดไป: '+esc(nextText(it))+'</div></div>'
        +'<div class="railcol">'+rail+'</div>'
        +'<div class="lastcol">'+esc(it.lastRun?relTime(it.lastRun):'')+'</div>'
        +'<div class="gitcol">'+c.gitBadge+'</div>'
        +'<div class="rowacts">'+c.contBtn+c.multiBtn+c.delBtn+'</div></div>';
      return '<div class="card qrow'+(it.driven?' live':'')+c.crashCls+'" data-path="'+esc(it.path)+'">'+main+c.gitEd+'</div>';
    }
    if (!items.length) {
      el("content").innerHTML = '<div class="proj-track"><div class="empty">'+esc(m.subtitle)+'</div></div>';
    } else {
      var hero = items[0], queue = items.slice(1);
      var html = '<div class="proj-track">'+heroHtml(hero);
      if (queue.length) html += '<div class="qeyebrow">คิวถัดไป</div><div class="qlist">'+queue.map(rowHtml).join('')+'</div>';
      html += '</div>';
      el("content").innerHTML = html;
    }
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      // Whole row selects the project — except clicks on the git button, its
      // inline form, or the star toggle (those do their own thing).
      card.addEventListener('click',function(e){
        if (e.target.closest('.git-act') || e.target.closest('.git-editor') || e.target.closest('.star') || e.target.closest('.cont') || e.target.closest('.del')) return;
        // เพิ่งมี editor หุบไป (commit/ยกเลิก) → layout เพิ่งขยับ คลิกที่ 2 ของ
        // double-click จะตกใส่แถวอื่น — เมินช่วงสั้นๆ กัน pick/attach ผิดโปรเจค
        if (Date.now() - _edCloseAt < 350) return;
        post('pick_project',{path:path});
      });
      var starEl=card.querySelector('.star');
      if(starEl) starEl.addEventListener('click',function(e){ e.stopPropagation(); post('toggle_star',{path:path}); });
      var contEl=card.querySelector('.cont:not(.multi)');
      if(contEl) contEl.addEventListener('click',function(e){ e.stopPropagation();
        // spinning → this click CANCELS the live run; any other state → start one.
        if(contEl.classList.contains('spin')) post('cancel_run',{path:path});
        else { card.classList.add('live'); post('continue_run',{path:path}); } }); // optimistic: green now
      var multiEl=card.querySelector('.cont.multi:not(.disabled)');
      if(multiEl) multiEl.addEventListener('click',function(e){ e.stopPropagation();
        openMultiModal(path, multiEl.dataset.name||'', Number(multiEl.dataset.pending)||2); });
      var delEl=card.querySelector('.del:not(.disabled)');
      if(delEl) delEl.addEventListener('click',function(e){ e.stopPropagation(); openDelModal(path, delEl.dataset.name||''); });
      wireGit(card, path);
    });
    // DOM เพิ่งถูกสร้างใหม่ทั้งจอ (host re-render หลังทุก git action) — สถานะ arm/แสง
    // อยู่ใน AUTO (script ตัวนี้รันครั้งเดียว) จึงต้อง apply กลับเข้าปุ่มทุกใบ
    items.forEach(function(it){ applyAutoUi(it.path); });
  }
  // The deleted-projects list — read-only rows (name + delete date), no git/continue/
  // delete controls. Reuses the projects action bar so the toggle button stays present
  // to switch back to the live list.
  function renderArchived(m){
    _lastProjKey = null;                 // returning to live projects must re-render
    el("title").textContent = m.title; setSubtitle(m.subtitle, false);
    el("actions").innerHTML = actionsHtml(false, false, false, false, false, true, 'deleted'); wireActions(false);
    var arb=el("archBtn"); if(arb) arb.classList.add('on');
    var items = m.items||[];
    // Reuse the active view's Bento frame (.proj-track + queue rows). Deleted items
    // only carry name + delete date, so each row is a name block (no rail/git/star).
    if(!items.length){ el("content").innerHTML = '<div class="proj-track"><div class="empty">'+esc(m.subtitle)+'</div></div>'; return; }
    var rows = items.map(function(it){
      var when = it.deletedAt ? String(it.deletedAt).slice(0,10) : '';
      return '<div class="card qrow" data-path="'+esc(it.path)+'">'
        +'<div class="rowmain"><div class="namecol wide"><div class="nm">'+esc(it.name)+'</div>'
        +'<div class="nx">ลบไปแล้วเมื่อ '+esc(when)+'</div></div></div></div>';
    }).join('');
    el("content").innerHTML = '<div class="proj-track"><div class="qeyebrow">ลบไปแล้ว</div><div class="qlist">'+rows+'</div></div>';
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      card.addEventListener('click',function(){ post('pick_archived',{path:path}); });
    });
  }
  function wireGit(card, path){
    var ed=card.querySelector('.git-editor'), act=card.querySelector('.git-act');
    if(act) act.addEventListener('click',function(e){ e.stopPropagation();
      var k=act.dataset.kind;
      if(k==='push'){ post('git_push',{path:path}); return; }
      if(k==='pull'){ post('git_pull',{path:path}); return; }
      // commit / create-push: OPEN the form (never toggle-closed). Re-clicking the
      // orange button used to collapse it → looked like "nothing happened / stuck".
      if(ed){ ed.style.display='block'; ast(path).edOpen=true; var mb=ed.querySelector('.git-msg'); if(mb) mb.focus(); } });
    if(!ed) return;
    var mb0=ed.querySelector('.git-msg'); if(mb0) mb0.addEventListener('input',function(){
      var st=ast(path); st.draft=mb0.value; st.edOpen=true;});  // เก็บ draft กันหายตอนจอ re-render
    var x=ed.querySelector('.git-x'); if(x) x.addEventListener('click',function(){
      // ปิดฟอร์ม = ล้มเลิกทั้งหมด (หยุด auto + ปลดแสง + ทิ้ง draft) — กัน arm ค้างแบบมองไม่เห็น
      var st=ast(path); st.thinking=false; st.gen++; disarm(path); st.draft=null; st.edOpen=false;
      applyAutoUi(path); _edCloseAt=Date.now(); ed.style.display='none';});
    var au=ed.querySelector('.git-auto'); if(au) au.addEventListener('click',function(){
      var st=ast(path);
      st.gen++;  // ทุกการกด = ตัดผลของ request เก่าที่ยังลอยอยู่ทิ้งเสมอ
      // หยุดทุกกรณีที่ระบบกำลังทำงาน: กำลังคิด "หรือ" แสงวิ่งอยู่ (รวมช่วง grace ที่คิดเสร็จแล้ว)
      if(st.thinking || st.armed>0){ st.thinking=false; disarm(path); applyAutoUi(path); return; }
      st.thinking=true; st.msg=null; applyAutoUi(path); post('git_auto',{path:path,gen:st.gen});});
    var go=ed.querySelector('.git-go'); if(go) go.addEventListener('click',function(){
      var st=ast(path);
      if(st.armed>0){ disarmToBox(path, ed); return; }        // กดตอนแสงวิ่ง = ยกเลิก auto-commit (auto ยังคิดต่อ)
      if(st.thinking){ st.armed=1; st.armedAt=Date.now(); applyAutoUi(path); return; } // arm: คิดเสร็จ = commit เอง (grace 3 วิ)
      var v=(ed.querySelector('.git-msg').value||'').trim(); if(!v)return;
      st.draft=null; st.edOpen=false; _edCloseAt=Date.now();
      post('git_commit',{path:path,message:v}); ed.style.display='none';});
    var px=ed.querySelector('.git-pushx'); if(px) px.addEventListener('click',function(){
      var st=ast(path);
      if(st.armed===1){ st.armed=2; st.armedAt=Date.now(); if(st.msg) scheduleExec(path); applyAutoUi(path); return; } // arm push + reset 3 วิ
      if(st.armed===2){ disarmToBox(path, ed); return; }      // กดตอนแสงคู่ = แสงหายทั้งคู่ (auto ยังคิดต่อ)
    });
    var go2=ed.querySelector('.git-go2'); if(go2) go2.addEventListener('click',function(){
      var n=(ed.querySelector('.git-repo').value||'').trim(); if(!n)return;
      ast(path).edOpen=false; _edCloseAt=Date.now();
      post('git_createpush',{path:path,repoName:n,isPrivate:ed.querySelector('.git-priv').checked}); ed.style.display='none';});
  }
  function fillAuto(path,message){
    var card=cardOf(path);
    if(!card)return; var au=card.querySelector('.git-auto'); if(au){au.textContent='✨ auto';au.disabled=false;}
    var st=ast(path); st.edOpen=true; if(message) st.draft=message;  // เก็บเป็น draft — รอด re-render
    var ed=card.querySelector('.git-editor'); if(ed) ed.style.display='block';
    var box=card.querySelector('.git-msg'); if(box&&message) box.value=message;
  }

  // ── auto-commit arming — สถานะแยกต่อ project, ตัวจับเวลาอิสระต่อกัน ─────────
  // st = { thinking: auto กำลังคิด, armed: 0 ไม่ arm / 1 commit / 2 commit+push,
  //        armedAt: เวลา click ล่าสุดที่เพิ่ม/ขยับ arm (จุดเริ่ม grace 3 วิ),
  //        msg: ข้อความที่ auto คิดเสร็จ (รอ grace), execTimer: setTimeout id }
  var AUTO = {};
  var GRACE_MS = 3000;
  // กัน double-click: คลิกที่ 2 ตกบน layout ที่เพิ่งขยับ (editor เพิ่งหุบ) แล้วกลายเป็น
  // pick_project ของแถวอื่น — จำเวลาหุบล่าสุดไว้แล้วเมิน card-click ช่วงสั้นๆ หลังจากนั้น
  var _edCloseAt = 0;
  function ast(p){ return AUTO[p] || (AUTO[p] = {thinking:false, armed:0, armedAt:0, msg:null,
    execTimer:null, gen:0, draft:null, edOpen:false}); }
  function cardOf(p){ return el("content").querySelector('.card[data-path="'+(window.CSS&&CSS.escape?CSS.escape(p):p)+'"]'); }
  function disarm(p){ var st=ast(p); st.armed=0; st.armedAt=0;
    if(st.execTimer){ clearTimeout(st.execTimer); st.execTimer=null; }
    var m=st.msg; st.msg=null; return m; }  // soft: ปลด arm + เคลียร์ timer เท่านั้น — auto ที่ยังคิดอยู่ปล่อยคิดต่อ (disarmToBox พึ่งพฤติกรรมนี้)
  // hard: soft + ทิ้งผล auto ที่ยัง in-flight ด้วย (thinking=false + gen++ → git_auto_result เก่าถูก drop)
  // ใช้เฉพาะตอนละทิ้งงานทั้งหมดจริงๆ (ออกจากหน้า / ซ่อน panel / การ์ดหลุด) — ไม่ใช่ตอน user แค่ยกเลิก arm
  function disarmHard(p){ var st=ast(p); st.thinking=false; st.gen++; return disarm(p); }
  // ยกเลิก arm/timer ของทุก project พร้อมกัน (hard) + รีเฟรช UI (ลบไฟเรือง/คืนปุ่ม ✨auto/ซ่อน push)
  // ถ้าไม่เรียก applyAutoUi คลาส .glow จะค้างบนปุ่ม → ไฟเรืองหมุนไม่หยุดตอนกลับมาหน้าเดิม (state ปลดแล้วก็จริง)
  function disarmAll(){ for(var k in AUTO){ if(Object.prototype.hasOwnProperty.call(AUTO,k)){ disarmHard(k); applyAutoUi(k); } } }
  function scheduleExec(p){ var st=ast(p);
    if(st.execTimer) clearTimeout(st.execTimer);
    var wait=Math.max(0, GRACE_MS-(Date.now()-st.armedAt));
    st.execTimer=setTimeout(function(){ execArmed(p); }, wait); }
  function execArmed(p){ var st=ast(p); st.execTimer=null;
    if(!st.armed || !st.msg) return;
    var withPush=(st.armed===2), msg=st.msg;
    st.armed=0; st.armedAt=0; st.msg=null;
    // ปิดฟอร์มทันทีที่ยิง commit — ไม่รอ host re-render กลับมา กัน user มือเร็วกด auto/commit/push
    // ในเสี้ยววิระหว่าง commit→push (ตอนนั้นงานยิงไปแล้ว กดซ้ำ = commit/แกล้งซ้อน)
    st.edOpen=false; st.draft=null; _edCloseAt=Date.now();
    applyAutoUi(p);
    var card=cardOf(p), ed=card&&card.querySelector('.git-editor'); if(ed) ed.style.display='none';
    post(withPush?'git_commit_push':'git_commit',{path:p,message:msg}); }
  function applyAutoUi(p){ var card=cardOf(p); if(!card) return;
    var st=ast(p), ed=card.querySelector('.git-editor');
    var au=card.querySelector('.git-auto'), go=card.querySelector('.git-go'), px=card.querySelector('.git-pushx');
    if(!go) return;
    // ปุ่ม auto = ปุ่มหยุดตลอดช่วงที่ระบบทำงาน (กำลังคิด "หรือ" แสงวิ่งช่วง grace)
    if(au){ au.textContent = (st.thinking || st.armed>0) ? '⏹ หยุด' : '✨ auto'; au.disabled=false; }
    if(ed && (st.thinking || st.armed>0 || st.edOpen)) ed.style.display='block';
    // ฟื้น message ที่พิมพ์ค้าง/auto เติมไว้ หลังจอถูก re-render (host refresh ทุก git action)
    var bx=card.querySelector('.git-msg'); if(bx && st.draft && !bx.value) bx.value=st.draft;
    go.classList.toggle('glow', st.armed>0);
    if(px){ px.style.display = st.armed>0 ? '' : 'none';
      // sync: ตอนแสง push เพิ่งติด ให้ restart แสง commit ในเฟรมเดียวกัน → จุดวิ่งออกจาก 0° พร้อมกัน (เฟสตรงกันตลอด grace)
      var pxOn = st.armed===2, pxWas = px.classList.contains('glow');
      if(pxOn && !pxWas){ go.classList.remove('glow'); void go.offsetWidth; go.classList.add('glow'); }
      px.classList.toggle('glow', pxOn); } }
  // คืน msg ที่ค้างเข้า textarea ตอนปลด arm ระหว่าง grace — จะได้ไม่หายไปเฉยๆ
  function disarmToBox(p, ed){ var m=disarm(p); applyAutoUi(p);
    if(m){ var st=ast(p); st.draft=m; st.edOpen=true;
      var b=ed.querySelector('.git-msg'); if(b && !b.value.trim()) b.value=m; } }
  function handleAutoResult(p, message, gen){ var st=ast(p);
    if(typeof gen==='number' && gen!==st.gen) return;  // ผลของ request ที่ถูกยกเลิก/แทนที่ — ทิ้ง (กัน commit ด้วย message เก่า)
    if(!st.thinking) return;                       // ถูกยกเลิกไปแล้ว — ทิ้งผลเงียบๆ
    st.thinking=false;
    if(st.armed>0){
      st.msg=String(message||'').trim();
      if(!st.msg){ disarm(p); applyAutoUi(p); fillAuto(p,''); return; }   // auto คิดไม่ออก → ปลด arm ให้พิมพ์เอง
      st.armedAt=Date.now(); scheduleExec(p); applyAutoUi(p); return;  // grace นับจากตอน "ผลมาถึง" (user เพิ่งเห็น msg) — ไม่ใช่จาก click ก่อน gen (ไม่งั้น gen>3วิ = ยิงทันทีไม่มีช่อง cancel)
    }
    applyAutoUi(p); fillAuto(p, message); }

  // Deterministic avatar hue from the team name (hash % 360) — a team is always the
  // same color, and the color space is effectively unlimited (not a fixed palette).
  function tsHue(s){ var h=0; s=String(s||''); for(var i=0;i<s.length;i++){ h=(h*31 + s.charCodeAt(i))>>>0; } return h%360; }
  function renderTeams(m){ disarmAll(); _lastProjKey=null;  // ออกจากหน้า projects → เลิก arm/timer ที่ค้างทั้งหมด (+invalidate skip-guard)
    el("title").textContent=m.title; setSubtitle(m.subtitle, false);
    el("actions").innerHTML=actionsHtml(m.canBack, false, false, false, m.githubUrl); wireActions(m.canBack);
    var items=m.items||[];
    if(!items.length){ el("content").innerHTML='<div class="empty">ยังไม่มีทีม — สร้างในหน้า Teams ก่อน</div>'; return; }
    var odd = items.length % 2 === 1;
    var cards = items.map(function(it, i){
      var solo = odd && i === items.length-1; // odd count → last card centered on its own row
      return '<div class="tscard'+(it.isDefault?' last':'')+(solo?' solo':'')+'" data-name="'+esc(it.name)+'">'
        +(it.isDefault?'<span class="tsbadge"><span class="tsdot"></span>ล่าสุด</span>':'')
        +'<span class="tsav" style="background:hsl('+tsHue(it.name)+',62%,54%)">'+esc(String(it.name||'?').slice(0,1).toUpperCase())+'</span>'
        +'<span class="tsname">'+esc(it.name)+'</span>'
        +'<span class="tsmeta"><span class="tsm1">'+(it.memberCount||0)+' members</span>'
        +'<span class="tsm2">orchestrator: '+esc(it.orchestrator||'(none)')+'</span></span>'
        +'</div>';
    }).join('');
    el("content").innerHTML='<div class="tsgrid">'+cards+'</div>';
    el("content").querySelectorAll('.tscard').forEach(function(c){
      c.addEventListener('click',function(){post('pick_team',{name:c.dataset.name});});});
  }
  function renderOrch(m){ disarmAll(); _lastProjKey=null;  // ออกจากหน้า projects → เลิก arm/timer ที่ค้างทั้งหมด (+invalidate skip-guard)
    el("title").textContent=m.title; setSubtitle(m.subtitle, false);
    el("actions").innerHTML=actionsHtml(false, false); wireActions(false);
    el("content").innerHTML=(m.items||[]).map(function(it){
      return '<div class="card" data-name="'+esc(it.name)+'"><button class="pick">'
        +'<span class="cname">'+esc(it.name)+'</span><span class="csub">orchestrator</span></button></div>';
    }).join('');
    el("content").querySelectorAll('.card').forEach(function(c){
      c.addEventListener('click',function(){post('pick_orch',{name:c.dataset.name});});});
  }

  window.addEventListener("message",function(e){
    var m=e.data; if(!m||!m.type) return;
    if(m.type==="screen_projects") renderProjects(m);
    else if(m.type==="screen_archived") renderArchived(m);
    else if(m.type==="screen_teams") renderTeams(m);
    else if(m.type==="screen_orch") renderOrch(m);
    else if(m.type==="screen_detail") renderDetail(m);
    else if(m.type==="doc_html") handleDocHtml(m.rel, m.html, m.error, m.mermaidUri, m.imgSrc);
    else if(m.type==="preview_state") handlePreviewState(m.running);
    else if(m.type==="disarm_all") disarmAll();  // panel ถูกซ่อน/สลับ tab (backend แจ้งมา) → เลิก arm ค้าง
    else if(m.type==="git_auto_result") handleAutoResult(m.path,m.message,m.gen);
    else if(m.type==="open_namemodal") openNameModal(m.default, m.url, m.nameFromUser);
    else if(m.type==="name_result") nmResult(m);
    else if(m.type==="path_copied") flashCopied();
    // ⛔ อัปเดตแค่ข้อความ ห้าม renderDelPhase ตอนรอบ 2: มันล้าง input ที่ user กำลังพิมพ์อยู่
    else if(m.type==="del_unsaved"){
      if(_delPath===m.path){ _delUnsaved=m.text||''; el('dm-hint').textContent=delHint(); }
    }
  });
  post("ready");
</script></body></html>`;
}
