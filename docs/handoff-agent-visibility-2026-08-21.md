# Hand-off: Mission Control cannot tell the human an agent is stuck

Paste this whole file into a fresh session. It is self-contained.

## Situation

Mission Control (MC) is a VS Code extension that supervises tmux-based Claude Code agent teams. Repo: `/home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl`. Extension source: `<repo>/extension/src`. Tests: `bun test` from `<repo>/extension`. Typecheck: `npx tsc --noEmit` from `<repo>/extension`.

On 2026-08-20/21 an orchestrator team ran five sprints in tmux session `09-foreman` (foreman in window 0, workers in windows 1-3). It **blocked twice waiting for a human decision** and nothing told the human. A supervising agent found it both times by running `tmux capture-pane` by hand, and hand-built three throwaway bash monitors during the day to cover: an agent blocked on the human, a worker pane disappearing, a protected branch moving, and per-worker progress.

MC already ships the blocked-agent detector (`extension/src/commands/pendingAsk.ts` + `pendingAskWatch.ts`), and its regexes were tested against the real frame the team displayed — they matched, all four options parsed including Thai labels. **The detector is fine. It was never running**, and once it does run, several defects below make it untrustworthy.

Verified 2026-08-21, independently, three ways: `code --list-extensions` has no `mission*` entry; `~/.vscode/extensions/extensions.json` has 10 entries and none is MC; no `*mission*` extension-host log directory exists under `~/.config/Code/logs/`. MC has only ever run in an F5 Extension Development Host.

An audit ran 42 findings through adversarial verification; 36 survived and are the basis for this document. Where a verifier corrected the original claim, the corrected version is what is written here.

## Hard constraints

- **`extension/src/webview/orchestrator.ts` has UNCOMMITTED work from another live session.** Do not write to it. Two fixes below want to touch it — do the half that lives elsewhere, and **stop and ask the human** before touching that file.
- Do not commit or push unless the human says so.
- **`npm run compile` before telling the human to reload VS Code.** A reload alone does not pick up TypeScript changes — this has wasted time here before.
- Every fix needs a **red-proof**: run the new test against the unfixed code and show it failing, then show it passing. Do not claim a test is meaningful without that.
- Thai is the user-facing language in this codebase's UI strings. Match the surrounding style.

## Order of work, and why

Tier 0 first because until MC is installed, nothing else is observable and no fix can be confirmed by the human. Tier 1 next because a detector that cries wolf or types a digit into a busy agent's composer is worse than no detector — get it trustworthy before you make it louder. Tier 2 is where the hours actually go (a dead run that reads as "working"), and it contains one genuinely destructive bug. Tier 3 is additive surfacing and can slip.

---

## Tier 0 — make MC installable, then install it

There is no install path at all: no `.vsix`, no `vsce` dependency, no `package` or `install` script, no `.vscodeignore`.

**0a. `vsce package` aborts on interactive prompts.** `cd extension && printf '' | npx @vscode/vsce@3.9.2 package` fails with `Error: Aborted` — it stops on a missing `repository` field and a missing LICENSE. Fix: add to `extension/package.json` a `repository` (`https://github.com/MyMissionControl/missionControl.git`) and `"license": "UNLICENSED"` (or a real LICENSE file), and pin the flags in a new `"package"` script. Add `"vscode:prepublish": "npm run compile"` so `out/` can never ship stale.

**0b. The package is 114 MB / 6519 files.** `vsce ls` really collects 119.4 MB where a correct package needs about 259 files / 6.2 MB. The bulk is `scripts/mirror-bridge` (63 MB, a gitignored dead Windows node-pty prototype), stale `node_modules` (46 MB), plus `src/`, tests and sourcemaps. Fix: add `extension/.vscodeignore` excluding `src/**`, `**/*.test.ts`, `**/*.js.map`, `ψ/**`, `docs/**`, `scripts/**`, `media/xterm/**`, `tsconfig.json`, lockfiles. Test: assert `vsce ls` yields zero paths matching `^(src/|ψ/|scripts/)`, `\.test\.ts$` or `\.js\.map$`, and total bytes under 10 MB — it fails today at 6519 files.

**0c. The obvious size fix breaks the extension completely.** `marked` is the extension's only runtime `node_modules` require and it is reached at module-load time (`extension/src/commands/projectDocs.ts:3`), so `--no-dependencies` or a blanket `node_modules/**` exclude makes the whole extension fail to load *before* `activate()` runs. Either keep an explicit `!node_modules/marked/**` re-include, or bundle with esbuild (`"vscode:prepublish": "esbuild src/extension.ts --bundle --external:vscode --platform=node --outfile=out/extension.js"`), which also collapses ~3800 JS files to one and makes 0b's node_modules problem moot. Note the repo's own `docs/vsix-team-distribution.md` points a developer toward `--no-dependencies` — fix that doc too.

