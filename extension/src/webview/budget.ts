import * as os from "node:os";

import * as vscode from "vscode";

import { type ProjectDetail, buildDetail } from "../budget-detail";
import { openBudgetDetailPanel } from "./budget-detail-page";
import {
  type ProjectAgg,
  type ProjectPeriods,
  type UsageSummary,
  collapseProjectDayDetail,
  computeUsage,
  getInstantUsage,
  getProjectLedger,
  groupByProjectRoot,
  localMonthKey,
  localTodayKey,
  projectPeriods,
  refreshUsage,
  sumByPrefix,
  unwiredProviders,
} from "../usage";

// Editor-area panel for real Claude Code spend, computed locally from
// ~/.claude/projects transcripts (no backend). Replaces the old native
// showInformationMessage modal — themed webview so it matches the
// Accounts/Teams panels. Singleton _panel mirrors accounts.ts; the client
// script stays dumb (host sends display-ready strings).
let _panel: vscode.WebviewPanel | undefined;

// One formatted-money helper (thousands separators + 2dp). Kept as the single
// format point so the hero + the matching stat card read identically to the cent.
const fmt = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// resolveProject / groupByProjectRoot (cwd -> project root/name grouping) live in
// usage.ts so the detail page reuses the exact same grouping — imported above.

export interface BudgetView {
  monthFmt: string;
  todayFmt: string;
  last7Fmt: string;
  allTimeFmt: string;
  daily14: number[]; // raw daily spend, oldest→newest (index 13 = today) for the 14-day chart
  projects: ProjectRow[]; // every project under projects/ — client sorts + pages
  monthStartMs: number; // local start-of-month (ms) — client's "this month" filter
  providerNote: string; // reminder when a provider on disk isn't summed in yet ("" = none)
  sessions: number;
}

export interface ProjectRow {
  name: string;
  path: string;
  costFmt: string;
  cost: number; // numeric $ — for the bar + QuickPick top-5
  tokens: number; // total tokens — client sorts by "token ที่ใช้"
  lastMs: number; // last activity (ms) — client sorts by recency + month filter
  detail: ProjectDetail; // per-category token/$ split — powers the click-to-open pie popup
  live: boolean; // false = folder/transcripts gone now; numbers come from the durable ledger
  periods?: ProjectPeriods; // today/week/month/all cost+token+4-cat split (attached by attachPeriods)
}

/** Build the full display view from a usage snapshot `u`: this-month / today /
 *  7-day / all-time USD and the projects — all pre-formatted. Reads the durable
 *  project ledger (a small cached file, not a rescan) so projects whose folder
 *  was since deleted locally still show their last-known spend instead of
 *  silently disappearing. */
