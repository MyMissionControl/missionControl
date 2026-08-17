import * as vscode from "vscode";

import {
  configPath,
  listSettings,
  setSetting,
  type SettingEntry,
} from "../commands/settingsOps";
import { deriveEnabled, writeIntent } from "../commands/searchOps";
import { OracleOfflineError, patchConfig, setPrimary, startIndex, stopIndex } from "../commands/oracleVectorClient";
import { writeBackendIntent } from "../commands/vectorConfigFile";
import { pullModel } from "../commands/ollamaPull";
import {
  buildSearchStateEnriched,
  buildSearchStateFast,
  searchSectionBody,
  searchSectionScript,
  searchSectionStyle,
} from "./searchSection";
import { availableModels } from "../commands/teamsOps";
import { confirmIsolateMessage, setMode } from "../commands/oracleMemoryOps";
import { setTabIcon } from "./tabIcon";
import {
  buildOracleMemoryState,
  oracleMemorySectionBody,
  oracleMemorySectionScript,
  oracleMemorySectionStyle,
} from "./oracleMemorySection";

// Editor-area Settings page. Singleton panel + a display-ready postMessage + a
// small message switch — mirrors accounts.ts / teams.ts. All fs lives in
// settingsOps (node-only, tested); this file only bridges it to the webview and
// does the display grouping.
let _panel: vscode.WebviewPanel | undefined;

// Group render order — anything not listed falls to the end.
// ⛔ There is deliberately no "legacy" bucket any more: a knob that nothing reads
// is deleted from the schema and pruned out of config.json (settingsOps
// RETIRED_KEYS), not parked in a greyed-out section.
const GROUP_ORDER = ["Orchestration", "Build", "Teams", "Skills", "Other"];

function grouped(entries: SettingEntry[]): { group: string; fields: SettingEntry[] }[] {
  const byGroup = new Map<string, SettingEntry[]>();
  for (const e of entries) {
    const g = byGroup.get(e.group) ?? [];
    g.push(e);
    byGroup.set(e.group, g);
  }
  const order = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...byGroup.keys()]
    .sort((a, b) => order(a) - order(b))
    .map((group) => ({ group, fields: byGroup.get(group) as SettingEntry[] }));
}

// Model list for the "Default member model" dropdown, cached per window so
// repainting the page never re-fetches. availableModels() itself is memoised +
// disk-cached; this just avoids awaiting a promise we already resolved.
let _liveModels: string[] | undefined;

function pushList(panel: vscode.WebviewPanel): void {
  panel.webview.postMessage({
    type: "settings",
    groups: grouped(listSettings(_liveModels)),
    path: configPath(),
  });
}

/** Stale-while-revalidate, same shape as pushSearch: paint immediately from the
 *  pinned model subset (never blocks on the network), then re-push once the live
 *  `GET /v1/models` list is in — which is what stops this page's dropdown from
 *  disagreeing with the Team Config per-member picker. */
async function pushListEnriched(panel: vscode.WebviewPanel): Promise<void> {
  pushList(panel);
  try {
    const ids = await availableModels();
    if (!ids.length) return;
    const same =
      _liveModels?.length === ids.length && _liveModels.every((m, i) => m === ids[i]);
    if (same) return; // nothing new → don't churn the UI
    _liveModels = ids;
    pushList(panel);
  } catch {
    /* keep the pinned paint — availableModels already degrades on its own */
  }
}

async function pushSearch(panel: vscode.WebviewPanel): Promise<void> {
  // Stale-while-revalidate: paint the instant file-only view first (works
  // offline, never hangs on the :47778 timeout), then enrich from the server
  // if it happens to be up (real model status + live index progress).
  panel.webview.postMessage({ type: "searchState", state: buildSearchStateFast() });
  const enriched = await buildSearchStateEnriched();
  if (enriched) panel.webview.postMessage({ type: "searchState", state: enriched });
}

/** Oracle memory (shared vs isolated per oracle). Reads the ~/.claude CLI's
 *  --json status; null → the section renders "not installed" instead of an empty
 *  list that would read as "everything is shared". */
function pushOracleMemory(panel: vscode.WebviewPanel): void {
  panel.webview.postMessage({ type: "oracleMemoryState", state: buildOracleMemoryState() });
}

