import { describe, expect, test } from "bun:test";

import { addBreakdown, emptyBreakdown, priceLine, topProjectsByRange, projectPeriods } from "./usage";

describe("projectPeriods", () => {
  const bd = (inTok: number, outTok: number, crTok: number, cwTok: number, inC: number, outC: number, crC: number, cwC: number) => ({
    inTok, outTok, cacheReadTok: crTok, cacheWriteTok: cwTok,
    inCost: inC, outCost: outC, cacheReadCost: crC, cacheWriteCost: cwC,
  });
  test("buckets days into today / week / month / all with cat + cost sums", () => {
    const dayDetail = {
      "2026-07-24": bd(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4), // today
      "2026-07-20": bd(1, 1, 1, 1, 1, 1, 1, 1),          // in week (>= 07-18) + month
      "2026-07-10": bd(2, 2, 2, 2, 2, 2, 2, 2),          // month only
      "2026-06-30": bd(5, 5, 5, 5, 5, 5, 5, 5),          // all only
    };
    const p = projectPeriods(dayDetail, "2026-07-24", "2026-07-18", "2026-07");
    expect(p.today.cost).toBeCloseTo(1.0, 9);
    expect(p.today.tokens).toBe(10);
    expect(p.today.cats.cacheRead.usd).toBeCloseTo(0.3, 9);
    expect(p.week.cost).toBeCloseTo(5.0, 9);
    expect(p.week.tokens).toBe(14);
    expect(p.month.cost).toBeCloseTo(13.0, 9);
    expect(p.all.cost).toBeCloseTo(33.0, 9);
    expect(p.all.cats.input.tokens).toBe(9);
    expect(p.all.cats.output.usd).toBeCloseTo(0.2 + 1 + 2 + 5, 9);
  });
  test("empty day detail → all-zero periods", () => {
    const p = projectPeriods({}, "2026-07-24", "2026-07-18", "2026-07");
    expect(p.all.cost).toBe(0);
    expect(p.today.tokens).toBe(0);
    expect(p.month.cats.cacheWrite.usd).toBe(0);
  });
});

describe("priceLine", () => {
  test("opus split + cost (no 5m/1h)", () => {
    const r = priceLine("claude-opus-4-8", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
    })!;
    expect(r).not.toBeNull();
    expect(r.bd.inTok).toBe(1000);
    expect(r.bd.cacheWriteTok).toBe(2000);
    expect(r.bd.inCost).toBeCloseTo(0.005, 9);
    expect(r.bd.outCost).toBeCloseTo(0.0125, 9);
    expect(r.bd.cacheReadCost).toBeCloseTo(0.005, 9);
    expect(r.bd.cacheWriteCost).toBeCloseTo(0.0125, 9);
    expect(r.cost).toBeCloseTo(0.035, 9);
    expect(r.tokens).toBe(13500);
    // invariant: parts sum to whole
    expect(r.bd.inCost + r.bd.outCost + r.bd.cacheReadCost + r.bd.cacheWriteCost).toBeCloseTo(r.cost, 9);
  });

  test("uses 5m/1h split when present (ccTot still = cacheWriteTok)", () => {
    const r = priceLine("claude-opus-4-8", {
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    })!;
    expect(r.bd.cacheWriteCost).toBeCloseTo(1000 * 6.25e-6 + 2000 * 10e-6, 9); // 0.02625
    expect(r.bd.cacheWriteTok).toBe(3000);
  });

  test("synthetic model -> null", () => {
    expect(priceLine("<synthetic>", { input_tokens: 5 })).toBeNull();
  });
});

describe("topProjectsByRange", () => {
  const cutoff = new Date("2026-07-20T00:00:00").getTime(); // local midnight

  test("ranks projects by in-range cost, returns top N, drops out-of-range hours", () => {
    const bph = {
      "/home/u/projects/alpha": {
        "2026-07-22 10:00": { cost: 5, tokens: 100 },
        "2026-07-19 09:00": { cost: 99, tokens: 9 }, // before cutoff -> excluded
      },
      "/home/u/projects/beta": { "2026-07-21 08:00": { cost: 3, tokens: 50 } },
      "/home/u/projects/gamma": { "2026-07-20 00:00": { cost: 1, tokens: 10 } },
    };
    const top = topProjectsByRange(bph, cutoff, 2);
    expect(top).toEqual([
      { name: "alpha", cost: 5 },
      { name: "beta", cost: 3 },
    ]);
  });

  test("folds sub-dir cwds onto the same project root", () => {
    const bph = {
      "/home/u/projects/alpha": { "2026-07-22 10:00": { cost: 2, tokens: 1 } },
      "/home/u/projects/alpha/sub": { "2026-07-22 11:00": { cost: 4, tokens: 1 } },
      "/home/u/projects/beta": { "2026-07-22 10:00": { cost: 5, tokens: 1 } },
    };
    const top = topProjectsByRange(bph, cutoff, 2);
    expect(top).toEqual([
      { name: "alpha", cost: 6 },
      { name: "beta", cost: 5 },
    ]);
  });

  test("skips cwds with no resolvable project", () => {
    const bph = {
      "/home/u/random/dir": { "2026-07-22 10:00": { cost: 100, tokens: 1 } },
      "/home/u/projects/alpha": { "2026-07-22 10:00": { cost: 1, tokens: 1 } },
    };
    expect(topProjectsByRange(bph, cutoff, 5)).toEqual([{ name: "alpha", cost: 1 }]);
  });
});

describe("Breakdown helpers", () => {
  test("empty is zeros; add is field-wise", () => {
    const e = emptyBreakdown();
    expect(e.inTok).toBe(0);
    expect(e.cacheWriteCost).toBe(0);
    const a = {
      inTok: 1, outTok: 2, cacheReadTok: 3, cacheWriteTok: 4,
      inCost: 5, outCost: 6, cacheReadCost: 7, cacheWriteCost: 8,
    };
    const s = addBreakdown(a, a);
    expect(s.inTok).toBe(2);
    expect(s.cacheWriteCost).toBe(16);
  });
});
