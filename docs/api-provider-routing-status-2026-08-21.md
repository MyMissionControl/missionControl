# API-provider routing — status, measurements, and the per-role design (2026-08-21)

Handoff note. Companion to `docs/ccs-evaluation-2026-08-20.md` (why CCS is not adopted).
Everything below was measured on this machine today, not read off a vendor page.
Environment: `claude 2.1.237 (Claude Code)`, VS Code extension `anthropic.claude-code-2.1.237`.

---

## 0. What the user actually wants

1. Keep paying with the **Claude subscription** for normal work.
2. Be able to pick **which account/provider pays** (the reason the API-providers zone exists).
3. Eventually: the build system (orches/maw) should be able to run **across providers** —
   different roles on different providers at the same time (e.g. most panes on the
   subscription, some on a GLM/z.ai coding plan).

Item 3 is **not built**. The user explicitly said "อย่าพึ่งทำ" (do not start yet) — this
document exists so the design does not have to be re-derived.

---

## 1. Current state, verified

| Thing | State | Receipt |
|---|---|---|
| API-providers zone (3rd zone of Connections) | shipped, compiled | `out/commands/apiProvidersOps.js`, `out/webview/accounts.js` contain `isAnthropicHost` |
| Any account saved? | **NO — vault is empty** | `~/.claude/.mc-api-providers/` has 0 files (dir created 2026-08-20 15:09) |
| Machine currently routed anywhere? | **NO** | `~/.claude/settings.json` → `env` holds only `ORACLE_EMBED_TIMEOUT_MS`, `ORACLE_EMBED_ATTEMPTS`; the running claude (pid 9792) has no `ANTHROPIC_*` |
| What pays today | the **subscription** | `~/.claude/.credentials.json` exists (567 B, mtime 2026-08-21 07:40) |
| Simultaneous mixed providers | **not wired** | see §4 |

⇒ The user's "it doesn't work" was **not** a bug: nothing had ever been saved, so there was
nothing to switch to. Second cause: they were typing into CCS's UI, which runs caged (§3).

---

## 2. Measurements (fake-endpoint method — reproducible, needs no real key)

Method: a 30-line python `http.server` on `127.0.0.1:8321` that logs the request path plus
the `authorization` / `x-api-key` headers and answers with a minimal valid Anthropic
`message` body. Then `claude -p "say ok" --max-turns 1` pointed at it. `claude` printed the
server's fake reply, so the request really was served by it.

```python
# sniff.py — prints one HIT line per request, answers 200 with a valid message body
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        print("HIT %s auth=%s x-api-key=%s" % (self.path,
              (self.headers.get('authorization') or '')[:40],
              (self.headers.get('x-api-key') or '')[:40]), flush=True)
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({"id":"msg_1","type":"message","role":"assistant","model":"m",
            "content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",
            "usage":{"input_tokens":1,"output_tokens":1}}).encode())
    def log_message(self,*a): pass
http.server.HTTPServer(('127.0.0.1',8321),H).serve_forever()
```

### M1 — env routing works, and it OUTRANKS the subscription login

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8321 ANTHROPIC_AUTH_TOKEN=sk-test-not-real claude -p "say ok"
→ HIT /v1/messages?beta=true auth=Bearer sk-test-not-real
```
claude itself printed:
> claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set
> and **takes precedence over your claude.ai login** — Unset it to load your organization's connectors

**So an API key does not "top up" the subscription — it replaces it, and bills the API
wallet per token.** This is the answer to "ใส่ key ของ Anthropic แล้วมันกิน subscription ไหม": no.

### M2 — the header is `Authorization: Bearer` for BOTH env vars

```
ANTHROPIC_API_KEY=sk-ant-fake (custom base URL) → HIT ... auth=Bearer sk-ant-fake  x-api-key=<empty>
```
Never `x-api-key`, at least on a custom base URL. Consequence: a test that sends *both*
headers is a false green (it passes on endpoints claude could not actually reach). Fixed —
see §5. Not measured (no real key): which header claude picks for the *default*
`api.anthropic.com` endpoint.

### M3 ⭐ `settings.json` `env` BEATS the shell environment

```
cfgA/settings.json = {"env":{... "ANTHROPIC_AUTH_TOKEN":"AAA-settings-wins"}}
CLAUDE_CONFIG_DIR=cfgA ANTHROPIC_AUTH_TOKEN=BBB-shell-wins claude -p "say ok"
→ HIT ... auth=Bearer AAA-settings-wins
```

**This kills the obvious per-pane design.** An inline `VAR=x claude` prefix is silently
overridden by whatever the global switch wrote into `~/.claude/settings.json`.

### M4 ⭐ `--settings` BEATS `settings.json`

```
CLAUDE_CONFIG_DIR=cfgA claude -p "say ok" \
  --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8321","ANTHROPIC_AUTH_TOKEN":"CCC-flag-wins"}}'