let _indexPoll: ReturnType<typeof setInterval> | undefined;
function pollSearchWhileIndexing(panel: vscode.WebviewPanel): void {
  if (_indexPoll) return;
  _indexPoll = setInterval(async () => {
    // Progress is live server state — use the enriched view. If the server
    // vanished mid-run, fall back to the file view and stop polling.
    const state = (await buildSearchStateEnriched()) ?? buildSearchStateFast();
    panel.webview.postMessage({ type: "searchState", state });
    if (state.index.status !== "indexing" && state.index.status !== "stopping") {
      clearInterval(_indexPoll);
      _indexPoll = undefined;
    }
  }, 1500);
}

export function openSettingsPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.settings",
    "Settings",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  setTabIcon(panel);
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
    if (_indexPoll) {
      clearInterval(_indexPoll);
      _indexPoll = undefined;
    }
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      // The config path is a chip you can click — the host owns the clipboard.
      case "copyPath":
        await vscode.env.clipboard.writeText(configPath());
        void panel.webview.postMessage({ type: "pathCopied" });
        return;

      case "ready":
      case "reload":
        void pushListEnriched(panel);
        void pushSearch(panel);
        pushOracleMemory(panel);
        return;

      case "oracleMemoryReload":
        pushOracleMemory(panel);
        return;

      case "oracleMemorySet": {
        if (typeof msg.vault !== "string") return;
        const isolate = msg.isolated === true;
        const state = buildOracleMemoryState();
        const row = state?.vaults.find((v) => v.vault === msg.vault);
        // Isolating writes the DB (relabels that vault's docs), so confirm it.
        // Going back to shared only drops the read filter — no prompt.
        if (isolate && row) {
          const go = await vscode.window.showWarningMessage(
            confirmIsolateMessage(row),
            { modal: true },
            "Isolate",
          );
          if (go !== "Isolate") {
            pushOracleMemory(panel);
            return;
          }
        }
        const res = setMode(msg.vault, isolate);
        if (!res.ok) {
          vscode.window.showErrorMessage(`Oracle memory: ${res.error ?? "failed"}`);
        } else {
          vscode.window.showInformationMessage(
            isolate
              ? `${msg.vault}: isolated — เปิด session ใหม่ของ oracle ตัวนี้เพื่อให้มีผล`
              : `${msg.vault}: shared again — มีผลกับ session ที่เปิดใหม่`,
          );
        }
        pushOracleMemory(panel);
        return;
      }

      case "set": {
        if (typeof msg.key !== "string") return;
        try {
          setSetting(msg.key, msg.value as string | number | boolean, _liveModels);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Settings: ${m}`);
        }
        pushList(panel); // always re-push so the UI reflects on-disk truth
        return;
      }

      case "reloadSearch":
        await pushSearch(panel);
        return;

      case "searchSet": {
        // Write vector-server.json directly first (offline-safe source of truth
        // the server reads on boot), then best-effort PATCH so a running server
        // applies it live. A down server is expected — swallow it; only surface
        // errors the server actually returned.
        try {
          if (msg.field === "hybrid" || msg.field === "mode") {
            const intent = writeIntent(
              msg.field === "hybrid"
                ? { hybridEnabled: msg.value === true }
                : { mode: msg.value === "graph" ? "graph" : "vector" },
            );
            const enabled = deriveEnabled(intent);
            writeBackendIntent({ enabled });
            await patchConfig({ enabled });
          } else if (msg.field === "model" && typeof msg.value === "string") {
            // Set the chosen model primary via the oracle's dedicated endpoint
            // (server-side withPrimary flips exactly one primary and preserves
            // every collection's model/adapter). A wholesale collections PATCH
            // would drop those fields on current arra.
            writeBackendIntent({ primaryModel: msg.value });
            await setPrimary(msg.value);
          }
        } catch (err) {
          if (!(err instanceof OracleOfflineError)) {
            const m = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Search: ${m}`);
          }
        }
        await pushSearch(panel);
        return;
      }

      case "indexStart": {
        const ok = await vscode.window.showWarningMessage(
          "เริ่ม index embeddings ตอนนี้? งานนี้กิน CPU หนักและใช้เวลาสักพัก (หยุดได้ด้วยปุ่ม Stop).",
          { modal: true },
          "Index now",
        );
        if (ok !== "Index now") return;
        try {
          await startIndex();
          pollSearchWhileIndexing(panel);
        } catch (err) {
          // Indexing is the one action that genuinely needs the server running.
          if (err instanceof OracleOfflineError) {
            vscode.window.showWarningMessage("เปิด oracle server (:47778) ก่อนถึงจะ index ได้");
          } else {
            const m = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Index: ${m}`);
          }
        }
        await pushSearch(panel);
        return;
      }

      case "indexStop": {
        try {
          await stopIndex();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Index: ${m}`);
        }
        await pushSearch(panel);
        return;
      }

      case "installModel": {
        if (typeof msg.model !== "string") return;
        const model = msg.model;
        const ok = await vscode.window.showWarningMessage(
          `ดาวน์โหลดโมเดล ${model} ผ่าน ollama? ไฟล์อาจใหญ่หลาย GB.`,
          { modal: true },
          "Install",
        );
        if (ok !== "Install") return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ollama pull ${model}`, cancellable: false },
          async (progress) => {
            const code = await pullModel(model, (line) => progress.report({ message: line }));
            if (code !== 0) vscode.window.showErrorMessage(`ollama pull ${model} ล้มเหลว (exit ${code})`);
          },
        );
        await pushSearch(panel);
        return;
      }

      case "chooseModelFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "ใช้ไฟล์นี้เป็น model",
          title: "เลือกไฟล์ model (เผื่อโหลดไว้แล้วแต่ระบบไม่รู้ path)",
        });
        if (picked && picked[0]) {
          try {
            writeIntent({ modelPath: picked[0].fsPath });
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Search: ${m}`);
          }
        }
        await pushSearch(panel);
        return;
      }
    }
  });

  return panel;
}

