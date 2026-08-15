# missionControl

VS Code extension ("Mission Control") — front-end control panel for an AI "software factory" (orchestrates maw/Oracle build teams, Claude REPLs, projects, budgets, skills, settings via a webview sidebar). **All real code lives in `extension/`, not the repo root.** Frontend-only build; the former REST/WS backend is stubbed out.

## Map
- `extension/` — the actual VS Code extension (manifest + TS `src/`; `extension/out/` is tsc-generated, gitignored).
- `extension/src/extension.ts` — entry: `activate()` registers ~24 `missioncontrol.*` commands, sidebar, status bar, session/attach registries.
- `extension/package.json` — VS Code manifest; `main`=`out/extension.js`; `contributes.commands` lists the full feature surface.
- `extension/src/webview/sidebar.ts` — `registerSidebar()`, the main activity-bar panel users see.
- `extension/src/commands/` — command impls. Convention: thin `*Panel.ts`/command files delegate to fat, pure, unit-testable `*Ops.ts`/`*Model.ts`. Colocated `*.test.ts`.
- `extension/src/webview/` — panel generators = big HTML/CSS/JS-in-TS template strings (e.g. `orchestrator.ts` ~98K, `dashboard.ts`, `mirror.ts`), not conventional modules.
- Factory flow: `extension/src/commands/startOrchestrator.ts`, `orchestratorResume.ts`, `extension/src/webview/orchestrator.ts`.
- `claude-skills/orches/SKILL.md` — versioned backup of the live `/orches` skill (synced to `~/.claude/skills/` via `claude-skills/install.sh`).

## Where to start
Enumerate features by reading `contributes.commands` in `extension/package.json` + the registration block in `extension/src/extension.ts`. For ecosystem/ghq placement + the "never git-init the soulbrew root" golden rule see `docs/PROJECT-STRUCTURE.md` (does NOT map `src/`).

## Gotchas
- **Dashboard session row — what is clickable (fixed 2026-08-04):** the session **name** and the `$ tmux attach …` line attach; a **window row** (`1:john claude`) attaches *and* selects that window (`tmux attach -t '=<sess>:<idx>'`, proved on tmux 3.4); the rest of the head toggles the expand; `✕` kills (modal). ⛔ Window rows previously rendered a `▸` chevron with **no handler at all** — the click looked broken. Any new row affordance needs both a handler and a `cursor`/hover, and a guard that fails **loudly**: the attach handler used to `return` silently when the name was not in `_lastSessionNames` (session died between poll and click), which is indistinguishable from a dead button — it now warns + re-pushes the list.
- **⛔⛔ Copy-mode swallows the pendingAsk keystrokes (guarded 2026-08-14):** a tmux pane in copy-mode eats every `send-keys` — the call still exits 0, so the popup reported "ส่งให้ … แล้ว" while the agent stayed blocked on its box and the run parked silently. Seen live on `09-foreman`; `#{pane_in_mode}` was 1 and `send-keys -X cancel` unstuck it. The entry is ordinary: the orches layout sets `mouse on` (that is what makes the status bar clickable), so one wheel notch over a pane enters copy-mode, and with `scroll=0` nothing on screen shows it. `answerSingle`/`answerMulti` now call `leaveCopyMode()` before the first keystroke (`buildInModeArgs` → `isInMode` → `buildUncopyArgs`, all pure + tested in `pendingAsk.test.ts` K1-K3). ⛔ A failed probe counts as "not in a mode" and we send anyway — refusing to answer on a tmux hiccup would cause the exact stall this prevents. ⛔ Other send paths in the extension (`claudeSessions.ts` attach-file, `teamUpModel.ts`) have the same exposure and are **not** guarded yet.
- **Backend disabled**: `extension/src/api.ts` (`BACKEND_DISABLED=true`) and `extension/src/ws.ts` are no-op stubs — `api()` always rejects, `WSClient` never connects, so WS handlers in `extension.ts` (ideas_ready, pr_ready, agent_progress…) never fire. Reads like a live client/server system; it isn't.
- **Tests**: no `test` npm script (only setup/compile/watch). Run `bun test`; `*.test.ts` is excluded from the tsc build (tsconfig `exclude`) — that's why pure logic is split into `*Ops.ts`/`*Model.ts` (no `vscode` needed at test time).
- `req.md` is an UNRELATED spec (an "agentSkill marketplace" website the tool builds), not this extension's requirements.
- `agents/1-*` are gitignored maw worktree = full duplicate checkouts; `ψ/` is gitignored Oracle runtime. Never edit code there — real source is `extension/src/`.
