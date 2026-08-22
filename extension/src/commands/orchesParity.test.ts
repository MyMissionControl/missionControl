/**  Cross-repo parity: orches-drive (bash) writes it, MissionControl (TS) reads it.
 *
 *  WHY this file exists — "two surfaces, one kernel". The `.orches-*` files are a CONTRACT
 *  between two codebases that share no code: `orches-integrate.sh` writes them, this extension
 *  parses them. Each side has its own parser. Nothing today proves the two agree, and a
 *  disagreement is invisible: MC just silently shows a slightly different value than the drive
 *  is acting on. That already bit us once — a divergent model-id regex dropped `opus[1m]`
 *  for every worker, and the fix comment still sits at teamsModel.ts:224.
 *
 *  METHOD (repo convention, see the `mc-orches-dev-verify` skill): round-trip. Write with the
 *  REAL bash verb, read with the REAL TS parser, assert they agree. NOT hand-written fixture
 *  strings on both sides — that would only prove both match a string I invented, which is how
 *  you get two parsers that agree with the fixture and disagree with each other.
 *
 *  SCOPE: the pairs that exist today —
 *    (1) `.orches-state`  bash cmd_state_get      <-> TS parseStateValue
 *    (2) model id guard   bash cmd_worker_model   <-> TS isSafeModelId
 *    (3) heartbeat clock  bash `date +%FT%T`/-d   <-> TS heartbeatAgeMs
 *    (4) stale threshold  bash ORCHES_HEARTBEAT_STALE <-> TS HEARTBEAT_STALE_SEC
 *    (5) status vocabulary  every `status <v>` the engine writes <-> TS OrchesStatus
 *    (6) runtime sidecar  bash cmd_worker_runtime <-> TS parse/serializeTeamRuntimes
 *    (7) memory sidecar   bash cmd_worker_memory  <-> TS parse/serializeTeamMemory
 *
 *  This test SKIPS (loudly) when the skill isn't installed, so a clone without orches-drive
 *  still runs green — but it must never pass silently while the engine is present.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

import { HEARTBEAT_STALE_SEC, heartbeatAgeMs, readOrchesState } from "./orchesSignals";
import { parseStateValue } from "./orchestratorResume";
import { isSafeModelId } from "./teamsModel";
import {
  isSafeRuntimeId,
  parseTeamMemory,
  parseTeamRuntimes,
  rosterToSidecars,
  serializeTeamMemory,
  serializeTeamRuntimes,
} from "./teamRuntimes";

// ⛔ mkdtempSync ทิ้งโฟลเดอร์ไว้ตลอดกาล: สวีตนี้เปิด 5 ที่ ⇒ ทุกครั้งที่รัน `bun test src` /tmp โตขึ้น 5 dir
//   (เจอจริง 2026-08-19: /tmp มี orches-parity-* ค้าง 16 dir จากการรันวันเดียว)
const TMPDIRS: string[] = [];
function tmpProj(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMPDIRS.push(d);
  return d;
}
afterAll(() => {
  for (const d of TMPDIRS) rmSync(d, { recursive: true, force: true });
});

const INTG = process.env.ORCHES_INTG || join(homedir(), ".claude/skills/orches-drive/orches-integrate.sh");
const HAVE = existsSync(INTG);

function engine(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("bash", [INTG, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).replace(/\n$/, "");
}

/** Values the engine actually stores. Each must survive bash->disk->both parsers identically. */
const STATE_CASES: Array<[name: string, key: string, value: string]> = [
  ["plain", "team", "brew"],
  ["sprint fraction", "sprint", "2/5"],
  ["ISO timestamp keeps its colons", "heartbeat", "2026-08-03T01:57:33"],
  ["verdict@epoch (what _poll_stamp writes)", "poll-result-api", "SILENT_EXIT@1754180283"],
  ["thai text", "status", "กำลังรอ worker"],
  ["path value", "owner-session", "/home/x/.claude/projects/p"],
  ["empty value", "blank", ""],
  ["inner spaces", "note", "a  b   c"],
  // v-- the one that actually diverged: bash stripped only the LEADING space after ':',
  //     TS trims both ends. Reachable whenever a value comes from an unquoted $(...) capture.
  ["trailing space", "trailer", "done "],
  ["leading space", "leader", " done"],
];

