import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { listOrchestratorTeams } from "../commands/startOrchestrator";
import { isSafeOracleName, type OracleTeam } from "../commands/teams";
import { droppedFilePath } from "../commands/claudeSessions";
import {
  isSafeSessionName,
  paneRoleAndLabel,
  parseTmuxSessions,
  sessionCanAttach,
  TMUX_FMT,
  workersForSession,
  type TmuxSession,
} from "./sessions";
import { contextFromCsid, transcriptPath } from "./mirrorContext";
import { parseTranscript, type ChatMsg } from "./transcriptChat";

// Mission Control — "Claude Chat" grid. Renders a live /orches tmux session as a
// grid of per-pane CHAT panels (orchestrator + workers), each showing that
// oracle's conversation rendered from its Claude Code transcript (.jsonl) as real
// HTML — so Thai displays perfectly (no terminal grid to garble stacked marks)
// and each panel has ONE composer. Input still goes to the live pane via the
// verified Thai-safe `tmux send-keys -t %<id> -l` path (per pane). No xterm, no
// PTY, no control mode — we only READ transcripts and WRITE keystrokes.

const POLL_MS = 1500; // pane roster + transcript tail
const CTX_EVERY = 4; // ctx recompute every Nth poll (~6s)
const INIT_TAIL_BYTES = 512 * 1024; // cap the initial transcript read
const EMPTY_WARN_POLLS = 20; // ~30s of NO panes → hint that the session isn't up (e.g. launch failed)

interface PaneRec {
  id: string;
  role: "orchestrator" | "worker" | null;
  label: string;
  csid: string;
  win: string; // tmux window_name (used to pass the orchestrator window to wake-worker)
  file: string | null; // transcript path
  offset: number; // bytes consumed
  leftover: Buffer; // partial trailing line, kept as BYTES (decode only at \n
  // boundaries so a multibyte UTF-8/Thai char split across a poll never corrupts)
  positioned: boolean; // has the read cursor been placed for this file (once)
  midFileStart: boolean; // positioned mid-file → drop the first (partial) line once
  seeded: boolean; // has at least one batch been emitted (drives the client `reset`)
}
interface Chat {
  panel: vscode.WebviewPanel;
  session: string;
  panes: Map<string, PaneRec>;
  timer?: NodeJS.Timeout;
  tick: number;
  emptyPolls: number; // consecutive polls with NO panes (session not up yet / ended)
  warnedEmpty: boolean; // have we already surfaced the "session didn't come up" hint
  revealedLive: boolean; // re-revealed the panel once panes went live (see poll)
  workers: string[]; // this session's team worker oracles (dispatchable), resolved once live
  workersResolved: boolean; // have we settled the worker roster (stop re-reading teams from disk)
  workerResolveTries: number; // resolve attempts SINCE panes went live (not global polls)
  lastTeamPost: string; // last {name,visible}[] posted, to avoid redundant "team" messages
  pendingWorkers: Set<string>; // workers with an open/close op in flight (serialize + debounce)
}

const _chats = new Map<string, Chat>();
const isPaneId = (s: unknown): s is string => typeof s === "string" && /^%\d+$/.test(s);

function mirrorableSessions(): TmuxSession[] {
  let raw = "";
  try {
    raw = cp.execFileSync("tmux", ["list-sessions", "-F", TMUX_FMT], { encoding: "utf8" });
  } catch {
    return [];
  }
  return parseTmuxSessions(raw).filter(
    (s) => isSafeSessionName(s.name) && (sessionCanAttach(s.cmd) || !!s.orchesLabel),
  );
}

export async function openMirrorPanel(
  context: vscode.ExtensionContext,
  session?: string,
): Promise<void> {
  let target = session && isSafeSessionName(session) ? session : undefined;
  if (!target) {
    const sessions = mirrorableSessions();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(
        'ไม่พบ Claude/orches session ที่เปิดอยู่ — เริ่มโปรเจคผ่าน /orches หรือ "Open Claude" ก่อน แล้วลองอีกครั้ง',
      );
      return;
    }
    if (sessions.length === 1) {
      target = sessions[0].name;
    } else {
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({ label: s.label || s.name, description: s.name, name: s.name })),
        { placeHolder: "chat session ไหน?" },
      );
      if (!pick) return;
      target = pick.name;
    }
  }

  const existing = _chats.get(target);
  if (existing) {
    existing.panel.reveal();
    return;
  }
  createChat(context, target);
}

