import { expect, test } from "bun:test";

import {
  buildCloneKickoffNote,
  buildContinueKickoff,
  buildKickoffPrompt,
  buildPaneLayoutInitCommand,
  buildResumeKickoff,
  buildTmuxLaunchCommand,
  formatOrchesLabel,
  resolveOrchesLabel,
  isSafeOracleName,
  parseOraclePath,
  parseSessionPin,
  parseTeamRoster,
} from "./teams";

test("buildContinueKickoff: names the project path + drives ONE sprint via --once", () => {
  const k = buildContinueKickoff("demo", "/p/demo", "brew", "foreman", ["mike"]);
  expect(k).toContain("/p/demo");
  expect(k).toContain("--once");
  expect(k).toContain("/orches-drive");
  expect(k).not.toMatch(/--once \d/); // default (1) → bare --once, no count
});

test("buildContinueKickoff: sprints>1 → '--once N' + multi-sprint scope (no checkpoint)", () => {
  const k = buildContinueKickoff("demo", "/p/demo", "brew", "foreman", ["mike"], 3);
  expect(k).toContain("--once 3");
  expect(k).toContain("/p/demo");
  expect(k).toContain("3 sprint");
});

test("buildTmuxLaunchCommand: attach=false omits the trailing tmux attach", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", [], false);
  expect(cmd).toContain("new-session");
  expect(cmd).not.toContain("tmux attach");
});

test("buildTmuxLaunchCommand: default still attaches (unchanged behavior)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", []);
  expect(cmd).toContain("tmux attach");
});

// ⛔⛔ ghost text = ข้อความที่ Claude Code เดาว่าคนจะพิมพ์ต่อ แล้ววาดเป็น placeholder สีจาง
//    บนบรรทัด ❯ ของเพนที่ว่าง · engine ปิดมันให้ทุกเพนที่ตัวเองเปิดตั้งแต่ 2026-08-13
//    (orches-integrate.sh cmd_launch_env) แต่เพนที่ **MC เปิดเอง** ไม่ได้ผ่านทางนั้นเลย
//    MC คือคนที่เจ็บที่สุด: pendingAsk ส่งคีย์ `Right` ซึ่งเป็นปุ่ม accept ของ ghost text
//    และ `capture-pane -p` ตัดสีจางทิ้ง → อ่านเป็น "มีคนพิมพ์ค้างไว้"
test("buildTmuxLaunchCommand: ปิด ghost text ในเพนที่ MC เปิดเอง", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", [], false);
  expect(cmd).toContain("&& CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0 claude");
});

test("buildTmuxLaunchCommand: ปิด ghost text ด้วยแม้ตอนระบุ model", () => {
  const cmd = buildTmuxLaunchCommand(
    "foreman", "/x", "hi", "claude-foreman", [], false, undefined, "claude-sonnet-5",
  );
  expect(cmd).toContain("&& CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0 claude --model");
});

test("buildTmuxLaunchCommand: model → 'claude --model <model>' before --dangerously-skip-permissions", () => {
  const cmd = buildTmuxLaunchCommand(
    "foreman", "/x", "hi", "claude-foreman", [], false, undefined, "claude-sonnet-5",
  );
  expect(cmd).toContain("claude --model claude-sonnet-5 --dangerously-skip-permissions");
});

test("buildTmuxLaunchCommand: no model → bare claude, no --model (unchanged)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", [], false);
  expect(cmd).toContain("claude --dangerously-skip-permissions");
  expect(cmd).not.toContain("--model");
});

test("buildTmuxLaunchCommand: unsafe model string is ignored (no injection)", () => {
  const cmd = buildTmuxLaunchCommand(
    "foreman", "/x", "hi", "claude-foreman", [], false, undefined, "sonnet; rm -rf /",
  );
  expect(cmd).not.toContain("--model");
  expect(cmd).not.toContain("rm -rf");
});

test("parseSessionPin: finds pinned session for an oracle", () => {
  const cfg = JSON.stringify({ sessions: { foreman: "09-foreman", bob: "05-bob" } });
  expect(parseSessionPin(cfg, "foreman")).toBe("09-foreman");
  expect(parseSessionPin(cfg, "bob")).toBe("05-bob");
});

