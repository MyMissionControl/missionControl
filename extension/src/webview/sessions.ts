// Pure helpers for the dashboard Sessions panel. NO vscode import here so the
// parsing + validation logic can be unit-tested standalone with `bun test`.

import type { OracleTeam } from "../commands/teams";

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  clients: number; // session_attached as a COUNT — 0 = nothing is displaying it
  cmd: string; // active pane's current command (claude / maw / bash …)
  cwd: string; // active pane's current path
  orchesLabel?: string; // tmux user-option @orches_label (authoritative display label)
  windowName?: string; // the session's (only, when windows===1) window name — team-up sessions
  // rename their single window to the bare oracle while the SESSION keeps the team's name.
  label?: string; // computed display label (filled in the extension host, see dashboard.ts)
  canAttach?: boolean; // active pane runs claude → show the attach-file button (host-computed)
}

/** True when a session's ACTIVE pane runs claude — the only case where injecting
 *  a file path lands in a Claude prompt (not a bare shell). Gates the attach-file
 *  button in the dashboard Sessions panel. The path is sent to the session's
 *  active pane, so the button only makes sense when that pane is claude. */
export function sessionCanAttach(cmd: string): boolean {
  return cmd.trim() === "claude";
}

/** True when the Claude Chat webview can actually render this session: its active
 *  pane runs claude, or it is an orches session (which carries @orches_label and
 *  whose claude panes may be behind a non-active window). A session that fails
 *  this — a bare shell, a `maw` window, a dev server — has no transcript to show,
 *  so the chat would open empty; those fall back to a native terminal REGARDLESS
 *  of the view-mode setting. Shared by mirror.ts (which sessions may be chatted)
 *  and claudeView.ts (whether the setting can be honoured for a given session),
 *  so the two definitions cannot drift. */
export function isMirrorableSession(
  s: { name: string; cmd: string; orchesLabel?: string },
  isSafeName: (n: string) => boolean,
): boolean {
  return isSafeName(s.name) && (sessionCanAttach(s.cmd) || !!s.orchesLabel);
}

/** A pane row of the chat's whole-session scan, reduced to what decides whether
 *  it belongs in the grid. */
export interface GridPaneRow {
  orchRole: string; // @orch_role  (stamped by /orches on the orchestrator pane)
  orchMember: string; // @orch_member (stamped by /orches on a worker pane)
  windowActive: boolean; // #{window_active} — this pane's window is the session's current one
  paneActive: boolean; // #{pane_active}  — this pane is its own window's active one
}

/** Which panes the Claude Chat grid shows, for the two session SHAPES it gets:
 *
 *  /orches — one window holding every pane; "open/close worker" moves a pane in
 *    and out of it (break-pane → its own window). The grid is therefore exactly
 *    the ACTIVE window: a closed worker still exists in a window of its own, and
 *    listing it would resurrect panels the user just closed.
 *  maw team up — one WINDOW per member (that is how `maw team up` wakes them), no
 *    open/close concept. Taking the active window would show exactly ONE member of
 *    the team, so the grid is each window's active pane instead.
 *
 *  Shape is read off the /orches stamps rather than guessed from the session name:
 *  a roster (@orch_oracles) or any @orch_role/@orch_member pane means /orches. A
 *  team session carries none of them. Pure — mirror.ts feeds it the scan rows. */
export function pickGridPanes<T extends GridPaneRow>(rows: T[], hasRoster: boolean): T[] {
  const orches =
    hasRoster || rows.some((r) => r.orchRole === "orchestrator" || !!r.orchMember);
  return rows.filter((r) => (orches ? r.windowActive : r.paneActive));
}

// A session counts as IDLE (and is hidden from the dashboard Bento Sessions
// card) when it's a single bare-shell window with no live process. A multi-
// window session, or one whose active pane runs anything other than a shell
// (claude, maw, a dev server, a tail…), is real work and always shown.
const IDLE_SHELLS = new Set(["bash", "zsh", "sh", "fish", ""]);
export function sessionIsIdle(s: Pick<TmuxSession, "cmd" | "windows">): boolean {
  if (s.windows > 1) return false;
  const cmd = s.cmd.trim().replace(/^-/, ""); // strip login-shell leading dash
  return IDLE_SHELLS.has(cmd);
}