// One whole-session (`-s`) list-panes row carries: the pane fields (0-5), whether its
// window is the active/layout one (6), and the session options @orch_oracles (7) +
// @orches_label (8) — session opts resolve INSIDE list-panes -F even on a DETACHED session
// (unlike display-message, which needs the `=session:` colon). So a SINGLE subprocess yields
// grid panes + roster + label + awake set, replacing 4 blocking spawns/tick.
const PANE_ROSTER_FMT = [
  "#{pane_id}", "#{@orch_role}", "#{@orch_member}", "#{@claude_session}",
  "#{window_name}", "#{pane_current_command}",
  "#{window_active}", "#{@orch_oracles}", "#{@orches_label}",
].join("\t");

interface SessionScan {
  panes: Array<{ id: string; role: PaneRec["role"]; label: string; csid: string; win: string }>;
  roster: string[]; // @orch_oracles (valid oracle names); [] if unset
  label: string; // @orches_label
  awake: Set<string>; // roster members with a pane in ANY window (grid OR own detached window)
  any: boolean; // ≥1 pane row → session is up
}

/** ONE `tmux list-panes -s` for the whole session → everything the poll needs. Replaces
 *  enumeratePanes + tmuxOrchOracles + awakeWorkerSet + tmuxOrchesLabel (4 blocking spawns →
 *  1). `active` rows (window_active==1) are the grid; roster/label come off row 0; awake =
 *  a roster member tagged on a pane (@orch_member) OR living in a window named <worker>. */
function scanSession(session: string): SessionScan {
  const scan: SessionScan = { panes: [], roster: [], label: "", awake: new Set(), any: false };
  if (!isSafeSessionName(session)) return scan;
  let raw = "";
  try {
    raw = cp.execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", PANE_ROSTER_FMT], { encoding: "utf8" });
  } catch {
    return scan;
  }
  const rows = raw
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .filter((f) => f.length >= 9 && /^%\d+$/.test(f[0]));
  if (!rows.length) return scan;
  scan.any = true;
  scan.roster = (rows[0][7] || "").split(/\s+/).filter(Boolean).filter(isSafeOracleName);
  scan.label = rows[0][8] || "";
  const inRoster = new Set(scan.roster);
  for (const f of rows) {
    if (f[2] && inRoster.has(f[2])) scan.awake.add(f[2]);
    else if (f[4] && inRoster.has(f[4])) scan.awake.add(f[4]); // worker still in its own window <worker>
    if (f[6] === "1") {
      const { role, label } = paneRoleAndLabel({ orchRole: f[1], orchMember: f[2], winName: f[4], cmd: f[5] }, session);
      scan.panes.push({ id: f[0], role, label, csid: f[3] || "", win: f[4] || "" });
    }
  }
  return scan;
}

