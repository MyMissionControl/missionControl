import { test, expect } from "bun:test";
import { parseEntry, parseAskUserQuestion } from "./transcriptChat";

// Real AskUserQuestion input shape captured from a live orchestrator transcript.
const ASK_INPUT = {
  questions: [
    {
      question: "Tech stack ฝั่ง frontend/backend อยากใช้อะไรครับ?",
      header: "Tech stack",
      options: [
        { label: "Next.js full-stack", description: "App Router เดียวจบ" },
        { label: "React + Express แยก", description: "คนละ service" },
      ],
      multiSelect: false,
    },
    {
      question: "database แบบไหน?",
      header: "Database",
      options: [{ label: "SQLite", description: "ไฟล์เดียว" }],
      multiSelect: true,
    },
  ],
};

function askEntry(input: unknown) {
  return {
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-08-01T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "AskUserQuestion", input }],
    },
  };
}

test("parseAskUserQuestion parses questions + options from real shape", () => {
  const q = parseAskUserQuestion(ASK_INPUT);
  expect(q).toBeDefined();
  expect(q!.length).toBe(2);
  expect(q![0].question).toContain("Tech stack");
  expect(q![0].header).toBe("Tech stack");
  expect(q![0].multiSelect).toBe(false);
  expect(q![0].options.length).toBe(2);
  expect(q![0].options[0].label).toBe("Next.js full-stack");
  expect(q![0].options[0].description).toContain("App Router");
  expect(q![1].multiSelect).toBe(true);
  expect(q![1].options[0].label).toBe("SQLite");
});

test("parseAskUserQuestion is defensive on malformed input", () => {
  expect(parseAskUserQuestion(undefined)).toBeUndefined();
  expect(parseAskUserQuestion({})).toBeUndefined();
  expect(parseAskUserQuestion({ questions: "nope" })).toBeUndefined();
  expect(parseAskUserQuestion({ questions: [] })).toBeUndefined();
  // a question with no valid options is dropped; if none survive -> undefined
  expect(parseAskUserQuestion({ questions: [{ question: "x", options: [] }] })).toBeUndefined();
  // option missing description is fine (description optional)
  const q = parseAskUserQuestion({ questions: [{ question: "x", options: [{ label: "a" }] }] });
  expect(q).toBeDefined();
  expect(q![0].options[0].label).toBe("a");
  expect(q![0].options[0].description).toBeUndefined();
});

test("parseEntry attaches ask[] to an AskUserQuestion tool_use block", () => {
  const m = parseEntry(askEntry(ASK_INPUT));
  expect(m).not.toBeNull();
  const b = m!.blocks[0];
  expect(b.kind).toBe("tool_use");
  expect(b.name).toBe("AskUserQuestion");
  expect(b.ask).toBeDefined();
  expect(b.ask!.length).toBe(2);
  expect(b.ask![0].options[0].label).toBe("Next.js full-stack");
});

test("parseEntry leaves ask undefined for a normal (non-Ask) tool_use", () => {
  const m = parseEntry({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }] },
  });
  expect(m).not.toBeNull();
  expect(m!.blocks[0].ask).toBeUndefined();
});
