import { expect, test } from "bun:test";

import {
  buildKillCmd,
  canKillGroup,
  canKillMcService,
  classifyMcService,
  isProtectedComm,
} from "./localhostKill";

const ROOT = "/home/u/github.com/owner/projects";

test("isProtectedComm: shells / editor / tmux / init are protected", () => {
  ["code", "tmux", "bash", "-bash", "zsh", "sh", "systemd", "init"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(true),
  );
  ["node", "next-server", "uvicorn", "python3"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(false),
  );
});

test("canKillGroup: only pgid>1, non-protected leader, leader cwd under project", () => {
  expect(canKillGroup(15371, `${ROOT}/learningPlatform`, "node", ROOT)).toBe(true);
  expect(canKillGroup(15371, null, "node", ROOT)).toBe(true); // leader gone → allow (pgid>1)
  expect(canKillGroup(1, `${ROOT}/x`, "node", ROOT)).toBe(false); // pgid<=1
  expect(canKillGroup(0, `${ROOT}/x`, "node", ROOT)).toBe(false);
  expect(canKillGroup(15371, "/home/u", "node", ROOT)).toBe(false); // cwd outside project
  expect(canKillGroup(15371, `${ROOT}/x`, "code", ROOT)).toBe(false); // protected comm
});

test("buildKillCmd: TERM / KILL to the negative pgid (whole group)", () => {
  expect(buildKillCmd(15371, false)).toBe("kill -TERM -15371");
  expect(buildKillCmd(15371, true)).toBe("kill -KILL -15371");
});

test("classifyMcService: only OUR vendored/caged CCS (never a lookalike)", () => {
  const ccs =
    "node /home/u/.mc/vendor/ccs/node_modules/@kaitranntt/ccs/dist/ccs.js config";
  expect(classifyMcService(ccs)).toEqual({ id: "ccs", label: "CCS dashboard" });
  // a globally-installed / different-path ccs is NOT ours → not surfaced/stoppable
  expect(classifyMcService("node /usr/local/lib/node_modules/@kaitranntt/ccs/dist/ccs.js config")).toBeNull();
  expect(classifyMcService("node /home/u/project/server.js")).toBeNull();
  expect(classifyMcService("")).toBeNull();
});

test("canKillMcService: needs a real group, non-protected leader, MC-service args", () => {
  const ccs = "node /home/u/.mc/vendor/ccs/node_modules/@kaitranntt/ccs/dist/ccs.js config";
  expect(canKillMcService(275578, "node", ccs)).toBe(true);
  expect(canKillMcService(1, "node", ccs)).toBe(false); // pgid<=1
  expect(canKillMcService(275578, "bash", ccs)).toBe(false); // protected leader (shell-led group)
  expect(canKillMcService(275578, "node", "node /home/u/x/server.js")).toBe(false); // not an MC service
});
