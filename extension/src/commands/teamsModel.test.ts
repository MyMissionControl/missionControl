import { expect, test } from "bun:test";

import {
  MODELS_CACHE_TTL_MS,
  MODEL_ALIASES,
  awakenStatusFromClaudeMd,
  createArgs,
  deleteArgs,
  diffMembers,
  extractOauthToken,
  findDuplicateOracleNames,
  inviteArgs,
  isSafeModelId,
  isSafeTeamName,
  mergeTeamStores,
  normalizeOracle,
  parseModelsCache,
  reconcileToolMembers,
  removeArgs,
  resolveModelAuth,
  serializeModelsCache,
  syncCharterMembers,
  type TeamMember,
} from "./teamsModel";

test("isSafeTeamName whitelist", () => {
  expect(isSafeTeamName("brew")).toBe(true);
  expect(isSafeTeamName("orch-dev_2.0")).toBe(true);
  expect(isSafeTeamName("")).toBe(false);
  expect(isSafeTeamName("bad name")).toBe(false);
  expect(isSafeTeamName("evil;rm")).toBe(false);
  expect(isSafeTeamName("../escape")).toBe(false);
});

test("mergeTeamStores fills model/color from tool store, defaults role", () => {
  const merged = mergeTeamStores(
    [{ oracle: "bob", role: "member" }, { oracle: "foreman", role: "orchestrator" }, { oracle: "jack" }],
    [{ name: "bob", model: "claude", color: "blue" }],
  );
  expect(merged).toEqual([
    { oracle: "bob", role: "member", model: "claude", color: "blue" },
    { oracle: "foreman", role: "orchestrator", model: undefined, color: undefined },
    { oracle: "jack", role: "member", model: undefined, color: undefined }, // blank role → default
  ]);
});

test("mergeTeamStores appends tool-store-only members (divergent stores)", () => {
  // Oracle store {orches,dev1} but tool store {foreman,bob} — the stores diverged.
  // Every member from BOTH must survive so the divergence is visible/editable.
  const merged = mergeTeamStores(
    [{ oracle: "orches", role: "orchestrator" }, { oracle: "dev1", role: "builder" }],
    [{ name: "foreman", model: "claude-opus-4-8" }, { name: "bob", model: "claude-sonnet-5", color: "green" }],
  );
  expect(merged).toEqual([
    { oracle: "orches", role: "orchestrator", model: undefined, color: undefined },
    { oracle: "dev1", role: "builder", model: undefined, color: undefined },
    { oracle: "foreman", role: "member", model: "claude-opus-4-8", color: undefined },
    { oracle: "bob", role: "member", model: "claude-sonnet-5", color: "green" },
  ]);
});

test("inviteArgs / removeArgs / createArgs / deleteArgs", () => {
  expect(inviteArgs("bob", "brew", "builder")).toEqual([
    "team", "oracle-invite", "bob", "--team", "brew", "--role", "builder",
  ]);
  expect(inviteArgs("bob", "brew", "")).toEqual(["team", "oracle-invite", "bob", "--team", "brew"]);
  expect(removeArgs("bob", "brew")).toEqual(["team", "oracle-remove", "bob", "--team", "brew"]);
  expect(createArgs("x", "hi there")).toEqual(["team", "create", "x", "--description", "hi there"]);
  expect(createArgs("x", "  ")).toEqual(["team", "create", "x"]);
  expect(deleteArgs("x")).toEqual(["team", "delete", "x"]);
});

const M = (oracle: string, role: string, model?: string, color?: string): TeamMember => ({
  oracle, role, model, color,
});

