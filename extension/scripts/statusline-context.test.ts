import { test, expect } from "bun:test";

import {
  autoCompactTrigger,
  contextPct,
  fillHue,
  hslToRgb,
  parseLastAutoCompactPreTokens,
  pickTrigger,
  renderBar,
} from "./statusline-context.mjs";

// Helpers to build fake transcript JSONL lines.
const autoCompact = (pre: number) =>
  JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: pre } });
const manualCompact = (pre: number) =>
  JSON.stringify({ type: "system", compactMetadata: { trigger: "manual", preTokens: pre } });
const usageLine = (t: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: t } } });

test("contextPct = tokens/window, clamped 0..100", () => {
  expect(contextPct(350000, 700000)).toBe(50);
  expect(contextPct(686000, 700000)).toBe(98);
  expect(contextPct(900000, 700000)).toBe(100); // clamp
  expect(contextPct(0, 700000)).toBe(0);
  expect(contextPct(1000, 0)).toBe(0); // unknown window
});

test("autoCompactTrigger subtracts the 33k reserve, floored at 1", () => {
  expect(autoCompactTrigger(700000)).toBe(667000); // [1m] capped at 700k
  expect(autoCompactTrigger(1000000)).toBe(967000); // uncapped [1m]
  expect(autoCompactTrigger(200000)).toBe(167000); // default window
  expect(autoCompactTrigger(10000)).toBe(1); // tiny window never divides by ≤0
});

test("contextPct against the trigger reads 100% at the real compact point", () => {
  // [1m] capped at 700k → trigger 667k; the bar now tops out exactly at compaction
  // (against the raw 700k window this read 95%).
  expect(contextPct(667000, autoCompactTrigger(700000))).toBe(100);
  expect(contextPct(333500, autoCompactTrigger(700000))).toBe(50);
});

test("fillHue fades green→red, non-increasing, honoring the zones", () => {
  expect(fillHue(0)).toBe(130);
  expect(fillHue(100)).toBe(0);
  expect(fillHue(75)).toBe(80);
  expect(fillHue(90)).toBe(40);
  let prev = 999;
  for (let p = 0; p <= 100; p += 5) {
    const h = fillHue(p);
    expect(h).toBeLessThanOrEqual(prev);
    prev = h;
  }
});

test("hslToRgb: low fill is green-dominant, high fill is red-dominant", () => {
  const green = hslToRgb(fillHue(10), 0.7, 0.55); // hue ~123
  expect(green.g).toBeGreaterThan(green.r);
  expect(green.g).toBeGreaterThan(green.b);
  const red = hslToRgb(fillHue(100), 0.7, 0.55); // hue 0
  expect(red.r).toBeGreaterThan(red.g);
  expect(red.r).toBeGreaterThan(red.b);
});

test("renderBar draws a block bar, the %, and truecolor ANSI", () => {
  const s = renderBar(60);
  expect(s).toContain("ctx [");
  expect(s).toContain("60%");
  expect(s).toContain("\x1b[38;2;"); // truecolor foreground
  expect(s).toContain("\x1b[0m"); // reset
  // 60% of a 10-cell bar = 6 filled, 4 empty
  expect((s.match(/█/g) || []).length).toBe(6);
  expect((s.match(/░/g) || []).length).toBe(4);
  // no color emoji used
  expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)).toBe(false);
});

test("renderBar clamps the bar cells at the ends", () => {
  expect((renderBar(0).match(/█/g) || []).length).toBe(0);
  expect((renderBar(100).match(/█/g) || []).length).toBe(10);
});

test("parseLastAutoCompactPreTokens returns the most recent trigger:auto preTokens", () => {
  const jsonl = [usageLine(1000), autoCompact(267186), usageLine(50000)].join("\n");
  expect(parseLastAutoCompactPreTokens(jsonl)).toBe(267186);
});

test("parseLastAutoCompactPreTokens IGNORES manual compactions (they fire at arbitrary points)", () => {
  // most recent line is a manual /compact at 600k — must NOT poison the auto trigger
  const jsonl = [autoCompact(250000), usageLine(300000), manualCompact(600000)].join("\n");
  expect(parseLastAutoCompactPreTokens(jsonl)).toBe(250000);
});

