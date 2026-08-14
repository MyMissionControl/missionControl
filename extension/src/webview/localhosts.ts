import * as vscode from "vscode";

import { scanLocalhostsEnriched, type EnrichedGroup } from "../commands/localhostScan";
import { setTabIcon } from "./tabIcon";
import {
  stopAllLocalhosts,
  stopGroupLocalhosts,
  stopPortLocalhost,
} from "../commands/localhostStop";

// Full editor-area panel that lists running localhost dev servers as grouped
// "channel strips" (Bento redesign). One _panel at a time; a ~5s poll keeps
// uptime, the RAM meter and newly started servers current. Detection + kill
// logic is reused from commands/localhostScan.ts + commands/localhostStop.ts.
//
// req/s is not observable here (no proxy / log tailing), so per the design we
// ship a RAM-only meter and the client builds the 60s series by accumulating
// the per-poll RAM sample — real data, never fabricated.

let _panel: vscode.WebviewPanel | undefined;
let _pollTimer: NodeJS.Timeout | undefined;

const POLL_MS = 5_000;

function pushGroups(panel: vscode.WebviewPanel): void {
  let groups: EnrichedGroup[] = [];
  try {
    groups = scanLocalhostsEnriched();
  } catch {
    groups = [];
  }
  void panel.webview.postMessage({ type: "localhosts", groups });
}

export function openLocalhostsPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.localhosts",
    "Localhosts",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  setTabIcon(panel);
  _panel = panel;

  panel.onDidDispose(() => {
    _panel = undefined;
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = undefined;
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready":
      case "fetch":
        pushGroups(panel);
        return;
      case "open":
        if (typeof msg.port === "number") {
          void vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${msg.port}`));
        }
        return;
      case "copy":
        if (typeof msg.port === "number") {
          void vscode.env.clipboard.writeText(`http://localhost:${msg.port}`);
        }
        return;
      case "stopPort":
        if (typeof msg.port === "number") {
          await stopPortLocalhost(msg.port);
          pushGroups(panel);
        }
        return;
      case "stopGroup":
        if (typeof msg.project === "string") {
          await stopGroupLocalhosts(msg.project);
          pushGroups(panel);
        }
        return;
      case "stopAll":
        await stopAllLocalhosts();
        pushGroups(panel);
        return;
    }
  });

  _pollTimer = setInterval(() => {
    if (_panel) pushGroups(_panel);
  }, POLL_MS);

  return panel;
}