test("diffMembers: add / remove / role change / config change", () => {
  const original = [M("bob", "member", "claude", "blue"), M("jack", "member"), M("old", "member")];
  const edited = [
    M("bob", "builder", "claude", "blue"), // role changed
    M("jack", "member", "claude", "green"), // config changed (color added)
    M("newbie", "orchestrator"), // added
    // "old" removed
  ];
  const d = diffMembers(original, edited);
  expect(d.added.map((m) => m.oracle)).toEqual(["newbie"]);
  expect(d.removed).toEqual(["old"]);
  expect(d.roleChanged.map((m) => m.oracle)).toEqual(["bob"]);
  expect(d.configChanged.map((m) => m.oracle)).toEqual(["jack"]);
});

test("diffMembers: no changes → all empty", () => {
  const same = [M("bob", "member", "claude", "blue")];
  const d = diffMembers(same, [M("bob", "member", "claude", "blue")]);
  expect(d.added).toEqual([]);
  expect(d.removed).toEqual([]);
  expect(d.roleChanged).toEqual([]);
  expect(d.configChanged).toEqual([]);
});

test("diffMembers: a member both role- and config-changed appears in both lists", () => {
  const d = diffMembers([M("bob", "member", "claude", "blue")], [M("bob", "builder", "claude", "red")]);
  expect(d.roleChanged.map((m) => m.oracle)).toEqual(["bob"]);
  expect(d.configChanged.map((m) => m.oracle)).toEqual(["bob"]);
});

test("reconcileToolMembers drops removed members (the delete-reappears bug)", () => {
  // config.json had jack; oracle-remove cleaned the maw store but not this one.
  // Reconcile MUST prune jack, or mergeTeamStores re-appends him after save.
  const existing = [
    { name: "foreman", model: "claude-opus-4-8" },
    { name: "bob", model: "claude-sonnet-5" },
    { name: "jack", model: "claude-sonnet-5" },
    { name: "john", model: "claude-sonnet-5" },
  ];
  const out = reconcileToolMembers(existing, { remove: ["jack"] });
  expect(out.map((m) => m.name)).toEqual(["foreman", "bob", "john"]);
});

test("reconcileToolMembers removes AND upserts in one pass", () => {
  const existing = [
    { name: "bob", model: "claude-sonnet-5" },
    { name: "jack", model: "claude-sonnet-5" },
  ];
  const out = reconcileToolMembers(existing, {
    remove: ["jack"],
    upsert: [M("bob", "member", "claude-opus-4-8", "green"), M("newbie", "member", "claude-haiku-4-5")],
  });
  expect(out).toEqual([
    { name: "bob", model: "claude-opus-4-8", color: "green" }, // updated in place
    { name: "newbie", model: "claude-haiku-4-5" }, // appended
  ]);
});

test("reconcileToolMembers preserves unknown keys and ignores a remove miss", () => {
  const existing = [{ name: "bob", model: "claude-sonnet-5", note: "keep me" }];
  const out = reconcileToolMembers(existing, { remove: ["ghost"], upsert: [M("bob", "member", undefined, "blue")] });
  expect(out).toEqual([{ name: "bob", model: "claude-sonnet-5", color: "blue", note: "keep me" }]);
});

test("reconcileToolMembers with no opts is a passthrough copy", () => {
  const existing = [{ name: "bob", model: "claude-sonnet-5" }];
  const out = reconcileToolMembers(existing, {});
  expect(out).toEqual(existing);
  expect(out).not.toBe(existing); // new array, not the same reference
});

test("normalizeOracle: trims and strips ONE trailing -oracle (matches sanitizeMembers)", () => {
  expect(normalizeOracle("jack")).toBe("jack");
  expect(normalizeOracle("  jack  ")).toBe("jack");
  expect(normalizeOracle("jack-oracle")).toBe("jack"); // maw bud would strip this too
  expect(normalizeOracle("  fusion-oracle  ")).toBe("fusion");
  expect(normalizeOracle("data-oracle-oracle")).toBe("data-oracle"); // only ONE suffix
  expect(normalizeOracle("-oracle")).toBe(""); // degenerate → empty
  expect(normalizeOracle("")).toBe("");
});

