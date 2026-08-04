import { test, expect } from "bun:test";

import {
  buildAttachCommand,
  isSafeSessionName,
  parseTmuxSessions,
  parseOraclesJson,
  projectFromPaths,
  loneOracleName,
  teamOfOracle,
  computeSessionLabel,
  labelNamesProject,
  sessionForProjectLabel,
  sessionCanAttach,
  teamFromOrchesLabel,
  parseTmuxWindows,
  sessionIsIdle,
  sessionClients,
  pickAttachAction,
} from "./sessions";

test("parseTmuxWindows: parses index/name/cmd, preserves spaces in cmd", () => {
  const raw = "0\tforeman\tclaude\n1\tbuild\tpnpm dev\n2\tlogs\ttail -f app.log";
  expect(parseTmuxWindows(raw)).toEqual([
    { index: 0, name: "foreman", cmd: "claude" },
    { index: 1, name: "build", cmd: "pnpm dev" },
    { index: 2, name: "logs", cmd: "tail -f app.log" },
  ]);
});

test("parseTmuxWindows: tolerant — blank/short/non-numeric lines dropped, empty cmd ok", () => {
  expect(parseTmuxWindows("")).toEqual([]);
  expect(parseTmuxWindows("garbage")).toEqual([]); // <2 fields
  expect(parseTmuxWindows("x\ty\tz")).toEqual([]); // index not a number
  expect(parseTmuxWindows("3\tshell")).toEqual([{ index: 3, name: "shell", cmd: "" }]);
});

test("sessionIsIdle: bare single-window shell is idle; claude/maw or multi-window is not", () => {
  const S = (cmd: string, windows = 1) =>
    ({ name: "s", windows, attached: false, cmd, cwd: "" });
  expect(sessionIsIdle(S("bash"))).toBe(true);
  expect(sessionIsIdle(S("zsh"))).toBe(true);
  expect(sessionIsIdle(S("-bash"))).toBe(true); // login shell
  expect(sessionIsIdle(S("claude"))).toBe(false);
  expect(sessionIsIdle(S("maw"))).toBe(false);
  expect(sessionIsIdle(S("bash", 3))).toBe(false); // multi-window = real work
});

test("sessionCanAttach: true only when active pane runs claude", () => {
  expect(sessionCanAttach("claude")).toBe(true);
  expect(sessionCanAttach(" claude ")).toBe(true); // tolerant of stray ws
  expect(sessionCanAttach("bash")).toBe(false);
  expect(sessionCanAttach("maw")).toBe(false);
  expect(sessionCanAttach("")).toBe(false);
});

test("labelNamesProject: exact or '<basename> / …', never a prefix, false when undefined", () => {
  expect(labelNamesProject("rpn", "rpn")).toBe(true);
  expect(labelNamesProject("rpn / brew", "rpn")).toBe(true);
  expect(labelNamesProject("rpnx", "rpn")).toBe(false);
  expect(labelNamesProject("rpnx / t", "rpn")).toBe(false);
  expect(labelNamesProject(undefined, "rpn")).toBe(false);
});

test("sessionForProjectLabel: matches exact basename or '<basename> / team', never a prefix", () => {
  const S = (name: string, orchesLabel?: string) =>
    ({ name, windows: 1, attached: false, cmd: "claude", cwd: "", orchesLabel });
  const sessions = [S("05-bob"), S("09-foreman", "rpn / brew"), S("x", "rpnx / t")];
  expect(sessionForProjectLabel("rpn", sessions)?.name).toBe("09-foreman"); // "rpn / brew"
  expect(sessionForProjectLabel("rpn", [S("a", "rpn")])?.name).toBe("a"); // exact
  expect(sessionForProjectLabel("rpn", [S("a", "rpnx"), S("b", "rpnx / t")])).toBeNull(); // prefix ≠ match
  expect(sessionForProjectLabel("rpn", [S("a")])).toBeNull(); // no label
});