export async function buildBudgetView(u: UsageSummary): Promise<BudgetView> {
  const month = sumByPrefix(u, localMonthKey());
  const today = sumByPrefix(u, localTodayKey());

  // Last 7 local days (inclusive of today): from local midnight 6 days ago.
  let last7 = 0;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  for (const day of Object.keys(u.byDay)) {
    const t = new Date(day + "T00:00:00"); // no "Z" -> local midnight
    if (!Number.isNaN(t.getTime()) && t.getTime() >= cutoff.getTime()) {
      last7 += u.byDay[day].cost;
    }
  }

  // 14-day daily spend series (raw, oldest→newest; index 13 = today) for the chart.
  const ymd = (d: Date) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const dayBase = new Date();
  dayBase.setHours(0, 0, 0, 0);
  const daily14: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(dayBase);
    d.setDate(dayBase.getDate() - i);
    daily14.push(u.byDay[ymd(d)]?.cost ?? 0);
  }

  const home = os.homedir();

  // Live grouping: every recorded cwd collapsed onto its project under
  // projects/ (cwds not under a projects/ folder — oracles, tools, home — are
  // skipped). Then fold in any ledger-only root NOT seen in this live scan —
  // a project whose folder (or transcripts) are gone locally now, but whose
  // last-known totals are still worth showing.
  const byKey = new Map<string, ProjectAgg & { live: boolean }>();
  for (const [root, agg] of Object.entries(groupByProjectRoot(u))) {
    byKey.set(root, { ...agg, live: true });
  }
  const ledger = await getProjectLedger();
  for (const [root, entry] of Object.entries(ledger)) {
    if (byKey.has(root)) continue; // live data is at least as fresh — keep it
    byKey.set(root, {
      name: entry.name, cost: entry.cost, tokens: entry.tokens, lastMs: entry.lastMs,
      det: entry.detail, live: false,
    });
  }
  const projects: ProjectRow[] = [...byKey.entries()]
    .map(([key, b]) => ({
      name: b.name,
      path: key.startsWith(home) ? "~" + key.slice(home.length) : key,
      costFmt: fmt(b.cost),
      cost: b.cost,
      tokens: b.tokens,
      lastMs: b.lastMs,
      detail: buildDetail(b.det),
      live: b.live,
    }))
    .sort((a, b) => b.lastMs - a.lastMs); // default order; client re-sorts

  // Local start-of-month for the client's "this month" filter.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Reminder: a provider CLI is present on disk but its spend isn't wired into
  // this total yet (e.g. the user just added Gemini). Nudge them to include it.
  const unwired = unwiredProviders();
  const providerNote = unwired.length
    ? "พบ " + unwired.join(", ") + " บนเครื่อง — ยอดนี้ยังนับเฉพาะ Claude Code (ยังไม่รวม provider เหล่านี้)"
    : "";

  return {
    monthFmt: fmt(month),
    todayFmt: fmt(today),
    last7Fmt: fmt(last7),
    allTimeFmt: fmt(u.total.cost),
    daily14,
    projects,
    monthStartMs: monthStart.getTime(),
    providerNote,
    sessions: u.fileCount,
  };
}

/** Attach each project's today / week / month / all breakdown so the Budget
 *  page's period filter can re-scope spend + the pie without another host round-
 *  trip. Live projects get real day-scoped numbers; a ledger-only project (folder
 *  gone) has no day series → its scoped periods are 0 and only "all" (from its
 *  all-time row cost, applied client-side) shows a total. */
function attachPeriods(u: UsageSummary, view: BudgetView): void {
  const home = os.homedir();
  const ymd = (d: Date) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  const todayKey = localTodayKey();
  const weekStartKey = ymd(weekStart);
  const monthPrefix = localMonthKey();
  for (const p of view.projects) {
    const absRoot = p.path.startsWith("~") ? home + p.path.slice(1) : p.path;
    p.periods = projectPeriods(collapseProjectDayDetail(u, absRoot), todayKey, weekStartKey, monthPrefix);
  }
}

async function postView(panel: vscode.WebviewPanel, u: UsageSummary): Promise<void> {
  const view = await buildBudgetView(u);
  attachPeriods(u, view);
  panel.webview.postMessage({ type: "budget", ...view });
}

/** Paint instantly from the cached snapshot, then repaint when a fresh scan
 *  lands (stale-while-revalidate) — the panel never blocks on the ~5s cold
 *  parse. Only the very first run (no snapshot at all) awaits one scan. */
function pushInstant(panel: vscode.WebviewPanel): void {
  void (async () => {
    const cached = await getInstantUsage();
    if (cached) {
      void postView(panel, cached).catch(() => {});
      void refreshUsage()
        .then((fresh) => postView(panel, fresh))
        .catch(() => {});
    } else {
      void postView(panel, await computeUsage()).catch(() => {});
    }
  })();
}

/** Explicit refresh button — recompute from disk, then repaint. */
function pushFresh(panel: vscode.WebviewPanel): void {
  void refreshUsage()
    .then((u) => postView(panel, u))
    .catch(() => {});
}