test("parseSessionPin: missing oracle / empty / bad JSON → null", () => {
  expect(parseSessionPin(JSON.stringify({ sessions: {} }), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({}), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({ sessions: { foreman: "  " } }), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({ sessions: { foreman: 42 } }), "foreman")).toBeNull();
  expect(parseSessionPin("{bad", "foreman")).toBeNull();
});

test("buildTmuxLaunchCommand: pinned session name wins over claude-<orch>", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "09-foreman");
  expect(cmd.startsWith("tmux new-session -A -d -s '09-foreman' -n 'foreman-oracle' '")).toBe(true);
  expect(cmd).not.toContain("claude-foreman");
});

test("buildTmuxLaunchCommand: blank pin falls back to claude-<orch>", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "  ");
  expect(cmd.startsWith("tmux new-session -A -d -s 'claude-foreman' -n 'foreman-oracle' '")).toBe(true);
});

test("formatOrchesLabel: '<project> / <team>', or bare project when no team", () => {
  expect(formatOrchesLabel("rpn", "brew")).toBe("rpn / brew");
  expect(formatOrchesLabel("rpn")).toBe("rpn");
  expect(formatOrchesLabel("rpn", "  ")).toBe("rpn"); // blank team ignored, not "rpn / "
});

test("resolveOrchesLabel: a known name (resume OR name-popup new build) → '<project> / <team>'", () => {
  expect(resolveOrchesLabel("rpn", "brew")).toBe("rpn / brew");
  expect(resolveOrchesLabel("  rpn  ", "brew")).toBe("rpn / brew"); // trimmed
});

test("resolveOrchesLabel: no name (nameless new build) → undefined (defer to orchestrator's runtime set)", () => {
  expect(resolveOrchesLabel(undefined, "brew")).toBeUndefined();
  expect(resolveOrchesLabel("", "brew")).toBeUndefined();
  expect(resolveOrchesLabel("   ", "brew")).toBeUndefined();
});

test("buildTmuxLaunchCommand: orchesLabel → session-scoped @orches_label set-option (NO '=' prefix)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "09-foreman", [], true, "rpn / brew");
  // set-option targets the SESSION with a PLAIN name — tmux 3.4 treats '=name' as
  // a literal name for set-option, so the '=' prefix (fine for has-session/attach)
  // must NOT appear here.
  expect(cmd).toContain("set-option -t '09-foreman' @orches_label 'rpn / brew'");
  expect(cmd).toContain("new-session"); // still creates the session
});

test("buildTmuxLaunchCommand: label set even when detached (attach=false — the continue button)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", [], false, "rpn / brew");
  expect(cmd).toContain("@orches_label");
  expect(cmd).not.toContain("tmux attach");
});

test("buildTmuxLaunchCommand: no orchesLabel → no set-option (unchanged behavior)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", []);
  expect(cmd).not.toContain("@orches_label");
});

test("parseTeamRoster: valid roster with an orchestrator", () => {
  const raw = JSON.stringify({
    name: "carbon",
    members: [
      { oracle: "bob", role: "member" },
      { oracle: "jack", role: "member" },
      { oracle: "foreman", role: "orchestrator" },
    ],
  });
  const t = parseTeamRoster("carbon", raw);
  expect(t).not.toBeNull();
  expect(t!.name).toBe("carbon");
  expect(t!.members.length).toBe(3);
  expect(t!.orchestrators).toEqual(["foreman"]);
});

test("parseTeamRoster: multiple orchestrators", () => {
  const raw = JSON.stringify({
    members: [
      { oracle: "foreman", role: "orchestrator" },
      { oracle: "captain", role: "orchestrator" },
      { oracle: "bob", role: "member" },
    ],
  });
  const t = parseTeamRoster("x", raw);
  expect(t!.orchestrators).toEqual(["foreman", "captain"]);
});

test("parseTeamRoster: no orchestrator → empty list", () => {
  const raw = JSON.stringify({ members: [{ oracle: "bob", role: "member" }] });
  const t = parseTeamRoster("x", raw);
  expect(t!.orchestrators).toEqual([]);
});

test("parseTeamRoster: bad JSON → null", () => {
  expect(parseTeamRoster("x", "{not json")).toBeNull();
});

test("parseTeamRoster: missing members array → null", () => {
  expect(parseTeamRoster("x", JSON.stringify({ name: "x" }))).toBeNull();
});

