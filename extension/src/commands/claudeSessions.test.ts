import { test, expect } from "bun:test";

import {
  buildAttachText,
  buildClaudeSendKeysArgs,
  buildClaudeDetachedArgs,
  buildClaudeTmuxCommand,
  buildCompactSendKeysArgs,
  clipboardImagePath,
  clipboardImageReadCommand,
  isClaudeReplSession,
  looksLikePng,
  projectSessionName,
  sessionFromTerminalName,
  droppedFilePath,
} from "./claudeSessions";

test("droppedFilePath: sanitized temp path, keeps basename+ext, strips dirs", () => {
  expect(droppedFilePath("/tmp", 42, "a.png")).toBe("/tmp/mc-drop-42-a.png");
  expect(droppedFilePath("/tmp/", 42, "../../etc/passwd")).toBe("/tmp/mc-drop-42-passwd");
  expect(droppedFilePath("/tmp", 42, "we ird!.txt")).toBe("/tmp/mc-drop-42-we_ird_.txt");
  expect(droppedFilePath("/tmp", 42, "")).toBe("/tmp/mc-drop-42-file");
});

test("projectSessionName prefixes claude- and keeps clean names", () => {
  expect(projectSessionName("ttt")).toBe("claude-ttt");
  expect(projectSessionName("agentskill-marketplace")).toBe("claude-agentskill-marketplace");
  expect(projectSessionName("agentskill-marketplace-v2")).toBe("claude-agentskill-marketplace-v2");
});

test("projectSessionName sanitizes spaces, symbols, and edge hyphens", () => {
  expect(projectSessionName("expense tracker!!")).toBe("claude-expense-tracker");
  expect(projectSessionName("  weird  ")).toBe("claude-weird");
  expect(projectSessionName("a/b:c")).toBe("claude-a-b-c");
  expect(projectSessionName("***")).toBe("claude-project"); // all stripped -> fallback
  expect(projectSessionName("")).toBe("claude-project");
});

test("projectSessionName output always passes the session-name whitelist", () => {
  for (const n of ["ttt", "expense tracker!!", "a/b:c", "***", "x".repeat(60)]) {
    expect(/^claude-[A-Za-z0-9._-]+$/.test(projectSessionName(n))).toBe(true);
  }
});

test("buildClaudeTmuxCommand quotes session and cwd", () => {
  expect(buildClaudeTmuxCommand("claude-ttt", "/home/u/projects/ttt")).toBe(
    "tmux new-session -A -s 'claude-ttt' -c '/home/u/projects/ttt' claude",
  );
});

test("buildClaudeTmuxCommand escapes single quotes in cwd (no shell break-out)", () => {
  expect(buildClaudeTmuxCommand("claude-x", "/tmp/o'neil")).toBe(
    "tmux new-session -A -s 'claude-x' -c '/tmp/o'\\''neil' claude",
  );
});

// ── attach file/image helpers ──────────────────────────────────────────────

test("sessionFromTerminalName parses the 'tmux: <session>' title", () => {
  expect(sessionFromTerminalName("tmux: claude-ttt")).toBe("claude-ttt");
  expect(sessionFromTerminalName("tmux:claude-soulbrew")).toBe("claude-soulbrew"); // no space
  expect(sessionFromTerminalName("tmux:   claude-x  ")).toBe("claude-x"); // trims padding
});

test("sessionFromTerminalName rejects non-tmux terminal titles", () => {
  expect(sessionFromTerminalName("bash")).toBeNull();
  expect(sessionFromTerminalName("ttt")).toBeNull(); // dashboard project-named terminal
  expect(sessionFromTerminalName("")).toBeNull();
  expect(sessionFromTerminalName(undefined)).toBeNull();
});

test("isClaudeReplSession matches single-pane Open-Claude sessions only", () => {
  expect(isClaudeReplSession("claude-ttt")).toBe(true);
  expect(isClaudeReplSession("claude-soulbrew")).toBe(true);
  expect(isClaudeReplSession("claude-agentskill-marketplace")).toBe(true);
  // excluded: multi-pane orches / oracle / project sessions
  expect(isClaudeReplSession("1-foreman")).toBe(false);
  expect(isClaudeReplSession("expense-tracker")).toBe(false);
  expect(isClaudeReplSession("claude-")).toBe(false); // needs a slug
  expect(isClaudeReplSession("claude-bad name")).toBe(false); // whitelist only
});

