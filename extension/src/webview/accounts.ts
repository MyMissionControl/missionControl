import { execFileSync } from "node:child_process";

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
import {
  PROVIDER_PRESETS,
  activateApiAccount,
  apiAccountSecret,
  clearApiRoute,
  deleteApiAccount,
  isSafeBaseUrl,
  isSafeId,
  listApiProviders,
  saveApiAccount,
} from "../commands/apiProvidersOps";
import { fetchClaudeUsage } from "../commands/usage";
import { setTabIcon } from "./tabIcon";

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

/** โซน API providers — provider ที่เข้าด้วย API key (z.ai/GLM, MiniMax, …) ซึ่งสลับด้วย
 *  การเขียนบล็อก env ของ settings.json ไม่ใช่การสลับไฟล์ credentials
 *  ⛔ กฎเดียวกับอีกสองโซน: ไม่มีค่า key จริงในข้อมูลที่ส่งออกไป มีแต่ mask */
function pushApi(panel: vscode.WebviewPanel): void {
  const v = listApiProviders();
  const live = v.live;
  const activeLabel = v.active ? v.active.provider + " / " + v.active.label : "";
  // ⛔ แยก "vault บอกว่า active" กับ "settings.json ชี้ไปไหนจริง" ให้เห็นคนละบรรทัด:
  //    ถ้าใครแก้ settings.json ด้วยมือ สองอย่างนี้จะไม่ตรงกัน และคนต้องรู้ทันที
  let liveText: string;
  if (!live) {
    liveText = "กำลังใช้: Anthropic ปกติ (ไม่มี env ของ provider อื่นอยู่ใน settings.json)";
  } else if (activeLabel) {
    liveText =
      "กำลังใช้: " + activeLabel + " · " + live.baseUrl + (live.model ? " · " + live.model : "");
  } else {
    liveText =
      "กำลังใช้: " + live.baseUrl + (live.model ? " · " + live.model : "") +
      " · ไม่ตรงกับ account ไหนใน vault (ถูกแก้ settings.json ด้วยมือ)";
  }
  panel.webview.postMessage({
    type: "api",
    liveText,
    routed: live !== null,
    settingsReadable: v.settingsReadable,
    presets: PROVIDER_PRESETS.map((x) => ({ id: x.id, name: x.name, baseUrl: x.baseUrl, note: x.note })),
    providers: v.providers.map((ps) => ({
      provider: ps.provider,
      title: ps.name,
      accounts: ps.accounts.map((a) => ({
        label: a.label,
        active: v.active?.provider === ps.provider && v.active?.label === a.label,
        sub:
          a.keyMask + " · " + a.baseUrl + (a.model ? " · " + a.model : "") +
          (a.savedAt ? " · บันทึก " + a.savedAt.slice(0, 10) : ""),
      })),
    })),
  });
}

/** ยิงคำขอที่เล็กที่สุดเท่าที่เป็นไปได้ไปที่ endpoint ของ account หนึ่ง เพื่อจับ base URL /
 *  key ที่ผิด **ก่อน** จะเอาไปตั้งทั้งเครื่อง — เพราะถ้าตั้งผิด claude ทุกตัวจะพังพร้อมกัน
 *  ⛔ ค่าที่คืนกลับเป็นข้อความสถานะเท่านั้น ไม่มี key ไม่มี body ดิบ */
