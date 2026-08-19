import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT = ".orches-preview.sh";
const PIDF = ".orches-preview.pid";
const LOGF = ".orches-preview.log";
/** The toggle script's OWN stdout/stderr (why it refused to boot), not the server log. */
const BOOTLOG = ".orches-preview.boot.log";

/** The dev-server URL printed in the preview log (Next :3000 / Vite :5173 / py :8000).
 *  0.0.0.0 and 127.0.0.1 are normalized to localhost so the browser opens cleanly. */
export function parsePreviewUrl(logText: string): string | null {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i.exec(logText);
  if (!m) return null;
  return m[0].replace(/\/\/(?:127\.0\.0\.1|0\.0\.0\.0)/i, "//localhost");
}

/** A project can preview iff it ships the .orches-preview.sh toggle script. */
export function isPreviewAvailable(projectPath: string): boolean {
  try {
    return fs.statSync(path.join(projectPath, SCRIPT)).isFile();
  } catch {
    return false;
  }
}

/** Is the dev server live right now? (pid file present + that process alive) */
export function isPreviewRunning(projectPath: string): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(path.join(projectPath, PIDF), "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return true;
  } catch {
    return false;
  }
}

/** Toggle the dev server via .orches-preview.sh (the script starts if down, stops if up).
 *  Returns whether it JUST started (vs stopped), from the pre-run state.
 *  Callers MUST gate on isPreviewAvailable() first. */
export function togglePreview(projectPath: string): { started: boolean } {
  const wasRunning = isPreviewRunning(projectPath);
  // The script's own output is the only place that says WHY it refused to boot
  // ("unknown stack", "npm install failed"). It used to go to stdio:"ignore", so a
  // failed start was indistinguishable from a slow one. Truncate per start: the
  // boot log describes THIS attempt only.
  let out: number | "ignore" = "ignore";
  try {
    out = fs.openSync(path.join(projectPath, BOOTLOG), "w");
  } catch {
    /* unwritable project dir — fall back to a silent start rather than not starting */
  }
  const child = cp.spawn("bash", [path.join(projectPath, SCRIPT)], {
    cwd: projectPath,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  if (typeof out === "number") {
    try {
      fs.closeSync(out);
    } catch {
      /* already closed */
    }
  }
  return { started: !wasRunning };
}

/** Last non-empty line the toggle script printed on this attempt — the message to show
 *  the user when no URL ever appeared. null = it left nothing behind. */
export function readPreviewBootError(projectPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(projectPath, BOOTLOG), "utf8");
  } catch {
    return null;
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length ? lines[lines.length - 1] : null;
}

/** Poll the preview log for the served URL.
 *  Returns null when the server never came up OR died right after printing its URL —
 *  callers must NOT open a browser then.
 *  ⛔ This used to return "http://localhost:3000" on timeout: a project whose toggle
 *  script exited 1 still opened a dead tab and reported "running" (noDB, 2026-08-19).
 *  A fabricated URL turns "it failed" into "it works but the page is broken".
 *
 *  `timeoutMs` is the wait for a quiet boot; while the script is still WRITING (a cold
 *  `npm install` can take minutes) the wait extends up to `hardCapMs`.
 */
export async function waitForPreviewUrl(
  projectPath: string,
  timeoutMs = 15000,
  hardCapMs = 300000,
): Promise<string | null> {
  const logPath = path.join(projectPath, LOGF);
  const bootPath = path.join(projectPath, BOOTLOG);
  const startedAt = Date.now();
  let lastSize = -1;
  let lastGrowth = startedAt;
  for (;;) {
    let text = "";
    try {
      text = fs.readFileSync(logPath, "utf8");
    } catch {
      /* log not written yet */
    }
    // ⛔ A URL in the log only proves the server PRINTED one. Real case (noDB,
    //   2026-08-19): port 3000 was taken, Next bounced to 3001, printed
    //   "Local: http://localhost:3001", then exited ("Another next dev server is
    //   already running") — the old code opened that dead 3001 tab. The pidfile is
    //   the liveness truth: the toggle script removes it when the server dies.
    const url = parsePreviewUrl(text);
    if (url && isPreviewRunning(projectPath)) return url;
    // progress = either file still growing (install/compile in flight)
    let size = text.length;
    try {
      size += fs.statSync(bootPath).size;
    } catch {
      /* no boot log (older projects) */
    }
    const now = Date.now();
    if (size !== lastSize) {
      lastSize = size;
      lastGrowth = now;
    }
    if (now - lastGrowth >= timeoutMs || now - startedAt >= hardCapMs) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}