→ HIT ... auth=Bearer CCC-flag-wins
```

`--settings <file-or-json>` is therefore **the** channel for per-role routing: a per-launch
flag whose scope outranks the user config file, so a global write cannot win over it.

---

## 3. Why CCS cannot be the answer (re-verified from the installed copy)

The contained install is at `~/.mc/vendor/ccs/node_modules/@kaitranntt/ccs` (24 MB dist),
run caged by MC's button as `HOME=~/.mc/ccs-home node …/ccs.js config` (a web dashboard on
`127.0.0.1:3000`).

- **Caged ⇒ inert by design.** Anything typed into that UI lands in `~/.mc/ccs-home/…`,
  never in `~/.claude/settings.json`. The cage's own config is still empty
  (`accounts: {}`, `profiles: {}`), which is why the UI looked like it did nothing.
- **CCS has no per-project scope at all.** `dist/commands/persist-command.js` header:
  *"Writes a profile's Claude setup to ~/.claude/settings.json for native Claude Code usage
  across the CLI and IDE extension."* No `process.cwd()` in the persist path, and no
  `--local` / `--project` / `--scope` flag anywhere under `dist/commands`.
- Its account mode is even wider: `CLAUDE_CONFIG_DIR` appears 58× in `dist` — it relocates
  the whole config dir (transcripts included), which blinds Mirror→Chat, the statusline
  self-calibration and the budget math.
- Closest thing to scoped routing is **per-run**: `ccs <profile> -- <args>` sets env for the
  child process only. That is the same idea as §4 but through a dependency that ships ~1.4
  releases/day.

⛔ Never run `ccs sync` (symlinks its own skills/commands into `~/.claude`). Never pass
`--permission-mode` / `--dangerously-skip-permissions` into a persisted settings file.

---

## 4. The per-role design (NOT built — do not start without asking)

Goal: pane A on the subscription, pane B on GLM, same machine, same time.

1. **Route with `--settings`, one file per role** (M4). A pane that passes no `--settings`
   keeps using the subscription credentials — that is the desired default.
   Suggested location: reuse the existing vault dir, e.g.
   `~/.claude/.mc-api-providers/<provider>/<label>.settings.json` (0600), written from the
   same account record the zone already stores.
2. **Where the flag goes in.** maw builds each pane's launch line as a shell string typed
   into the pane, and already knows how to add flags and an env prefix:
   - `maw-js/src/config/command-logic.ts:210` `buildCommandFromConfig` →
     `applyFreshLaunch` / `applyModelFlag` / `applySystemPromptFile`
   - `maw-js/src/config/command-logic.ts:53-60` `applyChannelEnv` builds `KEY='v' <cmd>`
   - engine command comes from `config.engines[<name>].cmd`
     (`maw-js/src/config/engine-registry.ts:69` `resolveEngine`)
   ⛔ `maw-js` is legacy/read-only in this workspace — do **not** edit it. Two ways in
   without touching it: put the flag in `config.engines[<role>].cmd`, or have MC/orches
   compose the launch line it already owns.
   ⛔ Do **not** use the env-prefix path for provider routing (M3 — a global route silently
   wins over it).
3. **Single-slot is a code fact, not an oversight.** `activateApiAccount` →
   `writeManagedEnv` (`extension/src/commands/apiProvidersOps.ts:244`) deletes every key in
   `MANAGED_ENV_KEYS` before writing, so the machine-level route is exactly one provider at
   a time. Per-role routing must not go through it.

### Blocker to fix BEFORE any mixed run

`extension/src/usage.ts:128-130` — the rate table matches model ids by substring and falls
back to **opus tier ($5/$25 per MTok)** for anything unknown ("safe over-estimate"). A GLM
worker (`glm-4.6`) would therefore be billed as Opus in the budget page, inventing money
that a flat-fee coding plan never charges. Quota/flat plans need a request-count model, not
a rate table.

### Wall that is outside our control

- **Anthropic Pro/Max**: only the vendor binary can spend it (OAuth in `.credentials.json`).
  An `sk-ant-…` key is a **different wallet** (metered) — see M1.
- **GLM / z.ai coding plan**: issues an API key *and* an Anthropic-protocol base URL
  (`https://api.z.ai/api/anthropic`) ⇒ the clean path for mixed roles.
- **OpenAI**: no `/v1/messages` endpoint; needs a translating gateway (LiteLLM et al.),
  entered through the zone's "อื่นๆ" preset.
