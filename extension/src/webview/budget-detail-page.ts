import * as vscode from "vscode";

import { type UsageSummary } from "../usage";
import { scanProjectUsage } from "../commands/projectUsageScan";

// Editor-area panel: ONE project's Claude usage — the "Project Usage" drill-down.
// Opened from a project row on the Budget page. The rich per-hour / per-session /
// per-model / per-skill detail is scanned ON DEMAND for THIS project only
// (commands/projectUsageScan.ts) so it never bloats the global usage cache. The
// client rolls the hourly series up into year → month → day → hour buckets, each
// bar stacked by token type; a side rail + models + sessions + skills fill the
// history the old single-bar/donut layout was missing.
//
// Singleton panel. _root/_name hold the currently-shown project so a reopen
// re-scans the right one. `summary` is accepted for call-site compatibility with
// budget.ts but no longer needed — the scan reads transcripts directly.
let _panel: vscode.WebviewPanel | undefined;
let _root = "";
let _name = "";

export function openBudgetDetailPanel(
  projectRoot: string,
  projectName: string,
  _summary?: UsageSummary,
): vscode.WebviewPanel {
  _root = projectRoot;
  _name = projectName;

  if (_panel) {
    _panel.title = projectName + " — Usage";
    _panel.reveal();
    postUsage(_panel);
    return _panel;
  }

  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.budget-detail",
    projectName + " — Usage",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  panel.webview.html = renderDetailShell();
  panel.webview.onDidReceiveMessage((msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "ready") postUsage(panel);
    else if (msg.type === "close") panel.dispose(); // Back → return to the Budget list
  });

  return panel;
}

/** Scan this project's transcripts and hand the client the full usage payload.
 *  The file list is resolved against the global usage cache first (async), then
 *  the transcripts are read and folded. */
function postUsage(panel: vscode.WebviewPanel): void {
  void (async () => {
    let u;
    try {
      u = await scanProjectUsage(_root);
    } catch {
      u = { hourly: {}, models: {}, sessions: [], skills: [] };
    }
    panel.webview.postMessage({ type: "usage", projectName: _name, hourly: u.hourly, models: u.models, sessions: u.sessions, skills: u.skills });
  })();
}

