import * as fs from "node:fs";

import * as vscode from "vscode";

import {
  loadDataIndex,
  loadProjectDocList,
  loadProjectPlan,
  loadProjectTasks,
  type ProjectRow,
} from "../commands/dataView";

/** Singleton panel — a second open reveals the existing one instead of spawning a twin. */
let current: vscode.WebviewPanel | undefined;

/** Open (or reveal) the Data View. Two modes, one panel:
 *  - no `projectPath` → cross-project: every project's status from its `.md` docs
 *    (table / kanban / timeline), which is what the main dashboard button opens;
 *  - a `projectPath` → that project alone, its sprints broken down into tasks.
 *  Clicking a row in the cross-project table drills into the same project mode, and
 *  the back button returns. Read-only either way. */
export async function openDataViewPanel(projectPath?: string): Promise<vscode.WebviewPanel> {
  if (current) {
    current.reveal(vscode.ViewColumn.Active);
    if (projectPath) void current.webview.postMessage({ type: "enter_project", path: projectPath });
    void refresh(current);
    return current;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.dataView",
    "Data View",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  current = panel;
  panel.onDidDispose(() => {
    if (current === panel) current = undefined;
  });

  const rows = await loadDataIndex();
  panel.webview.html = renderHtml(rows, projectPath);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg?.type) {
      case "refresh":
        await refresh(panel);
        return;
      case "get_tasks": {
        // Read only when a project is actually opened — see loadProjectTasks.
        const p = typeof msg.path === "string" ? msg.path : "";
        void panel.webview.postMessage({
          type: "tasks",
          path: p,
          sprints: p ? loadProjectTasks(p) : [],
          docs: p ? loadProjectDocList(p) : [],
          plan: p ? loadProjectPlan(p) : null,
        });
        return;
      }
      case "open_doc":
        if (typeof msg.file === "string" && msg.file && fs.existsSync(msg.file)) {
          void vscode.window.showTextDocument(vscode.Uri.file(msg.file), { preview: true });
        }
        return;
      case "open_github":
        if (typeof msg.url === "string" && msg.url) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
    }
  });
  return panel;
}

async function refresh(panel: vscode.WebviewPanel): Promise<void> {
  const rows = await loadDataIndex();
  void panel.webview.postMessage({ type: "index", rows });
}