function createChat(context: vscode.ExtensionContext, session: string): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.mirror",
    `Claude Chat · ${session}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] },
  );
  const chat: Chat = { panel, session, panes: new Map(), tick: 0, emptyPolls: 0, warnedEmpty: false, revealedLive: false, workers: [], workersResolved: false, workerResolveTries: 0, lastTeamPost: "", pendingWorkers: new Set() };
  _chats.set(session, chat);

  panel.webview.html = renderHtml(panel.webview, mediaRoot, session);

  const post = (m: unknown) => void panel.webview.postMessage(m);

  function poll() {
    // 1) ONE whole-session scan → grid panes + roster + label + awake set (see scanSession)
    const scan = scanSession(session);
    const live = scan.panes;
    const liveIds = new Set(live.map((p) => p.id));
    let rosterChanged = false;
    for (const p of live) {
      let rec = chat.panes.get(p.id);
      if (!rec) {
        rec = { ...p, file: null, offset: 0, leftover: Buffer.alloc(0), positioned: false, midFileStart: false, seeded: false };
        chat.panes.set(p.id, rec);
        rosterChanged = true;
      } else if (rec.role !== p.role || rec.label !== p.label || rec.csid !== p.csid || rec.win !== p.win) {
        rec.role = p.role; rec.label = p.label; rec.win = p.win;
        if (rec.csid !== p.csid) { rec.csid = p.csid; rec.file = null; rec.offset = 0; rec.leftover = Buffer.alloc(0); rec.positioned = false; rec.midFileStart = false; rec.seeded = false; }
        rosterChanged = true;
      }
    }
    for (const id of [...chat.panes.keys()]) if (!liveIds.has(id)) { chat.panes.delete(id); rosterChanged = true; }
    if (rosterChanged) {
      post({
        type: "panes",
        panes: [...chat.panes.values()].map((r) => ({ id: r.id, role: r.role, label: r.label })),
      });
    }

    // 1a) the FIRST time panes go live, re-assert the chat as the front tab. On a
    // fresh launch the orchestrator terminal runs its `tmux …` command on a delay
    // (shell-integration-ready or a 2.5s fallback) and that editor-terminal reveal
    // yanks the just-opened chat to the back — right about when the user starts
    // typing. Panes only appear AFTER that command runs (claude starts then), so
    // this reveal lands last and keeps the chat in front. One-shot.
    if (!chat.revealedLive && chat.panes.size > 0) {
      chat.revealedLive = true;
      try { chat.panel.reveal(undefined, false); } catch { /* panel disposing */ }
    }

    // 1b) if NO panes appear for a while, the session likely never came up (a
    // launch that failed, or the session ended) — surface a hint instead of an
    // eternal "กำลังต่อ session…". Reset once panes exist so it can re-warn later.
    if (chat.panes.size === 0) {
      chat.emptyPolls++;
      if (chat.emptyPolls >= EMPTY_WARN_POLLS && !chat.warnedEmpty) {
        chat.warnedEmpty = true;
        const alive = tmuxHasSessionSafe(session);
        post({
          type: "status",
          text: alive
            ? `session '${session}' มีอยู่ แต่ยังไม่มี pane ที่อ่านได้ — ตรวจว่า orchestrator/worker เปิด Claude แล้วหรือยัง`
            : `ไม่พบ session '${session}' (tmux) — ถ้าเพิ่งกด launch รอสักครู่; ถ้านานแล้ว /orches อาจ launch ไม่ขึ้นหรือ session ปิดไปแล้ว (เช็ค terminal "orchestrator: …")`,
        });
      }
    } else {
      chat.emptyPolls = 0;
      chat.warnedEmpty = false;
    }

    // 1c) team worker roster → tell the webview which team workers are VISIBLE
    // (have a pane) vs. absent, so it can offer "เปิด <worker>" (wake+show) chips
    // and a per-panel "ปิด" (hide) button. Resolve the roster as soon as the SESSION
    // is up — not only once a pane enumerates — so the worker selector appears right
    // away (the roster/@orch_oracles is set at launch, before workers join the grid).
    // The extra has-session probe only fires in the brief pre-pane window (short-circuit).
    // scan.any = ≥1 pane; the has-session probe only fires in the brief pre-pane window.
    const sessionUp = scan.any || tmuxHasSessionSafe(session);
    if (sessionUp) {
      // roster comes from the scan (@orch_oracles, resolved in the same list-panes). Only
      // the disk-based team fallback (a session WITHOUT @orch_oracles) is latched, so a
      // lone-oracle session doesn't hammer the teams dir; give up after a few tries SINCE
      // going live (not global polls — a slow launch must not burn the budget pre-panes).
      let workers = scan.roster;
      if (!workers.length) {
        if (!chat.workersResolved) {
          chat.workerResolveTries++;
          workers = fallbackTeamWorkers(session);
          if (workers.length > 0 || chat.workerResolveTries > 8) chat.workersResolved = true;
        }
        if (!workers.length) workers = chat.workers; // keep the last resolved fallback
      }
      chat.workers = workers;
      // shown = worker has a pane in the ACTIVE layout window (the grid). awake (from the
      // scan) = has a pane ANYWHERE in the session (grid OR its own detached window). shown ⊆ awake.
      const shown = new Set(
        [...chat.panes.values()].filter((r) => r.role === "worker").map((r) => r.label),
      );
      const orchName = [...chat.panes.values()].find((r) => r.role === "orchestrator")?.label || "";
      // old-UI selector format: "<project> / <team>" header, orchestrator name (not
      // clickable), then every worker with its state — click a worker → show its pane.
      const state = chat.workers.map((w) => ({
        name: w,
        shown: shown.has(w),
        awake: scan.awake.has(w) || shown.has(w),
      }));
      const payload = { type: "team", label: scan.label, orch: orchName, workers: state };
      const key = JSON.stringify(payload);
      if (key !== chat.lastTeamPost) { chat.lastTeamPost = key; post(payload); }
    }

    // 2) transcript tail per pane
    for (const rec of chat.panes.values()) tailPane(rec, post);

    // 3) context meters (throttled)
    if (chat.tick % CTX_EVERY === 0) {
      const ctx: Record<string, unknown> = {};
      for (const r of chat.panes.values()) ctx[r.id] = r.csid ? safeCtx(r.csid) : null;
      post({ type: "ctx", ctx });
    }
    chat.tick++;
  }

  chat.timer = setInterval(poll, POLL_MS);
  poll();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready":
        // The synchronous first poll() (on open) races the webview attaching its
        // message listener, so its roster + seed can be dropped. On `ready`, force
        // a full resend: re-seed every pane and post the roster unconditionally.
        for (const r of chat.panes.values()) { r.seeded = false; r.positioned = false; r.midFileStart = false; r.offset = 0; r.leftover = Buffer.alloc(0); }
        chat.lastTeamPost = ""; // re-post the worker roster (wake chips) after a re-attach
        post({ type: "panes", panes: [...chat.panes.values()].map((r) => ({ id: r.id, role: r.role, label: r.label })) });
        chat.tick = 0;
        poll();
        return;
      case "send":
        if (isPaneId(msg.pane) && typeof msg.d === "string") composerSend(msg.pane, msg.d);
        return;
      case "attach":
        if (isPaneId(msg.pane)) await attachViaDialog(msg.pane, post);
        return;
      case "drop":
        if (isPaneId(msg.pane) && typeof msg.name === "string" && typeof msg.data === "string")
          attachDroppedFile(msg.pane, msg.name, msg.data, post);
        return;
      case "compact":
        if (isPaneId(msg.pane)) await forceCompact(msg.pane);
        return;
      case "openWorker":
        if (typeof msg.worker === "string") await openWorker(chat, msg.worker);
        return;
      case "closeWorker":
        if (typeof msg.worker === "string") closeWorker(chat, msg.worker);
        return;
    }
  });

  panel.onDidDispose(() => {
    if (chat.timer) clearInterval(chat.timer);
    _chats.delete(session);
  });
}

/** Read new transcript bytes for a pane and push parsed messages. */
const MAX_READ = 1024 * 1024; // cap per-tick transcript read; backlog drains next tick

function tailPane(rec: PaneRec, post: (m: unknown) => void): void {
  if (!rec.csid || !/^[A-Za-z0-9._-]+$/.test(rec.csid)) return; // guard path traversal via csid
  if (!rec.file) {
    rec.file = transcriptPath(rec.csid);
    if (!rec.file) return; // transcript not created yet
  }
  let size: number;
  try {
    size = fs.statSync(rec.file).size;
  } catch {
    rec.file = null; // transcript vanished (rotated) — re-locate next poll
    return;
  }
  if (!rec.positioned) {
    // Position the read cursor ONCE per file (NOT gated on `seeded` — if the first
    // read has no complete line, seeded stays false and re-running this would reset
    // the cursor and re-read, duplicating via leftover). Start at most the last
    // INIT_TAIL_BYTES; a mid-file start has one leading partial line to drop.
    rec.offset = Math.max(0, size - INIT_TAIL_BYTES);
    rec.midFileStart = rec.offset > 0;
    rec.positioned = true;
  }
  if (size < rec.offset) { // truncated in place → re-seed from the top (client resets)
    rec.offset = 0; rec.leftover = Buffer.alloc(0); rec.seeded = false; rec.midFileStart = false;
  }
  if (size <= rec.offset) return; // nothing new (leftover can't gain a \n without new bytes)
  const start = rec.offset;
  let len = size - start;
  if (len > MAX_READ) len = MAX_READ; // drain a huge burst across ticks (no host jank)
  let buf: Buffer;
  try {
    const fd = fs.openSync(rec.file, "r");
    try {
      buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  rec.offset = start + len;
  // Work in BYTES and decode ONLY complete lines (up to a \n). \n is 0x0a, which
  // never appears inside a multibyte UTF-8 sequence, so decoding at \n boundaries
  // can't split a Thai codepoint even when a poll catches a half-written line.
  const combined = rec.leftover.length ? Buffer.concat([rec.leftover, buf]) : buf;
  const nl = combined.lastIndexOf(0x0a);
  if (nl < 0) { rec.leftover = combined; return; } // no complete line yet — hold the bytes
  rec.leftover = combined.subarray(nl + 1);
  let completeBuf = combined.subarray(0, nl);
  if (rec.midFileStart) {
    // drop the one leading partial line from the tail window, exactly once
    const first = completeBuf.indexOf(0x0a);
    completeBuf = first >= 0 ? completeBuf.subarray(first + 1) : Buffer.alloc(0);
    rec.midFileStart = false;
  }
  const msgs: ChatMsg[] = parseTranscript(completeBuf.toString("utf8"));
  const reset = !rec.seeded;
  rec.seeded = true;
  if (msgs.length || reset) post({ type: "messages", pane: rec.id, reset, msgs });
}

function safeCtx(csid: string) {
  try {
    return contextFromCsid(csid);
  } catch {
    return null;
  }
}

/** Composer submit → deliver byte-exact to a PANE then a SEPARATE Enter (one-call
 *  send-keys swallows the Enter). Multi-line → bracketed paste (one message). */
function composerSend(pane: string, text: string): void {
  if (!isPaneId(pane) || !text) return;
  try {
    if (text.includes("\n")) {
      const wrapped = "\x1b[200~" + text + "\x1b[201~";
      const hex = Buffer.from(wrapped, "utf8").toString("hex").match(/../g) ?? [];
      cp.execFileSync("tmux", ["send-keys", "-t", pane, "-H", ...hex]);
    } else {
      cp.execFileSync("tmux", ["send-keys", "-t", pane, "-l", "--", text]);
    }
    cp.execFileSync("tmux", ["send-keys", "-t", pane, "Enter"]);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`ส่งข้อความเข้า pane ล้มเหลว: ${m}`);
  }
}

/** Clicking the ctx meter forces a `/compact` on that pane (native confirm first —
 *  compacting a live Claude session is consequential and not trivially reversible). */
async function forceCompact(pane: string): Promise<void> {
  if (!isPaneId(pane)) return;
  const yes = await vscode.window.showWarningMessage(
    "บีบอัด context ของ pane นี้เลยไหม? (ส่ง /compact เข้า Claude — ทำแล้วย้อนไม่ได้)",
    { modal: true },
    "บีบอัด",
  );
  if (yes !== "บีบอัด") return;
  // Clear the pane's input line first (Ctrl-U = kill-to-start) so "/compact" is the
  // WHOLE prompt — never appended to leftover typed text (which would make Claude
  // submit a garbled message and silently NOT compact). No-op / harmless if empty.
  try {
    cp.execFileSync("tmux", ["send-keys", "-t", pane, "C-u"]);
  } catch {
    /* best-effort — composerSend below still delivers /compact */
  }
  composerSend(pane, "/compact");
}

/** This session's team worker oracles (dispatchable) — resolved from the live
 *  `@orches_label` ("<project> / <team>") when present, else from the orchestrator
 *  name encoded in the session name ("09-foreman"/"claude-foreman" → "foreman").
 *  ONLY team-defined workers are ever returned, so the open/close buttons can never
 *  target an arbitrary oracle. */
/** Disk-based team-roster fallback — used ONLY when the session has no live
 *  `@orch_oracles` (not init'd by pane-layout / a non-orches session). The hot path
 *  reads `@orch_oracles` directly (cheap, authoritative); this is latched so a
 *  lone-oracle session doesn't re-read teams from disk every poll. */
function fallbackTeamWorkers(session: string): string[] {
  let teams: OracleTeam[];
  try {
    teams = listOrchestratorTeams();
  } catch {
    return [];
  }
  return workersForSession(tmuxOrchesLabel(session), session, teams).filter(isSafeOracleName);
}

/** Read a tmux user-option off a session. Target MUST be `=<session>:` — the trailing
 *  colon (exact session + its active window) is REQUIRED on tmux 3.4: a bare `=<session>`
 *  target makes `display-message` resolve session user-options to EMPTY for a DETACHED
 *  session (verified — same family as the `send-keys -t =session` quirk). The `=` keeps it
 *  exact-match (won't prefix-match a similarly-named session); the `:` restores session
 *  context so `#{@orch_oracles}` / `#{@orches_label}` actually resolve. Without the colon
 *  the worker roster reads empty → no "เปิด" chips, and the Sessions label reads empty. */