// NOTE: the client <script> below is written with string concatenation only —
// NO backticks and NO backslashes — so this outer template literal never has to
// escape anything. The only regexes used (esc) contain no backslashes.
function renderDetailShell(): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#11171d; --editor:#0f151b; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --dot:rgba(255,255,255,.028);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --dot:rgba(15,30,45,.035);
  }
  :root { --pad:20px; --gap:14px; --cardpad:15px; --radius:14px; --secgap:20px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  * { box-sizing: border-box; }
  body { font-family: var(--uifont); font-size: 13.5px; color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad); }
  .wrap { max-width: 1000px; margin: 0 auto; }

  .head { display: flex; align-items: flex-start; gap: 20px; margin-bottom: 16px; }
  .head .htext { flex: 1; min-width: 0; }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .pname { font-size: 27px; font-weight: 700; letter-spacing: -.4px; margin-top: 7px; }
  .crumbs { display: flex; align-items: center; gap: 8px; margin-top: 9px; font-family: var(--mono); font-size: 11.5px; flex-wrap: wrap; }
  .crumbs .cr { color: var(--muted); cursor: pointer; }
  .crumbs .cr:hover { color: var(--accent2); }
  .crumbs .cr.cur { color: var(--txt); cursor: default; }
  .crumbs .sep { color: var(--faint); }
  .crumbs .hint { color: var(--faint); font-size: 11px; }
  .backbtn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 8px;
    background: var(--card); border: 1px solid var(--border2); color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 600; font-family: var(--uifont); }
  .backbtn:hover { border-color: var(--accent); color: var(--txt); }
  .backbtn svg { width: 12px; height: 12px; }

  .shortcuts { display: flex; gap: 9px; margin-bottom: var(--secgap); }
  .sc { height: 30px; padding: 0 15px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--uifont);
    background: var(--card); border: 1px solid var(--border2); color: var(--muted); }
  .sc:hover { border-color: var(--accent); }
  .sc.active { color: var(--txt); background: var(--accentSoft); border-color: var(--accent); }
  #calBtn { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; }
  #calBtn svg { width: 13px; height: 13px; }
  .calpanel { padding: 16px 18px; margin-bottom: var(--secgap); }
  .caldates { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px 30px; margin-bottom: 4px; }
  .calrow { display: flex; align-items: center; gap: 8px; }
  .calrow .cllbl { width: 42px; flex: none; font-family: var(--mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--faint); }
  .csel { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border-radius: 8px; background: var(--card); border: 1px solid var(--border2); color: var(--txt); font-family: var(--mono); font-size: 11.5px; cursor: pointer; }
  .csel:focus { outline: none; border-color: var(--accent); }
  .csel.y { flex: 1.3; } .csel.m { flex: 1.1; } .csel.d { flex: 0.9; }
  .calfoot { display: flex; align-items: center; gap: 10px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .calfoot .cclr { margin-left: auto; height: 26px; padding: 0 11px; border-radius: 7px; background: var(--card); border: 1px solid var(--border2); color: var(--muted); cursor: pointer; font-size: 11px; font-family: var(--uifont); }
  .calfoot .cclr:hover { border-color: var(--accent); color: var(--txt); }

  .row2 { display: flex; gap: var(--gap); margin-bottom: var(--secgap); }
  .pc { padding: var(--cardpad); border-radius: var(--radius); background: var(--card); border: 1px solid var(--border); }
  .clabel { font-family: var(--mono); font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .chart { flex: 1; min-width: 0; }
  .ctitle { display: flex; align-items: center; gap: 10px; }
  .ctitle .ct { font-size: 13.5px; font-weight: 700; }
  .ctitle .cleg { margin-left: auto; display: flex; gap: 10px; font-family: var(--mono); font-size: 9.5px; color: var(--muted); }
  .ctitle .cleg i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }
  .plotwrap { display: flex; gap: 8px; margin-top: 14px; }
  .yaxis { display: flex; flex-direction: column; justify-content: space-between; height: 210px; font-family: var(--mono); font-size: 9.5px; color: var(--faint); text-align: right; }
  .plot { flex: 1; min-width: 0; display: flex; align-items: flex-end; gap: 4px; height: 210px; border-bottom: 1px solid var(--border2); border-left: 1px solid var(--border2); padding-left: 4px; }
  .col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
  .bar { display: flex; flex-direction: column-reverse; border-radius: 3px 3px 0 0; overflow: hidden; }
  .bar.clk { cursor: pointer; }
  .bar.clk:hover { opacity: .82; }
  .bar > span { display: block; }
  .xlabels { display: flex; gap: 4px; margin-top: 6px; padding-left: 4px; }
  .xlabels .xl { flex: 1; min-width: 0; text-align: center; font-family: var(--mono); font-size: 9px; color: var(--faint); overflow: hidden; }
  .cfoot { display: flex; align-items: center; gap: 16px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .cfoot .tot { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; color: var(--txt); }
  .cfoot .tot i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }

  .rail { width: 296px; flex: none; display: flex; flex-direction: column; gap: var(--gap); }
  .stack { display: flex; gap: 2px; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 12px; }
  .stack > span { display: block; height: 100%; }
  .legend { display: flex; flex-direction: column; gap: 7px; margin-top: 12px; }
  .lg { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
  .lg .sw { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .lg .lb { color: var(--muted); } .lg .fill { flex: 1; }
  .lg .vl { font-family: var(--mono); color: var(--txt); } .lg .pc2 { font-family: var(--mono); color: var(--faint); width: 40px; text-align: right; }
  .toprail { flex: 1; }
  .topcols { display: flex; font-family: var(--mono); font-size: 9px; letter-spacing: 1.2px; color: var(--faint); border-bottom: 1px solid var(--border2); padding-bottom: 6px; margin-top: 10px; }
  .topcols .a { flex: 1; } .topcols .b { }
  .topitem { margin-top: 10px; }
  .topitem .tl { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 11px; }
  .topitem .tl .tn { color: var(--txt); } .topitem .tl .tc { color: var(--muted); }
  .topitem .tbar { height: 5px; border-radius: 3px; background: var(--accent2); margin-top: 5px; }

  .row3 { display: flex; gap: var(--gap); }
  .models { width: 296px; flex: none; }
  .mblock { margin-top: 12px; }
  .mrow1 { display: flex; align-items: center; gap: 8px; }
  .mrow1 .dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .mrow1 .mid { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow1 .mc { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .mrow2 { display: flex; justify-content: space-between; margin-top: 3px; padding-left: 16px; font-size: 10.5px; color: var(--faint); }
  .mrow2 .mt { font-family: var(--mono); font-size: 10px; }

  .sesscard { flex: 1; min-width: 0; border-radius: 11px; background: var(--card); border: 1px solid var(--border); overflow: hidden; }
  .shead, .srow { display: flex; align-items: center; gap: 12px; }
  .shead { padding: 11px 15px; border-bottom: 1px solid var(--border2); font-family: var(--mono); font-size: 9.5px; letter-spacing: 1.2px; color: var(--faint); }
  .srow { padding: 10px 15px; border-top: 1px solid var(--border); }
  .srow:first-child { border-top: none; }
  .c-start { width: 110px; flex: none; font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .c-len { width: 60px; flex: none; font-family: var(--mono); font-size: 11.5px; }
  .c-model { width: 104px; flex: none; display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; }
  .c-model .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .c-branch { flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-cost { width: 70px; flex: none; text-align: right; font-family: var(--mono); font-size: 12.5px; font-weight: 600; }

  .skills { margin-top: var(--secgap); }
  .sk-head { display: flex; align-items: center; }
  .sk-head .rc { margin-left: auto; font-family: var(--mono); font-size: 9.5px; color: var(--faint); }
  .skblock { margin-top: 12px; }
  .skline { display: flex; align-items: center; gap: 10px; }
  .skline .sn { font-family: var(--mono); font-size: 12px; font-weight: 600; }
  .skline .sd { font-size: 11px; color: var(--faint); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skline .sr { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .skline .scst { font-family: var(--mono); font-size: 11.5px; font-weight: 600; width: 68px; text-align: right; }
  .skbar { height: 5px; border-radius: 3px; background: var(--accent2); margin-top: 6px; }
  .empty { color: var(--faint); font-size: 12px; padding: 30px 4px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="htext">
      <div class="eyebrow">Mission Control — Project Usage</div>
      <div class="pname" id="pname">—</div>
      <div class="crumbs" id="crumbs"></div>
    </div>
    <button class="backbtn" id="back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Back</button>
  </div>

  <div class="shortcuts" id="shortcuts">
    <button class="sc" data-sc="today">Today</button>
    <button class="sc" data-sc="week">This week</button>
    <button class="sc" data-sc="month">This month</button>
    <button class="sc" data-sc="year">This year</button>
    <button class="sc" id="calBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><span id="calBtnTxt">Custom range</span></button>
  </div>

  <div class="pc calpanel" id="calPanel" style="display:none">
    <div class="caldates">
      <div class="calrow"><span class="cllbl">Start</span><select class="csel y" id="sY"></select><select class="csel m" id="sM"></select><select class="csel d" id="sD"></select></div>
      <div class="calrow"><span class="cllbl">End</span><select class="csel y" id="eY"></select><select class="csel m" id="eM"></select><select class="csel d" id="eD"></select></div>
    </div>
    <div class="calfoot"><span id="calFoot"></span><button class="cclr" id="calClear">Clear</button></div>
  </div>

  <div class="row2">
    <div class="pc chart">
      <div class="ctitle"><span class="ct" id="ctitle">—</span><span class="cleg" id="cleg"></span></div>
      <div class="plotwrap"><div class="yaxis" id="yaxis"></div><div class="plot" id="plot"></div></div>
      <div class="xlabels" id="xlabels"></div>
      <div class="cfoot" id="cfoot"></div>
    </div>
    <div class="rail">
      <div class="pc"><div class="clabel">Token types</div><div class="stack" id="rail-stack"></div><div class="legend" id="rail-legend"></div></div>
      <div class="pc toprail"><div class="clabel" id="top-label">TOP</div><div id="top-list"></div></div>
    </div>
  </div>

  <div class="row3">
    <div class="pc models"><div class="clabel">Models used</div><div class="stack" id="mstack"></div><div id="mlist"></div></div>
    <div class="sesscard">
      <div class="shead"><span class="c-start">STARTED</span><span class="c-len">LENGTH</span><span class="c-model">MODEL</span><span class="c-branch">BRANCH</span><span class="c-cost">COST</span></div>
      <div id="sessions"></div>
    </div>
  </div>

  <div class="pc skills">
    <div class="sk-head"><span class="clabel">Skills fired</span><span class="rc">RUNS · COST</span></div>
    <div id="skills-list"></div>
  </div>
</div>

<script>
  var vscode = acquireVsCodeApi();
  (function () { var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark"; })();

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  var USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n) { return "$" + USD.format(n || 0); }
  var TOK = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function tokM(n) { return TOK.format(n || 0); }
  function p2(n) { return String(n).padStart(2, "0"); }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Token categories (fixed order + colors, matching the Budget tab).
  var CATS = [
    { key: "cacheRead", color: "#4f9cf9", label: "Cache read" },
    { key: "cacheWrite", color: "#e8a33d", label: "Cache write" },
    { key: "output", color: "#f4796b", label: "Output" },
    { key: "input", color: "#5ecf8f", label: "Input" }
  ];
  function emptyCats() { return { cacheRead: { tokens: 0, usd: 0 }, cacheWrite: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0 }, input: { tokens: 0, usd: 0 } }; }
  function addCats(dst, src) { CATS.forEach(function (c) { var s = src[c.key] || { tokens: 0, usd: 0 }; dst[c.key].tokens += s.tokens || 0; dst[c.key].usd += s.usd || 0; }); }

  var STATE = { scope: { level: "week" }, data: null, cal: { open: false, s: "", e: "" } };
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function shortD(s) { var p = String(s).split("-"); return (+p[2]) + " " + MONTHS[(+p[1]) - 1]; }
  // "20 Jul – 28 Jul" within one year, "1 Jan 2024 – 31 Dec 2026" when the years differ.
  function rangeLabel(from, to) {
    var fp = from.split("-"), tp = to.split("-"), diffY = fp[0] !== tp[0];
    function one(p) { return (+p[2]) + " " + MONTHS[(+p[1]) - 1] + (diffY ? " " + p[0] : ""); }
    return one(fp) + " – " + one(tp);
  }

  // Total cost of a candidate scope, straight from the hourly buckets.
  function costForScope(sc) {
    var now = new Date(), y = now.getFullYear();
    if (sc.level === "year") return sumPrefix(y + "-").cost;
    if (sc.level === "month") return sumPrefix(sc.month + "-").cost;
    if (sc.level === "day") return sumPrefix(sc.day + " ").cost;
    var t = 0; // week = the 8 days ending today
    for (var i = 7; i >= 0; i--) { var d = new Date(now); d.setDate(now.getDate() - i); t += sumPrefix(ymd(d) + " ").cost; }
    return t;
  }
  // Most recent local day that actually has spend (for projects idle in every current period).
  function mostRecentDay() {
    var h = STATE.data.hourly, best = "";
    for (var k in h) { if (h[k].cost > 0) { var day = k.slice(0, 10); if (day > best) best = day; } }
    return best;
  }
  // On entry, show the NARROWEST current period that has activity: today → week → month → year.
  // If the project was idle in all of them, jump to its most recent active day so the chart is never blank.
  function pickDefaultScope() {
    var now = new Date(), ym = now.getFullYear() + "-" + p2(now.getMonth() + 1);
    var order = [{ level: "day", day: ymd(now) }, { level: "week" }, { level: "month", month: ym }, { level: "year" }];
    for (var i = 0; i < order.length; i++) if (costForScope(order[i]) >= 0.005) return order[i];
    var md = mostRecentDay();
    return md ? { level: "day", day: md } : { level: "week" };
  }

  // Sum hourly buckets whose key starts with the prefix into one {cost,tokens,cats}.
  function sumPrefix(prefix) {
    var h = STATE.data.hourly, out = { cost: 0, tokens: 0, cats: emptyCats() };
    for (var k in h) { if (k.indexOf(prefix) === 0) { out.cost += h[k].cost; out.tokens += h[k].tokens; addCats(out.cats, h[k].cats); } }
    return out;
  }

  // Build the chart buckets + meta for the current scope.
  function aggregate() {
    var sc = STATE.scope, now = new Date(), y = now.getFullYear();
    var buckets = [], title = "", unit = "month";
    if (sc.level === "year") {
      title = "Monthly · " + y; unit = "month";
      for (var m = 1; m <= 12; m++) { var key = y + "-" + p2(m); var b = sumPrefix(key + "-"); buckets.push({ label: MONTHS[m - 1], cost: b.cost, cats: b.cats, drill: b.cost > 0 ? { level: "month", month: key } : null }); }
    } else if (sc.level === "month") {
      var parts = sc.month.split("-"), yy = +parts[0], mm = +parts[1];
      title = "Daily · " + MONTHS[mm - 1] + " " + yy; unit = "day";
      var dim = new Date(yy, mm, 0).getDate();
      for (var dd = 1; dd <= dim; dd++) { var dk = sc.month + "-" + p2(dd); var bd = sumPrefix(dk + " "); buckets.push({ label: String(dd), cost: bd.cost, cats: bd.cats, drill: bd.cost > 0 ? { level: "day", day: dk } : null }); }
    } else if (sc.level === "week") {
      unit = "day"; var days = [];
      for (var i = 7; i >= 0; i--) { var d = new Date(now); d.setDate(now.getDate() - i); days.push(d); }
      title = "Daily · " + days[0].getDate() + " – " + days[7].getDate() + " " + MONTHS[days[7].getMonth()] + " " + y;
      days.forEach(function (d) { var dk = ymd(d); var bw = sumPrefix(dk + " "); buckets.push({ label: d.getDate() + " " + MONTHS[d.getMonth()], cost: bw.cost, cats: bw.cats, drill: bw.cost > 0 ? { level: "day", day: dk } : null }); });
    } else if (sc.level === "range") {
      var fd = new Date(sc.from + "T00:00:00"), td = new Date(sc.to + "T00:00:00");
      if (fd > td) { var tmp = fd; fd = td; td = tmp; }
      var spanDays = Math.round((td - fd) / 86400000) + 1;
      if (spanDays <= 62) { // short range → one bar per day
        unit = "day"; title = "Daily · " + rangeLabel(ymd(fd), ymd(td));
        var cur = new Date(fd);
        while (cur <= td) {
          var dk = ymd(cur); var br = sumPrefix(dk + " ");
          buckets.push({ label: cur.getDate() + " " + MONTHS[cur.getMonth()], cost: br.cost, cats: br.cats, drill: br.cost > 0 ? { level: "day", day: dk } : null });
          cur.setDate(cur.getDate() + 1);
        }
      } else { // long / multi-year range → one bar per month (drill into the month for days)
        unit = "month"; title = "Monthly · " + rangeLabel(ymd(fd), ymd(td));
        var mcur = new Date(fd.getFullYear(), fd.getMonth(), 1);
        var mend = new Date(td.getFullYear(), td.getMonth(), 1), mg = 0;
        while (mcur <= mend && mg < 600) {
          var mk = mcur.getFullYear() + "-" + p2(mcur.getMonth() + 1); var bm = sumPrefix(mk + "-");
          buckets.push({ label: MONTHS[mcur.getMonth()] + " " + String(mcur.getFullYear()).slice(2), cost: bm.cost, cats: bm.cats, drill: bm.cost > 0 ? { level: "month", month: mk } : null });
          mcur.setMonth(mcur.getMonth() + 1); mg++;
        }
      }
    } else { // day
      unit = "hour"; var dp = sc.day.split("-");
      title = "Hourly · " + (+dp[2]) + " " + MONTHS[(+dp[1]) - 1] + " " + dp[0];
      for (var h = 0; h < 24; h++) { var hk = sc.day + " " + p2(h); var hb = STATE.data.hourly[hk]; buckets.push({ label: p2(h), cost: hb ? hb.cost : 0, cats: hb ? hb.cats : emptyCats(), drill: null }); }
    }
    return { title: title, unit: unit, buckets: buckets };
  }

  function crumbLabel(sc) {
    var now = new Date();
    var out = [{ set: { level: "year" }, txt: String(now.getFullYear()), cur: sc.level === "year" }];
    if (sc.level === "range") { out.push({ set: null, txt: rangeLabel(sc.from, sc.to), cur: true }); return out; }
    if (sc.level === "week") out.push({ set: { level: "week" }, txt: "This week", cur: true });
    if (sc.level === "month" || (sc.level === "day" && sc.month)) {
      var mk = sc.month || (sc.day ? sc.day.slice(0, 7) : "");
      var mm = +mk.split("-")[1];
      out.push({ set: { level: "month", month: mk }, txt: MONTHS[mm - 1], cur: sc.level === "month" });
    }
    if (sc.level === "day") { var dp = sc.day.split("-"); out.push({ set: null, txt: (+dp[2]) + " " + MONTHS[(+dp[1]) - 1], cur: true }); }
    return out;
  }
  function renderCrumbs() {
    var sc = STATE.scope, crumbs = crumbLabel(sc), deepest = sc.level === "day";
    var html = "";
    crumbs.forEach(function (c, i) {
      if (i) html += '<span class="sep">›</span>';
      html += '<span class="cr' + (c.cur ? " cur" : "") + '"' + (c.set && !c.cur ? ' data-crumb="' + i + '"' : "") + ">" + esc(c.txt) + "</span>";
    });
    html += '<span class="sep">·</span><span class="hint">' + (deepest ? "Deepest level — use the breadcrumb to go back" : "Click a bar to drill down") + "</span>";
    document.getElementById("crumbs").innerHTML = html;
    STATE._crumbs = crumbs;
  }

  function renderShortcuts() {
    var sc = STATE.scope, now = new Date();
    var active = sc.level === "year" ? "year" : sc.level === "week" ? "week"
      : (sc.level === "month" && sc.month === now.getFullYear() + "-" + p2(now.getMonth() + 1)) ? "month"
      : (sc.level === "day" && sc.day === ymd(now)) ? "today" : "";
    document.querySelectorAll("#shortcuts .sc").forEach(function (b) { b.classList[b.getAttribute("data-sc") === active ? "add" : "remove"]("active"); });
  }

  function renderChart(agg) {
    document.getElementById("ctitle").textContent = agg.title;
    document.getElementById("cleg").innerHTML = CATS.map(function (c) { return '<span><i style="background:' + c.color + '"></i>' + c.label + "</span>"; }).join("");
    var max = 0; agg.buckets.forEach(function (b) { if (b.cost > max) max = b.cost; });
    document.getElementById("yaxis").innerHTML = [1, .75, .5, .25, 0].map(function (f) { return "<span>" + money(max * f) + "</span>"; }).join("");
    var plotH = 210, n = agg.buckets.length;
    document.getElementById("plot").innerHTML = agg.buckets.map(function (b, i) {
      if (b.cost <= 0) return '<div class="col"></div>';
      var barPx = Math.max(2, Math.round(b.cost / max * plotH));
      var segs = CATS.map(function (c) {
        var u = (b.cats[c.key] || {}).usd || 0; if (u <= 0) return "";
        return '<span style="height:' + (u / b.cost * barPx) + 'px;background:' + c.color + '"></span>';
      }).join("");
      var tip = b.label + " · " + money(b.cost);
      return '<div class="col"><div class="bar' + (b.drill ? " clk" : "") + '" data-bar="' + i + '" title="' + esc(tip) + '" style="height:' + barPx + 'px">' + segs + "</div></div>";
    }).join("");
    // x labels: thin out per bucket count
    var every = n > 24 ? 5 : n > 12 ? 3 : 1;
    document.getElementById("xlabels").innerHTML = agg.buckets.map(function (b, i) {
      var show = (i % every === 0) || i === n - 1;
      return '<span class="xl">' + (show ? esc(b.label) : "") + "</span>";
    }).join("");
    var total = 0, active = 0, peak = 0;
    agg.buckets.forEach(function (b) { total += b.cost; if (b.cost > 0) active++; if (b.cost > peak) peak = b.cost; });
    document.getElementById("cfoot").innerHTML = '<span class="tot"><i></i>Total ' + money(total) + "</span><span>Active " + active + "/" + n + "</span><span>Peak " + money(peak) + "</span>";
    STATE._buckets = agg.buckets; STATE._unit = agg.unit;
  }

  function renderRail(agg) {
    var tot = emptyCats(), sum = 0;
    agg.buckets.forEach(function (b) { addCats(tot, b.cats); });
    CATS.forEach(function (c) { sum += tot[c.key].usd; });
    document.getElementById("rail-stack").innerHTML = sum > 0 ? CATS.map(function (c) { var w = tot[c.key].usd / sum * 100; return w > 0 ? '<span style="width:' + w + '%;background:' + c.color + '"></span>' : ""; }).join("") : '<span style="width:100%;background:var(--border)"></span>';
    document.getElementById("rail-legend").innerHTML = CATS.map(function (c) {
      var u = tot[c.key].usd, pct = sum > 0 ? Math.round(u / sum * 100) : 0;
      return '<div class="lg"><span class="sw" style="background:' + c.color + '"></span><span class="lb">' + c.label + '</span><span class="fill"></span><span class="vl">' + money(u) + '</span><span class="pc2">' + pct + '%</span></div>';
    }).join("");
    // TOP <unit>
    var unitWord = agg.unit === "month" ? "MONTHS" : agg.unit === "hour" ? "HOURS" : "DAYS";
    var colWord = agg.unit === "month" ? "MONTH" : agg.unit === "hour" ? "HOUR" : "DAY";
    document.getElementById("top-label").textContent = "TOP " + unitWord;
    var top = agg.buckets.filter(function (b) { return b.cost > 0; }).slice().sort(function (a, b) { return b.cost - a.cost; }).slice(0, 4);
    var maxTop = top.length ? top[0].cost : 1;
    var html = '<div class="topcols"><span class="a">' + colWord + '</span><span class="b">COST</span></div>';
    html += top.map(function (b, i) {
      var op = 1 - i * 0.18;
      return '<div class="topitem"><div class="tl"><span class="tn">' + esc(b.label) + '</span><span class="tc">' + money(b.cost) + '</span></div>' +
        '<div class="tbar" style="width:' + Math.max(6, b.cost / maxTop * 100) + '%;opacity:' + op + '"></div></div>';
    }).join("");
    document.getElementById("top-list").innerHTML = top.length ? html : '<div class="empty">No spend</div>';
  }

  function modelFamily(id) { id = (id || "").toLowerCase(); return id.indexOf("opus") >= 0 ? "opus" : id.indexOf("sonnet") >= 0 ? "sonnet" : id.indexOf("haiku") >= 0 ? "haiku" : "other"; }
  var MODELCOL = { opus: "#c9a0ff", sonnet: "#4f9cf9", haiku: "#5ecf8f", other: "#8a97a4" };
  var MODELROLE = { opus: "deep work", sonnet: "default", haiku: "cheap loops", other: "" };
  function shortModel(id) { return String(id || "").replace(/^claude-/, ""); }

  function renderModels() {
    var models = STATE.data.models || {}, ids = Object.keys(models);
    var totCost = 0, totTok = 0; ids.forEach(function (m) { totCost += models[m].cost; totTok += models[m].tokens; });
    ids.sort(function (a, b) { return models[b].cost - models[a].cost; });
    document.getElementById("mstack").innerHTML = totCost > 0 ? ids.map(function (m) { var w = models[m].cost / totCost * 100; return '<span style="width:' + w + '%;background:' + MODELCOL[modelFamily(m)] + '"></span>'; }).join("") : '<span style="width:100%;background:var(--border)"></span>';
    document.getElementById("mlist").innerHTML = ids.length ? ids.map(function (m) {
      var fam = modelFamily(m), col = MODELCOL[fam];
      var pct = totCost > 0 ? Math.round(models[m].cost / totCost * 100) : 0;
      return '<div class="mblock"><div class="mrow1"><span class="dot" style="background:' + col + '"></span><span class="mid">' + esc(shortModel(m)) + '</span><span class="mc">' + money(models[m].cost) + '</span></div>' +
        '<div class="mrow2"><span>' + esc(MODELROLE[fam]) + '</span><span class="mt">' + tokM(models[m].tokens) + ' · ' + pct + '%</span></div></div>';
    }).join("") : '<div class="empty">No model data</div>';
  }

  function fmtStart(ms) { var d = new Date(ms); return d.getDate() + " " + MONTHS[d.getMonth()] + " · " + p2(d.getHours()) + ":" + p2(d.getMinutes()); }
  function fmtLen(ms) { var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); if (h) return h + "h " + m + "m"; if (m) return m + "m"; return s + "s"; }
  function renderSessions() {
    var ss = (STATE.data.sessions || []).slice(0, 40);
    document.getElementById("sessions").innerHTML = ss.length ? ss.map(function (s) {
      var col = MODELCOL[modelFamily(s.model)];
      return '<div class="srow"><span class="c-start">' + esc(fmtStart(s.startMs)) + '</span><span class="c-len">' + esc(fmtLen(s.durationMs)) + '</span>' +
        '<span class="c-model"><span class="dot" style="background:' + col + '"></span>' + esc(shortModel(s.model)) + '</span>' +
        '<span class="c-branch">' + esc(s.branch || "—") + '</span><span class="c-cost">' + money(s.cost) + '</span></div>';
    }).join("") : '<div class="empty">No sessions</div>';
  }

  function renderSkills() {
    var sk = STATE.data.skills || [];
    var maxRuns = sk.length ? sk[0].runs : 1;
    document.getElementById("skills-list").innerHTML = sk.length ? sk.map(function (s) {
      var w = Math.max(6, s.runs / maxRuns * 100), op = Math.max(.4, s.runs / maxRuns);
      return '<div class="skblock"><div class="skline"><span class="sn">' + esc(s.name) + '</span><span class="sd"></span>' +
        '<span class="sr">' + s.runs + '×</span><span class="scst">' + money(s.cost) + '</span></div>' +
        '<div class="skbar" style="width:' + w + '%;opacity:' + op + '"></div></div>';
    }).join("") : '<div class="empty">No skills fired for this project</div>';
  }

  function render() {
    if (!STATE.data) return;
    document.getElementById("pname").textContent = STATE.data.projectName || "—";
    renderCrumbs();
    renderShortcuts();
    renderCal();
    var agg = aggregate();
    renderChart(agg);
    renderRail(agg);
    renderModels();
    renderSessions();
    renderSkills();
  }

  // ── events ──
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t.closest && t.closest("#back")) { post("close"); return; }
    if (t.closest && t.closest("#calBtn")) { STATE.cal.open ? (STATE.cal.open = false) : openCalendar(); renderCal(); return; }
    if (t.closest && t.closest("#calClear")) { clearCalSel(); setScopeShortcut("week"); return; }
    var sc = t.closest ? t.closest("#shortcuts .sc") : null;
    if (sc && sc.hasAttribute("data-sc")) { setScopeShortcut(sc.getAttribute("data-sc")); return; }
    var cr = t.closest ? t.closest(".cr[data-crumb]") : null;
    if (cr) { var i = +cr.getAttribute("data-crumb"); var c = STATE._crumbs && STATE._crumbs[i]; if (c && c.set) { STATE.scope = c.set; render(); } return; }
    var bar = t.closest ? t.closest(".bar.clk") : null;
    if (bar) { var b = STATE._buckets[+bar.getAttribute("data-bar")]; if (b && b.drill) { STATE.scope = b.drill; render(); } return; }
  });
  function setScopeShortcut(sc) {
    var now = new Date();
    if (sc === "today") STATE.scope = { level: "day", day: ymd(now) };
    else if (sc === "week") STATE.scope = { level: "week" };
    else if (sc === "month") STATE.scope = { level: "month", month: now.getFullYear() + "-" + p2(now.getMonth() + 1) };
    else STATE.scope = { level: "year" };
    clearCalSel();
    render();
  }
  function post(type) { vscode.postMessage({ type: type }); }

  // ── range picker: separate Year / Month / Day dropdowns for start and end ──
  function clearCalSel() { STATE.cal.s = ""; STATE.cal.e = ""; }
  function calParts(str) { if (!str) return { y: "", m: "", d: "" }; var p = str.split("-"); return { y: p[0], m: String(+p[1]), d: String(+p[2]) }; }
  function calJoin(y, m, d) { return (y && m && d) ? y + "-" + p2(+m) + "-" + p2(+d) : ""; }
  function dimOf(y, m) { return (y && m) ? new Date(+y, +m, 0).getDate() : 31; }
  // Years that appear in this project's data, current year always included, plus a 2-year floor.
  function yearsRange() {
    var now = new Date().getFullYear(), min = now, h = STATE.data ? STATE.data.hourly : {};
    for (var k in h) { var y = +k.slice(0, 4); if (y && y < min) min = y; }
    min = Math.min(min, now - 2);
    var out = []; for (var y2 = now; y2 >= min; y2--) out.push(y2);
    return out;
  }
  function optList(vals, sel, labels) {
    var o = '<option value="">—</option>';
    for (var i = 0; i < vals.length; i++) { var v = vals[i], lab = labels ? labels[i] : v; o += '<option value="' + v + '"' + (String(v) === String(sel) ? " selected" : "") + ">" + lab + "</option>"; }
    return o;
  }
  var MNUM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  function fillCal() {
    [["s", STATE.cal.s], ["e", STATE.cal.e]].forEach(function (pair) {
      var p = pair[0], parts = calParts(pair[1]);
      var dim = dimOf(parts.y, parts.m), dsel = (parts.d && +parts.d > dim) ? String(dim) : parts.d;
      var days = []; for (var d = 1; d <= dim; d++) days.push(d);
      document.getElementById(p + "Y").innerHTML = optList(yearsRange(), parts.y);
      document.getElementById(p + "M").innerHTML = optList(MNUM, parts.m, MONTHS);
      document.getElementById(p + "D").innerHTML = optList(days, dsel);
    });
  }
  function openCalendar() {
    var sc = STATE.scope;
    if (sc.level === "range") { STATE.cal.s = sc.from; STATE.cal.e = sc.to; }
    else if (sc.level === "day") { STATE.cal.s = sc.day; STATE.cal.e = sc.day; }
    else { var md = mostRecentDay(); STATE.cal.s = md || ""; STATE.cal.e = md || ""; }
    STATE.cal.open = true; renderCal();
  }
  // Read the six selects back, re-clamp day counts, and apply the range once both ends are complete.
  function onCalChange() {
    ["s", "e"].forEach(function (p) {
      STATE.cal[p] = calJoin(document.getElementById(p + "Y").value, document.getElementById(p + "M").value, document.getElementById(p + "D").value);
    });
    fillCal();
    var s = STATE.cal.s, e = STATE.cal.e;
    if (s && e) { var from = s, to = e; if (from > to) { from = e; to = s; } STATE.scope = { level: "range", from: from, to: to }; render(); }
    else { document.getElementById("calFoot").textContent = (s || e) ? ((s ? shortD(s) : "…") + " – " + (e ? shortD(e) : "…")) : "Pick a start and end date"; renderCal(); }
  }
  function renderCal() {
    var cal = STATE.cal, sc = STATE.scope;
    var txt = document.getElementById("calBtnTxt");
    if (txt) txt.textContent = sc.level === "range" ? rangeLabel(sc.from, sc.to) : "Custom range";
    var btn = document.getElementById("calBtn");
    if (btn) btn.classList[sc.level === "range" ? "add" : "remove"]("active");
    var panel = document.getElementById("calPanel");
    if (panel) panel.style.display = cal.open ? "block" : "none";
    if (!cal.open) return;
    fillCal();
    var s = cal.s, e = cal.e;
    document.getElementById("calFoot").textContent = (s || e) ? ((s ? shortD(s) : "…") + " – " + (e ? shortD(e) : "…")) : "Pick a start and end date";
  }
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("csel")) onCalChange();
  });

  window.addEventListener("message", function (ev) {
    var m = ev.data; if (!m || m.type !== "usage") return;
    STATE.data = m;
    STATE.cal.open = false; clearCalSel();
    STATE.scope = pickDefaultScope();
    render();
  });
  post("ready");
</script>
</body></html>`;
}
