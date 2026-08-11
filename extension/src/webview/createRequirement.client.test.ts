import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// The Create Requirement page's client JS lives inside a template literal in
// createRequirement.ts, so nothing type-checks or exercises it. Read the file as
// TEXT (importing it would pull in `vscode`), cut the <script> out, and run it
// against a stub DOM — that is the only way to prove the page's behaviour
// without launching an extension host.

const SRC = fs.readFileSync(path.join(__dirname, "createRequirement.ts"), "utf8");

function extractClientScript(): { js: string; html: string } {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  return { js: SRC.slice(start + "<script>".length, end), html: SRC.slice(SRC.lastIndexOf("<body>"), start) };
}

// ── Stub DOM ────────────────────────────────────────────────────────────────

type El = Record<string, any>;

function makeEl(id: string): El {
  const listeners: Record<string, Function[]> = {};
  const el: El = {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    scrollTop: 0,
    style: {},
    dataset: {},
    attrs: {} as Record<string, string>,
    listeners,
    classList: {
      _s: new Set<string>(),
      add(c: string) { this._s.add(c); },
      remove(c: string) { this._s.delete(c); },
      contains(c: string) { return this._s.has(c); },
    },
    addEventListener(type: string, fn: Function) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type: string, ev: any = {}) {
      (listeners[type] || []).forEach((fn) => fn({ target: el, currentTarget: el, ...ev }));
    },
    setAttribute(k: string, v: string) { el.attrs[k] = v; },
    getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k: string) { delete el.attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return [] as El[]; },
    setSelectionRange() {},
    select() {},
    focus() {},
    closest() { return null; },
  };
  return el;
}

/** Minimal innerHTML parser: enough to register generated elements by id and by
 *  class so getElementById / querySelectorAll reach the wizard controls. The
 *  page builds those with string concatenation, so a tag scan is faithful. */
