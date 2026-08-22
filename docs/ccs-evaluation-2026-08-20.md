# CCS (Claude Code Switch) — evaluation, decision, and what shipped instead

**Date:** 2026-08-20 · **Verdict: NOT adopted. MC switches provider/account itself.**
**Shipped:** `ffd2c8f` — `extension/src/commands/apiProvidersOps.ts` + the third zone
("API providers") in `extension/src/webview/accounts.ts` (the Connections panel).

Written as a handoff for another session. Everything below was read out of CCS's own
source or measured, not inferred from its marketing page. English on purpose (machine
reader); the user's decisions are quoted in the Thai he said them in.

---

## 1. The question that started it

> "เราเคยคุยเรื่องหน้า Connections ผมสงสัยว่าถ้าเราหันไปใช้ https://ccs.kaitran.ca/
> แทนจะดีกว่าไหม และถ้าใช้จริงเราได้อะไรบ้าง"

MC's **Connections** page (`missioncontrol.accounts`) has two zones today:

| zone | what it manages | mechanism |
| --- | --- | --- |
| AI accounts | Claude Pro/Max + ChatGPT-via-Codex **subscription logins** | swap the credentials FILE (`~/.claude/.credentials.json`, `~/.codex/auth.json`) — `accountsOps.ts` |
| Git | PAT per host, credential-helper status, Azure DevOps PAT expiry | `gitCredentials.ts` |

CCS overlaps **only the first zone**, and only partly.

## 2. What CCS is (measured, not claimed)

- npm `@kaitranntt/ccs`, GitHub `kaitranntt/ccs`, **MIT**, TypeScript, 2,819 stars,
  actively developed (pushed 2026-08-19).
- npm latest **8.9.0**; **unpacked 16.1 MB / 3,231 files**; 20 runtime deps including
  **`bcrypt` (native)**; installs **6 binaries**: `ccs`, `ccsd`, `ccsx`, `ccsxp`,
  `ccs-droid`, `ccs-codex`.
- **Release cadence is the headline risk: 1,064 published versions since 2025-11-05 —
  33 in the last 30 days, 10 in the last 7** (≈1.4/day sustained).
- Source split (why "build vs buy" is not one answer):

| area | files | bytes | share of `src/` |
| --- | --- | --- | --- |
| `src/cliproxy` (OAuth + refresh + routing for non-Anthropic providers) | 303 | 2.80 MB | **56%** |
| `src/auth` + `src/management` (the account-switch part — overlaps MC) | 55 | 345 KB | **~7%** |

## 3. How it actually works (file-level receipts)

### 3.1 The switch mechanism is Claude Code's own env, not CCS's invention

`ccs persist <profile>` writes the `env` block of `~/.claude/settings.json`
(`src/commands/persist-command.ts` docstring: *"Writes a profile's Claude setup to
~/.claude/settings.json for native Claude Code usage across the CLI and IDE
extension"*). Per `src/shared/claude-extension-setup.ts`:

- **account profile** → `{ env: { CLAUDE_CONFIG_DIR: <instancePath> } }`
  (line ~100: `'Claude account instance isolated through CLAUDE_CONFIG_DIR.'`, line ~198:
  `extensionEnv: { CLAUDE_CONFIG_DIR: instancePath }`)
- **API/settings profile** → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` /
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`

⇒ **There is nothing to buy for switching itself.** We can write those keys.

`ccs auth default <name>` is NOT enough for machine-level switching: it only affects
commands invoked through `ccs`. A pane that maw starts as plain `claude` ignores CCS
entirely. `ccs persist` is the only path that reaches native `claude`.

### 3.2 `ccs auth create` = spawn claude in an isolated config dir

`src/auth/commands/create-command.ts`:
- `ensureInstance(profileName, contextPolicy, { bare })` → `instancePath`
- spawns the Claude CLI with `stripClaudeCodeEnv({ ...process.env, CLAUDE_CONFIG_DIR: instancePath })`
  (~line 257) so the interactive OAuth login lands in that dir
- prints `Resources: ${effectiveBare ? 'profile-local (bare)' : 'shared with ~/.claude'}`
  and, when bare, `Mode: bare (no shared symlinks)` (~line 297)

⇒ the whole account-isolation feature is ~3 lines of spawn plus a credentials file.

### 3.3 Two independent sharing axes, defaults pointing opposite ways

**a) `shared_resource_mode`** (`src/auth/shared-resource-policy.ts`) — default **shared**.
`src/management/shared-manager/shared-dir-linker.ts` header: *"Owns the creation of the
`~/.ccs/shared/*` symlinks pointing at `~/.claude/*` and the per-instance links for
commands/skills/agents/plugins/settings."* The canonical list
(`src/management/shared-manager/types.ts`, `SHARED_ITEMS`):