// ── Webview shell ────────────────────────────────────────────────────────────
//
// IMPORTANT: the client <script> below lives inside this template literal. Keep
// it FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would corrupt the client script. The only regexes used (esc)
// contain no backslashes.

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
    --dot:rgba(255,255,255,.028);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad; --good:#2fa96a;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --dot:rgba(15,30,45,.035);
  }
  :root { --pad:20px; --gap:14px; --secgap:20px; --radius:14px; --fs:13.5px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace;
    --danger:#f4796b; }
  * { box-sizing: border-box; }
  body { font-family: var(--uifont); font-size: var(--fs); color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad); }
  .wrap { max-width: 960px; margin: 0 auto; }

  /* Header */
  .head { display: flex; align-items: flex-end; gap: 16px; margin-bottom: 20px; }
  .head .htext { flex: 1; }
  .eyebrow { font-family: var(--mono); font-size: 10.5px; letter-spacing: 3px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .title { font-size: 19px; font-weight: 700; margin-top: 7px; }
  .btn { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-radius: 8px;
    font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: var(--uifont); white-space: nowrap; }
  .btn svg { width: 13px; height: 13px; }
  .btn.sec { background: var(--card); border: 1px solid var(--border2); color: var(--muted); }
  .btn.sec:hover { border-color: var(--accent); color: var(--txt); }
  .btn.danger { background: rgba(244,121,107,.12); color: var(--danger); border: 1px solid rgba(244,121,107,.35); }
  .btn.danger:hover, .btn.danger.armed { background: rgba(244,121,107,.24); }

  /* Groups */
  .groups { display: flex; flex-direction: column; gap: var(--secgap); }
  .ghead { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; padding: 0 2px; }
  .ghead .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); box-shadow: 0 0 7px var(--good); flex-shrink: 0; }
  .ghead .gname { font-size: 13.5px; font-weight: 700; }
  .ghead .gpath { font-family: var(--mono); font-size: 10.5px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ghead .spacer { flex: 1; }
  .ghead .gcount { font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .ghead .gstop { font-family: var(--mono); font-size: 10px; color: var(--danger); cursor: pointer;
    border-bottom: 1px solid rgba(244,121,107,.4); background: none; border-top: 0; border-left: 0; border-right: 0; padding: 0 0 1px; }
  .ghead .gstop.armed { color: #fff; background: var(--danger); border-radius: 4px; padding: 1px 6px; border-bottom: 0; }

  .strips { display: flex; flex-direction: column; gap: 8px; }
  .strip { position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 16px 14px 20px;
    border-radius: 12px; background: var(--card); border: 1px solid var(--border); overflow: hidden; cursor: pointer; }
  .strip:hover { border-color: var(--kc, var(--accent)); }
  .strip .edge { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--kc, var(--accent)); }
  .strip .portb { width: 88px; flex: none; }
  .strip .portb .pk { font-family: var(--mono); font-size: 8.5px; letter-spacing: 1.3px; color: var(--faint); }
  .strip .portb .pn { font-family: var(--mono); font-size: 23px; font-weight: 600; line-height: 1.05; letter-spacing: -.5px; }
  .strip .procb { width: 176px; flex: none; min-width: 0; }
  .badge { display: inline-flex; align-items: center; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: .8px;
    padding: 2px 6px; border-radius: 5px; }
  .strip .procb .cmd { font-family: var(--mono); font-size: 11px; color: var(--txt); margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip .procb .cmd.none { color: var(--faint); }

  /* Meter */
  .meterb { flex: 1; min-width: 0; }
  .meterb .mrow { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 5px; }
  .meterb .mlab { font-family: var(--mono); font-size: 8.5px; letter-spacing: 1.3px; color: var(--faint); }
  .meterb .mval { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--kc, var(--accent)); }
  .led { display: flex; align-items: flex-end; gap: 2px; height: 26px; }
  .led .lg { flex: 1; border-radius: 1.5px; height: 4px; background: var(--border); }
  .meterb .mfoot { display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--mono); font-size: 9px; color: var(--faint); }

  /* Actions */
  .acts { flex: none; display: flex; gap: 6px; }
  .ico { width: 27px; height: 27px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px;
    background: transparent; border: 1px solid var(--border2); color: var(--muted); cursor: pointer; }
  .ico:hover { border-color: var(--accent); color: var(--txt); }
  .ico svg { width: 12px; height: 12px; }
  .ico.stop { color: var(--danger); border-color: rgba(244,121,107,.3); }
  .ico.stop:hover, .ico.stop.armed { background: rgba(244,121,107,.16); }
  .ico.ok { color: var(--good); border-color: rgba(94,207,143,.4); }

  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty .e1 { font-size: 15px; font-weight: 600; color: var(--txt); }
  .empty .e2 { font-size: 12.5px; margin-top: 8px; }
  .empty code { font-family: var(--mono); background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="htext">
      <div class="eyebrow">Local Servers</div>
      <div class="title" id="title">กำลังสแกน…</div>
    </div>
    <button class="btn sec" id="fetch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>Fetch</button>
    <button class="btn danger" id="stopAll" data-confirm="Confirm?">Stop all</button>
  </div>
  <div class="groups" id="groups"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  (function () { var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark"; })();

  var SEG_N = 22;              // LED segments per meter
  var MAX_SAMPLES = 22;        // rolling RAM samples kept per port (~ last 60s at 5s poll: ~12)
  var SERIES = {};             // "port|pid" -> [memMB, …]
  var STATE = { groups: [] };
  var KIND = {
    web:  { label: "WEB",  color: "#4f9cf9" },
    api:  { label: "API",  color: "#e8a33d" },
    db:   { label: "DB",   color: "#e879a8" },
    docs: { label: "DOCS", color: "#5ecf8f" }
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtMB(mb) {
    mb = mb || 0;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + "GB" : Math.round(mb) + "MB";
  }
  function kindColor(k) { return (KIND[k] && KIND[k].color) || "var(--accent)"; }

  // Accumulate the RAM series from each poll (real samples, not fabricated).
  function accumulate(groups) {
    var live = {};
    groups.forEach(function (g) {
      g.ports.forEach(function (p) {
        var key = p.port + "|" + p.pid;
        live[key] = true;
        var arr = SERIES[key] || [];
        arr.push(p.memMB || 0);
        if (arr.length > MAX_SAMPLES) arr = arr.slice(arr.length - MAX_SAMPLES);
        SERIES[key] = arr;
      });
    });
    // Drop series for ports/pids that are gone so a restarted server starts fresh.
    Object.keys(SERIES).forEach(function (k) { if (!live[k]) delete SERIES[k]; });
  }

  function ledHtml(key, color) {
    var arr = SERIES[key] || [];
    var max = 1;
    for (var i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    var lit = arr.length;
    var out = "";
    for (var s = 0; s < SEG_N; s++) {
      var idx = s - (SEG_N - lit); // rightmost segments hold the newest samples
      if (idx < 0) { out += '<span class="lg"></span>'; continue; }
      var h = 6 + Math.round((arr[idx] / max) * 18); // 6–24px
      var glow = idx >= lit - 4 ? ";box-shadow:0 0 6px " + color : "";
      out += '<span class="lg" style="height:' + h + "px;background:" + color + glow + '"></span>';
    }
    return out;
  }

  function stripHtml(p) {
    var key = p.port + "|" + p.pid;
    var col = kindColor(p.kind);
    var k = KIND[p.kind];
    var badge = k
      ? '<span class="badge" style="color:' + k.color + ";background:" + k.color + "22;border:1px solid " + k.color + '55">' + k.label + "</span>"
      : "";
    var cur = (SERIES[key] && SERIES[key].length) ? SERIES[key][SERIES[key].length - 1] : p.memMB;
    var cmd = p.cmd ? '<div class="cmd">' + esc(p.cmd) + "</div>" : '<div class="cmd none">unknown process</div>';
    return '<div class="strip" data-open="' + p.port + '" title="เปิด http://localhost:' + p.port + '" style="--kc:' + col + '">' +
      '<span class="edge"></span>' +
      '<div class="portb"><div class="pk">PORT</div><div class="pn">' + p.port + "</div></div>" +
      '<div class="procb">' + badge + cmd + "</div>" +
      '<div class="meterb">' +
        '<div class="mrow"><span class="mlab">RAM · 60s</span><span class="mval" style="color:' + col + '">' + fmtMB(cur) + "</span></div>" +
        '<div class="led">' + ledHtml(key, col) + "</div>" +
        '<div class="mfoot"><span>pid ' + p.pid + "</span><span>" + (p.uptime ? "&#8593; " + esc(p.uptime) : "") + "</span></div>" +
      "</div>" +
      '<div class="acts">' +
        '<button class="ico" data-copy="' + p.port + '" title="คัดลอก URL"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>' +
        '<button class="ico stop" data-stopport="' + p.port + '" title="หยุด (คลิกอีกครั้งเพื่อยืนยัน)"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>' +
      "</div></div>";
  }

  function render() {
    var groups = STATE.groups || [];
    var ports = groups.reduce(function (n, g) { return n + g.ports.length; }, 0);
    document.getElementById("title").textContent = ports + " ports · " + groups.length + " projects";

    var root = document.getElementById("groups");
    var sa = document.getElementById("stopAll");
    if (!ports) {
      sa.style.display = "none";
      root.innerHTML = '<div class="empty"><div class="e1">ไม่มี dev server ทำงานอยู่</div>' +
        '<div class="e2">เริ่มสักตัวในโปรเจกต์ (เช่น <code>pnpm dev</code> หรือ <code>uvicorn app:api</code>) แล้วกด Fetch</div></div>';
      return;
    }
    sa.style.display = "";
    root.innerHTML = groups.map(function (g) {
      var strips = g.ports.map(stripHtml).join("");
      return '<div class="group">' +
        '<div class="ghead"><span class="dot"></span>' +
        '<span class="gname">' + esc(g.project) + "</span>" +
        '<span class="gpath">' + esc(g.path) + "</span>" +
        '<span class="spacer"></span>' +
        '<span class="gcount">' + g.ports.length + " ports</span>" +
        '<button class="gstop" data-stopgroup="' + esc(g.project) + '" data-confirm="Confirm?">stop all</button>' +
        "</div>" +
        '<div class="strips">' + strips + "</div></div>";
    }).join("");
  }

  // Inline confirm: first click arms the button (2.6s window), second fires.
  function armOrFire(el, fire) {
    if (el.dataset.armed === "1") {
      clearTimeout(el._t); el.dataset.armed = "";
      if (el.dataset.orig != null) { el.textContent = el.dataset.orig; el.dataset.orig = ""; }
      el.classList.remove("armed");
      fire();
      return;
    }
    el.dataset.armed = "1";
    el.classList.add("armed");
    if (el.dataset.confirm) { el.dataset.orig = el.textContent; el.textContent = el.dataset.confirm; }
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.dataset.armed = "";
      el.classList.remove("armed");
      if (el.dataset.orig != null && el.dataset.orig !== "") { el.textContent = el.dataset.orig; el.dataset.orig = ""; }
    }, 2600);
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    var b = t.closest ? t.closest("[data-open],[data-copy],[data-stopport],[data-stopgroup],#stopAll,#fetch") : null;
    if (!b) return;
    if (b.id === "fetch") { vscode.postMessage({ type: "fetch" }); return; }
    if (b.hasAttribute("data-open")) { vscode.postMessage({ type: "open", port: Number(b.getAttribute("data-open")) }); return; }
    if (b.hasAttribute("data-copy")) {
      vscode.postMessage({ type: "copy", port: Number(b.getAttribute("data-copy")) });
      b.classList.add("ok"); setTimeout(function () { b.classList.remove("ok"); }, 1200);
      return;
    }
    if (b.hasAttribute("data-stopport")) { armOrFire(b, function () { vscode.postMessage({ type: "stopPort", port: Number(b.getAttribute("data-stopport")) }); }); return; }
    if (b.hasAttribute("data-stopgroup")) { armOrFire(b, function () { vscode.postMessage({ type: "stopGroup", project: b.getAttribute("data-stopgroup") }); }); return; }
    if (b.id === "stopAll") { armOrFire(b, function () { vscode.postMessage({ type: "stopAll" }); }); return; }
  });

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.type !== "localhosts") return;
    STATE.groups = m.groups || [];
    accumulate(STATE.groups);
    // Don't yank the DOM out from under an armed confirm — refresh on the next poll.
    if (!document.querySelector(".armed")) render();
  });

  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
