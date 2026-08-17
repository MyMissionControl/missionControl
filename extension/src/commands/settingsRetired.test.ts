import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RETIRED_KEYS, listSettings, pruneRetired, readConfig } from "./settingsOps";

function tempConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-retired-"));
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  process.env.MC_CONFIG_PATH = p;
  return p;
}

test("pruneRetired: drops the knobs nothing reads, keeps the rest", () => {
  const { config, removed } = pruneRetired({
    agents: 3,
    auto_loop: false,
    decentralized_review: false,
    skills_hierarchical_threshold: 50,
    push_mode: "per-sprint",
    claude_view_mode: "native",
    "search.mode": "vector",
  });
  expect(removed.sort()).toEqual(RETIRED_KEYS.slice().sort());
  expect(config).toEqual({ claude_view_mode: "native", "search.mode": "vector" });
});

test("pruneRetired: a file with nothing retired is returned untouched", () => {
  const raw = { claude_view_mode: "chat" };
  const { config, removed } = pruneRetired(raw);
  expect(removed).toEqual([]);
  expect(config).toBe(raw); // same object — no needless rewrite
});

// The point of pruning on read: a retired key left in the file would come back as
// a mystery row in the "Other" group, which is exactly the "knob that does
// nothing" this removal was about.
test("readConfig: retired keys are stripped from the file, once", () => {
  const p = tempConfig({ agents: 3, auto_loop: true, claude_view_mode: "native" });
  expect(readConfig()).toEqual({ claude_view_mode: "native" });
  expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({ claude_view_mode: "native" });
});

test("listSettings: a retired key never renders a row (not even under Other)", () => {
  tempConfig({ agents: 3, skills_hierarchical_threshold: 50, claude_view_mode: "chat" });
  const keys = listSettings().map((e) => e.key);
  for (const k of RETIRED_KEYS) expect(keys).not.toContain(k);
  expect(keys).toContain("claude_view_mode");
});

test("a retired key is never re-added by the schema", () => {
  tempConfig({});
  const keys = listSettings().map((e) => e.key);
  expect(keys.filter((k) => RETIRED_KEYS.includes(k))).toEqual([]);
});
