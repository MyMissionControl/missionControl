import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

import * as vscode from "vscode";

import { ApiError, BACKEND_DISABLED, SERVER_URL, api } from "../api";
import { isPortUp, isMawUp } from "../commands/mawServe";
import {
  PROJECT_STATE_KEY,
  getCurrentProjectId,
  onProjectChange,
  setCurrentProjectId,
} from "../projectState";
import {
  defaultTeamFor,
  launchOrchestrator,
  listOrchestratorTeams,
  scanProjects,
  tmuxHasSession,
} from "../commands/startOrchestrator";
import { parseTeamRoster, type OracleTeam } from "../commands/teams";
import { parseOrchesMeta, serializeOrchesMeta, type ResumableProject } from "../commands/orchestratorResume";
import * as gitOps from "../commands/gitOps";
import { parseGitButtonState, type GitButtonState } from "../commands/gitStatus";
import { computeUsage, topProjectsByRange } from "../usage";
import { buildBudgetView } from "./budget";
import { openClaudeView } from "./claudeView";
import {
  forgetSessionTerminal,
  listTmuxSessions,
  registerAttachTerminalCleanup,
  sessionTerminal,
} from "./attachTerminal";
import { liveClaudeToken } from "../commands/accountsOps";
import { fetchClaudeUsage } from "../commands/usage";
import {
  TMUX_WINDOWS_FMT,
  type TmuxSession,
  type TmuxWindow,
  isSafeSessionName,
  isWindowIndex,
  parseTmuxWindows,
  sessionIsIdle,
  killFailureMessage,
  sessionKillGroup,
  parseOraclesJson,
  projectFromPaths,
  loneOracleName,
  teamOfOracle,
  computeSessionLabel,
  teamFromOrchesLabel,
} from "./sessions";
import { listSkills } from "./skills";

type Project = {
  id: string;
  name: string;
  created_at?: string;
  archived_at?: string | null;
};

// Singleton — only one Mission Control dashboard makes sense at a time.
// Cleared on onDidDispose so the next openDashboardPanel call creates a
// fresh one.
let _panel: vscode.WebviewPanel | undefined;
let _unsubProjectChange: (() => void) | undefined;
let _statusPollTimer: NodeJS.Timeout | undefined;

// Sessions panel state. The terminal-reuse map now lives in attachTerminal.ts so
// every native-attach caller shares one registry; _lastSessionNames is the set we
// last showed the webview, used to validate attach requests.
let _lastSessionNames = new Set<string>();
let _termCleanupRegistered = false;

const STATUS_POLL_MS = 10_000;

// Transient state for the in-screen "Start / Continue Orchestrator" wizard
// (project → team → orchestrator). Reset when it closes or launches.
type OrchStep = "project" | "team" | "orch";
let _orch:
  | {
      mode: "new" | "continue";
      step: OrchStep;
      projects?: ResumableProject[];
      project?: ResumableProject;
      team?: OracleTeam;
    }
  | undefined;
// Set when the wizard is launched from the sidebar (dashboard may still be
// booting) — consumed on the webview's "ready" so the screen shows once loaded.
let _pendingOrchMode: "new" | "continue" | undefined;

/**
 * Open (or reveal) the Mission Control dashboard — a full editor-area
 * webview that takes the place of the legacy cramped sidebar buttons.
 *
 * Sidebar is now a slim nav with status + project name + "Open Dashboard"
 * + a few links. The dashboard owns project picker, workflow actions,
 * sprint control, and resources.
 *
 * `projectId` is the active project at open time; the dashboard updates
 * it via `setCurrentProjectId` when the user changes the dropdown, which
 * propagates to api.ts (X-Project-Id header) + ws.ts (subscription).
 */