test("findDuplicateOracleNames: exact repeats", () => {
  expect(findDuplicateOracleNames(["foreman", "bob", "john", "jack", "jack"])).toEqual(["jack"]);
  expect(findDuplicateOracleNames(["jack", "jack", "jack"])).toEqual(["jack"]);
});

test("findDuplicateOracleNames: no duplicates → empty", () => {
  expect(findDuplicateOracleNames(["foreman", "bob", "john"])).toEqual([]);
});

test("findDuplicateOracleNames: normalizes before comparing (jack vs jack-oracle, whitespace)", () => {
  expect(findDuplicateOracleNames(["jack", "jack-oracle"])).toEqual(["jack"]);
  expect(findDuplicateOracleNames([" jack ", "jack"])).toEqual(["jack"]);
});

test("findDuplicateOracleNames: ignores empty/blank rows, case-sensitive, sorts groups", () => {
  expect(findDuplicateOracleNames(["", "  ", "a"])).toEqual([]); // blanks never a dup
  expect(findDuplicateOracleNames(["Bob", "bob"])).toEqual([]); // case-sensitive, like the fs registry
  expect(findDuplicateOracleNames(["b", "b", "a", "a"])).toEqual(["a", "b"]); // multiple groups, sorted
});

test("syncCharterMembers: replaces members, preserves session/project/description", () => {
  const existing = [
    "name: brew",
    "description: Brew team — the crew",
    "session: brew",
    "project: fufu-2345/missionControl",
    "members:",
    "  - role: bob",
    "  - role: jack",
    "  - role: john",
  ].join("\n");
  const out = syncCharterMembers(existing, "brew", ["foreman", "bob", "jack", "john", "mike"]);
  expect(out).toBe(
    [
      "name: brew",
      "description: Brew team — the crew",
      "session: brew",
      "project: fufu-2345/missionControl",
      "members:",
      "  - role: foreman",
      "  - role: bob",
      "  - role: jack",
      "  - role: john",
      "  - role: mike",
      "",
    ].join("\n"),
  );
});

test("syncCharterMembers: no charter yet → minimal charter keyed on team name", () => {
  expect(syncCharterMembers(null, "alpha", ["neo", "trin"])).toBe(
    "name: alpha\nsession: alpha\nmembers:\n  - role: neo\n  - role: trin\n",
  );
  expect(syncCharterMembers("", "alpha", ["neo"])).toBe(
    "name: alpha\nsession: alpha\nmembers:\n  - role: neo\n",
  );
});

test("syncCharterMembers: charter without a members block → append one", () => {
  expect(syncCharterMembers("name: t\nsession: t", "t", ["a"])).toBe(
    "name: t\nsession: t\nmembers:\n  - role: a\n",
  );
});

test("syncCharterMembers: preserves top-level keys that follow the members block", () => {
  const existing = "name: t\nmembers:\n  - role: old\nengines:\n  claude: claude\n";
  const out = syncCharterMembers(existing, "t", ["a", "b"]);
  expect(out).toBe("name: t\nmembers:\n  - role: a\n  - role: b\nengines:\n  claude: claude\n");
});

test("mergeTeamStores: skips maw live-worker entries (team up pollution)", () => {
  // maw team up writes live tmux windows into the SAME config.json (tmuxPaneId /
  // backendType). These are NOT roster members and must never surface — else the
  // panel shows phantom "team"/"missioncontrol-bob" rows and a Save scaffolds them.
  const merged = mergeTeamStores(
    [
      { oracle: "foreman", role: "orchestrator" },
      { oracle: "bob", role: "member" },
    ],
    [
      { name: "team", tmuxPaneId: "%0", backendType: "tmux", model: "claude", color: "blue" },
      { name: "missioncontrol-bob", tmuxPaneId: "%1", backendType: "tmux", color: "green" },
      { name: "bob", model: "claude-opus-4-8", color: "cyan" }, // genuine decoration — kept
    ],
  );
  expect(merged).toEqual([
    { oracle: "foreman", role: "orchestrator", model: undefined, color: undefined },
    { oracle: "bob", role: "member", model: "claude-opus-4-8", color: "cyan" }, // decorated, not from the live %1 entry
  ]);
});

