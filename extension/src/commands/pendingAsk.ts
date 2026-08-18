// Surface an agent's choice box to the human who is NOT looking at the pane.
//
// Every agent in an orches run is a Claude REPL in a tmux pane. When one calls
// AskUserQuestion it renders a numbered choice box INSIDE that pane and blocks.
// Nothing in VS Code said so — the dashboard has no per-pane state, no badge, no
// notification — so a run could sit stalled for as long as it took somebody to
// attach and look.
//
// ⛔ WHY THE SCREEN AND NOT THE TRANSCRIPT — measured, do not "improve" this back:
// the obvious source is ~/.claude/projects/<enc>/<id>.jsonl, which stores the ask
// as a `tool_use` block with the full structured questions/options JSON. Replaying
// all 448 local transcripts, 305/310 asks parsed perfectly. It is still useless
// here: Claude Code does not WRITE that record until the tool completes. Proved
// live 2026-08-07 — a pane sat on an open modal for ~2 minutes at 15 lines with no
// tool_use anywhere in the file; the instant the question was answered the file
// went to 22 lines with the tool_use AND its result appearing together. Historical
// transcripts all look complete, which is exactly why the file lies about the one
// state we care about. The pane's own screen is the only live source.
//
// NO vscode import here on purpose — this is the pure half (`bun test`
// pendingAsk.test.ts). Polling / QuickPick / send-keys live in pendingAskWatch.ts.

/** One selectable option as printed in the pane. */
export interface AskOption {
  /** The digit the TUI prints for it — what gets sent, never an array index. */
  key: number;
  label: string;
  description: string;
}

/** A choice box currently on screen in a pane. */
export interface PaneAsk {
  header: string;
  question: string;
  options: AskOption[];
  /** True for a tick-several-then-Submit box, where a digit TOGGLES instead of
   *  answering. Both kinds print the SAME footer (checked against real captures
   *  of each), so the `[ ]` in front of every option is the only tell. */
  multiSelect: boolean;
}

/** The modal's footer — the ONE unambiguous "a choice box is open" marker.
 *  Keying on numbered lines alone is what made the engine's own `_pane_waiting`
 *  mistake a todo panel for a modal (see orches tests/pane-waiting.sh). */
const FOOTER_RE = /Esc to cancel/;
/** `❯ 1. label` (selected) or `  2. label`. NBSP shows up in this TUI, so \s is
 *  not enough on its own — [\s ] everywhere whitespace is expected. */
const OPTION_RE = /^[\s ]*[❯>]?[\s ]*(\d)\.[\s ]+(\S.*)$/;
/** The header line: " [] x" for a plain box, or the tabbed multi-select form
 *  "<-  [] x  v Submit  ->". Both shapes are real captures 2026-08-07. */
const HEADER_RE = /^[\s ]*(?:←[\s ]*)?[☐☑✓][\s ]+(\S.*?)[\s ]*(?:[✔✓][\s ]*Submit.*)?$/;
/** The checkbox a multi-select box prints in front of EVERY option label. */
const CHECKBOX_RE = /^\[[\s xX✓✔]?\][\s ]*/;
/** Box-drawing rules that the viewport interleaves into the option list. */
const RULE_RE = /^[\s ]*[─━—-]{8,}[\s ]*$/;
/** Rows the TUI appends itself — real options must not be confused with them.
 *  (They keep their printed digits; dropping them never renumbers anything,
 *  because every option carries the digit it was printed with.) */
const BUILTIN_RE = /^(Type something\.?|Chat about this)$/i;
/** The TUI answers with one keystroke, so 9 is the ceiling. */
const MAX_DIGIT = 9;

const isBlank = (l: string) => !l.replace(/[\s ]/g, "");

/**
 * The choice box showing in a pane, or null when none is.
 *
 * `text` is `tmux capture-pane -p` output. Parsing walks UP from the footer so a
 * long scrollback of earlier numbered lists can never be mistaken for the modal.
 *
 * A wrapped option label (narrow split panes wrap Thai labels) degrades the
 * DISPLAYED text only — the digit that gets sent is read off the printed number,
 * so the answer stays correct even when the label is clipped.
 */