**Then install it and confirm with the human that the blocked-agent status bar appears.** That confirmation is the acceptance test for this whole tier; do not move on without it.

---

## Tier 1 — make the blocked-agent detector trustworthy

**1a. (worst) A busy agent is reported as blocked, and "answering" types a digit into its composer.** `FOOTER_RE = /Esc to cancel/` (`extension/src/commands/pendingAsk.ts:45`) is also drawn by the TUI's todo panel. Fix: require the footer to be the **last non-blank line** of the capture (measured: real permission modal 0 lines below the footer, real AskUserQuestion box 0, real todo panel 2 — the pane's own `⏵⏵ accept edits on` bar), and add a spinner/busy guard before a pane is reported at all (port `ORCHES_BUSY_RE` from `orches-integrate.sh:139-145`). Test in `pendingAsk.test.ts`: the verbatim todo-panel capture preceded by numbered plan lines must give `parseAskFromPane === null`; the same frame with `✽ Cogitating… (1m 7s)` prepended must also be null. Red today.

**1b. A header-less permission modal harvests phantom options.** `parseAskFromPane`'s 60-line upward walk only stops at `HEADER_RE`, so ordinary numbered output above a header-less modal becomes options 4..9. Clicking one sends a digit the modal cannot accept, MC reports "sent", and `_seen` then suppresses the box forever. Fix: `break` on `FOOTER_RE` inside the upward walk — a second footer is the previous box's boundary — and reject a parse whose digits are not contiguous `1..N`. When header and question cannot be found, render read-only (hand off to the pane) rather than offering a send affordance. Test: a two-box fixture must return only the current box's digits, never the older frame's.

**1c. The only alarm fails silent-closed.** `pendingAskWatch.ts:129`'s `tmux()` wrapper collapses exec failure, missing binary, wrong socket and "no server" into one `null`, so `sweep()` returns `[]`, the status bar hides and an open box is closed — with no log and no on-screen reason. Fix: return `{ok:true,out} | {ok:false,err}`; distinguish tmux's real "no server running" from an exec failure; on exec failure keep the previous hits, leave any open box up, and set the status bar to a warning (`$(alert)` with the stderr in the tooltip) — the same "say why on screen, not in a log" doctrine `autoOpenSkipReason` already follows.

**1d. `_seen` is never pruned.** `pendingAskWatch.ts:72` — unlike `_firstSeen`/`_nagged` which are pruned at :409-410. Two consequences: an identical question re-asked in the same pane never auto-opens again, and one transient tmux blip permanently demotes a live question to a silent status-bar item. Fix: prune keys absent from the live hit set, and make `closeOpen()` skip the `_seen.add` at :359 when the close was driven by a failed/empty sweep rather than a human Esc. Test via a pure `reconcileSeen(seen, liveKeys)`: K seen → K disappears → K returns ⇒ auto-openable again.

**1e. The attach gate is per-session, so a blocked worker in an unviewed window is downgraded.** `pendingAskWatch.ts:457` counts tmux clients per session with no window/pane visibility. Once anything is attached — including MC's own `openPane` terminal, which makes it permanent — a blocked worker in a non-viewed window becomes a status-bar item only. Fix: add `#{window_active}`, `#{pane_active}`, `#{window_index}` to `PANE_LIST_FMT` and treat "the box is on their screen" as `clients>0 AND windowActive AND paneActive`; anything else falls through to the normal auto-open/nag path, with a real `showWarningMessage` + "ไปที่เพน" action for attached-but-not-visible. Test the pure `shouldShowOwnAsker({clients, windowActive, paneActive})` then run `scanPending` over a 4-row pane list where only one row is active and assert the other three still auto-open. Note: this does **not** bite on the default chat view mode, which launches detached (clients=0) — so it is a real gap but not the one that hit today.

**1f. No surface names the blocked agent.** With four worker panes open, the status tooltip carries only the session and the popup adds an opaque `%NN` pane id — never the worker's `@orch_member`/role. Small fix, large practical difference.

**1g. Two stale doc strings.** `extension/package.json:143`'s `nagMinutes` description and `pendingAsk.ts:414-421`'s `nagDue` docstring both still describe pre-`2ac91ac` behaviour; since that commit the nag is gated behind the attach rule, so for an attached operator `nagMinutes` is a status-bar-warning knob, not the "re-pop the box" knob it advertises.

---

## Tier 2 — a dead or hung run must not read as "working"