test("parseTmuxSessions parses tab-separated session lines (with orches label + window name cols)", () => {
  const raw =
    "carbon\t2\t1\tclaude\t\tmain\t/home/u/bob\n" +
    "soulbrew\t1\t0\tbash\tsci-calc / brew\tfrontend\t/home/u/sb\n" +
    "twin\t1\t2\tclaude\t\t\t/home/u/tw"; // 2 clients attached (session_attached is a COUNT), blank window name
  expect(parseTmuxSessions(raw)).toEqual([
    { name: "carbon", windows: 2, attached: true, clients: 1, cmd: "claude", windowName: "main", cwd: "/home/u/bob" },
    {
      name: "soulbrew",
      windows: 1,
      attached: false,
      clients: 0,
      cmd: "bash",
      orchesLabel: "sci-calc / brew",
      windowName: "frontend",
      cwd: "/home/u/sb",
    },
    { name: "twin", windows: 1, attached: true, clients: 2, cmd: "claude", cwd: "/home/u/tw" },
  ]);
});

test("parseTmuxSessions tolerates empty and non-format output", () => {
  expect(parseTmuxSessions("")).toEqual([]);
  expect(parseTmuxSessions("no server running on /tmp/tmux-1000/default")).toEqual([]);
  expect(parseTmuxSessions("\n\n")).toEqual([]);
});

test("isSafeSessionName accepts normal names, rejects injection", () => {
  expect(isSafeSessionName("carbon")).toBe(true);
  expect(isSafeSessionName("my-team_1")).toBe(true);
  expect(isSafeSessionName("")).toBe(false);
  expect(isSafeSessionName("a'; rm -rf ~ #")).toBe(false);
  expect(isSafeSessionName("a\nb")).toBe(false);
  expect(isSafeSessionName('q"x')).toBe(false);
});

test("buildAttachCommand single-quotes the name with exact-match prefix", () => {
  // "=" forces exact target matching — plain names prefix-match in tmux, which
  // can attach/kill a different session once the exact one is gone.
  expect(buildAttachCommand("carbon")).toBe("tmux attach -t '=carbon'");
});

test("parseOraclesJson returns oracle names, tolerant of junk", () => {
  expect(parseOraclesJson('{"oracles":[{"name":"bob"},{"name":"foreman"},{"x":1}]}')).toEqual(["bob", "foreman"]);
  expect(parseOraclesJson("not json")).toEqual([]);
  expect(parseOraclesJson("{}")).toEqual([]);
});

test("projectFromPaths finds a projects/<name> dir from any pane cwd", () => {
  expect(projectFromPaths(["/x/foreman-oracle", "/x/projects/scientific-calculator/agents/frontend"]))
    .toEqual({ name: "scientific-calculator", path: "/x/projects/scientific-calculator" });
  expect(projectFromPaths(["/x/projects/rpn"])).toEqual({ name: "rpn", path: "/x/projects/rpn" });
  expect(projectFromPaths(["/home/u/foreman-oracle"])).toBeNull();
  expect(projectFromPaths([])).toBeNull();
});

test("loneOracleName: single window whose SESSION name resolves to a known oracle", () => {
  const oracles = ["bob", "foreman"];
  expect(loneOracleName({ name: "05-bob", windows: 1, attached: false, cmd: "claude", cwd: "" }, oracles)).toBe("bob");
  expect(loneOracleName({ name: "claude-bob", windows: 1, attached: false, cmd: "claude", cwd: "" }, oracles)).toBe("bob");
  // multi-window → not a lone oracle
  expect(loneOracleName({ name: "05-bob", windows: 3, attached: false, cmd: "claude", cwd: "" }, oracles)).toBeNull();
  // unknown stem → null
  expect(loneOracleName({ name: "claude-soulbrew", windows: 1, attached: false, cmd: "bash", cwd: "" }, oracles)).toBeNull();
});