async function testApiAccount(provider: string, label: string): Promise<{ ok: boolean; text: string }> {
  const secret = apiAccountSecret(provider, label);
  if (!secret) return { ok: false, text: "ไม่พบ key/base URL ของ account นี้" };
  const url = secret.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": secret.apiKey,
        authorization: "Bearer " + secret.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: secret.model || "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true, text: "ต่อได้ (HTTP " + res.status + ")" };
    // 400 = endpoint พูดภาษา Anthropic แต่ model/param ไม่ตรง ⇒ เส้นทางถูก key ผ่าน
    if (res.status === 400) {
      return { ok: true, text: "endpoint ตอบแบบ Anthropic (400 — น่าจะเป็นชื่อ model) เส้นทางใช้ได้" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, text: "key ไม่ผ่าน (HTTP " + res.status + ")" };
    if (res.status === 404) return { ok: false, text: "ไม่มี /v1/messages ที่ URL นี้ (404) — base URL น่าจะผิด" };
    return { ok: false, text: "HTTP " + res.status };
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    return { ok: false, text: ctrl.signal.aborted ? "หมดเวลา 15 วินาที" : "ต่อไม่ได้: " + m };
  } finally {
    clearTimeout(timer);
  }
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
  setTabIcon(panel);
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
        pushApi(panel);
        void pushUsage(panel);
        return;

      // ── โซน API providers ────────────────────────────────────────────────────
      // ⛔ key มาจาก webview ครั้งเดียวตอนกดบันทึก แล้วฝั่งหน้าจอล้างช่องทันที
      case "api_save": {
        const prov = String(msg.provider ?? "").trim();
        const label = String(msg.label ?? "").trim();
        if (!isSafeId(prov) || !isSafeId(label)) {
          void vscode.window.showErrorMessage("ชื่อ provider/account ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)");
          return;
        }
        if (!isSafeBaseUrl(msg.baseUrl)) {
          void vscode.window.showErrorMessage("base URL ต้องเป็น http(s) เต็มรูปแบบ");
          return;
        }
        const r = saveApiAccount(
          prov,
          label,
          {
            apiKey: String(msg.apiKey ?? ""),
            baseUrl: String(msg.baseUrl ?? ""),
            model: String(msg.model ?? ""),
            smallFastModel: String(msg.smallFastModel ?? ""),
          },
          new Date().toISOString(),
        );
        notify(r, `บันทึก ${prov} / ${label} แล้ว (ยังไม่สลับไปใช้)`);
        pushApi(panel);
        return;
      }

      case "api_switch": {
        const prov = String(msg.provider ?? "");
        const label = String(msg.label ?? "");
        if (!isSafeId(prov) || !isSafeId(label)) return;
        // เตือนให้ชัดว่านี่คือระดับเครื่อง ไม่ใช่แค่แท็บนี้ — และของที่เปิดค้างไม่เปลี่ยน
        const pick = await vscode.window.showWarningMessage(
          `ให้ claude ทุกตัวบนเครื่องนี้วิ่งไปที่ ${prov} / ${label}?`,
          { modal: true, detail: "เขียนบล็อก env ใน settings.json (สำรองไฟล์เดิมให้ก่อน) · มีผลกับ process ที่เปิดใหม่เท่านั้น" },
          "สลับ",
        );
        if (pick !== "สลับ") return;
        const r = activateApiAccount(prov, label);
        notify(r, `สลับไป ${prov} / ${label} แล้ว — เปิด session ใหม่เพื่อให้มีผล`);
        pushApi(panel);
        return;
      }

      case "api_clear": {
        const pick = await vscode.window.showWarningMessage(
          "กลับไปใช้ Anthropic ปกติ?",
          { modal: true, detail: "ลบเฉพาะ env ที่ MC เขียนไว้ ค่าอื่นใน settings.json ไม่แตะ" },
          "กลับไปใช้ Anthropic",
        );
        if (pick !== "กลับไปใช้ Anthropic") return;
        const r = clearApiRoute();
        notify(r, "กลับไปใช้ Anthropic ปกติแล้ว — เปิด session ใหม่เพื่อให้มีผล");
        pushApi(panel);
        return;
      }

      case "api_test": {
        const prov = String(msg.provider ?? "");
        const label = String(msg.label ?? "");
        if (!isSafeId(prov) || !isSafeId(label)) return;
        const r = await testApiAccount(prov, label);
        panel.webview.postMessage({ type: "api_test_result", provider: prov, label, ok: r.ok, text: r.text });
        return;
      }

      // เปิด dashboard ของ CCS — ของนอก ไม่ใช่ทางที่ MC ใช้สลับ account/provider
      // ⛔ `ccs config` เปิดเบราว์เซอร์เองและปลุก CLIProxy daemon (ไม่มี flag ปิด) จึงเรียกได้
      //    เฉพาะตอนคนกดปุ่มนี้เท่านั้น ห้ามเรียกจากที่อื่นหรือเบื้องหลังเด็ดขาด
      case "open_ccs_ui": {
        let bin = "";
        try {
          // ผ่าน login shell เพราะ bin ของ bun/npm global มักไม่อยู่ใน PATH ของ extension host
          bin = execFileSync("bash", ["-lc", "command -v ccs"], {
            encoding: "utf8",
            timeout: 5000,
          }).trim();
        } catch {
          bin = "";
        }
        if (!bin) {
          const CMD = "bun add -g @kaitranntt/ccs";
          const pick = await vscode.window.showInformationMessage(
            "ยังไม่ได้ลง CCS บนเครื่องนี้ — UI นั้นเป็นของ CLI ตัวนั้น ไม่ใช่ของ MC",
            {
              modal: true,
              detail:
                "MC สลับ account/provider ได้เองอยู่แล้ว ไม่ต้องพึ่ง CCS · ปุ่มนี้มีไว้เปิด UI ของเขาถ้าอยากดู\n\nลงด้วย:\n" +
                CMD +
                "\n\nข้อควรระวังที่อ่านจากซอร์สมาแล้ว: อย่ารัน 'ccs sync' เพราะมันเอา skills/commands ของตัวเอง symlink เข้า ~/.claude",
            },
            "คัดลอกคำสั่งลง",
          );
          if (pick) {
            await vscode.env.clipboard.writeText(CMD);
            vscode.window.setStatusBarMessage("คัดลอกคำสั่งแล้ว — วางใน terminal เพื่อลง", 4000);
          }
          return;
        }
        const term = vscode.window.createTerminal({ name: "CCS UI" });
        term.sendText("ccs config");
        term.show();
        return;
      }

      case "api_del": {
        const prov = String(msg.provider ?? "");
        const label = String(msg.label ?? "");
        if (!isSafeId(prov) || !isSafeId(label)) return;
        const pick = await vscode.window.showWarningMessage(
          `ลบ ${prov} / ${label} ออกจาก vault?`,
          { modal: true, detail: "ถ้าเป็นตัวที่ใช้อยู่ จะกลับไปใช้ Anthropic ปกติให้ด้วย" },
          "ลบ",
        );
        if (pick !== "ลบ") return;
        const r = deleteApiAccount(prov, label);
        notify(r, `ลบ ${prov} / ${label} แล้ว`);
        pushApi(panel);
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
  .modal-card select { width: 100%; box-sizing: border-box; font-size: 13px; padding: 6px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  .mono { font-family: var(--vscode-editor-font-family), monospace; font-size: 11px; opacity: 0.7; }
</style>
</head>
<body>
  <h1>Connections</h1>
  <div class="lead">ทุกอย่างที่ MC ต่ออยู่ข้างนอก — บัญชี AI (subscription login + API key)</div>
  <div class="zones">
    <button class="zone on" data-z="ai">AI accounts</button>
    <button class="zone" data-z="api">API providers</button>
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

  <div id="zone-api" style="display:none">
    <section class="prov">
      <div class="ph">
        <div><h2>Provider ที่เข้าด้วย API key</h2>
        <div class="live" id="api-live"></div></div>
        <div class="ph-btns">
          <button class="b ccsui">เปิด UI ของ CCS</button>
          <button class="b apiclear">กลับไปใช้ Anthropic</button>
          <button class="primary api-add">+ เพิ่ม account</button>
        </div>
      </div>
      <div id="api-rows"></div>
    </section>
    <div class="note">
      <b>ใช้ยังไง:</b> กด "+ เพิ่ม account" เลือก provider (หรือกรอกเอง) แล้ววาง base URL แบบ Anthropic กับ API key — เก็บได้หลาย provider และหลาย account ต่อ provider · กด <b>ทดสอบ</b> ก่อน แล้วค่อยกด <b>สลับ</b><br />
      <b>ต่างจากโซน AI accounts ตรงไหน:</b> โซนนั้นสลับ <b>ไฟล์ credentials</b> ของ CLI (subscription login) · โซนนี้เขียนบล็อก <b>env ใน settings.json</b> (ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL) ซึ่งเป็นวิธีที่ Claude Code ใช้ชี้ไป endpoint อื่น<br />
      <b>ข้อควรรู้:</b> มีผลระดับ <b>เครื่อง</b> กับ process ที่เปิด <b>ใหม่</b> เท่านั้น · MC แตะเฉพาะ env ที่ตัวเองเขียน ค่าอื่นใน settings.json (hooks, statusLine, permissions, env ของคุณ) ไม่ถูกแก้ และสำรองไฟล์เดิมไว้ที่ settings.json.mc-bak ก่อนเขียนทุกครั้ง · base URL ผิด = claude ทุกตัวพังพร้อมกัน จึงควรกดทดสอบก่อน<br />
      <b>ความปลอดภัย:</b> key เก็บที่ ~/.claude/.mc-api-providers/ (สิทธิ์ 0600) ไม่ push git · หน้านี้เห็นแค่ค่าที่ปิดบังไว้ เช่น zai-…1234
    </div>
  </div>

  <div id="amodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt">เพิ่ม account ของ provider</div>
      <div class="mh" id="am-hint">endpoint ต้องรับ /v1/messages แบบ Anthropic — ดู docs ของ provider นั้น</div>
      <div class="ml">provider</div>
      <select id="am-preset"></select>
      <div class="ml">ชื่อ account (ตั้งเอง เช่น work / personal)</div>
      <input id="am-label" type="text" spellcheck="false" placeholder="work" />
      <div class="ml">API key</div>
      <input id="am-key" type="password" spellcheck="false" placeholder="วาง key ของ provider" />
      <div id="am-customwrap" style="display:none">
        <div class="ml">ชื่อ provider ที่ใช้เก็บ (A-Z a-z 0-9 . _ -)</div>
        <input id="am-prov" type="text" spellcheck="false" placeholder="myprovider" />
        <div class="ml">base URL</div>
        <input id="am-url" type="text" spellcheck="false" placeholder="https://…/anthropic" />
      </div>
      <div class="merr" id="am-err"></div>
      <div class="mact">
        <button class="mbtn" id="am-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="am-ok" disabled>บันทึก</button>
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

  // ── โซน API providers ──────────────────────────────────────────────────────
  // ⛔ apiView ไม่มีค่า key จริง (host ส่งมาแต่ mask) จึง render ซ้ำได้ไม่มีความเสี่ยง
  let apiView = null;
  const apiTestMap = {};
  function apiKeyOf(p, l) { return p + " / " + l; }

  function renderApi() {
    const v = apiView;
    if (!v) return;
    document.getElementById("api-live").textContent = v.liveText || "";
    const clearBtn = document.querySelector(".apiclear");
    if (clearBtn) clearBtn.style.display = v.routed ? "" : "none";
    const root = document.getElementById("api-rows");
    const provs = v.providers || [];
    let html = "";
    if (!v.settingsReadable) {
      html += '<div class="tres bad">อ่าน settings.json ไม่ออก (ไม่ใช่ JSON object) — ปุ่มสลับจะไม่เขียนไฟล์นี้จนกว่าจะซ่อมด้วยมือ</div>';
    }
    if (!provs.length) {
      html += '<div class="empty">ยังไม่มี provider — กด "+ เพิ่ม account" แล้ววาง base URL กับ API key</div>';
      root.innerHTML = html;
      return;
    }
    for (let i = 0; i < provs.length; i++) {
      const ps = provs[i];
      html += '<div class="live" style="margin:14px 0 6px">' + esc(ps.title) + '</div><div class="rows">';
      const list = ps.accounts || [];
      for (let j = 0; j < list.length; j++) {
        const a = list[j];
        const pAttr = esc(ps.provider), lAttr = esc(a.label);
        const t = apiTestMap[apiKeyOf(ps.provider, a.label)];
        const tcls = t == null ? "tres" : t.ok === true ? "tres good" : "tres bad";
        html +=
          '<div class="row' + (a.active ? " active" : "") + '"><div class="ri">' +
            '<div class="rl">' + esc(a.label) + (a.active ? ' <span class="badge">ACTIVE</span>' : "") + '</div>' +
            '<div class="rs">' + esc(a.sub || "") + '</div>' +
            (t ? '<div class="' + tcls + '">' + esc(t.text) + '</div>' : "") +
          '</div><div class="ra">' +
            '<button class="b apitest" data-ap="' + pAttr + '" data-al="' + lAttr + '">ทดสอบ</button>' +
            (a.active
              ? '<span class="cur">ใช้อยู่</span>'
              : '<button class="b apisw" data-ap="' + pAttr + '" data-al="' + lAttr + '">สลับ</button>') +
            '<button class="b apidel" data-ap="' + pAttr + '" data-al="' + lAttr + '">ลบ</button>' +
          '</div></div>';
      }
      html += "</div>";
    }
    root.innerHTML = html;
  }

  // ── modal เพิ่ม account ของ provider ───────────────────────────────────────
  // ⛔ key อยู่ในช่อง input จนกดบันทึก แล้วล้างทันที ไม่เคยถูกเก็บใน state ที่ render ซ้ำ
  function amEl(id) { return document.getElementById(id); }
  function amFillPresets() {
    const sel = amEl("am-preset");
    if (sel.options.length) return; // เติมครั้งเดียว
    const ps = (apiView && apiView.presets) || [];
    let html = "";
    for (let i = 0; i < ps.length; i++) {
      html += '<option value="' + esc(ps[i].id) + '">' + esc(ps[i].name) + "</option>";
    }
    sel.innerHTML = html;
  }
  function amPreset() {
    const ps = (apiView && apiView.presets) || [];
    const id = amEl("am-preset").value;
    for (let i = 0; i < ps.length; i++) { if (ps[i].id === id) return ps[i]; }
    return null;
  }
  function amApplyPreset() {
    const p = amPreset();
    if (!p) return;
    amEl("am-hint").textContent = p.note || "";
    // ⛔ preset รู้ทั้งชื่อและ base URL อยู่แล้ว จึงไม่ถามซ้ำ — เหลือแค่ชื่อ account + key
    //    ช่องคู่นี้โผล่เฉพาะ "อื่นๆ" ที่เราไม่รู้ปลายทางจริงๆ
    const custom = p.id === "custom";
    amEl("am-customwrap").style.display = custom ? "" : "none";
    amEl("am-prov").value = custom ? "" : p.id;
    amEl("am-url").value = custom ? "" : p.baseUrl;
    amSync();
  }
  const ID_OK = /^[A-Za-z0-9._-]{1,60}$/;
  function amSync() {
    const prov = amEl("am-prov").value.trim();
    const label = amEl("am-label").value.trim();
    const url = amEl("am-url").value.trim();
    const key = amEl("am-key").value;
    let err = "";
    if (prov && (!ID_OK.test(prov) || prov === "_index")) err = "ชื่อ provider ใช้ได้เฉพาะ A-Z a-z 0-9 . _ -";
    else if (label && (!ID_OK.test(label) || label === "_index")) err = "ชื่อ account ใช้ได้เฉพาะ A-Z a-z 0-9 . _ -";
    else if (url && url.indexOf("http") !== 0) err = "base URL ต้องขึ้นต้นด้วย http:// หรือ https://";
    amEl("am-err").textContent = err;
    amEl("am-ok").disabled = !!err || !prov || !label || !url || !key;
  }
  function openApiAdd() {
    amFillPresets();
    amEl("am-label").value = ""; amEl("am-key").value = "";
    amEl("am-err").textContent = "";
    amApplyPreset();
    amEl("amodal").style.display = "flex";
    amEl("am-label").focus();
  }
  function closeApiAdd() {
    amEl("amodal").style.display = "none";
    // ⛔ อย่าให้ key ค้างใน DOM — retainContextWhenHidden ทำให้ DOM อยู่ต่อตอนซ่อนแท็บ
    amEl("am-key").value = "";
  }
  function amSave() {
    if (amEl("am-ok").disabled) return;
    // ⛔ ไม่ส่ง model — user สั่ง 2026-08-20 ว่าใช้เพื่อเลือก "account ไหนจ่าย" ไม่ใช่เปลี่ยนโมเดล
    //    ปล่อยว่าง = ไม่เขียน ANTHROPIC_MODEL ⇒ โมเดลยังเลือกจากที่เดิม (statusline / --model)
    post("api_save", {
      provider: amEl("am-prov").value.trim(),
      label: amEl("am-label").value.trim(),
      baseUrl: amEl("am-url").value.trim(),
      apiKey: amEl("am-key").value
    });
    closeApiAdd();
  }
  amEl("am-preset").addEventListener("change", amApplyPreset);
  amEl("am-prov").addEventListener("input", amSync);
  amEl("am-label").addEventListener("input", amSync);
  amEl("am-url").addEventListener("input", amSync);
  amEl("am-key").addEventListener("input", amSync);
  amEl("am-cancel").addEventListener("click", closeApiAdd);
  amEl("am-ok").addEventListener("click", amSave);
  amEl("amodal").addEventListener("click", function (e) { if (e.target === amEl("amodal")) closeApiAdd(); });

  amEl("amodal").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); amSave(); }
    else if (e.key === "Escape") { e.preventDefault(); closeApiAdd(); }
  });

  function showZone(z) {
    document.getElementById("zone-ai").style.display = z === "ai" ? "" : "none";
    document.getElementById("zone-api").style.display = z === "api" ? "" : "none";
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
    // โซน API providers มาก่อน เพื่อไม่ให้ปุ่มของมันไปตกที่ handler ท้ายไฟล์
    const ap = t.getAttribute("data-ap");
    const al = t.getAttribute("data-al");
    if (t.classList.contains("api-add")) { openApiAdd(); return; }
    if (t.classList.contains("ccsui")) { post("open_ccs_ui"); return; }
    if (t.classList.contains("apiclear")) { post("api_clear"); return; }
    if (t.classList.contains("apitest")) { post("api_test", { provider: ap, label: al }); return; }
    if (t.classList.contains("apisw")) { post("api_switch", { provider: ap, label: al }); return; }
    if (t.classList.contains("apidel")) { post("api_del", { provider: ap, label: al }); return; }
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
    else if (m.type === "api") { apiView = m; renderApi(); }
    else if (m.type === "api_test_result") {
      apiTestMap[apiKeyOf(m.provider, m.label)] = { ok: m.ok, text: m.text };
      renderApi();
    }
  });

  post("ready");
</script>
</body></html>`;
}