**2a. (destructive — do this one carefully) One failed tmux probe round kills every live orchestrator run.** The spin poll's reap treats "could not ask tmux" identically to "session is gone", then renders `session ดับ` as if the run died on its own. Fix has two halves:
- **Do now:** `extension/src/commands/startOrchestrator.ts:327` — make `tmuxHasSession` tri-state (`boolean | null`): only `e.status === 1` means "no such session"; anything else (`e.code` set, `status` null) is unknown. Unit-test with an injected spawner: `null` on ENOENT, `false` only on `status===1`.
- **Needs the human first:** the consumer at `extension/src/webview/orchestrator.ts:317-338` must treat `null` as "assume still running" and require N consecutive confirmed-absent ticks before `reapSession` may fire. That file is held by another session — **ask before touching it.** A destructive action must never be driven by a probe that failed.

**2b. A death is silently converted into a success.** Same poll: a marker still saying `running` whose session vanished is reaped exactly like a clean finish. Fix: classify the transition — marker flipped to `done`/`error`/absent = real finish (reap silently); marker still `running` + session gone = death, so write `{status:"error", errorMsg:"session ดับกลางรัน (ไม่ได้เขียน done/error)"}` via the existing `writeRunMarker`, raise one `showWarningMessage` naming the project, and capture the pane scrollback before `kill-session` (orches-drive ships `capture-session.sh`) so the evidence survives. Put the classifier in a pure helper so it is testable without the webview: `classifyRunTransition` — marker running + session gone → `died`; marker done → `finished`.

**2c. No watchdog: `startedAt` is written, validated, and never read.** `startOrchestrator.ts:557` writes it; the parse guard makes it mandatory; `resolveButtonState` takes no clock. A run whose session is alive but wedged stays `⟳ กำลังทำ` forever and keeps the card's continue/delete buttons locked. Fix: a pure `runStallVerdict({startedAt, heartbeatAt, nowMs, stallMs, hardCapMs}): "ok"|"stalled"|"overrun"` (same shape as `previewOps.ts:138`), and give `resolveButtonState` a `nowMs`. Thresholds go in `package.json` config (`missioncontrol.run.stallMinutes` default 15, `hardCapMinutes` default 0 = off) so a legitimately long sprint can raise them instead of being mislabelled. Test with a fixed `nowMs` — pure, no clock flake.

**2d. The engine already publishes a liveness verdict and MC never reads it.** The orches engine writes `driver-alive` (`ALIVE|IDLE|SELF|DEAD|NONE`) and a `heartbeat` key into `.orches-state`; MC reads that file for exactly one key, `owner-session` (`startOrchestrator.ts:336-341`). Fix: add an `ownerHeartbeat(projectPath)` reader beside it using the already-imported `parseStateValue`, feed it into `resolveButtonState` so `running + session alive + heartbeat older than ORCHES_HEARTBEAT_STALE` resolves to a hung state, and keep the threshold reading the same env default (600s) so MC and the engine cannot drift. Pin the pairing in `orchesParity.test.ts`, which exists for exactly these cross-repo contracts. **Reuse MC's existing `@orches_label` + `sessionCreatedAt` scoping** — that is precisely why the engine needed its `SELF` branch, and ignoring it will make MC diagnose itself as the driver.

**2e. No per-worker liveness: a dead worker under a live orchestrator renders `⟳ กำลังทำ` forever.** Fix: add `workers: {expected, alive}` (or `rolesAlive: string[]`) to `resolveButtonState` (`continueRun.ts:135`) and return a new `"broken"` state when `marker.status === "running" && live.alive && alive < expected`. `mirror.ts:511-527`'s `awakeWorkerSet()` already computes that set and can be reused verbatim. **Do not detect this by diffing tmux pane ids** — `orches-integrate.sh:7307` warns pane ids are not stable across revive, so a naive diff false-positives after a legitimate re-dispatch. Include a test that pins the revive case as *not* a death.

**2f. All crash detection is render-time and dies with the panel.** The only always-on watcher is `pendingAskWatch` (4s); the run-health and reap poll live inside the Orchestrator panel (`extension/src/extension.ts:113` is where activation-time watchers are registered). Fix: a `runHealthWatch.ts` modelled directly on `pendingAskWatch.ts` — `initRunHealthWatch(context)` called from `extension.ts`, polling ~30s over `scanProjects()` for `running` markers, surfacing through a status bar item plus one non-focus-stealing warning per project per incident (reuse the `_seen`/`_nagged` de-dup pattern). Move the reap/finish bookkeeping out of the panel so panel-open state stops gating detection; leave the panel poll doing render refresh only. Split the pure part out per the `vscode-ext-split-pure-for-bun-test` convention already used across this repo, and test that two successive snapshots of a dead run yield exactly one alert.

---

## Tier 3 — surface signals the engine already writes

The engine writes machine-readable per-role events to `.orches-dispatch` and more keys to `.orches-state`. **MC has zero readers for `.orches-dispatch` anywhere**, and reads one key of `.orches-state`.