test("loneOracleName: session name is the TEAM (team-up sessions) → resolves via WINDOW name instead", () => {
  const oracles = ["bob", "mike"];
  // `maw team up` sessions are named after the team ("brew", or minted "brew-2"),
  // not the oracle — only the single window is renamed to the bare oracle.
  expect(
    loneOracleName({ name: "brew", windows: 1, attached: false, cmd: "claude", windowName: "mike", cwd: "" }, oracles),
  ).toBe("mike");
  expect(
    loneOracleName({ name: "brew-2", windows: 1, attached: false, cmd: "claude", windowName: "bob", cwd: "" }, oracles),
  ).toBe("bob");
  // multi-window team session → still not a lone oracle, even with a window name
  expect(
    loneOracleName(
      { name: "brew", windows: 2, attached: false, cmd: "claude", windowName: "mike", cwd: "" },
      oracles,
    ),
  ).toBeNull();
  // window name doesn't resolve to a known oracle → null (session-name stem "brew" isn't one either)
  expect(
    loneOracleName(
      { name: "brew", windows: 1, attached: false, cmd: "claude", windowName: "_boot", cwd: "" },
      oracles,
    ),
  ).toBeNull();
});

test("teamOfOracle picks first team by name containing the oracle", () => {
  const teams = [
    { name: "carbon", members: [{ oracle: "bob", role: "member" }], orchestrators: [] },
    { name: "brew", members: [{ oracle: "bob", role: "member" }], orchestrators: [] },
    { name: "orch-dev", members: [{ oracle: "foreman", role: "orchestrator" }], orchestrators: ["foreman"] },
  ];
  expect(teamOfOracle("bob", teams)).toBe("brew"); // alphabetical: brew < carbon
  expect(teamOfOracle("mike", teams)).toBeNull();
});

test("computeSessionLabel priority: orchesLabel > project > loneOracle > rawName", () => {
  // rule 1
  expect(computeSessionLabel({ orchesLabel: "sci-calc / brew", rawName: "09-foreman" })).toBe("sci-calc / brew");
  expect(computeSessionLabel({ orchesLabel: "  ", project: { name: "p" }, rawName: "r" })).toBe("p"); // blank label ignored
  // rule 2
  expect(computeSessionLabel({ project: { name: "rpn", team: "brew" }, rawName: "09-foreman" })).toBe("rpn / brew");
  expect(computeSessionLabel({ project: { name: "rpn" }, rawName: "09-foreman" })).toBe("rpn"); // no team
  // rule 3
  expect(computeSessionLabel({ loneOracle: { oracle: "bob", team: "brew" }, rawName: "05-bob" })).toBe("brew / bob");
  expect(computeSessionLabel({ loneOracle: { oracle: "bob" }, rawName: "05-bob" })).toBe("bob"); // no team
  // rule 4
  expect(computeSessionLabel({ rawName: "claude-soulbrew" })).toBe("claude-soulbrew");
});

test("teamFromOrchesLabel: recovers team from '<project> / <team>', else undefined", () => {
  expect(teamFromOrchesLabel("rpn / brew", "rpn")).toBe("brew");
  expect(teamFromOrchesLabel("learningPlatform / carbon", "learningPlatform")).toBe("carbon");
  expect(teamFromOrchesLabel("rpn", "rpn")).toBeUndefined(); // bare project, no team
  expect(teamFromOrchesLabel("rpnx / brew", "rpn")).toBeUndefined(); // different project (no prefix match)
  expect(teamFromOrchesLabel(undefined, "rpn")).toBeUndefined();
  expect(teamFromOrchesLabel("rpn / ", "rpn")).toBeUndefined(); // blank team
  expect(teamFromOrchesLabel("  rpn / brew  ", "rpn")).toBe("brew"); // tolerant of stray ws
});

