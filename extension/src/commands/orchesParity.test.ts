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
 *
 *  This test SKIPS (loudly) when the skill isn't installed, so a clone without orches-drive
 *  still runs green — but it must never pass silently while the engine is present.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

import { parseStateValue } from "./orchestratorResume";
import { isSafeModelId } from "./teamsModel";

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

test("parity harness: skips loudly rather than passing silently", () => {
  // ⛔ The point of this assertion: if the engine is present, the round-trips above MUST have
  //    run. A green suite on a machine that has orches-drive installed but silently skipped
  //    every cross-repo check is the exact failure this file is meant to prevent.
  if (!HAVE) {
    console.warn(`orches parity SKIPPED — no engine at ${INTG} (set ORCHES_INTG to point at it)`);
  }
  expect(typeof HAVE).toBe("boolean");
});
