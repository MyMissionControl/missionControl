// Pure helpers for the "Open Claude" project picker. NO vscode/fs import here
// so the sanitization + command-building logic can be unit-tested standalone
// with `bun test`. The fs-backed project discovery lives in claude.ts.

export interface ClaudeTarget {
  /** Display label in the quick-pick (the project folder name, or "soulbrew"). */
  label: string;
  /** Absolute working directory claude is launched in. */
  cwd: string;
  /** tmux session name — whitelist-safe, "claude-" prefixed. */
  session: string;
}

/** Turn a project folder name into a safe tmux session name: "claude-<slug>".
 *  Any char outside [A-Za-z0-9._-] collapses to a single "-"; leading/trailing
 *  hyphens are trimmed. The result always matches /^claude-[A-Za-z0-9._-]+$/,
 *  so the Sessions panel's isSafeSessionName whitelist accepts it and it is
 *  safe to single-quote into a shell command. */
export function projectSessionName(projectName: string): string {
  const slug = projectName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-") // non-whitelist runs -> one hyphen
    .replace(/-+/g, "-") // collapse hyphen runs
    .replace(/^-+|-+$/g, ""); // trim edge hyphens
  return "claude-" + (slug || "project");
}

/** Single-quote a string for POSIX sh, escaping embedded single quotes via the
 *  '\'' idiom. Robust even if a path contains quotes/spaces/metacharacters. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the create-or-attach tmux command. `-A` attaches if the session
 *  already exists, otherwise creates it running `claude` in `cwd`. Both the
 *  session name and cwd are shell-quoted. */
export function buildClaudeTmuxCommand(session: string, cwd: string): string {
  return `tmux new-session -A -s ${shQuote(session)} -c ${shQuote(cwd)} claude`;
}

/** argv (NO shell) for create-or-noop DETACHED — `-A -d` = attach if it exists,
 *  otherwise create, and never take over this terminal. Chat mode needs this
 *  because the chat webview can only MIRROR a session, not spawn one: we bring
 *  the session up headless first, then point the chat at it. */
export function buildClaudeDetachedArgs(session: string, cwd: string): string[] {
  return ["new-session", "-A", "-d", "-s", session, "-c", cwd, "claude"];
}

// ── Attach file/image to a live Claude REPL ────────────────────────────────
// The "Claude REPL" is the real `claude` CLI running in a tmux pane opened by
// "Open Claude". On this Linux/xrdp box you can't drag-drop or paste an image
// into a raw terminal TUI, so attaching is done from VS Code: pick the file,
// then TYPE its absolute path into the pane via `tmux send-keys`. Claude Code's
// own Read tool ingests the file (image or text) from that path — the exact
// trick maw uses, minus maw's upload server (unneeded here: the extension and
// the claude process share one filesystem). See attachToClaude.ts for the shell.

/** Parse a tmux session name out of an editor-terminal title. "Open Claude"
 *  (claude.ts) and the dashboard re-attach path name their terminals
 *  "tmux: <session>". Returns the session, or null when the title isn't one of
 *  ours. */
export function sessionFromTerminalName(name: string | undefined): string | null {
  if (!name) return null;
  const m = name.match(/^tmux:\s*(\S.*?)\s*$/);
  return m ? m[1] : null;
}

/** True when a session name is a single-pane "Open Claude" REPL (`claude-<slug>`
 *  from projectSessionName, incl. `claude-soulbrew`). This is the ONLY shape the
 *  attach command targets: multi-pane orches sessions (`NN-oracle` / project
 *  names) are excluded because `send-keys -t '=<session>'` hits the active pane,
 *  which in a multi-pane session may not be the claude one. */
export function isClaudeReplSession(name: string): boolean {
  return /^claude-[A-Za-z0-9._-]+$/.test(name);
}

/** The literal text inserted at the claude prompt for the attached path(s):
 *  space-joined with a trailing space so the user can keep typing their prompt
 *  after it. Raw paths (no quoting) — the pane receives them literally via
 *  `send-keys -l` and Claude Code resolves a bare path with its Read tool.
 *  Empty/blank input → "" (caller skips the send). */
export function buildAttachText(paths: string[]): string {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  return clean.length ? clean.join(" ") + " " : "";
}

