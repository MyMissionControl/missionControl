// Pure parser: a Claude Code transcript (.jsonl) → renderable chat messages.
// NO vscode/fs import (unit-testable with bun). The Mirror "chat" view renders
// each pane's conversation from its transcript instead of mirroring a terminal —
// so Thai renders as real HTML (no terminal grid to garble stacked marks) and
// there is a single composer.
//
// Transcript entries have a top-level `type`; only `user`/`assistant` carry a
// `message` ({role, content}) worth showing. content is a string (a plain
// prompt) or an array of Anthropic content blocks (text / thinking / tool_use /
// tool_result / image). System-injected turns (`isMeta`) and subagent sidechains
// (`isSidechain`) are dropped — they're noise in a human chat view.

export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result" | "image";

export interface AskOption {
  label: string;
  description?: string;
}
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface ChatBlock {
  kind: BlockKind;
  text?: string; // text / thinking / tool_result content
  name?: string; // tool_use tool name
  input?: unknown; // tool_use raw input
  isError?: boolean; // tool_result error flag
  /** Present only on an `AskUserQuestion` tool_use — the questions Claude is asking
   *  the human, normalized for prominent rendering (chat.js shows a question card
   *  instead of a collapsed tool chip, so the human actually sees + can answer it). */
  ask?: AskQuestion[];
}

/** Normalize an `AskUserQuestion` tool_use `input` into renderable questions, or
 *  undefined when the input is malformed / has no answerable question. Pure +
 *  defensive: transcripts are untrusted, a bad shape must degrade to "no card"
 *  (the raw tool chip still renders), never throw. */
export function parseAskUserQuestion(input: unknown): AskQuestion[] | undefined {
  const qs = (input as any)?.questions;
  if (!Array.isArray(qs)) return undefined;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) continue;
    const opts: AskOption[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (o && typeof o.label === "string" && o.label.trim())
          opts.push({ label: o.label, description: typeof o.description === "string" ? o.description : undefined });
      }
    }
    if (!opts.length) continue; // a question with no selectable option isn't answerable here
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : undefined, multiSelect: !!q.multiSelect, options: opts });
  }
  return out.length ? out : undefined;
}

export interface ChatMsg {
  role: "user" | "assistant";
  uuid?: string;
  ts?: string;
  blocks: ChatBlock[];
  /** true when every block is a tool_result — a tool-feedback turn, not a human
   *  prompt (render as results, not a user bubble). */
  toolFeedback: boolean;
}

// Claude Code's slash-command echoes are recorded as user turns — UI plumbing,
// not conversation. Drop them. Two shapes:
//  (a) the wrapped form `<command-name>/compact</command-name>…` (interactive TUI), and
//  (b) a BARE slash command like "/compact" (recorded when the command is delivered via
//      send-keys — e.g. the chat's own forceCompact — so it slips past the wrapper regex).
const CMD_NOISE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/;
// bare slash-command: a single line that is "/word" (+ optional args). Anchored + single-line
// so it never eats a path ("/tmp/x/y" fails: no space after the first word) or a real multi-
// line message that merely starts with "/". User turns only (see isNoiseText).
const SLASH_CMD = /^\/[a-zA-Z][\w:-]*(\s.*)?$/;
function isCommandNoise(text: string): boolean {
  return CMD_NOISE.test(text.trim());
}
/** Text that is UI plumbing, not conversation — dropped from the chat. */
function isNoiseText(text: string, role: "user" | "assistant"): boolean {
  const t = text.trim();
  if (isCommandNoise(t)) return true;
  if (role === "user" && !t.includes("\n") && SLASH_CMD.test(t)) return true;
  return false;
}

/** Flatten a tool_result's `content` (string | array of {type,text|...}) to text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && typeof b.text === "string" ? b.text : b && b.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Parse ONE already-JSON-parsed transcript entry into a ChatMsg, or null when
 *  it is not a renderable conversation turn. */
export function parseEntry(o: any): ChatMsg | null {
  if (!o || (o.type !== "user" && o.type !== "assistant")) return null;
  // isMeta/isSidechain = system-injected / subagent noise. isCompactSummary +
  // isVisibleInTranscriptOnly = the "This session is being continued…" compaction summary
  // (a synthetic user turn shown only in the transcript view) — the user must NOT see it.
  if (o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly) return null;
  const msg = o.message;
  if (!msg) return null;
  const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
  const blocks: ChatBlock[] = [];
  const c = msg.content;
  if (typeof c === "string") {
    if (c.trim() && !isNoiseText(c, role)) blocks.push({ kind: "text", text: c });
  } else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b.type !== "string") continue;
      if (b.type === "text") {
        if (typeof b.text === "string" && b.text.trim() && !isNoiseText(b.text, role)) blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "thinking") {
        if (typeof b.thinking === "string" && b.thinking.trim()) blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "tool_use") {
        const name = typeof b.name === "string" ? b.name : "tool";
        const block: ChatBlock = { kind: "tool_use", name, input: b.input };
        if (name === "AskUserQuestion") block.ask = parseAskUserQuestion(b.input);
        blocks.push(block);
      } else if (b.type === "tool_result") {
        blocks.push({ kind: "tool_result", text: resultText(b.content), isError: !!b.is_error });
      } else if (b.type === "image") {
        blocks.push({ kind: "image" });
      }
    }
  }
  if (!blocks.length) return null;
  const toolFeedback = blocks.every((b) => b.kind === "tool_result");
  return { role, uuid: o.uuid, ts: o.timestamp, blocks, toolFeedback };
}

/** Parse a chunk of newline-delimited transcript JSON into ChatMsgs (skipping
 *  non-conversation + unparseable lines). Used for the initial load and for each
 *  appended tail chunk. */
export function parseTranscript(text: string): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const line of text.split("\n")) {
    if (!line || line[0] !== "{") continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = parseEntry(o);
    if (m) out.push(m);
  }
  return out;
}