- ⚠️ **Unread**: each plan's *automation / backend-usage clause*. An orchestrator fanning
  out N panes is exactly what such clauses target, and it usually lives on a different page
  from the setup snippet. Read it before a real mixed run; "nobody has been banned yet" is
  precedent risk, not permission.

---

## 5. Code changed today (compiled, tests green)

| File | Change |
|---|---|
| `extension/src/commands/apiProvidersOps.ts` | new `isAnthropicHost()` (URL-parsed host match — `api.anthropic.com.evil.test` is refused) and `apiKeyEnvVar()`; `activateApiAccount` now writes `ANTHROPIC_API_KEY` for Anthropic's own host and `ANTHROPIC_AUTH_TOKEN` for gateways, i.e. the var each vendor documents. One var only, so a switch never leaves the loser behind. |
| `extension/src/webview/accounts.ts` | the "ทดสอบ" button used to send `x-api-key` **and** `Authorization: Bearer` together ⇒ endpoints that accept only one answered 200 = green test, then a real switch 401'd. It now sends exactly one header, chosen the same way as the env var. |
| `extension/src/commands/apiProvidersOps.test.ts` | +3 cases (vendor→var mapping, look-alike host, activating Anthropic leaves no stale `ANTHROPIC_AUTH_TOKEN`). |

`bun test apiProvidersOps.test.ts` **25 pass / 0 fail** · `accounts.client.test.ts` **4/0** ·
`npx tsc --noEmit` clean · `npm run compile` done.

**Uncommitted** in `missionControl` at time of writing: `apiProvidersOps.ts`,
`apiProvidersOps.test.ts`, `webview/accounts.ts`, plus `pendingAsk.ts` / `pendingAsk.test.ts`
(different task) and untracked `docs/ccs-evaluation-2026-08-20.md`,
`docs/handoff-agent-visibility-2026-08-21.md` (another session).

---

## 6. What the user must do to use the zone at all

Reload VS Code → Connections → **Provider ที่เข้าด้วย API key** → `+ เพิ่ม account`
→ preset + label + paste key → **ทดสอบ** → **สลับ** → open a **new** Claude REPL
(env is read at launch; live panes keep the old route). `กลับไปใช้ Anthropic` removes every
managed key and returns to the subscription.

---

## 7. Harness impact of a per-role switch — measured (2026-08-21, same session)

**Good news first: the harness survives, because `--settings` MERGES, it does not replace.**

### M5 — user-level hooks still fire under `--settings`

Config dir with a `SessionStart` hook that appends to a file, launched with
`--settings '{"env":{…"CCC-flag"}}'`:

```
A) no flag        → hook fired 1× · auth=Bearer AAA-settings
B) with --settings→ hook fired 1× · auth=Bearer CCC-flag
```

⇒ hooks (RTK rewrite, oracle stamp, token-checkpoint, the pane→session stamp the whole MC
readback tier depends on), `statusLine`, `permissions` all keep coming from the user config.
Only the keys the per-role file names are overridden. Transcript schema, `/compact`,
pane-ready scraping, worktree/marker protocols are untouched — same binary, same JSONL.

### M6 — pass a FILE, never inline JSON

```
--settings /abs/path/roleB.settings.json          → auth=Bearer DDD-from-file   ✔
--setting-sources=user,project,local + --settings → auth=Bearer DDD-from-file   ✔ (coexist)
```

⛔ Security: maw types the launch line into the pane, so an inline
`--settings '{"…AUTH_TOKEN":"sk-…"}'` would put the key in tmux scrollback **and** in
`ps`/`/proc/<pid>/cmdline` for every process on the box. Per-role routing must use a
0600 file path.

### The three real problems (none of them "harness broken")

1. ⛔⛔ **`sync-team-models` would actively break a mixed pane.**
   `orches-integrate.sh:4745` walks every pane with `@orch_member` and retypes the team's
   model in-band, reading the ack by scraping `set model to …`
   (`cmd_model_ack`, `orches-integrate.sh:4735`). On a GLM pane that means typing an
   **Anthropic** model id at a z.ai endpoint → the worker starts erroring mid-sprint. It
   fails *open* (`return 0` always, report-only by design), so nothing blocks — it just
   silently mis-configures. Needs a per-role skip before any mixed run: if the role carries a
   provider override, leave its model alone.
2. **Cost math** — `extension/src/usage.ts:128-130`, see §4: unknown ids bill at opus tier.
3. **Model vocabulary** — MC pins `--model` at launch and its picker lists Anthropic ids
   only; a GLM role needs its own id (either its `--model` or `ANTHROPIC_MODEL` inside the
   per-role settings file, which is cleaner because it travels with the route).