export function parseAskFromPane(text: string): PaneAsk | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  // Walk up from the footer to the header, keeping option rows in screen order.
  const options: AskOption[] = [];
  const seen = new Set<number>();
  let header = "";
  let headerIdx = -1;
  let multiSelect = false;
  for (let i = footer - 1; i >= 0 && footer - i < 60; i--) {
    const line = lines[i];
    if (isBlank(line) || RULE_RE.test(line)) continue;
    const h = HEADER_RE.exec(line);
    if (h) {
      header = h[1].trim();
      headerIdx = i;
      break;
    }
    const m = OPTION_RE.exec(line);
    if (m) {
      const key = Number(m[1]);
      const raw = m[2].trim();
      // Strip the checkbox BEFORE the built-in test: a multi-select box prints
      // its own row as "4. [ ] Type something", which only matches once bare.
      const label = raw.replace(CHECKBOX_RE, "").trim();
      if (label !== raw) multiSelect = true;
      if (key >= 1 && key <= MAX_DIGIT && !seen.has(key) && !BUILTIN_RE.test(label)) {
        seen.add(key);
        options.unshift({ key, label, description: "" });
      }
    }
  }
  if (!options.length) return null;

  // The question is the first real line under the header (the header block is
  // absent for a modal that did not set one — then there is no question line
  // either, and the options alone still carry the ask).
  let question = "";
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < footer; i++) {
      const line = lines[i];
      if (isBlank(line) || RULE_RE.test(line)) continue;
      if (OPTION_RE.test(line)) break;
      question = line.trim();
      break;
    }
  }

  // A description is the indented run directly under an option row.
  for (let i = 0; i < lines.length && i < footer; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) continue;
    const opt = options.find((o) => o.key === Number(m[1]));
    if (!opt || opt.description) continue;
    const next = lines[i + 1];
    if (next && !isBlank(next) && !RULE_RE.test(next) && !OPTION_RE.test(next) && !HEADER_RE.test(next)) {
      const d = next.trim();
      if (d !== opt.label && !FOOTER_RE.test(d)) opt.description = d;
    }
  }
  return { header, question, options, multiSelect };
}

/**
 * True when a single digit ANSWERS the box.
 *
 * Only the single-select shape is live-proved (`send-keys -t %0 2` picked and
 * submitted option 2 on a real modal, 2026-08-07). In a multi-select box the
 * same keystroke merely TOGGLES a checkbox and the human still has to hit
 * Submit — so those are shown read-only and handed off to the pane rather than
 * half-answered from here.
 */
export function isDigitAnswerable(ask: PaneAsk): boolean {
  return !ask.multiSelect && ask.options.length > 0;
}

/**
 * A stable identity for one on-screen ask, so a poll every few seconds shows the
 * box once instead of every tick.
 *
 * There is no tool_use id to borrow — that only reaches disk after the question
 * is answered — so identity is the pane plus what the box says. Re-asking the
 * SAME question in the same pane is therefore treated as the same ask, which is
 * the right call: it is the same human decision either way.
 */
export function askKey(pane: string, ask: PaneAsk): string {
  return [pane, ask.header, ask.question, ...ask.options.map((o) => `${o.key}:${o.label}`)].join("");
}

/**
 * Is the box on screen RIGHT NOW the same one we snapshotted? The guard that
 * runs immediately before a digit is sent (pendingAskWatch.stillUp).
 *
 * ⛔ It must be `askKey` and nothing looser (fixed 2026-08-14). The old check
 * compared the question plus the option COUNT, so a box that was answered in the
 * pane and then re-asked the SAME question with a different option set passed
 * the guard — and the digit we send is positional, so it lands on a different
 * answer. Identity of an ask already has one definition in this file; a second,
 * weaker one at the send site is exactly how the two drift apart.
 *
 * Safe against redraws by construction: the parser strips the `❯` cursor and the
 * `[ ]`/`[✔]` checkbox before the label, so moving the cursor or ticking a box in
 * the pane does not change the key (test D6).
 */
export function sameAsk(pane: string, key: string, now: PaneAsk | null): boolean {
  return !!now && askKey(pane, now) === key;
}

