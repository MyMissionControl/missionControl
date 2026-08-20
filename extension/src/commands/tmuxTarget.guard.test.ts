import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ⛔⛔ On tmux 3.4 a session-only `=<name>` target is REJECTED by send-keys —
 * `can't find pane: =claude-jack`, exit 1 — while the same form works for
 * `attach`/`has-session`. Verified live on an isolated socket:
 *
 *   -t '=claude-jack'      -> can't find pane, exit 1     <- the trap
 *   -t '=claude-jack:'     -> ok
 *   -t '=claude-jack:w.0'  -> ok
 *   -t 'claude-jack'       -> ok
 *
 * Every send-keys in this repo is wrapped in a best-effort try/catch, so the trap is
 * silent: the keystroke never lands and nothing is logged. `claudeSessions.ts` records
 * the same finding in a comment, but a comment cannot fail a build — this can.
 *
 * The pattern matched is exactly the broken shape: a `=${x}` target that ends right
 * there, with no `:<window>` after it. Qualified forms and pane ids (`%0`) pass.
 */
const SRC_DIR = join(import.meta.dir, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** `=${anything}` closed immediately by the template quote — no `:<window>` after it. */
const BARE_TARGET = /=\$\{[^}]+\}["\'`]/;

/** A comment that DESCRIBES the trap is not the trap. Skipping comment-only lines is
 *  the same false-positive class that made the first pass of the 2026-08-20 webview
 *  audit report 9 phantom failures: a scanner that cannot tell code from prose. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("the detector actually fires (guard has teeth)", () => {
  expect(BARE_TARGET.test('cp.execFileSync("tmux", ["send-keys", "-t", `=${s}`, k])')).toBe(true);
  expect(BARE_TARGET.test('cp.execFileSync("tmux", ["send-keys", "-t", `=${s}:${w}`, k])')).toBe(false);
  expect(BARE_TARGET.test('cp.execFileSync("tmux", ["send-keys", "-t", pane, k])')).toBe(false);
});

test("no send-keys target is a bare `=${session}` (tmux 3.4 rejects it, silently)", () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("send-keys")) continue;
    text.split("\n").forEach((line, i) => {
      if (!line.includes("send-keys") || isComment(line)) return;
      if (BARE_TARGET.test(line)) {
        offenders.push(`${file.slice(SRC_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
