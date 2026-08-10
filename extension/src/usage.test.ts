import { describe, expect, test } from "bun:test";

import {
  addBreakdown,
  allDayDetail,
  emptyBreakdown,
  mergeProjectsByRealpath,
  priceLine,
  topProjectsByRange,
  projectPeriods,
} from "./usage";

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
  test('an "unknown" day counts in all-time only, never in the week', () => {
    // The week test is a lexical compare, and "unknown" sorts above every real
    // YYYY-MM-DD — without an explicit skip it would land in "this week".
    const p = projectPeriods(
      { unknown: bd(1, 1, 1, 1, 1, 1, 1, 1) },
      "2026-07-24",
      "2026-07-18",
      "2026-07",
    );
    expect(p.all.cost).toBeCloseTo(4, 9);
    expect(p.week.cost).toBe(0);
    expect(p.today.cost).toBe(0);
    expect(p.month.cost).toBe(0);
  });
});

describe("mergeProjectsByRealpath", () => {
  const agg = (name: string, cost: number, tokens: number, lastMs: number, live = true) => ({
    name, cost, tokens, lastMs, live,
    det: { inTok: 1, outTok: 1, cacheReadTok: 1, cacheWriteTok: 1, inCost: cost, outCost: 0, cacheReadCost: 0, cacheWriteCost: 0 },
  });

  test("merges two paths to the same real dir, keeping the canonical key", () => {
    const real = (p: string) => (p === "/old/projects/app" ? "/new/projects/app" : p);
    const out = mergeProjectsByRealpath(
      { "/old/projects/app": agg("app", 46.7, 100, 5), "/new/projects/app": agg("app", 0.97, 10, 9) },
      real,
    );
    expect(Object.keys(out)).toEqual(["/new/projects/app"]);
    expect(out["/new/projects/app"].cost).toBeCloseTo(47.67, 9);
    expect(out["/new/projects/app"].tokens).toBe(110);
    expect(out["/new/projects/app"].lastMs).toBe(9); // newest activity wins
    expect(out["/new/projects/app"].det.inCost).toBeCloseTo(47.67, 9);
  });

  test("same NAME but different real dirs stay separate", () => {
    const out = mergeProjectsByRealpath(
      { "/a/projects/app": agg("app", 1, 1, 1), "/b/projects/app": agg("app", 2, 2, 2) },
      (p) => p,
    );
    expect(Object.keys(out).sort()).toEqual(["/a/projects/app", "/b/projects/app"]);
  });

  test("a live row merged with a ledger-only row stays live; realpath errors are tolerated", () => {
    const out = mergeProjectsByRealpath(
      { "/gone/projects/app": agg("app", 3, 3, 3, false), "/live/projects/app": agg("app", 4, 4, 4, true) },
      (p) => {
        if (p === "/gone/projects/app") throw new Error("ENOENT");
        return p;
      },
    );
    expect(Object.keys(out).sort()).toEqual(["/gone/projects/app", "/live/projects/app"]);
    expect(out["/live/projects/app"].live).toBe(true);
  });
});

describe("allDayDetail", () => {
  const bd = (n: number) => ({
    inTok: n, outTok: n, cacheReadTok: n, cacheWriteTok: n,
    inCost: n, outCost: n, cacheReadCost: n, cacheWriteCost: n,
  });
  // Only the "projects/" cwd would show up in the budget table; the token card
  // must still see the tool/oracle/home cwds, which are the bulk of real spend.
  const u = {
    byProjectDayDetail: {
      "/home/u/projects/alpha": { "2026-07-24": bd(1) },
      "/home/u/Desktop/soulbrew": { "2026-07-24": bd(2), "2026-07-10": bd(4) },
      unknown: { unknown: bd(8) },
    },
  } as never as Parameters<typeof allDayDetail>[0];

  test("sums EVERY cwd per day, not just the ones under projects/", () => {
    const d = allDayDetail(u);
    expect(Object.keys(d).sort()).toEqual(["2026-07-10", "2026-07-24", "unknown"]);
    expect(d["2026-07-24"].inCost).toBe(3); // 1 (projects/) + 2 (outside) — both counted
    expect(d["2026-07-10"].outCost).toBe(4);
  });

  test("all-time total matches the whole bill, so the card agrees with the hero", () => {
    const p = projectPeriods(allDayDetail(u), "2026-07-24", "2026-07-18", "2026-07");
    expect(p.all.cost).toBeCloseTo((1 + 2 + 4 + 8) * 4, 9); // 4 categories per day bucket
    expect(p.today.cost).toBeCloseTo(3 * 4, 9);
    expect(p.month.cost).toBeCloseTo((1 + 2 + 4) * 4, 9); // "unknown" day stays out
  });

  test("a summary with no byProjectDayDetail yields an empty map, not a throw", () => {
    expect(allDayDetail({} as never as Parameters<typeof allDayDetail>[0])).toEqual({});
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

  test("Sonnet 5 uses its intro rate for usage before 2026-09-01, standard after", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const intro = priceLine("claude-sonnet-5", u, Date.UTC(2026, 7, 10))!;
    const after = priceLine("claude-sonnet-5", u, Date.UTC(2026, 8, 1))!;
    const undated = priceLine("claude-sonnet-5", u)!;
    expect(intro.cost).toBeCloseTo(2 + 10, 9);
    expect(after.cost).toBeCloseTo(3 + 15, 9); // window closed — back to list
    expect(undated.cost).toBeCloseTo(3 + 15, 9); // no timestamp → standard rate
    // the intro rate is Sonnet-5-only: 4.6 and Opus are unaffected by the date
    expect(priceLine("claude-sonnet-4-6", u, Date.UTC(2026, 7, 10))!.cost).toBeCloseTo(3 + 15, 9);
    expect(priceLine("claude-opus-5", u, Date.UTC(2026, 7, 10))!.cost).toBeCloseTo(5 + 25, 9);
  });

  test('speed "fast" bills opus at the premium $10/$50 rate', () => {
    const std = priceLine("claude-opus-5", { input_tokens: 1000, output_tokens: 1000, speed: "standard" })!;
    const fast = priceLine("claude-opus-5", { input_tokens: 1000, output_tokens: 1000, speed: "fast" })!;
    expect(std.cost).toBeCloseTo(0.005 + 0.025, 9);
    expect(fast.cost).toBeCloseTo(0.01 + 0.05, 9); // 2x — fast mode is a real price change
    expect(fast.bd.cacheReadCost).toBe(0);
    expect(fast.tokens).toBe(std.tokens); // token counts are unaffected by speed
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