**3a. One pure module, `extension/src/commands/orchesSignals.ts`** (no vscode import, bun-testable, same pattern as `orchestratorResume.ts`): `parseDispatchLedger(raw): LedgerRow[]` and `latestPerRole(rows)`, plus thin `parseStateValue` wrappers for `sprint`, `status`, `open-roles`, `poll-result-<role>`, `dispatch-pane-<role>`. **Reuse the engine's own round rule** (`orches-integrate.sh:5913`: `assigned`/`dispatched`/`needs_attention` open a round; `done`/`landed` close it) rather than inventing one. Test against the real ledger fixture, and add a parity case to `orchesParity.test.ts` asserting the TS parser reads back exactly what the bash `dispatch-log` command wrote.

**3b. "Sprint finished, safe to review" is unrepresentable.** `RunStatus` (`continueRun.ts:15`) has no `paused-checkpoint`, so a checkpoint-paused run renders as `busy`; and a hand-started run writes no `.orches-run.json`, so the completion poll never starts. Fix: add `paused-checkpoint` to the union with a distinct "รอรีวิว" chip, and have `scanProjects()` also read `.orches-state` for `status` + `sprint` so the poll can start when either a running marker exists or the state says in-progress. Note the union change makes the test fail to *typecheck* before the fix — that is your red-proof.

**3c. Per-role progress.** Extend the message that already exists rather than adding a surface: add `verdict` (last ledger event) and `sinceMs` to each worker entry in `mirror.ts:288-292` — the worker selector already renders one chip per worker, so this is a label change, not a layout change — and put the same three-line summary on the always-visible sidebar card. **Do not parse `.orches-progress.md` prose**; the ledger event is a machine token and the engine itself warns against reading worker summaries.

**3d. Root cause worth fixing once:** four of the five signals live in panel-scoped polls, there is no filesystem watcher anywhere, and `scanProjects` only walks `projects/` — so a run on any other repo is structurally unobservable. Promote **one** always-on watcher rather than adding four: extend `pendingAskWatch`'s existing tick (it already runs `tmux list-panes -a` every 4s) to derive each Claude pane's project root by walking up to the nearest dir containing `.orches-state` — which is not restricted to `projects/` — then diff against the previous tick and publish into the two always-visible surfaces (its own status bar item, and the sidebar card). Leave the dashboard and orchestrator panels alone. Test a pure `advanceRunState(prev, cur)`: one "sprint finished, awaiting review" event on the transition, none when `cur` repeats, and assert the upward `.orches-state` walk resolves a project outside `projects/`.

---

## Do not do these

- **Do not "fix" the frozen `0.0.1` version.** The claim that reinstalling a rebuilt vsix silently no-ops was investigated and **refuted** on the installed VS Code 1.133.0. Adding `vscode:prepublish` (Tier 0a) is still worthwhile for stale `out/`, but do not build version-bumping machinery to solve a problem that does not exist.
- **Do not wire `limitHit.ts` as-is.** It is dead code (only its own test imports it) and it is stale: `nextResetMs` parses only `(UTC)`, while every one of the 34 real rate-limit records since 2026-08-04 says `(Asia/Bangkok)` — 5/39 parse. Wiring it unchanged ships a warning with no reset time. If you consume it, fix the timezone parse first and add the false-positive guard its own header calls for (a conversation line merely containing the words `rate_limit` must not match).
- **Do not treat "main moved" as a defect.** MC's `baseMainSha` is capture-once/consume-once-by-cancel by design, and per-role merge enforcement already runs unskippably inside `cmd_land`'s hard guard. Nothing to build here.
- **Do not exclude `node_modules/**` wholesale** (see 0c) — it kills activation before `activate()`.
- **Do not detect dead workers by diffing pane ids** (see 2e) — false-positives after every legitimate revive.
- **Do not add a wall-clock rate limit anywhere near watch/progress logic** if you touch adjacent code; that pattern is explicitly ruled out in this ecosystem because 2x playback and fast-forward are normal.

## Verify at the end

1. `cd <repo>/extension && npx tsc --noEmit` — 0 errors.
2. `bun test` from `<repo>/extension` — full suite green, and state the before/after counts.
3. `npm run compile`, then have the human reload VS Code.
4. **An end-to-end check, not only unit tests:** with MC installed, drive a real tmux pane into a choice box and confirm the status bar and popup appear and name the right pane; then drive the todo panel into view and confirm it is **not** reported (that is 1a's real proof). A unit test on a fixture is necessary but not sufficient here — the whole point of this hand-off is that the fixture passed while reality did not.
5. Do not report an item as done without its red-proof output.

## Report back

Say which items you fixed, which you skipped and why, and which findings you believe are wrong. Several of these were rewritten during verification because the first reading was mistaken — the same may be true of what survived. **Push back rather than implementing something you think is wrong**, and stop and ask before touching `extension/src/webview/orchestrator.ts`.
