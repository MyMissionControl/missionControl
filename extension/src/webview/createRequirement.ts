import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  REQUIREMENT_TEMPLATE,
  applyExtension,
  buildCheckPrompt,
  parseCheckResult,
  validateFileName,
  validateSaveDir,
  type CheckPhase,
  type QA,
} from "../commands/requirementOps";

// "Create Requirement" — a full-page editor for the requirement .md that gets
// handed to /orches. Three moving parts:
//   Check    → `claude -p` returns questions + assumptions + a full rewrite.
//              Questions are answered one at a time (wizard), then a single
//              summary shows what the model decided on its own; Apply/Discard.
//   Download → in-page form (folder + filename) writes the .md to disk.
//   Copy     → the button turns into Copy after a save and puts the absolute
//              path on the clipboard; ANY edit flips it back to Download so the
//              path on the clipboard always points at the newest bytes.
//
// All prompt building / parsing / validation lives in commands/requirementOps.ts
// (unit tested); this file is I/O + markup only.

let _panel: vscode.WebviewPanel | undefined;
let _proc: ChildProcess | undefined;

const DRAFT_KEY = "mc.requirement.draft";
const SAVED_PATH_KEY = "mc.requirement.savedPath";
const SAVED_TEXT_KEY = "mc.requirement.savedText";
// Answers are stored WITH the draft they were given for, and only restored
// when that draft is still byte-identical — otherwise reopening the panel on
// an edited draft would silently feed the model answers to questions that no
// longer apply.
const QA_KEY = "mc.requirement.qa";
// A ceiling, not an expectation: triage lands in ~37s and a rewrite in ~171s.
// (An earlier comment here claimed the rewritten draft was what dominated the
// wall clock. Measured: it is 21%. Thinking before the first token is 77% —
// see EFFORT below. The claim was wrong and is recorded so it is not restored.)
const CHECK_TIMEOUT_MS = 900_000;

// The review is a pure text transform: draft in, JSON out — nothing here needs
// a tool or an MCP server. `--disallowedTools` was the wrong instrument: it only
// denies CALLS, the schemas still ship in the system prompt and the configured
// MCP servers still start. Measured on a "reply OK1" probe (2026-08-07):
//   --disallowedTools <11 names>        28,871 input tokens   (what shipped)
//   --tools ""                          20,690
//   --tools "" --strict-mcp-config      11,505   ← 60% less, same answer
//   --safe-mode                         34,034   ← worse, do not use
const NO_TOOLS = ["--tools", "", "--strict-mcp-config"];

// Pinned, NOT inherited from the user's default — per-process flags, they do not
// touch the user's global model. On a real 3.2KB Thai draft opus never returned
// inside 330s; sonnet is the quality/latency pick.
//
// Effort is the lever that actually matters. 77% of the old wait was spent
// thinking BEFORE the first output token (ttft 311s of 405s), so on the same
// prompt: default 405s / $0.70, medium 171s / $0.39, low 118s / $0.32.
// Low surfaced 4-5 questions where default and medium surfaced 6, so the cheap
// triage pass takes low and the one rewrite that has to be good takes medium —
// rather than dropping the whole feature to low.
const CHECK_MODEL = ["--model", "sonnet"];
const EFFORT: Record<CheckPhase, string[]> = {
  triage: ["--effort", "low"],
  rewrite: ["--effort", "medium"],
};

function statKind(p: string): "dir" | "file" | "missing" {
  try {
    return fs.statSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/** ~/Downloads when it exists, else the home directory — never a path that
 *  cannot be written to. */
function defaultSaveDir(): string {
  const downloads = path.join(os.homedir(), "Downloads");
  return statKind(downloads) === "dir" ? downloads : os.homedir();
}

/** Answers saved on a previous visit, but only if the draft has not changed
 *  since. Returns [] on any mismatch or malformed store. */
function restoreQa(context: vscode.ExtensionContext, draft: string): QA[] {
  const box = context.globalState.get<{ draft?: unknown; qa?: unknown } | null>(QA_KEY, null);
  if (!box || typeof box !== "object") return [];
  if (typeof box.draft !== "string" || box.draft !== draft) return [];
  if (!Array.isArray(box.qa)) return [];
  return box.qa
    .filter((x): x is QA => !!x && typeof x === "object" &&
      typeof (x as QA).q === "string" && typeof (x as QA).a === "string")
    .map((x) => ({ q: x.q, a: x.a }));
}

function killCheck(): void {
  if (_proc && !_proc.killed) {
    try {
      _proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  _proc = undefined;
}

/** Run `claude -p` with the review prompt. Resolves with stdout, or an error
 *  string the page can show verbatim. Cancellation kills the process and
 *  resolves as cancelled so the UI never hangs on a spinner. */
function runCheck(
  prompt: string,
  phase: CheckPhase,
): Promise<{ ok: true; out: string } | { ok: false; error: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true; out: string } | { ok: false; error: string; cancelled?: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      _proc = undefined;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      // stdin is closed on purpose: a piped-but-never-written stdin would let
      // any prompt claude decides to ask hang the panel forever.
      child = spawn("claude", ["-p", ...CHECK_MODEL, ...EFFORT[phase], ...NO_TOOLS, "--", prompt], {
        // A scratch dir, not the home directory: nothing about reviewing a draft
        // should pick up whatever project context the cwd happens to carry.
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ ok: false, error: "เรียก claude ไม่ได้ — ไม่มีใน PATH?" });
      return;
    }
    _proc = child;
    const timer = setTimeout(() => {
      // Salvage first. stdout has been filling the whole time, and a run that
      // printed its JSON but has not exited yet (session write, wedged child)
      // would otherwise burn the full ceiling and then throw away a complete
      // answer. Only report the timeout when there is genuinely nothing usable.
      const salvaged = out;
      killCheck();
      if (parseCheckResult(salvaged).ok) {
        finish({ ok: true, out: salvaged });
        return;
      }
      // Derived from the constant so the number in the message can never drift.
      finish({ ok: false, error: "claude ใช้เวลาเกิน " + CHECK_TIMEOUT_MS / 1000 + " วินาที — ยกเลิกแล้ว" });
    }, CHECK_TIMEOUT_MS);

    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", () => finish({ ok: false, error: "เรียก claude ไม่ได้ — ไม่มีใน PATH?" }));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" && !done) {
        // Same salvage on cancel: if the answer already arrived, keep it.
        if (parseCheckResult(out).ok) {
          finish({ ok: true, out });
          return;
        }
        finish({ ok: false, error: "ยกเลิกแล้ว", cancelled: true });
        return;
      }
      if (code !== 0 && out.trim().length === 0) {
        finish({ ok: false, error: err.trim().slice(0, 400) || "claude จบด้วย exit code " + code });
        return;
      }
      finish({ ok: true, out });
    });
  });
}