test("parseTeamRoster: skips members without a string oracle field", () => {
  const raw = JSON.stringify({
    members: [{ oracle: "bob", role: "member" }, { role: "orphan" }, null, 42],
  });
  const t = parseTeamRoster("x", raw);
  expect(t!.members.map((m) => m.oracle)).toEqual(["bob"]);
});

test("parseTeamRoster: member without role defaults to empty string", () => {
  const t = parseTeamRoster("x", JSON.stringify({ members: [{ oracle: "bob" }] }));
  expect(t!.members[0].role).toBe("");
});

test("isSafeOracleName: whitelist", () => {
  expect(isSafeOracleName("foreman")).toBe(true);
  expect(isSafeOracleName("orch-lead_2.0")).toBe(true);
  expect(isSafeOracleName("")).toBe(false);
  expect(isSafeOracleName("bad name")).toBe(false);
  expect(isSafeOracleName("evil;rm -rf")).toBe(false);
  expect(isSafeOracleName("$(whoami)")).toBe(false);
});

test("buildTmuxLaunchCommand: tmux new-session -A -d wrapping cd + fresh claude", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hello");
  expect(cmd.startsWith("tmux new-session -A -d -s 'claude-foreman' -n 'foreman-oracle' '")).toBe(true);
  expect(cmd).toContain("cd "); // inner: cd into the oracle repo
  expect(cmd).toContain("/p/foreman-oracle");
  expect(cmd).toContain("claude --dangerously-skip-permissions");
  expect(cmd).toContain("hello");
});

test("buildPaneLayoutInitCommand: workers → guarded pane-layout init", () => {
  const cmd = buildPaneLayoutInitCommand("09-foreman", "foreman-oracle", ["bob", "jack"]);
  expect(cmd).toContain("pane-layout.sh");
  expect(cmd).toContain("init '09-foreman' 'foreman-oracle' 'bob' 'jack'");
  expect(cmd).toContain('[ -x "$LAY" ]'); // graceful skip when the skill is absent
});

test("buildPaneLayoutInitCommand: no workers → empty (no buttons to show)", () => {
  expect(buildPaneLayoutInitCommand("09-foreman", "foreman-oracle", [])).toBe("");
});

test("buildTmuxLaunchCommand: workers → detached create, layout, then attach", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "09-foreman", [
    "bob",
    "john",
  ]);
  expect(cmd.startsWith("tmux new-session -A -d -s '09-foreman' -n 'foreman-oracle' '")).toBe(true);
  expect(cmd).toContain("init '09-foreman' 'foreman-oracle' 'bob' 'john'"); // layout wired in
  // trailing `true;` is deliberate (teams.ts:296) — keeps the `&& { … }` group exiting 0
  expect(cmd.trimEnd().endsWith("tmux attach -t '=09-foreman' ; true; }")).toBe(true);
});

test("buildTmuxLaunchCommand: no workers → detached+attach, no layout", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "09-foreman");
  expect(cmd).toContain("tmux new-session -A -d -s '09-foreman'");
  expect(cmd).not.toContain("pane-layout.sh");
  expect(cmd).toContain("tmux attach -t '=09-foreman'");
});

test("buildTmuxLaunchCommand: NO --continue (fresh session, not resume)", () => {
  expect(buildTmuxLaunchCommand("foreman", "/x", "hi")).not.toContain("--continue");
});

test("buildTmuxLaunchCommand: inner single-quotes survive shell round-trip", () => {
  // Structural check: the inner command's quotes must be escaped for the outer
  // single-quoted tmux arg — bash unwraps '\'' back into a literal '.
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "it's (fine)");
  expect(cmd).toContain("'\\''"); // escaped inner quote present
  expect(cmd).toContain("it"); // kickoff text carried through
  expect(cmd).toContain("(fine)");
});

test("parseOraclePath: finds local_path by name", () => {
  const raw = JSON.stringify({
    oracles: [
      { name: "bob", local_path: "/p/bob-oracle" },
      { name: "foreman", local_path: "/p/foreman-oracle" },
    ],
  });
  expect(parseOraclePath(raw, "foreman")).toBe("/p/foreman-oracle");
  expect(parseOraclePath(raw, "nope")).toBeNull();
});

