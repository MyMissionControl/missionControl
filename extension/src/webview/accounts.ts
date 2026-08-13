import * as vscode from "vscode";

import {
  accountExists,
  captureCurrent,
  deleteAccount,
  isProvider,
  isSafeLabel,
  listAccounts,
  liveClaudeToken,
  savedClaudeToken,
  switchTo,
  type Provider,
} from "../commands/accountsOps";
import { listAzurePats } from "../commands/azurePats";
import { fetchClaudeUsage } from "../commands/usage";
import {
  CRED_FILE,
  credTargetFromUrl,
  isValidExpiryDate,
  listGitCredentials,
  providerLabelForHost,
  removeGitCredential,
  setGitCredential,
  setPatExpiry,
  testGitCredential,
} from "../commands/gitCredentials";

// Editor-area panel for managing multiple subscription logins across AI CLIs.
// Singleton _panel, a display-ready postMessage + a message switch — mirrors
// teams.ts. All credential I/O lives in accountsOps (node-only, tested); this
// file only bridges it to the webview + native prompts and does the display
// formatting. NEVER post a token to the webview — the view carries provider
// metadata (subscription type / date) only.
let _panel: vscode.WebviewPanel | undefined;

function providerTitle(p: Provider): string {
  return p === "claude" ? "Claude" : "OpenAI · Codex";
}

/** Build a fully display-ready view so the client script stays dumb. */
function buildView(): Record<string, unknown> {
  const raw = listAccounts();
  const providers = raw.providers.map((ps) => {
    const savedActive = ps.accounts.some((a) => a.label === ps.active);
    let liveText: string;
    if (ps.live.present) {
      const tier = ps.live.secondary ? " · " + ps.live.secondary : "";
      const primary = ps.live.primary ? ps.live.primary : "login อยู่";
      const acct = savedActive ? (ps.active as string) : "ยังไม่ได้บันทึก";
      liveText = "กำลังใช้: " + primary + tier + " · account: " + acct;
    } else {
      liveText = ps.loginHint;
    }
    const accounts = ps.accounts.map((a) => {
      const when = a.capturedAt ? " · บันทึก " + a.capturedAt.slice(0, 10) : "";
      const head = a.primary ? a.primary + (a.secondary ? " · " + a.secondary : "") : "subscription";
      return { label: a.label, active: a.label === ps.active, sub: head + when, unsaved: false };
    });
    // Surface the CURRENTLY-LIVE login even before it is captured, so the account
    // in use is never invisible — but only when it isn't already a saved active row.
    if (ps.live.present && !savedActive) {
      const head = ps.live.primary
        ? ps.live.primary + (ps.live.secondary ? " · " + ps.live.secondary : "")
        : "login อยู่";
      accounts.unshift({ label: "กำลังใช้อยู่", active: true, sub: head + " · ยังไม่ได้บันทึก", unsaved: true });
    }
    return {
      provider: ps.provider,
      title: providerTitle(ps.provider),
      liveText,
      active: ps.active,
      usage: ps.provider === "claude", // only Claude has a usage endpoint
      accounts,
    };
  });
  return { type: "accounts", providers };
}

function pushList(panel: vscode.WebviewPanel): void {
  panel.webview.postMessage(buildView());
}

/** โซน Git — ⛔ ไม่มีค่า secret ในนี้เลย มีแต่ host/org + สถานะ (กฎเดียวกับ token ของ AI) */
function pushGit(panel: vscode.WebviewPanel): void {
  const { rows, ghLogin } = listGitCredentials();
  panel.webview.postMessage({
    type: "git",
    file: CRED_FILE,
    ghLogin,
    rows: rows.map((r) => ({
      host: r.host,
      user: r.user,
      provider: r.provider,
      // ⛔ ห้ามใส่สัญลักษณ์/emoji ในข้อความที่ผู้ใช้เห็น — เครื่องนี้เรนเดอร์เป็นกล่องเปล่า
      //    (ใช้คำว่า "ใช้ไม่ได้:" นำหน้าแทน แล้วให้สีของ .tres เป็นตัวบอกระดับ)
      sub:
        r.provider + " · " + r.host +
        (r.helper ? "" : " · ใช้ไม่ได้: ยังไม่ได้ตั้ง credential helper ของ host นี้"),
      testable: r.provider === "Azure DevOps",
      // สถานะวันหมดอายุ — level ให้ฝั่งหน้าจอเลือกสี, text เป็นข้อความไทยพร้อมโชว์
      expiry: r.expiry.text,
      expiryLevel: r.expiry.level,
      expiresAt: r.expiresAt,
    })),
  });
}

/** Fetch remaining usage for every Claude account whose token is still valid and
 *  post it to the webview keyed by the SAME row label buildView uses. Tokens
 *  never leave the host. Best-effort — each account degrades to a status string
 *  on expiry / rate-limit / error. */