// `tmux list-sessions -F` format string. Tab-separated because a tab is far
// less likely than `|`/space to appear inside a session name or path. The
// @orches_label + window_name columns sit BEFORE cwd so cwd stays the
// tab-safe slice tail. #{window_name} is the session's CURRENT window — for a
// single-window session that's unambiguous, which is exactly the case
// loneOracleName needs it for (team-up sessions keep the team as session name
// but rename their one window to the bare oracle).
export const TMUX_FMT =
  "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{@orches_label}\t#{window_name}\t#{pane_current_path}";

/** Parse stdout of `tmux list-sessions -F TMUX_FMT`. Tolerant: blank input or a
 *  "no server running" message yields []; lines without 6 fields are skipped. */
export function parseTmuxSessions(raw: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 6) continue;
    const name = parts[0];
    if (!name) continue;
    out.push({
      name,
      windows: Number.parseInt(parts[1], 10) || 0,
      // session_attached is a COUNT of clients (0, 1, 2, …) — attached when > 0.
      // (=== "1" was wrong: a 2nd client, e.g. dashboard + orchestrator tab, made it "2".)
      attached: !!parts[2] && parts[2] !== "0",
      clients: Number.parseInt(parts[2], 10) || 0,
      cmd: parts[3] ?? "",
      orchesLabel: parts[4] || undefined,
      windowName: parts[5] || undefined,
      cwd: parts.slice(6).join("\t"),
    });
  }
  return out;
}

/** Live client count for `name` out of a fresh `listTmuxSessions()`, or -1 when
 *  the session is not there any more. Exact-name compare on purpose: tmux
 *  prefix-matches targets, which has already killed the wrong session once. */
export function sessionClients(sessions: Pick<TmuxSession, "name" | "clients">[], name: string): number {
  const hit = sessions.find((s) => s.name === name);
  return hit ? hit.clients : -1;
}

/** What a click on a session row should DO. `hasLiveTerminal` = we still hold a
 *  terminal for this session whose shell has not exited; `clients` comes from
 *  sessionClients (-1 = session gone).
 *
 *  ⛔ Why this exists: reuse used to be gated on "the terminal is alive", but a
 *  terminal outlives the `tmux attach` running INSIDE it. Once that attach ends
 *  (detach, prefix-d, session restarted) the tab sits at a bare prompt, and the
 *  old code focused that husk and returned — so the click did nothing, forever.
 *  The right question is whether anything is attached to the session RIGHT NOW. */
export type AttachAction = "focus" | "reattach" | "create" | "gone";
export function pickAttachAction(hasLiveTerminal: boolean, clients: number): AttachAction {
  if (clients < 0) return "gone"; // session died since we listed it — attaching would just error
  if (!hasLiveTerminal) return "create";
  // Something is already displaying it: focus that tab. A 2nd client would make
  // tmux shrink the window to the smaller viewport and flip the status dot.
  return clients > 0 ? "focus" : "reattach";
}

/** ชื่อ "ครอบครัว" ของ session = ชื่อ oracle ที่เหลือหลังตัด prefix ของ pin (`NN-`)
 *  หรือ `claude-` ออก แล้วตัด suffix twin (`-2`, `-3`, …) ทิ้ง. `09-foreman-2`,
 *  `claude-foreman`, `09-foreman` → `foreman` ทั้งหมด. */
function sessionFamily(name: string): string {
  return name
    .replace(/^\d+-/, "")
    .replace(/^claude-/, "")
    .replace(/-\d+$/, "");
}

