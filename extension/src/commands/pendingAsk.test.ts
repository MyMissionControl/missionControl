import { describe, expect, test } from "bun:test";

import {
  askKey,
  findOptionByLabel,
  itemLabel,
  buildAnswerArgs,
  isDigitAnswerable,
  parseAskFromPane,
  parsePaneList,
  scanPending,
} from "./pendingAsk";

// ── fixtures ───────────────────────────────────────────────────────────────
// REAL `tmux capture-pane -p` output, taken 2026-08-07 off a live claude REPL
// sitting on an open AskUserQuestion modal. Copied byte-for-byte, including the
// NBSP the TUI emits and the box rule the viewport interleaves BETWEEN options
// 4 and 5 — both broke a naive parser, which is why they stay in the fixture.
const REAL_MODAL = [
  "│                        /tmp                        │",
  "╰──────────────────────────────────────────────────────╯",
  "❯ ใช้ tool AskUserQuestion ถามผมว่าชอบผลไม้อะไร ตัวเลือก 3 อัน",
  "────────────────────────────────────────────────────────",
  " ☐ ผลไม้",
  "ชอบผลไม้อะไร?",
  "❯ 1. มะม่วง",
  "     หวานสุด",
  "  2. ทุเรียน",
  "     ราชาผลไม้",
  "  3. เงาะ",
  "     เปลือกมีขน",
  "  4. Type something.",
  "────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
  "",
].join("\n");

/** A busy pane: same REPL, no modal — this is the false-positive shape. */
const REAL_WORKING = [
  "● ไฟล์ /etc/hostname มีขนาด 21 bytes",
  "✻ Cooked for 5s",
  "────────────────────────────────────────────────────────",
  "❯ cat /etc/hostname",
  "────────────────────────────────────────────────────────",
  "  ctx [██░░░░░░░░] 22%",
  "  ⏸ manual mode on · ← for agents",
].join("\n");


/** REAL capture of a multiSelect box (2026-08-07). Note it prints the SAME
 *  footer as the single-select one — the `[ ]` per option is the only tell —
 *  and its header carries the tab arrows plus a Submit affordance. */
const REAL_MULTI = [
  "────────────────────────────────────────────────────────",
  "\u2190  \u2610 \u0e1c\u0e25\u0e44\u0e21\u0e49  \u2714 Submit  \u2192",
  "\u0e0a\u0e2d\u0e1a\u0e1c\u0e25\u0e44\u0e21\u0e49\u0e2d\u0e30\u0e44\u0e23\u0e1a\u0e49\u0e32\u0e07",
  "\u276f 1. [ ] \u0e21\u0e30\u0e21\u0e48\u0e27\u0e07",
  "  \u0e1c\u0e25\u0e44\u0e21\u0e49\u0e2b\u0e27\u0e32\u0e19 \u0e40\u0e2b\u0e25\u0e37\u0e2d\u0e07",
  "  2. [ ] \u0e17\u0e38\u0e40\u0e23\u0e35\u0e22\u0e19",
  "  \u0e1c\u0e25\u0e44\u0e21\u0e49\u0e21\u0e35\u0e01\u0e25\u0e34\u0e48\u0e19\u0e41\u0e23\u0e07",
  "  3. [ ] \u0e40\u0e07\u0e32\u0e30",
  "  \u0e1c\u0e25\u0e44\u0e21\u0e49\u0e41\u0e14\u0e07 \u0e2d\u0e23\u0e48\u0e2d\u0e22",
  "  4. [ ] Type something",
  "     Submit",
  "────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel",
].join("\n");