test("parseLastAutoCompactPreTokens picks the LATEST auto when several exist", () => {
  const jsonl = [autoCompact(240000), usageLine(10000), autoCompact(268000)].join("\n");
  expect(parseLastAutoCompactPreTokens(jsonl)).toBe(268000);
});

test("parseLastAutoCompactPreTokens returns null with no auto compaction / empty / garbage", () => {
  expect(parseLastAutoCompactPreTokens([usageLine(100), manualCompact(500000)].join("\n"))).toBeNull();
  expect(parseLastAutoCompactPreTokens("")).toBeNull();
  expect(parseLastAutoCompactPreTokens("not json\n{also not}")).toBeNull();
});

test("parseLastAutoCompactPreTokens tolerates a truncated first line (tail-read cut mid-line)", () => {
  // a bounded tail read can slice the first line in half — that half must be skipped, not crash
  const jsonl = '{"partial":"cut-o' + "\n" + autoCompact(267000);
  expect(parseLastAutoCompactPreTokens(jsonl)).toBe(267000);
});

test("pickTrigger prefers the live transcript trigger over cache and formula", () => {
  // real auto preTokens seen this session -> that's ground truth, use it verbatim
  expect(pickTrigger(267186, 260000, 700000)).toBe(267186);
});

test("pickTrigger falls back to the cached learned trigger when no live one this session", () => {
  expect(pickTrigger(null, 267000, 700000)).toBe(267000);
  expect(pickTrigger(null, 267000, 700000, 200000)).toBe(267000); // still below it -> trust it
  expect(pickTrigger(null, 267000, 700000, 267000)).toBe(267000); // exactly at it = 100%, valid
});

// ⛔ บั๊กจริง (2026-08-04, run agentskill-marketplace-newflow4): cache
//    ~/.claude/.mc-ctx-trigger = 147686 เขียนไว้ 11 วันก่อน (คนละ model/window) แล้ว
//    session 3 ตัววิ่งอยู่ที่ 220,075 / 163,185 / 138,436 โดย **ไม่มี auto-compact เลย**
//    -> cache ชนะ formula เสมอ, 220075/147686 = 149% -> clamp เหลือ 100% ทั้งสามแท่ง
//    บาร์เลยโชว์ "ตันแล้ว" ทั้งที่ยังเหลือที่จริงอีกเยอะ = ตัวเลขที่ทำให้ตัดสินใจผิด
//    (ผมเกือบสั่งแทรกกลางรันเพราะเชื่อเลขนี้)
// กติกาที่ถูก: token ที่แล่นผ่าน trigger ไปโดยไม่ compact = **หลักฐานว่า trigger นั้นผิด**
//    ไม่ใช่หลักฐานว่าใกล้ตัน -> ทิ้ง cache แล้วตกไปใช้ formula บน window จริง
test("pickTrigger ทิ้ง cached trigger ที่ session นี้แล่นผ่านไปแล้ว (พิสูจน์แล้วว่าผิด)", () => {
  // เคสจริงที่เจอ: cache 147,686 · ctx 220,075 · window 700k -> ต้องไปใช้ formula 667,000
  expect(pickTrigger(null, 147686, 700000, 220075)).toBe(667000);
  // เกินไปแค่ 1 token ก็ถือว่าโป๊ะแล้ว (ถ้ามันจริง Claude ต้อง compact ไปแล้ว)
  expect(pickTrigger(null, 147686, 700000, 147687)).toBe(667000);
  // ⛔ live trigger ต้องไม่ถูกกฎนี้แตะ — มันมาจาก transcript ของ session นี้เอง = ของจริง
  //    (ช่วงสั้น ๆ หลัง compact tokens อาจยังสูงกว่า preTokens ที่บันทึก)
  expect(pickTrigger(267186, 147686, 700000, 300000)).toBe(267186);
});

test("pickTrigger: ไม่ส่ง tokens มา = พฤติกรรมเดิมทุกอย่าง (caller เก่าไม่พัง)", () => {
  expect(pickTrigger(null, 147686, 700000)).toBe(147686);
});

test("pickTrigger falls back to the formula (window − reserve) only when nothing is learned", () => {
  expect(pickTrigger(null, null, 700000)).toBe(667000);
  expect(pickTrigger(null, null, 10000)).toBe(1); // floored, never divides by ≤0
});