export function openCreateRequirementPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.createRequirement",
    "Create Requirement",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;

  panel.onDidDispose(() => {
    _panel = undefined;
    killCheck();
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready": {
        const draft = context.globalState.get<string>(DRAFT_KEY, "");
        void panel.webview.postMessage({
          type: "init",
          text: draft && draft.trim().length > 0 ? draft : REQUIREMENT_TEMPLATE,
          savedText: context.globalState.get<string | null>(SAVED_TEXT_KEY, null),
          savedPath: context.globalState.get<string | null>(SAVED_PATH_KEY, null),
          defaultDir: defaultSaveDir(),
          qa: restoreQa(context, draft),
        });
        return;
      }

      case "draftChanged":
        if (typeof msg.text === "string") await context.globalState.update(DRAFT_KEY, msg.text);
        return;

      case "qaChanged":
        await context.globalState.update(QA_KEY, {
          draft: typeof msg.text === "string" ? msg.text : "",
          qa: Array.isArray(msg.qa) ? msg.qa : [],
        });
        return;

      case "check": {
        if (typeof msg.text !== "string" || msg.text.trim().length === 0) return;
        const qa: QA[] = Array.isArray(msg.qa)
          ? msg.qa
              .filter((x: unknown) => x && typeof x === "object")
              .map((x: { q?: unknown; a?: unknown }) => ({
                q: typeof x.q === "string" ? x.q : "",
                a: typeof x.a === "string" ? x.a : "",
              }))
          : [];
        const phase: CheckPhase = msg.phase === "rewrite" ? "rewrite" : "triage";
        const res = await runCheck(buildCheckPrompt(msg.text, qa, phase), phase);
        if (!res.ok) {
          void panel.webview.postMessage({
            type: res.cancelled ? "checkCancelled" : "checkError",
            message: res.error,
          });
          return;
        }
        const parsed = parseCheckResult(res.out);
        if (!parsed.ok) {
          void panel.webview.postMessage({ type: "checkError", message: parsed.error });
          return;
        }
        // No diff is sent: the page shows what the model DECIDED (assumptions)
        // rather than every reworded line, and the full rewrite is readable in
        // the textarea after Apply.
        void panel.webview.postMessage({ type: "checkResult", result: parsed.value, phase });
        return;
      }

      case "cancelCheck":
        killCheck();
        return;

      case "pickDir": {
        // The webview has no filesystem access, so folder choice goes through
        // VS Code's own dialog. Cancelling posts nothing back — the form keeps
        // whatever folder it already had.
        const current = typeof msg.current === "string" && msg.current ? msg.current : defaultSaveDir();
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(statKind(current) === "dir" ? current : defaultSaveDir()),
          openLabel: "เลือกโฟลเดอร์นี้",
          title: "เลือกโฟลเดอร์ที่จะบันทึก .md",
        });
        if (picked && picked[0]) {
          void panel.webview.postMessage({ type: "dirPicked", dir: picked[0].fsPath });
        }
        return;
      }

      case "save": {
        const text = typeof msg.text === "string" ? msg.text : "";
        const dirRaw = typeof msg.dir === "string" ? msg.dir : "";
        const nameRaw = typeof msg.name === "string" ? msg.name : "";

        const nameCheck = validateFileName(nameRaw);
        if (!nameCheck.ok) {
          void panel.webview.postMessage({ type: "saveError", message: nameCheck.error });
          return;
        }
        let dirCheck = validateSaveDir(dirRaw, statKind);
        if (!dirCheck.ok && dirCheck.missing && msg.createDir === true) {
          try {
            fs.mkdirSync(dirRaw.replace(/\/+$/, ""), { recursive: true });
            dirCheck = validateSaveDir(dirRaw, statKind);
          } catch {
            void panel.webview.postMessage({ type: "saveError", message: "สร้างโฟลเดอร์ไม่สำเร็จ" });
            return;
          }
        }
        if (!dirCheck.ok) {
          void panel.webview.postMessage({
            type: "saveError",
            message: dirCheck.error,
            missing: dirCheck.missing === true,
          });
          return;
        }

        const target = path.join(dirRaw.replace(/\/+$/, ""), applyExtension(nameRaw));
        if (statKind(target) !== "missing" && msg.overwrite !== true) {
          void panel.webview.postMessage({
            type: "saveError",
            message: "มีไฟล์นี้อยู่แล้ว — เขียนทับไหม?",
            needOverwrite: true,
          });
          return;
        }
        try {
          fs.writeFileSync(target, text, "utf8");
        } catch (e) {
          void panel.webview.postMessage({
            type: "saveError",
            message: "เขียนไฟล์ไม่สำเร็จ: " + String((e as Error)?.message ?? e).slice(0, 200),
          });
          return;
        }
        await context.globalState.update(SAVED_PATH_KEY, target);
        await context.globalState.update(SAVED_TEXT_KEY, text);
        void panel.webview.postMessage({ type: "saved", path: target, text });
        return;
      }

      case "copyPath": {
        const saved = context.globalState.get<string | null>(SAVED_PATH_KEY, null);
        if (!saved) {
          // Fail loudly: a Copy button that silently does nothing is
          // indistinguishable from a dead button.
          void vscode.window.showWarningMessage("ยังไม่ได้ save ไฟล์ — กด Download ก่อน");
          void panel.webview.postMessage({ type: "saved", path: null, text: null });
          return;
        }
        await vscode.env.clipboard.writeText(saved);
        void panel.webview.postMessage({ type: "copied", path: saved });
        return;
      }

      case "resetTemplate":
        void panel.webview.postMessage({ type: "setText", text: REQUIREMENT_TEMPLATE });
        return;
    }
  });

  return panel;
}