test("awakenStatusFromClaudeMd: bud placeholder → stub", () => {
  const stub = "# bob-oracle\n\n## Identity\n- **Purpose**: (to be defined by /awaken)\n";
  expect(awakenStatusFromClaudeMd(stub)).toBe("stub");
});

test("awakenStatusFromClaudeMd: placeholder gone → identity (ritual OR hand edit)", () => {
  const set = "# foreman-oracle\n\n## Identity\n- **Purpose**: orchestrate builds\n";
  expect(awakenStatusFromClaudeMd(set)).toBe("identity");
});

test("awakenStatusFromClaudeMd: no/empty content → unknown", () => {
  expect(awakenStatusFromClaudeMd(null)).toBe("unknown");
  expect(awakenStatusFromClaudeMd(undefined)).toBe("unknown");
  expect(awakenStatusFromClaudeMd("   ")).toBe("unknown");
});

// isSafeModelId — ONE validator for a model id that gets interpolated into a shell
// command (`claude --model X` at launch, `tmux send-keys '/model X'` per member).
// Regression: two divergent regexes guarded this same value — the orchestrator
// launch path allowed the bracketed window suffix while the per-member /model send
// rejected it, so a bracketed pick was silently dropped and the member quietly
// inherited the global default model.
test("isSafeModelId: versioned ids and bare aliases pass", () => {
  for (const m of [...MODEL_ALIASES, "claude-sonnet-5-20250929", "opus", "sonnet", "haiku_x.2"]) {
    expect(isSafeModelId(m)).toBe(true);
  }
});

test("isSafeModelId: bracketed window suffix passes (was silently dropped)", () => {
  expect(isSafeModelId("opus[1m]")).toBe(true);
  expect(isSafeModelId("claude-sonnet-5[1m]")).toBe(true);
});

test("isSafeModelId: shell metacharacters rejected, never sanitized", () => {
  for (const bad of [
    "x; rm -rf /",
    "a b",
    "$(id)",
    "a`id`",
    "a'b",
    'a"b',
    "a|b",
    "a&b",
    "a\nb",
    "../etc/passwd",
    "opus[1m",
    "opus1m]",
    "opus[]",
    "opus[a;b]",
  ]) {
    expect(isSafeModelId(bad)).toBe(false);
  }
});

test("isSafeModelId: empty / oversized rejected", () => {
  expect(isSafeModelId("")).toBe(false);
  expect(isSafeModelId("a".repeat(101))).toBe(false);
});

// ── live model list: cache + credential resolution ────────────────────────────
// Why this exists: MODEL_ALIASES going stale is a bug that already shipped — Opus 5
// was unrepresentable in the picker, so a pick that read "opus-4-8" while the worker
// ran opus-5 looked like a config mismatch rather than the dead --model path it was.

test("MODEL_ALIASES: includes the current top Opus (the stale-list bug)", () => {
  expect(MODEL_ALIASES).toContain("claude-opus-5");
  expect(MODEL_ALIASES.every((m) => isSafeModelId(m))).toBe(true);
});

const NOW = 1_800_000_000_000;