```
commands (dir) · skills (dir) · agents (dir) · plugins (dir)
settings.json (file, divergencePolicy: 'newer-wins')
CLAUDE.md      (file, divergencePolicy: 'canonical-first')
```

`--bare` / `--mode profile-local` = no shared symlinks at all.

**b) `context_mode`** (`src/auth/account-context.ts`) —
`DEFAULT_ACCOUNT_CONTEXT_MODE = 'isolated'`. Opt in with `--share-context` /
`--context-group <name>`; `--deeper-continuity` additionally links
`ADVANCED_CONTINUITY_ITEMS = ['session-env','file-history','shell-snapshots','todos']`.

### 3.4 The disqualifier: transcripts move

`src/management/shared-manager/project-context-sync.ts`:
- isolated (default): each profile keeps its own `<instance>/projects`
- shared: `<instance>/projects` becomes a symlink to
  **`~/.ccs/shared/context-groups/<group>/projects`** — *not* `~/.claude/projects` —
  and there is an explicit guard: `"Skipping unsafe project merge source outside CCS roots"`

`projects/` and `history.jsonl` appear in **neither** `SHARED_ITEMS` nor
`ADVANCED_CONTINUITY_ITEMS`. So any account switch done CCS's way relocates the
transcripts, and these MC features go blind:

- `extension/src/webview/mirrorContext.ts:60` — hardcodes `~/.claude/projects`
- `extension/src/usage.ts:399` and `extension/src/commands/projectUsageScan.ts:176` —
  read `process.env.CLAUDE_CONFIG_DIR` **of the extension host**, not of the pane, so
  they still point at `~/.claude`
- ⇒ Mirror→Chat, statusline self-calibrate, budget money math

### 3.5 Install-time behaviour (safer than feared)

- `scripts/postinstall.js` creates `~/.ccs/`, `~/.ccs/shared/*`, `~/.ccs/config.yaml`,
  and only *checks* `~/.claude/settings.json` (warning if missing). It contains the
  comment *"`.claude/` directory installation moved to `ccs sync` command"*.
- ⛔ **`ccs sync` is the dangerous one**: `src/utils/claude-symlink-manager.ts` symlinks
  CCS's own shipped `.claude/*` items **into `~/.claude/*`**. That would mix CCS skills
  into our 158-skill tree and collide with the MC Skills panel + the flat+marker rule.
  **Never run `ccs sync`.**
- `scripts/preinstall.js` installs `ui/` deps but skips when `npm_config_global=true`.
- `CCS_HOME` redirects `~/.ccs` only. `SharedManager` uses `os.homedir()` directly
  (`src/management/shared-manager/orchestrator.ts`: `this.homeDir = os.homedir()`;
  `this.claudeDir = path.join(this.homeDir, '.claude')`), so **`CCS_HOME` does NOT
  sandbox `~/.claude`** — a real sandbox needs a fake `HOME` (verified:
  `HOME=/tmp/x node -e "require('os').homedir()"` → `/tmp/x`).

### 3.6 settings.json writes are careful

`src/commands/persist-command/handler.ts` merges:
`{ ...existingSettings, env: { ...preservedEnv, ...resolved.env } }` — deletes only its
own managed keys, previews the write, backs up first (`--yes` = auto-backup), has
`--list-backups` / `--restore`, and `src/commands/persist-command/secret-detection.ts`.
`ccs persist default --yes` = "Reset to native Claude defaults (clear CCS-managed overrides)".

⛔ It can also write `--permission-mode` and `--dangerously-skip-permissions` into
settings.json. **Never pass those.**

### 3.7 Machine-readable surfaces