// NOTE: the inline <script> below lives inside this template literal. Keep it
// FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would silently corrupt the client script (a known foot-gun in
// this codebase, see accounts.ts). The regexes here contain no backslashes.
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
  /* Bento tokens — the same surface/accent language as the Projects and Skills
     pages, so Settings stops looking like a different app. */
  body {
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --pcard:#161f28; --pborder:rgba(255,255,255,.08); --ptxt:#e7eef5; --pmuted:#8a97a4; --pfaint:#5c6773;
    --pfield:rgba(255,255,255,.04); --good:#3fd39a;
    --pmono:'JetBrains Mono', var(--vscode-editor-font-family), ui-monospace, monospace;
    --pshadow: 0 10px 28px rgba(0,0,0,.45);
    color: var(--ptxt);
  }
  body.vscode-light, body.vscode-high-contrast-light {
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --pcard:#ffffff; --pborder:rgba(15,30,45,.12); --ptxt:#132029; --pmuted:#5a6b78; --pfaint:#94a1ad;
    --pfield:rgba(15,30,45,.03); --good:#2fa96a;
    --pshadow: 0 10px 24px rgba(15,30,45,.16);
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 21px; font-weight: 700; margin: 0 0 5px; letter-spacing: .2px; }
  .lead { font-size: 12px; color: var(--pmuted); margin-bottom: 10px; }
  /* The config path is a click-to-copy chip, like the Project Detail header. */
  .path { display: inline-block; font-size: 10.5px; font-family: var(--pmono); color: var(--pmuted);
    background: var(--pfield); border: 1px solid var(--pborder); border-radius: 8px; padding: 5px 10px;
    margin-bottom: 24px; cursor: pointer; }
  .path:hover { border-color: var(--accent); color: var(--ptxt); }
  .path.copied { color: var(--good); border-color: var(--good); }

  /* One card per group, rows divided by hairlines — fewer boxes than the old
     row-per-box layout, which read as a stack of unrelated tiles. */
  .grp { margin-bottom: 22px; }
  .grp h2 { font-family: var(--pmono); font-size: 10.5px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .16em; color: var(--pfaint); margin: 0 0 9px 2px; }
  .rows { display: flex; flex-direction: column;
    background: var(--pcard); border: 1px solid var(--pborder); border-radius: 12px; overflow: hidden; }
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 22px;
    padding: 12px 16px; border-top: 1px solid var(--pborder); transition: background .15s;
  }
  .row:first-child { border-top: none; }
  .row:hover { background: var(--accentSoft); }
  .ri { min-width: 0; }
  .rl { font-size: 13px; font-weight: 600; }
  .ra { flex-shrink: 0; display: flex; align-items: center; gap: 6px; }

  /* Explanations are not printed under every row any more — each one hides
     behind this badge, and only shows after a 2s hover (see the tooltip engine
     in the script). Any element carrying data-tip gets the same behaviour,
     including the ones the Search / Oracle sections render. */
  .hint {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; margin-left: 7px; vertical-align: middle;
    border: 1px solid var(--pborder); border-radius: 50%;
    background: var(--pfield); color: var(--pmuted);
    font-size: 9.5px; font-weight: 700; line-height: 1;
    cursor: help; user-select: none; transition: .15s;
  }
  .hint:hover { color: var(--accent2); border-color: var(--accent); background: var(--accentSoft); }
  #tip {
    position: fixed; left: 0; top: 0; z-index: 40; max-width: 320px;
    pointer-events: none; visibility: hidden; opacity: 0;
    background: var(--pcard); color: var(--ptxt);
    border: 1px solid var(--pborder); border-radius: 10px; box-shadow: var(--pshadow);
    padding: 9px 12px; font-size: 11.5px; line-height: 1.65;
    transition: opacity .12s ease;
  }
  #tip.on { visibility: visible; opacity: 1; }
  select, input[type=text], input[type=number] {
    background: var(--pfield); color: var(--ptxt);
    border: 1px solid var(--pborder); border-radius: 9px;
    padding: 7px 10px; font-size: 12px; font-family: inherit; min-width: 160px;
    outline: none; transition: border-color .15s, box-shadow .15s;
  }
  select:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accentSoft); }
  .empty { color: var(--pfaint); font-size: 12.5px; padding: 12px 4px; }
  .note {
    margin-top: 18px; font-size: 11.5px; line-height: 1.7; color: var(--pmuted);
    background: var(--pfield); border: 1px solid var(--pborder); border-radius: 12px; padding: 14px 16px;
  }
  .note b { color: var(--ptxt); font-weight: 600; }
  ${searchSectionStyle()}
  ${oracleMemorySectionStyle()}