// ── parseAskFromPane ───────────────────────────────────────────────────────
describe("parseAskFromPane", () => {
  test("P1 reads the real modal: header, question, and the 3 REAL options", () => {
    const ask = parseAskFromPane(REAL_MODAL);
    expect(ask).not.toBeNull();
    expect(ask!.header).toBe("ผลไม้");
    expect(ask!.question).toBe("ชอบผลไม้อะไร?");
    expect(ask!.options.map((o) => o.label)).toEqual(["มะม่วง", "ทุเรียน", "เงาะ"]);
  });

  test("P2 each option keeps the digit the TUI printed for it", () => {
    // The digit is what gets sent. Deriving it from an array index would break
    // the moment the TUI reorders or inserts a row.
    expect(parseAskFromPane(REAL_MODAL)!.options.map((o) => o.key)).toEqual([1, 2, 3]);
  });

  test("P3 the TUI's own rows are dropped, real options keep their numbers", () => {
    const labels = parseAskFromPane(REAL_MODAL)!.options.map((o) => o.label);
    expect(labels).not.toContain("Type something.");
    expect(labels).not.toContain("Chat about this");
  });

  test("P4 descriptions come along", () => {
    expect(parseAskFromPane(REAL_MODAL)!.options.map((o) => o.description)).toEqual([
      "หวานสุด",
      "ราชาผลไม้",
      "เปลือกมีขน",
    ]);
  });

  test("P5 a WORKING pane is not a modal", () => {
    expect(parseAskFromPane(REAL_WORKING)).toBeNull();
  });

  test("P6 a numbered list in ordinary output is not a modal", () => {
    // The exact false positive the engine's own pane-waiting check hit: a todo
    // panel read as a choice box. Only the footer decides.
    const chat = ["● แผนคือ", "  1. อ่านโค้ด", "  2. เขียนเทส", "  3. รัน", "✻ Cooked for 5s"].join("\n");
    expect(parseAskFromPane(chat)).toBeNull();
  });

  test("P7 an ANSWERED modal (footer gone) stops reporting", () => {
    const after = REAL_MODAL.replace("Enter to select · ↑/↓ to navigate · Esc to cancel", "● ได้แล้ว คุณเลือก มะม่วง");
    expect(parseAskFromPane(after)).toBeNull();
  });

  test("P8 the newest modal wins when an older one is still in scrollback", () => {
    const two =
      REAL_MODAL.replace("ผลไม้", "เก่า").replace("มะม่วง", "ของเก่า") + "\n" + REAL_MODAL;
    expect(parseAskFromPane(two)!.header).toBe("ผลไม้");
  });

  test("P9 a footer with no options above it is not an ask", () => {
    expect(parseAskFromPane("some text\nEnter to select · Esc to cancel")).toBeNull();
  });

  test("P10 blank / garbage never throws", () => {
    expect(parseAskFromPane("")).toBeNull();
    expect(parseAskFromPane("\n\n\n")).toBeNull();
    expect(parseAskFromPane("Esc to cancel")).toBeNull();
  });

  test("P11 a modal with no header still yields its options", () => {
    const bare = ["  1. ใช่", "  2. ไม่", "Enter to select · Esc to cancel"].join("\n");
    const ask = parseAskFromPane(bare);
    expect(ask!.options.map((o) => o.label)).toEqual(["ใช่", "ไม่"]);
    expect(ask!.header).toBe("");
  });

  test("P12 an option list past 9 entries keeps only single-digit keys", () => {
    const many = [
      " ☐ h",
      "q?",
      ...Array.from({ length: 12 }, (_, i) => `  ${i + 1}. opt${i + 1}`),
      "Enter to select · Esc to cancel",
    ].join("\n");
    const keys = parseAskFromPane(many)!.options.map((o) => o.key);
    expect(Math.max(...keys)).toBeLessThanOrEqual(9);
    // "10." parses its first digit as 1 — the real 1 must win, not be overwritten.
    expect(parseAskFromPane(many)!.options.find((o) => o.key === 1)!.label).toBe("opt1");
  });

  test("P13 a multiSelect box is recognised from its [ ] checkboxes", () => {
    const ask = parseAskFromPane(REAL_MULTI);
    expect(ask).not.toBeNull();
    expect(ask!.multiSelect).toBe(true);
    expect(ask!.options.map((o) => o.label)).toEqual(["\u0e21\u0e30\u0e21\u0e48\u0e27\u0e07", "\u0e17\u0e38\u0e40\u0e23\u0e35\u0e22\u0e19", "\u0e40\u0e07\u0e32\u0e30"]);
  });

  test("P14 the multiSelect header drops its tab arrows and Submit affordance", () => {
    expect(parseAskFromPane(REAL_MULTI)!.header).toBe("\u0e1c\u0e25\u0e44\u0e21\u0e49");
  });

  test("P15 the single-select box is NOT flagged multiSelect", () => {
    expect(parseAskFromPane(REAL_MODAL)!.multiSelect).toBe(false);
  });
});

