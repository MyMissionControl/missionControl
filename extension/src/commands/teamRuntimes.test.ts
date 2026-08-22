import { expect, test } from "bun:test";
import {
  isSafeRuntimeId,
  parseTeamMemory,
  parseTeamRuntimes,
  serializeTeamMemory,
  serializeTeamRuntimes,
  teamMemoryFile,
  teamRuntimesFile,
  rosterToSidecars,
} from "./teamRuntimes";

// ── file locations are a CROSS-REPO contract ────────────────────────────────
// The orches engine reads these exact two paths (_orches_teams_dir defaults to
// ~/.claude/teams). Renaming either silently changes which worker gets which CLI
// with no error anywhere — the run just quietly bills the wrong subscription.
test("sidecars live next to models.json under ~/.claude/teams/<team>/", () => {
  expect(teamRuntimesFile("brew").replace(process.env.HOME ?? "~", "~")).toBe(
    "~/.claude/teams/brew/runtimes.json",
  );
  expect(teamMemoryFile("brew").replace(process.env.HOME ?? "~", "~")).toBe(
    "~/.claude/teams/brew/memory.json",
  );
});

// ── runtime id guard ─────────────────────────────────────────────────────────
// This value is interpolated into a shell command line that gets typed into a
// tmux pane. The bash side accepts ^[a-z][a-z0-9-]*$ and nothing else; anything
// this guard lets through that bash rejects becomes a worker that silently falls
// back to claude, and anything bash would accept that this rejects is a picker
// that cannot save a legal value.
const RUNTIME_CASES: [string, boolean][] = [
  ["claude", true],
  ["codex", true],
  ["gemini-cli", true],
  ["a", true],
  // ⛔ uppercase is ACCEPTED and normalized, not rejected: the engine lowercases
  //    before its charset check, so rejecting here would make the two sides
  //    disagree about the same hand-edited file (orchesParity caught exactly this).
  ["Codex", true],
  ["  codex  ", true], // trimmed
  ["1codex", false], // must start with a letter
  ["-codex", false],
  ["codex_cli", false], // underscore is not in the bash charset
  ["codex;rm -rf /", false],
  ["codex x", false],
  ["codex$(id)", false],
  ["codex`id`", false],
  ["", false],
  ["c".repeat(41), false],
];
for (const [id, ok] of RUNTIME_CASES) {
  test(`isSafeRuntimeId(${JSON.stringify(id)}) === ${ok}`, () => {
    expect(isSafeRuntimeId(id)).toBe(ok);
  });
}

// ── parse: a bad file must degrade, never throw ──────────────────────────────
test("parseTeamRuntimes drops unsafe/non-string values and survives garbage", () => {
  expect(parseTeamRuntimes('{"a":"codex","b":"","c":123,"d":"bad id","e":null}')).toEqual({
    a: "codex",
  });
  expect(parseTeamRuntimes("not json")).toEqual({});
  expect(parseTeamRuntimes("[1,2]")).toEqual({});
  expect(parseTeamRuntimes('{"a":"  Codex  "}')).toEqual({ a: "codex" }); // trimmed + lowercased
});

// ⛔ memory grants a privilege, so a malformed file must fail CLOSED (nobody gets
//    it), the opposite of the runtime map which fails open to "everyone claude".
test("parseTeamMemory fails closed on garbage and only counts a real true", () => {
  expect(parseTeamMemory('{"a":true,"b":false,"c":"on","d":"no","e":1}')).toEqual({
    a: true,
    c: true,
  });
  expect(parseTeamMemory("not json")).toEqual({});
  expect(parseTeamMemory('{"a":"maybe"}')).toEqual({});
});

// ── serialize: "default" must have exactly ONE representation ────────────────
// If "claude" were written out, two files would carry the same fact and could
// disagree; if `false` were written, absent-key and false-key would be two ways
// to spell off and every reader would need to know both.
test("serializeTeamRuntimes prunes empty and the claude default", () => {
  expect(JSON.parse(serializeTeamRuntimes({ a: "codex", b: "claude", c: "", d: "bad id" }))).toEqual(
    { a: "codex" },
  );
});
test("serializeTeamMemory keeps only explicit true", () => {
  expect(JSON.parse(serializeTeamMemory({ a: true, b: false }))).toEqual({ a: true });
});

// ── the roster projection is roster-shaped, not diff-shaped ────────────────
// ⛔ Tested on the PURE projection, never through writeTeamRuntimeSidecars: that
//    one calls os.homedir(), which does NOT follow a reassigned process.env.HOME
//    in bun — an earlier version of this test wrote into the real
//    ~/.claude/teams/t/ and had to be cleaned up by hand. A unit test must not be
//    able to touch the user's live config, so the fs layer stays untested here and
//    the interesting rule lives in a function that has no fs at all.
test("rosterToSidecars: only non-default values become keys", () => {
  expect(
    rosterToSidecars([
      { oracle: "bob", runtime: "codex", memory: true },
      { oracle: "jack", runtime: "claude", memory: false },
    ]),
  ).toEqual({ runtimes: { bob: "codex", jack: "claude" }, memory: { bob: true } });
});

test("rosterToSidecars: the REVOKE case — off must erase, not persist", () => {
  // A diff-based writer would keep bob's grant ("nothing changed for jack") and the
  // user's un-tick would silently not take effect. Serializing the full projection
  // is what makes absent-key the one and only spelling of off.
  const after = rosterToSidecars([
    { oracle: "bob", runtime: "claude", memory: false },
    { oracle: "jack", runtime: "codex", memory: true },
  ]);
  expect(JSON.parse(serializeTeamRuntimes(after.runtimes))).toEqual({ jack: "codex" });
  expect(JSON.parse(serializeTeamMemory(after.memory))).toEqual({ jack: true });
  expect(Object.keys(JSON.parse(serializeTeamMemory(after.memory)))).not.toContain("bob");
});

test("rosterToSidecars skips rows with no oracle name", () => {
  expect(rosterToSidecars([{ runtime: "codex", memory: true }, { oracle: "" }])).toEqual({
    runtimes: {},
    memory: {},
  });
});