export function openBudgetPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    pushInstant(_panel);
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.budget",
    "Budget",
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

    switch (msg.type) {
      case "ready": // initial open — instant cached paint + background refresh
        pushInstant(panel);
        return;
      case "reload": // explicit ⟳ refresh button — recompute from disk
        pushFresh(panel);
        return;

      case "openProjectDetail": {
        const { projectPath, projectName } = msg;
        if (typeof projectPath !== "string" || typeof projectName !== "string") return;
        // projectPath is the display path ("~/…") — expand ~ back to an absolute
        // root so collapseProjectHours can match it against the cwd keys.
        const absRoot = projectPath.startsWith("~")
          ? os.homedir() + projectPath.slice(1)
          : projectPath;
        const current = (await getInstantUsage()) ?? (await computeUsage());
        openBudgetDetailPanel(absRoot, projectName, current);
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
function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
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
  :root { --pad:20px; --gap:14px; --cardpad:15px; --radius:14px; --secgap:20px; --fs:13.5px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  * { box-sizing: border-box; }
  body { font-family: var(--uifont); font-size: var(--fs); color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad); }
  .wrap { max-width: 1000px; margin: 0 auto; }

  /* Header */
  .head { display: flex; align-items: flex-start; gap: 20px; margin-bottom: var(--secgap); }
  .head .htext { flex: 1; min-width: 0; }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .hero { display: flex; align-items: baseline; gap: 3px; margin-top: 8px; font-family: var(--mono); }
  .hero .cur { font-size: 26px; font-weight: 600; color: var(--muted); }
  .hero .amt { font-size: 46px; font-weight: 600; letter-spacing: -1.5px; line-height: 1; color: var(--txt); }
  .hero .dec { color: var(--muted); }
  .hero-sub { font-size: 12.5px; color: var(--muted); margin-top: 8px; }
  .hright { flex: none; display: flex; align-items: center; gap: 10px; }
  .seg { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--card); border: 1px solid var(--border2); }
  .seg .s { height: 26px; padding: 0 12px; display: inline-flex; align-items: center; border-radius: 6px;
    font-size: 11.5px; font-weight: 600; color: var(--faint); background: transparent; cursor: pointer; font-family: var(--uifont); white-space: nowrap; }
  .seg .s.active { color: var(--txt); background: var(--accentSoft); box-shadow: inset 0 0 0 1px var(--accent); }
  .refresh { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 8px;
    background: var(--card); border: 1px solid var(--border2); color: var(--txt); font-size: 12.5px; font-weight: 600; cursor: pointer; font-family: var(--uifont); }
  .refresh:hover { border-color: var(--accent); }
  .refresh svg { width: 13px; height: 13px; }
  .refresh[disabled] { opacity: .5; cursor: default; }

  /* Stat cards */
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--gap); margin-bottom: var(--secgap); }
  .tile { padding: var(--cardpad); border-radius: var(--radius); background: var(--card); border: 1px solid var(--border); }
  .tile.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .tile .k { font-size: 11.5px; color: var(--muted); }
  .tile .v { font-family: var(--mono); font-size: 20px; font-weight: 600; margin-top: 6px; }
  @media (max-width: 720px) { .tiles { grid-template-columns: repeat(2, 1fr); } }

  /* Two-up row */
  .twoup { display: flex; gap: var(--gap); margin-bottom: var(--secgap); }
  .panelcard { padding: var(--cardpad); border-radius: var(--radius); background: var(--card); border: 1px solid var(--border); }
  .clabel { font-family: var(--mono); font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .daily { flex: 1; min-width: 0; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 56px; margin-top: 12px; }
  .bars .b { flex: 1; background: var(--accent); opacity: .75; border-radius: 2px 2px 0 0; min-height: 2px; }
  .bars .b.today { background: var(--accent2); opacity: 1; box-shadow: 0 0 8px var(--accent2); }
  .daily .cap { font-family: var(--mono); font-size: 9.5px; color: var(--faint); margin-top: 8px; }
  .toks { width: 340px; flex: none; }
  .stack { display: flex; gap: 2px; height: 12px; border-radius: 6px; overflow: hidden; margin-top: 12px; }
  .stack > span { display: block; height: 100%; }
  .legend { display: flex; flex-direction: column; gap: 7px; margin-top: 12px; }
  .lg { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
  .lg .sw { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .lg .lb { color: var(--muted); }
  .lg .fill { flex: 1; }
  .lg .vl { font-family: var(--mono); color: var(--txt); }
  .lg .pc { font-family: var(--mono); color: var(--faint); width: 34px; text-align: right; }

  /* Table */
  .secbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .section-k { font-family: var(--mono); font-size: 10.5px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; color: var(--faint); }
  .secbar .rng { font-family: var(--mono); font-size: 9.5px; color: var(--faint); }
  .secbar .hair { flex: 1; height: 1px; background: var(--border); }
  .secbar .hint { font-size: 10px; color: var(--faint); }
  .pager { display: flex; align-items: center; gap: 7px; }
  .pager .pg { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px;
    background: var(--card); border: 1px solid var(--border2); color: var(--txt); cursor: pointer; }
  .pager .pg svg { width: 13px; height: 13px; }
  .pager .pg:hover:not([disabled]) { border-color: var(--accent); }
  .pager .pg[disabled] { color: var(--faint); opacity: .4; cursor: default; }
  .pager .pi { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 34px; text-align: center; }

  .tbl { border-radius: 11px; background: var(--card); border: 1px solid var(--border); overflow: hidden; }
  .thead { display: flex; align-items: center; gap: 14px; padding: 9px 15px; border-bottom: 1px solid var(--border2);
    font-family: var(--mono); font-size: 9.5px; letter-spacing: 1.2px; font-weight: 600; color: var(--faint); }
  .thead .th-rank { width: 14px; text-align: right; flex: none; }
  .thead .th-name { width: 230px; flex: none; }
  .thead .th-mix { flex: 1; min-width: 0; }
  .thead .th-tok { width: 74px; text-align: right; flex: none; }
  .thead .th-cost { width: 76px; text-align: right; flex: none; }
  .thead .sortable { cursor: pointer; }
  .thead .sortable:hover { color: var(--txt); }
  .thead .active-sort { color: var(--accent2); }
  .thead .arrow { margin-left: 3px; }

  .prow { position: relative; display: flex; align-items: center; gap: 14px; padding: 13px 15px; cursor: pointer; border-top: 1px solid var(--border); }
  .prow:first-child { border-top: none; }
  .prow:hover { background: var(--accentSoft); }
  .prow .rank { width: 14px; text-align: right; flex: none; font-family: var(--mono); font-size: 11px; color: var(--faint); }
  .prow .pname { width: 230px; flex: none; font-family: var(--mono); font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prow .mixcol { flex: 1; min-width: 0; }
  .prow .mix { display: flex; gap: 1px; height: 16px; border-radius: 5px; overflow: hidden; }
  .prow .mix > span { display: block; height: 100%; }
  .prow .tok { width: 74px; text-align: right; flex: none; font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .prow .cost { width: 76px; text-align: right; flex: none; font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .prow.removed { opacity: .72; }
  .empty { color: var(--faint); font-size: 13px; padding: 26px 15px; }
  .notice { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; font-size: 12px; line-height: 1.5;
    border: 1px solid var(--border2); background: var(--card); color: var(--muted); }

  /* Dwell popover (donut) */
  #dwell { position: fixed; z-index: 30; pointer-events: none; display: none; width: 392px;
    padding: 16px 18px; border-radius: 13px; background: var(--panel); border: 1px solid var(--border2); box-shadow: 0 18px 44px rgba(0,0,0,.45); }
  #dwell .d-body { display: flex; align-items: center; gap: 18px; }
  #dwell .donutwrap { position: relative; width: 104px; height: 104px; flex-shrink: 0; }
  #dwell .donut { width: 104px; height: 104px; display: block; }
  #dwell .dcenter { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
  #dwell .dcenter .dv { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--txt); line-height: 1.05; max-width: 48px; text-align: center; overflow: hidden; text-overflow: ellipsis; }
  #dwell .dcenter .du { font-family: var(--mono); font-size: 7.5px; letter-spacing: .5px; color: var(--faint); margin-top: 1px; }
  #dwell .d-right { flex: 1; min-width: 0; }
  #dwell .d-name { font-family: var(--mono); font-size: 11.5px; font-weight: 600; margin-bottom: 10px; }
  #dwell .lg { margin-top: 7px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="htext">
      <div class="eyebrow">Mission Control — Claude Usage</div>
      <div class="hero"><span class="cur">$</span><span class="amt" id="hero-amt">—</span></div>
      <div class="hero-sub" id="hero-sub">ยอดใช้จ่ายเดือนนี้ (คำนวณจาก transcript ในเครื่อง)</div>
    </div>
    <div class="hright">
      <div class="seg" id="period">
        <span class="s" data-p="today">วันนี้</span>
        <span class="s" data-p="week">สัปดาห์นี้</span>
        <span class="s active" data-p="month">เดือนนี้</span>
      </div>
      <button class="refresh" id="refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>รีเฟรช</button>
    </div>
  </div>

  <div class="tiles" id="tiles"></div>
  <div class="notice" id="provider-note" style="display:none"></div>

  <div class="twoup">
    <div class="panelcard daily"><div class="clabel">รายวัน · 14 วัน</div><div class="bars" id="bars"></div><div class="cap" id="daily-cap"></div></div>
    <div class="panelcard toks"><div class="clabel">แยกตามประเภท token</div><div class="stack" id="stack"></div><div class="legend" id="tok-legend"></div></div>
  </div>

  <div class="secbar">
    <span class="section-k" id="projects-k">PROJECTS</span>
    <span class="rng" id="range"></span>
    <span class="hair"></span>
    <span class="hint">คลิกหัวคอลัมน์เพื่อเรียง · ชี้ค้าง 3 วิ ดูกราฟวงกลม</span>
    <div class="pager" id="pager" hidden>
      <button class="pg" id="pg-prev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
      <span class="pi" id="pg-info"></span>
      <button class="pg" id="pg-next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
    </div>
  </div>
  <div class="tbl">
    <div class="thead">
      <span class="th-rank">#</span>
      <span class="th-name">PROJECT</span>
      <span class="th-mix">TOKEN MIX</span>
      <span class="th-tok sortable" data-sort="tok">TOKENS<span class="arrow"></span></span>
      <span class="th-cost sortable" data-sort="cost">COST<span class="arrow"></span></span>
    </div>
    <div id="rows"></div>
  </div>
</div>

<div id="dwell"></div>

<script>
  const vscode = acquireVsCodeApi();
  (function () { var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark"; })();

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var USD = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money2(n) { return "$" + USD.format(n || 0); }
  var TOKFMT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function fmtTokens(n) { return TOKFMT.format(n || 0); }
  function post(type) { vscode.postMessage({ type: type }); }

  var PAGE_SIZE = 6;
  var STATE = { view: null, period: "month", sortKey: "cost", sortDir: "desc", page: 0, dwellRow: null, dwellTimer: null };
  var PERIOD_WORD = { today: "วันนี้", week: "สัปดาห์นี้", month: "เดือนนี้" };
  // Fixed categorical colors (outside the teal accent palette) — identical in dark + light.
  var CATS = [
    { key: "cacheRead", color: "#4f9cf9", label: "Cache read" },
    { key: "output", color: "#f4796b", label: "Output" },
    { key: "cacheWrite", color: "#e8a33d", label: "Cache write" },
    { key: "input", color: "#5ecf8f", label: "Input" }
  ];

  // Selected-period {cost, tokens, cats} for a project — day-scoped from the host.
  function periodOf(p) {
    var pd = (p.periods && p.periods[STATE.period]) || { cost: 0, tokens: 0, cats: {} };
    return { cost: pd.cost || 0, tokens: pd.tokens || 0, cats: pd.cats || {} };
  }
  function heroFmt() {
    var v = STATE.view; if (!v) return "$0.00";
    return { today: v.todayFmt, week: v.last7Fmt, month: v.monthFmt }[STATE.period] || v.monthFmt;
  }

  // ── donut pie: wedges by USD, start 12 o'clock clockwise, center punched out ──
  function pt(deg) { var r = deg * Math.PI / 180; return (50 + 42 * Math.sin(r)).toFixed(2) + " " + (50 - 42 * Math.cos(r)).toFixed(2); }
  // metric = "usd" (wedges by dollars) or "tokens" (wedges by token count) so the
  // pie matches whatever the table is sorted by.
  function donutSvg(cats, metric) {
    var total = 0; CATS.forEach(function (c) { total += (cats[c.key] || {})[metric] || 0; });
    if (total <= 0) return "";
    var nz = CATS.filter(function (c) { return ((cats[c.key] || {})[metric] || 0) > 0; });
    var body;
    if (nz.length === 1) { body = '<circle cx="50" cy="50" r="42" fill="' + nz[0].color + '"/>'; }
    else {
      var a = 0, parts = [];
      CATS.forEach(function (c) {
        var val = (cats[c.key] || {})[metric] || 0; if (val <= 0) return;
        var sweep = val / total * 360, a0 = a, a1 = a + sweep; a = a1;
        parts.push('<path d="M50 50 L' + pt(a0) + ' A42 42 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + pt(a1) + ' Z" fill="' + c.color + '"/>');
      });
      body = parts.join("");
    }
    return '<svg class="donut" viewBox="0 0 100 100">' + body + '<circle cx="50" cy="50" r="26" fill="var(--panel)"/></svg>';
  }

  // Hide projects with no spend in the selected period (they render as $0.00).
  function visibleList() {
    var v = STATE.view; if (!v) return [];
    var list = (v.projects || []).filter(function (p) { return periodOf(p).cost >= 0.005; });
    list.sort(function (a, b) {
      var d = STATE.sortKey === "tok" ? (periodOf(a).tokens - periodOf(b).tokens) : (periodOf(a).cost - periodOf(b).cost);
      if (d === 0) d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      return STATE.sortDir === "desc" ? -d : d;
    });
    return list;
  }

  function updateHero() {
    var s = heroFmt();
    var body = s.charAt(0) === "$" ? s.slice(1) : s;
    var dot = body.lastIndexOf(".");
    var intPart = dot >= 0 ? body.slice(0, dot) : body;
    var decPart = dot >= 0 ? body.slice(dot) : "";
    document.getElementById("hero-amt").innerHTML = esc(intPart) + '<span class="dec">' + esc(decPart) + "</span>";
    document.getElementById("hero-sub").textContent = "ยอดใช้จ่าย" + PERIOD_WORD[STATE.period] + " (คำนวณจาก transcript ในเครื่อง)";
    // segment active state
    var segs = document.querySelectorAll("#period .s");
    for (var i = 0; i < segs.length; i++) segs[i].classList[segs[i].getAttribute("data-p") === STATE.period ? "add" : "remove"]("active");
  }

  function renderTiles() {
    var v = STATE.view;
    var tiles = [
      { k: "เดือนนี้", v: v.monthFmt, p: "month" },
      { k: "วันนี้", v: v.todayFmt, p: "today" },
      { k: "7 วันล่าสุด", v: v.last7Fmt, p: "week" },
      { k: "ทั้งหมด", v: v.allTimeFmt, p: "all" }
    ];
    document.getElementById("tiles").innerHTML = tiles.map(function (t) {
      return '<div class="tile' + (t.p === STATE.period ? " active" : "") + '"><div class="k">' + esc(t.k) + '</div><div class="v">' + esc(t.v) + "</div></div>";
    }).join("");
  }

  function renderDaily() {
    var d = (STATE.view && STATE.view.daily14) || [];
    var max = 0; for (var i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
    var today = d.length ? d[d.length - 1] : 0;
    document.getElementById("bars").innerHTML = d.map(function (val, i) {
      var h = max > 0 ? Math.max(2, Math.round(val / max * 52)) : 2;
      return '<span class="b' + (i === d.length - 1 ? " today" : "") + '" style="height:' + h + 'px" title="' + money2(val) + '"></span>';
    }).join("");
    document.getElementById("daily-cap").textContent = "วันนี้ " + money2(today) + " · สูงสุดในรอบ " + money2(max);
  }

  // Portfolio token-type totals for the active period (sum across visible spend).
  function portfolioCats() {
    var tot = { cacheRead: 0, output: 0, cacheWrite: 0, input: 0 }, sum = 0;
    (STATE.view.projects || []).forEach(function (p) {
      var cats = periodOf(p).cats;
      CATS.forEach(function (c) { var u = (cats[c.key] || {}).usd || 0; tot[c.key] += u; sum += u; });
    });
    return { tot: tot, sum: sum };
  }
  function renderTokenBar() {
    var pc = portfolioCats(), sum = pc.sum;
    document.getElementById("stack").innerHTML = sum > 0 ? CATS.map(function (c) {
      var w = pc.tot[c.key] / sum * 100;
      return w > 0 ? '<span style="width:' + w + '%;background:' + c.color + '"></span>' : "";
    }).join("") : '<span style="width:100%;background:var(--border)"></span>';
    document.getElementById("tok-legend").innerHTML = CATS.map(function (c) {
      var u = pc.tot[c.key], pct = sum > 0 ? Math.round(u / sum * 100) : 0;
      return '<div class="lg"><span class="sw" style="background:' + c.color + '"></span>' +
        '<span class="lb">' + c.label + '</span><span class="fill"></span>' +
        '<span class="vl">' + money2(u) + '</span><span class="pc">' + pct + '%</span></div>';
    }).join("");
  }

  function renderHeaders() {
    document.querySelectorAll(".thead .sortable").forEach(function (h) {
      var key = h.getAttribute("data-sort"), active = key === STATE.sortKey;
      h.classList[active ? "add" : "remove"]("active-sort");
      h.querySelector(".arrow").textContent = active ? (STATE.sortDir === "desc" ? " ↓" : " ↑") : "";
    });
  }

  function renderTable() {
    cancelDwell();
    var list = visibleList();
    document.getElementById("projects-k").textContent = "PROJECTS (" + list.length + ")";
    renderHeaders();
    var maxCost = list.reduce(function (m, p) { var c = periodOf(p).cost; return c > m ? c : m; }, 0);
    var rowsEl = document.getElementById("rows");
    if (!list.length) { rowsEl.innerHTML = '<div class="empty">ไม่มีการใช้จ่ายในช่วงนี้</div>'; renderPager(0, 0); document.getElementById("range").textContent = ""; return; }
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (STATE.page >= pages) STATE.page = pages - 1;
    if (STATE.page < 0) STATE.page = 0;
    var start = STATE.page * PAGE_SIZE, slice = list.slice(start, start + PAGE_SIZE);
    rowsEl.innerHTML = slice.map(function (p, i) {
      var pd = periodOf(p);
      var barW = maxCost > 0 ? Math.max(6, Math.round(pd.cost / maxCost * 100)) : 6;
      var segs = pd.cost > 0 ? CATS.map(function (c) {
        var u = (pd.cats[c.key] || {}).usd || 0; var w = u / pd.cost * 100;
        return w > 0 ? '<span style="width:' + w + '%;background:' + c.color + '"></span>' : "";
      }).join("") : "";
      return '<div class="prow' + (p.live === false ? " removed" : "") + '" data-key="' + esc(p.path) + '">' +
        '<div class="rank">' + (start + i + 1) + "</div>" +
        '<div class="pname" title="' + esc(p.name) + '">' + esc(p.name) + "</div>" +
        '<div class="mixcol"><div class="mix" style="width:' + barW + '%">' + segs + "</div></div>" +
        '<div class="tok">' + fmtTokens(pd.tokens) + " tok</div>" +
        '<div class="cost">' + money2(pd.cost) + "</div></div>";
    }).join("");
    document.getElementById("range").textContent = "— " + (start + 1) + "–" + (start + slice.length) + " จาก " + list.length;
    renderPager(pages, list.length);
  }
  function renderPager(pages, total) {
    var pg = document.getElementById("pager");
    if (pages <= 1) { pg.setAttribute("hidden", ""); return; }
    pg.removeAttribute("hidden");
    document.getElementById("pg-info").textContent = (STATE.page + 1) + " / " + pages;
    var prev = document.getElementById("pg-prev"), next = document.getElementById("pg-next");
    if (STATE.page <= 0) prev.setAttribute("disabled", ""); else prev.removeAttribute("disabled");
    if (STATE.page >= pages - 1) next.setAttribute("disabled", ""); else next.removeAttribute("disabled");
  }

  function render(v) {
    STATE.view = v;
    updateHero();
    renderTiles();
    var pn = document.getElementById("provider-note");
    if (v.providerNote) { pn.textContent = v.providerNote; pn.style.display = "block"; } else { pn.style.display = "none"; }
    var rf = document.getElementById("refresh"); if (rf) rf.removeAttribute("disabled");
    renderDaily();
    renderTokenBar();
    renderTable();
  }

  // ── Dwell popover (3s) ──
  function projFromKey(key) { var l = (STATE.view && STATE.view.projects) || []; for (var i = 0; i < l.length; i++) if (l[i].path === key) return l[i]; return null; }
  function cancelDwell() { if (STATE.dwellTimer) { clearTimeout(STATE.dwellTimer); STATE.dwellTimer = null; } hideDwell(); }
  function hideDwell() { var d = document.getElementById("dwell"); if (d) d.style.display = "none"; STATE.dwellRow = null; }
  function showDwell(row) {
    var p = projFromKey(row.getAttribute("data-key")); if (!p) return;
    var pd = periodOf(p);
    var donut = donutSvg(pd.cats, "usd");   // wedges + legend always by dollars
    if (!donut) return;
    var legend = CATS.map(function (c) {
      var u = (pd.cats[c.key] || {}).usd || 0;
      return '<div class="lg"><span class="sw" style="background:' + c.color + '"></span>' +
        '<span class="lb">' + c.label + '</span><span class="fill"></span><span class="vl">' + money2(u) + "</span></div>";
    }).join("");
    // Center of the donut = total spend (compact so it fits the punched-out hole).
    var center = '<div class="dcenter"><div class="dv">$' + esc(TOKFMT.format(pd.cost)) + '</div><div class="du">usd</div></div>';
    var d = document.getElementById("dwell");
    d.innerHTML = '<div class="d-body"><div class="donutwrap">' + donut + center + '</div><div class="d-right"><div class="d-name">' + esc(p.name) + "</div>" + legend + "</div></div>";
    d.style.display = "block";
    var r = row.getBoundingClientRect();
    var w = d.offsetWidth, h = d.offsetHeight;
    var left = r.right - 16 - w; if (left < 8) left = 8;
    var top = (r.bottom + h - 6 <= window.innerHeight - 8) ? (r.bottom - 6) : (r.top - h + 6);
    if (top < 8) top = 8;
    d.style.left = left + "px"; d.style.top = top + "px";
    STATE.dwellRow = row.getAttribute("data-key");
  }

  // ── events ──
  document.addEventListener("click", function (e) {
    var t = e.target;
    var seg = t.closest ? t.closest("#period .s") : null;
    if (seg) { STATE.period = seg.getAttribute("data-p"); STATE.page = 0; render(STATE.view); return; }
    var th = t.closest ? t.closest(".thead .sortable") : null;
    if (th) { var k = th.getAttribute("data-sort"); if (STATE.sortKey === k) STATE.sortDir = STATE.sortDir === "desc" ? "asc" : "desc"; else { STATE.sortKey = k; STATE.sortDir = "desc"; } STATE.page = 0; renderTable(); return; }
    var row = t.closest ? t.closest(".prow") : null;
    if (row && row.getAttribute("data-key")) { var p = projFromKey(row.getAttribute("data-key")); if (p) vscode.postMessage({ type: "openProjectDetail", projectPath: p.path, projectName: p.name }); return; }
    var b = t.id ? t : (t.closest ? t.closest("[id]") : null);
    if (b && b.id === "refresh") { b.setAttribute("disabled", "true"); post("reload"); }
    else if (b && b.id === "pg-prev") { if (STATE.page > 0) { STATE.page--; renderTable(); } }
    else if (b && b.id === "pg-next") { STATE.page++; renderTable(); }
  });
  document.addEventListener("mouseover", function (e) {
    var row = e.target.closest ? e.target.closest(".prow") : null;
    if (!row) { if (STATE.dwellRow || STATE.dwellTimer) cancelDwell(); return; }
    var key = row.getAttribute("data-key");
    if (key === STATE.dwellRow) return;           // already shown for this row
    if (STATE.dwellTimer) clearTimeout(STATE.dwellTimer);
    hideDwell();
    STATE.dwellTimer = setTimeout(function () { STATE.dwellTimer = null; showDwell(row); }, 2000);
  });
  document.addEventListener("mouseout", function (e) {
    var to = e.relatedTarget, row = e.target.closest ? e.target.closest(".prow") : null;
    if (row && (!to || !to.closest || !to.closest(".prow"))) cancelDwell();
  });
  window.addEventListener("scroll", cancelDwell, true);
  window.addEventListener("message", function (ev) { var m = ev.data; if (m && m.type === "budget") render(m); });

  post("ready");
</script>
</body></html>`;
}