- `ccs auth list --json` / `ccs auth show <n> --json` — real JSON
  (`src/auth/commands/list-command.ts`), fields: `name, type, is_default, created,
  last_used, context_mode, context_group, continuity_mode, shared_resource_mode,
  shared_resource_inferred, bare?, instance_path`
- `ccs api list` has **no** `--json` (`src/commands/api-command/list-command.ts`) →
  would have to read `~/.ccs/config.yaml` (schema v13)
- Full REST + WebSocket dashboard (`src/web-server/`), mounted under `/api`:
  `/api/accounts` (list, `POST /default`, bulk-pause/resume, solo, tier-lock),
  `/api/profiles`, `/api/settings`, `/api/config`, `/api/health`, `/api/auth`,
  `/api/cliproxy/*`, `/api/cliproxy/ai-providers`, `/api/cliproxy/openai-compat`,
  `/api/usage`, `/api/logs`. `dashboard_auth` is **off by default** on loopback.
- `ccs config [--port P] [--host H] [--dev]` starts it. **There is no `--no-open`** — it
  always opens a browser (`open` dep) and it calls `ensureCliproxyService()`. Therefore
  it may only ever be invoked from an explicit user click, never in the background.

## 4. The decision and its reasoning

Asked "คุ้มไหม / ของเค้าดีกว่าเราทำเองไหม", the answer split in two:

- **account/provider switching → build.** The overlap is 7% of their source, and the
  mechanism is Claude Code's own env var. We already own the vault, capture/swap, usage
  display and Git PATs.
- **subscription-login providers (Gemini, Codex, Copilot, Cursor, Kimi plan) → buy.**
  That is `src/cliproxy`, 56% of their source; not reimplementable at sane cost. It
  comes with a resident daemon + a native dep.

Then the user narrowed the scope, which removed the reason to depend on CCS at all:

> "เราคงใช้แค่ frontend เราแต่ระบบเค้าแหละ … ผมอยากให้สลับ provider ได้ สลับ account
> ของ provider เจ้านั้นๆได้ และใช้ ui ของเค้า(กรณีที่ user กดเท่านั้น)"
> → scope: **"ระดับเครื่อง (เหมือนที่เป็นอยู่)"**
> → then: **"api key ตามที่เสนอเลยแต่คือเอาให้เก็บได้หลาย provider และหลาย accout นะ"**

**API keys only ⇒ the endpoint already speaks Anthropic protocol ⇒ no translating proxy,
no daemon, nothing to install, downside genuinely zero.**

### Residuals if CCS were adopted anyway (for the record)

Mitigations exist for all but the first:

1. **Upkeep of a third-party CLI contract** — 33 releases/month. Pin = freeze = lose the
   new providers you bought it for. **Irreducible.**
2. **Supply chain** — install-time scripts, 6 PATH binaries, and its job is reading and
   writing credential files. Shrink with: `npm i @kaitranntt/ccs@<pin> --ignore-scripts
   --prefix ~/.mc/vendor/ccs` and invoke `node .../dist/ccs.js` directly (no scripts, no
   PATH). Caveat: `--ignore-scripts` skips the bcrypt build, which may break the
   dashboard (auth is off by default, so possibly harmless — untested).
3. **Blast radius on `~/.claude`** — cage it: run every ccs invocation with
   `HOME=~/.mc/ccs-home`. Verified that `os.homedir()` follows `$HOME`, and CCS derives
   `claudeDir` from it, so a caged run physically cannot see the real `~/.claude`. This
   turns "don't run `ccs sync`" from a convention into a lock.
4. **Daemon + native dep** — only for OAuth providers and the dashboard, i.e. only when
   those features are actually used.

## 5. What shipped instead (`ffd2c8f`)

`extension/src/commands/apiProvidersOps.ts` (node-only, 22 tests in
`apiProvidersOps.test.ts`) + a third zone in `extension/src/webview/accounts.ts`.

- vault `~/.claude/.mc-api-providers/<provider>/<label>.json`, file 0600 in a 0700 dir;
  **many providers, many accounts per provider**
- activate = merge the `env` block into `settings.json`; backs up to
  `settings.json.mc-bak` first and **refuses to write if the backup fails**
- `MANAGED_ENV_KEYS` are deleted before every write ⇒ switching never leaves a stale
  half-route