function parseNodes(html: string, register: (id: string, el: El) => void): El[] {
  const out: El[] = [];
  const tagRe = /<([a-z]+)([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[2];
    const el = makeEl("");
    const pick = (name: string) => {
      const r = new RegExp("\\b" + name + '="([^"]*)"').exec(attrs);
      return r ? r[1] : null;
    };
    const id = pick("id");
    if (id) { el.id = id; register(id, el); }
    const cls = pick("class");
    if (cls) { el.className = cls; cls.split(/\s+/).forEach((c) => el.classList.add(c)); }
    const fill = pick("data-fill");
    if (fill !== null) el.attrs["data-fill"] = fill;
    const go = pick("data-go");
    if (go !== null) el.attrs["data-go"] = go;
    const val = pick("value");
    if (val !== null) el.value = val.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    el.disabled = /\bdisabled\b/.test(attrs);
    out.push(el);
  }
  return out;
}

type Harness = {
  els: Record<string, El>;
  posted: any[];
  execCalls: { text: string }[];
  receive: (msg: any) => void;
  execOk: boolean;
  execApplies: boolean;
};

function loadPage(opts: { execOk?: boolean; execApplies?: boolean } = {}): Harness {
  const { js, html } = extractClientScript();
  const ids = Array.from(html.matchAll(/id="([^"]+)"/g)).map((m) => m[1]);
  const els: Record<string, El> = {};
  ids.forEach((id) => (els[id] = makeEl(id)));

  // Elements the review pane generates at runtime, re-indexed on every repaint.
  let dynamic: Record<string, El> = {};
  let dynNodes: El[] = [];
  let dynIds: string[] = [];
  const rbody = els["rbody"];
  let rbodyHtml = "";
  delete rbody.innerHTML;
  Object.defineProperty(rbody, "innerHTML", {
    get: () => rbodyHtml,
    set: (v: string) => {
      rbodyHtml = v;
      // Drop the previous repaint's elements from `els` as well, so a test that
      // reaches for a control the current view does NOT render fails loudly
      // instead of quietly poking a detached node.
      dynIds.forEach((id) => delete els[id]);
      dynamic = {};
      dynIds = [];
      dynNodes = parseNodes(v, (id, el) => {
        dynamic[id] = el;
        els[id] = el;
        dynIds.push(id);
      });
    },
  });
  rbody.querySelectorAll = (sel: string) =>
    dynNodes.filter((n) => n.classList.contains(String(sel).replace(".", "")));

  const posted: any[] = [];
  const execCalls: { text: string }[] = [];
  const windowListeners: Record<string, Function[]> = {};
  const h: Harness = {
    els,
    posted,
    execCalls,
    execOk: opts.execOk !== false,
    execApplies: opts.execApplies !== false,
    receive: (msg: any) => (windowListeners["message"] || []).forEach((fn) => fn({ data: msg })),
  };

  const documentStub: any = {
    getElementById: (id: string) => els[id] || dynamic[id] || null,
    body: { classList: { contains: () => false } },
    documentElement: { dataset: {} },
    execCommand: (cmd: string, _ui: boolean, text: string) => {
      execCalls.push({ text });
      if (!h.execOk) return false;
      if (h.execApplies) els["ta"].value = text;
      return true;
    },
  };
  const windowStub: any = {
    addEventListener: (type: string, fn: Function) => {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
  };

  const fn = new Function(
    "document", "window", "acquireVsCodeApi", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date",
    js,
  );
  fn(
    documentStub,
    windowStub,
    () => ({ postMessage: (m: any) => posted.push(m) }),
    () => 0,           // timers are inert: autosave debounce and the elapsed
    () => {},          // ticker must not fire during a synchronous test
    () => 0,
    () => {},
    Date,
  );
  return h;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("client script hygiene", () => {
  test("contains no backslash or backtick — both would be eaten by the template literal", () => {
    const { js } = extractClientScript();
    expect(js.includes("\\")).toBe(false);
    expect(js.includes("`")).toBe(false);
  });

  // Regression guard for the toolbar misalignment: `.sec` was both a secondary
  // button modifier ("btn sec") and a review-pane block with margin-bottom:16px,
  // so the Check button sat 16px above Download (measured in headless chromium:
  // btnCheck 20-52, btnSave 36-68, both 32px tall).
  test("no button modifier class is also a bare block-level rule", () => {
    const css = SRC.slice(SRC.indexOf("<style>"), SRC.indexOf("</style>"));
    const modifiers = new Set<string>();
    for (const m of SRC.matchAll(/class="btn ([a-z]+)"/g)) modifiers.add(m[1]);
    for (const m of SRC.matchAll(/className = "btn ([a-z]+)"/g)) modifiers.add(m[1]);
    expect(modifiers.size).toBeGreaterThan(1);

    const offenders: string[] = [];
    modifiers.forEach((cls) => {
      // A bare `.cls {` or `.cls:pseudo {` rule — anything not qualified by .btn
      const bare = new RegExp("(^|[\\s,}])\\." + cls + "(:[a-z-]+)?\\s*\\{", "m");
      if (bare.test(css)) offenders.push(cls);
    });
    expect(offenders).toEqual([]);
  });

  // direction:rtl is the usual trick for eliding the START of a long path, but
  // it moves the leading "/" to the end — headless chromium rendered
  // "/home/u/Downloads" as "home/u/Downloads/".
  test("the folder path is not laid out right-to-left", () => {
    const css = SRC.slice(SRC.indexOf("<style>"), SRC.indexOf("</style>"));
    expect(css).not.toContain("direction: rtl");
  });

  test("every getElementById target is either in the markup or generated by the page", () => {
    const { js, html } = extractClientScript();
    const ids = [...new Set(Array.from(js.matchAll(/getElementById\("([^"]+)"\)/g)).map((m) => m[1]))];
    expect(ids.length).toBeGreaterThan(20);
    // The wizard builds its own controls, so an id may legitimately come from a
    // generated string instead of the static body.
    const generated = new Set(Array.from(js.matchAll(/id=.([a-zA-Z]+)./g)).map((m) => m[1]));
    expect(ids.filter((id) => !html.includes('id="' + id + '"') && !generated.has(id))).toEqual([]);
  });
});

describe("page load", () => {
  let h: Harness;
  beforeEach(() => { h = loadPage(); });

  test("loads without throwing and announces itself to the host", () => {
    expect(h.posted).toEqual([{ type: "ready" }]);
  });

  test("init fills the textarea and the token estimate", () => {
    h.receive({ type: "init", text: "abcd".repeat(25), savedText: null, savedPath: null, defaultDir: "/home/u/Downloads" });
    expect(h.els.ta.value.length).toBe(100);
    expect(h.els.tok.textContent).toBe("~25 tokens");
    expect(h.els.fDirText.textContent).toBe("/home/u/Downloads");
  });

  test("Check is disabled while the draft is empty", () => {
    h.receive({ type: "init", text: "", savedText: null, savedPath: null, defaultDir: "/d" });
    expect(h.els.btnCheck.disabled).toBe(true);
  });
});

describe("Ctrl+Z after a programmatic replace", () => {
  test("replaces via execCommand(insertText) so the native undo stack survives", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "setText", text: "NEW" });
    expect(h.execCalls.map((c) => c.text)).toEqual(["NEW"]);
    expect(h.els.ta.value).toBe("NEW");
  });

  // execCommand can report success without pushing an undo entry, and script
  // cannot observe that. So the link is offered whichever way the call went —
  // a hidden link plus a dead Ctrl+Z would mean no way back to the draft.
  test("offers the fallback undo link even when the native undo reports success", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "setText", text: "NEW" });
    expect(h.els.btnUndo.style.display).toBe("");
  });

  test("falls back to a direct assignment when execCommand is refused", () => {
    const h = loadPage({ execOk: false });
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "setText", text: "NEW" });
    expect(h.els.ta.value).toBe("NEW");
    expect(h.els.btnUndo.style.display).toBe("");
  });

  test("treats a silently-ignored execCommand as failure, not success", () => {
    // Returns true but leaves the field untouched — the dangerous middle case.
    const h = loadPage({ execOk: true, execApplies: false });
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "setText", text: "NEW" });
    expect(h.els.ta.value).toBe("NEW");
  });

  test("Apply routes the revised draft through the same undoable path", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "checkResult", phase: "rewrite", result: { verdict: "ok", questions: [], assumptions: [], revised: "REVISED" } });
    h.els.btnApply.fire("click");
    expect(h.execCalls.map((c) => c.text)).toEqual(["REVISED"]);
    expect(h.els.ta.value).toBe("REVISED");
    expect(h.els.btnUndo.style.display).toBe("");
  });

  test("the fallback undo link restores the pre-Apply draft", () => {
    const h = loadPage({ execOk: false });
    h.receive({ type: "init", text: "OLD", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "checkResult", result: { verdict: "ok", gaps: [], questions: [], revised: "REVISED" }, diff: [] });
    h.els.btnApply.fire("click");
    expect(h.els.ta.value).toBe("REVISED");
    h.els.btnUndo.fire("click");
    expect(h.els.ta.value).toBe("OLD");
    expect(h.els.btnUndo.style.display).toBe("none");
  });
});