/** Build the `tmux send-keys` argv that inserts `text` LITERALLY into the
 *  session's active pane WITHOUT submitting (no trailing Enter). `-l` = literal
 *  keys, so a path containing spaces, `;`, or the word `Enter` is typed verbatim
 *  rather than interpreted as a key name. Run via `execFileSync` (argv, no shell)
 *  so an arbitrary picked path needs no shell quoting. Caller MUST validate
 *  `session` with isSafeSessionName first.
 *
 *  Target is the BARE session name, NOT `=<session>`: on tmux 3.4 (this box)
 *  `send-keys -t '=<session>'` fails with "can't find pane" — verified live, and
 *  matching the orches memory gotcha. A bare name resolves exact-first (and the
 *  isSafeSessionName whitelist excludes every fnmatch metachar `*?[`, so no
 *  surprise prefix match). No Enter is intentional: the user adds their prompt
 *  around the path and submits themselves, which also sidesteps the tmux
 *  "paste-then-Enter swallow" race (see memory tmux-send-keys-enter-swallow). */
export function buildClaudeSendKeysArgs(session: string, text: string): string[] {
  return ["send-keys", "-t", session, "-l", text];
}

/** Build the `tmux send-keys` argv that runs `/compact` in the target pane.
 *  Target is "<session>" (single-pane REPL) or "<session>:<window>" (a worker in
 *  a multi-pane orches session) — bare, never `=<session>` (that fails for
 *  send-keys on tmux 3.4; a window-qualified `=<s>:<w>` works but bare is simpler
 *  and matches teamUpModel's `/model` send). NOT `-l`: the args are interpreted,
 *  so "/compact" is typed as keystrokes (triggering the slash command) then Enter
 *  submits — live-verified. Caller MUST validate session (+ window) with
 *  isSafeSessionName first. */
export function buildCompactSendKeysArgs(target: string): string[] {
  return ["send-keys", "-t", target, "/compact", "Enter"];
}

// ── Clipboard image (Option B: paste an image into the REPL) ────────────────
// VS Code's clipboard API is text-only, so a pasted IMAGE is fetched by shelling
// out to the OS clipboard tool, written to a temp file, and its path injected
// exactly like a picked file. Verified on this X11/xrdp box: xclip round-trips
// image/png losslessly.

/** The command that reads a PNG off the OS clipboard to stdout, chosen from the
 *  display server in `env`. Wayland → wl-paste, X11 → xclip. null when neither
 *  display is present (headless). The tool may still be uninstalled — the caller
 *  handles ENOENT (e.g. "install xclip"). */
export function clipboardImageReadCommand(env: {
  WAYLAND_DISPLAY?: string;
  DISPLAY?: string;
}): { tool: string; args: string[] } | null {
  if (env.WAYLAND_DISPLAY) return { tool: "wl-paste", args: ["--type", "image/png"] };
  if (env.DISPLAY) return { tool: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] };
  return null;
}

/** True when `bytes` starts with the 8-byte PNG signature. Used to reject empty
 *  output / text-only clipboards before writing a temp file. */
export function looksLikePng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

/** Temp path for a clipboard image: `<dir>/mc-clip-<stamp>.png`. `dir` is
 *  os.tmpdir() at the call site; `stamp` is a millisecond timestamp (passed in so
 *  this stays pure/testable). Trailing slashes on `dir` are trimmed. */
export function clipboardImagePath(dir: string, stamp: number): string {
  return `${dir.replace(/\/+$/, "")}/mc-clip-${stamp}.png`;
}

/** Temp path for a drag-dropped file: `<dir>/mc-drop-<stamp>-<safeName>`. A
 *  drag-drop into a webview only yields the file's BYTES + a display name (no OS
 *  path — browser security), so the host writes the bytes to this temp path and
 *  injects that. Only the basename is kept (POSIX `/` and Windows `\\` segments
 *  dropped) and reduced to [A-Za-z0-9._-] with the rest → "_", so an arbitrary
 *  dropped name can never escape `dir` or inject path/shell metacharacters. Empty
 *  → "file". `stamp` is passed in (millisecond timestamp) so this stays pure. */
export function droppedFilePath(dir: string, stamp: number, name: string): string {
  const base = (name.split("/").pop() || "").split("\\").pop() || "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  return `${dir.replace(/\/+$/, "")}/mc-drop-${stamp}-${safe}`;
}
