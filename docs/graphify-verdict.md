# Why graphify is not worth adopting in the soulbrew workspace

**As of 2026-07-27.** Written to be read *without access to this codebase* — everything you need is in this file.
**Audience:** another AI agent (or engineer) who is about to propose "let's index this codebase with a code-graph tool to save context." Read this first.
**Status of the decision:** NOT ADOPTED as a default tool. **One narrow use is worth wiring** (see §6). Nothing in the workspace was modified to produce this document.

> ## UPDATE 2026-07-27 (later the same day) — the two open questions are now closed
>
> §10 previously listed two UNTESTED items as the things that could change the verdict. Both were then tested against the current release (**0.9.29**, which superseded 0.9.28 the same day), run from an unpacked wheel, no install, all repos verified pristine.
>
> - **Q1: "does the newer version still print edge directions backwards?" — FIXED, decisively.** On the identical query and graph, 0.9.18 printed all 14 edges as outgoing (**11 of them backwards**); 0.9.29 printed 10 deduplicated edges with **directions 10/10 verified correct against live source**, each carrying a new `at=file:Lnn` **call-site** anchor (also verified byte-correct). Determinism is fixed too: 5 identical runs gave **5 different outputs on 0.9.18, 1 on 0.9.29.** So §5.1 — previously the single biggest reason against — no longer applies to 0.9.29.
> - **Q2: "does it resolve TypeScript instance-method calls?" — NOT FIXED.** A full fresh rebuild of `maw-js` on 0.9.29 (64 s, out of tree) reproduces the old result exactly: the `sendText` method at `src/core/transport/tmux-class.ts:505` has **1 inbound edge** (class containment), **0 inbound `calls` edges**, against **49 real call sites in 27 files** (23 in `src/` across 13 files); the wrapper `sendPromptViaTmux` (`wake-cmd.ts:697`) still has **0 outgoing edges**. §5.2 stands unchanged.
>
> **A fresh measurement then replaced the fix's benefit with a cheaper objection.** With directions correct, graphify was re-raced on the same question. For "who calls `createStorageBackend`": a one-pass `awk` returns **all 8 `src/` call sites with enclosing function in 392 bytes**; graphify 0.9.29 costs **2,979 bytes** (`explain`) or **6,441 bytes** (`query`) for a *less* complete answer. **`awk` is 7.6x cheaper and more complete.** So "who calls X" still does not belong to graphify — but see the next point, which is the reason the verdict moved.
>
> **What did change the verdict:** `affected "<symbol>" --relation calls --depth 2` on 0.9.29 returns a **49-entry transitive caller closure with correct file:line anchors in 3,047 bytes, in one call** (depth 3: 53 entries, 3,256 bytes), surfacing second-order callers grep cannot reach without N sequential rounds (`writeSqliteBackup`, `createExportCoreRoutes`, `exportOracleData`, `backupCommand`, `mineCommand`, `getTenantDb`, `buildDataExportPayload`). Note the `--relation calls` filter is what makes this usable: without it, depth 2 balloons to 16,786 bytes dominated by "which test file imports this."
>
> **ACTED ON, same day.** The four changes below were then applied and verified. Two things learned during execution correct this document:
> - **`built_at_commit` is NOT written by 0.9.29's `update`, on either code path.** A clustered rebuild produced graph-level attributes of `{}`. So "drop `--no-cluster` to get a commit anchor" — asserted in §5.3 and in the old memory note — is **wrong for 0.9.29**. Freshness is now tracked by a hand-written sidecar `~/.oracle/graphify/<repo>/BUILT_AT.json` holding `{repo_path, commit, built_at, graphify_version, nodes, edges}`.
> - **`GRAPHIFY_OUT` (absolute) combined with the clustered default path WORKS** — this combination had never been run before. All output including `graph.html`, `GRAPH_REPORT.md`, `cache/` and `.graphify_labels.json` landed outside the repo; every repo verified `dirty=0` with no `graphify-out/`. Clustering needed no API key and added ~0.6 s.
> - Minor: 0.9.29 writes a different top-level JSON shape (`directed` / `multigraph` / `graph` / `hyperedges` + `nodes` / `links`) than 0.9.18 (`input_tokens` / `output_tokens` / `nodes` / `links`). It reads the old shape fine. Note `directed: false` — direction survives only because each serialized edge carries an ordered `source`/`target` pair, which 0.9.29's renderer now reads correctly.
>
> Applied: **(1)** the memory note was rewritten and its index line corrected; **(2)** graphify upgraded 0.9.18 → **0.9.29** into the stable home (`UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` pinned, else it lands in a snap-revision path that breaks on VS Code updates); **(3)** the three stale graphs rebuilt clustered and out of tree, backed up first — orches-skills 338→530 nodes / 442→702 edges (0.8 s), missionControl 1304→1414 / 2615→2918 (4.1 s), oracle-autoskills 51→214 / 100→270 (0.9 s; the 4x jump is larger than 4 commits explains, so the old graph was evidently built with narrower coverage); **(4)** a thin skill at `~/.claude/skills/graphify-impact/SKILL.md` (~121 tokens always-loaded, ~1,266 on invoke). Acceptance test on the fresh missionControl graph: `affected "readTeamDetailSync()" --relation calls --depth 2` → **803 bytes, 11 transitive callers, 6 of 6 spot-checked anchors correct against live source**, including four second-order callers invisible at depth 1.
>
> **Revised bottom line:** upgrade to 0.9.29 and keep graphify for exactly one job — **transitive impact analysis on TypeScript repos whose call style is exported functions** (`arra-oracle-v3` today; `missionControl` after a ~5 s rebuild). Everything else in this document stands, including the whole of §8 DO-NOT. `maw-js` remains out of reach, and single-hop "who calls X" stays with `awk`.