test("parseModelsCache: fresh cache returns its ids", () => {
  const raw = serializeModelsCache(["claude-opus-5", "claude-sonnet-5"], NOW);
  expect(parseModelsCache(raw, NOW + 1000)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
});

test("parseModelsCache: expired past the TTL returns null (so we refetch)", () => {
  const raw = serializeModelsCache(["claude-opus-5"], NOW);
  expect(parseModelsCache(raw, NOW + MODELS_CACHE_TTL_MS + 1)).toBeNull();
  expect(parseModelsCache(raw, NOW + MODELS_CACHE_TTL_MS - 1)).toEqual(["claude-opus-5"]);
});

test("parseModelsCache: future timestamp rejected (clock jump must not pin a stale list)", () => {
  expect(parseModelsCache(serializeModelsCache(["claude-opus-5"], NOW + 5000), NOW)).toBeNull();
});

test("parseModelsCache: unusable input returns null, never throws", () => {
  for (const bad of [null, undefined, "", "not json", "[1,2,3]", "{}", '{"ids":["a"]}',
                     '{"fetchedAt":"x","ids":["a"]}', '{"fetchedAt":1,"ids":"a"}']) {
    expect(parseModelsCache(bad as string | null, NOW)).toBeNull();
  }
});

test("parseModelsCache: ⛔ re-validates ids from disk (they reach a --model cmdline)", () => {
  const tampered = JSON.stringify({ fetchedAt: NOW, ids: ["claude-opus-5", "x; rm -rf /", "a b"] });
  expect(parseModelsCache(tampered, NOW)).toEqual(["claude-opus-5"]);
  // all-unsafe = same as no cache
  expect(parseModelsCache(JSON.stringify({ fetchedAt: NOW, ids: ["$(id)"] }), NOW)).toBeNull();
  expect(parseModelsCache(JSON.stringify({ fetchedAt: NOW, ids: [] }), NOW)).toBeNull();
});

test("resolveModelAuth: API key uses x-api-key, NOT bearer", () => {
  const a = resolveModelAuth({ ANTHROPIC_API_KEY: "sk-ant-api-xxx" })!;
  expect(a.source).toBe("api-key");
  expect(a.headers["x-api-key"]).toBe("sk-ant-api-xxx");
  expect(a.headers.Authorization).toBeUndefined();
  expect(a.headers["anthropic-beta"]).toBeUndefined();
});

test("resolveModelAuth: OAuth token uses Bearer + the oauth beta header", () => {
  const a = resolveModelAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-yyy" })!;
  expect(a.source).toBe("auth-token");
  expect(a.headers.Authorization).toBe("Bearer sk-ant-oat01-yyy");
  expect(a.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(a.headers["x-api-key"]).toBeUndefined();
});

test("resolveModelAuth: falls back to Claude Code's creds file", () => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-zzz", expiresAt: NOW + 60_000 } });
  const a = resolveModelAuth({}, creds)!;
  expect(a.source).toBe("claude-oauth");
  expect(a.headers.Authorization).toBe("Bearer sk-ant-oat01-zzz");
});

test("resolveModelAuth: env wins over the creds file", () => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: "from-file" } });
  expect(resolveModelAuth({ ANTHROPIC_API_KEY: "from-env" }, creds)!.headers["x-api-key"]).toBe("from-env");
});

test("resolveModelAuth: nothing available = null (caller uses the pinned list)", () => {
  expect(resolveModelAuth({})).toBeNull();
  expect(resolveModelAuth({ ANTHROPIC_API_KEY: "   " }, "not json")).toBeNull();
  expect(resolveModelAuth({}, JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
});

test("extractOauthToken: finds the token at any nesting depth", () => {
  expect(extractOauthToken(JSON.stringify({ accessToken: "t1" }))).toBe("t1");
  expect(extractOauthToken(JSON.stringify({ a: { b: { access_token: "t2" } } }))).toBe("t2");
  expect(extractOauthToken("garbage")).toBeNull();
  expect(extractOauthToken(null)).toBeNull();
});

test("extractOauthToken: skips an expired token (don't send a dead credential)", () => {
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: NOW - 1 } });
  expect(extractOauthToken(expired, NOW)).toBeNull();
  const live = JSON.stringify({ claudeAiOauth: { accessToken: "new", expiresAt: NOW + 1 } });
  expect(extractOauthToken(live, NOW)).toBe("new");
  // no expiry field = usable (shape has moved before; don't assume it's there)
  expect(extractOauthToken(JSON.stringify({ accessToken: "noexp" }), NOW)).toBe("noexp");
});