test.if(HAVE)("state: bash writer -> both parsers read the same value", () => {
  const proj = tmpProj("orches-parity-");
  for (const [name, key, value] of STATE_CASES) {
    engine(["state-set", proj, key, value]);
    const raw = readFileSync(join(proj, ".orches-state"), "utf8");
    const fromBash = engine(["state-get", proj, key]);
    const fromTs = parseStateValue(raw, key) ?? "";
    expect(`${name}: ${JSON.stringify(fromTs)}`).toBe(`${name}: ${JSON.stringify(fromBash)}`);
  }
});

test.if(HAVE)("state: a key the engine never wrote is absent on both sides", () => {
  const proj = tmpProj("orches-parity-");
  engine(["state-set", proj, "team", "brew"]);
  const raw = readFileSync(join(proj, ".orches-state"), "utf8");
  expect(parseStateValue(raw, "nope")).toBeNull();
  expect(engine(["state-get", proj, "nope"])).toBe("");
});

test.if(HAVE)("state: last write wins on both sides (RMW keeps one row per key)", () => {
  const proj = tmpProj("orches-parity-");
  engine(["state-set", proj, "sprint", "1/3"]);
  engine(["state-set", proj, "sprint", "2/3"]);
  const raw = readFileSync(join(proj, ".orches-state"), "utf8");
  expect(parseStateValue(raw, "sprint")).toBe("2/3");
  expect(engine(["state-get", proj, "sprint"])).toBe("2/3");
  expect(raw.split("\n").filter((l) => l.startsWith("sprint:")).length).toBe(1);
});

/** Model ids: bash returns the id when it passes its SAFE guard, "" when it rejects.
 *  TS answers the same question as a boolean. Accept/reject must match id-for-id. */
const MODEL_CASES = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "opus[1m]", // bracketed context-window suffix IS a real spec Claude Code accepts
  "claude-haiku-4-5-20251001",
  "a.b_c-d",
  "bad id", // space
  "bad;id", // shell metachar
  "bad$(x)",
  "bad`x`",
  "opus[1m][2m]", // only ONE bracket group is legal
  "opus[]",
  "",
];

test.if(HAVE)("model id: bash guard and TS guard accept exactly the same ids", () => {
  const teams = tmpProj("orches-parity-teams-");
  for (const model of MODEL_CASES) {
    mkdirSync(join(teams, "t"), { recursive: true });
    writeFileSync(join(teams, "t", "models.json"), JSON.stringify({ w: model }));
    const bashAccepts = engine(["worker-model", "t", "w"], { ORCHES_TEAMS_DIR: teams }) !== "";
    expect(`${JSON.stringify(model)} -> ${isSafeModelId(model)}`).toBe(
      `${JSON.stringify(model)} -> ${bashAccepts}`,
    );
  }
});

// ── heartbeat: the engine stamps `date +%FT%T` (local, NO offset) and reads it back
//    with `date -d`. MC now derives an age from the same string. A format or clock
//    disagreement here is exactly the invisible kind: MC would just call a live run
//    hung, or never call a hung one hung.
//    ⛔ TZ is pinned to UTC for BOTH sides because `bun test` forces the JS clock to UTC
//      (measured: getTimezoneOffset() === 0 inside bun test, -420 under plain `bun` on
//      this +07 box) while a child `date` would read /etc/timezone. That is a harness
//      artifact, not the product: the real-zone reading is proven by orchesSignals'
//      H4, which spawns a child in Asia/Bangkok on purpose.
const UTC_ENV = { ...process.env, TZ: "UTC" };
function shell(args: string[]): string {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8", env: UTC_ENV }).trim();
}