/** ชุด session ที่ต้องปิดเมื่อกด ✕ ที่แถวหนึ่ง: ตัวที่กด **มาก่อนเสมอ** แล้วต่อด้วย
 *  "ซาก" ของ oracle เดียวกัน — session ที่ยังมีชีวิตใน tmux แต่เหลือ 1 หน้าต่างเป็น
 *  shell เปล่า เพราะ Claude ข้างในตาย (crash/OOM/exit).
 *
 *  ⛔ ทำไมต้องรวบ: Bento **ซ่อน** session แบบนั้น (`sessionIsIdle`) เพื่อให้เลข
 *  "N active" ตรง — ผลข้างเคียงคือมันไม่มีปุ่มให้กดปิด แล้วค้างกินแรมไปเรื่อย ๆ
 *  (user เจอจริง 2026-08-11: กดปิดตัวที่เห็น แต่ twin `09-foreman-2` ยังอยู่).
 *  ⛔ เงื่อนไขความปลอดภัย: ตัวที่ถูกลากมาปิดด้วย **ต้องเป็นซากเท่านั้น** — session
 *  ที่ยังรัน claude หรือมีหลายหน้าต่างคือ "งานจริง" (อาจเป็น sprint ที่กำลังรันอยู่)
 *  ห้ามแตะเด็ดขาด. เรียงตัวที่กดไว้หน้าสุดเพื่อให้เจตนา user ถูกยิงก่อน เผื่อตัวถัดไปค้าง. */
export function sessionKillGroup(
  clicked: string,
  sessions: Pick<TmuxSession, "name" | "cmd" | "windows">[],
): string[] {
  const fam = sessionFamily(clicked);
  const husks = sessions
    .filter((s) => s.name !== clicked && sessionFamily(s.name) === fam && sessionIsIdle(s))
    .map((s) => s.name);
  return [clicked, ...husks];
}

/** ข้อความตอน `tmux kill-session` "สำเร็จ" แต่ session ยังอยู่ (เช็คด้วย has-session
 *  หลังยิง). ⛔ ทำไมต้องมี: เดิม callback ของ execFile ทิ้ง err ทั้งก้อน แล้วรีเฟรช
 *  รายการเฉย ๆ — ถ้า tmux ไม่ทัน/ถูก timeout ตัด session จะรอดมา และ UI ก็แค่โชว์แถวเดิม
 *  ต่อ = แยกไม่ออกจาก "กด ✕ แล้วปุ่มเสีย" (อาการที่ user รายงาน 2026-08-11).
 *  ยุบเป็นบรรทัดเดียว (showWarningMessage โชว์บรรทัดเดียว) + ตัดสั้น และเมื่อ tmux
 *  ไม่พูดอะไรเลยต้องเดาแทนว่า "ไม่ตอบ/หมดเวลา" — ห้ามลงท้ายด้วย ":" เปล่า. */
export function killFailureMessage(name: string, stderr: string): string {
  const why = stderr.replace(/\s+/g, " ").trim().slice(0, 160);
  return (
    `tmux session '${name}' ยังไม่ตาย — kill-session ไม่สำเร็จ: ` +
    (why || "tmux ไม่ตอบ/หมดเวลา (ลองอีกครั้ง หรือ kill จาก terminal เอง)")
  );
}

export interface TmuxWindow {
  index: number;
  name: string;
  cmd: string; // active pane's current command in that window
}

// `tmux list-windows -t <session> -F` format. Tab-separated (same reasoning as
// TMUX_FMT). Powers the dashboard Bento session-row expand.
export const TMUX_WINDOWS_FMT =
  "#{window_index}\t#{window_name}\t#{pane_current_command}";

/** Parse stdout of `tmux list-windows -F TMUX_WINDOWS_FMT`. Tolerant: blank
 *  input yields []; lines missing the index/name pair or with a non-numeric
 *  index are skipped. A window with an empty command keeps cmd="". */
export function parseTmuxWindows(raw: string): TmuxWindow[] {
  const out: TmuxWindow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const index = Number.parseInt(parts[0], 10);
    if (Number.isNaN(index)) continue;
    out.push({ index, name: parts[1], cmd: parts.slice(2).join("\t") });
  }
  return out;
}

/** True when a name is safe to interpolate (single-quoted) into a shell
 *  `tmux attach -t '<name>'`. Whitelist only. */