// ── Webview shell ────────────────────────────────────────────────────────────
//
// IMPORTANT: the client <script> below lives inside this template literal. Keep
// it FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would corrupt the client script. That is also why line
// splitting / diffing happens on the extension side and arrives pre-split.

function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#11171d; --editor:#0f151b; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773; --good:#5ecf8f;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --dot:rgba(255,255,255,.028); --addBg:rgba(94,207,143,.12); --delBg:rgba(244,121,107,.12);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad; --good:#2fa96a;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --dot:rgba(15,30,45,.035); --addBg:rgba(47,169,106,.13); --delBg:rgba(214,84,68,.11);
  }
  :root { --pad:20px; --radius:14px; --fs:13.5px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace;
    --danger:#f4796b; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: var(--uifont); font-size: var(--fs); color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad); display: flex; flex-direction: column; }
  .wrap { max-width: 980px; width: 100%; margin: 0 auto; flex: 1; display: flex; flex-direction: column; min-height: 0; }

  /* Toolbar */
  .head { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 14px; flex: none; }
  .head .htext { flex: 1; min-width: 0; }
  .eyebrow { font-family: var(--mono); font-size: 10.5px; letter-spacing: 3px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .title { font-size: 19px; font-weight: 700; margin-top: 7px; }
  .btn { height: 32px; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px; border-radius: 8px;
    font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--uifont); white-space: nowrap; border: 1px solid transparent; }
  .btn svg { width: 13px; height: 13px; }
  .btn.sec { background: var(--card); border-color: var(--border2); color: var(--muted); }
  .btn.sec:hover { border-color: var(--accent); color: var(--txt); }
  .btn.pri { background: var(--accent); color: #fff; box-shadow: 0 2px 10px var(--accentGlow); }
  .btn.pri:hover { filter: brightness(1.08); }
  .btn.ok { background: rgba(94,207,143,.14); color: var(--good); border-color: rgba(94,207,143,.4); }
  .btn.ok:hover { background: rgba(94,207,143,.24); }
  .btn:disabled { opacity: .45; cursor: default; filter: none; }

  .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,.28); border-top-color: #fff;
    animation: sp .7s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }

  /* Editor */
  .edwrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  textarea { flex: 1; min-height: 220px; width: 100%; resize: none; padding: 16px 18px; border-radius: var(--radius);
    background: var(--card); border: 1px solid var(--border); color: var(--txt);
    font-family: var(--mono); font-size: 13px; line-height: 1.7; outline: none; }
  textarea:focus { border-color: var(--accent); }
  .foot { display: flex; align-items: center; gap: 12px; margin-top: 9px; padding: 0 4px; flex: none;
    font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .foot .spacer { flex: 1; }
  .foot .lnk { color: var(--faint); cursor: pointer; border: 0; background: none; font-family: var(--mono); font-size: 10.5px; padding: 0;
    border-bottom: 1px solid var(--border2); }
  .foot .lnk:hover { color: var(--txt); }

  /* Review pane */
  .review { flex: none; margin-top: 14px; border-radius: var(--radius); background: var(--card);
    border: 1px solid var(--border2); overflow: hidden; display: none; }
  .review.on { display: block; }
  .rhead { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .rhead .verdict { font-family: var(--mono); font-size: 9.5px; font-weight: 700; letter-spacing: 1.2px;
    padding: 3px 8px; border-radius: 5px; }
  .verdict.vok { background: rgba(94,207,143,.16); color: var(--good); }
  .verdict.vwork { background: rgba(232,163,61,.16); color: #e8a33d; }
  .rhead .rtitle { font-size: 13px; font-weight: 600; }
  .rhead .spacer { flex: 1; }
  .rbody { max-height: 46vh; overflow: auto; padding: 14px 16px; }
  /* NOT ".sec" — secondary buttons carry "btn sec", and a bare .sec rule with a
     margin lands on every one of them (it pushed Check 16px above Download). */
  .rsec { margin-bottom: 16px; }
  .rsec:last-child { margin-bottom: 0; }
  .slab { font-family: var(--mono); font-size: 9px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--faint); margin-bottom: 8px; }
  /* Assumptions read as "already done", so they get a calmer, flatter card than
     the questions above them — a left rule instead of a full border. */
  .acard { border-left: 2px solid var(--accent2); padding: 2px 0 2px 11px; margin-bottom: 10px; }
  .acard .aw { color: var(--txt); }
  .acard .ay { font-size: 11.5px; color: var(--faint); margin-top: 3px; }

  .qcard { border: 1px solid var(--border); border-radius: 10px; padding: 12px 13px; margin-bottom: 9px; background: var(--editor); }
  .qcard.skipped { opacity: .5; }
  .qcard .qq { font-weight: 600; margin-bottom: 4px; }
  .qcard .qw { font-size: 11.5px; color: var(--faint); margin-bottom: 9px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { font-size: 11.5px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
    background: var(--accentSoft); border: 1px solid var(--border2); color: var(--muted); }
  .chip:hover { border-color: var(--accent); color: var(--txt); }
  .chip.skip { background: transparent; }
  .qcard input { width: 100%; padding: 8px 10px; border-radius: 8px; background: var(--card);
    border: 1px solid var(--border2); color: var(--txt); font-family: var(--uifont); font-size: 12.5px; outline: none; }
  .qcard input:focus { border-color: var(--accent); }

  .dsum { font-family: var(--mono); font-size: 10px; color: var(--faint); margin-bottom: 7px; }
  /* Wizard nav: one question on screen, dots to jump, filled dot = answered. */
  .qnav { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .qnav .dots { flex: 1; display: flex; justify-content: center; gap: 6px; }
  .dot { width: 7px; height: 7px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
    background: var(--border2); }
  .dot.ans { background: var(--good); }
  .dot.cur { background: var(--accent2); box-shadow: 0 0 0 3px var(--accentSoft); }

  .rfoot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .rfoot .spacer { flex: 1; }
  .err { color: var(--danger); font-size: 12.5px; }

  /* Save form */
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; padding: 24px; }
  .backdrop.on { display: flex; }
  .modal { width: 100%; max-width: 520px; background: var(--panel); border: 1px solid var(--border2);
    border-radius: var(--radius); padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .modal h3 { margin: 0 0 4px; font-size: 15px; }
  .modal .mh { font-size: 12px; color: var(--faint); margin-bottom: 16px; }
  .field { margin-bottom: 13px; }
  .field label { display: block; font-family: var(--mono); font-size: 9.5px; letter-spacing: 1.2px;
    text-transform: uppercase; color: var(--faint); margin-bottom: 6px; }
  .field input { width: 100%; padding: 9px 11px; border-radius: 8px; background: var(--card);
    border: 1px solid var(--border2); color: var(--txt); font-family: var(--mono); font-size: 12.5px; outline: none; }
  .field input:focus { border-color: var(--accent); }
  /* Folder is CHOSEN, never typed — a typed path is a validation problem the
     user has to debug; the native picker can only produce a real directory. */
  .pick { width: 100%; display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 8px;
    background: var(--card); border: 1px solid var(--border2); color: var(--txt);
    font-family: var(--mono); font-size: 12.5px; cursor: pointer; text-align: left; }
  .pick:hover { border-color: var(--accent); }
  /* No direction:rtl here — it renders "/home/u/x" as "home/u/x/", moving the
     leading slash to the end. Full path is on the title attribute instead. */
  .pick .p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick .pk { flex: none; font-family: var(--uifont); font-size: 11px; font-weight: 600; color: var(--accent2); }
  .mfoot { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
  .mfoot .spacer { flex: 1; }
  .merr { color: var(--danger); font-size: 12px; min-height: 16px; margin-top: 2px; }

  .toast { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); background: var(--card);
    border: 1px solid var(--border2); border-radius: 10px; padding: 10px 16px; font-family: var(--mono); font-size: 11.5px;
    color: var(--txt); box-shadow: 0 10px 30px rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .18s; }
  .toast.on { opacity: 1; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="htext">
      <div class="eyebrow">For /orches</div>
      <div class="title">Create Requirement</div>
    </div>
    <button class="btn sec" id="btnCheck">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span id="checkLabel">Check</span>
    </button>
    <button class="btn pri" id="btnSave">
      <span id="saveIcon"></span><span id="saveLabel">Download</span>
    </button>
  </div>

  <div class="edwrap">
    <textarea id="ta" spellcheck="false"></textarea>
    <div class="foot">
      <span id="tok">~0 tokens</span>
      <span class="spacer"></span>
      <span id="pathHint"></span>
      <button class="lnk" id="btnUndo" style="display:none">undo ร่างเดิม</button>
      <button class="lnk" id="btnReset">reset template</button>
    </div>
  </div>

  <div class="review" id="review">
    <div class="rhead">
      <span class="verdict vwork" id="verdict">NEEDS-WORK</span>
      <span class="rtitle" id="rtitle">ผลตรวจ</span>
      <span class="spacer"></span>
      <button class="btn sec" id="btnCloseReview">ปิด</button>
    </div>
    <div class="rbody" id="rbody"></div>
    <div class="rfoot">
      <span class="err" id="rerr"></span>
      <span class="spacer"></span>
      <button class="btn sec" id="btnRecheck">ตรวจอีกรอบ</button>
      <button class="btn sec" id="btnDiscard">Discard</button>
      <button class="btn ok" id="btnApply">Apply</button>
    </div>
  </div>
</div>

<div class="backdrop" id="backdrop">
  <div class="modal">
    <h3>บันทึกเป็นไฟล์ .md</h3>
    <div class="mh">เลือกโฟลเดอร์และตั้งชื่อไฟล์</div>
    <div class="field">
      <label>โฟลเดอร์</label>
      <button class="pick" id="fDirBtn" type="button">
        <span class="p" id="fDirText"></span>
        <span class="pk">เลือก…</span>
      </button>
    </div>
    <div class="field">
      <label for="fName">ชื่อไฟล์</label>
      <input id="fName" type="text" spellcheck="false" placeholder="my-project" />
    </div>
    <div class="merr" id="merr"></div>
    <div class="mfoot">
      <span class="spacer"></span>
      <button class="btn sec" id="btnCancelSave">ยกเลิก</button>
      <button class="btn pri" id="btnConfirmSave">บันทึก</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();
  (function () { var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark"; })();

  var ta = document.getElementById("ta");
  var tok = document.getElementById("tok");
  var review = document.getElementById("review");
  var rbody = document.getElementById("rbody");
  var rerr = document.getElementById("rerr");
  var verdictEl = document.getElementById("verdict");
  var rtitle = document.getElementById("rtitle");
  var btnCheck = document.getElementById("btnCheck");
  var checkLabel = document.getElementById("checkLabel");
  var btnSave = document.getElementById("btnSave");
  var saveLabel = document.getElementById("saveLabel");
  var saveIcon = document.getElementById("saveIcon");
  var pathHint = document.getElementById("pathHint");
  var backdrop = document.getElementById("backdrop");
  var fDirBtn = document.getElementById("fDirBtn");
  var fDirText = document.getElementById("fDirText");
  var fName = document.getElementById("fName");
  var merr = document.getElementById("merr");
  var toast = document.getElementById("toast");

  var STATE = {
    savedText: null,      // exact bytes last written to disk (null = never saved)
    savedPath: null,
    defaultDir: "",
    dir: "",              // folder chosen in the save form (picker only)
    checking: false,
    pending: null,        // last checkResult, waiting for Apply/Discard
    qs: [],               // questions from THIS round
    answers: [],          // parallel to qs; "" means skipped
    // Every question ever asked for this draft, with its answer ("" = skipped).
    // Kept OUTSIDE the per-round state on purpose: it used to be reset with the
    // round, so by round three the model no longer saw round one's answers and
    // cheerfully asked them all over again.
    qaAll: [],
    phase: "triage",      // which pass produced STATE.pending
    qi: 0,                // which question the wizard is on
    view: "ask",          // "ask" (one question at a time) or "summary"
    undoText: null,       // one level of undo for Apply
    askOverwrite: false
  };
  var saveTimer = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("on");
    setTimeout(function () { toast.classList.remove("on"); }, 2600);
  }

  // Estimate only — ASCII ~4 chars/token, Thai and other non-Latin ~2. Pure
  // arithmetic so it can run on every keystroke with no lag. Mirrors
  // approxTokens() in commands/requirementOps.ts.
  function approxTokens(text) {
    if (!text) return 0;
    var ascii = 0, wide = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 128) ascii++; else wide++;
    }
    return Math.round(ascii / 4 + wide / 2);
  }

  // Compared by VALUE, not a dirty flag: edit then undo back to the saved text
  // and the button returns to Copy on its own, so Copy never yields a path
  // whose file is out of date.
  function syncSaveButton() {
    var isSaved = STATE.savedText !== null && ta.value === STATE.savedText;
    if (isSaved) {
      btnSave.className = "btn ok";
      saveLabel.textContent = "Copy";
      saveIcon.textContent = "";
      pathHint.textContent = STATE.savedPath || "";
    } else {
      btnSave.className = "btn pri";
      saveLabel.textContent = "Download";
      saveIcon.textContent = "";
      pathHint.textContent = "";
    }
  }

  // Replace the whole textarea in a way Ctrl+Z can undo. Assigning ta.value
  // wipes the browser's own undo stack; an execCommand("insertText") over a
  // full selection is recorded as a normal user edit, so Ctrl+Z walks back to
  // the previous draft. Returns false if the host refuses the command — the
  // caller then shows the explicit undo link as a fallback.
  function setTextUndoable(text) {
    var ok = false;
    try {
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand("insertText", false, text) === true;
    } catch (e) {
      ok = false;
    }
    if (!ok || ta.value !== text) {
      ta.value = text;
      ok = false;
    }
    onEdit();
    return ok;
  }

  function onEdit() {
    tok.textContent = "~" + approxTokens(ta.value).toLocaleString() + " tokens";
    btnCheck.disabled = STATE.checking || ta.value.trim().length === 0;
    syncSaveButton();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      vscode.postMessage({ type: "draftChanged", text: ta.value });
    }, 400);
  }
  ta.addEventListener("input", onEdit);

  // ── Check ──────────────────────────────────────────────────────────────────

  // Fold this round's answers into the cumulative store, newest wins. Skipped
  // questions are kept with an empty answer — the model needs to be told they
  // were asked and declined, or it just asks them again.
  function mergeAnswers() {
    saveCurrentAnswer();
    for (var i = 0; i < STATE.qs.length; i++) {
      var q = STATE.qs[i].q;
      var hit = -1;
      for (var j = 0; j < STATE.qaAll.length; j++) if (STATE.qaAll[j].q === q) { hit = j; break; }
      if (hit >= 0) STATE.qaAll[hit].a = STATE.answers[i];
      else STATE.qaAll.push({ q: q, a: STATE.answers[i] });
    }
    vscode.postMessage({ type: "qaChanged", text: ta.value, qa: STATE.qaAll });
  }

  // Only one question card is mounted at a time, so answers cannot be scraped
  // off the DOM — they come from STATE, and from every earlier round too.
  function collectAnswers() {
    mergeAnswers();
    return STATE.qaAll;
  }

  // A real review runs 1-3 minutes (sonnet, measured). A label that never moves
  // for that long reads as a hung button, so tick the elapsed seconds and say
  // outright that clicking again cancels.
  var tickTimer = null;
  function setChecking(on) {
    STATE.checking = on;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (on) {
      var t0 = Date.now();
      var tick = function () {
        var s = Math.round((Date.now() - t0) / 1000);
        checkLabel.textContent = "กำลังตรวจ " + s + "s · กดเพื่อยกเลิก";
      };
      tick();
      tickTimer = setInterval(tick, 1000);
      btnCheck.className = "btn sec";
      btnCheck.disabled = false;                 // stays clickable = Cancel
      btnCheck.setAttribute("data-mode", "cancel");
    } else {
      checkLabel.textContent = "Check";
      btnCheck.disabled = ta.value.trim().length === 0;
      btnCheck.removeAttribute("data-mode");
    }
  }

  // Both re-run affordances go through here. The toolbar Check used to hardcode
  // qa: [] while the footer button sent the answers, so reaching for the wrong
  // one silently threw away everything the user had just typed.
  function runCheck(phase) {
    if (STATE.checking || ta.value.trim().length === 0) return;
    rerr.textContent = "";
    setChecking(true);
    STATE.phase = phase;
    vscode.postMessage({ type: "check", text: ta.value, qa: collectAnswers(), phase: phase });
  }

  btnCheck.addEventListener("click", function () {
    if (btnCheck.getAttribute("data-mode") === "cancel") {
      vscode.postMessage({ type: "cancelCheck" });
      return;
    }
    runCheck("triage");
  });

  var btnApply = document.getElementById("btnApply");
  var btnDiscard = document.getElementById("btnDiscard");
  var btnRecheck = document.getElementById("btnRecheck");

  btnRecheck.addEventListener("click", function () { runCheck("triage"); });

  btnDiscard.addEventListener("click", function () {
    STATE.pending = null;
    review.classList.remove("on");
  });
  document.getElementById("btnCloseReview").addEventListener("click", function () {
    STATE.pending = null;
    review.classList.remove("on");
  });

  var btnUndo = document.getElementById("btnUndo");
  btnApply.addEventListener("click", function () {
    if (!STATE.pending) return;
    // Triage never asks for a rewrite — that is the whole point of splitting the
    // passes — so until one exists this button orders it instead of applying.
    if (STATE.pending.revised === null || STATE.pending.revised === undefined) {
      runCheck("rewrite");
      return;
    }
    STATE.undoText = ta.value;
    var revised = STATE.pending.revised;
    STATE.pending = null;
    review.classList.remove("on");
    var undoable = setTextUndoable(revised);
    // Shown even when execCommand reported success. It can report success and
    // still not push an undo entry, and there is no way to observe that from
    // script — a hidden link would then leave a dead Ctrl+Z and no way back to
    // the draft. One small link costs nothing next to losing the draft.
    btnUndo.style.display = "";
    showToast(undoable ? "ใส่ร่างใหม่แล้ว — กด Ctrl+Z ย้อนได้" : "ใส่ร่างใหม่แล้ว");
  });
  btnUndo.addEventListener("click", function () {
    if (STATE.undoText === null) return;
    var prev = STATE.undoText;
    STATE.undoText = null;
    btnUndo.style.display = "none";
    setTextUndoable(prev);
    showToast("กลับไปร่างก่อน Apply แล้ว");
  });

  document.getElementById("btnReset").addEventListener("click", function () {
    vscode.postMessage({ type: "resetTemplate" });
  });

  // ── Review: question wizard, then one summary ─────────────────────────────
  //
  // Questions arrive as a batch but are shown ONE AT A TIME with prev/next, the
  // way a REPL choice box works. Answers live in STATE.answers, not in the DOM,
  // so navigating away and back keeps them. Only after the last question does
  // the summary appear — one screen instead of a wall you have to scroll.

  function renderReview(result) {
    verdictEl.textContent = result.verdict === "ok" ? "OK" : "NEEDS-WORK";
    verdictEl.className = "verdict " + (result.verdict === "ok" ? "vok" : "vwork");
    rtitle.textContent = result.verdict === "ok"
      ? "ร่างใช้ได้ — มีขัดเกลาให้เล็กน้อย"
      : "ยังขาดรายละเอียดบางจุด";
    STATE.pending = result;
    STATE.qs = result.questions || [];
    STATE.answers = [];
    for (var i = 0; i < STATE.qs.length; i++) STATE.answers.push("");
    STATE.qi = 0;
    STATE.view = STATE.qs.length ? "ask" : "summary";
    paintReview();
    review.classList.add("on");
  }

  function paintReview() {
    var asking = STATE.view === "ask";
    rbody.innerHTML = asking ? askHtml() : summaryHtml();
    if (asking) wireAsk(); else wireSummary();
    // Apply/Discard/recheck act on the whole result, so they belong to the
    // summary only; the wizard carries its own nav.
    btnApply.style.display = asking ? "none" : "";
    btnDiscard.style.display = asking ? "none" : "";
    btnRecheck.style.display = asking ? "none" : "";
    var hasRewrite = !!(STATE.pending && STATE.pending.revised);
    btnApply.textContent = hasRewrite ? "Apply" : "สร้างร่างใหม่";
    rbody.scrollTop = 0;
  }

  function askHtml() {
    var q = STATE.qs[STATE.qi];
    var h = '<div class="rsec">';
    h += '<div class="slab">ต้องตอบ · ข้อ ' + (STATE.qi + 1) + " จาก " + STATE.qs.length + "</div>";
    h += '<div class="qcard">';
    h += '<div class="qq">' + esc(q.q) + "</div>";
    if (q.why) h += '<div class="qw">' + esc(q.why) + "</div>";
    h += '<div class="chips">';
    for (var k = 0; k < (q.options || []).length; k++) {
      h += '<button class="chip" data-fill="' + esc(q.options[k]) + '">' + esc(q.options[k]) + "</button>";
    }
    h += '<button class="chip skip" data-fill="">ข้ามข้อนี้</button>';
    h += "</div>";
    h += '<input id="qInput" type="text" placeholder="พิมพ์คำตอบเอง หรือกดตัวเลือกด้านบน แล้วกด Enter" value="'
      + esc(STATE.answers[STATE.qi]) + '" />';
    h += "</div>";
    h += '<div class="qnav">';
    h += '<button class="btn sec" id="qPrev"' + (STATE.qi === 0 ? " disabled" : "") + ">ก่อนหน้า</button>";
    h += '<div class="dots">';
    for (var d = 0; d < STATE.qs.length; d++) {
      h += '<button class="dot' + (d === STATE.qi ? " cur" : "") + (STATE.answers[d] ? " ans" : "")
        + '" data-go="' + d + '" title="ข้อ ' + (d + 1) + '"></button>';
    }
    h += "</div>";
    h += '<button class="btn pri" id="qNext">' + (STATE.qi === STATE.qs.length - 1 ? "ดูสรุป" : "ถัดไป") + "</button>";
    h += "</div></div>";
    return h;
  }

  function summaryHtml() {
    var r = STATE.pending || {};
    var h = "";
    if (STATE.qs.length) {
      var answered = 0;
      for (var i = 0; i < STATE.answers.length; i++) if (STATE.answers[i]) answered++;
      h += '<div class="rsec"><div class="slab">คำตอบของคุณ · ' + answered + " จาก " + STATE.qs.length + "</div>";
      for (var j = 0; j < STATE.qs.length; j++) {
        h += '<div class="acard"><div class="aw">' + esc(STATE.qs[j].q) + "</div>";
        h += '<div class="ay">' + (STATE.answers[j] ? esc(STATE.answers[j]) : "— ข้ามไว้") + "</div></div>";
      }
      h += '<div class="qnav"><button class="btn sec" id="qBack">กลับไปแก้คำตอบ</button>'
        + '<div class="dots"></div></div>';
      h += "</div>";
    }
    if (r.assumptions && r.assumptions.length) {
      h += '<div class="rsec"><div class="slab">ตัดสินใจแทนให้แล้ว — เช็คว่าเดาถูกไหม</div>';
      for (var a = 0; a < r.assumptions.length; a++) {
        h += '<div class="acard"><div class="aw">' + esc(r.assumptions[a].what) + "</div>";
        if (r.assumptions[a].why) h += '<div class="ay">' + esc(r.assumptions[a].why) + "</div>";
        h += "</div>";
      }
      h += "</div>";
    }
    if (!STATE.qs.length && !(r.assumptions && r.assumptions.length)) {
      h += '<div class="dsum">ไม่มีอะไรต้องถามและไม่มีอะไรต้องเดาแทน</div>';
    }
    return h;
  }

  function saveCurrentAnswer() {
    var inp = document.getElementById("qInput");
    if (inp) STATE.answers[STATE.qi] = inp.value;
  }

  function goTo(i) {
    saveCurrentAnswer();
    if (i < 0) return;
    // Reaching the summary persists what has been answered so far — closing the
    // panel after working through ten questions used to lose all ten.
    if (i >= STATE.qs.length) { mergeAnswers(); STATE.view = "summary"; paintReview(); return; }
    STATE.qi = i;
    paintReview();
    var inp = document.getElementById("qInput");
    if (inp) inp.focus();
  }

  function wireAsk() {
    var chips = rbody.querySelectorAll(".chip");
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener("click", function (ev) {
        // Picking an option advances, like a REPL choice box. "ก่อนหน้า" and the
        // dots make that reversible, so nothing is lost by not confirming.
        STATE.answers[STATE.qi] = ev.currentTarget.getAttribute("data-fill") || "";
        var inp = document.getElementById("qInput");
        if (inp) inp.value = STATE.answers[STATE.qi];
        goTo(STATE.qi + 1);
      });
    }
    var dots = rbody.querySelectorAll(".dot");
    for (var d = 0; d < dots.length; d++) {
      dots[d].addEventListener("click", function (ev) {
        goTo(parseInt(ev.currentTarget.getAttribute("data-go"), 10));
      });
    }
    var prev = document.getElementById("qPrev");
    if (prev) prev.addEventListener("click", function () { goTo(STATE.qi - 1); });
    var next = document.getElementById("qNext");
    if (next) next.addEventListener("click", function () { goTo(STATE.qi + 1); });
    var inp = document.getElementById("qInput");
    if (inp) {
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") goTo(STATE.qi + 1);
        else if (ev.key === "ArrowUp") goTo(STATE.qi - 1);
      });
      inp.focus();
    }
  }

  function wireSummary() {
    var back = document.getElementById("qBack");
    if (back) back.addEventListener("click", function () {
      STATE.view = "ask";
      STATE.qi = 0;
      paintReview();
    });
  }

  // ── Save / Copy ────────────────────────────────────────────────────────────

  btnSave.addEventListener("click", function () {
    var isSaved = STATE.savedText !== null && ta.value === STATE.savedText;
    if (isSaved) {
      vscode.postMessage({ type: "copyPath" });
      return;
    }
    merr.textContent = "";
    STATE.askOverwrite = false;
    setDir(STATE.savedPath
      ? STATE.savedPath.slice(0, STATE.savedPath.lastIndexOf("/"))
      : STATE.defaultDir);
    if (STATE.savedPath) fName.value = STATE.savedPath.slice(STATE.savedPath.lastIndexOf("/") + 1);
    backdrop.classList.add("on");
    fName.focus();
    fName.select();
  });

  function setDir(dir) {
    STATE.dir = dir || "";
    fDirText.textContent = STATE.dir;
    fDirText.setAttribute("title", STATE.dir);
  }
  // Hands off to VS Code's own folder dialog — the webview cannot browse the
  // filesystem, and a picker cannot return a path that does not exist.
  fDirBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "pickDir", current: STATE.dir });
  });

  function closeModal() { backdrop.classList.remove("on"); }
  document.getElementById("btnCancelSave").addEventListener("click", closeModal);
  backdrop.addEventListener("click", function (ev) { if (ev.target === backdrop) closeModal(); });

  function doSave(extra) {
    var msg = { type: "save", text: ta.value, dir: STATE.dir, name: fName.value };
    if (extra && extra.overwrite) msg.overwrite = true;
    if (extra && extra.createDir) msg.createDir = true;
    vscode.postMessage(msg);
  }
  document.getElementById("btnConfirmSave").addEventListener("click", function () {
    doSave(STATE.askOverwrite ? { overwrite: true } : null);
  });
  fName.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") doSave(STATE.askOverwrite ? { overwrite: true } : null);
  });

  // ── Host messages ──────────────────────────────────────────────────────────

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || !m.type) return;
    if (m.type === "init") {
      ta.value = m.text || "";
      STATE.savedText = m.savedText === undefined ? null : m.savedText;
      STATE.savedPath = m.savedPath || null;
      STATE.defaultDir = m.defaultDir || "";
      STATE.qaAll = Array.isArray(m.qa) ? m.qa : [];
      setDir(STATE.defaultDir);
      onEdit();
      return;
    }
    if (m.type === "dirPicked") {
      if (m.dir) { setDir(m.dir); merr.textContent = ""; }
      return;
    }
    // reset template — same undo treatment as Apply, so a mis-click is one
    // Ctrl+Z away from the draft it just replaced.
    if (m.type === "setText") {
      STATE.undoText = ta.value;
      setTextUndoable(m.text || "");
      btnUndo.style.display = "";
      return;
    }
    if (m.type === "checkResult") {
      setChecking(false);
      STATE.phase = m.phase === "rewrite" ? "rewrite" : "triage";
      renderReview(m.result);
      // Nothing to ask means there is nothing for the user to do between the two
      // passes, so go straight on to the rewrite rather than making them press a
      // button that has only one sensible answer.
      if (STATE.phase === "triage" && STATE.qs.length === 0 && !STATE.pending.revised) {
        runCheck("rewrite");
      }
      return;
    }
    if (m.type === "checkError") {
      setChecking(false);
      review.classList.add("on");
      rerr.textContent = m.message || "ตรวจไม่สำเร็จ";
      return;
    }
    if (m.type === "checkCancelled") { setChecking(false); showToast("ยกเลิกการตรวจแล้ว"); return; }
    if (m.type === "saved") {
      closeModal();
      STATE.savedText = m.text === undefined ? null : m.text;
      STATE.savedPath = m.path || null;
      syncSaveButton();
      if (m.path) showToast("บันทึกแล้ว: " + m.path);
      return;
    }
    if (m.type === "saveError") {
      merr.textContent = m.message || "บันทึกไม่สำเร็จ";
      if (m.needOverwrite) {
        STATE.askOverwrite = true;
        document.getElementById("btnConfirmSave").textContent = "เขียนทับ";
      } else if (m.missing) {
        STATE.askOverwrite = false;
        merr.textContent = m.message + " กด บันทึก อีกครั้งเพื่อสร้างโฟลเดอร์";
        document.getElementById("btnConfirmSave").onclick = function () { doSave({ createDir: true }); };
      }
      return;
    }
    if (m.type === "copied") { showToast("คัดลอก path แล้ว: " + m.path); return; }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
