import * as vscode from "vscode";

import { ApiError, SERVER_URL, api } from "../api";
import {
  PROJECT_STATE_KEY,
  getCurrentProjectId,
  onProjectChange,
  setCurrentProjectId,
} from "../projectState";
import { isMawUp } from "../commands/mawServe";
import { openDashboardPanel } from "./dashboard";
import { getActiveNav, initNavTracking, onActiveNavChange } from "./navState";

const POLL_MS = 10_000;
const VIEW_ID = "missioncontrol.panel";

type Project = {
  id: string;
  name: string;
  created_at?: string;
  archived_at?: string | null;
};

// Module-level — resets on every extension reload. We auto-open the
// dashboard once per session AFTER setup completes (or right away if
// setup was already done). NOT persisted in globalState — re-opening
// VS Code should land the user back on the dashboard. The singleton
// guard inside openDashboardPanel makes accidental double-calls a no-op
// anyway, so this is just to avoid stealing focus from the editor on
// every render() pass.
let dashboardAutoOpened = false;

/**
 * Activity-bar sidebar for Mission Control. Two states:
 *
 *   first run  → only a Setup button (no other controls), until setup is done.
 *   ready      → the normal Run/Control panel + live backend status; no Setup.
 *
 * "Setup done" is remembered via SecretStorage `github_token` (set by a
 * successful /setup), so it persists across reloads and machines stay set up.
 * The provider owns the healthz poll and swaps the HTML when the state flips.
 *
 * Project picker: in the ready state, a dropdown at the top lets the user
 * switch between projects. Selection persists in `context.globalState` and
 * propagates through `projectState` to api.ts (X-Project-Id header) and ws.ts
 * (per-project WS subscription).
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private mawTimer?: NodeJS.Timeout; // polls :3456 to keep the maw-ui toggle live
  private renderedSetup?: boolean; // last-rendered "needs setup" flag
  private lastOnline?: boolean; // for offline→online transition detection
  private projectsLoaded = false; // true once /projects fetched at least once
  private unsubProjectChange?: () => void;
  private unsubNav?: () => void; // active-nav (frontmost tab) subscription

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "run" && typeof msg.command === "string") {
        await vscode.commands.executeCommand(msg.command);
        // A command may have just completed setup → re-evaluate which screen
        // to show (first-run Setup vs the full panel).
        await this.render();
        // The maw-ui toggle just flipped state → refresh the button label.
        await this.pushMaw();
      } else if (msg?.type === "ready") {
        await this.tick();
        await this.pushProjectList();
        await this.pushMaw();
        this.pushActiveNav(getActiveNav()); // light the nav for the current tab
      } else if (msg?.type === "open_dashboard") {
        openDashboardPanel(this.context, getCurrentProjectId());
      } else if (msg?.type === "refreshProjects") {
        await this.pushProjectList();
      }
    });

    // Re-sync whenever the active pid changes (e.g. a sibling component called
    // setCurrentProjectId, or a fresh /project/new returned a new id). We
    // re-fetch the full list (not just the selection) because a *new* project
    // won't be in the webview's cached list yet — without the refetch the
    // label would show the raw pid until the next 10s tick (bug-audit: label
    // lag). pushProjectList swallows its own errors, so this is safe to fire
    // on every change.
    this.unsubProjectChange = onProjectChange(() => {
      void this.pushProjectList();
    });

    // Re-light the sidebar nav whenever the frontmost editor tab changes.
    this.unsubNav = onActiveNavChange((nav) => this.pushActiveNav(nav));

    void this.render();
    // Frontend-only build: no backend health poll. The only recurring probe is
    // a cheap local TCP check of :3456 so the maw-ui toggle stays in sync even
    // when maw serve is started/stopped outside the extension.
    this.mawTimer = setInterval(() => void this.pushMaw(), 5000);
    view.onDidDispose(() => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (this.mawTimer) clearInterval(this.mawTimer);
      this.mawTimer = undefined;
      this.unsubProjectChange?.();
      this.unsubProjectChange = undefined;
      this.unsubNav?.();
      this.unsubNav = undefined;
    });
  }

  /** Tell the webview which nav item (if any) matches the frontmost tab.
   *  Ready state only — the setup screen has no nav. */
  private pushActiveNav(nav: string | null): void {
    if (!this.view || this.renderedSetup !== false) return;
    this.view.webview.postMessage({ type: "activeNav", nav });
  }

  /** Setup is complete once EITHER a GitHub token has been stored by /setup
   *  OR the user explicitly clicked "Skip for now" (globalState flag).
   *  The flag lets users use Mission Control without a GitHub token (local
   *  build + review still work; PR open/merge will fail until they re-run
   *  /setup and provide one).
   */
  private async needsSetup(): Promise<boolean> {
    if (await this.context.secrets.get("github_token")) return false;
    if (this.context.globalState.get<boolean>("missioncontrol.setupCompleted")) return false;
    return true;
  }

  /** Rebuild the webview HTML only when the first-run/ready state flips. */
  private async render(): Promise<void> {
    if (!this.view) return;
    const needsSetup = await this.needsSetup();
    if (needsSetup !== this.renderedSetup) {
      this.renderedSetup = needsSetup;
      this.view.webview.html = needsSetup ? this.setupHtml() : this.panelHtml();
    }
    await this.tick();
    if (!needsSetup) {
      await this.pushProjectList();
      // Auto-open the dashboard ONCE per session once setup is done.
      // This is what makes the page-mode UX feel right — user lands on
      // the full editor-area dashboard instead of having to remember to
      // run a command. dashboardAutoOpened is module-level so it resets
      // on extension reload (which is what we want).
      if (!dashboardAutoOpened) {
        dashboardAutoOpened = true;
        openDashboardPanel(this.context, getCurrentProjectId());
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.renderedSetup) return; // first-run screen has no status dot
    // Frontend-only build: there is no backend to poll. Render the "off"
    // status immediately and never attempt a /healthz fetch or reconnect.
    const online = false;
    this.view?.webview.postMessage({ type: "status", online });
    this.lastOnline = online;
  }

  /** Probe :3456 and tell the webview whether maw ui is up, so the toggle
   *  button can label itself Start vs Stop. Panel (ready) state only. */
  private async pushMaw(): Promise<void> {
    if (!this.view || this.renderedSetup !== false) return;
    const up = await isMawUp();
    this.view.webview.postMessage({ type: "maw", up });
  }

  // ── Project picker plumbing ──────────────────────────────────────────────

  /** Fetch /projects and push the list (+ current selection) to the webview. */
  private async pushProjectList(): Promise<void> {
    if (!this.view || this.renderedSetup) return;
    try {
      // Backend shape: {active_id: str|null, projects: ProjectResponse[]}.
      // Unwrap .projects — destructuring the array directly would call
      // .filter on the wrapper object → TypeError → catch branch → dropdown
      // stuck at "(backend offline)" even when backend is up. That's the
      // exact bug that hid newly-created projects from the picker.
      const resp = await api<{ active_id: string | null; projects: Project[] }>(
        "/projects",
      );
      const list = Array.isArray(resp?.projects) ? resp.projects : [];
      this.projectsLoaded = true;
      const live = list.filter((p) => !p.archived_at);
      await this.healStaleSelection(live);
      this.view.webview.postMessage({
        type: "projects",
        projects: live,
        current: getCurrentProjectId(),
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      // Backend down → empty list. The dropdown shows "(backend offline)"
      // and the user just gets the legacy single-project behavior. tick()
      // retries this fetch once the next /healthz succeeds, so the dropdown
      // self-heals when the backend finishes its BGE-M3 startup.
      this.view.webview.postMessage({
        type: "projects",
        projects: [],
        current: getCurrentProjectId(),
        error: msg,
      });
    }
  }

  /** If the active pid points at a project that no longer exists in the live
   *  (non-archived) list — archived or hard-deleted out of band via the API —
   *  drop the stale selection so the dropdown + header label don't desync.
   *  null = fall back to the backend's global active project (legacy).
   *
   *  In-memory state and the persisted globalState value are checked
   *  independently so this self-heals regardless of which surface (sidebar
   *  poll vs dashboard) reset the in-memory value first — otherwise a stale
   *  pid could linger in globalState and resurrect on the next reload. */
  private async healStaleSelection(live: Project[]): Promise<void> {
    const isStale = (id: string | null): boolean =>
      !!id && !live.some((p) => p.id === id);
    if (isStale(getCurrentProjectId())) setCurrentProjectId(null);
    const persisted = this.context.globalState.get<string | null>(
      PROJECT_STATE_KEY,
      null,
    );
    if (isStale(persisted)) {
      await this.context.globalState.update(PROJECT_STATE_KEY, null);
    }
  }

  private head(): string {
    return `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  /* Bento design tokens — sidebar auto-follows the VS Code theme kind. */
  :root, :root[data-theme="dark"] {
    --panel:#11171d; --card:#161f28; --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --good:#3fd39a; --primaryGrad:linear-gradient(180deg,#33a6cf,#1f7ea3);
  }
  :root[data-theme="light"] {
    --panel:#f9fbfc; --card:#ffffff; --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --good:#0fa574; --primaryGrad:linear-gradient(180deg,#13a0c9,#0e88ad);
  }
  html, body { height: 100%; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px;
    color: var(--txt); background: var(--panel); margin: 0; padding: 0;
    display: flex; flex-direction: column; min-height: 100vh; }
  * { box-sizing: border-box; }
  .eyebrow { font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;
    color: var(--faint); padding: 13px 16px 10px; }
  .search { margin: 0 12px 10px; height: 30px; display: flex; align-items: center; gap: 7px; padding: 0 9px;
    border: 1px solid var(--border); border-radius: 7px; background: var(--card); }
  .search svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--faint); }
  .search input { flex: 1; border: none; background: transparent; color: var(--txt); font-size: 11.5px;
    outline: none; font-family: inherit; }
  .search input::placeholder { color: var(--faint); }
  .primaries { display: flex; flex-direction: column; gap: 7px; padding: 0 12px; }
  .pbtn { display: flex; align-items: center; justify-content: center; gap: 8px; height: 36px; width: 100%;
    border: none; border-radius: 9px; background: var(--primaryGrad); color: #fff; font-weight: 600; font-size: 13px;
    cursor: pointer; font-family: inherit;
    box-shadow: 0 2px 10px var(--accentGlow), inset 0 1px 0 rgba(255,255,255,.18); }
  .pbtn svg { width: 16px; height: 16px; }
  .pbtn:hover { filter: brightness(1.06); }
  .divider { height: 1px; background: var(--border); margin: 12px 14px; }
  .nav { display: flex; flex-direction: column; gap: 2px; padding: 0 8px; }
  .nav-item { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; background: transparent;
    border: none; color: var(--muted); font-size: 12.5px; padding: 8px 10px; border-radius: 8px; cursor: pointer;
    font-family: inherit; }
  .nav-item svg { width: 15px; height: 15px; flex-shrink: 0; }
  .nav-item:hover { background: var(--accentSoft); color: var(--txt); }
  .nav-item.active { background: var(--accentSoft); color: var(--txt); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
  .nav-item.on { color: var(--good); }
  /* Settings — prominent, pinned to the very bottom. */
  .nav-bottom { margin-top: auto; padding: 10px 12px 12px; }
  .settings-btn { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    background: var(--card); border: 1px solid var(--border2); color: var(--txt); font-weight: 600;
    font-size: 12.5px; padding: 10px 12px; border-radius: 9px; cursor: pointer; font-family: inherit; }
  .settings-btn svg { width: 16px; height: 16px; color: var(--accent2); flex-shrink: 0; }
  .settings-btn:hover { border-color: var(--accent); background: var(--accentSoft); }
  /* First-run hero — fills the panel, centered. */
  .hero { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px 18px; }
  .hero .logo { color: var(--accent2); margin-bottom: 18px; }
  .hero .logo svg { width: 40px; height: 40px; }
  .hero h2 { margin: 0 0 10px; font-size: 18px; font-weight: 600; color: var(--txt); }
  .hero p { margin: 0 0 24px; font-size: 12.5px; color: var(--muted); line-height: 1.6; max-width: 260px; }
  .hero .pbtn { min-width: 200px; margin-bottom: 8px; }
</style>`;
  }

  /** First-run: Open Claude + Setup, in the Bento palette. */
  private setupHtml(): string {
    return `<!DOCTYPE html><html><head>${this.head()}</head><body>
  <div class="hero">
    <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg></div>
    <h2>Mission Control</h2>
    <p>Frontend-only build<br>เปิด Claude Code chat ในจอหลัก</p>
    <button class="pbtn" data-cmd="missioncontrol.claude">Open Claude</button>
    <button class="pbtn" data-cmd="missioncontrol.setup">Setup</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  (function(){ var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains('vscode-light') || b.contains('vscode-high-contrast-light')) ? 'light' : 'dark'; })();
  document.querySelectorAll('.pbtn[data-cmd]').forEach((b) =>
    b.addEventListener('click', () =>
      vscode.postMessage({ type: 'run', command: b.dataset.cmd })));
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }

  /** Ready: Bento sidebar — eyebrow + search + Home/Projects primaries + a
   *  5-item nav with active state. All heavy actions live on the dashboard;
   *  this is navigation + the live maw-ui toggle. */
  private panelHtml(): string {
    const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>';
    const ICON_HOME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>';
    const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
    const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3v18M3 12h18M6 6l12 12M18 6 6 18"/></svg>';
    const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
    // Connections. ⛔ Keep in step with media/tabicons/*/connections.svg — the tab
    // icon is generated from this same shape (scripts/gen-tabicons.mjs).
    const ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6"/><path d="M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9s1.3-6.4 3.9-9z"/></svg>';
    const ICON_SERVER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>';
    const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
    return `<!DOCTYPE html><html><head>${this.head()}</head><body>
  <div class="eyebrow">Mission Control</div>
  <div class="search">${ICON_SEARCH}<input id="navSearch" type="text" placeholder="Search…" /></div>
  <div class="primaries">
    <button class="pbtn" id="openDashboard">${ICON_HOME} Home</button>
    <button class="pbtn" data-cmd="missioncontrol.orchestratorContinue">${ICON_FOLDER} Projects</button>
  </div>
  <div class="divider"></div>
  <div class="nav">
    <button class="nav-item" data-cmd="missioncontrol.createRequirement" data-label="Requirement">${ICON_DOC}<span class="nav-label">Requirement</span></button>
    <button class="nav-item" data-cmd="missioncontrol.skills" data-label="Skills">${ICON_SPARK}<span class="nav-label">Skills</span></button>
    <button class="nav-item" data-cmd="missioncontrol.accounts" data-label="Connections">${ICON_GLOBE}<span class="nav-label">Connections</span></button>
    <button class="nav-item" data-cmd="missioncontrol.localhosts" data-label="Localhosts">${ICON_SERVER}<span class="nav-label">Localhosts</span></button>
  </div>
  <div class="nav-bottom">
    <button class="settings-btn" id="settingsBtn">${ICON_GEAR}<span>Settings</span></button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  (function(){ var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains('vscode-light') || b.contains('vscode-high-contrast-light')) ? 'light' : 'dark'; })();

  // The active glow follows the ACTUAL frontmost editor tab (pushed by the host),
  // not the last click — and only lights for Skills / Accounts / Localhosts.
  function setActiveNav(nav) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    if (nav) {
      var el = document.querySelector('.nav-item[data-cmd="missioncontrol.' + nav + '"]');
      if (el) el.classList.add('active');
    }
  }
  window.addEventListener('message', (ev) => {
    var m = ev.data;
    if (m && m.type === 'activeNav') setActiveNav(m.nav || null);
  });
  document.querySelectorAll('.nav-item[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'run', command: b.dataset.cmd }));
  });
  document.getElementById('openDashboard').addEventListener('click', () => {
    vscode.postMessage({ type: 'open_dashboard' });
  });
  document.querySelectorAll('.pbtn[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ type: 'run', command: b.dataset.cmd }));
  });

  // Search filters the nav items by label.
  const search = document.getElementById('navSearch');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('.nav-item').forEach((n) => {
      const lbl = (n.dataset.label || '').toLowerCase();
      n.style.display = (!q || lbl.indexOf(q) >= 0) ? '' : 'none';
    });
  });

  document.getElementById('settingsBtn').addEventListener('click', () =>
    vscode.postMessage({ type: 'run', command: 'missioncontrol.settings' }));
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

export function registerSidebar(context: vscode.ExtensionContext): void {
  initNavTracking(context); // watch the frontmost tab so the nav reflects the real page
  const provider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
  );
}