function tmuxSessionOpt(session: string, opt: string): string {
  if (!isSafeSessionName(session)) return "";
  try {
    return cp
      .execFileSync("tmux", ["display-message", "-p", "-t", `=${session}:`, `#{${opt}}`], { encoding: "utf8" })
      .trim();
  } catch {
    return "";
  }
}
const tmuxOrchesLabel = (session: string): string => tmuxSessionOpt(session, "@orches_label");

/** Roster workers that are AWAKE = have a live pane ANYWHERE in the session (whole-session
 *  `-s` scan, across ALL windows — the active layout window AND each worker's own detached
 *  window). A woken worker lives in its own window named `<worker>` until pane-layout joins
 *  it into the grid, after which its pane carries `@orch_member=<worker>`; match either. So
 *  the selector can list every awake worker, not just the ones already shown in the grid.
 *  (list-panes takes a bare `=<session>` target fine — unlike display-message.) */
function awakeWorkerSet(session: string, roster: string[]): Set<string> {
  const awake = new Set<string>();
  if (!isSafeSessionName(session) || !roster.length) return awake;
  let raw = "";
  try {
    raw = cp.execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{@orch_member}\t#{window_name}"], { encoding: "utf8" });
  } catch {
    return awake;
  }
  const inRoster = new Set(roster);
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const [member, win] = line.split("\t");
    if (member && inRoster.has(member)) awake.add(member);
    else if (win && inRoster.has(win)) awake.add(win); // worker still in its own window <worker>
  }
  return awake;
}

