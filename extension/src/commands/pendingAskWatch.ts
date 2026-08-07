// The vscode half of "an agent is waiting on you" — see pendingAsk.ts for the
// pure parsing and the receipts behind reading the SCREEN rather than the
// transcript (short version: Claude Code does not write the ask to the
// transcript until it has been answered, so the file is blank on exactly the
// state we care about).
//
// Poll every live Claude pane, and when one is sitting on a choice box, pop the
// same box as a native QuickPick and send the answer back with one keystroke.
//
// Live-proved 2026-08-07 in an Extension Development Host, verified from a
// screen capture: a tmux pane blocked on AskUserQuestion produced a QuickPick
// titled "<session> รอคำตอบ · <header>", placeholder = the question, one item per
// real option ("1. Monday" + its description as detail, the TUI's own "Type
// something."/"Chat about this" rows correctly absent), and "1 รอตอบ" in the
// status bar. The tmux send is separately proved (`send-keys -t %0 2` on a live
// modal selected AND submitted option 2).
//
// What could NOT be driven from a script is the click itself: under xrdp neither
// synthetic keys nor a synthetic click reliably reach the dev host's overlay, and
// pushing harder risks landing them in the user's real window. So the glue
// between "an item was picked" and "that option's digit is sent" is covered in
// the pure layer instead — itemLabel/findOptionByLabel are a locked round-trip
// (pendingAsk.test.ts R1-R6). If those two ever drift, the box renders and the
// click silently does nothing; that is the failure the tests exist to stop.

import * as cp from "node:child_process";

import * as vscode from "vscode";

import {
  PANE_LIST_FMT,
  buildAnswerArgs,
  findOptionByLabel,
  isDigitAnswerable,
  itemLabel,
  parseAskFromPane,
  parsePaneList,
  scanPending,
  type PaneAsk,
  type PendingHit,
} from "./pendingAsk";

const POLL_MS = 4000; // a blocked human decision is worth a 4s round trip
const CAPTURE_LINES = 60; // enough for the modal + its header; not the scrollback
/** Panes worth capturing. A claude REPL shows up as `claude` or `node`
 *  depending on how it was launched; everything else is a shell or a server. */
const CLAUDE_CMD = /^(claude|node|bun)$/;

/** Boxes already put in front of the user — never nag on every 4s tick. */
const _seen = new Set<string>();
/** The box on screen right now, so the poll can close it if the question gets
 *  answered in the pane instead. */
let _open: { key: string; qp: vscode.QuickPick<vscode.QuickPickItem> } | null = null;
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

function showBox(hit: PendingHit): void {
  const { ask } = hit;
  const answerable = isDigitAnswerable(ask);
  const OPEN_PANE = "$(terminal) เปิดเพนไปตอบเอง";

  const qp = vscode.window.createQuickPick();
  qp.title = `${hit.session} รอคำตอบ · ${title(ask)}`;
  qp.placeholder = ask.question || "เลือกคำตอบ";
  qp.ignoreFocusOut = true; // an agent is blocked on this — a stray click must not lose it
  qp.matchOnDetail = true;

  const items: vscode.QuickPickItem[] = ask.options.map((o) => ({
    label: itemLabel(o),
    detail: o.description || undefined,
  }));
  if (!answerable) {
    // Digits only toggle here. Show what is being asked, never fake a submit.
    items.unshift({ label: OPEN_PANE, detail: "เลือกได้หลายข้อ — ต้องกดในเพนแล้วกด Submit" });
  }
  qp.items = items;

  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    qp.hide();
    if (!picked) return;
    void (async () => {
      if (!answerable || picked.label === OPEN_PANE) {
        await openPane(hit);
        return;
      }
      const opt = findOptionByLabel(ask, picked.label);
      if (!opt) return;
      if (!(await stillUp(hit))) {
        vscode.window.showInformationMessage(`${hit.session}: กล่องปิดไปแล้ว — ไม่ได้ส่งคำตอบซ้ำ`);
        return;
      }
      const sent = await tmux(buildAnswerArgs(hit.pane, opt.key));
      if (sent === null) {
        vscode.window.showErrorMessage(`ส่งคำตอบไม่สำเร็จ — เพน ${hit.pane} ของ ${hit.session}`);
        return;
      }
      vscode.window.setStatusBarMessage(`ส่งให้ ${hit.session}: ${opt.label}`, 4000);
    })();
  });

  qp.onDidHide(() => {
    _open = null;
    _seen.add(hit.key); // answered or dismissed — the status bar still shows it is waiting
    qp.dispose();
  });

  _open = { key: hit.key, qp };
  qp.show();
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
    if (_open) _open.qp.hide();
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
    if (!hits.some((h) => h.key === _open!.key)) _open.qp.hide();
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
    _open.qp.show();
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
      if (_open) _open.qp.dispose();
      _open = null;
    },
  });
  void tick();
}