async function pushUsage(panel: vscode.WebviewPanel): Promise<void> {
  const claude = listAccounts().providers.find((p) => p.provider === "claude");
  if (!claude) return;
  const now = Date.now();
  const activeLabel = claude.active;
  const savedActive = claude.accounts.some((a) => a.label === activeLabel);

  const targets: { label: string; token: { accessToken: string; expiresAt: number } | null }[] = [];
  const live = liveClaudeToken();
  if (claude.live.present && live) {
    // The active account's fresh token lives in .credentials.json (its vault copy
    // is stale) — key it to whichever row represents "active" (synthetic or saved).
    targets.push({ label: savedActive ? (activeLabel as string) : "กำลังใช้อยู่", token: live });
  }
  for (const a of claude.accounts) {
    if (a.label === activeLabel) continue; // handled via the live token above
    targets.push({ label: a.label, token: savedClaudeToken(a.label) });
  }

  const results: Record<string, unknown> = {};
  await Promise.all(
    targets.map(async (t) => {
      if (!t.token) {
        results[t.label] = { status: "error" };
        return;
      }
      if (t.token.expiresAt && t.token.expiresAt <= now) {
        results[t.label] = { status: "expired" };
        return;
      }
      try {
        results[t.label] = { status: "ok", usage: await fetchClaudeUsage(t.token.accessToken) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results[t.label] = { status: msg.includes("429") ? "ratelimited" : "error" };
      }
    }),
  );
  panel.webview.postMessage({ type: "usage", results });
}
function notify(r: { ok: boolean; error?: string }, okMsg: string): void {
  vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
    r.ok ? `Accounts: ${okMsg}` : `Accounts: ${r.error}`,
  );
}

async function promptLabel(provider: Provider): Promise<string> {
  const raw = await vscode.window.showInputBox({
    title: `ตั้งชื่อ label (${providerTitle(provider)})`,
    prompt: "ชื่อสั้นๆ ไว้แยก account — A-Z a-z 0-9 . _ -",
    placeHolder: "เช่น main, work, personal2",
    ignoreFocusOut: true,
    validateInput: (v) =>
      isSafeLabel((v ?? "").trim()) ? null : "ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)",
  });
  const label = (raw ?? "").trim();
  return isSafeLabel(label) ? label : "";
}

export function openAccountsPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.accounts", // ⛔ view id เดิม — เปลี่ยนแล้ว state/keybinding ของ user พัง
    "Connections",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    const provider = isProvider(msg.provider) ? (msg.provider as Provider) : null;

    switch (msg.type) {
      case "ready":
      case "reload":
        pushList(panel);
        pushGit(panel);
        void pushUsage(panel);
        return;

      // ── modal กลางจอ: เช็ค URL แล้วตอบ host/org กลับไปโชว์ใต้ช่องกรอก ────────
      case "git_url_check": {
        const url = String(msg.url ?? "").trim();
        const t = credTargetFromUrl(url);
        panel.webview.postMessage(
          t
            ? {
                type: "git_url_result",
                url,
                ok: true,
                host: t.host,
                user: t.user,
                provider: providerLabelForHost(t.host),
              }
            : { type: "git_url_result", url, ok: false, reason: "อ่าน host/org จาก URL นี้ไม่ได้" },
        );
        return;
      }

      // ดึงวันหมดอายุจริงจาก Azure (ผ่าน Entra token ของ az) — ของแถม ล้มได้ไม่กระทบอะไร
      case "git_pat_dates": {
        const org = String(msg.org ?? "");
        const r = await listAzurePats(org);
        panel.webview.postMessage({ type: "git_pat_dates_result", org, ...r });
        return;
      }

      // บันทึก PAT — ใช้ทั้งตอนเพิ่มใหม่ (host/user มาจากผลเช็ค URL) และตอนเปลี่ยน PAT
      // ⛔ ห้ามเชื่อ host/user ที่ webview ส่งมาแบบไม่ตรวจ: setGitCredential validate อีกชั้น
      //    (whitelist + กัน newline) เพราะค่านี้ถูกเขียนลงไฟล์ที่ 1 บรรทัด = 1 credential
      case "git_cred_save": {
        const host = String(msg.host ?? "");
        const user = String(msg.user ?? "");
        const pat = String(msg.pat ?? "");
        const exp = String(msg.expiresAt ?? "");
        const r = setGitCredential(host, user, pat, exp);
        notify(r, `เก็บ PAT ของ ${user} (${host}) แล้ว`);
        pushGit(panel);
        return;
      }

      case "git_expiry_save": {
        // แก้เฉพาะวันหมดอายุ — ไม่แตะ PAT · ค่าว่าง = ลืมวันไปเลย
        const host = String(msg.host ?? "");
        const user = String(msg.user ?? "");
        const next = String(msg.expiresAt ?? "").trim();
        if (next && !isValidExpiryDate(next)) {
          vscode.window.showErrorMessage("Accounts: วันหมดอายุต้องเป็น YYYY-MM-DD");
          return;
        }
        setPatExpiry(host, user, next || null);
        vscode.window.showInformationMessage(
          next ? `ตั้งวันหมดอายุของ ${user} เป็น ${next}` : `ลบวันหมดอายุของ ${user} แล้ว`,
        );
        pushGit(panel);
        return;
      }

      case "git_del": {
        const host = String(msg.host ?? "");
        const user = String(msg.user ?? "");
        const pick = await vscode.window.showWarningMessage(
          `ลบ credential ของ '${user}' (${host}) ออกจาก ${CRED_FILE}?`,
          { modal: true },
          "ลบ",
        );
        if (pick !== "ลบ") return;
        notify(removeGitCredential(host, user), `ลบ '${user}' แล้ว`);
        pushGit(panel);
        return;
      }

      case "git_test": {
        const host = String(msg.host ?? "");
        const user = String(msg.user ?? "");
        panel.webview.postMessage({ type: "git_test_result", host, user, text: "กำลังเช็ค…" });
        const r = await testGitCredential(host, user);
        panel.webview.postMessage({
          type: "git_test_result",
          host,
          user,
          ok: r.ok,
          text: (r.ok ? "PASS: " : "FAIL: ") + r.text,
        });
        return;
      }

      case "refresh_usage":
        void pushUsage(panel);
        return;

      case "add": {
        if (!provider) return;
        const label = await promptLabel(provider);
        if (!label) return;
        if (accountExists(provider, label)) {
          const pick = await vscode.window.showWarningMessage(
            `มี '${label}' (${providerTitle(provider)}) อยู่แล้ว — เขียนทับด้วย login ปัจจุบัน?`,
            { modal: true },
            "เขียนทับ",
          );
          if (pick !== "เขียนทับ") return;
        }
        const r = captureCurrent(provider, label, new Date().toISOString());
        notify(r, `บันทึก '${label}' แล้ว (= account ที่ login อยู่ตอนนี้)`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "switch": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const r = switchTo(provider, label);
        if (r.ok) {
          vscode.window.showInformationMessage(
            `Accounts: สลับไป '${label}' แล้ว — process ที่เปิด "ใหม่" จะใช้ account นี้ (ตัวที่เปิดค้างอยู่ต้อง restart)`,
          );
        } else {
          vscode.window.showErrorMessage(`Accounts: ${r.error}`);
        }
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "recapture": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const pick = await vscode.window.showWarningMessage(
          `อัปเดต '${label}' ด้วย session ที่ login อยู่ตอนนี้?\n\nใช้เมื่อ token เดิมหมุน/หมดอายุ — ต้องมั่นใจว่าตอนนี้ login เป็น account เดียวกันกับ '${label}'`,
          { modal: true },
          "อัปเดต",
        );
        if (pick !== "อัปเดต") return;
        const r = captureCurrent(provider, label, new Date().toISOString());
        notify(r, `อัปเดต '${label}' แล้ว`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "delete": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const pick = await vscode.window.showWarningMessage(
          `ลบ '${label}' (${providerTitle(provider)}) ออกจาก vault? (ลบแค่ค่าที่เก็บในเครื่อง ไม่กระทบ account จริง)`,
          { modal: true },
          "ลบ",
        );
        if (pick !== "ลบ") return;
        const r = deleteAccount(provider, label);
        notify(r, `ลบ '${label}' แล้ว`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }
    }
  });

  return panel;
}