// ── isDigitAnswerable ──────────────────────────────────────────────────────
describe("isDigitAnswerable", () => {
  test("N1 single-select can be answered with one digit (live-proved)", () => {
    expect(isDigitAnswerable(parseAskFromPane(REAL_MODAL)!)).toBe(true);
  });

  test("N2 multiSelect can NOT — a digit only toggles, Submit still needed", () => {
    expect(isDigitAnswerable(parseAskFromPane(REAL_MULTI)!)).toBe(false);
  });

});

// ── askKey ─────────────────────────────────────────────────────────────────
describe("askKey", () => {
  test("D1 the same box in the same pane is the same ask across polls", () => {
    const a = parseAskFromPane(REAL_MODAL)!;
    const b = parseAskFromPane(REAL_MODAL)!;
    expect(askKey("%1", a)).toBe(askKey("%1", b));
  });

  test("D2 the same question in a DIFFERENT pane is a different ask", () => {
    const a = parseAskFromPane(REAL_MODAL)!;
    expect(askKey("%1", a)).not.toBe(askKey("%2", a));
  });

  test("D3 a different question in the same pane is a different ask", () => {
    const a = parseAskFromPane(REAL_MODAL)!;
    const b = parseAskFromPane(REAL_MODAL.replace("ชอบผลไม้อะไร?", "ชอบสีอะไร?"))!;
    expect(askKey("%1", a)).not.toBe(askKey("%1", b));
  });
});

// ── buildAnswerArgs ────────────────────────────────────────────────────────
describe("buildAnswerArgs", () => {
  test("K1 sends the printed digit to the PANE id, with no Enter", () => {
    // Live-proved on a real modal 2026-08-07: this exact argv picked option 2.
    // A session target would hit the ACTIVE pane (wrong agent), and `=<session>`
    // is a known tmux 3.4 failure.
    expect(buildAnswerArgs("%0", 2)).toEqual(["send-keys", "-t", "%0", "2"]);
  });

  test("K2 refuses anything that is not a %N pane id", () => {
    expect(() => buildAnswerArgs("09-foreman", 1)).toThrow();
    expect(() => buildAnswerArgs("%1; rm -rf /", 1)).toThrow();
    expect(() => buildAnswerArgs("", 1)).toThrow();
  });

  test("K3 refuses a digit the TUI could not have printed", () => {
    expect(() => buildAnswerArgs("%1", 0)).toThrow();
    expect(() => buildAnswerArgs("%1", 10)).toThrow();
    expect(() => buildAnswerArgs("%1", 1.5)).toThrow();
  });
});

// ── parsePaneList ──────────────────────────────────────────────────────────
describe("parsePaneList", () => {
  test("M1 keeps pane, session and running command", () => {
    const raw = ["%0\taskprobe\tclaude", "%1\t09-foreman\tnode", "%2\t09-foreman\tbash"].join("\n");
    expect(parsePaneList(raw)).toEqual([
      { pane: "%0", session: "askprobe", cmd: "claude" },
      { pane: "%1", session: "09-foreman", cmd: "node" },
      { pane: "%2", session: "09-foreman", cmd: "bash" },
    ]);
  });

  test("M2 drops rows whose pane id is not a tmux target", () => {
    expect(parsePaneList("bad\ts\tclaude\n%3\ts\tclaude")).toEqual([
      { pane: "%3", session: "s", cmd: "claude" },
    ]);
  });

  test("M3 blank / error output yields nothing", () => {
    expect(parsePaneList("")).toEqual([]);
    expect(parsePaneList("no server running on /tmp/tmux-1000/default")).toEqual([]);
  });
});