export function openDashboardPanel(
  context: vscode.ExtensionContext,
  projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.dashboard",
    "Mission Control",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;

  // Belt-and-suspenders: if caller passed null, re-read at this exact moment.
  // Plan note: `if (!projectId) projectId = getCurrentProjectId();`
  const initialPid = projectId ?? getCurrentProjectId();

  // Offline→online self-heal state (bug-audit fix #1). At boot the dashboard
  // auto-opens while the backend is still loading BGE-M3, so /healthz answers
  // before /projects is ready → the project list + budget + skill cards fail
  // and stay stale forever because the 10s poll only refreshed /healthz.
  // We now re-fetch the data cards on the offline→online edge (or while the
  // project list hasn't loaded yet), mirroring sidebar.ts's self-heal.
  let lastOnline = false;
  let projectsLoaded = false;

  // Live cards can go stale from sources the dashboard never sees an event
  // for — budget from sprint spend, skill count from a toggle in the separate
  // Skills panel, memory_share from a curl. Refresh them every poll tick
  // (cheap GETs) so they self-heal within STATUS_POLL_MS (bug-audit #4/#5).
  const refreshLiveCards = async () => {
    await Promise.all([
      pushBudget(panel),
      pushSkillCount(panel),
      pushMemoryShare(panel),
    ]);
  };

  const refreshDataCards = async () => {
    projectsLoaded = await pushProjects(panel);
    await refreshLiveCards();
  };

  const pollTick = async () => {
    await pushSessions(panel); // tmux is local + fast — refresh first, independent of backend
    await pushMaw(panel); // local TCP probe — keeps the "Start/Stop maw ui" row live
    const online = await pushStatus(panel);
    if (online) {
      if (!lastOnline || !projectsLoaded) {
        await refreshDataCards(); // edge: also re-fetch the project list
      } else {
        await refreshLiveCards(); // steady: keep budget/skill/memshare fresh
      }
    }
    lastOnline = online;
  };

  panel.webview.html = renderHtml();

  // Cross-surface project sync — if the sidebar or some other code path
  // changes the project, push the new selection into the dashboard so its
  // dropdown stays in sync without a full /projects re-fetch.
  _unsubProjectChange = onProjectChange((pid) => {
    panel.webview.postMessage({ type: "current_project", current: pid });
  });

  panel.onDidDispose(() => {
    _panel = undefined;
    if (_unsubProjectChange) {
      _unsubProjectChange();
      _unsubProjectChange = undefined;
    }
    if (_statusPollTimer) {
      clearInterval(_statusPollTimer);
      _statusPollTimer = undefined;
    }
  });

  // One global listener: when a session's terminal closes, drop it from the
  // shared reuse map so the next click opens a fresh attached terminal.
  if (!_termCleanupRegistered) {
    _termCleanupRegistered = true;
    registerAttachTerminalCleanup(context);
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready": {
        // Sessions are a fast local tmux read — push them FIRST + independently
        // so they never wait behind (or break on) the backend-dependent status /
        // data-card fetches. That ordering was the "(loading…) hangs" the user hit
        // whenever the maw/oracle backend was down.
        await pushSessions(panel);
        await pushMaw(panel);
        lastOnline = await pushStatus(panel);
        await refreshDataCards();
        // Start the poller (one per panel lifetime). pollTick self-heals the
        // data cards if the backend was still booting when "ready" fired.
        if (!_statusPollTimer) {
          _statusPollTimer = setInterval(() => {
            void pollTick();
          }, STATUS_POLL_MS);
        }
        // Wizard requested from the sidebar before the webview was ready.
        if (_pendingOrchMode) {
          startOrchWizard(panel, _pendingOrchMode);
          _pendingOrchMode = undefined;
        }
        return;
      }
      case "refresh": {
        await pushSessions(panel); // fast local tmux — first, never wait on backend
        const online = await pushStatus(panel);
        lastOnline = online;
        await refreshDataCards();
        return;
      }
      case "attach_session": {
        const name = typeof msg.name === "string" ? msg.name : "";
        // The human display label the row already showed ("<project> / <team>",
        // from @orches_label). Used only for the editor-tab title, never a shell —
        // so the raw name still guards attach/kill below.
        const label = typeof msg.label === "string" ? msg.label : "";
        // Defense in depth: only attach to a name we actually listed, and that
        // passes the shell-safety whitelist.
        if (!isSafeSessionName(name)) return; // never build a shell command from it
        if (!_lastSessionNames.has(name)) {
          // ⛔ เดิม return เงียบ ๆ = แยกไม่ออกจาก "ปุ่มเสีย" (อาการที่ user เจอซ้ำ ๆ)
          //    เกิดได้จริงเมื่อ session ตายระหว่าง poll กับตอนกด → บอกแล้วรีเฟรชแถวให้
          void vscode.window.showWarningMessage(`tmux session '${name}' ไม่อยู่ในรายการแล้ว — รีเฟรชรายการให้แล้ว`);
          await pushSessions(panel);
          return;
        }
        // Optional: which window row was clicked ("1:john claude"). Absent = the whole
        // session (old behaviour). Junk is dropped, never interpolated into the target.
        const win = isWindowIndex(msg.window) ? msg.window : undefined;

        // Honour the Claude-view setting (default = our chat webview). A session
        // the chat can't render falls back to a terminal inside openClaudeView.
        // Tab title = the project (the part before " / <team>" in the label), e.g.
        // "agentskill-marketplace-v9", not the raw pin "tmux: 09-foreman-2".
        const opened = await openClaudeView(context, name, {
          window: win,
          tabTitle: label.split(" / ")[0].trim() || undefined,
        });
        if (!opened) {
          void vscode.window.showWarningMessage(`tmux session '${name}' ปิดไปแล้ว`);
          await pushSessions(panel); // drop the stale row instead of leaving a dead button
        }
        return;
      }
      case "kill_session": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeSessionName(name)) return; // never build a tmux target from it
        // ⛔ เดิม return เงียบ ๆ ทั้งสองเงื่อนไข = แยกไม่ออกจาก "ปุ่มเสีย" (บั๊กคลาสเดียวกับ
        //    attach ที่แก้ไป 2026-08-04 แต่ตกหล่นเส้น kill) — บอกแล้วรีเฟรชแถวให้
        if (!_lastSessionNames.has(name)) {
          void vscode.window.showWarningMessage(
            `tmux session '${name}' ไม่อยู่ในรายการแล้ว — รีเฟรชรายการให้แล้ว`,
          );
          await pushSessions(panel);
          return;
        }
        // กดปิดทีเดียว = เก็บซากให้หมดด้วย (user's call 2026-08-11). ⛔ ต้องอ่านลิสต์
        // **ดิบ** ตรงนี้ — pushSessions กรองซากออกไปแล้ว (sessionIsIdle) ซึ่งเป็นเหตุผล
        // เดียวที่ซากไม่มีปุ่มให้กดปิดตั้งแต่แรก · โชว์รายชื่อทั้งหมดใน modal ก่อนยิง
        const group = sessionKillGroup(name, await listTmuxSessions()).filter(isSafeSessionName);
        const extra = group.slice(1);
        const pick = await vscode.window.showWarningMessage(
          extra.length
            ? `Kill tmux session '${name}'? This closes all its windows.\n\n` +
                `เก็บซากของ oracle เดียวกันให้ด้วย (เหลือ shell เปล่า ปิดจากหน้าจอไม่ได้): ` +
                extra.join(", ")
            : `Kill tmux session '${name}'? This closes all its windows.`,
          { modal: true },
          "Kill",
        );
        if (pick !== "Kill") return;
        const survivors: string[] = [];
        for (const target of group) {
          const stderr = await new Promise<string>((resolve) => {
            // execFile (no shell) — args passed as array, name already whitelisted.
            // "=" = exact-match target: plain names prefix-match, so if this
            // session died while the modal was open tmux would kill a DIFFERENT
            // session sharing the prefix (verified live: -t zz-a killed zz-ab).
            // ⛔ 2s was too tight on a loaded box: execFile's timeout SIGKILLs the
            //    tmux CLIENT, so the kill may never reach the server — and the old
            //    callback swallowed err entirely, leaving the row in place with no
            //    explanation (= the "I pressed ✕ and nothing died" report 08-11).
            cp.execFile("tmux", ["kill-session", "-t", `=${target}`], { timeout: 5000 }, (err, _o, e) =>
              resolve(String(e ?? "") || (err ? err.message : "")),
            );
          });
          // ⛔ ถามว่า "ตายจริงไหม" ไม่ใช่ "คำสั่งคืนค่าอะไร": tmux ตอบ 0 แล้ว session
          //    ยังอยู่ก็เกิดได้ (timeout ตัดกลางทาง / server ไม่ตอบ) → เช็คซ้ำแล้วบอกให้รู้
          if (tmuxHasSession(target)) {
            survivors.push(target);
            void vscode.window.showWarningMessage(killFailureMessage(target, stderr));
            continue; // ตัวถัดไปยังต้องได้โอกาสปิด — อย่าเงียบและอย่าหยุดทั้งชุด
          }
          // Drop any reused attach-terminal for the now-dead session.
          const term = sessionTerminal(target);
          if (term) term.dispose();
          forgetSessionTerminal(target);
        }
        if (!survivors.length && extra.length)
          void vscode.window.showInformationMessage(
            `ปิดแล้ว ${group.length} session: ${group.join(", ")}`,
          );
        await pushSessions(panel); // refresh the list
        return;
      }
      case "expand_session": {
        const name = typeof msg.name === "string" ? msg.name : "";
        // Only list windows for a session we actually showed + whitelisted.
        if (!_lastSessionNames.has(name) || !isSafeSessionName(name)) return;
        const windows = await listTmuxWindows(name);
        panel.webview.postMessage({ type: "session_windows", name, windows });
        return;
      }
      case "run": {
        if (typeof msg.command === "string") {
          void vscode.commands.executeCommand(msg.command);
          if (msg.command === "missioncontrol.mawToggle") {
            // Reflect the new maw state without waiting a whole poll cycle
            // (the server takes a moment to bind/unbind :3456).
            setTimeout(() => void pushMaw(panel), 1500);
          }
        }
        return;
      }
      case "orch_open": {
        startOrchWizard(panel, msg.mode === "continue" ? "continue" : "new");
        return;
      }
      case "orch_pick": {
        handleOrchPick(panel, typeof msg.value === "string" ? msg.value : "");
        return;
      }
      case "orch_back": {
        _orch = undefined;
        panel.webview.postMessage({ type: "orch_close" });
        return;
      }
      case "git_refresh": {
        await refreshOrchProjects(panel, true); // fetch → recompute ahead/behind
        return;
      }
      case "git_auto": {
        // Draft a commit message from the diff (claude -p, read-only). The
        // webview fills its textarea with the result — human reviews + commits.
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        const message = await gitOps.autoCommitMessage(p);
        panel.webview.postMessage({ type: "git_auto_result", path: p, message });
        return;
      }
      case "git_commit": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message) return;
        const r = await gitOps.commitAll(p, message);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Mission Control: commit สำเร็จ — ${p.split("/").pop()}`
            : `Mission Control: commit ล้มเหลว — ${gitOps.gitErrorLine(r) || "(git ไม่ได้บอกสาเหตุ)"}`,
        );
        await refreshOrchProjects(panel);
        return;
      }
      case "git_pull": {
        // parseGitButtonState can return kind "pull", so this screen renders a
        // Pull button — it just had no handler here (and none in the client),
        // i.e. a button that did nothing at all when pressed.
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        const r = await gitOps.pullRepo(p);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Mission Control: pull สำเร็จ — ${p.split("/").pop()}`
            : `Mission Control: pull ล้มเหลว — ${gitOps.gitErrorLine(r) || "(git ไม่ได้บอกสาเหตุ)"}`,
        );
        // a failed pull means origin moved → refresh so the row stops offering
        // the same doomed button (see the same fix in orchestrator.ts)
        await refreshOrchProjects(panel, !r.ok);
        return;
      }
      case "git_push": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        const st = await gitOps.readGitStatus(p);
        const r = await gitOps.pushRepo(p, st.hasUpstream);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Mission Control: push สำเร็จ — ${p.split("/").pop()}`
            : `Mission Control: push ล้มเหลว — ${gitOps.gitErrorLine(r) || "(git ไม่ได้บอกสาเหตุ)"}`,
        );
        await refreshOrchProjects(panel, !r.ok); // rejected push = origin moved → refetch
        return;
      }
      case "git_createpush": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const repoName = typeof msg.repoName === "string" ? msg.repoName.trim() : "";
        const isPrivate = msg.isPrivate !== false; // default private
        if (!p || !repoName) return;
        // External action → confirm before creating a real GitHub repo.
        const pick = await vscode.window.showWarningMessage(
          `สร้าง GitHub repo ${isPrivate ? "(private)" : "(public)"} ชื่อ '${repoName}' จาก ${p
            .split("/")
            .pop()} แล้ว push?`,
          { modal: true },
          "Create & Push",
        );
        if (pick !== "Create & Push") return;
        const r = await gitOps.createAndPush(p, repoName, isPrivate);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Mission Control: สร้าง+push '${repoName}' สำเร็จ`
            : `Mission Control: create/push ล้มเหลว — ${gitOps.gitErrorLine(r) || "(git ไม่ได้บอกสาเหตุ)"}`,
        );
        await refreshOrchProjects(panel);
        return;
      }
      case "close": {
        panel.dispose();
        return;
      }
    }
  });

  // Capture initial pid → push when webview signals "ready".
  // Set the project state so api.ts/ws.ts use it for the first /projects.
  if (initialPid) {
    setCurrentProjectId(initialPid);
  }

  return panel;
}