test.if(HAVE)("heartbeat: MC's epoch == bash's `date -d` epoch, to the second", () => {
  const proj = tmpProj("orches-parity-hb-");
  const hb = shell(["date", "+%FT%T"]); // the engine's own producer
  engine(["state-set", proj, "heartbeat", hb]);
  const state = readOrchesState(proj);
  expect(state?.heartbeat).toBe(hb); // survives bash -> disk -> TS
  const bashEpoch = Number(shell(["date", "-d", hb, "+%s"])); // the engine's own reader
  const now = Date.now();
  const age = heartbeatAgeMs(state?.heartbeat ?? null, now);
  expect(age).not.toBeNull();
  expect(Math.round((now - (age as number)) / 1000)).toBe(bashEpoch);
});

test.if(HAVE)("stale threshold: MC's default is the engine's ORCHES_HEARTBEAT_STALE default", () => {
  const sh = readFileSync(INTG, "utf8");
  const m = /ORCHES_HEARTBEAT_STALE="\$\{ORCHES_HEARTBEAT_STALE:-(\d+)\}"/.exec(sh);
  expect(m).not.toBeNull();
  expect(HEARTBEAT_STALE_SEC).toBe(Number(m![1]));
});

test.if(HAVE)("status vocabulary: MC knows every value the engine stamps into `status`", () => {
  // ⛔ Drift here fails QUIET: an unknown status parses to null, so a 4th value the
  //    engine starts writing would simply never be surfaced. Read the writers, do not
  //    trust a list copied by hand. Both writers count: the .sh AND SKILL.md's Layer C
  //    (`paused-checkpoint` is stamped ONLY from the skill, never from the script).
  const sources = [INTG, join(INTG, "..", "SKILL.md")].map((f) => readFileSync(f, "utf8")).join("\n");
  const written = new Set<string>();
  for (const m of sources.matchAll(/state[-_]set\s+"\$P(?:ROJ)?"\s+status\s+([a-z][a-z-]*)/g)) written.add(m[1]);
  expect([...written].sort()).toEqual(["done", "in-progress", "paused-checkpoint"]);
});

test("parity harness: skips loudly rather than passing silently", () => {
  // ⛔ The point of this assertion: if the engine is present, the round-trips above MUST have
  //    run. A green suite on a machine that has orches-drive installed but silently skipped
  //    every cross-repo check is the exact failure this file is meant to prevent.
  if (!HAVE) {
    console.warn(`orches parity SKIPPED — no engine at ${INTG} (set ORCHES_INTG to point at it)`);
  }
  expect(typeof HAVE).toBe("boolean");
});

// ── (6)(7) runtime + memory sidecars ─────────────────────────────────────────
//  These two decide WHICH agent CLI spends WHICH subscription for a given worker,
//  and whether that worker may reach oracle memory. MC's Team Config picker is the
//  only writer; the engine is the only reader. A disagreement here does not throw —
//  the worker just quietly becomes claude (wrong wallet) or quietly loses/keeps a
//  privilege the user just changed. Round-trip both directions with the real verbs.

const RUNTIME_ID_CASES = [
  "codex",
  "claude",
  "gemini-cli",
  "a",
  "Codex", // uppercase — bash charset is a-z only
  "1codex", // must start with a letter
  "-codex",
  "codex_cli", // underscore not in the bash charset
  "codex x",
  "codex;id",
  "codex$(id)",
  "codex`id`",
  "",
];

test.if(HAVE)("runtime id: bash guard and TS guard accept exactly the same ids", () => {
  const teams = tmpProj("orches-parity-runtimes-");
  for (const rt of RUNTIME_ID_CASES) {
    mkdirSync(join(teams, "t"), { recursive: true });
    writeFileSync(join(teams, "t", "runtimes.json"), JSON.stringify({ w: rt }));
    // bash falls back to the literal "claude" when the value is unusable, so
    // "accepted" means "came back as the value we wrote", not "non-empty".
    const got = engine(["worker-runtime", "t", "w"], { ORCHES_TEAMS_DIR: teams });
    const bashAccepts = got === rt.trim().toLowerCase() && got !== "";
    expect(`${JSON.stringify(rt)} -> ${isSafeRuntimeId(rt)}`).toBe(
      `${JSON.stringify(rt)} -> ${bashAccepts}`,
    );
  }
});

