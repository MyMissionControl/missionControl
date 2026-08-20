// The vscode half of "an agent is waiting on you" — see pendingAsk.ts for the
// pure parsing and the receipts behind reading the SCREEN rather than the
// transcript (short version: Claude Code does not write the ask to the
// transcript until it has been answered, so the file is blank on exactly the
// state we care about).
//
// Poll every live Claude pane, and when one is sitting on a choice box, show the
// same box as MC's own popup (webview/askPopup.ts) and send the answer back.
//
// ⛔ It used to be a native QuickPick. Two reasons it is not any more, both the
// user's call: a QuickPick looks nothing like the box they already know from the
// pane, and it can only express "pick one row" — so the MULTI-select shape had
// nowhere to put a Submit and the code degraded to a single "go answer it in the
// pane" row. That is the "ปุ่ม submit หาย" report: there was no Submit to press.
//
// The single-select send is live-proved 2026-08-07 (`send-keys -t %0 2` on a real
// modal both selected and submitted option 2). The multi-select protocol is
// live-proved 2026-08-10 on a throwaway REPL — digits toggle, `Right` opens the
// `✔ Submit` review tab, and its "1. Submit answers" digit submits; see
// answerMulti, which additionally reads the review screen back and refuses to
// send the last keystroke unless it lists exactly what was ticked.
//
// What still cannot be driven from a script is the click itself (under xrdp
// synthetic input does not reliably reach a dev-host window), so the glue between
// "a row was clicked" and "that option's digit is sent" is covered in the pure
// layers instead: pendingAsk.test.ts (protocol + review gate) and
// askPopup.test.ts (every option rendered, Submit always present, HTML escaped).

import * as cp from "node:child_process";

import * as vscode from "vscode";

import { renderAskCard, renderAskPopup } from "../webview/askPopup";
import { getSidebarProvider } from "../webview/sidebar";
import { parseTmuxSessions, sessionClients, TMUX_FMT } from "../webview/sessions";
import { setTabIcon } from "../webview/tabIcon";
import { tabLabel } from "../webview/tabModel";
import {
  PANE_LIST_FMT,
  autoOpenSkipReason,
  nagAllowed,
  buildAnswerArgs,
  buildInModeArgs,
  buildKeyArgs,
  buildUncopyArgs,
  isDigitAnswerable,
  isInMode,
  isMultiAnswerable,
  parseAskFromPane,
  parsePaneList,
  parseReviewFromPane,
  reviewMatches,
  sameAsk,
  scanPending,
  type PaneAsk,
  type PendingHit,
} from "./pendingAsk";

const POLL_MS = 4000; // a blocked human decision is worth a 4s round trip
const CAPTURE_LINES = 60; // enough for the modal + its header; not the scrollback
/** Between two toggle digits — each is its own `send-keys`, so the TUI needs a
 *  frame to repaint before the next one lands. */
const TOGGLE_GAP_MS = 120;
/** `Right` has to repaint the review screen before it can be read back. */
const REVIEW_STEP_MS = 200;
const REVIEW_TRIES = 12;
/** Panes worth capturing. A claude REPL shows up as `claude` or `node`
 *  depending on how it was launched; everything else is a shell or a server. */
const CLAUDE_CMD = /^(claude|node|bun)$/;

/** Boxes already put in front of the user — never nag on every 4s tick. */
const _seen = new Set<string>();
/** เห็นคำถามนี้ครั้งแรกเมื่อไร (epoch ms) — ฐานของการ "เตือนซ้ำเมื่อไม่มีใครตอบนานเกินไป" */
const _firstSeen = new Map<string, number>();
/** เตือนซ้ำไปแล้ว — ครั้งเดียวต่อคำถามต่ออายุ window (ดู nagDue) */
const _nagged = new Set<string>();
/** The box on screen right now, so the poll can close it if the question gets
 *  answered in the pane instead. */
// ⛔ `panel: null` = the box is showing INSIDE the sidebar (no editor group was opened).
//   Every dispose site must therefore go through `closeOpen()`, never `_open.panel.dispose()`
//   directly — a null deref here would kill the watcher tick and the run parks silently.
let _open: { key: string; panel: vscode.WebviewPanel | null } | null = null;