// ── In-screen "Start / Continue Orchestrator" wizard (host side) ──────────────

/** Open the first wizard screen in an already-ready dashboard webview. */
function startOrchWizard(panel: vscode.WebviewPanel, mode: "new" | "continue") {
  if (mode === "new") {
    _orch = { mode, step: "team" };
    pushOrchTeamScreen(panel);
  } else {
    // the "ทำต่อ" wizard only offers projects with real leftover work — unlike the
    // Projects screen, which is a full inventory.
    const projects = scanProjects({ resumableOnly: true });
    _orch = { mode, step: "project", projects };
    void pushOrchProjectScreen(panel, projects);
  }
}

/** Entry point for the sidebar buttons: reveal/open the dashboard, then start
 *  the wizard — immediately if it was already open, else on its "ready". */
export function requestOrchWizard(
  context: vscode.ExtensionContext,
  mode: "new" | "continue",
) {
  const wasOpen = !!_panel;
  const panel = openDashboardPanel(context);
  if (wasOpen) {
    startOrchWizard(panel, mode);
  } else {
    _pendingOrchMode = mode; // consumed on "ready"
  }
}

// Git state per project for the resume list's action buttons. Computed in
// parallel (a handful of fast local `git` calls each). `fetch` first refreshes
// remotes so ahead/behind is accurate (the ⟳ Refresh button path).
async function computeGitStates(
  projects: ResumableProject[],
  opts: { fetch?: boolean } = {},
): Promise<Record<string, GitButtonState>> {
  const out: Record<string, GitButtonState> = {};
  await Promise.all(
    projects.map(async (p) => {
      if (opts.fetch) await gitOps.fetchRepo(p.path);
      out[p.path] = parseGitButtonState(await gitOps.readGitStatus(p.path));
    }),
  );
  return out;
}

async function pushOrchProjectScreen(
  panel: vscode.WebviewPanel,
  projects: ResumableProject[],
  opts: { fetch?: boolean } = {},
) {
  const states = await computeGitStates(projects, opts);
  const items = projects.map((p) => ({
    value: p.path,
    label: p.name,
    sub:
      `${p.sprintDocs} sprint docs · ${p.openWorktrees} worktree` +
      (p.metaTeam ? ` · ทำล่าสุด: ${p.metaTeam}` : ""),
    git: { path: p.path, ...states[p.path] },
  }));
  panel.webview.postMessage({
    type: "orch_screen",
    screen: "resume", // marks this as the git-enabled project list
    title: "⏮ ทำต่อ — เลือก project ค้าง",
    subtitle: items.length
      ? "เลือก project ที่จะ resume · ปุ่มขวา = git (Commit / Push / Create & Push)"
      : "ไม่พบงานค้าง — ต้องมี docs/*sprint-*.md หรือ worktree agents/* เปิดอยู่",
    items,
  });
}

/** Recompute git states for the current resume list and re-render (after an
 *  action changes state). No-op if the wizard isn't on the project step. */
async function refreshOrchProjects(panel: vscode.WebviewPanel, fetch = false) {
  if (_orch?.step !== "project" || !_orch.projects) return;
  await pushOrchProjectScreen(panel, _orch.projects, { fetch });
}

function pushOrchTeamScreen(panel: vscode.WebviewPanel) {
  const teams = listOrchestratorTeams();
  const def = _orch?.project ? defaultTeamFor(_orch.project, teams) : null;
  const items = teams.map((t) => ({
    value: t.name,
    label: t.name + (t.name === def ? "  ⭐ (ทำล่าสุด)" : ""),
    sub: `${t.members.length} members · orchestrator: ${
      t.orchestrators.join(", ") || "(none)"
    }`,
  }));
  panel.webview.postMessage({
    type: "orch_screen",
    title: (_orch?.mode === "continue" ? "⏮ ทำต่อ" : "▶ เริ่มใหม่") + " — เลือกทีม",
    subtitle: _orch?.project ? `project: ${_orch.project.name}` : "เลือก oracle-team",
    items,
  });
}

function pushOrchOrchestratorScreen(panel: vscode.WebviewPanel, team: OracleTeam) {
  panel.webview.postMessage({
    type: "orch_screen",
    title: `${team.name} — เลือก orchestrator`,
    subtitle: "ทีมนี้มี orchestrator หลายตัว",
    items: team.orchestrators.map((o) => ({ value: o, label: o, sub: "orchestrator" })),
  });
}

function handleOrchPick(panel: vscode.WebviewPanel, value: string) {
  if (!_orch || !value) return;
  if (_orch.step === "project") {
    const p = (_orch.projects ?? []).find((x) => x.path === value);
    if (!p) return;
    _orch.project = p;
    _orch.step = "team";
    pushOrchTeamScreen(panel);
    return;
  }
  if (_orch.step === "team") {
    const team = listOrchestratorTeams().find((t) => t.name === value);
    if (!team) return;
    if (!team.orchestrators.length) {
      vscode.window.showWarningMessage(
        `Mission Control: ทีม '${team.name}' ไม่มี member role:orchestrator — tag ก่อน: ` +
          `maw team oracle-invite <ชื่อ> --team ${team.name} --role orchestrator`,
      );
      return;
    }
    _orch.team = team;
    if (team.orchestrators.length === 1) {
      void doOrchLaunch(panel, team.orchestrators[0]);
    } else {
      _orch.step = "orch";
      pushOrchOrchestratorScreen(panel, team);
    }
    return;
  }
  if (_orch.step === "orch") {
    void doOrchLaunch(panel, value);
  }
}

async function doOrchLaunch(panel: vscode.WebviewPanel, orch: string) {
  if (!_orch?.team) return;
  const team = _orch.team;
  const project = _orch.project;
  const mode: "new" | "resume" = _orch.mode === "continue" ? "resume" : "new";
  const r = await launchOrchestrator({ orch, team, mode, project });
  if (r.cancelled) return; // user backed out of the twin/inject choice — keep the wizard
  _orch = undefined;
  panel.webview.postMessage({ type: "orch_close" });
  if (r.error) {
    vscode.window.showErrorMessage(`Mission Control: ${r.error}`);
    return;
  }
  vscode.window.showInformationMessage(
    mode === "resume"
      ? `Mission Control: resume '${orch}' (team ${team.name}) → project ${project?.name} · อ่าน state เดิม + เสนอ sprint ต่อ`
      : `Mission Control: ปลุก '${orch}' (team ${team.name}) + เริ่ม build ใหม่ (ถาม requirement)`,
  );
}


/** List one session's windows (index/name/active-command) for the Bento
 *  session-row expand. `name` is whitelisted by isSafeSessionName before we get
 *  here; passed as an execFile arg (no shell), so it's injection-safe. Any tmux
 *  error → [] (the row just shows no windows). */
function listTmuxWindows(name: string): Promise<TmuxWindow[]> {
  return new Promise((resolve) => {
    cp.execFile(
      "tmux",
      ["list-windows", "-t", `=${name}`, "-F", TMUX_WINDOWS_FMT],
      { timeout: 700 },
      (err, stdout) => resolve(err ? [] : parseTmuxWindows(stdout.toString())),
    );
  });
}