// ── scanPending ────────────────────────────────────────────────────────────
describe("scanPending", () => {
  const panes = [
    { pane: "%1", session: "09-foreman", cmd: "claude" },
    { pane: "%2", session: "09-foreman", cmd: "claude" },
  ];

  test("S1 one hit per blocked pane, carrying the pane to answer on", () => {
    const hits = scanPending(panes, (p) => (p === "%2" ? REAL_MODAL : REAL_WORKING));
    expect(hits).toHaveLength(1);
    expect(hits[0].pane).toBe("%2");
    expect(hits[0].session).toBe("09-foreman");
    expect(hits[0].ask.header).toBe("ผลไม้");
  });

  test("S2 an unreadable pane never hides another pane's question", () => {
    const hits = scanPending(panes, (p) => {
      if (p === "%1") throw new Error("pane died");
      return REAL_MODAL;
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].pane).toBe("%2");
  });

  test("S3 two panes waiting both report, with distinct keys", () => {
    const hits = scanPending(panes, () => REAL_MODAL);
    expect(hits).toHaveLength(2);
    expect(hits[0].key).not.toBe(hits[1].key);
  });

  test("S4 nothing waiting = no work", () => {
    expect(scanPending(panes, () => REAL_WORKING)).toEqual([]);
    expect(scanPending([], () => REAL_MODAL)).toEqual([]);
  });
});

// ── itemLabel / findOptionByLabel ──────────────────────────────────────────
// The QuickPick round-trip: a label is FORMATTED for display, then the accept
// handler matches the picked label back to its option. If those two ever
// diverge the box renders fine and the click silently does nothing — the same
// dead-affordance class as the dashboard row that had no handler. Both sides
// now go through these functions, and these tests are what keep them in step.
describe("QuickPick label round-trip", () => {
  const ask = (labels: string[]) => ({
    header: "h",
    question: "q",
    multiSelect: false,
    options: labels.map((label, i) => ({ key: i + 1, label, description: "" })),
  });

  test("R1 a formatted label finds its own option again", () => {
    const a = ask(["Now", "Tonight", "Tomorrow"]);
    for (const o of a.options) {
      expect(findOptionByLabel(a, itemLabel(o))!.key).toBe(o.key);
    }
  });

  test("R2 Thai labels round-trip", () => {
    const a = ask(["เดี๋ยวนี้", "คืนนี้", "พรุ่งนี้"]);
    expect(findOptionByLabel(a, itemLabel(a.options[2]))!.label).toBe("พรุ่งนี้");
  });

  test("R3 a label that itself looks numbered does not match the wrong key", () => {
    // Option 1's text is "2. เอาแบบเดิม" -> displayed as "1. 2. เอาแบบเดิม".
    // A lookup that parsed the leading digit would return option 2. It must not.
    const a = ask(["2. เอาแบบเดิม", "อย่างอื่น"]);
    expect(findOptionByLabel(a, itemLabel(a.options[0]))!.key).toBe(1);
  });

  test("R4 duplicate label text stays distinguishable by its key", () => {
    const a = ask(["same", "same"]);
    expect(findOptionByLabel(a, itemLabel(a.options[1]))!.key).toBe(2);
  });

  test("R5 a label from a different box matches nothing", () => {
    expect(findOptionByLabel(ask(["a", "b"]), "1. หายไปแล้ว")).toBeNull();
    expect(findOptionByLabel(ask(["a", "b"]), "")).toBeNull();
  });

  test("R6 the displayed label carries the digit the pane will receive", () => {
    expect(itemLabel({ key: 3, label: "Friday", description: "" })).toBe("3. Friday");
  });
});
