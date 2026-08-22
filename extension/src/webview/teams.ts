import * as vscode from "vscode";

import {
  availableModels,
  createTeam,
  deleteTeam,
  listTeamSummaries,
  oracleCandidates,
  prepareAwakenMember,
  readTeamDetailSync,
  saveTeam,
  teamExists,
} from "../commands/teamsOps";
import {
  COLOR_OPTIONS,
  DEFAULT_ROLE,
  ROLE_OPTIONS,
  isSafeTeamName,
  normalizeOracle,
  type TeamMember,
} from "../commands/teamsModel";
import { getDefaultMemberModel } from "../commands/settingsOps";
import { isSafeRuntimeId, normalizeRuntimeId, RUNTIME_OPTIONS } from "../commands/teamRuntimes";
import { awakenMember, teamUp, teamUpMember, type TeamUpResult } from "../commands/teamUp";
import { setTabIcon } from "./tabIcon";

// Editor-area panel for browsing + editing maw oracle-teams. Mirrors skills.ts:
// singleton _panel, renderShell HTML, postMessage list/detail, a message switch.
// Three in-panel views (list → detail → new) swapped client-side. Membership +
// roles persist through the maw CLI (teamsOps); description + model/color are
// data-file writes into maw's own stores (no CLI verb exists). Rename is out of
// scope for v1 (no CLI verb; would touch 3 stores + the sessions pin).
let _panel: vscode.WebviewPanel | undefined;

const OPTIONS = {
  roleOptions: [...ROLE_OPTIONS],
  colorOptions: [...COLOR_OPTIONS],
  defaultRole: DEFAULT_ROLE,
};

// defaultModel is resolved fresh each push (not baked into OPTIONS) so a change
// on the Settings page takes effect without reopening the panel. The Settings
// knob default_member_model drives what a new/empty member row pre-selects.
function panelOptions() {
  // runtimeOptions rides along with the rest of the vocabulary so the picker has
  // exactly one source for what a runtime may be — the same list the engine's
  // adapter switch knows about.
  return { ...OPTIONS, defaultModel: getDefaultMemberModel(), runtimeOptions: [...RUNTIME_OPTIONS] };
}

function pushList(panel: vscode.WebviewPanel) {
  panel.webview.postMessage({ type: "team_list", teams: listTeamSummaries() });
}

async function pushDetail(panel: vscode.WebviewPanel, name: string) {
  const team = readTeamDetailSync(name);
  const candidates = oracleCandidates(team.members.map((m) => m.oracle));
  const modelOptions = await availableModels();
  panel.webview.postMessage({
    type: "team_detail",
    team,
    candidates,
    ...panelOptions(),
    modelOptions,
  });
}

/** Coerce a webview-sent member list into clean TeamMember[]. */
function sanitizeMembers(raw: unknown): TeamMember[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamMember[] = [];
  for (const m of raw) {
    // Normalize to the oracle STEM: `maw bud <stem>` makes repo <stem>-oracle,
    // so a typed "fusion-oracle" would become "fusion-oracle-oracle". Strip it.
    // Shared with the panel's duplicate check (normalizeOracle) so both agree.
    const oracle = normalizeOracle(typeof m?.oracle === "string" ? m.oracle : "");
    if (!oracle) continue;
    out.push({
      oracle,
      role: typeof m?.role === "string" && m.role.trim() ? m.role.trim() : DEFAULT_ROLE,
      model: typeof m?.model === "string" && m.model.trim() ? m.model.trim() : undefined,
      color: typeof m?.color === "string" && m.color.trim() ? m.color.trim() : undefined,
      // ⛔ This function is the SECOND place a new per-member field gets dropped
      //   silently (the first is readMembers in the client script). Anything not
      //   copied here never reaches saveTeam, and the picker looks like it did
      //   nothing — no error, the value just reverts on reload.
      runtime:
        typeof m?.runtime === "string" && isSafeRuntimeId(m.runtime)
          ? normalizeRuntimeId(m.runtime)
          : undefined,
      memory: m?.memory === true,
    });
  }
  return out;
}

/** Where the user should look after a wake, worded from the view that actually
 *  opened (chat webview vs editor terminal) — a toast that says "attach ใน
 *  terminal" while the chat opened is worse than no toast. */
function viewWord(r: TeamUpResult): string {
  return r.chat ? "เปิดใน Claude Chat" : "attach ใน terminal";
}

