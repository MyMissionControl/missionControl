import { describe, expect, test } from "bun:test";

import {
  REQUIREMENT_TEMPLATE,
  applyExtension,
  approxTokens,
  buildCheckPrompt,
  buttonModeFor,
  parseCheckResult,
  validateFileName,
  validateSaveDir,
} from "./requirementOps";

describe("REQUIREMENT_TEMPLATE", () => {
  test("carries the agreed headings and no acceptance section", () => {
    expect(REQUIREMENT_TEMPLATE).toContain("## ภาพรวม");
    expect(REQUIREMENT_TEMPLATE).toContain("## role และสิทธิ์");
    expect(REQUIREMENT_TEMPLATE).toContain("## หน้าจอและฟีเจอร์");
    expect(REQUIREMENT_TEMPLATE).toContain("## ข้อมูลที่ต้องเก็บ");
    expect(REQUIREMENT_TEMPLATE).toContain("## Tech stack และข้อจำกัด");
    expect(REQUIREMENT_TEMPLATE).toContain("## ไม่ต้องทำ (out of scope)");
    expect(REQUIREMENT_TEMPLATE).not.toContain("acceptance");
    expect(REQUIREMENT_TEMPLATE).not.toContain("deploy");
  });

  test("hints are real markdown comments so they render to nothing", () => {
    const hints = REQUIREMENT_TEMPLATE.split("\n").filter((l) => l.trim().startsWith("<!--"));
    expect(hints.length).toBeGreaterThan(4);
    hints.forEach((l) => expect(l.trim().endsWith("-->")).toBe(true));
  });

  test("data section asks for primary key and many-to-many in words", () => {
    expect(REQUIREMENT_TEMPLATE).toContain("primary key");
    expect(REQUIREMENT_TEMPLATE).toContain("many to many");
    expect(REQUIREMENT_TEMPLATE).not.toContain("N:N");
  });
});

describe("approxTokens", () => {
  test("counts ASCII at roughly a quarter of its characters", () => {
    expect(approxTokens("abcd".repeat(25))).toBe(25);
  });

  test("counts Thai heavier than ASCII", () => {
    const thai = "ก".repeat(100);
    const ascii = "a".repeat(100);
    expect(approxTokens(thai)).toBeGreaterThan(approxTokens(ascii));
  });

  test("empty text is zero, never NaN", () => {
    expect(approxTokens("")).toBe(0);
  });
});

describe("buildCheckPrompt", () => {
  test("carries the draft and forbids anything but JSON", () => {
    const p = buildCheckPrompt("ร่างของฉัน", []);
    expect(p).toContain("ร่างของฉัน");
    expect(p.toLowerCase()).toContain("json");
  });

  // Regression guard for the 2026-08-07 hang: instructing a headless run to
  // invoke `grilling` makes it wait for an interviewee who is not there, and
  // sends it exploring the codebase. Both stances are inlined instead.
  test("never tells a headless run to invoke the interview skills", () => {
    const p = buildCheckPrompt("ร่าง", []);
    expect(p).not.toContain("grilling");
    expect(p).not.toContain("สกิล");
  });

  test("forbids asking back, waiting, and touching the filesystem", () => {
    const p = buildCheckPrompt("ร่าง", []);
    expect(p).toContain("ห้ามถามกลับ");
    expect(p).toContain("ห้ามรอคำตอบ");
    expect(p).toContain("ห้ามเรียกเครื่องมือ");
    expect(p).toContain("questions");
  });

  test("round two replays the answered questions and drops skipped ones", () => {
    const p = buildCheckPrompt("ร่าง", [
      { q: "ใช้ DB อะไร", a: "sqlite" },
      { q: "รองรับกี่ภาษา", a: "" },
    ]);
    expect(p).toContain("ใช้ DB อะไร");
    expect(p).toContain("sqlite");
    expect(p).not.toContain("รองรับกี่ภาษา");
  });
});