test("buildAttachText joins paths and adds a trailing space for typing", () => {
  expect(buildAttachText(["/a/b/img.png"])).toBe("/a/b/img.png ");
  expect(buildAttachText(["/a/one.png", "/b/two.txt"])).toBe("/a/one.png /b/two.txt ");
});

test("buildAttachText drops blanks and returns '' when nothing usable", () => {
  expect(buildAttachText(["  ", ""])).toBe("");
  expect(buildAttachText([])).toBe("");
  expect(buildAttachText([" /x/y.png ", ""])).toBe("/x/y.png ");
});

test("buildClaudeSendKeysArgs inserts literally (-l) with no Enter, bare-session target", () => {
  // BARE session name — `=<session>` fails on tmux 3.4 (verified live).
  expect(buildClaudeSendKeysArgs("claude-ttt", "/a/b img.png ")).toEqual([
    "send-keys",
    "-t",
    "claude-ttt",
    "-l",
    "/a/b img.png ",
  ]);
  // never the `=`-prefixed form
  expect(buildClaudeSendKeysArgs("claude-x", "/p ")).not.toContain("=claude-x");
  // no "Enter" element — submission is left to the user
  expect(buildClaudeSendKeysArgs("claude-x", "/p ")).not.toContain("Enter");
});

test("buildCompactSendKeysArgs types /compact + Enter (interpreted, not -l)", () => {
  expect(buildCompactSendKeysArgs("claude-ttt")).toEqual(["send-keys", "-t", "claude-ttt", "/compact", "Enter"]);
  expect(buildCompactSendKeysArgs("09-foreman:bob")).toEqual([
    "send-keys",
    "-t",
    "09-foreman:bob",
    "/compact",
    "Enter",
  ]);
  expect(buildCompactSendKeysArgs("claude-x")).not.toContain("-l"); // interpreted keys, not literal
});

// ── clipboard image (Option B) helpers ─────────────────────────────────────

test("clipboardImageReadCommand picks wl-paste on Wayland, xclip on X11, null headless", () => {
  expect(clipboardImageReadCommand({ WAYLAND_DISPLAY: "wayland-0" })).toEqual({
    tool: "wl-paste",
    args: ["--type", "image/png"],
  });
  expect(clipboardImageReadCommand({ DISPLAY: ":10.0" })).toEqual({
    tool: "xclip",
    args: ["-selection", "clipboard", "-t", "image/png", "-o"],
  });
  // Wayland wins when both set
  expect(clipboardImageReadCommand({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })?.tool).toBe("wl-paste");
  expect(clipboardImageReadCommand({})).toBeNull();
});

test("looksLikePng detects the 8-byte PNG signature", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  expect(looksLikePng(png)).toBe(true);
  expect(looksLikePng(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false); // too short
  expect(looksLikePng(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false); // jpeg header
  expect(looksLikePng(new Uint8Array(0))).toBe(false); // empty clipboard
  expect(looksLikePng(new TextEncoder().encode("hello world"))).toBe(false); // text clipboard
});

test("clipboardImagePath builds <dir>/mc-clip-<stamp>.png and trims trailing slashes", () => {
  expect(clipboardImagePath("/tmp", 1234)).toBe("/tmp/mc-clip-1234.png");
  expect(clipboardImagePath("/tmp/", 1234)).toBe("/tmp/mc-clip-1234.png");
  expect(clipboardImagePath("/var/folders/x//", 99)).toBe("/var/folders/x/mc-clip-99.png");
});

// Chat mode cannot spawn a session (the webview only mirrors one), so "Open
// Claude" brings it up detached first, then points the chat at it.
test("buildClaudeDetachedArgs: create-or-noop, never takes over the terminal", () => {
  expect(buildClaudeDetachedArgs("claude-foo", "/home/u/p")).toEqual([
    "new-session", "-A", "-d", "-s", "claude-foo", "-c", "/home/u/p", "claude",
  ]);
  // argv, not a shell string → a space in the path is one argument, not two
  const args = buildClaudeDetachedArgs("claude-x", "/home/u/my project");
  expect(args[6]).toBe("/home/u/my project");
  // -d is what keeps it headless; losing it would hijack the caller's terminal
  expect(args).toContain("-d");
});
