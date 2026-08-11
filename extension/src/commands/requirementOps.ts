// Pure logic behind the "Create Requirement" page (webview/createRequirement.ts).
// Deliberately free of `vscode` and `node:fs` imports so `bun test` can exercise
// it directly — the panel keeps only the I/O (spawn claude, write the file,
// clipboard). Same split as localhostScan/localhostStop and teamsModel.

/** The scaffold pre-filled into the empty textarea, so the user never starts
 *  from a blank page. Hints are real markdown comments: leaving them in place
 *  renders to nothing and `/orches` reads straight past them. */
export const REQUIREMENT_TEMPLATE = [
  "# <ชื่อโปรเจกต์>",
  "",
  "## ภาพรวม",
  "<!-- สร้างอะไร ให้ใครใช้ แก้ปัญหาอะไร — 3-5 บรรทัด -->",
  "",
  "## role และสิทธิ์",
  "<!-- มี role อะไรบ้าง แต่ละ role ทำอะไรได้ / ไม่ได้ -->",
  "",
  "## หน้าจอและฟีเจอร์",
  "<!-- ไล่ทีละหน้า: ชื่อหน้า → เห็นอะไร → กดอะไรได้ → กดแล้วเกิดอะไร -->",
  "1.",
  "2.",
  "",
  "## ข้อมูลที่ต้องเก็บ",
  "<!-- primary key + ความสัมพันธ์ (1 to many / many to many) + field สำคัญ -->",
  "",
  "## Tech stack และข้อจำกัด",
  "<!-- ภาษา/framework/DB ที่บังคับ · ห้ามใช้อะไร -->",
  "",
  "## ไม่ต้องทำ (out of scope)",
  "<!-- ตัดสิ่งที่ agent ชอบเดาเอง -->",
  "",
].join("\n");

// ── Token estimate ───────────────────────────────────────────────────────────

/** Rough token count for the status line, computed with arithmetic only so the
 *  webview can run it on every keystroke with zero latency and zero network.
 *  ASCII is ~4 chars/token; Thai and other non-Latin scripts tokenize far
 *  worse, so they count as ~2 chars/token. Always rendered with a "~" prefix —
 *  this is an estimate, never a billing figure. */
export function approxTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.round(ascii / 4 + wide / 2);
}

// ── Check prompt ─────────────────────────────────────────────────────────────

export type QA = { q: string; a: string };

/** Which pass we are asking for.
 *
 *  "triage"  — questions + assumptions only, NO rewrite. This is what the user
 *              waits on before the wizard can open, so it is kept cheap.
 *  "rewrite" — the full rewritten draft, asked ONCE after the answers are in.
 *
 *  Measured 2026-08-07 on a real 3.2KB Thai draft, same prompt otherwise:
 *    triage,  effort low     37s   2,086 output tokens   $0.12
 *    rewrite, effort medium 171s  12,914 output tokens   $0.39
 *    (what shipped before: one pass, default effort, 405s / 33,684 tok / $0.70,
 *     and its rewrite was discarded the moment the user answered and re-checked)
 *  77% of the old wait was pre-first-token thinking (ttft 311s of 405s), which
 *  is why effort — not output length — is the lever that matters here. */
export type CheckPhase = "triage" | "rewrite";

/** Prompt for `claude -p`.
 *
 *  ⛔ Deliberately does NOT tell the model to invoke the `grilling` skill.
 *  grilling is a LIVE INTERVIEW primitive — its own text says "ask the questions
 *  one at a time, waiting for feedback on each question before continuing",
 *  "do not enact the plan until I confirm", and "if a question can be answered
 *  by exploring the codebase, explore the codebase instead". Headless there is
 *  nobody to answer, so naming it made `claude -p` run past 6 minutes without
 *  ever printing (measured 2026-08-07; a plain `claude -p` round-trips in ~7s).
 *  So both skills' STANCE is inlined here instead, and the panel spawns claude
 *  with the tool set emptied — one turn in, one JSON out. */