describe("parseCheckResult", () => {
  const good = {
    verdict: "needs-work",
    questions: [{ id: "q1", q: "ใครใช้", why: "แบ่ง role ไม่ได้", options: ["admin", "user"] }],
    assumptions: [{ what: "ใช้ SQLite", why: "ข้อมูลเล็ก ไม่ต้องตั้งเซิร์ฟเวอร์" }],
    revised: "# ร่างใหม่",
  };

  test("parses bare JSON", () => {
    const r = parseCheckResult(JSON.stringify(good));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.revised).toBe("# ร่างใหม่");
  });

  test("survives a preamble line before the JSON", () => {
    const r = parseCheckResult("Here is the review you asked for:\n" + JSON.stringify(good));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.questions[0].q).toBe("ใครใช้");
  });

  test("survives a fenced json block", () => {
    const r = parseCheckResult("```json\n" + JSON.stringify(good) + "\n```\nhope this helps");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.assumptions).toEqual([{ what: "ใช้ SQLite", why: "ข้อมูลเล็ก ไม่ต้องตั้งเซิร์ฟเวอร์" }]);
  });

  test("returns an error instead of throwing on garbage", () => {
    const r = parseCheckResult("claude is not installed");
    expect(r.ok).toBe(false);
  });

  test("returns an error when revised is missing — never silently blanks the draft", () => {
    const r = parseCheckResult(JSON.stringify({ verdict: "ok", gaps: [], questions: [] }));
    expect(r.ok).toBe(false);
  });

  test("tolerates missing optional arrays", () => {
    const r = parseCheckResult(JSON.stringify({ verdict: "ok", revised: "# x" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assumptions).toEqual([]);
      expect(r.value.questions).toEqual([]);
    }
  });

  test("drops assumptions with no 'what' rather than rendering blank cards", () => {
    const r = parseCheckResult(
      JSON.stringify({
        verdict: "ok",
        revised: "# x",
        assumptions: [{ why: "เหตุผลลอยๆ" }, { what: "ใช้ Postgres" }, "ไม่ใช่ object"],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.assumptions).toEqual([{ what: "ใช้ Postgres", why: "" }]);
    }
  });

  // The old `gaps` field restated whatever it belonged to — measured 100%
  // redundant on a real draft. It must not come back through the prompt.
  test("the prompt asks for questions and assumptions, never a separate gap list", () => {
    const p = buildCheckPrompt("ร่าง", []);
    expect(p).toContain("assumptions");
    expect(p).not.toContain('"gaps"');
    expect(p).toContain("ห้ามอยู่ทั้งสองที่");
  });

  test("coerces an unknown verdict to needs-work", () => {
    const r = parseCheckResult(JSON.stringify({ verdict: "perfect", revised: "# x" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("needs-work");
  });

  test("drops malformed questions rather than rendering blank cards", () => {
    const r = parseCheckResult(
      JSON.stringify({ verdict: "ok", revised: "# x", questions: [{ why: "no q here" }, { q: "ok?" }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.questions.length).toBe(1);
      expect(r.value.questions[0].q).toBe("ok?");
      expect(r.value.questions[0].id).toBeTruthy();
    }
  });
});

describe("validateFileName", () => {
  test("appends .md when missing", () => {
    expect(applyExtension("myproject")).toBe("myproject.md");
    expect(applyExtension("myproject.md")).toBe("myproject.md");
    expect(applyExtension("myproject.MD")).toBe("myproject.MD");
  });

  test("rejects a path separator", () => {
    expect(validateFileName("a/b.md").ok).toBe(false);
  });

  test("rejects traversal", () => {
    expect(validateFileName("..").ok).toBe(false);
    expect(validateFileName("../x.md").ok).toBe(false);
  });

  test("rejects empty or whitespace-only", () => {
    expect(validateFileName("").ok).toBe(false);
    expect(validateFileName("   ").ok).toBe(false);
  });

  test("accepts a Thai filename", () => {
    expect(validateFileName("โปรเจค.md").ok).toBe(true);
  });
});

describe("validateSaveDir", () => {
  const stat = (p: string): "dir" | "file" | "missing" =>
    p === "/home/u/Downloads" ? "dir" : p === "/home/u/notes.md" ? "file" : "missing";

  test("accepts an existing absolute directory", () => {
    expect(validateSaveDir("/home/u/Downloads", stat).ok).toBe(true);
  });

  test("rejects a relative path", () => {
    expect(validateSaveDir("Downloads", stat).ok).toBe(false);
  });

  test("rejects a path that is a file", () => {
    expect(validateSaveDir("/home/u/notes.md", stat).ok).toBe(false);
  });

  test("reports a missing directory as missing so the caller can offer to create it", () => {
    const r = validateSaveDir("/home/u/nope", stat);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
  });

  test("tolerates a trailing slash", () => {
    expect(validateSaveDir("/home/u/Downloads/", stat).ok).toBe(true);
  });
});

describe("buttonModeFor", () => {
  test("nothing saved yet means download", () => {
    expect(buttonModeFor("draft", null)).toBe("download");
  });

  test("unchanged since save means copy", () => {
    expect(buttonModeFor("draft", "draft")).toBe("copy");
  });

  test("any edit flips back to download", () => {
    expect(buttonModeFor("draft!", "draft")).toBe("download");
  });

  test("editing then undoing back to the saved text returns to copy", () => {
    expect(buttonModeFor("draft", "draft")).toBe("copy");
  });
});