function renderHtml(rows: ProjectRow[], initialProject?: string): string {
  // `<` escaped so a project name containing `</script>` can't break out of the block.
  const data = JSON.stringify(rows).replace(/</g, "\\u003c");
  const initial = JSON.stringify(initialProject ?? null).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root, :root[data-theme="dark"] {
    --editor:#0f151b; --panel:#11171d; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15);
    --dot:rgba(255,255,255,.028);
  }
  :root[data-theme="light"] {
    --editor:#ffffff; --panel:#f9fbfc; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10);
    --dot:rgba(15,30,45,.035);
  }
  :root { --pad:20px; --gap:14px; --cardpad:14px; --radius:14px; --secgap:20px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace;
    --done:#5ecf8f; --active:#4f9cf9; --todo:#8a97a4; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; } /* beat .btn/.kpis display rules so hidden actually hides */
  body { font-family: var(--uifont); font-size: 13px; color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad); }
  .wrap { max-width: 1120px; margin: 0 auto; }
  h1 { font-size: 27px; font-weight: 700; letter-spacing: -.4px; margin: 0; }
  .sub { font-family: var(--mono); font-size: 11.5px; color: var(--faint); margin-top: 6px; }

  /* KPI / filter strip */
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); margin: var(--secgap) 0; }
  .kpi { padding: 13px 15px; border-radius: var(--radius); background: var(--card); border: 1px solid var(--border); cursor: pointer; transition: border-color .12s; }
  .kpi:hover { border-color: var(--accent); }
  .kpi.active { background: var(--accentSoft); border-color: var(--accent); }
  .kpi .k { font-size: 11px; color: var(--muted); }
  .kpi .v { font-family: var(--mono); font-size: 20px; font-weight: 600; margin-top: 5px; }

  /* toolbar: segmented switcher + search + refresh */
  .toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: var(--secgap); }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 9px; background: var(--card); border: 1px solid var(--border2); }
  .tab { height: 28px; padding: 0 14px; display: inline-flex; align-items: center; border-radius: 6px; border: none; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--uifont); }
  .tab.active { color: var(--txt); background: var(--accentSoft); box-shadow: inset 0 0 0 1px var(--accent); }
  .spacer { flex: 1; }
  input[type=search] { flex: none; width: 40%; max-width: 280px; height: 32px; background: var(--card); color: var(--txt); border: 1px solid var(--border2); border-radius: 8px; padding: 0 11px; font-size: 12px; font-family: var(--uifont); }
  input[type=search]:focus { outline: none; border-color: var(--accent); }
  button.btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 8px; background: var(--card); border: 1px solid var(--border2); color: var(--txt); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--uifont); }
  button.btn:hover { border-color: var(--accent); }

  /* table */
  .tbl { border-radius: 11px; background: var(--card); border: 1px solid var(--border); overflow: hidden; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  thead th { text-align: left; padding: 10px 15px; border-bottom: 1px solid var(--border2); font-family: var(--mono); font-size: 9.5px; letter-spacing: 1.2px; font-weight: 600; color: var(--faint); cursor: pointer; user-select: none; white-space: nowrap; }
  thead th .arr { opacity: .6; }
  tbody td { padding: 11px 15px; border-top: 1px solid var(--border); white-space: nowrap; }
  tr.proj { cursor: pointer; }
  tr.proj:hover td { background: var(--accentSoft); }
  tr.deleted td { opacity: .55; }
  td.c-name { font-family: var(--mono); font-size: 12.5px; font-weight: 600; overflow: hidden; max-width: 320px; }
  .c-name .cwrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .c-name .pn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .c-name .deltag, .c-name a.gh { flex: none; white-space: nowrap; }
  td.c-latest { color: var(--muted); overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
  td.num { font-family: var(--mono); font-size: 11.5px; color: var(--muted); text-align: right; }
  td.c-dur { font-family: var(--mono); font-size: 11px; color: var(--faint); text-align: right; }
  .done-cell { display: inline-flex; align-items: center; gap: 7px; justify-content: flex-end; font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9px; font-family: var(--mono); font-size: 10.5px; font-weight: 700; border: 1px solid transparent; }
  .s-done { background: rgba(94,207,143,.14); color: var(--done); border-color: rgba(94,207,143,.4); }
  .s-in-progress { background: rgba(79,156,249,.14); color: var(--active); border-color: rgba(79,156,249,.4); }
  .s-not-started { background: rgba(138,151,164,.12); color: var(--muted); border-color: var(--border2); }
  .bar { height: 6px; border-radius: 3px; background: var(--border); width: 66px; overflow: hidden; display: inline-block; vertical-align: middle; }
  .bar > i { display: block; height: 100%; background: var(--done); }
  .tag { font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .deltag { font-family: var(--mono); font-size: 10px; color: #e8a33d; background: rgba(232,163,61,.12); border: 1px solid rgba(232,163,61,.4); border-radius: 6px; padding: 0 6px; }
  a.gh { color: var(--accent2); text-decoration: none; }

  /* kanban */
  .kb { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); align-items: start; }
  .kb2 { grid-template-columns: repeat(2, 1fr); }
  .kb .col { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; min-height: 60px; background: var(--card); }
  .kb .col h3 { font-size: 12px; margin: 0 0 10px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .kb .col h3 .lbl { display: inline-flex; align-items: center; gap: 7px; }
  .kb .col h3 .cdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .kb .col h3 .cnt { font-family: var(--mono); font-size: 11px; color: var(--faint); font-weight: 400; }
  .card { border: 1px solid var(--border); border-left: 3px solid var(--todo); border-radius: 10px; padding: 12px 13px; margin-bottom: 9px; cursor: pointer; background: var(--card); }
  .card:hover { border-color: var(--accent); }
  .card.st-done { border-left-color: var(--done); }
  .card.st-in-progress { border-left-color: var(--active); }
  .card.deleted { opacity: .55; }
  .card .nm { font-family: var(--mono); font-size: 11.5px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; overflow: hidden; }
  .card .nm .lead { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .nm .fr { color: var(--faint); font-weight: 400; font-size: 10px; flex: none; }
  .card .note { font-size: 10.5px; color: var(--faint); margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .pbar { height: 4px; border-radius: 2px; background: var(--border); margin-top: 8px; overflow: hidden; }
  .card .pbar > i { display: block; height: 100%; }
  .swim { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--muted); margin: 12px 0 6px; }

  /* project mode — sprints broken into tasks (drill-in; refined in a later pass) */
  tr.sprow, tr.docrow, tr.planrow { cursor: pointer; }
  tr.sprow:hover td, tr.docrow:hover td, tr.planrow:hover td { background: var(--accentSoft); }
  tr.sprow .caret, tr.docrow .caret, tr.planrow .caret { display: inline-block; width: 12px; opacity: .6; }
  tr.docrow td, tr.planrow td { font-weight: 600; }
  tr.tasks > td { white-space: normal; padding: 0 15px 10px 30px; }
  .task { font-size: 12px; padding: 2px 0; display: flex; gap: 6px; align-items: baseline; }
  .task .box { color: var(--faint); font-family: var(--mono); flex: none; }
  .task.todo { color: var(--muted); }
  .tcard { border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 7px 9px; margin-bottom: 6px; font-size: 12px; background: var(--card); }
  .tcard.done { border-left-color: var(--done); }
  .tcard.todo { border-left-color: #e8a33d; }
  a.doc { font-family: var(--mono); font-size: 10px; color: var(--accent2); text-decoration: none; }
  a.doc:hover { text-decoration: underline; }

  /* timeline */
  .tl { font-size: 12px; }
  .tl .axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10px; color: var(--faint); border-bottom: 1px solid var(--border2); padding-bottom: 4px; margin-bottom: 8px; }
  .tl .row { display: grid; grid-template-columns: 180px 1fr; gap: 8px; align-items: center; padding: 5px 0; }
  .tl .row:hover { background: var(--accentSoft); }
  .tl .row.deleted { opacity: .55; }
  .tl .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .tl .track { position: relative; height: 16px; }
  .tl .seg { position: absolute; top: 7px; height: 2px; background: var(--border2); }
  .tl .dot { position: absolute; top: 3px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent2); transform: translateX(-50%); }
  .tl.ptl .sbar { position: absolute; top: 50%; transform: translateY(-50%); height: 12px; border-radius: 4px; background: var(--accent); min-width: 3px; }
  .tl .nodate { font-size: 11px; color: var(--faint); }
  .tl.ptl .row { grid-template-columns: 260px 1fr; }
  .tl .sum { font-family: var(--mono); font-size: 10.5px; color: var(--faint); margin-bottom: 6px; }

  /* overview timeline: bar per project (DATA_VIEW_TAB.md §6) */
  .tlbar { padding: 16px 18px 18px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
  .tlb-axis { position: relative; margin-left: 220px; height: 15px; margin-bottom: 4px; }
  .tlb-axis .ml { position: absolute; transform: translateX(-50%); font-family: var(--mono); font-size: 9.5px; color: var(--faint); white-space: nowrap; }
  .tlb-scroll { position: relative; }
  .tlb-lines { position: absolute; top: 0; bottom: 0; left: 220px; right: 0; pointer-events: none; z-index: 0; }
  .tlb-lines .gl { position: absolute; top: 0; bottom: 0; border-left: 1px dashed var(--border2); }
  .tlb-lines .today { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent2); transform: translateX(-1px); }
  .brow { display: grid; grid-template-columns: 220px 1fr; align-items: center; padding: 5px 0; position: relative; z-index: 1; }
  .brow:hover { background: var(--accentSoft); }
  .brow.deleted { opacity: .55; }
  .bnm { display: flex; align-items: center; gap: 6px; min-width: 0; font-family: var(--mono); font-size: 11.5px; cursor: pointer; padding-right: 10px; }
  .bnm .pn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .bnm .deltag { flex: none; white-space: nowrap; }
  .btrack { position: relative; height: 18px; }
  .btrack .nodate { position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--faint); }
  .brange { position: absolute; top: 50%; transform: translateY(-50%); height: 12px; border-radius: 4px; background-color: var(--accent);
    background-image: linear-gradient(90deg, rgba(255,255,255,.30) 0 1px, transparent 1px); background-repeat: repeat; }
  .tlb-legend { display: flex; gap: 18px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .tlb-legend .lg { display: inline-flex; align-items: center; gap: 7px; }
  .tlb-legend .sw { width: 22px; height: 9px; border-radius: 3px; background-color: var(--accent); background-image: linear-gradient(90deg, rgba(255,255,255,.30) 0 1px, transparent 1px); background-size: 7px 100%; background-repeat: repeat; }
  .tlb-legend .tln { width: 2px; height: 12px; background: var(--accent2); }
  .empty { color: var(--faint); font-size: 12px; padding: 30px 0; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1 id="title">Data View</h1>
  <div class="sub" id="sub"></div>
  <div class="kpis" id="kpis" hidden></div>
  <div class="toolbar">
    <button class="btn" id="back" hidden>‹ ทุกโปรเจกต์</button>
    <div class="tabs">
      <button class="tab active" data-view="table">Table</button>
      <button class="tab" data-view="kanban">Kanban</button>
      <button class="tab" data-view="timeline">Timeline</button>
    </div>
    <input type="search" id="q" placeholder="ค้นหาชื่อโปรเจกต์…">
    <div class="spacer"></div>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div id="view"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  (function(){ var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains('vscode-light') || b.contains('vscode-high-contrast-light')) ? 'light' : 'dark'; })();
  let ROWS = ${data};
  const INITIAL_PROJECT = ${initial};
  const S = {
    mode: "all",   // "all" = every project · "project" = one project broken into tasks
    proj: null,    // { name, path } while mode === "project"
    tasks: null,   // SprintTasks[] for S.proj — null means "not answered yet"
    docs: [],      // every other .md of S.proj (wiki, ADRs, design/req, README)
    plan: null,    // plan.md as {file, done[], pending[]} — its own row above the sprints
    planOpen: false, // the plan.md row expanded
    open: {},      // sprint n → row expanded in the project table
    docsOpen: false, // the "เอกสารอื่นๆ" group
    statusFilter: "all", // overview KPI-card filter: all | done | in-progress
    view: "table", q: "", sortKey: "updated", sortDir: -1,
  };
  const baseName = (p) => String(p || "").split(/[\\\\/]/).filter(Boolean).pop() || String(p || "");

  const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  // deleted (backed-up) project → a plain-text tag; no emoji (terminal renders them blank)
  function delTag(r){
    return r && r.deleted
      ? ' <span class="deltag" title="โปรเจกต์นี้ถูกลบจากเครื่องแล้ว — กำลังดูจากสำเนาสำรอง">(ลบแล้ว '
        + esc(r.deletedAt ? String(r.deletedAt).slice(0,10) : '') + ')</span>'
      : '';
  }
  const STATUS_ORDER = { "not-started": 0, "in-progress": 1, "done": 2 };
  const STATUS_LABEL = { "done": "เสร็จ", "in-progress": "กำลังทำ", "not-started": "ยังไม่เริ่ม" };
  const STATUS_COLOR = { "done": "var(--done)", "in-progress": "var(--active)", "not-started": "var(--todo)" };
  const COLS = [
    { k: "name", t: "PROJECT" },
    { k: "status", t: "STATUS" },
    { k: "sprintsDone", t: "SPRINTS" },
    { k: "percentDone", t: "DONE%" },
    { k: "duration", t: "DURATION" },
    { k: "latest", t: "LATEST" },
  ];
  // Project span in days, from its first to its last dated sprint (null = no dates yet).
  function durDays(r) {
    const ds = (r.sprints || []).map(s => s.date).filter(Boolean).sort();
    return ds.length ? Math.max(0, Math.round((Date.parse(ds[ds.length - 1]) - Date.parse(ds[0])) / 86400000)) : null;
  }
  function durLabel(r) { const d = durDays(r); return d == null ? "—" : (d + " วัน"); }

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return ROWS.filter(r => (S.statusFilter === "all" || r.status === S.statusFilter) && (!q || r.name.toLowerCase().includes(q)));
  }
  function cmp(a, b, k) {
    if (k === "status") return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (k === "latest") return (a.latestSprint?.n ?? 0) - (b.latestSprint?.n ?? 0);
    if (k === "duration") return (durDays(a) ?? 0) - (durDays(b) ?? 0);
    let av = a[k], bv = b[k];
    if (typeof av === "number") return av - (bv ?? 0);
    return String(av ?? "").localeCompare(String(bv ?? ""));
  }
  function sorted(list) {
    return [...list].sort((a, b) => cmp(a, b, S.sortKey) * S.sortDir || a.name.localeCompare(b.name));
  }
  /** Drill from the cross-project table into one project. Its sprint docs are not in
   *  ROWS — ask the extension for them, and render a loading line until they land. */
  function enterProject(p, name) {
    S.mode = "project";
    S.proj = { path: p, name: name || baseName(p) };
    S.tasks = null;
    S.docs = [];
    S.plan = null;
    S.planOpen = false;
    S.open = {};
    S.docsOpen = false;
    S.q = "";
    document.getElementById("q").value = "";
    vscode.postMessage({ type: "get_tasks", path: p });
    render();
  }
  function exitProject() {
    S.mode = "all";
    S.proj = null;
    S.tasks = null;
    S.q = "";
    document.getElementById("q").value = "";
    render();
  }

  function statusBadge(s) { return '<span class="badge s-' + s + '">' + (STATUS_LABEL[s] || s) + '</span>'; }
  function bar(pct) { return '<span class="bar"><i style="width:' + pct + '%"></i></span>'; }

  function rowCells(r) {
    return '<td class="c-name"><div class="cwrap"><span class="pn">' + esc(r.name) + '</span>' + delTag(r) + (r.githubUrl ? '<a href="#" class="gh" data-url="' + esc(r.githubUrl) + '">↗</a>' : '') + '</div></td>'
      + '<td>' + statusBadge(r.status) + '</td>'
      + '<td class="num">' + r.sprintsDone + '/' + r.sprintsTotal + '</td>'
      + '<td class="num"><span class="done-cell">' + bar(r.percentDone) + '<span>' + r.percentDone + '%</span></span></td>'
      + '<td class="c-dur">' + esc(durLabel(r)) + '</td>'
      + '<td class="c-latest">' + (r.latestSprint ? esc("s" + r.latestSprint.n + " " + r.latestSprint.name) : "—") + '</td>';
  }

  // KPI cards double as the status filter: Total (= reset to all) · Completed · In progress.
  function renderKpis() {
    const total = ROWS.length;
    const done = ROWS.filter(r => r.status === "done").length;
    const prog = ROWS.filter(r => r.status === "in-progress").length;
    const cards = [
      { k: "โปรเจกต์ทั้งหมด", v: total, f: "all" },
      { k: "เสร็จแล้ว", v: done, f: "done" },
      { k: "กำลังทำ", v: prog, f: "in-progress" },
    ];
    document.getElementById("kpis").innerHTML = cards.map(c =>
      '<div class="kpi' + (S.statusFilter === c.f ? ' active' : '') + '" data-f="' + c.f + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div></div>'
    ).join('');
  }

  function renderTable() {
    const list = sorted(filtered());
    const head = '<tr>' + COLS.map(c => '<th data-k="' + c.k + '">' + c.t + (S.sortKey === c.k ? ' <span class="arr">' + (S.sortDir < 0 ? "▼" : "▲") + '</span>' : '') + '</th>').join('') + '</tr>';
    if (!list.length) return '<div class="empty">ไม่มีโปรเจกต์ที่ตรงกับตัวกรอง</div>';
    let body = "";
    for (const r of list) body += '<tr class="proj' + (r.deleted ? ' deleted' : '') + '" data-p="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' + rowCells(r) + '</tr>';
    return '<div class="tbl"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function card(r) {
    const note = r.latestSprint ? ("s" + r.latestSprint.n + " " + r.latestSprint.name) : "";
    return '<div class="card st-' + r.status + (r.deleted ? ' deleted' : '') + '" data-p="' + esc(r.path) + '" data-name="' + esc(r.name) + '">'
      + '<div class="nm"><span class="lead">' + esc(r.name) + delTag(r) + '</span><span class="fr">' + r.sprintsDone + '/' + r.sprintsTotal + '</span></div>'
      + (note ? '<div class="note">' + esc(note) + '</div>' : '')
      + '<div class="pbar"><i style="width:' + r.percentDone + '%;background:' + (STATUS_COLOR[r.status] || 'var(--todo)') + '"></i></div></div>';
  }
  function kanbanCols(list) {
    const cols = [["not-started", "ยังไม่เริ่ม"], ["in-progress", "กำลังทำ"], ["done", "เสร็จ"]];
    return '<div class="kb">' + cols.map(([st, label]) => {
      const items = list.filter(r => r.status === st);
      return '<div class="col"><h3><span class="lbl"><span class="cdot" style="background:' + STATUS_COLOR[st] + '"></span>' + label + '</span><span class="cnt">' + items.length + '</span></h3>' + items.map(card).join('') + '</div>';
    }).join('') + '</div>';
  }
  function renderKanban() {
    const list = filtered();
    if (!list.length) return '<div class="empty">ไม่มีโปรเจกต์ที่ตรงกับตัวกรอง</div>';
    return kanbanCols(list);
  }

  function allDates(list) {
    const ds = [];
    for (const r of list) for (const s of r.sprints || []) if (s.date) ds.push(s.date);
    for (const r of list) if (r.updated) ds.push(r.updated);
    return ds.sort();
  }
  var MONTHS_EN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function ymdLocal(d) { const z = n => String(n).padStart(2, "0"); return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
  // Overview timeline (DATA_VIEW_TAB.md §6): one horizontal bar per project spanning its
  // real first→last sprint date, on a shared axis that ends at today. Dashed month
  // gridlines behind, an accent "today" line at the right edge, ticks subdividing each
  // bar by sprint count. Ignores search + status filter — always shows everything.
  function renderTimeline() {
    const list = sorted(ROWS);
    if (!list.length) return '<div class="empty">ยังไม่มีโปรเจกต์</div>';
    const ds = allDates(list);
    const today = ymdLocal(new Date());
    const min = ds.length ? ds[0] : today;
    const lastData = ds.length ? ds[ds.length - 1] : today;
    const max = Date.parse(lastData) > Date.parse(today) ? lastData : today; // today sits at the right edge
    const span = Math.max(1, Date.parse(max) - Date.parse(min));
    const pos = (d) => ((Date.parse(d) - Date.parse(min)) / span) * 100;

    // month gridlines + labels at each first-of-month within the range
    const ticks = [];
    { let d = new Date(min + "T00:00:00"); d.setDate(1);
      const end = Date.parse(max);
      while (d.getTime() <= end) {
        const x = pos(ymdLocal(d));
        if (x >= 0 && x <= 100) ticks.push({ x: x, label: MONTHS_EN[d.getMonth()] });
        d.setMonth(d.getMonth() + 1);
      }
    }
    const axis = '<div class="tlb-axis">' + ticks.map(t => '<span class="ml" style="left:' + t.x + '%">' + t.label + '</span>').join('') + '</div>';
    const overlay = '<div class="tlb-lines">' + ticks.map(t => '<div class="gl" style="left:' + t.x + '%"></div>').join('')
      + '<div class="today" style="left:' + pos(today) + '%"></div></div>';

    let rows = "";
    for (const r of list) {
      const dated = (r.sprints || []).map(s => s.date).filter(Boolean).sort();
      let track;
      if (!dated.length) {
        track = '<div class="btrack"><span class="nodate">ไม่มีวันที่</span></div>';
      } else {
        const lo = pos(dated[0]), hi = pos(dated[dated.length - 1]);
        const w = Math.max(1.2, hi - lo);
        const nSeg = Math.max(1, (r.sprints || []).length);
        const tip = dated[0] + ' → ' + dated[dated.length - 1] + ' · ' + r.sprintsTotal + ' sprint';
        track = '<div class="btrack"><div class="brange" title="' + esc(tip) + '" style="left:' + lo + '%;width:' + w + '%;background-size:' + (100 / nSeg) + '% 100%"></div></div>';
      }
      rows += '<div class="brow' + (r.deleted ? ' deleted' : '') + '"><div class="bnm" data-p="' + esc(r.path) + '" data-name="' + esc(r.name) + '" title="' + esc(r.name) + '"><span class="pn">' + esc(r.name) + '</span>' + delTag(r) + '</div>' + track + '</div>';
    }
    const legend = '<div class="tlb-legend"><span class="lg"><span class="sw"></span>ช่วงที่มีสปรินต์</span><span class="lg"><span class="tln"></span>วันนี้</span></div>';
    return '<div class="tlbar">' + axis + '<div class="tlb-scroll">' + overlay + rows + '</div>' + legend + '</div>';
  }

  /* ---------- project mode: sprints broken into tasks ---------- */

  function taskTotals() {
    let d = 0, p = 0;
    for (const s of S.tasks || []) { d += s.done.length; p += s.pending.length; }
    return { d, p };
  }
  /** Sprints with their task lists narrowed by the search box; a sprint with no
   *  surviving task drops out entirely (only while actually searching). */
  function sprintsFiltered() {
    const q = S.q.trim().toLowerCase();
    const hit = (t) => !q || t.toLowerCase().includes(q);
    const list = (S.tasks || []).map(s => ({ ...s, done: s.done.filter(hit), pending: s.pending.filter(hit) }));
    return q ? list.filter(s => s.done.length || s.pending.length) : list;
  }
  /* Other .md of the project, narrowed by the same search box as the tasks.
   * plan.md is dropped here — it gets its own row above the sprints. */
  function docsFiltered() {
    const q = S.q.trim().toLowerCase();
    const planFile = S.plan ? S.plan.file : null;
    return (S.docs || []).filter(d => d.file !== planFile && (!q || d.rel.toLowerCase().includes(q)));
  }
  /* plan.md as a sprint-shaped {done,pending}, narrowed by the search like sprints
   * (dropped entirely while searching if nothing matches). null = no plan.md. */
  function planFiltered() {
    if (!S.plan) return null;
    const q = S.q.trim().toLowerCase();
    const hit = (t) => !q || t.toLowerCase().includes(q);
    const done = (S.plan.done || []).filter(hit), pending = (S.plan.pending || []).filter(hit);
    if (q && !done.length && !pending.length) return null;
    return { file: S.plan.file, done, pending };
  }
  /** Said above the rows, never instead of them — the doc list stays useful even when
   *  the sprint docs use a format we can't read tasks out of. */
  function taskNote() {
    if (!S.tasks || !S.tasks.length) return "";
    const { d, p } = taskTotals();
    if (d || p) return "";
    return '<div class="empty">อ่าน task ไม่ได้ — sprint doc ของโปรเจกต์นี้ไม่ได้ใช้หัวข้อ "ทำอะไรเสร็จบ้าง" / "ยังค้าง" (เปิดไฟล์อ่านเองได้ด้านล่าง)</div>';
  }
  function docLink(d) {
    return '<div class="task"><a href="#" class="doc" data-f="' + esc(d.file) + '">' + esc(d.rel) + '</a></div>';
  }
  function taskLine(text, isDone) {
    return '<div class="task ' + (isDone ? 'done' : 'todo') + '"><span class="box">' + (isDone ? '[x]' : '[ ]') + '</span><span>' + esc(text) + '</span></div>';
  }
  function renderProjectTable() {
    if (S.tasks === null) return '<div class="empty">กำลังอ่านเอกสาร…</div>';
    const list = sprintsFiltered();
    const docs = docsFiltered();
    const plan = planFiltered();
    if (!list.length && !docs.length && !plan) {
      return '<div class="empty">' + (S.q.trim() ? "ไม่มีอะไรตรงกับตัวกรอง" : "โปรเจกต์นี้ไม่มีไฟล์ .md") + '</div>';
    }
    const head = '<tr><th>Sprint</th><th>วันที่</th><th>เสร็จ</th><th>ค้าง</th><th></th></tr>';
    let body = "";
    if (plan) {
      const open = S.planOpen || !!S.q.trim();
      body += '<tr class="planrow" data-plan="1">'
        + '<td><span class="caret">' + (open ? '▾' : '▸') + '</span>plan.md</td>'
        + '<td class="tag">—</td>'
        + '<td>' + plan.done.length + '</td>'
        + '<td>' + plan.pending.length + '</td>'
        + '<td><a href="#" class="doc" data-f="' + esc(plan.file) + '">.md</a></td>'
        + '</tr>';
      if (open) {
        const lines = plan.done.map(t => taskLine(t, true)).join('') + plan.pending.map(t => taskLine(t, false)).join('');
        body += '<tr class="tasks"><td colspan="5">' + (lines || '<div class="empty">plan.md ไม่มีเช็คลิสต์ — กด .md เพื่อเปิดอ่าน</div>') + '</td></tr>';
      }
    }
    for (const s of list) {
      const open = !!S.open[s.n] || !!S.q.trim(); // a search auto-opens what it matched
      body += '<tr class="sprow" data-n="' + s.n + '">'
        + '<td><span class="caret">' + (open ? '▾' : '▸') + '</span>' + esc('Sprint ' + s.n + ' — ' + s.name) + '</td>'
        + '<td class="tag">' + esc(s.date || '—') + '</td>'
        + '<td>' + s.done.length + '</td>'
        + '<td>' + s.pending.length + '</td>'
        + '<td><a href="#" class="doc" data-f="' + esc(s.file) + '">.md</a></td>'
        + '</tr>';
      if (!open) continue;
      const lines = s.done.map(t => taskLine(t, true)).join('') + s.pending.map(t => taskLine(t, false)).join('');
      body += '<tr class="tasks"><td colspan="5">' + (lines || '<div class="empty">ไม่มี task ในสปรินต์นี้</div>') + '</td></tr>';
    }
    if (docs.length) {
      const open = S.docsOpen || !!S.q.trim();
      body += '<tr class="docrow"><td colspan="5"><span class="caret">' + (open ? '▾' : '▸') + '</span>เอกสารอื่นๆ (' + docs.length + ')</td></tr>';
      if (open) body += '<tr class="tasks"><td colspan="5">' + docs.map(docLink).join('') + '</td></tr>';
    }
    return taskNote() + '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  // Kanban is the pure sprint board: only tasks parsed out of the sprint docs —
  // no plan.md, no other docs (those live on the Table tab).
  function renderProjectKanban() {
    if (S.tasks === null) return '<div class="empty">กำลังอ่านเอกสาร…</div>';
    const list = sprintsFiltered();
    if (!list.length) {
      return '<div class="empty">' + (S.q.trim() ? "ไม่มีอะไรตรงกับตัวกรอง" : "โปรเจกต์นี้ยังไม่มี sprint doc") + '</div>';
    }
    const col = (label, key, cls) => {
      let inner = "", n = 0;
      for (const s of list) {
        if (!s[key].length) continue;
        n += s[key].length;
        inner += '<div class="swim">' + esc('Sprint ' + s.n + ' — ' + s.name) + '</div>'
          + s[key].map(t => '<div class="tcard ' + cls + '">' + esc(t) + '</div>').join('');
      }
      return '<div class="col"><h3><span>' + label + '</span><span>' + n + '</span></h3>' + (inner || '<div class="empty">—</div>') + '</div>';
    };
    return taskNote() + '<div class="kb kb2">' + col('ค้าง', 'pending', 'todo') + col('เสร็จ', 'done', 'done') + '</div>';
  }

  /* project mode: one solid bar per sprint on a shared date axis — same look as the
   * cross-project timeline, but not subdivided (each row is a single sprint). Each
   * sprint doc carries one date (its completion); the bar spans from the previous
   * sprint's date to this one = how long the sprint took. */
  function renderProjectTimeline() {
    if (S.tasks === null) return '<div class="empty">กำลังอ่านเอกสาร…</div>';
    const sprints = (S.tasks || []).slice().sort((a, b) => a.n - b.n);
    const dated = sprints.filter(s => s.date).map(s => s.date).sort();
    if (!dated.length) return '<div class="empty">sprint doc ไม่มีบรรทัดวันที่ — ดู timeline ไม่ได้</div>';
    const DAY = 86400000;
    const min = dated[0], max = dated[dated.length - 1];
    const span = Math.max(1, Date.parse(max) - Date.parse(min));
    const pos = (d) => ((Date.parse(d) - Date.parse(min)) / span) * 100;
    const total = Math.max(0, Math.round((Date.parse(max) - Date.parse(min)) / DAY));
    const axis = '<div class="axis"><span>' + esc(min) + '</span><span>' + esc(max) + '</span></div>';
    let body = "", prev = null;
    for (const s of sprints) {
      const nm = '<div class="nm" title="' + esc('Sprint ' + s.n + ' — ' + s.name) + '">' + esc('Sprint ' + s.n + ' — ' + s.name) + '</div>';
      let track;
      if (!s.date) {
        track = '<span class="nodate">ไม่มีวันที่</span>';
      } else {
        const x = pos(s.date);
        const px = prev ? pos(prev.date) : x;   // first sprint: no prior span → a stub at the start
        const lo = Math.min(px, x), w = Math.abs(x - px);
        const days = prev ? Math.max(0, Math.round((Date.parse(s.date) - Date.parse(prev.date)) / DAY)) : 0;
        const dur = !prev ? ' · เริ่มต้น' : days === 0 ? ' · วันเดียวกับก่อนหน้า' : ' · ~' + days + ' วัน';
        const tip = 'Sprint ' + s.n + ' · ' + s.date + dur;
        track = '<div class="track"><div class="sbar" title="' + esc(tip) + '" style="left:' + lo + '%;width:' + w + '%"></div></div>';
        prev = s;
      }
      body += '<div class="row">' + nm + track + '</div>';
    }
    const sum = '<div class="sum">รวม ' + total + ' วัน · ' + sprints.length + ' sprint · แต่ละแท่ง = เวลาที่ sprint นั้นใช้</div>';
    return '<div class="tl ptl">' + sum + axis + body + '</div>';
  }

  function render() {
    const proj = S.mode === "project";
    document.getElementById("back").hidden = !proj;
    document.getElementById("kpis").hidden = proj; // KPI/filter strip is overview-only
    document.getElementById("q").placeholder = proj ? "ค้นหา task…" : "ค้นหาชื่อโปรเจกต์…";
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === S.view));
    const el = document.getElementById("view");

    if (proj) {
      document.getElementById("title").textContent = S.proj.name;
      const { d, p } = taskTotals();
      document.getElementById("sub").textContent = S.tasks === null
        ? "กำลังอ่านเอกสาร…"
        : d + " เสร็จ · " + p + " ค้าง · " + S.tasks.length + " sprint · "
          + (S.tasks.length + S.docs.length) + " ไฟล์ .md";
      el.innerHTML = S.view === "timeline" ? renderProjectTimeline()
        : S.view === "kanban" ? renderProjectKanban() : renderProjectTable();
      return;
    }
    document.getElementById("title").textContent = "Data View";
    renderKpis();
    const shown = filtered().length;
    document.getElementById("sub").textContent = ROWS.length + " โปรเจกต์" + (shown !== ROWS.length ? " (แสดง " + shown + ")" : "") + " · อ่านจากไฟล์ .md";
    el.innerHTML = S.view === "table" ? renderTable() : S.view === "kanban" ? renderKanban() : renderTimeline();
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab"); if (!t) return; S.view = t.dataset.view; render();
  });
  document.getElementById("kpis").addEventListener("click", (e) => {
    const c = e.target.closest(".kpi"); if (!c) return; S.statusFilter = c.dataset.f; render();
  });
  document.getElementById("q").addEventListener("input", (e) => { S.q = e.target.value; render(); });
  document.getElementById("back").addEventListener("click", exitProject);
  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
    if (S.proj) { S.tasks = null; vscode.postMessage({ type: "get_tasks", path: S.proj.path }); render(); }
  });
  document.getElementById("view").addEventListener("click", (e) => {
    const gh = e.target.closest(".gh");
    if (gh) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: "open_github", url: gh.dataset.url }); return; }
    const doc = e.target.closest(".doc");
    if (doc) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: "open_doc", file: doc.dataset.f }); return; }
    if (S.mode === "project") {
      if (e.target.closest(".planrow")) { S.planOpen = !S.planOpen; render(); return; }
      const sp = e.target.closest(".sprow");
      if (sp) { const n = sp.dataset.n; S.open[n] = !S.open[n]; render(); return; }
      if (e.target.closest(".docrow")) { S.docsOpen = !S.docsOpen; render(); }
      return;
    }
    const th = e.target.closest("th");
    if (th && th.dataset.k) { if (S.sortKey === th.dataset.k) S.sortDir = -S.sortDir; else { S.sortKey = th.dataset.k; S.sortDir = 1; } render(); return; }
    const p = e.target.closest("[data-p]");
    if (p) enterProject(p.dataset.p, p.dataset.name);
  });
  window.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "index") { ROWS = m.rows || []; render(); return; }
    // ignore a late answer for a project we already navigated away from
    if (m.type === "tasks") { if (S.proj && m.path === S.proj.path) { S.tasks = m.sprints || []; S.docs = m.docs || []; S.plan = m.plan || null; render(); } return; }
    if (m.type === "enter_project" && m.path) { enterProject(m.path, baseName(m.path)); }
  });
  if (INITIAL_PROJECT) enterProject(INITIAL_PROJECT, baseName(INITIAL_PROJECT));
  else render();
</script>
</body>
</html>`;
}