/**
 * How an option is written in the QuickPick, and how it is read back.
 *
 * These two are a pair and must never drift: the accept handler receives only
 * the picked item's `label`, so the formatting side and the lookup side have to
 * agree exactly. If they diverge the box renders perfectly and clicking it does
 * nothing — a dead affordance, the same failure the dashboard's window rows once
 * had. Matching the WHOLE formatted string (rather than parsing the leading
 * digit) is what makes an option whose own text begins "2. …" still resolve to
 * its real key. `pendingAsk.test.ts` locks the round-trip.
 */
export function itemLabel(o: AskOption): string {
  return `${o.key}. ${o.label}`;
}

/** The option a picked QuickPick label refers to, or null if it belongs to a
 *  box that has since been replaced. */
export function findOptionByLabel(ask: PaneAsk, label: string): AskOption | null {
  if (!label) return null;
  return ask.options.find((o) => itemLabel(o) === label) ?? null;
}

/**
 * `tmux send-keys` argv that picks the option printed as `digit`.
 *
 * Live-proved 2026-08-07: `tmux send-keys -t %0 2` on an open AskUserQuestion
 * modal selected AND submitted option 2 — no Enter needed, and an Enter that
 * missed the modal would submit an empty prompt to the agent instead.
 *
 * Targets a `%N` PANE id, never a session: `-t '=<session>'` is a known tmux 3.4
 * failure, and a bare session target lands on the ACTIVE pane — usually a
 * different agent than the one that asked. Throws rather than sending anything
 * it cannot vouch for.
 */
export function buildAnswerArgs(paneId: string, digit: number): string[] {
  if (!/^%\d+$/.test(paneId)) throw new Error(`unsafe pane id: ${paneId}`);
  if (!Number.isInteger(digit) || digit < 1 || digit > MAX_DIGIT) {
    throw new Error(`option out of range: ${digit}`);
  }
  return ["send-keys", "-t", paneId, String(digit)];
}

/**
 * Copy-mode guard.
 *
 * ⛔⛔ A pane sitting in tmux copy-mode SWALLOWS every `send-keys` — the command
 * still exits 0, nothing appears, and the agent stays blocked. Caught live
 * 2026-08-14 on `09-foreman`: the run parked on the ask's review screen while
 * both this popup's keys and hand-sent ones vanished; `#{pane_in_mode}` was 1.
 *
 * The entry is not a user error we can design away: the orches layout sets
 * `mouse on` (that is what makes the status bar clickable), so one wheel notch
 * over a pane enters copy-mode. Cancelling costs only that scroll position,
 * while not cancelling costs the whole answer — so we always clear before we
 * send, and never the other way round.
 */
export function buildInModeArgs(paneId: string): string[] {
  if (!/^%\d+$/.test(paneId)) throw new Error(`unsafe pane id: ${paneId}`);
  return ["display-message", "-p", "-t", paneId, "#{pane_in_mode}"];
}

/** `tmux send-keys -X … cancel` argv — leaves copy-mode, sends no keystroke. */
export function buildUncopyArgs(paneId: string): string[] {
  if (!/^%\d+$/.test(paneId)) throw new Error(`unsafe pane id: ${paneId}`);
  return ["send-keys", "-X", "-t", paneId, "cancel"];
}

/** tmux prints `1` when the pane is in a mode. Anything else (including a failed
 *  call → null) means "not in a mode": never block answering on a probe error. */
export function isInMode(raw: string | null | undefined): boolean {
  return (raw ?? "").trim() === "1";
}

/** Named keys we are willing to send. A whitelist, not a string pass-through:
 *  `send-keys` with unknown text types it into whatever has focus, and the thing
 *  with focus here is a blocked agent's prompt. */
const KEY_NAMES = ["Right", "Left", "Enter", "Escape"] as const;
export type SendKeyName = (typeof KEY_NAMES)[number];

/** `tmux send-keys` argv for one named key (not text). */
export function buildKeyArgs(paneId: string, key: SendKeyName): string[] {
  if (!/^%\d+$/.test(paneId)) throw new Error(`unsafe pane id: ${paneId}`);
  if (!KEY_NAMES.includes(key)) throw new Error(`key not allowed: ${key}`);
  return ["send-keys", "-t", paneId, key];
}

