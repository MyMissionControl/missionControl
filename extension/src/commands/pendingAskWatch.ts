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

import { renderAskPopup } from "../webview/askPopup";
import {
  PANE_LIST_FMT,
  buildAnswerArgs,
  buildKeyArgs,
  isDigitAnswerable,
  isMultiAnswerable,
  parseAskFromPane,
  parsePaneList,
  parseReviewFromPane,
  reviewMatches,
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
/** The box on screen right now, so the poll can close it if the question gets
 *  answered in the pane instead. */
let _open: { key: string; panel: vscode.WebviewPanel } | null = null;
let _timer: ReturnType<typeof setInterval> | undefined;
let _status: vscode.StatusBarItem | undefined;
let _lastHits: PendingHit[] = [];
let _ticking = false;

function enabled(): boolean {
  return vscode.workspace.getConfiguration("missioncontrol").get<boolean>("pendingAsk.enabled", true);
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
  const now = parseAskFromPane(text);
  if (!now) return false;
  return now.options.length === hit.ask.options.length && now.question === hit.ask.question;
}

/** Attach to the pane so the human can answer it there — the multi-select shape,
 *  where a digit only ticks a checkbox. */
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

/** Answer a single-select box — one digit both picks and submits (live-proved 2026-08-07). */
async function answerSingle(hit: PendingHit, key: number): Promise<{ ok: boolean; text: string }> {
  const opt = hit.ask.options.find((o) => o.key === key);
  if (!opt) return { ok: false, text: "ตัวเลือกนี้ไม่อยู่ในกล่องแล้ว" };
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
function showBox(hit: PendingHit): void {
  const panel = vscode.window.createWebviewPanel(
    "mcPendingAsk",
    `${hit.session} รอคำตอบ · ${title(hit.ask)}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
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

function refreshStatus(hits: PendingHit[]): void {
  if (!_status) return;
  if (!hits.length) {
    _status.hide();
    return;
  }
  _status.text = `$(question) ${hits.length} รอตอบ`;
  _status.tooltip = new vscode.MarkdownString(
    hits.map((h) => `**${h.session}** — ${title(h.ask)}`).join("\n\n") + "\n\nคลิกเพื่อเปิดกล่องคำถาม",
  );
  _status.show();
}

async function tick(): Promise<void> {
  if (_ticking) return; // a slow sweep must not stack ticks on top of itself
  if (!enabled()) {
    _lastHits = [];
    refreshStatus([]);
    if (_open) _open.panel.dispose();
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
  refreshStatus(hits);

  if (_open) {
    // Answered in the pane while the box was up → close it rather than leave a
    // dead box whose click would send a keystroke nobody is waiting for.
    if (!hits.some((h) => h.key === _open!.key)) _open.panel.dispose();
    return; // one box at a time
  }
  const next = hits.find((h) => !_seen.has(h.key));
  if (next) showBox(next);
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
    _open.panel.reveal(vscode.ViewColumn.Beside, false);
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
      if (_open) _open.panel.dispose();
      _open = null;
    },
  });
  void tick();
}