export function buildCheckPrompt(draft: string, qa: QA[], phase: CheckPhase = "rewrite"): string {
  const wantsRewrite = phase === "rewrite";
  const answered = (qa || []).filter((x) => x && typeof x.a === "string" && x.a.trim().length > 0);
  // Skipped questions are NOT dropped. Silently omitting them told the model
  // nothing, so it happily asked them again next round and the user paid another
  // full pass to dismiss the same question twice.
  const skipped = (qa || []).filter(
    (x) => x && typeof x.q === "string" && x.q.trim().length > 0 &&
      !(typeof x.a === "string" && x.a.trim().length > 0),
  );
  const parts: string[] = [
    "ตรวจร่าง requirement ข้างล่างนี้ แล้วตอบกลับครั้งเดียวจบ",
    "",
    "⛔ ห้ามถามกลับมาเป็นข้อความ ห้ามรอคำตอบ ห้ามเปิดอ่านไฟล์หรือสำรวจ codebase",
    "ห้ามเรียกเครื่องมือใดๆ — ใช้เฉพาะข้อความในร่างที่ให้มาเท่านั้น",
    "คำถามที่อยากถาม ให้ใส่ลงใน field questions ของ JSON แล้วจบการทำงาน",
    "",
    "มุมที่ใช้ตรวจ (2 มุม):",
    "1. ซักไซ้ — ไล่ทีละกิ่งของการตัดสินใจ หาจุดที่ 'ตอบคนละแบบแล้วโค้ดออกมาคนละอย่าง'",
    "   ทุกคำถามต้องแนบคำตอบที่แนะนำไว้เป็น options ตัวแรก",
    "2. คนนอก — ลืมไปว่าใครเขียนและเขาคิดว่าถูกเพราะอะไร อ่านร่างแบบเย็นชา",
    "   ถามด้วยว่าสิ่งนี้ควรมีอยู่ไหม และมีวิธีที่ง่ายกว่านี้ที่ได้ผลเดียวกันหรือเปล่า",
    "   ทุกข้อที่ติงต้องบอกว่า 'แก้อะไร' + 'ทำไม' ไม่ใช่เล่าร่างซ้ำ",
    "",
    "เกณฑ์ผ่าน: ร่างต้องละเอียดพอให้ orchestrator ของ /orches แตกเป็น sprint",
    "และแบ่ง role (โซนไฟล์ที่ไม่ทับกัน) ได้โดยไม่ต้องเดาเอง โดยเฉพาะ",
    "- แต่ละหน้า/ฟีเจอร์ กดแล้วเกิดอะไร (ไม่ใช่แค่ชื่อหน้า)",
    "- role ไหนเห็น/ทำอะไรได้บ้าง",
    "- ข้อมูลที่เก็บ + ความสัมพันธ์ระหว่างตาราง",
    "- ข้อจำกัดที่บังคับ (ภาษา/framework/DB) และสิ่งที่ไม่ต้องทำ",
    "- รู้ได้ยังไงว่างานเสร็จ (ตรวจได้จริง ไม่ใช่ความรู้สึก)",
    "",
    "ถามเฉพาะจุดที่ 'กำกวมจริง' — จุดที่ตอบคนละแบบแล้วโค้ดออกมาคนละอย่าง",
    "อย่าถามเรื่องที่เดาแทนได้อย่างปลอดภัย ให้เขียนสมมติฐานลงร่างแทน",
    "",
    "ตอบเป็น JSON วัตถุเดียวเท่านั้น ห้ามมีข้อความอื่นนอก JSON ห้ามใส่ code fence รูปแบบ:",
    '{"verdict":"ok|needs-work",',
    '"questions":[{"id":"q1","q":"คำถาม","why":"ทำไมต้องรู้","options":["ตัวเลือก1","ตัวเลือก2"]}],',
  ];
  if (wantsRewrite) {
    parts.push(
      '"assumptions":[{"what":"สิ่งที่ตัดสินใจแทนแล้วเขียนลงร่างเลย","why":"ทำไมถึงเลือกแบบนี้"}],',
      '"revised":"ร่างฉบับแก้แล้วเต็มฉบับเป็น markdown"}',
    );
  } else {
    parts.push('"assumptions":[{"what":"สิ่งที่จะตัดสินใจแทนให้","why":"ทำไมถึงเลือกแบบนี้"}]}');
  }
  parts.push(
    "",
    "ทุกประเด็นที่เจอ ต้องลงได้ที่เดียวเท่านั้น — questions หรือ assumptions:",
    "- questions = เรื่องที่ตัดสินใจแทนไม่ได้ ต้องให้ผู้ใช้ตอบ",
    "- assumptions = เรื่องที่ตัดสินใจแทนได้เองอย่างปลอดภัย",
    "⛔ เรื่องเดียวกันห้ามอยู่ทั้งสองที่ และห้ามมีลิสต์ 'สิ่งที่ยังขาด' ลอยๆ แยกอีกกอง",
  );
  if (wantsRewrite) {
    parts.push(
      "",
      "revised ต้องเป็นร่างเต็มฉบับพร้อมใช้เสมอ (ไม่ใช่ diff ไม่ใช่ข้อเสนอแนะ)",
      "เขียน revised เป็นภาษาไทยแบบเดียวกับร่างเดิม และคง heading เดิมไว้",
      "ถ้าร่างดีอยู่แล้วให้ verdict=ok, questions=[] และ revised = ร่างเดิมที่ขัดเกลาแล้ว",
    );
  } else {
    parts.push(
      "",
      "⛔ รอบนี้ห้ามส่ง field revised และห้ามเขียนร่างฉบับแก้กลับมา",
      "เอาแค่ questions กับ assumptions — ร่างจริงจะขอในรอบถัดไปหลังผู้ใช้ตอบคำถามแล้ว",
    );
  }
  if (answered.length > 0) {
    parts.push(
      "",
      wantsRewrite
        ? "รอบก่อนถามไปแล้ว และผู้ใช้ตอบมาแบบนี้ — ใส่คำตอบพวกนี้ลงใน revised และห้ามถามซ้ำ:"
        : "รอบก่อนถามไปแล้ว และผู้ใช้ตอบมาแบบนี้ — ห้ามถามซ้ำ:",
    );
    answered.forEach((x) => parts.push("- ถาม: " + x.q, "  ตอบ: " + x.a.trim()));
  }
  if (skipped.length > 0) {
    parts.push(
      "",
      "ข้อพวกนี้ถามไปแล้วและผู้ใช้เลือก 'ข้าม' — แปลว่าเขาไม่อยากตัดสินใจเอง",
      "⛔ ห้ามถามซ้ำ ให้ตัดสินใจแทนแล้วใส่ลงใน assumptions พร้อมเหตุผล:",
    );
    skipped.forEach((x) => parts.push("- " + x.q.trim()));
  }
  parts.push("", "--- ร่าง requirement ---", draft);
  return parts.join("\n");
}