/**
 * True when this box can be answered from outside the pane at all.
 *
 * Multi-select used to be excluded, because a digit only TOGGLES there and the
 * Submit affordance carries no digit to send. The full protocol was then found
 * by experiment on a live REPL (2026-08-10) and is deterministic — see
 * `parseReviewFromPane` — so these are answerable now too.
 */
export function isMultiAnswerable(ask: PaneAsk): boolean {
  return ask.multiSelect && ask.options.length > 0;
}

/** The review screen a multi-select box shows after `Right`. */
export interface AskReview {
  /** Best-effort split of the answer line, for showing the human what will be sent. */
  answers: string[];
  /** The answer line verbatim — a label may contain its own comma, so the split
   *  above is for display and `reviewMatches` uses this instead. */
  answerText: string;
  /** The digit printed for "Submit answers". */
  submitKey: number;
  /** The digit printed for "Cancel", when it is there. */
  cancelKey: number | null;
}

/** `   → มะม่วง, เงาะ` — what the review screen says it will send. */
const REVIEW_ANSWER_RE = /^[\s ]*→[\s ]+(\S.*)$/;
const SUBMIT_RE = /^submit answers$/i;
const CANCEL_RE = /^cancel$/i;

/**
 * Read the review screen, or null when the pane is not showing one.
 *
 * ⛔ Do NOT key this on the modal footer: the review screen prints **no**
 * `Esc to cancel` line at all (verified on a live capture 2026-08-10). That is
 * also why `parseAskFromPane` returns null here, which is what we want — the
 * poller must not count a review screen as a fresh question.
 *
 * The tell is an option row labelled exactly "Submit answers"; everything else
 * about the screen is prose that could be reworded upstream.
 */
export function parseReviewFromPane(text: string): AskReview | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  let submitKey = -1;
  let cancelKey: number | null = null;
  const answerLines: string[] = [];
  for (const line of lines) {
    const m = OPTION_RE.exec(line);
    if (m) {
      const label = m[2].trim();
      if (SUBMIT_RE.test(label)) submitKey = Number(m[1]);
      else if (CANCEL_RE.test(label)) cancelKey = Number(m[1]);
      continue;
    }
    const a = REVIEW_ANSWER_RE.exec(line);
    if (a) answerLines.push(a[1].trim());
  }
  if (submitKey < 1 || submitKey > MAX_DIGIT) return null;
  const answerText = answerLines.join(" · ");
  return {
    answers: answerLines.flatMap((l) => l.split(/,[\s ]+/).map((s) => s.trim())).filter(Boolean),
    answerText,
    submitKey,
    cancelKey,
  };
}

/**
 * Does the review screen list exactly what we ticked?
 *
 * This is the gate that makes sending the final keystroke safe: rather than
 * trusting that N digit presses landed, we read back the agent's own summary of
 * what it is about to submit and compare. A mismatch means a digit was dropped
 * or something was already ticked before we arrived — we abort and leave the box
 * for the human instead of submitting the wrong answer.
 *
 * Substring containment, not a comma split: a label may legitimately contain
 * ", ". An option we did NOT tick appearing in the review is a hard abort —
 * except when it is a substring of one we did tick, where the two are
 * indistinguishable and blocking would break a legitimate answer.
 */
export function reviewMatches(review: AskReview, chosen: string[], all: string[]): boolean {
  if (!chosen.length) return false; // never submit an empty box
  const t = review.answerText;
  if (!t) return false;
  for (const c of chosen) if (!t.includes(c)) return false;
  for (const o of all) {
    if (chosen.includes(o)) continue;
    if (chosen.some((c) => c.includes(o))) continue; // ambiguous by containment — cannot judge
    if (t.includes(o)) return false; // something we did not tick is in there
  }
  return true;
}

/** A live pane, from `tmux list-panes -a`. */
export interface PaneRow {
  pane: string;
  session: string;
  cmd: string;
}

/** tmux format for the one `list-panes -a` the poller runs per tick. */
export const PANE_LIST_FMT = "#{pane_id}\t#{session_name}\t#{pane_current_command}";

/** Parse `tmux list-panes -a -F PANE_LIST_FMT`. Rows whose pane id would be
 *  unsafe to hand back to tmux are dropped, so every row is a valid target. */