- ⛔ refuses all writes if `settings.json` is not a JSON object (the real file is 67.8 KB
  / 14 keys / 8 hooks — it cannot be lost)
- `liveRoute()` reads the route back **out of settings.json**, so the UI can show
  "vault says X but the file points at Y" when someone hand-edits
- deleting the active account clears the route too (never point at a deleted key)
- test button issues the smallest possible `/v1/messages` (max_tokens 1) and
  distinguishes 401 (bad key) / 404 (bad base URL) / 400 (Anthropic-shaped, wrong model)
  — a wrong base URL breaks every claude on the machine at once
- no raw key ever reaches the webview; only `maskKey()` output (`zai-…1234`)
- presets: **Anthropic (API key)** · Z.AI (GLM, `https://api.z.ai/api/anthropic`,
  verified) · อื่นๆ (paste your own). Form is **2 fields** (account name + key) after
  *"ทำไมให้ใส่เยอะจัง"*; provider name + base URL appear only for "อื่นๆ".
- **model fields removed on purpose** — the user's goal is choosing which account pays,
  not changing the model, so `ANTHROPIC_MODEL` is never written.
- **"เปิด UI ของ CCS" button** — runs `ccs config` in a VS Code terminal, only on click.
  If `ccs` is not on the login-shell PATH it shows the install command with a copy
  button and warns not to run `ccs sync`.

⛔ **OpenAI/ChatGPT cannot use this zone.** Claude Code speaks the Anthropic protocol
only; pointing `ANTHROPIC_BASE_URL` at OpenAI breaks the machine. Those accounts switch
in the existing **AI accounts** zone via the Codex CLI credentials file.

| what you have | switch it in |
| --- | --- |
| Claude subscription (Pro/Max), several accounts | AI accounts |
| ChatGPT / Codex subscription | AI accounts |
| Anthropic **API keys**, several (separate bills) | **API providers** |
| GLM/z.ai or any Anthropic-compatible endpoint | **API providers** |

## 6. Handoff — open items

1. **[RESOLVED 2026-08-21 — shipped `c0f9046`] The CCS UI button now opens a contained,
   caged install.** Installed `@kaitranntt/ccs@8.9.0` with `--ignore-scripts` into
   `~/.mc/vendor/ccs` (never global / never on PATH) and wired the button to launch it
   CAGED: `HOME=~/.mc/ccs-home node …/dist/ccs.js config`. Verified: `--version`/`--help`
   and `ccs config` all run; **unbuilt `bcrypt` does NOT break `ccs config`** — the
   dashboard serves at `127.0.0.1:3001` (dashboard_auth off on loopback, as predicted in
   §4.2). The cage holds: a caged run writes only under `~/.mc/ccs-home`, and the real
   `~/.claude/settings.json` mtime was unchanged across the run. CLIProxy is not installed
   (only the dashboard UI was wanted; it prints "CLIProxy not available" and the dashboard
   still serves). Resolution logic + shell-quoting live in
   `extension/src/commands/ccsLaunch.ts` (`resolveCcsLaunch`/`ccsLaunchCommand`, 6 tests).
   NOTE: the caged dashboard shows CCS's own (empty) state, NOT the real ~/.claude accounts
   — that is the deliberate safety trade-off. Un-caging would surface them but reintroduces
   the §3.4 transcript-relocation risk; do not un-cage without re-reading §3.4.
2. **If subscription-login providers are ever wanted** (Gemini, Codex, Copilot, Cursor,
   Kimi plan) that is the `src/cliproxy` 56%, and the daemon + native dep come with it.
   Re-read §3.4 first: their *account* mode is the part that blinds MC, their *provider*
   mode is not.
3. **A per-pane (rather than per-machine) account** was explicitly deferred — the user
   chose "ระดับเครื่อง (เหมือนที่เป็นอยู่)". Doing it later means passing a profile at
   launch, and **maw is read-only** (it is the process that runs `claude --model X`), so
   it needs either a `claude` PATH shim or per-session tmux env, plus a resolver so
   Mirror/statusline/budget follow the pane's config dir.
4. Related memory notes: `ccs-evaluated-build-native-env-switch`,
   `missioncontrol-accounts-feature`, `mc-start-project-from-clone`,
   `settings-json-inline-api-key`.