// ── Parsing claude's answer ──────────────────────────────────────────────────

export type Question = { id: string; q: string; why: string; options: string[] };
/** Something the model decided on the user's behalf and already wrote into
 *  `revised`. Replaced the old free-floating `gaps` list, which was measured
 *  (2026-08-07, on a real 3.2KB draft) to be 100% redundant: 7 of its 11 items
 *  restated a question sitting right below them, and the other 4 were already
 *  visible as added lines in the diff. Classifying each finding once — ask vs
 *  decided — is what removes the overlap. */
export type Assumption = { what: string; why: string };
export type CheckResult = {
  verdict: "ok" | "needs-work";
  questions: Question[];
  assumptions: Assumption[];
  /** null on a triage pass, and also when a rewrite pass came back without one.
   *  It used to be required, which meant a reply carrying eight good questions
   *  but a truncated rewrite was thrown away whole and the user paid another
   *  full pass to get back what was already on screen. The page gates Apply on
   *  this being non-null instead. */
  revised: string | null;
};
export type ParseOutcome =
  | { ok: true; value: CheckResult }
  | { ok: false; error: string };

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** Pull the result object out of whatever `claude -p` printed. It reliably
 *  ignores "output ONLY json" some of the time — preambles and ```json fences
 *  both show up (the same failure that produced commit c8bc703 in gitOps), so
 *  fall back to the widest brace span before giving up. Never throws. */
export function parseCheckResult(raw: string): ParseOutcome {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "claude ไม่ได้ตอบอะไรกลับมา" };

  const candidates: string[] = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    let obj: unknown;
    try {
      obj = JSON.parse(c);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    // `revised` is optional. A payload is usable as long as it carries findings;
    // a missing rewrite only means Apply has nothing to apply, which the page
    // handles by disabling the button — it is not a reason to discard the
    // questions. Reject only a payload with nothing in it at all.
    const revised =
      typeof o.revised === "string" && o.revised.trim().length > 0 ? o.revised : null;
    const hasFindings =
      (Array.isArray(o.questions) && o.questions.length > 0) ||
      (Array.isArray(o.assumptions) && o.assumptions.length > 0);
    if (revised === null && !hasFindings && o.verdict !== "ok") continue;

    const questions: Question[] = (Array.isArray(o.questions) ? o.questions : [])
      .map((q, i): Question | null => {
        if (!q || typeof q !== "object") return null;
        const r = q as Record<string, unknown>;
        if (typeof r.q !== "string" || r.q.trim().length === 0) return null;
        return {
          id: typeof r.id === "string" && r.id.trim() ? r.id.trim() : "q" + (i + 1),
          q: r.q.trim(),
          why: typeof r.why === "string" ? r.why.trim() : "",
          options: asStringArray(r.options),
        };
      })
      .filter((q): q is Question => q !== null);

    const assumptions: Assumption[] = (Array.isArray(o.assumptions) ? o.assumptions : [])
      .map((a): Assumption | null => {
        if (!a || typeof a !== "object") return null;
        const r = a as Record<string, unknown>;
        if (typeof r.what !== "string" || r.what.trim().length === 0) return null;
        return { what: r.what.trim(), why: typeof r.why === "string" ? r.why.trim() : "" };
      })
      .filter((a): a is Assumption => a !== null);

    return {
      ok: true,
      value: {
        verdict: o.verdict === "ok" ? "ok" : "needs-work",
        questions,
        assumptions,
        revised,
      },
    };
  }
  return { ok: false, error: "อ่านคำตอบของ claude เป็น JSON ไม่ได้" };
}

// ── Save target validation ───────────────────────────────────────────────────

export type Check = { ok: boolean; error?: string; missing?: boolean };

/** Add `.md` unless the name already ends in it (case-insensitively — a user
 *  who typed `.MD` meant it). */
export function applyExtension(name: string): string {
  const n = String(name ?? "").trim();
  return /\.md$/i.test(n) ? n : n + ".md";
}

export function validateFileName(name: string): Check {
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, error: "ยังไม่ได้ใส่ชื่อไฟล์" };
  if (n.indexOf("/") >= 0) return { ok: false, error: "ชื่อไฟล์มี / ไม่ได้ — ใส่โฟลเดอร์ในช่อง path" };
  if (n === "." || n === ".." || n.indexOf("..") >= 0)
    return { ok: false, error: "ชื่อไฟล์มี .. ไม่ได้" };
  if (n.charCodeAt(0) === 0) return { ok: false, error: "ชื่อไฟล์ไม่ถูกต้อง" };
  return { ok: true };
}

/** `stat` is injected so this stays testable without touching the filesystem;
 *  the panel passes a thin fs.statSync wrapper. A missing directory is NOT an
 *  error the user can't fix — it is flagged with `missing` so the caller can
 *  offer to create it rather than silently doing so. */
export function validateSaveDir(dir: string, stat: (p: string) => "dir" | "file" | "missing"): Check {
  let d = String(dir ?? "").trim();
  if (!d) return { ok: false, error: "ยังไม่ได้ใส่ path" };
  if (d.charAt(0) !== "/") return { ok: false, error: "ต้องเป็น absolute path (ขึ้นต้นด้วย /)" };
  if (d.length > 1 && d.endsWith("/")) d = d.replace(/\/+$/, "");
  const kind = stat(d || "/");
  if (kind === "dir") return { ok: true };
  if (kind === "file") return { ok: false, error: "path นี้เป็นไฟล์ ไม่ใช่โฟลเดอร์" };
  return { ok: false, error: "ยังไม่มีโฟลเดอร์นี้", missing: true };
}

// ── What a finished `claude -p` run actually means ───────────────────────────

export type ExitVerdict =
  | { kind: "ok"; out: string }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

/** Decide what a closed child process means. Split out of the panel because the
 *  obvious reading of the close event is wrong in two measured ways (2026-08-11,
 *  this machine):
 *
 *  - A SIGTERM'd `claude` arrives as **code 143, signal null** — not
 *    signal "SIGTERM". Cancellation therefore cannot be detected from the close
 *    event at all; the caller's own intent has to be passed in.
 *  - It prints **"Execution error" to STDOUT** (not stderr) when killed. Any
 *    "did it print anything?" test reads that as a successful run, hands it to
 *    parseCheckResult, and pops a parse-error panel on every single cancel.
 *
 *  Salvage still wins over everything: a run that printed its whole answer
 *  before dying is a success no matter how it exited. */
export function classifyCheckExit(x: {
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
  cancelRequested: boolean;
}): ExitVerdict {
  if (parseCheckResult(x.out).ok) return { kind: "ok", out: x.out };
  if (x.cancelRequested || x.signal === "SIGTERM") return { kind: "cancelled" };
  if (x.code !== 0) {
    return {
      kind: "error",
      error:
        x.err.trim().slice(0, 400) ||
        x.out.trim().slice(0, 400) ||
        "claude จบด้วย exit code " + x.code,
    };
  }
  // Exited cleanly but unparseable — let the caller's parser say why.
  return { kind: "ok", out: x.out };
}

// ── Download ⇄ Copy button ───────────────────────────────────────────────────

export type ButtonMode = "download" | "copy";

/** The button offers Copy only while the textarea still holds exactly what was
 *  written to disk. Compared by value, not by a dirty flag, so editing and then
 *  undoing back to the saved text returns to Copy on its own. */
export function buttonModeFor(current: string, savedText: string | null): ButtonMode {
  return savedText !== null && current === savedText ? "copy" : "download";
}