// NOTE: the inline <script> below lives inside this template literal. Keep it
// FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would silently corrupt the client script (a known foot-gun in
// this codebase). Regexes used here (/&/g etc.) contain no backslashes.
//
// ⛔ โซน Git เคยมีบล็อกคำอธิบาย 5 บรรทัดท้ายโซน — user สั่งลบทิ้ง 2026-08-13
//    ("อะไรเยอะจัง อ่านแล้วงง" → "ลบในรูปออก") ห้ามเอากลับมา. ที่มันบอกไปอยู่จุดที่ผู้ใช้
//    เจอตอนต้องใช้จริงแล้ว: prompt ของช่องกรอกวันหมดอายุ · สถานะหมดอายุในแถวเอง ·
//    ข้อความ error ของ clone ที่บอกวิธีแก้ตรงจุด. อยากอธิบายยาว = เขียนใน docs/
//    ⛔ และห้ามใส่ HTML comment ในเทมเพลตนี้: เทสกัน emoji สแกนช่วง <body> ทั้งก้อน
//       (คอมเมนต์อยู่ในนั้นด้วย) — คอมเมนต์ที่มีสัญลักษณ์จะทำเทสแดงทั้งที่ไม่มีใครเห็น
function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 22px; margin: 0;
  }
  h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; }
  .lead { font-size: 12px; opacity: 0.7; margin-bottom: 20px; }
  .prov { margin-bottom: 26px; max-width: 780px; }
  .ph { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
  .ph h2 { font-size: 15px; font-weight: 700; margin: 0 0 3px; }
  .live { font-size: 11.5px; opacity: 0.72; }
  .ph-btns { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .usage-btn { white-space: nowrap; }
  .primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 8px 13px; font-size: 12.5px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 8px;
    padding: 10px 14px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06));
  }
  .row.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, rgba(120,160,255,0.12)); }
  .rl { font-size: 14px; font-weight: 600; }
  .rs { font-size: 11px; opacity: 0.65; margin-top: 3px; }
  .badge {
    font-size: 10px; font-weight: 700; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 4px;
    background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); margin-left: 6px; vertical-align: middle;
  }
  .badge.warn { background: var(--vscode-charts-orange, #d18616); color: #1a1a1a; }
  .b.save { border-color: var(--vscode-focusBorder); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
  .b.save:hover { background: var(--vscode-button-hoverBackground); }
  .ra { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .cur { font-size: 11px; opacity: 0.6; font-style: italic; margin-right: 4px; }
  .b {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 5px;
    padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .b:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  .b.sw { border-color: var(--vscode-focusBorder); font-weight: 600; }
  .b.del:hover { border-color: var(--vscode-inputValidation-errorBorder, #d1242f); color: var(--vscode-inputValidation-errorBorder, #d1242f); }
  .empty { opacity: 0.55; font-size: 12.5px; padding: 12px 4px; }
  .note {
    margin-top: 8px; max-width: 780px; font-size: 12px; line-height: 1.6; opacity: 0.72;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding-top: 14px;
  }
  /* ย่อคำอธิบายยาว ๆ ไว้ใต้ปุ่มพับ — หน้าจอต้องอ่านจบได้ในสายตาเดียว ไม่ใช่กำแพงตัวอักษร */
  .note > summary { cursor: pointer; opacity: 0.85; }
  .note > .nb { margin-top: 10px; }
  .note b { opacity: 0.95; }
  /* ตัวสลับโซน — ยืมรูปแบบ segmented ของหน้า Data View มาใช้ (ไม่คิดศัพท์ UI ใหม่) */
  .zones { display: flex; gap: 4px; margin: 0 0 18px; }
  .zone {
    background: transparent; color: var(--vscode-foreground); opacity: 0.7;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 6px; padding: 6px 14px; font-size: 12.5px; cursor: pointer;
  }
  .zone.on { opacity: 1; font-weight: 700; border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12)); }
  .tres { font-size: 11px; margin-top: 3px; opacity: 0.8; }
  .tres.bad { color: var(--vscode-inputValidation-errorBorder, #d1242f); opacity: 1; }
  .tres.good { color: var(--vscode-charts-green, #3fd39a); opacity: 1; }
  .tres.warn { color: var(--vscode-charts-orange, #d18616); opacity: 1; }
  /* modal ใน webview ไม่ใช่ showInputBox ของ host: ของ host ไปโผล่เป็นแถบเล็ก ๆ ที่ขอบบนจอ
     (ที่เดียวกับ command palette) ย้ายไปกลางจอไม่ได้ — user บอกว่ามองไม่เห็น/ดูแปลก 2026-08-13
     ทรงเดียวกับ modal ของหน้า Projects (orchestrator.ts) เพื่อให้หน้าตาทั้งแอปเหมือนกัน */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 18px 20px; width: 460px; max-width: 88vw;
    box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
  .modal-card .mt { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .modal-card .mh { font-size: 11px; opacity: 0.65; margin-bottom: 12px; line-height: 1.5; }
  .modal-card .ml { font-size: 11px; opacity: 0.8; margin: 12px 0 4px; }
  .modal-card input { width: 100%; box-sizing: border-box; font-size: 14px; padding: 7px 9px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  .modal-card .merr { font-size: 11px; color: #f85149; min-height: 14px; margin-top: 5px; }
  .modal-card .merr.ok { color: #3fb950; }
  .modal-card .merr.warn { color: #e3a13a; }
  .modal-card .mact { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .modal-card .mbtn { font-size: 12px; padding: 5px 14px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); }
  .modal-card .mbtn.primary { border-color: #3f7bd0; color: #fff; background: #1f6feb; }
  .modal-card .mbtn.primary:hover { background: #388bfd; }
  .modal-card .mbtn:disabled { opacity: 0.45; cursor: not-allowed; }
  .modal-card .fixed { font-size: 13px; padding: 6px 0; opacity: 0.9; }
  .modal-card .linkbtn { background: none; border: none; padding: 2px 0; margin-top: 6px;
    font-size: 11px; color: var(--vscode-textLink-foreground, #4daafc); cursor: pointer; }
  .modal-card select { width: 100%; box-sizing: border-box; font-size: 13px; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  .mono { font-family: var(--vscode-editor-font-family), monospace; font-size: 11px; opacity: 0.7; }
</style>
</head>
<body>
  <h1>Connections</h1>
  <div class="lead">ทุกอย่างที่ MC ต่ออยู่ข้างนอก — บัญชี AI และ credential ของ git</div>
  <div class="zones">
    <button class="zone on" data-z="ai">AI accounts</button>
    <button class="zone" data-z="git">Git</button>
  </div>
  <div id="zone-ai">
  <div id="providers"></div>
  <div class="note">
    <b>ใช้ยังไง:</b> login แต่ละ account ผ่าน CLI ของ provider นั้น (Claude = <b>claude /login</b>, OpenAI = <b>codex login</b>) แล้วกด "บันทึก account ปัจจุบัน" — ทำซ้ำได้หลาย account · กด <b>สลับ</b> เพื่อเปลี่ยนตัว active<br />
    <b>ข้อควรรู้:</b> สลับ = เขียนทับไฟล์ credentials ของ CLI → มีผลกับ process ที่เปิด <b>ใหม่</b> เท่านั้น ตัวที่เปิดค้างต้อง restart · ทุก session อ่าน credentials ไฟล์เดียวกันต่อ provider จึงใช้ account เดียวพร้อมกัน · token หมุนจนสลับกลับไม่ได้ → login ใหม่แล้วกด "อัปเดต"<br />
    <b>usage คงเหลือ (Claude):</b> ดึงจาก endpoint <b>/api/oauth/usage</b> ของ account เอง (ไม่กิน quota) — โชว์ 5ชม/7วัน ที่เหลือ + เวลารีเซ็ต · account ที่ active ดึงได้เสมอ (token สด) · ตัวที่ save ไว้นานจน token หมดอายุจะขึ้น "สลับไปเช็ค" · endpoint นี้ private อาจเปลี่ยนได้ กด "⟳ usage" รีเฟรช (ห่าง ≥180 วิ)<br />
    <b>ความปลอดภัย:</b> token เก็บใน ~/.claude/.mc-accounts/ (เครื่องนี้เท่านั้น, สิทธิ์ 0600) ไม่ push git ไม่แสดงค่า token
  </div>
  </div>

  <div id="zone-git" style="display:none">
    <section class="prov">
      <div class="ph">
        <div><h2>Azure DevOps · เจ้าอื่น ๆ</h2>
        <div class="live" id="git-file"></div></div>
        <div class="ph-btns"><button class="primary git-add">+ เพิ่มจาก URL repo</button></div>
      </div>
      <div id="git-rows"></div>
    </section>
    <section class="prov">
      <div class="ph"><div><h2>GitHub</h2><div class="live" id="gh-live"></div></div></div>
    </section>
  </div>

  <div id="cmodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt" id="cm-title">เพิ่ม credential</div>
      <div class="mh" id="cm-hint"></div>
      <div id="cm-urlwrap">
        <div class="ml">URL repo (copy จากปุ่ม Clone)</div>
        <input id="cm-url" type="text" spellcheck="false"
               placeholder="https://ORG@dev.azure.com/ORG/PROJECT/_git/REPO" />
        <div class="merr" id="cm-urlstatus"></div>
      </div>
      <div id="cm-fixedwrap" style="display:none">
        <div class="ml">credential ของ</div>
        <div class="fixed" id="cm-fixed"></div>
      </div>
      <div id="cm-patwrap">
        <div class="ml">Personal Access Token — scope Code (Read)</div>
        <input id="cm-pat" type="password" spellcheck="false" placeholder="วาง PAT ที่ copy มาจาก Azure" />
        <div class="merr" id="cm-patstatus"></div>
      </div>
      <div id="cm-pickwrap" style="display:none">
        <div class="ml">token ของคุณใน Azure (ดึงวันหมดอายุจริงมาให้)</div>
        <select id="cm-pick"></select>
      </div>
      <div id="cm-expwrap" style="display:none">
        <div class="ml">วันหมดอายุ (ข้ามได้ — ใส่ไว้เพื่อให้เตือนก่อนหมด)</div>
        <input id="cm-exp" type="date" />
      </div>
      <div class="merr" id="cm-expstatus"></div>
      <button class="linkbtn" id="cm-manual" style="display:none">กรอกวันหมดอายุเอง</button>
      <div class="mact">
        <button class="mbtn" id="cm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="cm-ok" disabled>บันทึก</button>
      </div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function post(type, extra) {
    const m = { type: type };
    if (extra) { for (const k in extra) { m[k] = extra[k]; } }
    vscode.postMessage(m);
  }

  let lastView = null;
  let usageMap = {};

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }
  function usageText(show, u) {
    if (!show) return "";
    if (!u) return " · usage: กำลังเช็ค…";
    if (u.status === "expired") return " · usage: token หมดอายุ (สลับไปเช็ค)";
    if (u.status === "ratelimited") return " · usage: เพิ่งเช็ค รอสักครู่";
    if (u.status !== "ok" || !u.usage) return " · usage: ดึงไม่ได้";
    const g = u.usage;
    const parts = [];
    if (g.fiveHour) parts.push("5ชม เหลือ " + g.fiveHour.remaining + "%" + (g.fiveHour.resetsAt ? " (รีเซ็ต " + fmtTime(g.fiveHour.resetsAt) + ")" : ""));
    if (g.sevenDay) parts.push("7วัน เหลือ " + g.sevenDay.remaining + "%");
    return parts.length ? " · " + parts.join(" · ") : " · usage: —";
  }

  function render() {
    const v = lastView;
    if (!v) return;
    const root = document.getElementById("providers");
    const provs = v.providers || [];
    let html = "";
    for (let i = 0; i < provs.length; i++) {
      const ps = provs[i];
      const pAttr = esc(ps.provider);
      const usageBtn = ps.usage ? '<button class="b usage-btn" data-p="' + pAttr + '">⟳ usage</button>' : "";
      html += '<section class="prov">';
      html +=
        '<div class="ph"><div><h2>' + esc(ps.title) + "</h2>" +
        '<div class="live">' + esc(ps.liveText) + "</div></div>" +
        '<div class="ph-btns">' + usageBtn +
        '<button class="primary add" data-p="' + pAttr + '">+ บันทึก account ปัจจุบัน</button></div></div>';
      const list = ps.accounts || [];
      if (!list.length) {
        html += '<div class="empty">ยังไม่มี account ที่บันทึกไว้</div>';
      } else {
        html += '<div class="rows">';
        for (let j = 0; j < list.length; j++) {
          const a = list[j];
          const lAttr = esc(a.label);
          const badge = a.unsaved
            ? ' <span class="badge warn">ใช้อยู่ · ยังไม่บันทึก</span>'
            : a.active
            ? ' <span class="badge">ACTIVE</span>'
            : "";
          const actions = a.unsaved
            ? '<button class="b save" data-p="' + pAttr + '">บันทึก account นี้</button>'
            : (a.active
                ? '<span class="cur">ใช้อยู่</span>'
                : '<button class="b sw" data-p="' + pAttr + '" data-l="' + lAttr + '">สลับ</button>') +
              '<button class="b up" data-p="' + pAttr + '" data-l="' + lAttr + '">อัปเดต</button>' +
              '<button class="b del" data-p="' + pAttr + '" data-l="' + lAttr + '">ลบ</button>';
          html +=
            '<div class="row' + (a.active ? " active" : "") + '">' +
              '<div class="ri">' +
                '<div class="rl">' + esc(a.label) + badge + "</div>" +
                '<div class="rs">' + esc(a.sub || "") + esc(usageText(ps.usage, usageMap[a.label])) + "</div>" +
              "</div>" +
              '<div class="ra">' + actions + "</div>" +
            "</div>";
        }
        html += "</div>";
      }
      html += "</section>";
    }
    root.innerHTML = html;
  }

  let gitView = null;
  const testMap = {};
  function key(h, u) { return h + " " + u; }

  function renderGit() {
    const v = gitView;
    if (!v) return;
    document.getElementById("git-file").textContent = "เก็บที่ " + (v.file || "");
    document.getElementById("gh-live").textContent = v.ghLogin
      ? "ใช้ gh auth อยู่ (account " + v.ghLogin + ") — ไม่ต้องทำอะไร"
      : "ยังไม่ได้ login: รัน gh auth login แล้วกดรีเฟรช";
    const rows = v.rows || [];
    let html = "";
    if (!rows.length) {
      html = '<div class="empty">ยังไม่มี credential — กด "+ เพิ่มจาก URL repo" แล้ววาง URL ที่ copy จากปุ่ม Clone</div>';
    } else {
      html += '<div class="rows">';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const t = testMap[key(r.host, r.user)];
        const cls = t == null ? "tres" : t.ok === true ? "tres good" : t.ok === false ? "tres bad" : "tres";
        // สถานะวันหมดอายุ: หมดแล้ว/ใกล้หมด = สีเตือน · ไม่รู้วัน = สีจาง (ไม่ใช่ error)
        const ecls =
          r.expiryLevel === "expired" ? "tres bad"
          : r.expiryLevel === "soon" ? "tres warn"
          : r.expiryLevel === "ok" ? "tres good" : "tres";
        const etext = r.expiryLevel === "expired" ? "PAT " + r.expiry + " — กด 'เปลี่ยน PAT'" : r.expiry;
        html +=
          '<div class="row"><div class="ri">' +
            '<div class="rl">' + esc(r.user) + '</div>' +
            '<div class="rs">' + esc(r.sub) + '</div>' +
            (r.expiry ? '<div class="' + ecls + '">' + esc(etext) + '</div>' : "") +
            (t ? '<div class="' + cls + '">' + esc(t.text) + '</div>' : "") +
          '</div><div class="ra">' +
            (r.testable ? '<button class="b gtest" data-h="' + esc(r.host) + '" data-u="' + esc(r.user) + '">ทดสอบ</button>' : "") +
            '<button class="b gexp" data-h="' + esc(r.host) + '" data-u="' + esc(r.user) + '" data-e="' + esc(r.expiresAt || "") + '">วันหมดอายุ</button>' +
            '<button class="b gedit" data-h="' + esc(r.host) + '" data-u="' + esc(r.user) + '">เปลี่ยน PAT</button>' +
            '<button class="b del gdel" data-h="' + esc(r.host) + '" data-u="' + esc(r.user) + '">ลบ</button>' +
          '</div></div>';
      }
      html += "</div>";
    }
    document.getElementById("git-rows").innerHTML = html;
  }

  // ── modal กลางจอสำหรับใส่ credential (แทน showInputBox 3 ชั้นของ host) ──────
  // โหมด: "add" = กรอก URL เอง · "pat" = รู้ host/org แล้ว (กด "เปลี่ยน PAT") ·
  //       "exp" = แก้แค่วันหมดอายุ (ไม่ต้องกรอก PAT ใหม่)
  // ⛔ PAT อยู่ในช่อง input ของ webview จนกดบันทึก แล้วล้างทันที — และไม่เคยถูกเก็บใน
  //    ตัวแปร/state ที่ render ซ้ำ (retainContextWhenHidden ทำให้ DOM ค้างอยู่ตอนซ่อน)
  var _cmMode = "add", _cmHost = "", _cmUser = "", _cmUrlOk = false, _cmTimer = null;
  function cmEl(id) { return document.getElementById(id); }
  function openCred(mode, host, user, expiresAt) {
    _cmMode = mode; _cmHost = host || ""; _cmUser = user || ""; _cmUrlOk = false;
    var isAdd = mode === "add", isExp = mode === "exp";
    cmEl("cm-title").textContent = isAdd ? "เพิ่ม credential จาก URL repo"
      : isExp ? "วันหมดอายุของ PAT" : "เปลี่ยน PAT";
    cmEl("cm-hint").textContent = isAdd
      ? "วาง URL ที่ copy จากปุ่ม Clone แล้ว MC จะแกะ host + org ให้เอง"
      : "Azure DevOps: User settings → Personal access tokens → New Token";
    cmEl("cm-urlwrap").style.display = isAdd ? "" : "none";
    cmEl("cm-fixedwrap").style.display = isAdd ? "none" : "";
    cmEl("cm-patwrap").style.display = isExp ? "none" : "";
    cmEl("cm-fixed").textContent = _cmUser + "  ·  " + _cmHost;
    cmEl("cm-url").value = ""; cmEl("cm-pat").value = "";
    cmEl("cm-exp").value = expiresAt || "";
    cmEl("cm-urlstatus").textContent = ""; cmEl("cm-urlstatus").className = "merr";
    cmEl("cm-patstatus").textContent = ""; cmEl("cm-patstatus").className = "merr";
    // ⛔ ซ่อนทั้ง dropdown และปฏิทินไว้ก่อน — user บอกว่า "ถ้าดึงจริงไม่ต้องให้มันแสดงปฏิทิน"
    //    ปฏิทินจะโผล่เฉพาะตอนดึงวันจาก Azure ไม่ได้ หรือกด "กรอกวันหมดอายุเอง"
    cmEl("cm-pickwrap").style.display = "none";
    cmEl("cm-pick").innerHTML = "";
    cmEl("cm-expwrap").style.display = "none";
    cmEl("cm-manual").style.display = "none";
    cmEl("cm-expstatus").textContent = ""; cmEl("cm-expstatus").className = "merr";
    cmEl("cmodal").style.display = "flex";
    (isAdd ? cmEl("cm-url") : isExp ? cmEl("cm-exp") : cmEl("cm-pat")).focus();
    cmSync();
    // โหมดที่รู้ org อยู่แล้ว = ขอวันหมดอายุจริงได้เลย · โหมด add รอผลเช็ค URL ก่อน
    if (!isAdd && _cmUser) askDates(_cmUser);
    else if (isAdd) {
      cmEl("cm-expstatus").textContent = "วันหมดอายุ: จะดึงจาก Azure ให้เองหลังใส่ URL";
      cmEl("cm-expstatus").className = "merr";
      cmEl("cm-manual").style.display = "";
    }
  }

  // ── ดึงวันหมดอายุจริงจาก Azure ────────────────────────────────────────────
  // ⛔ API ไม่คืนค่า token กลับมา จับคู่อัตโนมัติว่า PAT ที่เก็บไว้เป็นตัวไหน "ไม่ได้" →
  //    ให้เลือกจากรายการ (1 คลิก) · เหลือ token เดียว = เลือกให้เลย ไม่ต้องคลิก
  var _cmDatesOrg = "";
  function askDates(org) {
    if (!org || org === _cmDatesOrg) return;
    _cmDatesOrg = org;
    cmEl("cm-expstatus").textContent = "กำลังดึงวันหมดอายุจาก Azure…";
    cmEl("cm-expstatus").className = "merr";
    post("git_pat_dates", { org: org });
  }
  function cmDatesResult(m) {
    if (m.org !== _cmDatesOrg) return;
    var st = cmEl("cm-expstatus"), wrap = cmEl("cm-pickwrap"), sel = cmEl("cm-pick");
    var pats = m.pats || [];
    if (!m.ok || !pats.length) {
      // ดึงไม่ได้จริง → ตรงนี้เท่านั้นที่ปฏิทินควรโผล่
      wrap.style.display = "none";
      cmEl("cm-expwrap").style.display = "";
      cmEl("cm-manual").style.display = "none";
      st.textContent = m.ok ? "ไม่เจอ token ที่ยังใช้ได้ใน org นี้ — กรอกวันเองได้" : (m.reason || "");
      st.className = "merr warn";
      return;
    }
    var html = '<option value="">— เลือกเอง / ไม่ระบุ —</option>';
    for (var i = 0; i < pats.length; i++) {
      html += '<option value="' + esc(pats[i].expiresAt) + '">' + esc(pats[i].name) +
              "  ·  หมด " + esc(pats[i].expiresAt) + "</option>";
    }
    sel.innerHTML = html;
    wrap.style.display = "";
    cmEl("cm-expwrap").style.display = "none";   // ดึงได้แล้ว = ไม่ต้องมีปฏิทิน
    cmEl("cm-manual").style.display = "";        // เผื่ออยากทับด้วยมือ
    if (pats.length === 1) { sel.value = pats[0].expiresAt; cmEl("cm-exp").value = pats[0].expiresAt; }
    st.textContent = pats.length === 1
      ? "เจอ token เดียว ใส่วันให้แล้ว"
      : "เจอ " + pats.length + " token — เลือกตัวที่กำลังวาง";
    st.className = "merr ok";
  }
  function closeCred() {
    // ⛔ ล้าง PAT ออกจาก DOM ทุกครั้งที่ปิด ไม่ปล่อยค้างในหน้าที่ซ่อนอยู่
    cmEl("cm-pat").value = ""; cmEl("cm-url").value = "";
    cmEl("cmodal").style.display = "none";
    _cmDatesOrg = "";
    if (_cmTimer) { clearTimeout(_cmTimer); _cmTimer = null; }
  }
  function cmSync() {
    var isAdd = _cmMode === "add", isExp = _cmMode === "exp";
    var okUrl = isAdd ? _cmUrlOk : true;
    var okPat = isExp ? true : cmEl("cm-pat").value.trim().length > 0;
    cmEl("cm-ok").disabled = !(okUrl && okPat);
  }
  function cmUrlChanged() {
    _cmUrlOk = false; cmSync();
    var u = cmEl("cm-url").value.trim();
    var st = cmEl("cm-urlstatus");
    if (!u) { st.textContent = ""; st.className = "merr"; return; }
    st.textContent = "กำลังอ่าน URL…"; st.className = "merr";
    if (_cmTimer) clearTimeout(_cmTimer);
    _cmTimer = setTimeout(function () { post("git_url_check", { url: u }); }, 350);
  }
  function cmUrlResult(m) {
    var st = cmEl("cm-urlstatus");
    if (m.url !== cmEl("cm-url").value.trim()) return; // ผลของ URL เก่า ทิ้ง
    if (m.ok) {
      _cmHost = m.host; _cmUser = m.user; _cmUrlOk = true;
      st.textContent = m.provider + " · org " + m.user;
      st.className = "merr ok";
      askDates(m.user);
    } else {
      _cmUrlOk = false; st.textContent = m.reason || "อ่าน URL นี้ไม่ได้"; st.className = "merr bad";
    }
    cmSync();
  }
  function cmSave() {
    if (cmEl("cm-ok").disabled) return;
    var exp = cmEl("cm-exp").value.trim();
    if (_cmMode === "exp") { post("git_expiry_save", { host: _cmHost, user: _cmUser, expiresAt: exp }); }
    else {
      post("git_cred_save", {
        host: _cmHost, user: _cmUser, pat: cmEl("cm-pat").value, expiresAt: exp,
      });
    }
    closeCred();
  }
  cmEl("cm-cancel").addEventListener("click", closeCred);
  cmEl("cm-ok").addEventListener("click", cmSave);
  cmEl("cm-url").addEventListener("input", cmUrlChanged);
  cmEl("cm-pat").addEventListener("input", cmSync);
  cmEl("cm-manual").addEventListener("click", function () {
    cmEl("cm-expwrap").style.display = "";
    cmEl("cm-manual").style.display = "none";
    cmEl("cm-exp").focus();
  });
  cmEl("cm-pick").addEventListener("change", function () {
    if (cmEl("cm-pick").value) cmEl("cm-exp").value = cmEl("cm-pick").value;
  });
  cmEl("cmodal").addEventListener("click", function (e) { if (e.target === cmEl("cmodal")) closeCred(); });
  cmEl("cmodal").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); cmSave(); }
    else if (e.key === "Escape") { e.preventDefault(); closeCred(); }
  });

  function showZone(z) {
    document.getElementById("zone-ai").style.display = z === "ai" ? "" : "none";
    document.getElementById("zone-git").style.display = z === "git" ? "" : "none";
    const bs = document.querySelectorAll(".zone");
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].getAttribute("data-z") === z) bs[i].classList.add("on");
      else bs[i].classList.remove("on");
    }
  }

  document.addEventListener("click", function (e) {
    const t = e.target;
    if (!t || !t.classList || !t.getAttribute) return;
    const z = t.getAttribute("data-z");
    if (z) { showZone(z); return; }
    const h = t.getAttribute("data-h");
    const u = t.getAttribute("data-u");
    if (t.classList.contains("git-add")) { openCred("add"); return; }
    if (t.classList.contains("gtest")) { post("git_test", { host: h, user: u }); return; }
    // เปลี่ยน PAT = เขียนทับคู่ host+user เดิม → modal โหมด "pat" (ไม่ต้องถาม URL ซ้ำ)
    if (t.classList.contains("gedit")) { openCred("pat", h, u, t.getAttribute("data-e") || ""); return; }
    // แก้แค่วันหมดอายุ ไม่ต้องกรอก PAT ใหม่ (เผื่อ user เพิ่งไปต่ออายุที่เว็บ Azure)
    if (t.classList.contains("gexp")) { openCred("exp", h, u, t.getAttribute("data-e") || ""); return; }
    // ⛔ ต้องมาก่อน .del ตัวล่าง: gdel มีคลาส del ด้วย ถ้าปล่อยไปถึงบรรทัดนั้นจะกลายเป็นลบ account AI
    if (t.classList.contains("gdel")) { post("git_del", { host: h, user: u }); return; }
    const p = t.getAttribute("data-p");
    const l = t.getAttribute("data-l");
    if (t.classList.contains("usage-btn")) { post("refresh_usage"); return; }
    if (t.classList.contains("add")) { post("add", { provider: p }); return; }
    if (t.classList.contains("save")) { post("add", { provider: p }); return; }
    if (t.classList.contains("sw")) { post("switch", { provider: p, label: l }); return; }
    if (t.classList.contains("up")) { post("recapture", { provider: p, label: l }); return; }
    if (t.classList.contains("del")) { post("delete", { provider: p, label: l }); return; }
  });

  window.addEventListener("message", function (ev) {
    const m = ev.data;
    if (!m) return;
    if (m.type === "accounts") { lastView = m; render(); }
    else if (m.type === "usage") { usageMap = m.results || {}; render(); }
    else if (m.type === "git") { gitView = m; renderGit(); }
    else if (m.type === "git_url_result") { cmUrlResult(m); }
    else if (m.type === "git_pat_dates_result") { cmDatesResult(m); }
    else if (m.type === "git_test_result") { testMap[key(m.host, m.user)] = { ok: m.ok, text: m.text }; renderGit(); }
  });

  post("ready");
</script>
</body></html>`;
}