/** Group every pane's cwd by tmux session (one tmux call) — used by the
 *  session-label cwd-scan fallback so an orchestrator+workers session can be
 *  labelled by the project a worker pane is building. */
function listPanePathsBySession(): Promise<Record<string, string[]>> {
  return new Promise((resolve) => {
    cp.execFile(
      "tmux",
      ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"],
      { timeout: 700 },
      (err, stdout) => {
        const map: Record<string, string[]> = {};
        if (err) return resolve(map);
        for (const line of stdout.toString().split(/\r?\n/)) {
          const i = line.indexOf("\t");
          if (i < 0) continue;
          (map[line.slice(0, i)] ||= []).push(line.slice(i + 1));
        }
        resolve(map);
      },
    );
  });
}

/** Oracle names from ~/.maw/oracles.json (best-effort → []). */
function readKnownOracles(): string[] {
  try {
    return parseOraclesJson(fs.readFileSync(path.join(homedir(), ".maw", "oracles.json"), "utf8"));
  } catch {
    return [];
  }
}

/** All team rosters from every ~/.maw/teams/<name>/oracle-members.json (best-effort → []). */
function readTeamRosters(): OracleTeam[] {
  const dir = path.join(homedir(), ".maw", "teams");
  const out: OracleTeam[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, name, "oracle-members.json"), "utf8");
      const t = parseTeamRoster(name, raw);
      if (t) out.push(t);
    } catch {
      /* team has no oracle-members.json — skip */
    }
  }
  return out;
}

/** team from <project>/.orches-meta.json (best-effort → undefined). */
function readProjectTeam(projectPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(projectPath, ".orches-meta.json"), "utf8");
    return parseOrchesMeta(raw)?.team || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the driving team into `.orches-meta.json` from a LIVE session's
 *  @orches_label, so "which team last drove this" survives after the session is
 *  terminated (terminate only kills tmux — it never writes the marker). Closes
 *  the gap where a fresh build never reached orches-drive's stamp-meta, or a
 *  resume attached to an already-live session and returned before stamping.
 *
 *  Purely additive & idempotent: only fires when the marker has NO team yet, so
 *  it never overwrites a known team and stops writing once recorded. An existing
 *  lastRun is preserved (only the missing team is filled in). Best-effort. */
function backfillProjectTeam(
  projectPath: string,
  projectName: string,
  orchesLabel: string | undefined,
  sessionName: string,
): void {
  if (readProjectTeam(projectPath)) return; // team already recorded — leave it
  const team = teamFromOrchesLabel(orchesLabel, projectName);
  if (!team) return; // the live label carries no team → nothing to recover
  const file = path.join(projectPath, ".orches-meta.json");
  let lastRun = Date.now();
  try {
    const prev = parseOrchesMeta(fs.readFileSync(file, "utf8"));
    if (prev?.lastRun) lastRun = prev.lastRun; // keep the real drive time if present
  } catch {
    /* no prior marker — Date.now() ("last seen driving") is the best we have */
  }
  try {
    fs.writeFileSync(file, serializeOrchesMeta(team, lastRun, sessionName));
  } catch {
    /* marker is best-effort */
  }
}

async function pushSessions(panel: vscode.WebviewPanel): Promise<void> {
  // Idle sessions (a single bare-shell window, no live process) are hidden from
  // the Bento Sessions card — the "N active" chip counts only what's shown, and
  // attach/kill/expand guard on _lastSessionNames = the displayed set.
  const sessions = (await listTmuxSessions()).filter((s) => !sessionIsIdle(s));
  _lastSessionNames = new Set(sessions.map((s) => s.name));
  const panePaths = await listPanePathsBySession();
  const oracles = readKnownOracles();
  const teams = readTeamRosters();
  for (const s of sessions) {
    const paths = panePaths[s.name] ?? (s.cwd ? [s.cwd] : []);
    const proj = projectFromPaths(paths);
    // While the session is alive its @orches_label carries the team; persist it
    // to the durable marker so it outlives a terminate (which never writes it).
    if (proj) backfillProjectTeam(proj.path, proj.name, s.orchesLabel, s.name);
    const lone = proj ? null : loneOracleName(s, oracles);
    s.label = computeSessionLabel({
      orchesLabel: s.orchesLabel,
      project: proj ? { name: proj.name, team: readProjectTeam(proj.path) } : undefined,
      loneOracle: lone ? { oracle: lone, team: teamOfOracle(lone, teams) ?? undefined } : undefined,
      rawName: s.name,
    });
  }
  panel.webview.postMessage({ type: "sessions", sessions });
}

async function pushStatus(panel: vscode.WebviewPanel): Promise<boolean> {
  // frontend-only build — no Mission Control backend. "online" now reflects the
  // local oracle/maw stack: green when maw (:3456) or oracle (:47778) answers.
  // The pollTick self-heal also keys off this, so the live cards refresh once
  // either server comes up.
  const [maw, oracle] = await Promise.all([isPortUp(3456), isPortUp(47778)]);
  const online = maw || oracle;
  panel.webview.postMessage({ type: "status", online });
  return online;
}

/** Push maw-ui up/down so the "Start maw ui" row (Data card) can flip its label
 *  Start↔Stop live. Cheap local TCP probe, independent of the backend. */
async function pushMaw(panel: vscode.WebviewPanel): Promise<void> {
  panel.webview.postMessage({ type: "maw", up: await isMawUp() });
}

/** Returns true when the project list loaded successfully (used by the
 *  offline→online self-heal poll so a boot-time fetch failure recovers). */
async function pushProjects(panel: vscode.WebviewPanel): Promise<boolean> {
  // Frontend-only build: there is no /projects endpoint. Render the offline
  // placeholder ONCE and report "loaded" so the 10s poll settles into
  // refreshLiveCards() instead of re-posting an empty list every tick.
  if (BACKEND_DISABLED) {
    panel.webview.postMessage({
      type: "projects",
      projects: [],
      current: getCurrentProjectId(),
      error: "frontend-only build",
    });
    return true;
  }
  try {
    const resp = await api<{ active_id: string | null; projects: Project[] }>(
      "/projects",
    );
    const list = Array.isArray(resp?.projects) ? resp.projects : [];
    const live = list.filter((p) => !p.archived_at);
    // Self-heal a stale selection: if the active pid was archived/deleted out
    // of band it won't be in `live`, so drop it to null (in-memory). The
    // sidebar poll clears the persisted globalState value — null here just
    // stops the dropdown from highlighting a project that's no longer listed.
    const cur = getCurrentProjectId();
    if (cur && !live.some((p) => p.id === cur)) {
      setCurrentProjectId(null);
    }
    panel.webview.postMessage({
      type: "projects",
      projects: live,
      current: getCurrentProjectId(),
    });
    return true;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err);
    panel.webview.postMessage({
      type: "projects",
      projects: [],
      current: getCurrentProjectId(),
      error: message,
    });
    return false;
  }
}

/** Weekly quota (real) from the Claude usage endpoint, using the LIVE account's
 *  token. Returns null on logged-out / offline / rate-limited so the Budget card
 *  degrades to "$ + top-3, no quota bar". The token never leaves the host. */
async function fetchWeeklyQuota(): Promise<{ usedPct: number; resetsAt: string } | null> {
  try {
    const tok = liveClaudeToken();
    if (!tok) return null;
    const w = (await fetchClaudeUsage(tok.accessToken)).sevenDay;
    if (!w) return null;
    return { usedPct: Math.max(0, Math.min(100, 100 - w.remaining)), resetsAt: w.resetsAt };
  } catch {
    return null;
  }
}

async function pushBudget(panel: vscode.WebviewPanel): Promise<void> {
  try {
    // Everything on the Bento budget card is WEEKLY and real:
    //   • big $ = Claude spend over the last 7 local days (buildBudgetView.last7)
    //   • top 3 projects by last-7-days $ (topProjectsByRange over byProjectHour)
    //   • progress/% = the seven_day usage quota from the Claude usage endpoint
    const u = await computeUsage();
    const view = await buildBudgetView(u);
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 6); // rolling last 7 days incl. today
    const rows = topProjectsByRange(u.byProjectHour, cutoff.getTime(), 3);
    const top1 = rows[0]?.cost ?? 0;
    const top = rows.map((r) => ({
      name: r.name,
      costFmt: "$" + r.cost.toFixed(2),
      frac: top1 > 0 ? r.cost / top1 : 0,
    }));
    const quota = await fetchWeeklyQuota();
    panel.webview.postMessage({
      type: "budget",
      last7Fmt: view.last7Fmt,
      top,
      quota,
      providerNote: view.providerNote,
    });
  } catch {
    panel.webview.postMessage({ type: "budget", last7Fmt: "$0.00", top: [], quota: null, providerNote: "" });
  }
}