export function parsePaneList(raw: string): PaneRow[] {
  const out: PaneRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split("\t");
    if (f.length < 3) continue;
    const [pane, session, cmd] = f;
    if (!/^%\d+$/.test(pane) || !session) continue;
    out.push({ pane, session, cmd: cmd || "" });
  }
  return out;
}

/** Should MC open its OWN asker for a hit, given how many clients are attached
 *  to that pane's tmux session?
 *
 *  ⛔ Every hit this feature produces is a NATIVE Claude Code box (FOOTER_RE is
 *  that box's own footer), so when a human is attached the question is already
 *  on their screen with its native keyboard handling — opening a second asker on
 *  top is the duplicate the user asked us to stop ("ถ้าเป็น native ให้ใช้ถามตอบ
 *  ของ native", 2026-08-16). MC's asker exists for the headless case: a run
 *  nobody is attached to, where the box would otherwise block the sprint until
 *  somebody happens to look.
 *
 *  ⛔ `clients` comes from `sessionClients()` (webview/sessions.ts), where -1
 *  means the session is gone — there is nothing left to answer. Any value that
 *  is not a clean non-negative integer is treated as "do not show": popping a
 *  panel over someone's screen on a garbled count is the failure that annoys,
 *  and the status bar + `pendingAskCommand` still offer a way in by hand. */
/** ทำไมกล่องไม่เด้งเอง — "" = มันจะเด้ง.
 *
 *  ⛔⛔ ทำไมต้องพิมพ์บอก: อาการ "popup ไม่เด้ง" ถูกบันทึกเป็น OPEN BUG ไว้ตั้งแต่ 2026-08-12
 *  แล้วไล่หาสาเหตุซ้ำหลายรอบ ทั้งที่วันนี้มีสามเหตุผลที่ **ถูกต้องทั้งหมด**: กล่องเปิดอยู่แล้ว ·
 *  เคยเด้งแล้วและถูกปิดไป (`_seen` ไม่เคยล้าง) · มีคน attach tmux session นั้นอยู่ ซึ่งเป็นกฎที่
 *  user สั่งเอง 2026-08-16 ("ไม่ต้องเด้งซ้ำกับกล่องที่อยู่บน pane แล้ว")
 *  ⇒ ถ้าไม่มีบรรทัดบอกเหตุผล ทุกครั้งที่มันเงียบจะถูกอ่านว่าบั๊ก แล้วเสียเวลาไล่ใหม่ทั้งรอบ
 *  ⛔ ตัวนี้ไม่ตัดสินอะไร — คำตัดสินยังอยู่ที่ shouldShowOwnAsker เหมือนเดิม */
export function autoOpenSkipReason(o: { openBox: boolean; unseenHits: number; clients: number }): string {
  if (o.openBox) return "กล่องเปิดอยู่แล้ว";
  if (o.unseenHits === 0) return "เคยเด้งแล้วและถูกปิดไป — กดที่แถบสถานะเพื่อเปิดใหม่";
  if (!shouldShowOwnAsker(o.clients))
    return `มีคน attach tmux session นี้อยู่ (${o.clients}) — ตั้งใจไม่เด้งซ้ำ (กฎ 2026-08-16) · กดที่แถบสถานะเพื่อเปิดเอง`;
  return "";
}

export function shouldShowOwnAsker(clients: number): boolean {
  return Number.isInteger(clients) && clients === 0;
}

/** A pane blocked on a choice box, plus where to answer it. */
export interface PendingHit {
  pane: string;
  session: string;
  ask: PaneAsk;
  key: string;
}

/**
 * One sweep: which live panes have a choice box open right now.
 *
 * `capture` returns a pane's screen, or null when it cannot be read. It may
 * throw (a pane can die between the list and the capture) — one bad pane must
 * never hide another pane's question, so each is isolated.
 */
export function scanPending(panes: PaneRow[], capture: (pane: string) => string | null): PendingHit[] {
  const out: PendingHit[] = [];
  for (const p of panes) {
    let text: string | null;
    try {
      text = capture(p.pane);
    } catch {
      continue; // unreadable right now — try again next tick
    }
    if (!text) continue;
    const ask = parseAskFromPane(text);
    if (ask) out.push({ pane: p.pane, session: p.session, ask, key: askKey(p.pane, ask) });
  }
  return out;
}
