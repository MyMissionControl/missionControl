import { describe, expect, test } from "bun:test";

import { buildProjectUsage, hourKeyLocal, type UsageRecord } from "./projectUsageScan";

const ROOT = "/home/u/projects/alpha";
// A real opus line's usage shape (only the fields priceLine reads).
const usage = (out: number, cr = 0, cw = 0, inp = 0) => ({
  input_tokens: inp,
  output_tokens: out,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
});
const rec = (o: Partial<UsageRecord>): UsageRecord => ({ type: "assistant", cwd: ROOT + "/apps/api", ...o });

describe("buildProjectUsage", () => {
  test("folds hourly (with cat split) + models + sessions + skills for the target root", () => {
    const recs: UsageRecord[] = [
      rec({
        timestamp: "2026-07-22T14:10:00.000Z", sessionId: "S1", gitBranch: "feature/pay",
        requestId: "r1", attributionSkill: "superpowers:tdd", promptId: "p1",
        message: { id: "m1", model: "claude-opus-4-8", usage: usage(1000, 10000, 2000, 500) },
      }),
      rec({
        timestamp: "2026-07-22T14:40:00.000Z", sessionId: "S1", gitBranch: "feature/pay",
        requestId: "r2", attributionSkill: "superpowers:tdd", promptId: "p2",
        message: { id: "m2", model: "claude-opus-4-8", usage: usage(500) },
      }),
      // different project — must be ignored
      rec({ cwd: "/home/u/projects/beta", timestamp: "2026-07-22T14:00:00.000Z", requestId: "r3",
        message: { id: "m3", model: "claude-opus-4-8", usage: usage(9999) } }),
      // a synthetic model → priceLine returns null → skipped
      rec({ timestamp: "2026-07-22T15:00:00.000Z", requestId: "r4",
        message: { id: "m4", model: "<synthetic>", usage: usage(1) } }),
    ];
    const u = buildProjectUsage(recs, ROOT);

    // both S1 lines land in the same local hour bucket, alpha only
    const hk = hourKeyLocal("2026-07-22T14:10:00.000Z");
    expect(Object.keys(u.hourly)).toEqual([hk]);
    expect(u.hourly[hk].cost).toBeGreaterThan(0);
    expect(u.hourly[hk].cats.output.tokens).toBe(1500); // 1000 + 500
    expect(u.hourly[hk].cats.cacheRead.tokens).toBe(10000);

    expect(Object.keys(u.models)).toEqual(["claude-opus-4-8"]);

    expect(u.sessions.length).toBe(1);
    expect(u.sessions[0].branch).toBe("feature/pay");
    expect(u.sessions[0].durationMs).toBe(30 * 60 * 1000); // 14:10 → 14:40
    expect(u.sessions[0].model).toBe("claude-opus-4-8");

    expect(u.skills.length).toBe(1);
    expect(u.skills[0].name).toBe("superpowers:tdd");
    expect(u.skills[0].runs).toBe(2); // two distinct promptIds
  });

  test("de-dupes on requestId:message.id (compaction re-logs)", () => {
    const line = rec({ timestamp: "2026-07-22T14:00:00.000Z", requestId: "r1",
      message: { id: "m1", model: "claude-opus-4-8", usage: usage(1000) } });
    const u = buildProjectUsage([line, { ...line }], ROOT);
    const hk = hourKeyLocal("2026-07-22T14:00:00.000Z");
    expect(u.hourly[hk].cats.output.tokens).toBe(1000); // counted once, not 2000
  });

  test("empty when nothing resolves to the root", () => {
    const u = buildProjectUsage([rec({ cwd: "/home/u/random", message: { model: "claude-opus-4-8", usage: usage(5) } })], ROOT);
    expect(u.sessions).toEqual([]);
    expect(Object.keys(u.hourly)).toEqual([]);
  });
});