test.if(HAVE)("runtime sidecar: what MC writes is what the engine dispatches", () => {
  const teams = tmpProj("orches-parity-runtimes2-");
  mkdirSync(join(teams, "t"), { recursive: true });
  const { runtimes } = rosterToSidecars([
    { oracle: "bob", runtime: "codex" },
    { oracle: "jack", runtime: "claude" },
    { oracle: "mike" },
  ]);
  writeFileSync(join(teams, "t", "runtimes.json"), serializeTeamRuntimes(runtimes));
  const read = (w: string) => engine(["worker-runtime", "t", w], { ORCHES_TEAMS_DIR: teams });
  expect(read("bob")).toBe("codex");
  // ⛔ MC prunes "claude" on write because it is the engine's default. That is only
  //    correct if the engine really does answer "claude" for an absent key — pin it,
  //    or a future prune rule turns every claude worker into an unset one.
  expect(read("jack")).toBe("claude");
  expect(read("mike")).toBe("claude");
  // and the file really is pruned, not just read back leniently
  expect(JSON.parse(readFileSync(join(teams, "t", "runtimes.json"), "utf8"))).toEqual({
    bob: "codex",
  });
});

test.if(HAVE)("memory sidecar: MC's on/off round-trips through the engine verb", () => {
  const teams = tmpProj("orches-parity-memory-");
  mkdirSync(join(teams, "t"), { recursive: true });
  const on = rosterToSidecars([
    { oracle: "bob", runtime: "codex", memory: true },
    { oracle: "jack", runtime: "codex", memory: false },
  ]);
  writeFileSync(join(teams, "t", "memory.json"), serializeTeamMemory(on.memory));
  const read = (w: string) => engine(["worker-memory", "t", w], { ORCHES_TEAMS_DIR: teams });
  expect(read("bob")).toBe("on");
  expect(read("jack")).toBe("off");
  expect(read("nobody")).toBe("off");

  // ⛔⛔ THE REVOKE CASE — the one that matters. The user un-ticks bob in the panel;
  //    MC rewrites the sidecar from the full roster; the engine must now say off.
  //    If either side ever switched to a diff/merge write, this is what would catch
  //    it, and nothing else would: the grant would simply survive its own removal.
  const off = rosterToSidecars([
    { oracle: "bob", runtime: "codex", memory: false },
    { oracle: "jack", runtime: "codex", memory: false },
  ]);
  writeFileSync(join(teams, "t", "memory.json"), serializeTeamMemory(off.memory));
  expect(read("bob")).toBe("off");
  expect(readFileSync(join(teams, "t", "memory.json"), "utf8").trim()).toBe("{}");
});

test.if(HAVE)("memory sidecar: a garbage file must fail CLOSED on both sides", () => {
  const teams = tmpProj("orches-parity-memory2-");
  mkdirSync(join(teams, "t"), { recursive: true });
  for (const bad of ["not json", "[1,2]", '{"bob":"maybe"}', '{"bob":0}']) {
    writeFileSync(join(teams, "t", "memory.json"), bad);
    expect(`${bad} -> ${engine(["worker-memory", "t", "bob"], { ORCHES_TEAMS_DIR: teams })}`).toBe(
      `${bad} -> off`,
    );
    expect(parseTeamMemory(bad).bob === true).toBe(false);
  }
});

test.if(HAVE)("runtime sidecar: a garbage file must fail OPEN to claude on both sides", () => {
  // Opposite default from memory ON PURPOSE: an unreadable runtime map should still
  // let the run happen (as claude), while an unreadable memory map must never grant.
  const teams = tmpProj("orches-parity-runtimes3-");
  mkdirSync(join(teams, "t"), { recursive: true });
  for (const bad of ["not json", "[1,2]", '{"bob":123}', '{"bob":"bad id"}']) {
    writeFileSync(join(teams, "t", "runtimes.json"), bad);
    expect(`${bad} -> ${engine(["worker-runtime", "t", "bob"], { ORCHES_TEAMS_DIR: teams })}`).toBe(
      `${bad} -> claude`,
    );
    expect(parseTeamRuntimes(bad).bob ?? "claude").toBe("claude");
  }
});