---

## 1. TL;DR (30 seconds)

> Read the UPDATE block above first — it revises reason 1 below and the bottom line. The four reasons are kept as originally written because §9 (how the old verdict went wrong) depends on them.

graphify builds a code graph (a queryable map of "which function calls which") so an agent can ask structural questions instead of reading whole files. On this workspace it was measured head-to-head against the boring baseline — `rg` (ripgrep) to find the symbol, then read only the located lines — and **it lost 5 out of 5 questions on bytes-into-context**, on a graph that was 100% fresh, on the question shape it is designed for.

The four reasons it does not pay here, in order of how much each one matters:

1. **The query output cannot be trusted.** Running the identical command five times returns five different answers, and roughly a quarter of the returned edges point the wrong way — so "who calls X" silently returns "what X calls" for some rows. Measured on a graph with verified-perfect line accuracy, so this is not a staleness problem and cannot be rebuilt away.
2. **This workspace's most important repo is method-heavy, and method calls do not resolve.** One key method with 20 real call sites shows up in the graph with 1 incoming edge. The graph is fresh; the resolver just misses this call style.
3. **The graphs that matter go stale, and staleness is undetectable.** The two repos worked in daily drift to 52% and 71-83% line accuracy. The tool's own freshness check prints nothing and exits successfully, so a cron job around it would report "fine" forever.
4. **It cannot answer cross-repo questions, and trying is actively harmful.** This workspace is ~12 separate repos, and the highest-value questions cross repo boundaries. The merge feature produces zero cross-repo connections while silently reversing 9,828 edge directions and inventing 496 nodes that exist in neither input.

The one thing that *does* pay: `graphify explain "<symbol you already know the name of>"` returns a caller/callee neighbourhood in ~450 bytes where the `rg` equivalent costs ~4,700 — and `graphify affected "<symbol>" --depth 2` finds *transitive* dependents, which grep genuinely cannot do in a single pass. That is a thin, occasional win, not a platform.

**Important:** the file-type story is a red herring. Bash and Markdown parse fine (195 of 195 bash functions recovered exactly, every line number byte-correct). If you have read a note claiming "bash/md not parsed," that note is wrong — see §9.

---

## 2. What you need to know about the two things being weighed

### graphify
A Python CLI (PyPI package `graphifyy`; installed here as version 0.9.18, latest is 0.9.28). It walks a repo with tree-sitter parsers, extracts symbols (functions, classes, files, markdown headings) as **nodes** and relationships (`calls`, `imports`, `contains`, `defines`, `references`, `extends`) as **edges**, and writes them to a single `graph.json`. Building the graph costs **zero LLM tokens** — it is pure AST parsing, no API key needed. Reading it back is done with a handful of CLI verbs:

- `query "<natural language question>"` — breadth-first walk from guessed seed nodes, printed as a token-budgeted list of `NODE` and `EDGE` lines.
- `explain "<exact node label>"` — plain-language description of one node plus its immediate neighbours.
- `affected "<exact node label>" --depth N` — reverse traversal: what depends on this.
- `path "A" "B"` — shortest route between two nodes.
- `update <repo>` — re-extract and refresh the graph.
- `merge-graphs g1 g2 ...` — combine per-repo graphs into one.

The value proposition is context economy: a graph answer is a few kilobytes of `file:line`-anchored structure, versus tens of kilobytes if the agent reads the files.

### The baseline it must beat
Not "nothing." The realistic alternative an agent already has:

- **`rg` (ripgrep)** — regex search across the tree, sub-100ms, always reflects the current files.
- **a single `awk` pass** — same search, but also prints the enclosing function name and the true call-site line number.
- **then read only the located slice**, with an offset and a line limit, instead of the whole file.

This baseline is free, needs no build step, and is never stale. That last property turns out to matter more than anything else. A graph is a build-and-maintain artifact; `rg` reads live files.