</style>
</head>
<body>
<div class="wrap">
  <h1>Settings</h1>
  <div class="lead">ปรับค่าต่างๆ ของ Mission Control — บันทึกทันทีเมื่อเปลี่ยนค่า</div>
  <div class="path" id="path" title="คลิกเพื่อคัดลอก path"></div>
  <div id="groups"></div>
  ${searchSectionBody()}
  ${oracleMemorySectionBody()}
  <div class="note">
    <b>เก็บที่ไหน:</b> ทุกค่าเขียนลงไฟล์ <b id="path2"></b> ตรงๆ (local เครื่องนี้เท่านั้น ไม่ push git) · เปลี่ยนแล้วมีผลกับงานที่ <b>เริ่มใหม่</b> หลังจากนี้<br />
    <b>ทุกค่าในหน้านี้มีตัวอ่านจริง:</b> ค่าที่ไม่มีใครอ่านถูกถอดออกและลบคีย์ทิ้งจากไฟล์แล้ว — ส่วนนั้นใช้ค่า default ในโค้ดตรงๆ
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

  // ---- hover tips -------------------------------------------------------
  // One floating card, shared by every [data-tip] on the page (rows rendered
  // here AND the ones the Search / Oracle scripts render — the listeners are on
  // document, so nothing has to register). Nothing shows until the pointer has
  // rested on a badge for TIP_DELAY, then the card trails the pointer until it
  // leaves. It is pointer-events:none, so it can never steal the hover.
  const TIP_DELAY = 2000;
  let tipEl = null, tipTimer = null, tipHost = null, tipX = 0, tipY = 0;

  function hint(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return "";
    return '<span class="hint" data-tip="' + esc(s) + '" aria-label="' + esc(s) + '">?</span>';
  }
  function tipNode() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "tip";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function tipShown() { return !!tipEl && tipEl.classList.contains("on"); }
  function placeTip(x, y) {
    const el = tipNode();
    let left = x + 14, top = y + 18;
    // Flip to the other side of the pointer rather than letting the card hang
    // off the window edge.
    if (left + el.offsetWidth > window.innerWidth - 8) left = x - el.offsetWidth - 14;
    if (top + el.offsetHeight > window.innerHeight - 8) top = y - el.offsetHeight - 14;
    el.style.left = Math.max(8, left) + "px";
    el.style.top = Math.max(8, top) + "px";
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    tipHost = null;
    if (tipEl) tipEl.classList.remove("on");
  }
  document.addEventListener("mouseover", function (e) {
    const t = e.target;
    const host = t && t.closest ? t.closest("[data-tip]") : null;
    if (!host) { if (tipHost) hideTip(); return; }
    if (host === tipHost) return;
    hideTip();
    tipHost = host;
    tipX = e.clientX; tipY = e.clientY;
    tipTimer = setTimeout(function () {
      tipTimer = null;
      // A re-render can swap the row out from under a pending timer.
      if (tipHost !== host || host.isConnected === false) return;
      const el = tipNode();
      el.textContent = host.getAttribute("data-tip") || "";
      el.classList.add("on");
      placeTip(tipX, tipY);
    }, TIP_DELAY);
  });
  document.addEventListener("mousemove", function (e) {
    if (!tipHost) return;
    tipX = e.clientX; tipY = e.clientY;
    if (tipShown()) placeTip(tipX, tipY);
  });
  document.addEventListener("mouseout", function (e) {
    if (!tipHost) return;
    const to = e.relatedTarget;
    if (to && tipHost.contains && tipHost.contains(to)) return;
    hideTip();
  });

  function fieldControl(f) {
    const key = esc(f.key);
    if (f.type === "boolean") {
      const on = f.value === true || f.value === "true";
      // Sliding on/off switch — same look as the Search / Oracle section's
      // .so-switch (CSS injected via searchSectionStyle). data-act="bool" stays
      // so the existing click handler flips it.
      return '<div class="so-switch' + (on ? " on" : "") + '" role="switch" aria-checked="' +
        (on ? "true" : "false") + '" data-act="bool" data-key="' + key +
        '" data-next="' + (on ? "false" : "true") + '"><div class="kn"></div></div>';
    }
    if (f.type === "select") {
      const opts = (f.options || []).map(function (o) {
        const sel = String(o.value) === String(f.value) ? " selected" : "";
        return '<option value="' + esc(o.value) + '"' + sel + ">" + esc(o.label) + "</option>";
      }).join("");
      return '<select data-act="select" data-key="' + key + '">' + opts + "</select>";
    }
    // number + string → text input committed on Enter / blur
    return '<input type="text" data-act="text" data-key="' + key + '" value="' + esc(f.value) + '" />';
  }

  function render(v) {
    document.getElementById("path").textContent = v.path || "";
    document.getElementById("path2").textContent = v.path || "";
    const root = document.getElementById("groups");
    const groups = v.groups || [];
    if (!groups.length) {
      root.innerHTML = '<div class="empty">ยังไม่มีค่าตั้งค่า</div>';
      return;
    }
    let html = "";
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      html += '<section class="grp"><h2>' + esc(g.group) + '</h2><div class="rows">';
      const fields = g.fields || [];
      for (let j = 0; j < fields.length; j++) {
        const f = fields[j];
        html +=
          '<div class="row"><div class="ri">' +
            '<div class="rl">' + esc(f.label) + hint(f.help) + "</div>" +
          '</div><div class="ra">' + fieldControl(f) + "</div></div>";
      }
      html += "</div></section>";
    }
    root.innerHTML = html;
  }

  document.addEventListener("click", function (e) {
    hideTip(); // a click means the user is done reading
    const t = e.target;
    if (!t || !t.closest) return;
    // Walk up so a click on the switch knob (.kn) still hits the switch.
    const sw = t.closest('[data-act="bool"]');
    if (sw) {
      post("set", { key: sw.getAttribute("data-key"), value: sw.getAttribute("data-next") === "true" });
      return;
    }
    if (t.closest("#path")) { post("copyPath"); }
  });
  document.addEventListener("change", function (e) {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute("data-act") === "select") {
      post("set", { key: t.getAttribute("data-key"), value: t.value });
    }
  });
  document.addEventListener("keydown", function (e) {
    const t = e.target;
    if (!t || !t.getAttribute || t.getAttribute("data-act") !== "text") return;
    if (e.key === "Enter") { t.blur(); }
  });
  document.addEventListener("blur", function (e) {
    const t = e.target;
    if (!t || !t.getAttribute || t.getAttribute("data-act") !== "text") return;
    post("set", { key: t.getAttribute("data-key"), value: t.value });
  }, true);

  window.addEventListener("message", function (ev) {
    const m = ev.data;
    if (m && m.type === "settings") { render(m); }
    else if (m && m.type === "pathCopied") {
      const p = document.getElementById("path");
      p.classList.add("copied");
      setTimeout(function () { p.classList.remove("copied"); }, 1200);
    }
  });

  post("ready");
  window.__mcVscode = vscode;
</script>
</div>
<script>
  ${searchSectionScript()}
</script>
<script>
  ${oracleMemorySectionScript()}
</script>
</body></html>`;
}
