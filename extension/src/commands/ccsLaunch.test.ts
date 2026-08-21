import { expect, test } from "bun:test";
import { CCS_INSTALL_CMD, ccsLaunchCommand, ccsPaths, resolveCcsLaunch } from "./ccsLaunch";

const HOME = "/home/u";

test("ccsPaths: contained under ~/.mc (never global / never on PATH)", () => {
  const p = ccsPaths(HOME);
  expect(p.entry).toBe("/home/u/.mc/vendor/ccs/node_modules/@kaitranntt/ccs/dist/ccs.js");
  expect(p.cageHome).toBe("/home/u/.mc/ccs-home");
  expect(p.vendorRoot).toBe("/home/u/.mc/vendor/ccs");
});

test("resolveCcsLaunch: run when the entry exists", () => {
  const L = resolveCcsLaunch(HOME, (p) => p.endsWith("dist/ccs.js"));
  expect(L.kind).toBe("run");
  if (L.kind === "run") {
    expect(L.entry).toContain("@kaitranntt/ccs/dist/ccs.js");
    expect(L.cageHome).toBe("/home/u/.mc/ccs-home");
  }
});

test("resolveCcsLaunch: missing -> contained install cmd (not global)", () => {
  const L = resolveCcsLaunch(HOME, () => false);
  expect(L.kind).toBe("missing");
  if (L.kind === "missing") {
    expect(L.installCmd).toBe(CCS_INSTALL_CMD);
    expect(L.installCmd).toContain("--ignore-scripts");
    expect(L.installCmd).not.toContain("-g "); // never `npm i -g` / `bun add -g`
  }
});

// The cage is the whole safety story: HOME points at a private dir, so CCS cannot see
// the real ~/.claude. The command must carry it and must only open the dashboard.
test("ccsLaunchCommand: caged HOME inlined, opens dashboard, never sync", () => {
  const entry = "/home/u/.mc/vendor/ccs/node_modules/@kaitranntt/ccs/dist/ccs.js";
  const cmd = ccsLaunchCommand(entry, "/home/u/.mc/ccs-home");
  expect(cmd).toBe("HOME='/home/u/.mc/ccs-home' node '" + entry + "' config");
  expect(cmd).toContain("config");
  expect(cmd).not.toContain("sync");
});

test("ccsLaunchCommand: single-quotes survive a nasty path (no shell injection)", () => {
  const cmd = ccsLaunchCommand("/x/'; rm -rf ~/.claude; '/ccs.js", "/home/u/.mc/ccs-home");
  // the quote is escaped as '\'' so the whole arg stays one literal token
  expect(cmd).toContain("'/x/'\\''; rm -rf ~/.claude; '\\''/ccs.js'");
});