### The workspace ("soulbrew")
Roughly 12 **independent** git repos sitting under one directory — not a monorepo. The ones that matter here:

| Repo | What it is | Size of its graph | Commits since its graph was built |
|---|---|---|---|
| `arra-oracle-v3` | memory/knowledge engine (TypeScript) | 13,401 nodes | 0 |
| `maw-js` | core CLI + runtime that drives AI agents in tmux panes (TypeScript) | 15,194 nodes | 1 |
| `missionControl` | VS Code extension, the human-facing control panel (TypeScript) | 1,304 nodes | 29 |
| `orches-skills` | build-orchestration skills, **bash + Markdown** | 338 nodes | 33 |
| `maw-ui` | web UI (TypeScript) | 942 nodes | 0 |
| 7 others | oracle instances, kanban scaffold — mostly config + prose | 8-65 nodes each | 0-4 |

Two facts about this shape drive the whole verdict:

1. **The daily-work repos are `missionControl` and `orches-skills`** — in a sampled window they absorbed 328 edits and 176 file-reads, versus **one file-read each** for `arra-oracle-v3` and `maw-js`. Any tool that only helps on the frozen repos is helping where the work isn't.
2. **The interesting behaviour crosses repos.** The real control flow is: the VS Code extension launches a tmux session → a bash skill (`orches-drive`) splits work and dispatches worker agents → those workers drive `maw-js`. An agent's most valuable structural question is exactly the one that follows that chain. See §5.4 for why no code graph can follow it.

---

## 3. The claim on trial, and the honest answer

An earlier audit (2026-07-17) concluded: *"graphify wins, real but modest ~+5% token saving, concentrated on the read-only legacy engines; not worth it on the actively-edited repos because the graph goes stale."* ("Legacy engines" is local shorthand for the two big, frozen, read-mostly TypeScript repos — `arra-oracle-v3` and `maw-js` — not for old or deprecated code.)

That was re-tested on 2026-07-27 with six live investigations, each independently re-run by a second adversarial agent whose job was to refute the first. The answer has two layers, and conflating them is the main trap:

- **The conclusion survives.** graphify is not worth adopting here.
- **Almost every stated reason for it was wrong**, and the headline number was never computed at all. The old verdict was right by luck of argument, not by measurement.

So: do not cite the old reasoning, and do not cite "+5%" (per-question deltas measured **-62% to +866%**, sign flipping with question shape — no single global percentage is defensible from any evidence that exists). But also do not read "the old reasons were wrong" as "so graphify is good." It was re-measured, and it lost.

---

## 4. The head-to-head measurement

Five structural questions spanning the repo types, each answered twice — once via graphify, once via `rg`/`awk` + a targeted read — scoring bytes pulled into context, wall time, and whether the answer was **correct** (every emitted `file:line` verified against the live source).

| # | Question shape | Result |
|---|---|---|
| 1 | trace a call chain in a big frozen TypeScript engine | graphify **lost** by 1,412 bytes |
| 2 | what runs when a VS Code command fires | graphify **won** by 429 bytes (9%); 4,268 bytes (90%) *if* the symbol name is already known |
| 3 | which bash functions write/poll a coordination file | graphify **lost** by 3,897 bytes |
| 4 | cross-cutting question | graphify **lost** by 6,953 bytes (9.7x worse) |
| 5 | reverse dependency: "who calls X" — deliberately constructed to favour graphify | initially scored a 2.6x win, then **refuted** |

Question 5 is the instructive one, because it was the entire investigation's only positive result. All three baselines it was scored against pulled source text into context. A single `awk` pass over just the matching files returned **the identical 10 non-test callers**, each with its enclosing function name, its declaration line, **and the true call-site line** (which graphify does not give you at all), in **1,103 bytes / 0.04 s** versus graphify's **2,794 bytes / 1.07 s**. It generalized: same pattern on two more symbols, 254 vs 333 bytes and 242 vs 316 bytes. **3 for 3 to `awk`.**

Net: **zero of five questions won on cost once a competent baseline is used**, and zero of the four originally planned questions returned correct line numbers from the stored graphs.

Read the limits of this honestly: five questions, hand-chosen by one agent, not sampled from real work. That is enough to kill "+5%" and enough to say "no measured win," but it is **not** enough to publish a replacement percentage. §10 says what experiment would be.

---

## 5. The four reasons, with evidence

### 5.1 The retrieval surface is untrustworthy (biggest reason, and independent of everything else)

Three separate defects, all measured on `arra-oracle-v3`, whose graph was verified **100.0% line-accurate** (200 of 200 sampled nodes still point at the right symbol) — so none of this can be blamed on staleness or fixed by rebuilding:

- **Non-determinism.** Five identical `query` invocations produced five different outputs — and not merely reordered: the *set* of nodes returned changed (3 distinct set-hashes across 3 runs). Setting `PYTHONHASHSEED=0` collapses it to one, which identifies the cause: ties between equal-degree nodes are broken by hash iteration order. A tool whose answer changes per run cannot be cited, diffed, or trusted.
- **Inverted edge directions.** One `query "who calls createStorageBackend"` returned 62 `NODE` and 14 `EDGE` lines. **11 of the 14 edges are backwards** (the original pass verified only a 4-edge sample and under-reported this; a full re-audit against 0.9.29's corrected output shows only `loadStorageConfig` and `normalizeStorageBackendName` were rendered the right way round, with one edge unverified) — — four functions rendered as if `createStorageBackend` calls them, when in live source they call *into* it. Both directions print with the **same arrow glyph**, so a reader cannot tell which rows to distrust. The `affected` verb renders direction correctly, which localizes this to a `query` presentation bug.
- **Silent truncation, worst-first.** Output is capped by a token budget and cut in degree order, so the nodes you named in the question get dropped in favour of high-degree hubs: **56 of 134 nodes discarded with no notice**, and **0 of 5** named seed symbols appeared in the first five rows. The `path` verb is also non-deterministic on score ties (identical command, two different 4-hop routes, both semantically meaningless — routed through a test file).

**All three are fixed in 0.9.29** — verified directly, see the UPDATE block at the top: directions 10/10 correct with call-site anchors, 1 distinct output across 5 runs, and an explicit truncation notice that states how many nodes were cut. This entire subsection therefore describes 0.9.18 only, and is the reason the upgrade is a precondition for using the tool at all.

Also note the budget flag is a trap: at the default budget you get 79 `NODE` and **0** `EDGE` lines with 440 of 519 nodes cut — a flat list with no structure, i.e. the one thing a graph is for. `--budget 12000` gave 50 nodes with 45 edges. Any documentation recommending `--budget 1200` is recommending something **worse than the default**.

### 5.2 Symbol resolution misses the call style this workspace's core repo uses

graphify resolves module-level exported functions well. It does not resolve **instance-method calls** (`someObject.someMethod()`), and `maw-js` — the runtime that drives everything — is built that way.

Concretely: the method that sends text into a tmux pane (`Tmux.sendText`) has **20 real call sites across 11 files**. In the graph it has **1 incoming edge**, and that one is merely the class-containment edge. A wrapper function that calls it on the very next line shows **zero outgoing edges**. Asking `affected ".sendText()"` returns `No unique node match` in 37 bytes.

This matters more than it sounds: it means the single most useful question about the runtime — "what would break if I change how we wake an agent?" — is exactly the question the graph cannot answer. And the graph is already fresh, so **rebuilding cannot help** — confirmed by a full fresh rebuild on 0.9.29 (64 s), which reproduced the numbers exactly: still 1 inbound edge, still 0 inbound `calls`, wrapper still 0 outgoing, against 49 real call sites in 27 files. This is also why the old verdict's "the payoff is arra and maw-js" was half wrong: only `arra-oracle-v3` has both a frozen graph and the right call style.

### 5.3 The graphs that matter are stale, and staleness is silent

Staleness is narrower than folklore says but sharper where it lands. Measured by "does each node's recorded line still point at that symbol in the current file":

| Repo | Commits since graph built | Line accuracy | Damage |
|---|---|---|---|
| `arra-oracle-v3` | 0 | **100.0%** | none |
| `maw-js` | 1 | **100.0%** | none |
| `missionControl` | 29 | **70.5-83%** | 296 node ids added / 186 removed; only 85.7% of stored ids survive; 20 real feature files invisible; 13 cited docs no longer exist |
| `orches-skills` | 33 | **51.8%** | drift of 184-373 lines — that is a *different function*, not a near miss |

Only **3 of 12** graphs have any drift at all (1,693 of 31,388 nodes = **5.4%** of the corpus), proven at content level: rebuilding `maw-js` and `arra-oracle-v3` at current HEAD produces **node-id sets identical** to the stored graphs. So most of the corpus is fine — but the stale 5.4% is precisely the two repos the human edits daily, and the damage is measurable downstream: citation correctness on the stale `missionControl` graph is **62.5%** versus **86.9%** on a fresh build of the same repo.

The refresh cost is trivial and was **never measured** by the audit that used it as the reason to exclude these repos:

| Repo | Full rebuild, no clustering | With clustering (the default) |
|---|---|---|
| `orches-skills` | **0.87-1.33 s** | not measured |
| `missionControl` | **3.8-5.2 s** | 4.65-5.19 s |
| `maw-js` | 61-66 s | 73-74 s |
| `arra-oracle-v3` | ~51 s | not measured |

Zero LLM tokens in every case; clustering names communities with a deterministic highest-degree-hub rule, not a model. So the repos excluded as "too expensive to keep fresh" are the **cheapest** ones, and the two that are genuinely slow to rebuild are the two that need no rebuilding.

**Correction (2026-07-27):** the sentence below about `built_at_commit` was based on reading 0.9.18 source, and execution disproved it — 0.9.29's `update` writes graph-level attributes of `{}` on **both** the clustered and `--no-cluster` paths, so there is no commit anchor to compare against on either. Freshness is now tracked by a hand-written `BUILT_AT.json` sidecar next to each rebuilt graph. Everything else in this subsection held.

The reason this still counts against adoption is that **nothing keeps them fresh and the tool cannot tell you it is stale**:

- No cron entry, no systemd timer, no running process, no git hooks — the rebuild was never wired anywhere.
- `graphify check-update` prints nothing and **exits 0**.
- `graphify watch` cannot even start here (its `watchdog` dependency is absent) and **also exits 0**.

Either one, put in a cron job, would report success forever while the graph rotted. Worse, every one of the 12 stored graphs was built with `--no-cluster`, which is the one code path that skips writing `built_at_commit` — so no graph carries a commit anchor, and there is no field to compare HEAD against. A freshness guard has to be built by hand from `git rev-parse HEAD`.

### 5.4 Cross-repo is structurally impossible, and merging is worse than useless

The highest-value question in this workspace crosses repo boundaries. graphify offers `merge-graphs` and a `global add` registry for exactly that. Both fail, and one causes harm.

Merging the three interesting graphs took 2.8 s and produced 17,357 nodes — **exactly the sum of the inputs**, with **0 cross-repo links** and **0 of 181 connected components spanning more than one repo**. `global add` gives 0 bridge nodes. Merge is `nx.compose` of prefixed graphs: a union, not a join.

The damage on top of the non-result:

- **567-572 edges silently dropped** (multiple relation types between the same pair collapse into one).
- **9,828 endpoint-pairs vanish and 100% of them reappear with source and target SWAPPED** under the same relation label — 4,035 of them `calls`. Spot-verified against live source: a function that calls another is recorded as being called by it. The likely mechanism is normalization to an **undirected** graph type, which cannot carry direction (that mechanism is inference, not measurement).
- **496 nodes invented** that exist in neither input (`std`, `axum`, `io`, `btreemap`).
- Merged queries are ~6.4x slower (2.6 s vs 0.4 s), the file is 19.6 MB, and the output carries **no repo attribution at all** — the formatter only prints label, source, location, and community, so you cannot tell which repo an answer came from even with readable repo tags configured.

And no better extractor could fix the underlying problem, which is not a parsing gap: **the handoff between these repos is a prompt string typed into a tmux pane.** The extension composes text; tmux delivers keystrokes; the agent on the other side interprets it. There is no import, no call, no symbol reference for any static analyzer to follow. The upstream code for cross-repo merging is **byte-identical** in the newer 0.9.28, so upgrading changes nothing here.

---

## 6. What actually does pay (keep this narrow)

**Exactly one job, and it needs 0.9.29.** After the fixes were verified, the verbs were re-raced. The result is narrower than the first pass claimed, and it is not the verb that first pass named.

**The winner: `affected "<exact symbol>" --relation calls --depth 2` (or 3).** A transitive caller closure — everything that reaches this symbol through any number of hops — in **3,047 bytes for 49 entries** (depth 3: 3,256 bytes, 53 entries), every one carrying a correct `file:Lnn` anchor. It surfaces second-order callers that a single grep pass cannot reach at all: to get the same closure with `rg` you must search, collect the first-order callers, then search again for each of them, round after round, paying context on every round. This is a genuine capability difference, not a byte saving.

The `--relation calls` filter is what makes it usable and the earlier pass missed it: **without** the filter, depth 2 balloons from 3,047 to **16,786 bytes**, mostly padded with "which test file imports this."

**Not the winner, contrary to the first pass: `explain`.** Re-measured on the same symbol, `graphify explain` costs **2,979 bytes** on 0.9.29 (1,120 on 0.9.18, but with no line anchors, so unusable), while a one-pass `awk` returns **all 8 `src/` call sites with their enclosing function names in 392 bytes** — **7.6x cheaper and more complete**. The earlier "452 bytes versus 4,720" figure was a different symbol scored against an `rg` invocation that pulled source text; it does not generalize and should not be quoted.

So: **single-hop "who calls X" stays with `awk`**, always. It is cheaper, faster, complete, and immune to staleness.

Where the winner applies is also narrow: it needs a repo whose calls actually resolve, which means **exported-function TypeScript**. That is `arra-oracle-v3` today and `missionControl` after a ~5 s rebuild. It is **not** `maw-js` (instance methods, §5.2) and **not** `orches-skills` (bash, zero cross-file call edges, §7).

If it is wired in, the correct shape is a **thin skill wrapping the CLI** — a short instruction file whose always-loaded cost is just a name and a description (~91-96 tokens) — carrying that one verb, the repo→graph-path table, and three warnings: it requires 0.9.29 or newer, line numbers are only trustworthy on a fresh graph, and single-hop callers go to `awk`.

---

## 7. Secondary findings worth knowing before you propose a variant

- **Coverage is not a problem, at all.** A fresh `orches-skills` build covers **61 of 61 files (100%)**, recovers **195 of 195** bash function definitions as an exact set match (0 missed, 0 extra), and every one of **291 line numbers** across all 97 function-to-function call edges is byte-correct. Bash and Markdown are fully parsed — the grammars are bundled and the extensions are registered.
- **But the bash graph is shallower than the node count implies.** `calls` edges are one per *(caller, callee)* pair, not per call site (one helper invoked 43 times has 7 incoming edges), so you cannot enumerate call sites from the graph. **0 of 230** `calls` edges cross a file boundary, Markdown is headings-only, and Markdown links resolve only to other documents — so there are **zero** edges between the prose and the scripts. The artifact is 29 per-file call graphs plus 32 separate heading outlines, in 58 disconnected components. Not one knowledge graph.
- **Every graph contains dangling edges** pointing at nodes that do not exist: 2.3% (`orches-skills`), 7.1% (`missionControl`), 12.5% (`maw-js`), 13.5% (`arra`) — and **8.9% on a 100%-fresh build**, identical on both versions. These materialize as attribute-free phantom nodes when the graph is loaded.
- **Do not register the MCP server.** (MCP = the protocol for exposing a tool's functions to an agent as always-available tools; the cost is that its schemas sit in the prompt every session.) It cannot start on this machine at all (the `mcp` optional dependency is absent; the process exits 1 with `ModuleNotFoundError`). Separately, the widely-repeated objection "one server can only serve one graph" is **false** — one process serves all 12 (proven by serving five real graphs from a single server with no default graph configured). The true cost is one server's worth of schemas: ~1,403 tokens for 10 tools plus ~197 for 6 resources, about **+21%** on the ~7,600-token session baseline. Real, but not the N-times-worse story that was recorded.
- **Do not run the tool's own installer** (`graphify install --platform claude`). It writes **82,233 bytes**, including a 38,980-byte instruction file (~9,730 tokens whenever invoked), a 229-byte always-loaded block, plus pre-tool hooks costing roughly 48 tokens per shell call and 100 per file read, at ~110 ms each — while the guard those hooks call **emits nothing**, because it looks for a graph inside the repo, which is neither where the graphs live nor allowed (this workspace has a standing rule that tooling must leave every repo byte-identical — "pristine").
- **Version drift explains presentation, not capability.** 0.9.18 vs 0.9.28: 215 files in both wheels, 0 added, 0 removed, no new extractors, and `orches-skills` builds **byte-identical** (same md5). The newer release's headline bash work is a provable no-op here (it links scripts that `source` a shared library; **zero** scripts in five repos do that). What 0.9.28 genuinely fixes: determinism, seed ordering, the truncation notice, `explain` call-site citations (0 → 11, of which 10 correct on a fresh graph but only 2 on a stale one), and a data-loss bug.
- **0.9.18 has a data-destroying bug:** re-running `extract --no-cluster` on an existing graph collapses it (270 nodes → 24 in one trial, → 86 in another). `update` is safe on both versions. Use `update`.

---

## 8. DO NOT (already settled; do not re-litigate)

- Do not use `merge-graphs` or `global add` for cross-repo questions. Zero cross-repo edges, 567-572 edges dropped, 9,828 reversed, 496 invented. Byte-identical in the newer version, so upgrading cannot help.
- Do not register the graphify MCP server. It cannot start; the "N graphs = N servers" premise is false; it would cost ~1.6k tokens per session for occasional use.
- Do not run `graphify install --platform claude` or its hook installer. See §7.
- Do not re-run `graphify extract --no-cluster`. Use `graphify update`.
- Do not rebuild `maw-js` hoping to fix reverse-dependency queries. Its graph is already perfect; the blocker is method resolution.
- Do not expect the newer version's bash improvements to add anything here. Zero scripts source a shared library.
- Do not claim "bash/md are not parsed." 195/195 symbol recall, 100% file coverage, 291/291 exact line numbers.
- Do not cite "+5%," or any single global percentage. Per-question deltas run -62% to +866%.
- Do not trust `check-update` or `watch` as freshness signals, and do not build a cron around either. Both exit 0 on hard failure.
- Do not rebuild the nine content-current graphs on a schedule. They have 0-1 commits since build and rebuild to identical node ids — and they are the slow ones.
- Do not revisit the Obsidian-vault variant of this idea. It was separately measured at 0% and that half of the old verdict stands.

---

## 9. How the old verdict went wrong (read this if you are about to run a similar audit)

The 2026-07-17 audit ran 36 agents and reached a defensible-sounding conclusion with almost no supporting evidence. The failure modes are worth naming, because they are easy to repeat:

- **A number appeared without a derivation.** The agent tasked with estimating the effect returned **0%**. The agent that wrote the final decision emitted **"~+5%"** with no formula, no inputs, and no arithmetic anywhere in the record — then listed, in its own caveats, *"All percentages are estimates, unmeasured."* That sentence did not survive into the note; the number did.
- **The conclusion preceded its subject.** At 22:13 the deciding agent's own probe reported that the graph directory **did not exist**. At 22:17 it published a verdict about which repos were worth graphing. The two frozen repos' graphs were created at 22:26-22:27; the two active repos it pronounced "not worth it" were not built until **10:00 the next day**. Across all 36 agents, **not one built or queried a graph.**
- **A unit swap.** The single genuine measurement in that audit was 2,421,561 **characters** of tool output across 8 sessions. No characters→tokens conversion appears anywhere, yet the result was reported as a percentage of **token** spend. The denominator also excluded the dominant cost in an agentic loop: a tool result is re-charged on every subsequent turn.
- **Invented coefficients.** The "reducible" pool was computed with reduction rates of 85% / 50% / 45% for different categories of prior work. None has a source. The author later down-revised the pool from 26.8% to "defensible 13-19%" — and never recomputed the 5%.
- **The win was banked where the data was empty.** The measured sample showed the two frozen repos with **one file-read each**, while the two repos the verdict excluded absorbed 74% of all reads. The conclusion pointed the opposite way from its own data.
- **The refuting agents were overruled without their numbers being used.** Three independent agents refuted the pool size; one showed the same slice of work was double-counted between two different proposed levers. Both figures were nonetheless published additively.
- **Features that directly rebut the argument sat unread in context.** The tool's own help text — listing `watch` ("rebuild the graph on code changes," the direct answer to the staleness argument that was the *sole* basis for the legacy-only conclusion), `merge-graphs`, `update ... (no LLM needed)`, and `install --platform claude` — was in two agents' context. **Zero agents mentioned any of them.** One reason recorded in the note ("bash/md not parsed") was contradicted by the very artifact it described, which already contained 105 bash functions and 190 document nodes: nobody opened the file they were characterizing.

The lesson that generalizes: **when a tool claims a context saving, the load-bearing work is building the cheapest competent baseline and checking edge *identity and direction*, not counting nodes.** Every large claim in this space died at one of those two steps — the "2.6x win" died to a one-line `awk`, and the merge feature's apparent success died to a directed-edge set comparison that a node count could not see.

---

## 10. Known unknowns, and what would change the answer

Ranked by how much each would move the decision:

1. ~~**Does the newer version still invert `query` edge directions?**~~ **RESOLVED 2026-07-27: fixed in 0.9.29.** Directions 10/10 correct against live source, call-site anchors added, determinism fixed (1 output in 5 runs vs 5). See the UPDATE block at the top.
2. ~~**Does it resolve TypeScript instance-method calls?**~~ **RESOLVED 2026-07-27: no.** A fresh 0.9.29 rebuild of `maw-js` reproduces 1 inbound edge and 0 inbound `calls` for a method with 49 real call sites. `maw-js` stays out of reach.
3. ~~**Behaviour when actually installed.**~~ **RESOLVED 2026-07-27: 0.9.29 is now genuinely installed** (`graphify --version` reports 0.9.29; the package in the tool venv is `graphifyy-0.9.29.dist-info`). All four pre-existing graphs still load, and three were rebuilt through it. One cosmetic wart: `uv tool list` still reports `graphifyy v0.9.18` from a stale receipt while the binary and the installed package are 0.9.29 — trust `graphify --version`, not `uv tool list`.
4. **`affected --depth 2/3` completeness** beyond a handful of spot-verified names, and whether test files can be filtered out of a 16-27 KB result.
5. **The real question distribution.** All five head-to-head questions were hand-picked, and one was explicitly constructed to favour graphify. No claim about averages is supportable from five questions.

**The one experiment that would settle it:** sample the last N genuine architecture / where-is-X / who-calls-X questions from real session transcripts — a distribution, not a hand-picked set — rebuild the three stale graphs on 0.9.28 (clustered, written outside the repos), then answer each question both ways, scoring three things per question: bytes entering context, whether the answer is correct, and whether every emitted `file:line` **and every edge direction** verifies against live source. That single pass settles the percentage question, the direction-inversion question, and the "is it trustworthy once fresh" question at once. It is the only design that can produce a defensible number.

Until that is run, the operating position is: **the behavioural baseline is primary** — search for the symbol first, then read only the located slice, and never re-read a file already in context. That is what beat graphify in 4 of 5 head-to-heads, and a single `awk` pass beat it in the fifth.

---

## 11. Glossary

- **Code graph** — a machine-readable map of a codebase as nodes (symbols) and edges (relationships), queryable without reading source text.
- **Node / edge** — a symbol (function, file, class, heading) / a relationship between two symbols (`calls`, `imports`, `contains`).
- **Dangling edge** — an edge referencing a node id that is not in the node list; becomes an attribute-free phantom node on load.
- **Line accuracy (`loc` accuracy)** — the share of sampled nodes whose recorded line number still points at that symbol in the current file. The practical measure of staleness.
- **`built_at_commit`** — a field recording which git commit a graph was built from. Written only on the clustered code path; absent from all 12 graphs here, which is why staleness cannot be checked automatically.
- **`rg` (ripgrep)** — fast recursive regex search. The baseline.
- **tree-sitter** — the parser library graphify uses to extract symbols per language.
- **Clustering** — grouping nodes into communities and naming them. Here it is deterministic (highest-degree hub), costs no LLM tokens, and is the code path that records the commit anchor.
- **MCP (Model Context Protocol)** — the mechanism for exposing a tool's functions to an agent as always-available tools. Costs context every session because the tool schemas sit in the prompt.
- **Skill** — an instruction file loaded on demand; only its name and description occupy context until it is invoked. Much cheaper than MCP for occasional use.
- **tmux** — terminal multiplexer. Here it is the transport: agents live in panes and are driven by simulated keystrokes, which is why the cross-repo control flow is invisible to static analysis.
- **Pristine** — the working rule that an audit must leave every repo byte-identical: no build output left in the tree, no tracked file touched.

---

## 12. Where things live, if you want to verify any of this

Nothing here needs to be taken on trust. On the machine this was measured on:

- **The tool** — `graphify` is a `uv`-managed CLI, not a system package: `~/.local/bin/graphify` (and `graphify-mcp`), with its Python source readable at `~/.local/share/uv/tools/graphifyy/lib/python3.11/site-packages/graphify/`. Note that `which graphify` failing does **not** mean it is absent — that mistake started the original audit off wrong.
- **The graphs** — one directory per repo under `~/.oracle/graphify/<repo>/graph.json`, deliberately outside the repos. Each is a single JSON object with `nodes` and `links` arrays; a node carries `id`, `label`, `source_file`, `source_location` (`"L<n>"`), and `metadata.language` / `metadata.kind`.
- **The repos** — `~/Desktop/soulbrew/github.com/<owner>/<repo>/`, each with its own git remote.
- **Cheapest checks**, in rough order of value: read `metadata.language` counts in `orches-skills/graph.json` to see bash parsed (kills the "not parsed" claim in one command); run the same `graphify query` five times and diff the outputs (shows the non-determinism); pick any `EDGE` line and check the two files to see whether the arrow points the right way; compare a graph's node `source_location` values against the current file to measure line accuracy.
- **Two rules if you do run it:** `graphify update <repo>` writes a `graphify-out/` directory **inside** the repo, and that path is **not** git-ignored in `missionControl`, `orches-skills` or `maw-js` — redirect it out of tree or delete it immediately. And use `update`, never a second `extract --no-cluster`, which destroys the graph.

## 13. Provenance

- **Method:** six live investigations (coverage, staleness, cross-repo merge, integration cost, version delta, empirical head-to-head), each independently re-run by a second agent instructed to refute the first, then synthesized. Roughly 20 first-round claims were knocked down by the reviewers, including the only positive head-to-head result. Where the two disagreed, the reviewer had the better evidence in every substantive case, for a consistent reason: they measured the code path that actually runs, or built the baseline that actually competes.
- **Separately:** a forensic pass over the 2026-07-17 audit's own 36 agent transcripts and its workflow journal, which is where §9 comes from.
- **Non-invasive:** all repos verified byte-identical afterwards (clean status, no build output left behind, unchanged HEADs); all 12 stored graphs verified unchanged by checksum. Nothing was installed or upgraded. The newer version was inspected from an unzipped wheel, never installed.
- **Version under test:** graphify (`graphifyy`) 0.9.18 installed; 0.9.28 inspected in the first pass; **0.9.29 (the release current as of 2026-07-27) executed** in the follow-up pass — real queries, a real 64-second `maw-js` rebuild, and a real head-to-head against `awk`, all from an unpacked wheel on `PYTHONPATH` with nothing installed.
- **Verified untouched afterwards:** four repos clean with no `graphify-out` left behind, all 12 stored graphs unmodified, and `graphify --version` still reporting 0.9.18 — the newer version was executed, never installed.