export function openTeamsPanel(
  context: vscode.ExtensionContext,
  _projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.teams",
    "Team Config",
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
    switch (msg.type) {
      case "ready":
      case "reload":
        pushList(panel);
        return;
      case "open_team":
        if (typeof msg.name === "string") void pushDetail(panel, msg.name);
        return;
      case "new_team": {
        const modelOptions = await availableModels();
        panel.webview.postMessage({
          type: "team_new",
          candidates: oracleCandidates([]),
          ...panelOptions(),
          modelOptions,
        });
        return;
      }
      case "save_team": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) {
          // busy() already disabled the Save button — must release it or it
          // stays stuck at "Working…" forever.
          vscode.window.showErrorMessage(`Teams: ชื่อทีมไม่ถูกต้อง: '${name}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const members = sanitizeMembers(msg.members);
        const description = typeof msg.description === "string" ? msg.description : "";
        const r = await saveTeam(name, description, members);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: บันทึก '${name}' แล้ว`
            : `Teams: บันทึก '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        await pushDetail(panel, name);
        return;
      }
      case "team_up": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) {
          vscode.window.showErrorMessage(`Teams: ชื่อทีมไม่ถูกต้อง: '${name}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const r = teamUp(context, name);
        if (r.error) {
          vscode.window.showErrorMessage(`Teams: team up '${name}' — ${r.error}`);
        } else if (r.minted) {
          vscode.window.showInformationMessage(
            `Teams: '${name}' มี session อยู่แล้ว → เปิด instance ใหม่ '${r.session}' (${viewWord(r)})`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Teams: team up '${name}' → session '${r.session}' (${viewWord(r)})`,
          );
        }
        // Opening a terminal returns immediately — release the button.
        panel.webview.postMessage({ type: "op_done" });
        return;
      }
      case "team_up_member": {
        const name = typeof msg.name === "string" ? msg.name : "";
        const oracle = typeof msg.oracle === "string" ? msg.oracle : "";
        if (!isSafeTeamName(name) || !isSafeTeamName(oracle)) {
          vscode.window.showErrorMessage(`Teams: ชื่อทีม/oracle ไม่ถูกต้อง: '${name}' / '${oracle}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const r = teamUpMember(context, name, oracle);
        if (r.error) {
          vscode.window.showErrorMessage(`Teams: wake '${oracle}' — ${r.error}`);
        } else if (r.minted) {
          vscode.window.showInformationMessage(
            `Teams: '${name}' มี session อยู่แล้ว → ปลุก '${oracle}' เข้า instance ใหม่ '${r.session}' (${viewWord(r)})`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Teams: ปลุก '${oracle}' → session '${r.session}' (${viewWord(r)})`,
          );
        }
        panel.webview.postMessage({ type: "op_done" });
        return;
      }
      case "awaken_member": {
        const name = typeof msg.name === "string" ? msg.name : "";
        const oracle = typeof msg.oracle === "string" ? msg.oracle : "";
        const role = typeof msg.role === "string" && msg.role.trim() ? msg.role.trim() : DEFAULT_ROLE;
        if (!isSafeTeamName(name) || !isSafeTeamName(oracle)) {
          vscode.window.showErrorMessage(`Teams: ชื่อทีม/oracle ไม่ถูกต้อง: '${name}' / '${oracle}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        // Confirm — awaken creates a NEW oracle repo and starts the ~5-20min birth
        // ritual, so guard the (mis)click behind a modal (like delete_team).
        const pick = await vscode.window.showWarningMessage(
          `awaken '${oracle}'? — สร้าง oracle ใหม่ (repo ในเครื่อง) แล้วเปิด Claude pane ยิง /awaken (พิธี 5–20 นาที). ตัวที่มีอยู่แล้วทำไม่ได้ (กันทับ identity)`,
          { modal: true },
          "Awaken",
        );
        if (pick !== "Awaken") {
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        // Birth-only guard + scaffold + invite + charter sync (refuses existing names).
        const prep = await prepareAwakenMember(name, oracle, role);
        if (!prep.ok) {
          vscode.window.showErrorMessage(`Teams: awaken '${oracle}' — ${prep.errors.join(" · ")}`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const r = awakenMember(context, name, oracle);
        if (r.error) {
          vscode.window.showErrorMessage(`Teams: awaken '${oracle}' — ${r.error}`);
        } else {
          vscode.window.showInformationMessage(
            `Teams: สร้าง+awaken '${oracle}' → session '${r.session}' (พิธีเปิดใน ${
              r.chat ? "Claude Chat" : "terminal"
            } · ถ้า /awaken ไม่ขึ้นใน pane พิมพ์เอง)`,
          );
        }
        await pushDetail(panel, name); // refresh — the new member now shows (as stub until the ritual runs)
        return;
      }
      case "create_team": {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!isSafeTeamName(name)) {
          vscode.window.showErrorMessage(
            `Teams: ชื่อทีมไม่ถูกต้อง (ใช้ได้แค่ A-Z a-z 0-9 . _ -): '${name}'`,
          );
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        // Guard against ALL stores (incl. the ψ vault maw checks) so a duplicate
        // — even a vault-only ghost — is caught here with a clean message rather
        // than reaching maw and failing with a cryptic error.
        if (teamExists(name)) {
          vscode.window.showErrorMessage(`Teams: ทีม '${name}' มีอยู่แล้ว`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const members = sanitizeMembers(msg.members);
        const description = typeof msg.description === "string" ? msg.description : "";
        const r = await createTeam(name, description, members);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: สร้าง '${name}' (${members.length} สมาชิก) แล้ว`
            : `Teams: สร้าง '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        if (r.ok) {
          pushList(panel); // refresh list, then jump into the new team
          await pushDetail(panel, name);
        } else {
          // Stay on the form so the user can fix + retry; re-enable its button.
          // (Do NOT pushList here — it re-renders the list view over the form,
          // wiping the typed name/members the user needs to fix.)
          panel.webview.postMessage({ type: "op_done" });
        }
        return;
      }
      case "delete_team": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) return;
        const pick = await vscode.window.showWarningMessage(
          `ลบทีม '${name}'? (ลบสมาชิก+config ของทีมนี้ — oracle แต่ละตัวไม่ถูกลบ)`,
          { modal: true },
          "Delete",
        );
        if (pick !== "Delete") return;
        const r = await deleteTeam(name);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: ลบ '${name}' แล้ว`
            : `Teams: ลบ '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        pushList(panel);
        panel.webview.postMessage({ type: "go_list" });
        return;
      }
      case "close":
        panel.dispose();
        return;
    }
  });

  return panel;
}

export function renderShell(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  /* Bento tokens — Team Config follows the VS Code theme kind (data-theme). */
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#11171d; --editor:#0f151b; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --dot:rgba(255,255,255,.028); --primaryGrad:linear-gradient(180deg,#33a6cf,#1f7ea3);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --dot:rgba(15,30,45,.035); --primaryGrad:linear-gradient(180deg,#13a0c9,#0e88ad);
  }
  :root { --pad:20px; --cardpad:15px; --radius:14px; --fs:13.5px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--uifont); font-size: var(--fs); color: var(--txt);
    background: var(--editor);
    background-image: radial-gradient(var(--dot) 1px, transparent 1px); background-size: 24px 24px;
    display: flex; flex-direction: column; overflow: hidden; }
  * { box-sizing: border-box; }
  .topbar { padding: 14px var(--pad) 12px; border-bottom: 1px solid var(--border); }
  .topbar-inner { display: flex; align-items: center; gap: 11px; max-width: 820px; margin: 0 auto; width: 100%; }
  .topbar h1 { font-size: 19px; margin: 0; font-weight: 700; letter-spacing: -.3px;
    display: flex; align-items: center; gap: 9px; }
  .topbar h1 .count { font-family: var(--mono); font-size: 12px; font-weight: 400; color: var(--faint);
    background: var(--card); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; margin: 0; }
  .topbar .actions { display: flex; gap: 8px; margin-left: auto; }
  button { display: inline-flex; align-items: center; gap: 6px; background: var(--card); color: var(--txt);
    border: 1px solid var(--border2); padding: 5px 12px; border-radius: 7px; font-size: 12px; font-weight: 500;
    cursor: pointer; font-family: var(--uifont); }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--primaryGrad); color: #fff; border: none; font-weight: 600;
    box-shadow: 0 2px 8px var(--accentGlow); }
  button.primary:hover { filter: brightness(1.06); }
  button.danger { background: #da3633; color: #fff; border-color: #da3633; }
  button.danger:hover { filter: brightness(1.06); border-color: #da3633; }
  .topbar .actions button { height: 32px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; }
  .topbar .actions button svg { width: 13px; height: 13px; }
  .content { flex: 1; overflow-y: auto; padding: var(--pad); max-width: 820px; margin: 0 auto;
    width: 100%; box-sizing: border-box; }
  .empty { color: var(--faint); font-size: 13px; padding: 24px 0; }

  .team-card { display: flex; align-items: center; gap: 13px;
    padding: var(--cardpad); margin-bottom: 9px; border-radius: var(--radius); cursor: pointer;
    background: var(--card); border: 1px solid var(--border); transition: border-color .12s; }
  .team-card:hover { border-color: var(--accent); }
  .team-card .tc-name { font-size: calc(var(--fs) + 1px); font-weight: 700; }
  .team-card .tc-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .team-card .tc-chev { margin-left: auto; color: var(--faint); display: flex; flex-shrink: 0; }
  .team-card .tc-chev svg { width: 15px; height: 15px; }

  label { font-size: 11px; opacity: 0.8; display: block; margin: 10px 0 3px; }
  input[type=text], textarea, select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px; padding: 5px 7px; font-size: 12px; box-sizing: border-box;
    font-family: var(--vscode-font-family); }
  input[type=text], textarea { width: 100%; }
  .hdr-config { border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 16px; }
  .hdr-config .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .hdr-config h2 { font-size: 15px; margin: 0; }

  table.members { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.members th { text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: .06em; opacity: .55; padding: 4px 6px; font-weight: 600; }
  table.members td { padding: 4px 6px; border-top: 1px solid var(--vscode-panel-border); }
  table.members .oracle-name { font-size: 12px; font-weight: 600; }
  /* Identity highlight — faint colour on oracles that have a real identity,
     gradient-fading to the normal row background (subtle, left→right). */
  table.members td.oracle-cell.awoken {
    background: linear-gradient(90deg, rgba(63,185,80,0.22), transparent 72%); }
  table.members input.oracle-new { width: 100%; min-width: 130px; }
  table.members select.role { min-width: 120px; }
  table.members select.model { min-width: 120px; }
  table.members select.color { width: 92px; }
  table.members select.runtime { min-width: 92px; }
  table.members td.mem-cell { text-align: center; }
  table.members input.memory { cursor: pointer; }
  table.members input.memory:disabled { opacity: 0.35; cursor: not-allowed; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px;
    vertical-align: middle; }
  .note { font-size: 11px; opacity: 0.6; margin-top: 8px; line-height: 1.5; }
  .barrow { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
  .x { color: #f85149; cursor: pointer; font-weight: 700; border: none; background: none; font-size: 14px; }
  .wake { color: #3fb950; cursor: pointer; font-weight: 700; border: none; background: none;
    font-size: 12px; padding: 0; margin-right: 6px; }
  .awaken-btn { color: #e3b341; background: none; border: 1px solid #e3b341; border-radius: 4px;
    font-size: 11px; padding: 1px 8px; margin-right: 8px; cursor: pointer; }
  .awaken-btn:hover { background: rgba(227,179,65,0.14); }
  /* Delete (✕) is gated behind the "จัดการ" toggle so it can't be hit by accident;
     ▶ wake stays visible. Default = manage-off = ✕ hidden. */
  .members-wrap.manage-off .x:not(.x-keep) { display: none; }
  .manage-toggle { color: var(--vscode-descriptionForeground); background: none;
    border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 1px 8px;
    font-size: 11px; cursor: pointer; }
  .manage-toggle:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  table.members th.th-manage { text-align: right; text-transform: none; letter-spacing: 0; opacity: 1; }
  table.members tr.dup td { background: rgba(248,81,73,0.09); }
  table.members tr.dup .oracle-new { border-color: #f85149; box-shadow: 0 0 0 1px #f85149; }
  table.members tr.dup .oracle-name { color: #f85149; }
  .dup-msg { color: #f85149; font-size: 12px; margin: 12px 0 0; display: none; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
</style></head>
<body>
  <div class="topbar"><div class="topbar-inner">
    <h1 id="title">Teams <span class="count" id="count"></span></h1>
    <div class="actions" id="topActions"></div>
  </div></div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
<script>
  const vscode = acquireVsCodeApi();
  (function(){ var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains('vscode-light') || b.contains('vscode-high-contrast-light')) ? 'light' : 'dark'; })();
  let VIEW = "list";
  // Team of the detail view — set while editing an existing team, "" otherwise.
  // The "awaken" button (create+ritual) only makes sense for a team that exists,
  // so it's shown/wired only when this is set.
  let DETAIL_TEAM = "";
  let OPT = { roleOptions: [], colorOptions: [], modelOptions: [], runtimeOptions: ["claude"], defaultRole: "worker", defaultModel: "claude-sonnet-5" };
  const COLOR_HEX = { blue:'#4ea1ff', green:'#3fb950', red:'#f85149', yellow:'#e3b341',
    magenta:'#d2a8ff', cyan:'#39c5cf', white:'#e6edf3', orange:'#f0883e' };

  function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function el(id){ return document.getElementById(id); }
  function post(type, extra){ vscode.postMessage(Object.assign({ type: type }, extra||{})); }
  // Disable a submit button on click so a create/save can't be double-fired
  // while the extension is mid-maw (a create with new members takes seconds).
  // Returns true if already busy (caller should bail). The extension re-enables
  // via an "op_done" message on failure; on success it re-renders a fresh DOM.
  function busy(btn){
    if (btn.disabled) return true;
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = 'Working…';
    return false;
  }
  function clearBusy(){
    var b = document.querySelector('button[data-label]');
    while (b){ b.disabled = false; b.textContent = b.dataset.label; delete b.dataset.label;
      b = document.querySelector('button[data-label]'); }
  }

  function optionList(values, sel){
    return values.map(v => '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(v)+'</option>').join('');
  }
  function roleSelect(sel){
    var val = sel || OPT.defaultRole;
    var opts = (OPT.roleOptions || []).slice();
    if (opts.indexOf(val) < 0) opts.unshift(val); // preserve an out-of-vocab stored role instead of silently selecting the first option (orchestrator)
    return '<select class="role">'+optionList(opts, val)+'</select>';
  }
  function colorSelect(sel){
    var opts = '<option value=""'+(!sel?' selected':'')+'>—</option>'
      + OPT.colorOptions.map(c => '<option value="'+esc(c)+'"'+(c===sel?' selected':'')+'>'+esc(c)+'</option>').join('');
    return '<select class="color">'+opts+'</select>';
  }
  function modelSelect(sel){
    var def = OPT.defaultModel || 'claude-sonnet-5';
    if (!sel || sel === 'claude') sel = def; // no model, or the bare engine name "claude" maw writes → default to sonnet-5
    var strip = function(v){ return String(v).replace(/^claude-/, ''); }; // display without the provider prefix; value keeps the full id
    var opts = (OPT.modelOptions || []).slice();
    if (opts.indexOf(sel) < 0) opts.unshift(sel); // keep a stored/default value not already in the list
    var body = opts.map(function(v){ return '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(strip(v))+'</option>'; }).join('');
    return '<select class="model">'+body+'</select>';
  }
  // runtime = which agent CLI drives this worker. claude opens a REPL and gets the
  // brief pasted in; codex runs headless and receives the brief WITH the command —
  // different shape, same team. The engine reads this from runtimes.json.
  function runtimeSelect(sel){
    var opts = (OPT.runtimeOptions || ['claude']).slice();
    if (!sel) sel = 'claude';
    if (opts.indexOf(sel) < 0) opts.unshift(sel); // never drop a stored value we do not recognise
    var body = opts.map(function(v){
      return '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(v)+'</option>'; }).join('');
    return '<select class="runtime" title="claude = REPL ในเพน · codex = รันรวดเดียวแบบ headless">'+body+'</select>';
  }
  // ⛔ memory is a PRIVILEGE toggle, not a preference: turning it on makes codex run
  //   with --approve-for-me, which flips approval from never (every escalation
  //   refused) to on-request (an automatic reviewer decides). The title says so —
  //   a checkbox labelled only "memory" would hide the trade.
  function memoryToggle(on, runtime){
    var headless = !!runtime && runtime !== 'claude';
    // ⛔⛔ disabled AND checked is an unreachable state: greyed out reads as "off" to
    //   the eye, readMembers still reports true, and the user cannot clear it —
    //   reproduced in real Chromium (click, synthetic mouse press, Space: all no-op).
    //   A disabled control must therefore never carry a tick. The on argument is ignored
    //   for a non-headless runtime, so the picture and the saved value always agree.
    var ticked = headless && on;
    var t = headless
      ? 'ให้ worker นี้เรียก oracle_learn/oracle_trace ได้ ⚠ ต้องรันด้วย --approve-for-me (approval never → on-request)'
      : 'claude ต่อความจำผ่าน MCP ของตัวเองอยู่แล้ว — ช่องนี้มีผลกับ runtime แบบ headless เท่านั้น';
    return '<input type="checkbox" class="memory"'+(ticked?' checked':'')
      + (headless?'':' disabled')+' title="'+esc(t)+'">';
  }
  function swatch(c){ return c ? '<span class="sw" style="background:'+(COLOR_HEX[c]||'#8b949e')+'"></span>' : ''; }

  // ── List view ──────────────────────────────────────────────────────────────
  function renderList(teams){
    VIEW = "list"; DETAIL_TEAM = "";
    el("title").innerHTML = 'Teams <span class="count">'+teams.length+'</span>';
    el("topActions").innerHTML =
      '<button class="primary" onclick="post(\\'new_team\\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New Team</button>'
      + '<button onclick="post(\\'reload\\')">Reload</button>';
    el("content").innerHTML = teams.length
      ? teams.map(t =>
          '<div class="team-card" data-name="'+esc(t.name)+'">'
          + '<div><div class="tc-name">'+esc(t.name)+'</div>'
          + '<div class="tc-meta">'+t.memberCount+' สมาชิก · '+esc((t.roles||[]).join(', ')||'—')+'</div></div>'
          + '<div class="tc-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></div></div>'
        ).join('')
      : '<div class="empty">ยังไม่มีทีม — กด + New Team</div>';
    el("content").querySelectorAll('.team-card').forEach(c =>
      c.addEventListener('click', () => post('open_team', { name: c.dataset.name })));
  }

  // ── Member table (shared by detail + create) ────────────────────────────────
  function memberRowHtml(m, editableOracle, candidates){
    var nameCell = editableOracle
      ? '<input type="text" class="oracle-new" list="oracle-suggest" placeholder="ชื่อ oracle ใหม่" value="'+esc(m.oracle||'')+'">'
      : '<span class="oracle-name">'+esc(m.oracle)+'</span>';
    var wakeBtn = editableOracle ? '' : '<button class="wake" title="ปลุก '+esc(m.oracle)+' คนเดียว">▶</button>';
    // On a NEW-name row (detail view), offer "awaken": create the oracle + run the
    // /awaken ritual now. Plain Save on the same row = bud (bare scaffold, no ritual).
    var awakenBtn = (editableOracle && DETAIL_TEAM)
      ? '<button class="awaken-btn" title="สร้าง oracle ใหม่ + ทำพิธี /awaken ทันที (กด Save เฉยๆ = bud โครงเปล่า)">awaken</button>'
      : '';
    // Identity highlight: oracles whose CLAUDE.md has a real identity get a faint
    // colour wash on the name cell, fading to normal. title = non-colour cue.
    var nameAttrs = ' class="oracle-cell'+(m.awaken === 'identity' ? ' awoken' : '')+'"'
      + (m.awaken === 'identity' ? ' title="ตั้งตัวตนแล้ว"'
         : m.awaken === 'stub' ? ' title="ยังไม่ตั้งตัวตน"' : '');
    // A NEW (editable) row's ✕ = "cancel this row" and must stay visible even when
    // manage mode is off (x-keep exempts it from the .manage-off gate). An existing
    // member's ✕ = "remove", which stays gated behind manage.
    var rmBtn = editableOracle
      ? '<button class="x x-keep" title="ยกเลิกแถวนี้">✕</button>'
      : '<button class="x" title="ลบ">✕</button>';
    return '<tr>'
      + '<td'+nameAttrs+'>'+nameCell+'</td>'
      + '<td>'+roleSelect(m.role)+'</td>'
      + '<td>'+modelSelect(m.model||'')+'</td>'
      + '<td>'+runtimeSelect(m.runtime||'')+'</td>'
      + '<td class="mem-cell">'+memoryToggle(m.memory===true, m.runtime||'claude')+'</td>'
      + '<td>'+swatch(m.color)+colorSelect(m.color)+'</td>'
      + '<td>'+wakeBtn+awakenBtn+rmBtn+'</td>'
      + '</tr>';
  }
  function readMembers(tbody){
    var out = [];
    tbody.querySelectorAll('tr').forEach(function(tr){
      var newInput = tr.querySelector('.oracle-new');
      var nameSpan = tr.querySelector('.oracle-name');
      var oracle = newInput ? newInput.value.trim() : (nameSpan ? nameSpan.textContent : '');
      if (!oracle) return;
      out.push({
        oracle: oracle,
        role: tr.querySelector('.role').value,
        model: tr.querySelector('.model').value.trim(),
        // ⛔ optional-chain both: a row rendered by an older panel build (or a future
        //   one that drops a column) must degrade to the default, not throw and take
        //   the whole Save down with it.
        runtime: (tr.querySelector('.runtime') || {}).value || 'claude',
        // ⛔ read the tick ONLY when the control is enabled — a disabled input's
        //   .checked is not something the user can act on, so reporting it as intent
        //   is how the stuck-grant bug reached disk in the first place.
        memory: (function(){ var c = tr.querySelector('.memory'); return !!(c && !c.disabled && c.checked); })(),
        color: tr.querySelector('.color').value,
      });
    });
    return out;
  }
  // ── Duplicate-name guard ─────────────────────────────────────────────────────
  // Mirrors teamsModel.normalizeOracle / findDuplicateOracleNames (a webview
  // script can't import). Uses a Set (NOT a plain object) so oracle names like
  // "toString"/"constructor" don't collide with Object.prototype keys.
  function normOracle(s){
    s = String(s == null ? '' : s).trim();
    return s.slice(-7) === '-oracle' ? s.slice(0, -7) : s;
  }
  function duplicateNames(names){
    var seen = new Set(), dup = new Set();
    names.forEach(function(n){
      var k = normOracle(n);
      if (!k) return;            // blank rows are never a duplicate
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    });
    return dup;
  }
  function rowNames(tbody){
    return Array.prototype.map.call(tbody.querySelectorAll('tr'), function(tr){
      var ni = tr.querySelector('.oracle-new');
      var ns = tr.querySelector('.oracle-name');
      return ni ? ni.value : (ns ? ns.textContent : '');
    });
  }
  // Highlight every row in a duplicated-name group, show the message, and block
  // Save until the roster is unique. Runs live (typing/add/remove) + on render.
  function validateMembers(root){
    var tbody = root.querySelector('tbody'); if (!tbody) return;
    var trs = tbody.querySelectorAll('tr');
    var names = rowNames(tbody);
    var dup = duplicateNames(names);
    Array.prototype.forEach.call(trs, function(tr, i){
      var k = normOracle(names[i]);
      tr.classList.toggle('dup', !!k && dup.has(k));
    });
    var list = []; dup.forEach(function(k){ list.push(k); });
    var msg = el('dupMsg');
    if (msg){
      if (list.length){
        msg.textContent = '⚠ ชื่อ oracle ซ้ำ: ' + list.join(', ') + ' — แก้ให้ไม่ซ้ำก่อนบันทึก';
        msg.style.display = 'block';
      } else {
        msg.textContent = ''; msg.style.display = 'none';
      }
    }
    // Don't fight busy(): only manage the disabled state when the button isn't
    // mid-save (busy() tags it with data-label while a save/create is in flight).
    var save = el('saveTeam') || el('createTeam');
    if (save && !save.dataset.label) save.disabled = list.length > 0;
  }

  function wireMemberTable(root, candidates){
    var tbody = root.querySelector('tbody');
    function bindRow(tr){
      var x = tr.querySelector('.x');
      if (x) x.addEventListener('click', function(){ tr.remove(); validateMembers(root); });
      var inp = tr.querySelector('.oracle-new');
      if (inp) inp.addEventListener('input', function(){ validateMembers(root); });
      // ⛔ mem is only meaningful for a headless runtime, so its enabled state is
      //   DERIVED from the runtime select and must follow it live.
      // ⛔⛔ Switching BACK to claude must CLEAR the tick, not carry it. An earlier
      //   version kept it "so codex→claude→codex would not silently revoke the
      //   grant" — that reasoning produced the opposite: a checked+disabled box the
      //   user cannot clear, saved as memory:true for a claude worker, which then
      //   fires --approve-for-me the moment anyone flips that worker back to codex.
      //   Re-ticking after a flip is one click; an invisible standing grant is not
      //   recoverable by the person looking at the screen.
      var rtSel = tr.querySelector('.runtime');
      if (rtSel) rtSel.addEventListener('change', function(){
        var mem = tr.querySelector('.memory');
        if (!mem) return;
        var headless = this.value && this.value !== 'claude';
        var keep = headless && mem.checked;
        mem.parentNode.innerHTML = memoryToggle(keep, this.value);
      });
      var awk = tr.querySelector('.awaken-btn');
      if (awk) awk.addEventListener('click', function(){
        if (busy(this)) return;
        var ni = tr.querySelector('.oracle-new');
        var oracle = ni ? ni.value.trim() : '';
        if (!oracle) { clearBusy(); return; } // nothing typed — release + no-op
        var roleSel = tr.querySelector('.role');
        post('awaken_member', { name: DETAIL_TEAM, oracle: oracle, role: roleSel ? roleSel.value : 'worker' });
      });
    }
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), bindRow);
    // "จัดการ" toggle: reveal/hide the ✕ delete buttons for the whole roster.
    var mgt = root.querySelector('.manage-toggle');
    if (mgt) mgt.addEventListener('click', function(){
      var wrap = this.closest('.members-wrap');
      var off = wrap.classList.toggle('manage-off'); // true => now hidden
      this.textContent = off ? 'manage' : 'done';
    });
    var addBtn = root.querySelector('.add-member');
    if (addBtn) addBtn.addEventListener('click', function(){
      // Always addable — a blank row where you TYPE a new (or existing) oracle
      // name; brand-new names get scaffolded into a real oracle on Save.
      var holder = document.createElement('tbody');
      holder.innerHTML = memberRowHtml({ oracle: '', role: OPT.defaultRole }, true, candidates);
      var row = holder.firstElementChild;
      tbody.appendChild(row);
      bindRow(row);
      var inp = row.querySelector('.oracle-new'); if (inp) inp.focus();
      validateMembers(root);
    });
    validateMembers(root); // initial state — flags divergent stores that already dup
  }
  function memberTableHtml(members, editableOracle, candidates){
    // Shared suggestions: existing oracle names autocomplete in the text input,
    // but you can also just type a brand-new name to create one.
    var dl = '<datalist id="oracle-suggest">'
      + (candidates||[]).map(function(c){ return '<option value="'+esc(c)+'">'; }).join('')
      + '</datalist>';
    // Gate the ✕ delete on an established roster (detail view = !editableOracle).
    // While building a NEW team (editableOracle) keep ✕ handy for instant undo.
    var gate = !editableOracle;
    var toggle = gate
      ? '<button type="button" class="manage-toggle" title="แสดง/ซ่อนปุ่มลบสมาชิก">manage</button>'
      : '';
    return '<div class="members-wrap'+(gate?' manage-off':'')+'">'
      + '<table class="members"><thead><tr>'
      + '<th>oracle</th><th>role</th><th>model</th><th>runtime</th><th title="ต่อความจำ (oracle_learn/oracle_trace) ให้ worker แบบ headless">mem</th><th>color</th>'
      + '<th class="th-manage">'+toggle+'</th>'
      + '</tr></thead><tbody>'
      + members.map(function(m){ return memberRowHtml(m, editableOracle, candidates); }).join('')
      + '</tbody></table></div>' + dl
      + '<div class="barrow"><button class="add-member">＋ Add member</button></div>';
  }

  // ── Detail view ─────────────────────────────────────────────────────────────
  function renderDetail(m){
    VIEW = "detail";
    OPT = { roleOptions: m.roleOptions, colorOptions: m.colorOptions,
      modelOptions: m.modelOptions || [], runtimeOptions: m.runtimeOptions || ["claude"],
      defaultRole: m.defaultRole, defaultModel: m.defaultModel };
    var t = m.team;
    DETAIL_TEAM = t.name; // enables the per-row "awaken" button (detail view only)
    el("title").innerHTML = 'Team · '+esc(t.name);
    el("topActions").innerHTML =
      '<button onclick="post(\\'reload\\')">← Teams</button>'
      + '<button onclick="post(\\'close\\')">Close</button>';
    el("content").innerHTML =
      '<div class="hdr-config">'
      + '<div class="row"><h2>'+esc(t.name)+'</h2>'
      + '<div style="display:flex;gap:6px">'
      + '<button class="primary" id="teamUp" title="maw team up — ปลุกทีมนี้เข้า tmux session แล้ว attach (ถ้ามี session อยู่แล้วเปิด instance ใหม่ -N)">▶ Team up</button>'
      + '<button class="danger" id="delTeam">🗑 Delete team</button></div></div>'
      + '</div>'
      + '<label>สมาชิก ('+t.members.length+')</label>'
      + memberTableHtml(t.members, false, m.candidates)
      + '<div class="dup-msg" id="dupMsg"></div>'
      + '<div class="barrow"><button class="primary" id="saveTeam">Save</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    content.querySelectorAll('.wake').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (busy(this)) return;
        var span = this.closest('tr').querySelector('.oracle-name');
        post('team_up_member', { name: t.name, oracle: span ? span.textContent : '' });
      });
    });
    el("delTeam").addEventListener('click', function(){ post('delete_team', { name: t.name }); });
    el("teamUp").addEventListener('click', function(){
      if (busy(this)) return;
      post('team_up', { name: t.name });
    });
    el("saveTeam").addEventListener('click', function(){
      if (busy(this)) return;
      post('save_team', {
        name: t.name,
        members: readMembers(content.querySelector('tbody')),
      });
    });
  }

  // ── New team view ────────────────────────────────────────────────────────────
  function renderNew(m){
    VIEW = "new"; DETAIL_TEAM = "";
    OPT = { roleOptions: m.roleOptions, colorOptions: m.colorOptions,
      modelOptions: m.modelOptions || [], runtimeOptions: m.runtimeOptions || ["claude"],
      defaultRole: m.defaultRole, defaultModel: m.defaultModel };
    el("title").innerHTML = 'New Team';
    el("topActions").innerHTML =
      '<button onclick="post(\\'reload\\')">← Teams</button>'
      + '<button onclick="post(\\'close\\')">Close</button>';
    el("content").innerHTML =
      '<div class="hdr-config">'
      + '<label>ชื่อทีม (A-Z a-z 0-9 . _ -)</label>'
      + '<input type="text" id="newName" placeholder="เช่น alpha">'
      + '</div>'
      + '<label>สมาชิก</label>'
      + memberTableHtml([], true, m.candidates)
      + '<div class="dup-msg" id="dupMsg"></div>'
      + '<div class="barrow"><button class="primary" id="createTeam">Create</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    el("createTeam").addEventListener('click', function(){
      if (busy(this)) return;
      post('create_team', {
        name: el("newName").value,
        members: readMembers(content.querySelector('tbody')),
      });
    });
  }

  window.addEventListener("message", function(e){
    var m = e.data;
    if (!m || !m.type) return;
    if (m.type === "team_list") renderList(m.teams || []);
    else if (m.type === "team_detail") renderDetail(m);
    else if (m.type === "team_new") renderNew(m);
    else if (m.type === "go_list") post('reload');
    else if (m.type === "op_done") clearBusy();
  });
  post("ready");
</script></body></html>`;
}