/** Read-only: does this tmux session exist? (distinguishes "not up yet / died" from
 *  "up but no readable panes" in the empty-state hint). Name-validated. */
function tmuxHasSessionSafe(session: string): boolean {
  if (!isSafeSessionName(session)) return false;
  try {
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const ORCHES_DRIVE = path.join(os.homedir(), ".claude", "skills", "orches-drive");
const INTEGRATE_SH = path.join(ORCHES_DRIVE, "orches-integrate.sh");
const PANE_LAYOUT_SH = path.join(ORCHES_DRIVE, "pane-layout.sh");

/** A worker op is allowed only for a safe session + a TEAM-DEFINED worker + the
 *  pane-layout script present (both ops need it). Defense-in-depth over the script's
 *  own roster guard. */
function workerOpOk(chat: Chat, worker: string): boolean {
  if (!isSafeSessionName(chat.session) || !isSafeOracleName(worker)) return false;
  if (!chat.workers.includes(worker)) return false; // only team-defined workers
  if (!fs.existsSync(PANE_LAYOUT_SH)) {
    vscode.window.showErrorMessage("ไม่พบ pane-layout.sh (orches-drive) — จัดการ worker ไม่ได้");
    return false;
  }
  return true;
}

/** Click a worker chip → bring its pane into the grid. Two paths, decided by an
 *  AUTHORITATIVE live awake re-check (awakeWorkerSet — the SAME scan the poll uses, so it
 *  can't act on a stale webview flag):
 *   - ALREADY AWAKE (woken by the orchestrator or a prior click, in its own window or the
 *     grid) → JUST `pane-layout show` = idempotent join. NO modal, NO re-wake. This SHARES
 *     the existing session/pane; re-waking an awake worker would violate wake-worker's
 *     asleep-only contract and risk a twin. Instant.
 *   - ASLEEP → confirm (spawns a Claude) → `wake-worker` (idempotent, --session pinned) →
 *     `pane-layout show`. Runs ASYNC (wake polls readiness ~30s — never block the host).
 *  In-flight lock prevents double-fire. */
async function openWorker(chat: Chat, worker: string): Promise<void> {
  if (!workerOpOk(chat, worker) || chat.pendingWorkers.has(worker)) return;
  chat.pendingWorkers.add(worker); // lock BEFORE the awake scan / modal so a 2nd click can't double-fire
  const showInGrid = (onErr: string) =>
    cp.execFile("bash", [PANE_LAYOUT_SH, "show", chat.session, worker], { timeout: 20000 }, (e) => {
      chat.pendingWorkers.delete(worker);
      if (e) vscode.window.showErrorMessage(`${onErr}: ${e.message}`);
    });

  // already awake → just show it (share), no confirm, no wake
  if (awakeWorkerSet(chat.session, chat.workers).has(worker)) {
    showInGrid(`แสดง pane '${worker}' ล้มเหลว`);
    return;
  }

  // asleep → confirm + wake + show
  if (!fs.existsSync(INTEGRATE_SH)) {
    chat.pendingWorkers.delete(worker);
    vscode.window.showErrorMessage("ไม่พบ orches-integrate.sh (orches-drive) — ปลุก worker ไม่ได้");
    return;
  }
  const yes = await vscode.window.showInformationMessage(
    `worker '${worker}' ยังหลับอยู่ — ปลุกเข้า session '${chat.session}'? (จะเปิด Claude ตัวใหม่)`,
    { modal: true },
    "ปลุก",
  );
  if (yes !== "ปลุก") { chat.pendingWorkers.delete(worker); return; } // released on cancel
  const win = [...chat.panes.values()].find((r) => r.role === "orchestrator")?.win || "";
  const orchTarget = win ? `=${chat.session}:${win}` : ""; // session-qualified → no cross-session focus theft
  const done = vscode.window.setStatusBarMessage(`กำลังปลุก worker '${worker}'…`);
  cp.execFile("bash", [INTEGRATE_SH, "wake-worker", chat.session, worker, orchTarget], { timeout: 120000 }, (err) => {
    if (err) {
      chat.pendingWorkers.delete(worker);
      done.dispose();
      vscode.window.showErrorMessage(`ปลุก '${worker}' ล้มเหลว: ${err.message}`);
      return;
    }
    // ensure it is shown in the layout grid (idempotent); the next poll picks it up as a worker
    done.dispose();
    showInGrid(`แสดง pane '${worker}' ล้มเหลว`);
  });
}

/** "ปิด" a worker: `pane-layout hide` → break-pane -d. IDEMPOTENT (no-op if already
 *  hidden — a stale button can never re-show it) and NON-DESTRUCTIVE — the worker's
 *  Claude keeps running; it just leaves the grid and reappears as an "เปิด" chip.
 *  We deliberately do NOT kill the pane. In-flight lock prevents double-fire. */
function closeWorker(chat: Chat, worker: string): void {
  if (!workerOpOk(chat, worker) || chat.pendingWorkers.has(worker)) return;
  chat.pendingWorkers.add(worker);
  cp.execFile("bash", [PANE_LAYOUT_SH, "hide", chat.session, worker], { timeout: 20000 }, (e) => {
    chat.pendingWorkers.delete(worker);
    if (e) vscode.window.showErrorMessage(`ซ่อน '${worker}' ล้มเหลว: ${e.message}`);
  });
}

// Attach = insert the picked path(s) into THIS pane's CHAT COMPOSER (webview textarea), not
// straight into the tmux pane input. Chat-first: the user must SEE what got attached, be able
// to attach several (they accumulate in the composer), edit, add a prompt, and send it all in
// one go via the normal composer submit. The old path (send-keys -l directly to the pane) put
// the path in the invisible tmux input line → no feedback, and a 2nd attach was easy to lose.
async function attachViaDialog(pane: string, post: (m: unknown) => void): Promise<void> {
  if (!isPaneId(pane)) return;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "แนบเข้าช่องพิมพ์",
    title: "เลือกไฟล์ใดๆ เพื่อแนบเข้า Claude pane",
    // "ทุกไฟล์" FIRST → it is the dialog's DEFAULT filter, so the picker shows every file
    // type (not just images). Claude Code's Read tool ingests any file (text/code/pdf/image)
    // from the bare path. "รูปภาพ" stays as a convenience narrowing option.
    filters: { ทุกไฟล์: ["*"], รูปภาพ: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
  });
  if (!picked || picked.length === 0) return;
  post({ type: "attachPaths", pane, paths: picked.map((u) => u.fsPath) });
}

function attachDroppedFile(pane: string, name: string, base64: string, post: (m: unknown) => void): void {
  if (!isPaneId(pane)) return;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return;
  }
  if (bytes.length === 0) return;
  const dest = droppedFilePath(os.tmpdir(), Date.now(), name);
  try {
    fs.writeFileSync(dest, bytes);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`บันทึกไฟล์ที่ลากมาล้มเหลว: ${m}`);
    return;
  }
  post({ type: "attachPaths", pane, paths: [dest] });
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, session: string): string {
  const clientJs = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "mirror", "chat.js"));
  const n = nonce();
  const cs = webview.cspSource;
  const csp =
    `default-src 'none'; img-src ${cs} data:; font-src ${cs}; ` +
    `style-src ${cs} 'unsafe-inline'; script-src 'nonce-${n}' ${cs};`;
  const safeSession = session.replace(/[^A-Za-z0-9._-]/g, "");
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: var(--vscode-editor-background);
    color: var(--vscode-foreground); font-family: var(--vscode-font-family); overflow: hidden; }
  #topbar { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 5px 12px;
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
  #topbar .name { font-weight: 600; }
  #topbar .sess { opacity: .7; }
  /* two columns: orchestrator LEFT (full height), workers stacked RIGHT */
  #grid { position: relative; flex: 1 1 auto; min-height: 0; display: flex; gap: 10px; padding: 10px; overflow: auto; }
  #orchCol { flex: 1.25 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  #workerCol { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  #grid.no-workers #workerCol { display: none; }           /* no visible workers → orchestrator takes the full width */
  #wakeBar { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 12px;
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
  #wakeBar:empty { display: none; }
  #wakeBar .wlbl { font-size: 11px; opacity: .6; margin-right: 2px; }
  /* old-UI selector header: "<project> / <team>" then "orchestrator: <name>" (NOT clickable) */
  #wakeBar .wsession { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
  #wakeBar .worch { font-size: 11px; opacity: .7; margin-right: 4px;
    padding: 2px 8px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  #wakeBar .wsep { width: 1px; align-self: stretch; margin: 2px 2px; background: var(--vscode-panel-border); }
  .wchip { border: 1px dashed var(--vscode-panel-border); border-radius: 14px; padding: 3px 11px; cursor: pointer; font-size: 12px;
    background: transparent; color: var(--vscode-foreground); opacity: .85; }
  .wchip:hover { opacity: 1; border-style: solid; background: var(--vscode-toolbar-hoverBackground,#ffffff14); }
  .wchip.on { border-style: solid; border-color: var(--vscode-focusBorder); opacity: 1;
    background: var(--vscode-toolbar-hoverBackground,#ffffff14); }              /* awake + shown in grid */
  .wchip.on::before { content: "● "; color: var(--vscode-charts-green,#4ec94e); }
  .wchip.off { opacity: .5; border-style: dotted; }                            /* asleep — click wakes+shows */
  .panel { flex: 1 1 0; display: flex; flex-direction: column; min-height: 120px; min-width: 0;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden;
    background: var(--vscode-editor-background); }
  .hidew { display: none; }                                 /* shown only on worker panels (see chat.js) */
  .phead { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 5px 10px; font-size: 12px;
    background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .phead .role { text-transform: uppercase; letter-spacing: .04em; opacity: .55; font-size: 10px; }
  .phead .label { font-weight: 600; }
  .phead .ctx { margin-left: auto; display: flex; align-items: center; gap: 5px; opacity: .9;
    cursor: pointer; padding: 2px 6px; border-radius: 6px; border: 1px solid transparent; user-select: none; }
  .phead .ctx:hover { opacity: 1; border-color: var(--vscode-panel-border); background: var(--vscode-toolbar-hoverBackground,#ffffff14); }
  .phead .ctx .lbl { font-size: 10px; letter-spacing: .04em; opacity: .7; }
  .ctxbar { width: 70px; height: 6px; border-radius: 3px; background: var(--vscode-editorWidget-border,#333); overflow: hidden; }
  .ctxfill { height: 100%; width: 0%; background: #3fb950; transition: width .3s, background .3s; }
  .ctxpct { font-variant-numeric: tabular-nums; min-width: 30px; text-align: right; }
  .msgs { flex: 1 1 auto; min-height: 120px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 92%; padding: 7px 11px; border-radius: 10px; font-size: 13px; line-height: 1.5; word-wrap: break-word; overflow-wrap: anywhere; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
  .msg pre { background: var(--vscode-textCodeBlock-background,#0000001a); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
  .msg code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .msg p { margin: 4px 0; } .msg ul,.msg ol { margin: 4px 0; padding-left: 20px; }
  .tool { align-self: flex-start; max-width: 92%; font-size: 12px; }
  .tool summary { cursor: pointer; padding: 4px 9px; border-radius: 8px; background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border); opacity: .85; list-style: none; }
  .tool[data-err="1"] summary { color: #f85149; border-color: #f85149; }
  .tool pre { margin: 4px 0 0; background: var(--vscode-textCodeBlock-background,#0000001a); padding: 8px 10px; border-radius: 6px; overflow: auto; max-height: 300px; font-size: 12px; }
  .think { align-self: flex-start; opacity: .6; font-style: italic; font-size: 12px; }
  .think summary { cursor: pointer; list-style: none; }
  /* AskUserQuestion card — must stand out so the human notices Claude is waiting on them */
  .askcard { border: 1px solid var(--vscode-focusBorder, #e3a13a); border-left: 3px solid var(--vscode-focusBorder, #e3a13a); background: var(--vscode-editorWidget-background); }
  .askhdr { font-weight: 600; color: var(--vscode-focusBorder, #e3a13a); font-size: 12px; margin-bottom: 6px; }
  .askq { margin: 8px 0 2px; }
  .askqh { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
  .askqt { font-weight: 600; margin: 2px 0; }
  .askopts { margin: 4px 0 0; padding-left: 22px; }
  .askopts li { margin: 3px 0; }
  .askdesc { opacity: .75; }
  .composer { flex: 0 0 auto; display: flex; gap: 6px; align-items: flex-end; padding: 6px 10px;
    background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-panel-border); }
  .composer textarea { flex: 1; resize: none; min-height: 32px; max-height: 30vh; padding: 6px 9px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 8px;
    font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.4; }
  .composer textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .btn { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
  .clip { display: inline-flex; align-items: center; justify-content: center; padding: 6px; line-height: 0; }
  .clip svg { display: block; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    opacity: .55; font-size: 13px; text-align: center; padding: 24px; pointer-events: none; }
</style></head><body>
  <div id="topbar"><span class="name">Claude Chat</span><span class="sess">${safeSession}</span></div>
  <div id="wakeBar"></div>
  <div id="grid">
    <div id="empty">กำลังต่อ session…</div>
    <div id="orchCol"></div>
    <div id="workerCol"></div>
  </div>
  <template id="panelTpl">
    <div class="panel">
      <div class="phead">
        <span class="role"></span><span class="label"></span>
        <span class="ctx" role="button" tabindex="0" title="context window — คลิกเพื่อบีบอัด (/compact)"><span class="lbl">ctx</span> <span class="ctxbar"><span class="ctxfill"></span></span><span class="ctxpct">—</span></span>
        <button class="btn hidew" title="ซ่อน worker นี้ออกจาก grid (ยังทำงานต่อ)">ปิด</button>
      </div>
      <div class="msgs"></div>
      <div class="composer">
        <button class="btn clip" title="แนบไฟล์" aria-label="แนบไฟล์"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <textarea rows="1" placeholder="พิมพ์ถึง oracle นี้ (Enter=ส่ง, Shift+Enter=ขึ้นบรรทัด)"></textarea>
        <button class="btn send">Send</button>
      </div>
    </div>
  </template>
<script nonce="${n}" src="${clientJs}"></script>
</body></html>`;
}