export function isSafeSessionName(name: string): boolean {
  if (!name || name.length > 200) return false;
  // Whitelist: letters, digits, dot, underscore, hyphen. Anything else (spaces,
  // quotes, control chars, shell metacharacters) is rejected, so the name is
  // safe to single-quote into `tmux attach -t '<name>'`.
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Shell command to attach to a session. Caller MUST validate with
 *  isSafeSessionName first; the name is single-quoted. The `=` prefix forces
 *  an EXACT session-name match — without it tmux falls back to prefix/fnmatch
 *  matching, so if the named session died you could silently attach to (or,
 *  in the kill path, destroy) a different session sharing the prefix.
 *
 *  With `window` given, the target becomes `=<name>:<idx>` so the attach lands on
 *  THAT window (proved live on tmux 3.4: active window flipped 0 -> 2). Anything
 *  that is not a non-negative integer is dropped rather than interpolated — the
 *  index reaches here from a webview message. */
export function buildAttachCommand(name: string, window?: number): string {
  const w = isWindowIndex(window) ? `:${window}` : "";
  return `tmux attach -t '=${name}${w}'`;
}

/** A tmux window index safe to interpolate into a target: non-negative integer,
 *  bounded (tmux never has 10k windows, and a bound keeps a junk message from
 *  building an absurd target string). */
export function isWindowIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10000;
}

