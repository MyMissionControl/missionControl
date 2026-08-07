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