test("parseOraclePath: bad JSON → null", () => {
  expect(parseOraclePath("{bad", "foreman")).toBeNull();
});

test("buildKickoffPrompt: names team/orchestrator/workers + runs drive not bootstrap", () => {
  const p = buildKickoffPrompt("carbon", "foreman", ["bob", "jack"]);
  expect(p).toContain("carbon");
  expect(p).toContain("foreman");
  expect(p).toContain("bob, jack");
  expect(p).toContain("/orches-drive");
  expect(p).toContain("อย่ารัน /orches"); // must NOT re-bootstrap
});

test("buildKickoffPrompt: no workers → hint text", () => {
  expect(buildKickoffPrompt("orch-dev", "foreman", [])).toContain("ยังไม่มี worker");
});

// "โหมดถาม" (grilling + scrutinize) ถูกถอดออกทั้งฟีเจอร์ 2026-08-05 — user สั่งเพราะไม่เคยได้ใช้
// และฝั่งสกิล /orches-drive ก็ถอดสายออกหมดแล้ว (ไฟล์สกิลยังอยู่ เก็บไว้ implement ที่อื่นในอนาคต)
// ⛔ เทสนี้ล็อกว่า kickoff **ต้องไม่** พา trigger ไปด้วย: ส่งคำที่ไม่มีใครอ่านแล้ว = โทเคนเปล่า +
//   ทำให้คนอ่าน prompt เข้าใจผิดว่าโหมดนี้ยังมีอยู่ · ห้ามต่อกลับโดยไม่มีคนสั่ง
test("kickoff ทั้งสองแบบไม่พา trigger โหมดถาม/grilling/scrutinize ไปด้วยอีก", () => {
  const fresh = buildKickoffPrompt("carbon", "foreman", ["bob"]);
  const resume = buildResumeKickoff("rpn", "/p/rpn", "carbon", "foreman", ["bob"]);
  for (const p of [fresh, resume]) {
    expect(p).not.toContain("โหมดถาม");
    expect(p).not.toContain("grilling");
    expect(p).not.toContain("scrutinize");
  }
});

test("buildCloneKickoffNote: บังคับ 'อ่านให้เข้าใจก่อนถาม' ไม่ใช่ถามทันที", () => {
  const n = buildCloneKickoffNote("my-proj", "/p/projects/my-proj", "https://github.com/o/r.git");
  expect(n).toContain("/p/projects/my-proj"); // path เป๊ะ — ห้าม prep ที่อื่น
  expect(n).toContain("README");
  expect(n).toContain("docs/wiki");
  expect(n).toMatch(/สรุป/); // สรุปให้ user ฟังก่อน
  // ลำดับต้องถูก ไม่ใช่แค่มีคำ: "อ่านก่อน" ต้องมาก่อน "ค่อยถาม" ในข้อความเดียวกัน
  expect(n).toContain("อย่าถาม requirement ทันที");
  expect(n.indexOf("อ่านให้เข้าใจจริงก่อน")).toBeLessThan(n.indexOf("ค่อยถาม"));
});

test("⛔ buildCloneKickoffNote: ต้องห้าม push ขึ้นต้นทางที่ clone มา", () => {
  const n = buildCloneKickoffNote("p", "/p/projects/p", "https://dev.azure.com/o/pr/_git/r");
  expect(n).toContain("upstream");
  expect(n).toMatch(/ห้าม.*push|push.*ห้าม/);
  expect(n).toContain("https://dev.azure.com/o/pr/_git/r"); // บอกด้วยว่าต้นทางคืออะไร
});

test("buildCloneKickoffNote: wiki สร้างได้แต่เขียนแค่ที่มั่นใจ", () => {
  const n = buildCloneKickoffNote("p", "/x", "https://github.com/o/r");
  expect(n).toMatch(/มั่นใจ/);
  expect(n).toMatch(/ห้ามเดา|อย่าเดา|ไม่เดา/);
});

test("buildCloneKickoffNote: ห้ามตั้งชื่อใหม่ / ห้าม prep ซ้ำที่อื่น", () => {
  const n = buildCloneKickoffNote("keep-this-name", "/x", "https://github.com/o/r");
  expect(n).toContain("keep-this-name");
  expect(n).toMatch(/ห้ามตั้งชื่อใหม่|ห้ามเปลี่ยนชื่อ/);
});