describe("Download to Copy button", () => {
  test("starts as Download and turns into Copy only after a save", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    expect(h.els.saveLabel.textContent).toBe("Download");
    h.receive({ type: "saved", path: "/home/u/Downloads/a.md", text: "draft" });
    expect(h.els.saveLabel.textContent).toBe("Copy");
    expect(h.els.pathHint.textContent).toBe("/home/u/Downloads/a.md");
  });

  test("any edit flips Copy back to Download", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "saved", path: "/p/a.md", text: "draft" });
    h.els.ta.value = "draft edited";
    h.els.ta.fire("input");
    expect(h.els.saveLabel.textContent).toBe("Download");
  });

  test("editing back to the saved text returns to Copy on its own", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "saved", path: "/p/a.md", text: "draft" });
    h.els.ta.value = "draft edited";
    h.els.ta.fire("input");
    h.els.ta.value = "draft";
    h.els.ta.fire("input");
    expect(h.els.saveLabel.textContent).toBe("Copy");
  });

  test("Copy asks the host for the path; Download opens the form instead", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnSave.fire("click");
    expect(h.posted.some((m) => m.type === "copyPath")).toBe(false);
    expect(h.els.backdrop.classList.contains("on")).toBe(true);

    h.receive({ type: "saved", path: "/p/a.md", text: "draft" });
    h.els.btnSave.fire("click");
    expect(h.posted.some((m) => m.type === "copyPath")).toBe(true);
  });

  test("Apply counts as an edit, so a saved draft goes back to Download", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "saved", path: "/p/a.md", text: "draft" });
    expect(h.els.saveLabel.textContent).toBe("Copy");
    h.receive({ type: "checkResult", result: { verdict: "ok", gaps: [], questions: [], revised: "REVISED" }, diff: [] });
    h.els.btnApply.fire("click");
    expect(h.els.saveLabel.textContent).toBe("Download");
  });
});