// ── click→attach: reuse an open tab ONLY while it is still attached to tmux ────
// ⛔ บั๊กจริง (run agentskill-marketplace-newflow4, 2026-08-04): เงื่อนไข reuse เดิม
//    เช็คแค่ `terminal.exitStatus === undefined` = "แท็บยังไม่ตาย" ซึ่งไม่ใช่คำถามที่ถูก —
//    เมื่อ `tmux attach` ในแท็บนั้นจบไป (detach / session ตายแล้วเปิดใหม่ / กด prefix-d)
//    แท็บยังเปิดอยู่เป็นเชลล์เปล่า → คลิกครั้งต่อไปแค่ show() แท็บซาก แล้ว return
//    **ไม่ยิง attach ใหม่อีกเลย** = "กดแล้วไม่มีอะไรขึ้น" ตลอดกาล
//    ของจริงที่วัดได้: session_attached 1 -> 0 ระหว่างรัน แล้วกดจาก dashboard ไม่ขึ้น
//    คำถามที่ถูกคือ "ตอนนี้มี client เกาะ session อยู่ไหม" → clients > 0 = focus พอ,
//    clients == 0 = แท็บเป็นซาก ต้องยิง attach ซ้ำ, ไม่มีแท็บ = สร้างใหม่
test("parseTmuxSessions: clients = จำนวน client จริง (ไม่ใช่แค่ boolean)", () => {
  const raw = [
    "a\t1\t0\tclaude\t\tw\t/p", // detached
    "b\t2\t1\tclaude\t\tw\t/p", // 1 client
    "c\t1\t2\tbash\t\tw\t/p", // 2 clients (dashboard + orchestrator tab)
  ].join("\n");
  const s = parseTmuxSessions(raw);
  expect(s.map((x) => x.clients)).toEqual([0, 1, 2]);
  expect(s.map((x) => x.attached)).toEqual([false, true, true]); // เดิมยังต้องถูก
});

test("parseTmuxSessions: clients ที่อ่านไม่ออก → 0 (ไม่ใช่ NaN)", () => {
  expect(parseTmuxSessions("a\t1\t\tclaude\t\tw\t/p")[0].clients).toBe(0);
  expect(parseTmuxSessions("a\t1\tzz\tclaude\t\tw\t/p")[0].clients).toBe(0);
});

test("sessionClients: หาจำนวน client ตามชื่อ, ไม่เจอ = -1 (session ตายแล้ว)", () => {
  const list = [
    { name: "09-foreman", clients: 0 },
    { name: "carbon", clients: 2 },
  ];
  expect(sessionClients(list, "09-foreman")).toBe(0);
  expect(sessionClients(list, "carbon")).toBe(2);
  expect(sessionClients(list, "gone")).toBe(-1);
  expect(sessionClients([], "09-foreman")).toBe(-1);
  // ⛔ ต้องเทียบชื่อแบบตรงตัว — tmux prefix-match เคยทำให้ kill ผิด session มาแล้ว
  expect(sessionClients(list, "09-forem")).toBe(-1);
});

test("pickAttachAction: reuse ได้เฉพาะตอนยัง attach อยู่จริง", () => {
  // ไม่มีแท็บ = เปิดใหม่
  expect(pickAttachAction(false, 1)).toBe("create");
  expect(pickAttachAction(false, 0)).toBe("create");
  // มีแท็บ + ยังมี client เกาะ = โฟกัสแท็บนั้นพอ (ห้ามยิง attach ซ้ำ — client ที่ 2
  // จะทำ tmux ย่อ window ตามจอที่เล็กกว่า + จุดสถานะกระพริบ)
  expect(pickAttachAction(true, 1)).toBe("focus");
  expect(pickAttachAction(true, 3)).toBe("focus");
  // มีแท็บ แต่ไม่มี client = แท็บซาก -> ต้อง attach ใหม่ (นี่คือบั๊กที่แก้)
  expect(pickAttachAction(true, 0)).toBe("reattach");
  // session ไม่อยู่ในลิสต์แล้ว = ตายไปแล้ว -> ห้าม attach (จะขึ้น can't find session)
  expect(pickAttachAction(true, -1)).toBe("gone");
  expect(pickAttachAction(false, -1)).toBe("gone");
});