/** Close whatever surface is showing the box (sidebar card or fallback panel). */
function closeOpen(): void {
  if (!_open) return;
  if (_open.panel) _open.panel.dispose();
  else {
    getSidebarProvider()?.clearAsk();
    _open = null;
  }
}
let _timer: ReturnType<typeof setInterval> | undefined;
let _status: vscode.StatusBarItem | undefined;
let _lastHits: PendingHit[] = [];
let _ticking = false;

function enabled(): boolean {
  return vscode.workspace.getConfiguration("missioncontrol").get<boolean>("pendingAsk.enabled", true);
}

/** นานเท่าไรถึงถือว่า "ไม่มีใครตอบ" แล้วต้องพูดขึ้นมาหนึ่งครั้ง · 0 = ปิด */
function nagMs(): number {
  const m = vscode.workspace.getConfiguration("missioncontrol").get<number>("pendingAsk.nagMinutes", 10);
  return Number.isFinite(m) && m > 0 ? m * 60_000 : 0;
}

/** Run a tmux command off the extension-host thread. Resolves to null on any
 *  failure — no tmux server, a pane that died between the list and the read.
 *
 *  ⛔ Never execFileSync here. Measured 2026-08-07 on 5 panes: one sync sweep
 *  blocks 28 ms (8 ms list-panes + 26 ms of captures), i.e. ~2 dropped frames
 *  every POLL_MS, scaling linearly with pane count. Async also lets the captures
 *  run in parallel, so a tick costs the SLOWEST pane instead of their sum. */