/** Push the per-project memory_share flag. The toggle requires an explicit
 *  project selection (the endpoint is /project/{pid}/...) — when no pid is
 *  selected we report hasProject:false so the UI disables the control. */
async function pushMemoryShare(panel: vscode.WebviewPanel): Promise<void> {
  const pid = getCurrentProjectId();
  if (!pid) {
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: false,
      enabled: false,
    });
    return;
  }
  try {
    const r = await api<{ enabled: boolean }>(
      `/project/${encodeURIComponent(pid)}/memory_share`,
    );
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: true,
      enabled: !!r.enabled,
    });
  } catch {
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: false,
      enabled: false,
    });
  }
}

async function pushSkillCount(panel: vscode.WebviewPanel): Promise<void> {
  try {
    // Local: count ~/.claude/skills/*/SKILL.md off disk (same source the Skills
    // panel uses). They're all "active" on disk, so enabled == total.
    const n = listSkills().length;
    panel.webview.postMessage({ type: "skill_count", total: n, enabled: n });
  } catch {
    panel.webview.postMessage({ type: "skill_count", total: 0, enabled: 0 });
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* ── Bento design tokens (from the design handoff). dark = default. ── */
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --titlebar:#0a0e13; --panel:#11171d; --editor:#0f151b; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --good:#3fd39a; --dot:rgba(255,255,255,.028);
    --primaryGrad:linear-gradient(180deg,#33a6cf,#1f7ea3);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --titlebar:#f6f8fa; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --good:#0fa574; --dot:rgba(15,30,45,.035);
    --primaryGrad:linear-gradient(180deg,#13a0c9,#0e88ad);
  }
  :root {
    --pad:20px; --gap:14px; --cardpad:15px; --radius:14px; --secgap:20px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace;
  }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--uifont); font-size: 13.5px; color: var(--txt);
    background: var(--editor);
    background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px;
    display: flex; flex-direction: column; overflow: hidden;
  }
  * { box-sizing: border-box; }

  .topbar { display: flex; justify-content: flex-end; align-items: center; padding: 8px 16px 0; }
  .theme-toggle { position: relative; width: 44px; height: 22px; border-radius: 999px;
    background: var(--card); border: 1px solid var(--border2); cursor: pointer; padding: 0; flex-shrink: 0; }
  .theme-toggle .thumb { position: absolute; top: 1px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--primaryGrad); transition: left .16s; }
  :root[data-theme="light"] .theme-toggle .thumb { left: 2px; }
  :root[data-theme="dark"] .theme-toggle .thumb { left: 23px; }
  .theme-toggle .tt-ico { position: absolute; top: 50%; transform: translateY(-50%); color: var(--faint); display: flex; }
  .theme-toggle .tt-ico svg { width: 11px; height: 11px; }
  .theme-toggle .tt-sun { left: 4px; } .theme-toggle .tt-moon { right: 4px; }

  .stage { flex: 1; display: flex; flex-direction: column; padding: 14px var(--pad) var(--pad); min-height: 0; }

  .mc-header { display: flex; align-items: center; gap: 11px; margin-bottom: var(--secgap); }
  .badge { width: 32px; height: 32px; border-radius: 9px; background: var(--accentSoft);
    border: 1px solid var(--border2); display: flex; align-items: center; justify-content: center;
    color: var(--accent2); flex-shrink: 0; }
  .badge svg { width: 17px; height: 17px; }
  .mc-title { font-size: 19px; font-weight: 700; letter-spacing: -.3px; }
  .spacer { flex: 1; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 5px 11px;
    background: var(--card); border: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .gdot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); box-shadow: 0 0 7px var(--good); }

  .bento { flex: 1; display: grid; grid-template-columns: 1.3fr 1fr 1fr;
    grid-template-rows: auto 1fr; gap: var(--gap); min-height: 0; }
  .cell { min-width: 0; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--cardpad); }
  .cellA { grid-column: 1; grid-row: 1 / 3; display: flex; flex-direction: column; min-height: 0; }
  .cellA #sessionsList { overflow-y: auto; min-height: 0; flex: 1; }
  .cellB { grid-column: 2 / 4; grid-row: 1; }
  .cellC { grid-column: 2; grid-row: 2; }
  .cellD { grid-column: 3; grid-row: 2; }
  @media (max-width: 820px) {
    .bento { grid-template-columns: 1fr; grid-template-rows: none; }
    .cellA, .cellB, .cellC, .cellD { grid-column: 1; grid-row: auto; }
    .cellA #sessionsList { max-height: 300px; }
  }

  .eyebrow { font-family: var(--mono); font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--faint); font-weight: 600; }
  .eyebrow-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
  .mini-btn { background: var(--accentSoft); color: var(--accent2); border: 1px solid var(--border);
    border-radius: 7px; padding: 3px 9px; font-size: 11px; cursor: pointer; font-family: var(--uifont); }
  .mini-btn:hover { border-color: var(--accent); }

  /* Sessions (Cell A) */
  .srow { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; overflow: hidden; transition: border-color .12s; }
  .srow.open { border-color: var(--accent); }
  .srow-head { display: flex; align-items: center; gap: 10px; padding: 9px 11px; cursor: pointer; }
  .srow-head:hover { background: var(--accentSoft); }
  .sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); box-shadow: 0 0 8px var(--accent2); flex-shrink: 0; }
  .sdot.on { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .smeta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  /* ชื่อ = ปุ่มเข้า session (ไม่ใช่แค่ข้อความ) → ต้อง hover ให้เห็นว่ากดได้ · align-self:start
     กันแถบ hover ยืดเต็มความกว้างคอลัมน์ flex */
  .sname { font-size: 12.5px; font-weight: 600; color: var(--txt); cursor: pointer; align-self: flex-start; }
  .sname:hover { text-decoration: underline; text-decoration-color: var(--accent2); }
  .ssub { font-family: var(--mono); font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .skill { flex-shrink: 0; background: transparent; border: none; color: var(--muted); opacity: .4;
    cursor: pointer; font-size: 12px; line-height: 1; padding: 3px 6px; border-radius: 5px; }
  .skill:hover { opacity: 1; background: rgba(248,81,73,.16); color: #f85149; }
  .schev { flex-shrink: 0; display: flex; color: var(--faint); transition: transform .15s; }
  .schev svg { width: 15px; height: 15px; }
  .srow.open .schev { transform: rotate(180deg); }
  .spreview { font-family: var(--mono); font-size: 10.5px; color: var(--faint);
    padding: 0 11px 9px 29px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .spreview:hover { color: var(--muted); }
  .spreview .dol { color: var(--accent2); }
  .swins { display: none; border-top: 1px solid var(--border); padding: 6px 11px 8px 29px; }
  .srow.open .swins { display: block; }
  .swin { font-family: var(--mono); font-size: 10.5px; color: var(--muted); padding: 2px 0; }
  .swin .wchev { color: var(--accent2); margin-right: 6px; }
  /* ⛔ แถวหน้าต่างเคยมี ▸ ให้เห็นแต่ "กดไม่ได้จริง" (ไม่มี handler เลย) = คนกดแล้วนึกว่าแอปค้าง
     คลิกได้แล้ว → ต้องมี cursor+hover บอกด้วย ไม่งั้นก็ยังไม่มีใครรู้ว่ากดได้ */
  .swin[data-win] { cursor: pointer; border-radius: 4px; padding: 2px 4px; margin-left: -4px; }
  .swin[data-win]:hover { color: var(--fg); background: rgba(255,255,255,.06); }
  .swin.empty { color: var(--faint); }
  .sessions-empty { color: var(--faint); font-size: 12px; padding: 6px 2px; }

  /* Budget (Cell B) — weekly */
  .budget { cursor: pointer; }
  .bhead { display: flex; align-items: baseline; gap: 8px; }
  .btitle { font-weight: 700; font-size: 14px; }
  .bcap { font-family: var(--mono); font-size: 11px; color: var(--faint); margin-left: auto; }
  .bamount { font-family: var(--mono); font-size: 26px; font-weight: 600; letter-spacing: -.5px; margin: 10px 0 12px; }
  .bprog { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
  .bprog-fill { height: 100%; width: 0; background: var(--primaryGrad); border-radius: 3px; transition: width .3s; }
  .bcaption { font-family: var(--mono); font-size: 10.5px; color: var(--faint); margin-top: 7px; }
  .bbreak { margin-top: 14px; display: flex; flex-direction: column; gap: 9px; }
  .prow-line { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--muted); }
  .prow .pcost { font-family: var(--mono); }
  .pbar { height: 4px; border-radius: 2px; background: var(--border); margin-top: 5px; overflow: hidden; }
  .pbar-fill { height: 100%; background: var(--accent2); border-radius: 2px; }
  .bempty { font-size: 10.5px; color: var(--faint); }
  .bnote { font-size: 10.5px; color: var(--faint); margin-top: 10px; line-height: 1.5; }

  /* Resources / Data (Cell C / D) */
  .rrow { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left;
    background: transparent; border: none; border-top: 1px solid var(--border); padding: 9px 0;
    cursor: pointer; color: var(--txt); font: inherit; font-family: var(--uifont); }
  .rrow:first-of-type { border-top: none; }
  .rrow:hover .rtitle { color: var(--accent2); }
  .ricon { flex-shrink: 0; color: var(--accent2); display: flex; padding-top: 1px; }
  .ricon svg { width: 15px; height: 15px; }
  .rtext { display: flex; flex-direction: column; min-width: 0; }
  .rtitle { font-size: 12.5px; font-weight: 600; }
  .rdesc { font-size: 10.5px; color: var(--muted); line-height: 1.5; margin-top: 2px; }
  .maw-row.running .ricon, .maw-row.running .rtitle { color: var(--good); }

  /* In-screen Start/Continue Orchestrator wizard (SPA overlay) */
  .orch-screen { display: none; position: fixed; inset: 0; z-index: 50;
    background: var(--vscode-editor-background); flex-direction: column;
    padding: 20px 24px; overflow-y: auto; }
  .orch-topbar { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
  .orch-back { flex-shrink: 0; background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none; border-radius: 5px; padding: 7px 13px; cursor: pointer; font-size: 13px; }
  .orch-back:hover { opacity: 0.85; }
  .orch-heads { min-width: 0; }
  .orch-title { font-size: 17px; font-weight: 700; }
  .orch-subtitle { font-size: 12px; opacity: 0.7; margin-top: 3px; }
  .orch-list { display: flex; flex-direction: column; gap: 8px; max-width: 720px; }
  .orch-item { display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
    text-align: left; width: 100%; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 7px;
    padding: 12px 14px; cursor: pointer; color: var(--vscode-foreground); }
  .orch-item:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.2)); }
  .orch-item .oi-label { font-size: 14px; font-weight: 600; }
  .orch-item .oi-sub { font-size: 11px; opacity: 0.7; }
  .orch-empty { opacity: 0.6; font-size: 12px; padding: 10px; }
</style>
</head>
<body>
  <div class="topbar">
    <button class="theme-toggle" id="themeToggle" title="สลับ light / dark" aria-label="Toggle theme">
      <span class="tt-ico tt-sun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/></svg></span>
      <span class="tt-ico tt-moon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg></span>
      <span class="thumb"></span>
    </button>
  </div>

  <div class="stage">
    <div class="mc-header">
      <span class="badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg></span>
      <span class="mc-title">Mission Control</span>
      <span class="spacer"></span>
      <span class="chip"><span class="gdot"></span><span id="activeCount">0 active</span></span>
      <span class="chip" id="chipBudget" style="display:none"></span>
    </div>

    <div class="bento">
      <div class="cell cellA card">
        <div class="eyebrow-row">
          <span class="eyebrow">Sessions</span>
          <button class="mini-btn" type="button" onclick="run('missioncontrol.orchestratorContinue')">Projects</button>
        </div>
        <div id="sessionsList" class="sessions-empty">(loading…)</div>
      </div>

      <div class="cell cellB card budget" id="budgetCard" title="เปิดหน้า Budget เต็ม">
        <div class="bhead"><span class="btitle">Budget</span><span class="bcap">· last 7 days</span></div>
        <div class="bamount" id="budgetAmount">—</div>
        <div class="bprog" id="budgetProgWrap"><div class="bprog-fill" id="budgetProgFill"></div></div>
        <div class="bcaption" id="budgetCaption"></div>
        <div class="bbreak" id="budgetTop"></div>
        <div class="bnote" id="budgetNote"></div>
      </div>

      <div class="cell cellC card">
        <div class="eyebrow">Resources</div>
        <button class="rrow" type="button" onclick="run('missioncontrol.teams')">
          <span class="ricon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11"/></svg></span>
          <span class="rtext"><span class="rtitle">Team Config</span><span class="rdesc">list/แก้ทีม · เพิ่มทีม · role/model/สี ต่อ oracle</span></span>
        </button>
        <button class="rrow" type="button" onclick="run('missioncontrol.accounts')">
          <span class="ricon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
          <span class="rtext"><span class="rtitle">Accounts</span><span class="rdesc">สลับ subscription login หลาย provider · usage หมดสลับได้</span></span>
        </button>
      </div>

      <div class="cell cellD card">
        <div class="eyebrow">Data</div>
        <button class="rrow" type="button" onclick="run('missioncontrol.dataView')">
          <span class="ricon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></span>
          <span class="rtext"><span class="rtitle">Data View</span><span class="rdesc">สถานะทุกโปรเจกต์จากไฟล์ .md · table / kanban / timeline</span></span>
        </button>
        <button class="rrow maw-row" id="mawRow" type="button" onclick="run('missioncontrol.mawToggle')">
          <span class="ricon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 4l14 8-14 8z"/></svg></span>
          <span class="rtext"><span class="rtitle" id="mawTitle">Start maw ui</span><span class="rdesc">เปิด/ปิด maw ui server (:3456)</span></span>
        </button>
        <button class="rrow" type="button" onclick="run('missioncontrol.openObsidian')">
          <span class="ricon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2 20 9l-8 13L4 9z"/></svg></span>
          <span class="rtext"><span class="rtitle">Open in Obsidian</span><span class="rdesc">vault โปรเจค (อัปเดตให้ก่อนเปิด)</span></span>
        </button>
      </div>
    </div>
  </div>

  <div id="orchScreen" class="orch-screen">
    <div class="orch-topbar">
      <button class="orch-back" type="button" onclick="orchBack()">← back</button>
      <div class="orch-heads">
        <div id="orchTitle" class="orch-title"></div>
        <div id="orchSubtitle" class="orch-subtitle"></div>
      </div>
    </div>
    <div id="orchList" class="orch-list"></div>
  </div>

<script>
  const vscode = acquireVsCodeApi();

  var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  // Theme: manual dark/light override persisted in webview state; when unset,
  // follow the VS Code theme kind (body carries a vscode-light/-dark class).
  function initTheme() {
    var saved = (vscode.getState && vscode.getState()) || {};
    var t = saved.theme;
    if (t !== "light" && t !== "dark") {
      var b = document.body.classList;
      t = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark";
    }
    document.documentElement.dataset.theme = t;
  }
  function toggleTheme() {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    var s = (vscode.getState && vscode.getState()) || {};
    s.theme = next;
    if (vscode.setState) vscode.setState(s);
  }
  initTheme();

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // Which session rows are expanded + their last-known windows. Persisted across
  // the 10s poll re-render so an open row STAYS open (a real toggle) instead of
  // snapping shut every tick — the "closes on a timeout" the list rebuild caused.
  var expandedSessions = new Set();
  var winCache = {};
  function toggleSess(row) {
    var name = row.dataset.name;
    if (row.classList.toggle("open")) {
      expandedSessions.add(name);
      if (winCache[name]) renderWindows(name, winCache[name]); // instant from cache
      vscode.postMessage({ type: "expand_session", name: name }); // + refresh live
    } else {
      expandedSessions.delete(name);
    }
  }
  function renderSessions(sessions) {
    const root = document.getElementById("sessionsList");
    if (!sessions || !sessions.length) {
      root.className = "sessions-empty";
      root.textContent = "(no active sessions)";
      return;
    }
    root.className = "";
    root.innerHTML = sessions.map((s) => {
      var meta = (s.label && s.label !== s.name ? s.name + ' · ' : '') + s.windows + ' win · ' + s.cmd;
      var pathPart = s.cwd ? '  ·  ' + escapeHtml(s.cwd) : '';
      return '<div class="srow" data-name="' + escapeHtml(s.name) + '" data-label="' + escapeHtml(s.label || '') + '">'
        + '<div class="srow-head">'
        +   '<span class="sdot' + (s.attached ? ' on' : '') + '"></span>'
        +   '<span class="smeta"><span class="sname" title="เปิด/เข้าไปดู session นี้">' + escapeHtml(s.label || s.name) + '</span>'
        +     '<span class="ssub">' + escapeHtml(meta) + '</span></span>'
        +   '<button class="skill" title="Kill session" data-kill="' + escapeHtml(s.name) + '">✕</button>'
        +   '<span class="schev">' + CHEVRON + '</span>'
        + '</div>'
        + '<div class="spreview" title="Attach"><span class="dol">$</span> tmux attach -t ' + escapeHtml(s.name) + pathPart + '</div>'
        + '<div class="swins"></div>'
        + '</div>';
    }).join('');
    root.querySelectorAll('.srow').forEach((row) => {
      row.querySelector('.srow-head').addEventListener('click', (e) => {
        if (e.target.closest('.skill')) return; // kill handled separately
        // กดที่ "ชื่อ session" = เข้าไปดูเลย (สิ่งที่คนคาดว่าจะเกิด) · ที่ว่างอื่น/chevron = กาง
        if (e.target.closest('.sname')) {
          vscode.postMessage({ type: 'attach_session', name: row.dataset.name, label: row.dataset.label });
          return;
        }
        toggleSess(row);
      });
      var prev = row.querySelector('.spreview');
      if (prev) prev.addEventListener('click', () => {
        vscode.postMessage({ type: 'attach_session', name: row.dataset.name, label: row.dataset.label });
      });
      var kill = row.querySelector('.skill');
      if (kill) kill.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'kill_session', name: kill.dataset.kill });
      });
    });
    // Re-apply expansion after the poll rebuilds this list, so open rows stay
    // open. Drop names that are no longer live to keep the set from growing.
    var liveNames = new Set(sessions.map((s) => s.name));
    expandedSessions.forEach((name) => { if (!liveNames.has(name)) expandedSessions.delete(name); });
    root.querySelectorAll('.srow').forEach((row) => {
      var name = row.dataset.name;
      if (!expandedSessions.has(name)) return;
      row.classList.add('open');
      if (winCache[name]) renderWindows(name, winCache[name]);
      vscode.postMessage({ type: 'expand_session', name: name }); // keep windows fresh
    });
  }
  // Fill an expanded row with its real tmux windows (from expand_session).
  function renderWindows(name, windows) {
    winCache[name] = windows || [];
    const root = document.getElementById("sessionsList");
    var sel = (window.CSS && CSS.escape) ? CSS.escape(name) : name;
    var row = root && root.querySelector('.srow[data-name="' + sel + '"]');
    if (!row) return;
    var wins = row.querySelector('.swins');
    if (!wins) return;
    wins.dataset.loaded = "1";
    if (!windows || !windows.length) {
      wins.innerHTML = '<div class="swin empty">(no windows)</div>';
      return;
    }
    wins.innerHTML = windows.map((w) =>
      '<div class="swin" data-win="' + w.index + '" title="เปิดหน้าต่างนี้ในเทอร์มินัล">'
      + '<span class="wchev">▸</span>' + escapeHtml(w.index + ':' + w.name + ' ' + w.cmd) + '</div>'
    ).join('');
    // แถวหน้าต่าง = ทางเข้าที่คนคาดว่าจะกดได้ (กด "1:john" แล้วอยากเห็น pane ของ john)
    // ส่ง window ไปด้วย host จะ attach แล้วเลือกหน้าต่างนั้นให้
    wins.querySelectorAll('.swin[data-win]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({
          type: 'attach_session', name: name,
          label: (row.dataset.label || ''), window: Number(el.dataset.win),
        });
      });
    });
  }

  function run(command) { vscode.postMessage({ type: "run", command }); }
  function refresh() { vscode.postMessage({ type: "refresh" }); }
  function orchStart(mode) { vscode.postMessage({ type: "orch_open", mode }); }
  function orchBack() { vscode.postMessage({ type: "orch_back" }); }

  // Inline styles per git button kind (avoids touching the shared <style>).
  var GIT_BTN_STYLE = {
    commit: 'background:#c47f1a;color:#fff;',
    push: 'background:#1f6feb;color:#fff;',
    pull: 'background:#1b9aaa;color:#fff;',
    'create-push': 'background:#238636;color:#fff;',
  };
  function gitCellHtml(g) {
    if (!g || g.kind === 'none') return '';
    if (g.kind === 'uptodate')
      return '<span class="git-uptodate" style="color:#7d8590;font-size:11px;">'
        + escapeHtml(g.label) + '</span>';
    // diverged has no safe auto-action → an info chip, never a button. It used
    // to render as a styleless <button> whose click did nothing at all.
    if (g.kind === 'diverged')
      return '<span class="git-diverged" style="color:#e3a13a;font-size:11px;" '
        + 'title="local + remote ต่างมี commit ใหม่ — reconcile เองใน terminal">'
        + escapeHtml(g.label) + '</span>';
    return '<button class="git-act" type="button" data-kind="' + g.kind + '" style="'
      + (GIT_BTN_STYLE[g.kind] || '') + 'border:none;border-radius:5px;padding:4px 10px;'
      + 'font-size:11px;cursor:pointer;">' + escapeHtml(g.label) + '</button>';
  }
  function gitEditorHtml(g) {
    if (g.kind === 'commit') {
      return '<div class="git-editor" style="display:none;margin-top:6px;">'
        + '<textarea class="git-msg" rows="2" placeholder="commit message…" '
        + 'style="width:100%;box-sizing:border-box;font-size:12px;"></textarea>'
        + '<div style="margin-top:4px;display:flex;gap:6px;">'
        + '<button class="git-auto" type="button">✨ auto</button>'
        + '<button class="git-commit-go" type="button">Commit</button>'
        + '<button class="git-cancel" type="button">ยกเลิก</button>'
        + '</div></div>';
    }
    if (g.kind === 'create-push') {
      // regex-free basename: a /\/+$/ regex inside this template literal would
      // evaluate to //+$/ (the \/ collapses to /), i.e. a line comment that
      // crashes the whole client script — the "dashboard frozen" bug. Split
      // instead: filter(Boolean) drops any trailing-slash empty segment.
      var _seg = String(g.path || '').split('/').filter(Boolean);
      var def = _seg[_seg.length - 1] || '';
      return '<div class="git-editor" style="display:none;margin-top:6px;">'
        + '<input class="git-reponame" value="' + escapeHtml(def) + '" '
        + 'style="width:60%;box-sizing:border-box;font-size:12px;" />'
        + '<label style="font-size:11px;margin-left:8px;">'
        + '<input type="checkbox" class="git-private" checked /> private</label>'
        + '<div style="margin-top:4px;display:flex;gap:6px;">'
        + '<button class="git-create-go" type="button">Create & Push</button>'
        + '<button class="git-cancel" type="button">ยกเลิก</button>'
        + '</div></div>';
    }
    return '';
  }

  function renderOrchScreen(m) {
    const scr = document.getElementById("orchScreen");
    document.getElementById("orchTitle").textContent = m.title || "";
    document.getElementById("orchSubtitle").textContent = m.subtitle || "";
    const list = document.getElementById("orchList");
    const items = m.items || [];
    const isResume = m.screen === "resume";
    const refreshBtn = isResume
      ? '<button class="git-refresh" type="button" style="align-self:flex-start;'
        + 'margin-bottom:8px;font-size:11px;">⟳ Refresh (git fetch)</button>'
      : '';
    if (!items.length) {
      list.innerHTML = refreshBtn + '<div class="orch-empty">(ไม่มีรายการ)</div>';
    } else if (isResume) {
      list.innerHTML = refreshBtn + items.map((it) =>
        '<div class="orch-row" data-path="' + escapeHtml((it.git && it.git.path) || it.value) + '" '
        + 'style="display:flex;flex-direction:column;">'
        + '<div style="display:flex;align-items:center;gap:8px;">'
        + '<button class="orch-item" type="button" data-value="' + escapeHtml(it.value) + '" '
        + 'style="flex:1;">'
        + '<span class="oi-label">' + escapeHtml(it.label) + '</span>'
        + (it.sub ? '<span class="oi-sub">' + escapeHtml(it.sub) + '</span>' : '')
        + '</button>'
        + '<span class="git-cell">' + gitCellHtml(it.git) + '</span>'
        + '</div>'
        + gitEditorHtml(it.git)
        + '</div>'
      ).join('');
    } else {
      list.innerHTML = items.map((it) =>
        '<button class="orch-item" type="button" data-value="' + escapeHtml(it.value) + '">'
        + '<span class="oi-label">' + escapeHtml(it.label) + '</span>'
        + (it.sub ? '<span class="oi-sub">' + escapeHtml(it.sub) + '</span>' : '')
        + '</button>'
      ).join('');
    }
    list.querySelectorAll('.orch-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: "orch_pick", value: btn.dataset.value });
      });
    });
    const rb = list.querySelector('.git-refresh');
    if (rb) rb.addEventListener('click', () => vscode.postMessage({ type: "git_refresh" }));
    wireGitRows(list);
    scr.style.display = "flex";
  }

  function wireGitRows(list) {
    list.querySelectorAll('.orch-row').forEach((row) => {
      const path = row.dataset.path;
      const editor = row.querySelector('.git-editor');
      const act = row.querySelector('.git-act');
      if (act) act.addEventListener('click', (e) => {
        e.stopPropagation();
        const kind = act.dataset.kind;
        if (kind === 'push') { vscode.postMessage({ type: "git_push", path }); return; }
        if (kind === 'pull') { vscode.postMessage({ type: "git_pull", path }); return; }
        if (editor) editor.style.display = editor.style.display === 'none' ? 'block' : 'none';
      });
      if (!editor) return;
      const cancel = editor.querySelector('.git-cancel');
      if (cancel) cancel.addEventListener('click', () => { editor.style.display = 'none'; });
      const auto = editor.querySelector('.git-auto');
      if (auto) auto.addEventListener('click', () => {
        auto.textContent = '✨ …'; auto.disabled = true;
        vscode.postMessage({ type: "git_auto", path });
      });
      const commitGo = editor.querySelector('.git-commit-go');
      if (commitGo) commitGo.addEventListener('click', () => {
        const msg = (editor.querySelector('.git-msg').value || '').trim();
        if (!msg) return;
        vscode.postMessage({ type: "git_commit", path, message: msg });
        editor.style.display = 'none';
      });
      const createGo = editor.querySelector('.git-create-go');
      if (createGo) createGo.addEventListener('click', () => {
        const repoName = (editor.querySelector('.git-reponame').value || '').trim();
        const isPrivate = editor.querySelector('.git-private').checked;
        if (!repoName) return;
        vscode.postMessage({ type: "git_createpush", path, repoName, isPrivate });
        editor.style.display = 'none';
      });
    });
  }

  // claude -p drafted a commit message → drop it into the matching row's box.
  function fillGitAuto(path, message) {
    const list = document.getElementById("orchList");
    const row = list && list.querySelector('.orch-row[data-path="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]');
    if (!row) return;
    const auto = row.querySelector('.git-auto');
    if (auto) { auto.textContent = '✨ auto'; auto.disabled = false; }
    const box = row.querySelector('.git-msg');
    const editor = row.querySelector('.git-editor');
    if (editor) editor.style.display = 'block';
    if (box && message) box.value = message;
  }
  function hideOrchScreen() {
    document.getElementById("orchScreen").style.display = "none";
  }

  // "resets in Nd / Nh" from the quota window's reset ISO timestamp.
  function humanReset(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var diff = t - Date.now();
    if (diff <= 0) return "soon";
    var days = Math.floor(diff / 86400000);
    if (days >= 1) return "in " + days + "d";
    var hrs = Math.floor(diff / 3600000);
    if (hrs >= 1) return "in " + hrs + "h";
    return "in <1h";
  }
  var BAR_COLORS = ["var(--accent2)", "var(--accent)", "var(--faint)"];
  function setBudget(m) {
    var amt = document.getElementById("budgetAmount");
    if (amt) amt.textContent = m.last7Fmt || "$0.00";
    var wrap = document.getElementById("budgetProgWrap");
    var fill = document.getElementById("budgetProgFill");
    var cap = document.getElementById("budgetCaption");
    var chip = document.getElementById("chipBudget");
    if (m.quota) {
      var pct = Math.max(0, Math.min(100, Math.round(m.quota.usedPct)));
      if (wrap) wrap.style.display = "block";
      if (fill) fill.style.width = pct + "%";
      var reset = humanReset(m.quota.resetsAt);
      if (cap) cap.textContent = pct + "% of weekly limit used" + (reset ? " · resets " + reset : "");
      if (chip) { chip.style.display = ""; chip.textContent = pct + "% of weekly limit used"; }
    } else {
      // Logged out / offline / rate-limited — degrade to just the $ + breakdown.
      if (wrap) wrap.style.display = "none";
      if (cap) cap.textContent = "";
      if (chip) chip.style.display = "none";
    }
    var top = document.getElementById("budgetTop");
    if (top) {
      var rows = m.top || [];
      top.innerHTML = rows.length
        ? rows.map((t, i) =>
            '<div class="prow"><div class="prow-line"><span class="pname">' + escapeHtml(t.name) + '</span>'
            + '<span class="pcost">' + escapeHtml(t.costFmt) + '</span></div>'
            + '<div class="pbar"><div class="pbar-fill" style="width:' + Math.round((t.frac || 0) * 100)
            + '%;background:' + BAR_COLORS[i % 3] + '"></div></div></div>'
          ).join('')
        : '<div class="bempty">(no spend in the last 7 days)</div>';
    }
    var note = document.getElementById("budgetNote");
    if (note) note.textContent = m.providerNote || "";
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "status") {
      // The status pill was removed (it read "Stopped" forever with no backend).
      // Guard the elements so the still-firing status poll is a harmless no-op.
      const dot = document.getElementById("dot");
      if (dot) dot.className = "dot " + (m.online ? "on" : "off");
      const st = document.getElementById("statusText");
      if (st) st.textContent = m.online ? "Running" : "Stopped";
    } else if (m.type === "budget") {
      setBudget(m);
    } else if (m.type === "skill_count") {
      const sub = document.getElementById("skillsSub");
      if (sub) sub.textContent = (m.enabled ?? 0) + " active / " + (m.total ?? 0) + " total";
    } else if (m.type === "sessions") {
      const list = m.sessions || [];
      renderSessions(list);
      const ac = document.getElementById("activeCount");
      if (ac) ac.textContent = list.length + " active";
    } else if (m.type === "session_windows") {
      renderWindows(m.name, m.windows || []);
    } else if (m.type === "maw") {
      var mt = document.getElementById("mawTitle");
      if (mt) mt.textContent = m.up ? "Stop maw ui" : "Start maw ui";
      var mr = document.getElementById("mawRow");
      if (mr) mr.classList.toggle("running", !!m.up);
    } else if (m.type === "orch_screen") {
      renderOrchScreen(m);
    } else if (m.type === "orch_close") {
      hideOrchScreen();
    } else if (m.type === "git_auto_result") {
      fillGitAuto(m.path, m.message);
    }
  });

  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("budgetCard").addEventListener("click", () => run("missioncontrol.budgetPanel"));

  // Tell host we're ready for initial data.
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