describe("Check button", () => {
  test("the first round is a triage pass with no answers yet", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnCheck.fire("click");
    const sent = h.posted.filter((m) => m.type === "check");
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual({ type: "check", text: "draft", qa: [], phase: "triage" });
  });

  // The toolbar button used to hardcode qa: [] while the footer button sent the
  // answers, so reaching for the wrong one silently discarded them all.
  test("the toolbar Check keeps the answers, exactly like ตรวจอีกรอบ", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q1", q: "Q1", why: "", options: [] }], assumptions: [], revised: null },
    });
    h.els.qInput.value = "คำตอบ";
    h.els.qNext.fire("click");            // -> summary
    h.els.btnCheck.fire("click");
    expect(h.posted.filter((m) => m.type === "check").pop().qa).toEqual([{ q: "Q1", a: "คำตอบ" }]);
  });

  test("answers from earlier rounds survive into later ones", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q1", q: "Q-ROUND1", why: "", options: [] }], assumptions: [], revised: null },
    });
    h.els.qInput.value = "ตอบรอบ 1";
    h.els.qNext.fire("click");
    h.els.btnRecheck.fire("click");
    // round 2 asks something else entirely
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q2", q: "Q-ROUND2", why: "", options: [] }], assumptions: [], revised: null },
    });
    h.els.qInput.value = "ตอบรอบ 2";
    h.els.qNext.fire("click");
    h.els.btnRecheck.fire("click");
    expect(h.posted.filter((m) => m.type === "check").pop().qa).toEqual([
      { q: "Q-ROUND1", a: "ตอบรอบ 1" },
      { q: "Q-ROUND2", a: "ตอบรอบ 2" },
    ]);
  });

  test("a skipped question is still reported, with an empty answer", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q1", q: "Q-SKIP", why: "", options: [] }], assumptions: [], revised: null },
    });
    h.els.qNext.fire("click");            // answered nothing -> summary
    h.els.btnRecheck.fire("click");
    expect(h.posted.filter((m) => m.type === "check").pop().qa).toEqual([{ q: "Q-SKIP", a: "" }]);
  });

  test("answers are handed to the host to persist with the draft", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q1", q: "Q1", why: "", options: [] }], assumptions: [], revised: null },
    });
    h.els.qInput.value = "ตอบ";
    h.els.qNext.fire("click");
    const saved = h.posted.filter((m) => m.type === "qaChanged").pop();
    expect(saved.text).toBe("draft");
    expect(saved.qa).toEqual([{ q: "Q1", a: "ตอบ" }]);
  });

  test("restored answers from a previous visit are sent on the first check", () => {
    const h = loadPage();
    h.receive({
      type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d",
      qa: [{ q: "Q-OLD", a: "ตอบไว้แล้ว" }],
    });
    h.els.btnCheck.fire("click");
    expect(h.posted.filter((m) => m.type === "check").pop().qa).toEqual([{ q: "Q-OLD", a: "ตอบไว้แล้ว" }]);
  });

  test("with no rewrite yet the primary button orders one instead of applying", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [], assumptions: [{ what: "A", why: "" }], revised: null },
    });
    expect(h.els.btnApply.textContent).toBe("ส่งแก้เลย");
    const sent = h.posted.filter((m) => m.type === "check").pop();
    expect(sent.phase).toBe("rewrite");   // auto-continued: nothing to ask
  });

  test("once a rewrite exists the primary button applies it", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "rewrite",
      result: { verdict: "ok", questions: [], assumptions: [], revised: "REWRITTEN" },
    });
    expect(h.els.btnApply.textContent).toBe("Apply");
    h.els.btnApply.fire("click");
    expect(h.els.ta.value).toBe("REWRITTEN");
  });

  test("a triage result WITH questions waits for the user, it does not auto-rewrite", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      phase: "triage",
      result: { verdict: "needs-work", questions: [{ id: "q1", q: "Q1", why: "", options: [] }], assumptions: [], revised: null },
    });
    expect(h.posted.filter((m) => m.type === "check").length).toBe(0);
  });

  test("while running, the button cancels instead of starting a second run", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnCheck.fire("click");
    h.els.btnCheck.fire("click");
    expect(h.posted.filter((m) => m.type === "check").length).toBe(1);
    expect(h.posted.filter((m) => m.type === "cancelCheck").length).toBe(1);
  });

  test("a result re-arms the button for another run", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnCheck.fire("click");
    h.receive({ type: "checkResult", result: { verdict: "ok", gaps: [], questions: [], revised: "R" }, diff: [] });
    expect(h.els.checkLabel.textContent).toBe("Check");
    expect(h.els.btnCheck.getAttribute("data-mode")).toBe(null);
  });

  test("an error re-arms the button and shows the message rather than hanging", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnCheck.fire("click");
    h.receive({ type: "checkError", message: "claude ไม่ตอบ" });
    expect(h.els.checkLabel.textContent).toBe("Check");
    expect(h.els.rerr.textContent).toBe("claude ไม่ตอบ");
    expect(h.els.review.classList.contains("on")).toBe(true);
  });

  const RESULT = {
    verdict: "needs-work",
    questions: [
      { id: "q1", q: "Q-ONE", why: "why one", options: ["opt-a", "opt-b"] },
      { id: "q2", q: "Q-TWO", why: "why two", options: [] },
      { id: "q3", q: "Q-THREE", why: "", options: ["opt-c"] },
    ],
    assumptions: [{ what: "A-ONE", why: "because" }],
    revised: null,          // triage never returns one; the rewrite pass does
  };

  function opened(res: any = RESULT) {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({ type: "checkResult", result: res });
    return h;
  }

  test("shows ONE question at a time, not the whole list", () => {
    const h = opened();
    expect(h.els.rbody.innerHTML).toContain("Q-ONE");
    expect(h.els.rbody.innerHTML).not.toContain("Q-TWO");
    expect(h.els.rbody.innerHTML).not.toContain("Q-THREE");
    expect(h.els.rbody.innerHTML).toContain("ข้อ 1 จาก 3");
  });

  test("never shows assumptions while they are still only intentions", () => {
    const h = opened();
    expect(h.els.rbody.innerHTML).not.toContain("A-ONE");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click"); // last one -> the decision screen
    expect(h.els.rbody.innerHTML).not.toContain("A-ONE");
  });

  test("next and prev walk the questions", () => {
    const h = opened();
    h.els.qNext.fire("click");
    expect(h.els.rbody.innerHTML).toContain("Q-TWO");
    h.els.qPrev.fire("click");
    expect(h.els.rbody.innerHTML).toContain("Q-ONE");
  });

  test("prev is disabled on the first question", () => {
    const h = opened();
    expect(h.els.qPrev.disabled).toBe(true);
  });

  test("the last question offers the summary instead of another next", () => {
    const h = opened();
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    expect(h.els.rbody.innerHTML).toContain("ดูสรุป");
  });

  test("a typed answer survives navigating away and back", () => {
    const h = opened();
    h.els.qInput.value = "คำตอบข้อหนึ่ง";
    h.els.qNext.fire("click");
    h.els.qPrev.fire("click");
    expect(h.els.qInput.value).toBe("คำตอบข้อหนึ่ง");
  });

  test("picking an option records it and advances", () => {
    const h = opened();
    const chips = h.els.rbody.querySelectorAll(".chip");
    chips[0].fire("click");                       // "opt-a"
    expect(h.els.rbody.innerHTML).toContain("Q-TWO");
    h.els.qPrev.fire("click");
    expect(h.els.qInput.value).toBe("opt-a");
  });

  // The skip CHIP is gone, but skipping is not: leaving the box empty and
  // pressing next still records "asked and declined", which is what stops the
  // model re-asking it.
  test("no skip chip is rendered — only the model's own options", () => {
    const h = opened();
    const chips = h.els.rbody.querySelectorAll(".chip");
    expect(chips.length).toBe(2);                 // opt-a, opt-b — nothing else
    expect(h.els.rbody.innerHTML).not.toContain("ข้ามข้อนี้");
  });

  test("an empty answer still advances and is still recorded as skipped", () => {
    const h = opened();
    h.els.qNext.fire("click");
    expect(h.els.rbody.innerHTML).toContain("Q-TWO");
    h.els.qPrev.fire("click");
    expect(h.els.qInput.value).toBe("");
  });

  test("Enter in the answer box moves on", () => {
    const h = opened();
    h.els.qInput.value = "x";
    h.els.qInput.fire("keydown", { key: "Enter" });
    expect(h.els.rbody.innerHTML).toContain("Q-TWO");
  });

  test("a dot jumps straight to that question", () => {
    const h = opened();
    const dots = h.els.rbody.querySelectorAll(".dot");
    expect(dots.length).toBe(3);
    dots[2].fire("click");
    expect(h.els.rbody.innerHTML).toContain("Q-THREE");
  });

  test("Apply/Discard/recheck are hidden while answering and back in the summary", () => {
    const h = opened();
    expect(h.els.btnApply.style.display).toBe("none");
    expect(h.els.btnDiscard.style.display).toBe("none");
    expect(h.els.btnRecheck.style.display).toBe("none");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    expect(h.els.btnApply.style.display).toBe("");
    // ตรวจอีกรอบ is not offered on the decision screen — send / back / discard
    // are the moves there, and the toolbar Check still re-runs it.
    expect(h.els.btnRecheck.style.display).toBe("none");
  });

  test("ตรวจอีกรอบ comes back once there is a rewrite to re-check", () => {
    const h = opened({ verdict: "ok", questions: [], assumptions: [], revised: "R" });
    expect(h.els.btnRecheck.style.display).toBe("");
  });

  test("a result with no questions lands straight on the summary", () => {
    const h = opened({ verdict: "ok", questions: [], assumptions: [{ what: "A-ONE", why: "" }], revised: "R" });
    expect(h.els.rbody.innerHTML).toContain("A-ONE");
    expect(h.els.btnApply.style.display).toBe("");
  });

  test("nothing to ask and nothing assumed says so rather than rendering blank", () => {
    const h = opened({ verdict: "ok", questions: [], assumptions: [], revised: "R" });
    expect(h.els.rbody.innerHTML).toContain("ไม่มีอะไรต้องถาม");
  });

  // Answering the last question lands on a decision, not a report: the user
  // just typed those answers and the assumptions are still speculative until a
  // rewrite exists.
  test("finishing the questions shows a decision, not a recap", () => {
    const h = opened();
    h.els.qInput.value = "ตอบข้อ 1";
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    expect(h.els.rbody.innerHTML).not.toContain("ตอบข้อ 1");
    expect(h.els.rbody.innerHTML).not.toContain("A-ONE");   // assumption, not yet written
    expect(h.els.rbody.innerHTML).toContain("ตอบแล้ว 1 จาก 3");
    expect(h.els.btnApply.textContent).toBe("ส่งแก้เลย");
    expect(h.els.btnDiscard.style.display).toBe("");
  });

  test("assumptions do appear once a rewrite actually exists", () => {
    const h = opened({ verdict: "ok", questions: [], assumptions: [{ what: "A-ONE", why: "because" }], revised: "R" });
    expect(h.els.rbody.innerHTML).toContain("A-ONE");
    expect(h.els.btnApply.textContent).toBe("Apply");
  });

  test("ก่อนหน้า is still there after the last question, and walks back into it", () => {
    const h = opened();
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");                    // -> summary
    expect(h.els.btnBack.style.display).toBe("");
    h.els.btnBack.fire("click");
    expect(h.els.rbody.innerHTML).toContain("Q-THREE");
    expect(h.els.rbody.innerHTML).toContain("ข้อ 3 จาก 3");
  });

  test("ก่อนหน้า is hidden while answering, and when there were no questions", () => {
    const h = opened();
    expect(h.els.btnBack.style.display).toBe("none");
    const h2 = opened({ verdict: "ok", questions: [], assumptions: [], revised: "R" });
    expect(h2.els.btnBack.style.display).toBe("none");
  });

  test("ตรวจอีกรอบ sends every question with its answer, skipped ones empty", () => {
    const h = opened();
    h.els.qInput.value = "ตอบหนึ่ง";
    h.els.qNext.fire("click");
    h.els.qInput.value = "ตอบสอง";
    h.els.qNext.fire("click");
    h.els.qNext.fire("click");                    // skip q3 -> summary
    h.els.btnRecheck.fire("click");
    const sent = h.posted.filter((m) => m.type === "check").pop();
    expect(sent.qa).toEqual([
      { q: "Q-ONE", a: "ตอบหนึ่ง" },
      { q: "Q-TWO", a: "ตอบสอง" },
      { q: "Q-THREE", a: "" },
    ]);
  });

  test("the diff zone is gone — no counts, no red/green lines", () => {
    const { js } = extractClientScript();
    expect(js).not.toContain("ร่างใหม่เทียบของเดิม");
    expect(js).not.toContain('class="diff"');
    expect(js).not.toContain("บรรทัด / -");
  });

  test("escapes markup coming back from the model", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.receive({
      type: "checkResult",
      result: {
        verdict: "ok",
        questions: [],
        assumptions: [{ what: '<img src=x onerror="boom">', why: "" }],
        revised: "R",
      },
    });
    expect(h.els.rbody.innerHTML).not.toContain("<img");
    expect(h.els.rbody.innerHTML).toContain("&lt;img");
  });
});