function tmux(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    cp.execFile("tmux", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

const capture = (pane: string) => tmux(["capture-pane", "-p", "-t", pane, "-S", `-${CAPTURE_LINES}`]);

/** Every live pane with a choice box open. One `list-panes -a`, then all the
 *  Claude panes captured concurrently. */
async function sweep(): Promise<PendingHit[]> {
  const raw = await tmux(["list-panes", "-a", "-F", PANE_LIST_FMT]);
  if (!raw) return []; // no tmux server = no agents = nothing waiting
  const panes = parsePaneList(raw).filter((p) => CLAUDE_CMD.test(p.cmd));
  if (!panes.length) return [];
  const texts = await Promise.all(panes.map((p) => capture(p.pane)));
  const byPane = new Map(panes.map((p, i) => [p.pane, texts[i]]));
  // scanPending stays pure and synchronous — the IO is already done.
  return scanPending(panes, (p) => byPane.get(p) ?? null);
}

/** Re-read the pane and report whether the SAME box is still up. Guards the
 *  send: if it was answered in the pane meanwhile, a digit would land in the
 *  prompt — or worse, in whatever box came next. */
async function stillUp(hit: PendingHit): Promise<boolean> {
  const text = await capture(hit.pane);
  if (!text) return false;
  // ⛔ Identity is `askKey`, never a looser local rule (see sameAsk). Comparing
  // the question plus the option COUNT let a re-asked box through, and the digit
  // we send is positional — it would land on a different answer.
  return sameAsk(hit.pane, hit.key, parseAskFromPane(text));
}

/** Attach to the pane so the human can answer it there — the multi-select shape,
 *  where a digit only ticks a checkbox.
 *
 *  ⛔ DELIBERATELY IGNORES the claude_view_mode setting and always opens a real
 *  terminal. This is the escape hatch for the one ask shape we cannot answer for
 *  the user, and answering it needs arrows + space + Enter — keys the chat
 *  composer has no way to send (it posts literal text plus a separate Enter).
 *  Routing this through claudeView would hand chat-mode users a panel they
 *  physically cannot answer in, with the run still blocked. */
async function openPane(hit: PendingHit): Promise<void> {
  // Best effort — if focusing fails the human can still navigate once attached.
  await tmux(["select-window", "-t", hit.pane]);
  await tmux(["select-pane", "-t", hit.pane]);
  const term = vscode.window.createTerminal({
    name: `tmux: ${hit.session}`,
    location: vscode.TerminalLocation.Editor,
  });
  term.sendText(`tmux attach -t '=${hit.session}'`);
  term.show(false);
}

function title(ask: PaneAsk): string {
  return ask.header || ask.question || "คำถาม";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the pane until the review screen is up. `Right` has to repaint before the
 *  capture, and a fixed sleep either wastes time or reads a half-drawn frame. */
async function awaitReview(pane: string): Promise<ReturnType<typeof parseReviewFromPane>> {
  for (let i = 0; i < REVIEW_TRIES; i++) {
    await sleep(REVIEW_STEP_MS);
    const text = await capture(pane);
    const r = text ? parseReviewFromPane(text) : null;
    if (r) return r;
  }
  return null;
}

/**
 * Answer a multi-select box end to end.
 *
 * ⛔⛔ The three steps are NOT guessed — they were established on a live REPL
 * (2026-08-10, throwaway tmux session): a digit toggles a checkbox and leaves the
 * cursor where it was; `Right` switches to the box's `✔ Submit` tab, which is a
 * review screen listing the ticked labels plus a numbered "1. Submit answers /
 * 2. Cancel"; that digit submits. Nothing depends on the cursor's position, which
 * is what makes it safe to drive from outside.
 *
 * The review screen is then READ BACK and compared with what the human ticked
 * before the last keystroke goes out — so a dropped digit, or an option that was
 * already ticked before we arrived, aborts instead of submitting a wrong answer.
 */
async function answerMulti(hit: PendingHit, keys: number[]): Promise<{ ok: boolean; text: string }> {
  const chosen = hit.ask.options.filter((o) => keys.includes(o.key));
  if (!chosen.length) return { ok: false, text: "ยังไม่ได้เลือกอะไร" };
  await leaveCopyMode(hit.pane);
  if (!(await stillUp(hit))) return { ok: false, text: "กล่องปิดไปแล้ว — ไม่ได้ส่งอะไร" };

  for (const o of chosen) {
    if ((await tmux(buildAnswerArgs(hit.pane, o.key))) === null) {
      return { ok: false, text: `ส่งไม่สำเร็จตอนติ๊ก "${o.label}"` };
    }
    await sleep(TOGGLE_GAP_MS); // each digit is its own send; give the TUI a frame to repaint
  }
  if ((await tmux(buildKeyArgs(hit.pane, "Right"))) === null) {
    return { ok: false, text: "เปิดหน้า Submit ไม่ได้" };
  }
  const review = await awaitReview(hit.pane);
  if (!review) {
    return { ok: false, text: "ติ๊กแล้วแต่หา หน้า review ไม่เจอ — เปิดเพนไปกด Submit เอง (ของที่ติ๊กยังอยู่)" };
  }
  const labels = chosen.map((o) => o.label);
  if (!reviewMatches(review, labels, hit.ask.options.map((o) => o.label))) {
    return {
      ok: false,
      text: `ยกเลิกการส่ง — หน้า review บอกว่าจะส่ง "${review.answers.join(", ")}" ซึ่งไม่ตรงกับที่เลือก (${labels.join(", ")}) · เปิดเพนไปตรวจเอง`,
    };
  }
  if ((await tmux(buildAnswerArgs(hit.pane, review.submitKey))) === null) {
    return { ok: false, text: "กด Submit ไม่สำเร็จ" };
  }
  return { ok: true, text: `ส่งให้ ${hit.session} แล้ว: ${labels.join(", ")}` };
}

/**
 * Clear tmux copy-mode before any keystroke goes out.
 *
 * ⛔⛔ Live 2026-08-14 (`09-foreman`): the pane was in copy-mode, so every digit
 * this watcher sent was swallowed — `send-keys` still succeeded, the popup
 * reported success, and the agent stayed blocked on its review screen. The pane
 * looked normal, which is why it read as "the run is just slow".
 *
 * Deliberately unconditional-on-failure: a probe that errors is treated as "not
 * in a mode" and we send anyway. Refusing to answer because a probe failed would
 * turn a rare tmux hiccup into the very stall this exists to prevent.
 */
async function leaveCopyMode(pane: string): Promise<void> {
  if (isInMode(await tmux(buildInModeArgs(pane)))) await tmux(buildUncopyArgs(pane));
}

/** Answer a single-select box — one digit both picks and submits (live-proved 2026-08-07). */
async function answerSingle(hit: PendingHit, key: number): Promise<{ ok: boolean; text: string }> {
  const opt = hit.ask.options.find((o) => o.key === key);
  if (!opt) return { ok: false, text: "ตัวเลือกนี้ไม่อยู่ในกล่องแล้ว" };
  await leaveCopyMode(hit.pane);
  if (!(await stillUp(hit))) return { ok: false, text: "กล่องปิดไปแล้ว — ไม่ได้ส่งคำตอบซ้ำ" };
  if ((await tmux(buildAnswerArgs(hit.pane, opt.key))) === null) {
    return { ok: false, text: `ส่งคำตอบไม่สำเร็จ — เพน ${hit.pane}` };
  }
  return { ok: true, text: `ส่งให้ ${hit.session} แล้ว: ${opt.label}` };
}

/**
 * MC's own popup for the box.
 *
 * ⛔ Deliberately NOT a QuickPick (the user rejected it twice): a QuickPick can
 * only say "pick one row", so a multi-select box had nowhere to put a Submit and
 * the old code degraded to a single "go answer it in the pane" row — that missing
 * button is the "ปุ่ม submit หาย" report. A webview renders the same shape the
 * human already knows from the pane, and its Submit is always on screen.
 */
/** Answer a hit from whichever surface reported the click. Shared so the sidebar
 *  and the fallback panel can never drift on what a click does. */
async function applyAnswer(
  hit: PendingHit,
  m: { type?: string; key?: number; keys?: number[] },
): Promise<{ ok: boolean; text: string } | null> {
  if ((m?.type === "answer" || m?.type === "ask_answer") && isDigitAnswerable(hit.ask)) {
    return answerSingle(hit, Number(m.key));
  }
  if ((m?.type === "submit" || m?.type === "ask_submit") && isMultiAnswerable(hit.ask)) {
    return answerMulti(hit, (m.keys ?? []).map(Number));
  }
  return null;
}

/** Render the box INSIDE the Mission Control sidebar. Returns false when there is
 *  no resolved sidebar view to render into, so the caller falls back to a panel.
 *
 *  ⛔⛔ USER 2026-08-17: the asker must not open a new editor group. `ViewColumn.Beside`
 *  did exactly that. VS Code has no floating-overlay API for a webview, so "popup" lands
 *  here — inside the panel MC already owns, revealed but never stealing the editor area. */
function showInSidebar(hit: PendingHit): boolean {
  const sb = getSidebarProvider();
  if (!sb) return false;
  sb.setAskHandler((m) => {
    void (async () => {
      const res = await applyAnswer(hit, m);
      if (!res) return;
      if (res.ok) {
        vscode.window.setStatusBarMessage(res.text, 4000);
        sb.clearAsk();
        _open = null;
        _seen.add(hit.key);
        return;
      }
      // ⛔ ห้ามปิดกล่องตอนล้ม — agent ยังค้างรออยู่ คนต้องเห็นเหตุผลและมีทางไปต่อ
      const go = await vscode.window.showWarningMessage(res.text, "เปิดเพนไปตอบเอง");
      if (go) await openPane(hit);
    })();
  });
  if (!sb.showAsk(renderAskCard({ session: hit.session, pane: hit.pane, ask: hit.ask }), hit.ask.multiSelect)) {
    return false;
  }
  _open = { key: hit.key, panel: null };
  return true;
}

function showBox(hit: PendingHit, opts: { preserveFocus?: boolean } = {}): void {
  if (showInSidebar(hit)) return;
  const panel = vscode.window.createWebviewPanel(
    "mcPendingAsk",
    // WHO is asking goes in the tab (the question itself is right there in the
    // popup) — a tab carrying both ran ~60 characters and pushed every other tab
    // off the bar.
    tabLabel("รอคำตอบ", hit.session, 16),
    // ⛔ การเตือนซ้ำต้องไม่แย่งโฟกัส: มันเด้งตอนคนกำลังพิมพ์อยู่ที่อื่น (นั่นคือเหตุผลที่ต้องเตือน)
    //   กล่องแรกยังแย่งโฟกัสเหมือนเดิม — ตอนนั้นคนเพิ่งถูกถามและควรได้ตอบทันที
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: opts.preserveFocus === true },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  setTabIcon(panel);
  panel.webview.html = renderAskPopup({ session: hit.session, pane: hit.pane, ask: hit.ask });

  panel.webview.onDidReceiveMessage((m: { type?: string; key?: number; keys?: number[] }) => {
    void (async () => {
      let res: { ok: boolean; text: string };
      if (m?.type === "answer" && isDigitAnswerable(hit.ask)) {
        res = await answerSingle(hit, Number(m.key));
      } else if (m?.type === "submit" && isMultiAnswerable(hit.ask)) {
        res = await answerMulti(hit, (m.keys ?? []).map(Number));
      } else {
        return;
      }
      panel.webview.postMessage({ type: "result", ok: res.ok, text: res.text });
      if (res.ok) {
        vscode.window.setStatusBarMessage(res.text, 4000);
        panel.dispose();
        return;
      }
      // ⛔ ห้ามปิดกล่องตอนล้ม — คนต้องเห็นเหตุผลและมีทางไปต่อ (agent ยังค้างรออยู่)
      const go = await vscode.window.showWarningMessage(res.text, "เปิดเพนไปตอบเอง");
      if (go) await openPane(hit);
    })();
  });

  panel.onDidDispose(() => {
    _open = null;
    _seen.add(hit.key); // answered or dismissed — the status bar still shows it is waiting
  });

  _open = { key: hit.key, panel };
}

function refreshStatus(hits: PendingHit[], skipReason = "", warnMin = 0): void {
  if (!_status) return;
  if (!hits.length) {
    _status.hide();
    return;
  }
  // ⭐ รอนานแต่ห้ามเด้ง (มีคน attach) → บอกด้วยสีของแถบสถานะ ไม่ใช่ด้วยตัวถามใบที่สอง
  _status.text = warnMin
    ? `$(question) ${hits.length} รอตอบ ${warnMin} นาที`
    : `$(question) ${hits.length} รอตอบ`;
  _status.backgroundColor = warnMin
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  // ⛔ เหตุผลที่ "ไม่เด้งเอง" ต้องอยู่ในที่ที่คนมองอยู่แล้ว ไม่ใช่ใน log ที่ต้องไปเปิด —
  //   สาเหตุทั้งสามข้อถูกต้องตามดีไซน์ แต่ไม่มีทางรู้จากหน้าจอเลย (ดู autoOpenSkipReason)
  _status.tooltip = new vscode.MarkdownString(
    hits.map((h) => `**${h.session}** — ${title(h.ask)}`).join("\n\n") +
      (skipReason ? `\n\n_ไม่เด้งเอง: ${skipReason}_` : "") +
      "\n\nคลิกเพื่อเปิดกล่องคำถาม",
  );
  _status.show();
}

async function tick(): Promise<void> {
  if (_ticking) return; // a slow sweep must not stack ticks on top of itself
  if (!enabled()) {
    _lastHits = [];
    refreshStatus([]);
    if (_open) closeOpen();
    return;
  }
  _ticking = true;
  let hits: PendingHit[];
  try {
    hits = await sweep();
  } finally {
    _ticking = false;
  }
  _lastHits = hits;

  // ⭐ จับเวลา "รอมานานแค่ไหน" ต่อคำถาม แล้วลืมของที่หายไปแล้ว (กันแมพโตไม่จำกัด)
  const now = Date.now();
  const live = new Set(hits.map((h) => h.key));
  for (const h of hits) if (!_firstSeen.has(h.key)) _firstSeen.set(h.key, now);
  for (const k of [..._firstSeen.keys()]) if (!live.has(k)) _firstSeen.delete(k);
  for (const k of [..._nagged]) if (!live.has(k)) _nagged.delete(k);
  // ⛔⛔ ต้องรู้ว่ามีคน attach หรือยัง **ก่อน** ทุกเส้นตัดสิน ไม่ใช่แค่เส้น auto-open:
  //   nag เดิมเรียก showBox โดยไม่ดู attach เลย ⇒ เด้งตัวถามซ้อนกล่อง native ที่คนกำลังมองอยู่
  //   (user เห็นซ้ำ 2026-08-20 — "ถ้าใช้ native ห้ามขึ้น ตอนนี้มันขึ้นอีกละแค่ย้ายตำแหน่ง")
  const sessions = parseTmuxSessions((await tmux(["list-sessions", "-F", TMUX_FMT])) ?? "");
  const clientsOf = (session: string): number => sessionClients(sessions, session);
  const waitedMs = (h: PendingHit): number => now - (_firstSeen.get(h.key) ?? now);

  const overdue = hits.find((h) =>
    nagAllowed({
      clients: clientsOf(h.session),
      waitedMs: waitedMs(h),
      nagMs: nagMs(),
      alreadyNagged: _nagged.has(h.key),
    }),
  );
  /** เตือนซ้ำหนึ่งครั้ง — เฉพาะเคส "ไม่มีใครดูอยู่" (กล่องเคยปิดไปแล้ว และไม่มีคน attach) */
  const nag = (): void => {
    if (!overdue) return;
    _nagged.add(overdue.key);
    showBox(overdue, { preserveFocus: true });
  };
  /** รอนานเกิน nagMinutes แต่มีคน attach — ห้ามเด้งตัวถาม จึงให้แถบสถานะเปลี่ยนเป็นสีเตือน
   *  แทน: เห็นได้โดยไม่แย่งโฟกัสและไม่สร้างตัวถามใบที่สอง */
  const stalled = hits
    .filter((h) => clientsOf(h.session) > 0 && nagMs() > 0 && waitedMs(h) >= nagMs())
    .sort((a, b) => waitedMs(b) - waitedMs(a))[0];
  const warnMin = stalled ? Math.floor(waitedMs(stalled) / 60000) : 0;

  if (_open) {
    // Answered in the pane while the box was up → close it rather than leave a
    // dead box whose click would send a keystroke nobody is waiting for.
    if (!hits.some((h) => h.key === _open!.key)) closeOpen();
    refreshStatus(hits, autoOpenSkipReason({ openBox: true, unseenHits: 1, clients: 0 }), warnMin);
    return; // one box at a time
  }
  const next = hits.find((h) => !_seen.has(h.key));
  if (!next) {
    refreshStatus(hits, autoOpenSkipReason({ openBox: false, unseenHits: 0, clients: 0 }), warnMin);
    nag();
    return;
  }
  // ⛔⛔ Every hit here is a NATIVE Claude Code box, so if a human is attached to that
  //   tmux session the question is already on their screen with its own key handling —
  //   opening ours on top is the duplicate the user asked us to drop (2026-08-16).
  //   Auto-open is for the headless case only; the status bar and the
  //   `missioncontrol.pendingAsk` command still reach every hit by hand.
  const skip = autoOpenSkipReason({ openBox: false, unseenHits: 1, clients: clientsOf(next.session) });
  refreshStatus(hits, skip, warnMin);
  if (skip) {
    nag();
    return;
  }
  showBox(next);
}

/** Command: re-open the box for whatever is waiting (after an Esc, or from the
 *  status bar). Without this, dismissing once would drop the human back to
 *  having no way to see the question — the exact problem this feature fixes. */
export async function pendingAskCommand(): Promise<void> {
  const hits = await sweep();
  _lastHits = hits;
  refreshStatus(hits);
  if (!hits.length) {
    vscode.window.showInformationMessage("ตอนนี้ไม่มี agent ตัวไหนรอคำตอบอยู่");
    return;
  }
  if (_open) {
    // ⛔ กล่องที่อยู่ใน sidebar ไม่มี panel ให้ reveal — เปิดแผงขึ้นมาแทน (คำสั่ง "ไม่เปิด pane ใหม่")
    if (_open.panel) _open.panel.reveal(vscode.ViewColumn.Beside, false);
    else await vscode.commands.executeCommand("missioncontrol.panel.focus");
    return;
  }
  _seen.delete(hits[0].key);
  showBox(hits[0]);
}

export function initPendingAskWatch(context: vscode.ExtensionContext): void {
  _status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
  _status.command = "missioncontrol.pendingAsk";
  context.subscriptions.push(_status);
  _timer = setInterval(() => void tick(), POLL_MS);
  context.subscriptions.push({
    dispose: () => {
      if (_timer) clearInterval(_timer);
      _timer = undefined;
      if (_open) closeOpen();
      _open = null;
    },
  });
  void tick();
}
