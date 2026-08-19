import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isPreviewAvailable,
  isPreviewRunning,
  parsePreviewUrl,
  readPreviewBootError,
  togglePreview,
  waitForPreviewUrl,
} from "./previewOps";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-preview-"));
}

test("parsePreviewUrl: Next / Vite / Django logs, 0.0.0.0 normalized to localhost", () => {
  expect(parsePreviewUrl("▲ Next.js 15\n- Local: http://localhost:3000")).toBe(
    "http://localhost:3000",
  );
  expect(parsePreviewUrl("➜  Local:   http://localhost:5173/")).toBe(
    "http://localhost:5173",
  );
  expect(parsePreviewUrl("Starting development server at http://127.0.0.1:8000/")).toBe(
    "http://localhost:8000",
  );
  expect(parsePreviewUrl("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)")).toBe(
    "http://localhost:8000",
  );
  expect(parsePreviewUrl("no url here")).toBeNull();
});

test("isPreviewAvailable: true only when .orches-preview.sh exists", () => {
  const p = tmp();
  expect(isPreviewAvailable(p)).toBe(false);
  fs.writeFileSync(path.join(p, ".orches-preview.sh"), "#!/usr/bin/env bash\n");
  expect(isPreviewAvailable(p)).toBe(true);
});

test("isPreviewRunning: alive pid true, missing/bogus pid false", () => {
  const p = tmp();
  expect(isPreviewRunning(p)).toBe(false); // no pid file
  fs.writeFileSync(path.join(p, ".orches-preview.pid"), String(process.pid));
  expect(isPreviewRunning(p)).toBe(true); // this test process is alive
  fs.writeFileSync(path.join(p, ".orches-preview.pid"), "2147480000"); // almost surely dead
  expect(isPreviewRunning(p)).toBe(false);
});

test("waitForPreviewUrl: returns URL already present in the log", async () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, ".orches-preview.log"), "ready - http://localhost:4321");
  expect(await waitForPreviewUrl(p, 2000)).toBe("http://localhost:4321");
});

// The dev server never came up. Returning a made-up :3000 opened a dead tab and
// reported "running" — the exact shape of the noDB report (2026-08-19): the toggle
// script exited 1 ("unknown stack") and Mission Control still opened a browser.
// No URL = say so; the caller shows the script's own error instead.
test("waitForPreviewUrl: null on timeout — never invents a URL", async () => {
  const p = tmp();
  expect(await waitForPreviewUrl(p, 300)).toBeNull();
});

test("waitForPreviewUrl: keeps waiting past the base timeout while the boot log grows", async () => {
  const p = tmp();
  const boot = path.join(p, ".orches-preview.boot.log");
  fs.writeFileSync(boot, "npm install...\n");
  const t = setInterval(() => {
    fs.appendFileSync(boot, "still installing\n");
  }, 100);
  setTimeout(() => {
    clearInterval(t);
    fs.writeFileSync(path.join(p, ".orches-preview.log"), "- Local: http://localhost:5173");
  }, 700);
  const url = await waitForPreviewUrl(p, 300, 5000);
  clearInterval(t);
  expect(url).toBe("http://localhost:5173");
});

test("waitForPreviewUrl: a static boot log does not extend the wait", async () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, ".orches-preview.boot.log"), "unknown stack\n");
  const t0 = Date.now();
  expect(await waitForPreviewUrl(p, 300, 5000)).toBeNull();
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("readPreviewBootError: last non-empty line of the boot log, null when clean", () => {
  const p = tmp();
  expect(readPreviewBootError(p)).toBeNull(); // no boot log yet
  fs.writeFileSync(
    path.join(p, ".orches-preview.boot.log"),
    "\u0e44\u0e21\u0e48\u0e23\u0e39\u0e49\u0e08\u0e31\u0e01 stack \u2014 \u0e41\u0e01\u0e49 CMD \u0e43\u0e19 .orches-preview.sh \u0e40\u0e2d\u0e07\n\n",
  );
  expect(readPreviewBootError(p)).toContain("stack");
});

// The script's own stdout/stderr used to go to stdio:"ignore" — when it refused to
// boot, nothing anywhere recorded why. It has to land in a file the UI can read back.
test("togglePreview: captures the script's own output into the boot log", async () => {
  const p = tmp();
  fs.writeFileSync(
    path.join(p, ".orches-preview.sh"),
    "#!/usr/bin/env bash\necho 'boom on stdout'\necho 'boom on stderr' >&2\nexit 1\n",
  );
  togglePreview(p);
  const boot = path.join(p, ".orches-preview.boot.log");
  for (let i = 0; i < 60 && !fs.existsSync(boot); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  let text = "";
  for (let i = 0; i < 60; i++) {
    text = fs.readFileSync(boot, "utf8");
    if (text.includes("stderr")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(text).toContain("boom on stdout");
  expect(text).toContain("boom on stderr");
});