describe("save form — folder is picked, never typed", () => {
  test("the folder control is a button, not a text input", () => {
    const { html } = extractClientScript();
    expect(html).toContain('id="fDirBtn"');
    expect(html).not.toContain('id="fDir" type="text"');
  });

  test("clicking it asks the host to open the native picker, passing the current folder", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/home/u/Downloads" });
    h.els.btnSave.fire("click");
    h.els.fDirBtn.fire("click");
    expect(h.posted.filter((m) => m.type === "pickDir").pop()).toEqual({
      type: "pickDir",
      current: "/home/u/Downloads",
    });
  });

  test("a picked folder is shown and used for the save", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/home/u/Downloads" });
    h.els.btnSave.fire("click");
    h.receive({ type: "dirPicked", dir: "/srv/specs" });
    expect(h.els.fDirText.textContent).toBe("/srv/specs");
    h.els.fName.value = "a";
    h.els.btnConfirmSave.fire("click");
    expect(h.posted.filter((m) => m.type === "save").pop().dir).toBe("/srv/specs");
  });

  test("cancelling the picker keeps the folder it already had", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/home/u/Downloads" });
    h.els.btnSave.fire("click");
    h.els.fDirBtn.fire("click");
    // host posts nothing back on cancel
    h.els.fName.value = "a";
    h.els.btnConfirmSave.fire("click");
    expect(h.posted.filter((m) => m.type === "save").pop().dir).toBe("/home/u/Downloads");
  });

  test("reopening after a save offers the folder that save went to", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/home/u/Downloads" });
    h.receive({ type: "saved", path: "/srv/specs/a.md", text: "draft" });
    h.els.ta.value = "draft2";
    h.els.ta.fire("input");
    h.els.btnSave.fire("click");
    expect(h.els.fDirText.textContent).toBe("/srv/specs");
    expect(h.els.fName.value).toBe("a.md");
  });
});