/** Oracle names from ~/.maw/oracles.json content. Tolerant: junk → []. */
export function parseOraclesJson(raw: string): string[] {
  try {
    const d = JSON.parse(raw) as { oracles?: unknown };
    if (!Array.isArray(d?.oracles)) return [];
    return d.oracles
      .map((o) => (o as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/** First pane cwd sitting under a `.../projects/<name>` dir → that project's
 *  name + root path. Used to label a session by the project it is building. */
export function projectFromPaths(paths: string[]): { name: string; path: string } | null {
  for (const p of paths) {
    const m = p.match(/^(.*\/projects\/([^/]+))(?:\/|$)/);
    if (m) return { path: m[1], name: m[2] };
  }
  return null;
}

/** A session that is a single woken oracle → that oracle's name. Only when it
 *  has exactly one window. Tries the WINDOW name first (team-up sessions:
 *  session = team name / team-N, the one window is renamed to the bare
 *  oracle), then falls back to the session name (`NN-<oracle>` /
 *  `claude-<oracle>` / bare — the orchestrator-launch convention). */
export function loneOracleName(session: TmuxSession, knownOracles: string[]): string | null {
  if (session.windows !== 1) return null;
  if (session.windowName && knownOracles.includes(session.windowName)) return session.windowName;
  const stem = session.name.replace(/^\d+-/, "").replace(/^claude-/, "");
  return knownOracles.includes(stem) ? stem : null;
}

/** The team an oracle belongs to — first team by name (deterministic). null
 *  when the oracle is in no team. */
export function teamOfOracle(oracle: string, teams: OracleTeam[]): string | null {
  const hit = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .find((t) => t.members.some((m) => m.oracle === oracle));
  return hit ? hit.name : null;
}

/** The dispatchable WORKER oracles for a session (non-orchestrator team members).
 *  Resolves the team from the live `@orches_label` ("<project> / <team>") when
 *  present, else from the orchestrator name encoded in the session name
 *  ("09-foreman"/"claude-foreman" → "foreman") → its team. Empty when no team
 *  resolves. Pure — the caller applies isSafeOracleName. */
export function workersForSession(
  orchesLabel: string | undefined,
  session: string,
  teams: OracleTeam[],
): string[] {
  let team: OracleTeam | undefined;
  const lbl = (orchesLabel || "").trim();
  const sep = lbl.lastIndexOf(" / ");
  if (sep >= 0) {
    const teamName = lbl.slice(sep + 3).trim();
    team = teams.find((t) => t.name === teamName);
  }
  if (!team) {
    // orchestrator name from the session ("09-foreman"→"foreman", twin "…-2"→also try "foreman").
    const stem = session.replace(/^\d+-/, "").replace(/^claude-/, "");
    for (const orch of [stem, stem.replace(/-\d+$/, "")]) {
      const matches = teams.filter((t) => t.orchestrators.includes(orch));
      if (matches.length === 1) { team = matches[0]; break; }
      if (matches.length > 1) return []; // shared orchestrator across teams → don't guess a roster
    }
  }
  if (!team) return [];
  return team.members.filter((m) => m.role !== "orchestrator").map((m) => m.oracle);
}

/** Priority-based display label: orches-label (authoritative) → project →
 *  lone-oracle → raw session name. Separator is " / ". */
export function computeSessionLabel(args: {
  orchesLabel?: string;
  project?: { name: string; team?: string };
  loneOracle?: { oracle: string; team?: string };
  rawName: string;
}): string {
  const lbl = args.orchesLabel?.trim();
  if (lbl) return lbl;
  if (args.project) {
    return args.project.team ? `${args.project.name} / ${args.project.team}` : args.project.name;
  }
  if (args.loneOracle) {
    return args.loneOracle.team ? `${args.loneOracle.team} / ${args.loneOracle.oracle}` : args.loneOracle.oracle;
  }
  return args.rawName;
}

/** True when an @orches_label names this project — exact basename or
 *  "<basename> / <team>". The " / " in the prefix check means "foo" never
 *  matches "foobar". Pure. */
export function labelNamesProject(orchesLabel: string | undefined, basename: string): boolean {
  return !!orchesLabel && (orchesLabel === basename || orchesLabel.startsWith(basename + " / "));
}

/** First live session whose @orches_label names this project. Pure. */
export function sessionForProjectLabel(basename: string, sessions: TmuxSession[]): TmuxSession | null {
  return sessions.find((s) => labelNamesProject(s.orchesLabel, basename)) ?? null;
}

/** The team encoded in an @orches_label of the form "<project> / <team>", or
 *  undefined when the label is bare "<project>", names a different project, or
 *  is absent. Inverse of teams.ts formatOrchesLabel; used to recover the driving
 *  team from a LIVE session so it can be persisted to `.orches-meta.json` before
 *  the session is terminated. Pure. */
export function teamFromOrchesLabel(
  orchesLabel: string | undefined,
  basename: string,
): string | undefined {
  const lbl = orchesLabel?.trim();
  if (!lbl || !basename) return undefined;
  const prefix = basename + " / ";
  if (!lbl.startsWith(prefix)) return undefined;
  return lbl.slice(prefix.length).trim() || undefined;
}

/** A pane in the Mirror grid, as the control-mode bridge reports it (the fields
 *  needed to name + role it — a subset of the bridge's full Pane). */
export interface MirrorPaneInfo {
  orchRole?: string; // tmux user-option @orch_role (set by /orches on the orchestrator pane)
  orchMember?: string; // @orch_member (the worker oracle's name)
  winName?: string; // window name (maw wake launches -n <oracle>)
  cmd?: string; // pane_current_command (last-resort label)
}

/** Role + display label for a grid pane, from the pane user-options /orches
 *  stamps (authoritative — the claude process rewrites pane_title via OSC 2 but
 *  cannot clobber `set-option -p` user-options). Pure/testable.
 *
 *  role:  @orch_role=="orchestrator" → orchestrator; @orch_member set → worker;
 *         otherwise null (a non-orches / not-yet-dispatched pane).
 *  label: worker → the oracle name (@orch_member, else window name); orchestrator
 *         → the oracle from the session name (`NN-<oracle>` / `claude-<oracle>`);
 *         else the window name / current command. */
export function paneRoleAndLabel(
  pane: MirrorPaneInfo,
  session: string,
): { role: "orchestrator" | "worker" | null; label: string } {
  const member = (pane.orchMember || "").trim();
  const role: "orchestrator" | "worker" | null =
    pane.orchRole === "orchestrator" ? "orchestrator" : member ? "worker" : null;
  let label: string;
  if (role === "worker") {
    label = member || (pane.winName || "").trim() || "worker";
  } else if (role === "orchestrator") {
    label = session.replace(/^\d+-/, "").replace(/^claude-/, "").trim() || session;
  } else {
    label = (pane.winName || "").trim() || (pane.cmd || "").trim() || "pane";
  }
  return { role, label };
}