describe("save form", () => {
  test("an overwrite conflict arms the confirm button instead of failing silently", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnSave.fire("click");
    h.els.fName.value = "a";
    h.els.btnConfirmSave.fire("click");
    h.receive({ type: "saveError", message: "มีไฟล์นี้อยู่แล้ว — เขียนทับไหม?", needOverwrite: true });
    expect(h.els.merr.textContent).toContain("เขียนทับ");
    expect(h.els.btnConfirmSave.textContent).toBe("เขียนทับ");
    h.els.btnConfirmSave.fire("click");
    const last = h.posted.filter((m) => m.type === "save").pop();
    expect(last.overwrite).toBe(true);
  });

  test("a missing folder tells the user the next click will create it", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnSave.fire("click");
    h.receive({ type: "saveError", message: "ยังไม่มีโฟลเดอร์นี้", missing: true });
    expect(h.els.merr.textContent).toContain("สร้างโฟลเดอร์");
  });

  test("a successful save closes the form", () => {
    const h = loadPage();
    h.receive({ type: "init", text: "draft", savedText: null, savedPath: null, defaultDir: "/d" });
    h.els.btnSave.fire("click");
    expect(h.els.backdrop.classList.contains("on")).toBe(true);
    h.receive({ type: "saved", path: "/p/a.md", text: "draft" });
    expect(h.els.backdrop.classList.contains("on")).toBe(false);
  });
});
