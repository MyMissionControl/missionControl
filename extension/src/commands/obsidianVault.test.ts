import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectRow } from "./dataView";
import { listProjectTree } from "./projectDocs";
import {
  MC_MARKER,
  VAULT_TOP,
  isGeneratedNote,
  planVault,
  projectNoteName,
  projectPrefix,
  readmeOnlyRows,
  registerVault,
  renderIndexNote,
  renderProjectNote,
  safeName,
  vaultRel,
  vaultId,
  writeVault,
} from "./obsidianVault";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A project on disk: docs/wiki/ (nested a level deeper too), sprint docs
 *  (deliberately out of order and double-digit), a loose doc, a docs/superpowers/
 *  scratch dir, a repeated basename, the screenshot tree, and two dirs the tree
 *  builder must never walk (node_modules, agents worktrees). */
function makeProject(base: string, name: string, sprintNums: number[] = [1, 2, 10]): string {
  const p = path.join(base, name);
  fs.mkdirSync(path.join(p, "docs", "wiki"), { recursive: true });
  fs.mkdirSync(path.join(p, "docs", "superpowers", "plans"), { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# readme " + name);
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "# overview");
  fs.writeFileSync(path.join(p, "docs", "superpowers", "plans", "scratch.md"), "# scratch");
  for (const n of sprintNums)
    fs.writeFileSync(path.join(p, "docs", `${name}-sprint-${n}.md`), `# sprint ${n}`);
  fs.mkdirSync(path.join(p, "docs", "wiki", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(p, "docs", "wiki", "decisions", "0001-storage.md"), "# adr");
  fs.writeFileSync(path.join(p, "docs", "wiki", "README.md"), "# wiki readme");
  fs.writeFileSync(path.join(p, "CHANGELOG.md"), "# changelog");
  fs.mkdirSync(path.join(p, "node_modules", "foo"), { recursive: true });
  fs.writeFileSync(path.join(p, "node_modules", "foo", "README.md"), "# vendor");
  fs.mkdirSync(path.join(p, "agents", "w1", "docs"), { recursive: true });
  fs.writeFileSync(path.join(p, "agents", "w1", "docs", "plan.md"), "# worktree copy");
  fs.mkdirSync(path.join(p, ".orches-shots", "sprint-1", "web-shell"), { recursive: true });
  fs.writeFileSync(path.join(p, ".orches-shots", "sprint-1", "web-shell", "login.png"), "png");
  fs.writeFileSync(path.join(p, ".orches-shots", "sprint-1", "web-shell", "render.log"), "log");
  return p;
}

function row(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    name: "demo",
    path: "/nope",
    sprintsTotal: 3,
    sprintsDone: 2,
    percentDone: 67,
    status: "in-progress",
    sprints: [
      { n: 1, name: "Sprint 1", date: "2026-01-01" },
      { n: 2, name: "Sprint 2", date: null },
      { n: 10, name: "Sprint 10", date: "2026-02-02" },
    ],
    latestSprint: { n: 10, name: "Sprint 10", date: "2026-02-02" },
    updated: "2026-02-02",
    hasPreview: false,
    githubUrl: null,
    ...over,
  };
}

// ------------------------------------------------------------------ plan ----

test("planVault: one folder per project, folder note, and the project's real tree", () => {
  const base = tmp("mc-ov-plan-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);

  expect(plan.dirs).toContain(VAULT_TOP);
  expect(plan.dirs).toContain(`${VAULT_TOP}/alpha`);
  expect(plan.dirs).toContain(`${VAULT_TOP}/alpha/docs`);
  expect(plan.dirs).toContain(`${VAULT_TOP}/alpha/docs/wiki`);
  // folder note + vault index note + โน้ตแกลเลอรี (fixture มีรูป 1 ใบ — ดูหมวด screenshot gallery)
  expect(plan.notes.map((n) => n.rel).sort()).toEqual([
    `${VAULT_TOP}/${VAULT_TOP}.md`,
    `${VAULT_TOP}/alpha/alpha-shots.md`,
    `${VAULT_TOP}/alpha/alpha.md`,
  ]);

  // the path in Obsidian IS the path in the repo — nothing renamed or pulled up
  const rels = plan.links.map((l) => l.rel);
  expect(rels).toContain(`${VAULT_TOP}/alpha/README.md`);
  expect(rels).toContain(`${VAULT_TOP}/alpha/docs/plan.md`);
  expect(rels).toContain(`${VAULT_TOP}/alpha/docs/wiki/overview.md`);
  expect(rels).toContain(`${VAULT_TOP}/alpha/docs/wiki/decisions/0001-storage.md`);
  expect(rels).toContain(`${VAULT_TOP}/alpha/docs/alpha-sprint-10.md`);
  // a folder is never linked — only files (Obsidian drops overlapping symlinks)
  expect(rels).not.toContain(`${VAULT_TOP}/alpha/docs/wiki`);
  const s10 = plan.links.find((l) => l.rel.endsWith("alpha-sprint-10.md"));
  expect(s10?.target).toBe(path.join(p, "docs", "alpha-sprint-10.md"));
});

// Was: superpowers was skipped as scratch. User's call 2026-08-18 — the vault shows
// what the Projects page shows, and the Projects page shows every .md.
test("planVault: docs/superpowers is linked like any other folder", () => {
  const base = tmp("mc-ov-skip-");
  const p = makeProject(base, "beta");
  const plan = planVault([row({ name: "beta", path: p })]);
  expect(plan.links.map((l) => l.rel)).toContain(
    `${VAULT_TOP}/beta/docs/superpowers/plans/scratch.md`,
  );
});

test("planVault: README-only project gets a note and a README link, no sprint dir", () => {
  const base = tmp("mc-ov-thin-");
  const p = path.join(base, "morse");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# morse");

  const plan = planVault([row({ name: "morse", path: p, sprints: [], sprintsTotal: 0 })]);
  expect(plan.dirs).not.toContain(`${VAULT_TOP}/morse/docs`);
  expect(plan.links.map((l) => l.rel)).toEqual([`${VAULT_TOP}/morse/README.md`]);
});

test("planVault: a doc named like the project does not clobber the folder note", () => {
  const base = tmp("mc-ov-collide-");
  const p = path.join(base, "gamma");
  fs.mkdirSync(p, { recursive: true });
  // at the ROOT, so it lands on the folder note's own name
  fs.writeFileSync(path.join(p, "gamma.md"), "# doc that shares the name");

  const plan = planVault([row({ name: "gamma", path: p })]);
  expect(plan.notes.some((n) => n.rel === `${VAULT_TOP}/gamma/gamma.md`)).toBe(true);
  expect(plan.links.map((l) => l.rel)).toEqual([`${VAULT_TOP}/gamma/gamma_2.md`]);
});

test("readmeOnlyRows: picks up docs-less README projects, skips known and ψ", () => {
  const owner = tmp("mc-ov-owner-");
  const projects = path.join(owner, "projects");
  fs.mkdirSync(projects, { recursive: true });
  // README-only → should be picked up
  for (const n of ["morse", "ttt"]) {
    fs.mkdirSync(path.join(projects, n));
    fs.writeFileSync(path.join(projects, n, "README.md"), "# " + n);
  }
  // already indexed by buildProjectRow → must not be duplicated
  makeProject(projects, "learningPlatform");
  // nothing readable at all → skipped
  fs.mkdirSync(path.join(projects, "empty"));
  // the shared oracle vault and dotfiles are never projects
  fs.mkdirSync(path.join(projects, "ψ"));
  fs.writeFileSync(path.join(projects, "ψ", "README.md"), "# psi");
  fs.mkdirSync(path.join(projects, ".hidden"));
  fs.writeFileSync(path.join(projects, ".hidden", "README.md"), "# dot");

  const rows = readmeOnlyRows(owner, new Set(["learningPlatform"]));
  expect(rows.map((r) => r.name).sort()).toEqual(["morse", "ttt"]);
  expect(rows[0].sprintsTotal).toBe(0);
  expect(rows[0].status).toBe("not-started");
  expect(rows[0].updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("readmeOnlyRows: such a project still gets its own folder + README link", () => {
  const owner = tmp("mc-ov-owner2-");
  const projects = path.join(owner, "projects");
  fs.mkdirSync(path.join(projects, "morse"), { recursive: true });
  fs.writeFileSync(path.join(projects, "morse", "README.md"), "# morse");
  const vault = tmp("mc-ov-vault-");

  const rows = readmeOnlyRows(owner, new Set());
  writeVault(planVault(rows), vault);
  const link = path.join(vault, VAULT_TOP, "morse", "README.md");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(link, "utf8")).toBe("# morse");
  expect(fs.existsSync(path.join(vault, VAULT_TOP, "morse", "morse.md"))).toBe(true);
});

test("projectPrefix/projectNoteName: the layout rule and its folder note", () => {
  expect(projectPrefix(row({ name: "alpha" }))).toBe(`${VAULT_TOP}/alpha`);
  expect(projectPrefix(row({ name: "a/b" }))).toBe(`${VAULT_TOP}/a-b`); // sanitised
  expect(projectNoteName(`${VAULT_TOP}/archive/alpha`)).toBe("alpha");
  expect(projectNoteName(`${VAULT_TOP}/alpha/`)).toBe("alpha"); // trailing slash tolerated
  expect(projectNoteName("")).toBe("unnamed");
});

test("planVault: relocating a project moves its dir, links, note AND wikilinks together", () => {
  const base = tmp("mc-ov-relocate-");
  const p = makeProject(base, "alpha");
  // the future case: projects grouped somewhere else in the vault
  const grouped = (r: ProjectRow) => `${VAULT_TOP}/done/${safeName(r.name)}`;
  const plan = planVault([row({ name: "alpha", path: p })], grouped);
  const home = `${VAULT_TOP}/done/alpha`;

  expect(plan.dirs).toContain(home);
  expect(plan.dirs).toContain(`${home}/docs`);
  expect(plan.notes.some((n) => n.rel === `${home}/alpha.md`)).toBe(true);
  expect(plan.links.every((l) => l.rel.startsWith(`${home}/`))).toBe(true);
  expect(plan.projects).toBe(1);

  // the whole point: nothing still points at the OLD location
  for (const n of plan.notes) {
    for (const m of n.body.matchAll(/\[\[([^\]|\\]*)/g)) expect(m[1].startsWith(home)).toBe(true);
    expect(n.body).not.toContain(`${VAULT_TOP}/alpha/`);
  }
  // and it still materialises + resolves on disk
  const vault = tmp("mc-ov-vault-");
  const res = writeVault(plan, vault);
  expect(res.projects).toBe(1);
  expect(
    fs.readFileSync(path.join(vault, home, "docs", "alpha-sprint-10.md"), "utf8"),
  ).toBe("# sprint 10");
});

test("safeName: strips separators and Obsidian-hostile characters", () => {
  expect(safeName("a/b")).toBe("a-b");
  expect(safeName("we[i]rd#name")).toBe("we-i-rd-name");
  expect(safeName("../escape")).toBe("-escape");
  expect(safeName("")).toBe("unnamed");
});

// ---------------------------------------------------------------- render ----

test("renderProjectNote: frontmatter carries the queryable fields + marker", () => {
  // links are what the sprint table resolves against — a sprint with no linked file
  // renders as plain text, so pass the one the table is asserted on
  const body = renderProjectNote(row({ name: "alpha", path: "/p/alpha" }), `${VAULT_TOP}/alpha`, [
    {
      rel: `${VAULT_TOP}/alpha/docs/alpha-sprint-10.md`,
      target: "/p/alpha/docs/alpha-sprint-10.md",
    },
  ]);
  expect(body.startsWith("---\n" + MC_MARKER)).toBe(true);
  expect(body).toContain("status: in-progress");
  expect(body).toContain("sprints_total: 3");
  expect(body).toContain("sprints_done: 2");
  expect(body).toContain("percent_done: 67");
  expect(body).toContain("updated: 2026-02-02");
  expect(body).toContain("  - mc/project");
  expect(body).toContain("  - mc/status/in-progress");
  expect(body).toContain("# alpha");
  // FULL-path link: "sprint-10.md" exists once per project, so a short [[sprint-10]]
  // would leave Obsidian guessing between all of them
  expect(body).toContain(`[[${VAULT_TOP}/alpha/docs/alpha-sprint-10\\|Sprint 10]]`);
});

test("renderProjectNote/renderIndexNote: no short wikilinks anywhere", () => {
  const base = tmp("mc-ov-nolinkshort-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);
  for (const n of plan.notes)
    for (const m of n.body.matchAll(/\[\[([^\]|\\]*)/g))
      expect(m[1].startsWith(`${VAULT_TOP}/`)).toBe(true);
});

test("planVault: every wikilink in a note points at a file the plan creates", () => {
  const base = tmp("mc-ov-resolve-");
  const a = makeProject(base, "alpha", [1, 2, 10]);
  const b = makeProject(base, "beta", [1, 2]);
  // row.sprints must mirror the sprint docs on disk — in production both come from
  // the same docs/ scan, so keep the fixture consistent too
  const plan = planVault([
    row({ name: "alpha", path: a }),
    row({
      name: "beta",
      path: b,
      sprints: [
        { n: 1, name: "Sprint 1", date: null },
        { n: 2, name: "Sprint 2", date: null },
      ],
    }),
  ]);

  const created = new Set<string>([
    ...plan.links.map((l) => l.rel.replace(/\.md$/i, "")),
    ...plan.notes.map((n) => n.rel.replace(/\.md$/i, "")),
  ]);
  const targets: string[] = [];
  for (const n of plan.notes)
    for (const m of n.body.matchAll(/\[\[([^\]|\\]*)/g)) targets.push(m[1]);

  expect(targets.length).toBeGreaterThan(4);
  for (const t of targets) expect(created.has(t)).toBe(true);
  // and each project's timeline points into ITS OWN folder, not a sibling's
  const alphaNote = plan.notes.find((n) => n.rel.endsWith("alpha/alpha.md"))!;
  expect(alphaNote.body).not.toContain(`${VAULT_TOP}/beta/`);
});


test("renderProjectNote: no sprints → no empty Sprint table", () => {
  const body = renderProjectNote(row({ sprints: [], sprintsTotal: 0, percentDone: 0 }));
  expect(body).not.toContain("## Sprint");
});

test("renderProjectNote: pipes in a sprint title cannot break the table", () => {
  const body = renderProjectNote(
    row({ sprints: [{ n: 1, name: "a|b [c]", date: null }] }),
  );
  const line = body.split("\n").find((l) => l.startsWith("| 1 |")) ?? "";
  // only UNescaped pipes are cell separators — the wikilink alias pipe is "\|"
  expect(line.split(/(?<!\\)\|/).length).toBe(5); // "", " 1 ", " link ", " date ", ""
  expect(line).toContain("a b [c]".replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim());
});

test("renderIndexNote: dataview block over the project tag + wikilink list", () => {
  const body = renderIndexNote(
    [row({ name: "alpha" }), row({ name: "beta", updated: "2026-03-03" })].map((r) => ({
      row: r,
      prefix: projectPrefix(r),
    })),
  );
  expect(body).toContain("```dataview");
  expect(body).toContain("FROM #mc/project");
  expect(body).toContain(`- [[${VAULT_TOP}/beta/beta|beta]]`);
  expect(body.indexOf("/beta/beta|")).toBeLessThan(body.indexOf("/alpha/alpha|")); // newest first
});

// ----------------------------------------------------------------- write ----

test("writeVault: creates symlinks that resolve to the real docs", () => {
  const base = tmp("mc-ov-write-");
  const p = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");

  const res = writeVault(planVault([row({ name: "alpha", path: p })]), vault);
  expect(res.projects).toBe(1);
  expect(res.skipped).toEqual([]);

  const link = path.join(vault, VAULT_TOP, "alpha", "docs", "alpha-sprint-10.md");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(link, "utf8")).toBe("# sprint 10");
  expect(fs.readFileSync(path.join(vault, VAULT_TOP, "alpha", "docs", "wiki", "overview.md"), "utf8")).toBe(
    "# overview",
  );
  expect(fs.existsSync(path.join(vault, VAULT_TOP, "alpha", "alpha.md"))).toBe(true);
});

test("writeVault: editing through the symlink writes the project's real file", () => {
  const base = tmp("mc-ov-edit-");
  const p = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");
  writeVault(planVault([row({ name: "alpha", path: p })]), vault);

  fs.writeFileSync(path.join(vault, VAULT_TOP, "alpha", "docs", "plan.md"), "# edited in obsidian");
  expect(fs.readFileSync(path.join(p, "docs", "plan.md"), "utf8")).toBe("# edited in obsidian");
});

test("writeVault: rerun is idempotent — same links, nothing pruned", () => {
  const base = tmp("mc-ov-idem-");
  const p = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");
  const plan = planVault([row({ name: "alpha", path: p })]);
  const first = writeVault(plan, vault);
  const second = writeVault(planVault([row({ name: "alpha", path: p })]), vault);
  expect(second.links).toBe(first.links);
  expect(second.pruned).toEqual([]);
});

test("writeVault: dropping a project prunes its folder but NOT the real files", () => {
  const base = tmp("mc-ov-prune-");
  const a = makeProject(base, "alpha");
  const b = makeProject(base, "beta");
  const vault = tmp("mc-ov-vault-");
  writeVault(planVault([row({ name: "alpha", path: a }), row({ name: "beta", path: b })]), vault);
  expect(fs.existsSync(path.join(vault, VAULT_TOP, "beta"))).toBe(true);

  const res = writeVault(planVault([row({ name: "alpha", path: a })]), vault);
  expect(res.pruned.length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(vault, VAULT_TOP, "beta"))).toBe(false);
  // the whole point: beta's real docs survive the prune untouched
  expect(fs.readFileSync(path.join(b, "docs", "plan.md"), "utf8")).toBe("# plan");
  expect(fs.readFileSync(path.join(b, "docs", "wiki", "overview.md"), "utf8")).toBe("# overview");
  expect(fs.readFileSync(path.join(b, "README.md"), "utf8")).toBe("# readme beta");
  expect(fs.readFileSync(path.join(b, "docs", "beta-sprint-10.md"), "utf8")).toBe("# sprint 10");
});

test("writeVault: prune leaves a hand-written note in the vault alone", () => {
  const base = tmp("mc-ov-hand-");
  const a = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");
  writeVault(planVault([row({ name: "alpha", path: a })]), vault);
  const mine = path.join(vault, VAULT_TOP, "my own thoughts.md");
  fs.writeFileSync(mine, "# mine\nno frontmatter here");

  const res = writeVault(planVault([row({ name: "alpha", path: a })]), vault);
  expect(res.pruned).toEqual([]);
  expect(fs.existsSync(mine)).toBe(true);
});

test("writeVault: a real file where a link belongs is skipped, never clobbered", () => {
  const base = tmp("mc-ov-skipreal-");
  const a = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");
  fs.mkdirSync(path.join(vault, VAULT_TOP, "alpha"), { recursive: true });
  const real = path.join(vault, VAULT_TOP, "alpha", "README.md");
  fs.writeFileSync(real, "# hand written readme");

  const res = writeVault(planVault([row({ name: "alpha", path: a })]), vault);
  expect(res.skipped).toContain(`${VAULT_TOP}/alpha/README.md`);
  expect(fs.readFileSync(real, "utf8")).toBe("# hand written readme");
});

test("writeVault: a vanished project doc yields no dead symlink", () => {
  const base = tmp("mc-ov-dead-");
  const a = makeProject(base, "alpha");
  const vault = tmp("mc-ov-vault-");
  const plan = planVault([row({ name: "alpha", path: a })]);
  fs.rmSync(path.join(a, "docs", "plan.md")); // disappears between plan and write

  writeVault(plan, vault);
  expect(fs.existsSync(path.join(vault, VAULT_TOP, "alpha", "docs", "plan.md"))).toBe(false);
});

test("isGeneratedNote: only files carrying the marker", () => {
  const base = tmp("mc-ov-marker-");
  const gen = path.join(base, "gen.md");
  const hand = path.join(base, "hand.md");
  fs.writeFileSync(gen, `---\n${MC_MARKER}\nmc: project\n---\n\n# x`);
  fs.writeFileSync(hand, "---\ntitle: mine\n---\n\n# x");
  expect(isGeneratedNote(gen)).toBe(true);
  expect(isGeneratedNote(hand)).toBe(false);
  expect(isGeneratedNote(path.join(base, "missing.md"))).toBe(false);
});

// -------------------------------------------------------------- register ----

function withConfig(body: string | null, fn: (cfg: string) => void): void {
  const dir = tmp("mc-ov-cfg-");
  const cfg = path.join(dir, "obsidian.json");
  if (body !== null) fs.writeFileSync(cfg, body);
  const prev = process.env.MC_OBSIDIAN_CONFIG;
  process.env.MC_OBSIDIAN_CONFIG = cfg;
  try {
    fn(cfg);
  } finally {
    if (prev === undefined) delete process.env.MC_OBSIDIAN_CONFIG;
    else process.env.MC_OBSIDIAN_CONFIG = prev;
  }
}

test("registerVault: keeps other vaults, marks only ours open", () => {
  withConfig(
    JSON.stringify({
      vaults: { abc123: { path: "/home/u/.oracle/graphify/maw-ui/vault", ts: 1, open: true } },
    }),
    (cfg) => {
      expect(registerVault("/home/u/.mission-control/obsidian", 999)).toBe("registered");
      const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
      expect(data.vaults["abc123"].path).toBe("/home/u/.oracle/graphify/maw-ui/vault");
      expect(data.vaults["abc123"].open).toBe(false);
      const id = vaultId("/home/u/.mission-control/obsidian");
      expect(data.vaults[id]).toEqual({
        path: "/home/u/.mission-control/obsidian",
        ts: 999,
        open: true,
      });
    },
  );
});

test("registerVault: rerun does not duplicate the entry", () => {
  withConfig(JSON.stringify({ vaults: {} }), (cfg) => {
    registerVault("/v/mine", 1);
    registerVault("/v/mine", 2);
    const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
    expect(Object.keys(data.vaults).length).toBe(1);
    expect(data.vaults[vaultId("/v/mine")].ts).toBe(2);
  });
});

test("registerVault: folds an Obsidian-assigned id for the same path into ours", () => {
  withConfig(
    JSON.stringify({ vaults: { deadbeefdeadbeef: { path: "/v/mine", ts: 5, open: false } } }),
    (cfg) => {
      expect(registerVault("/v/mine", 7)).toBe("registered");
      const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
      expect(Object.keys(data.vaults)).toEqual([vaultId("/v/mine")]);
    },
  );
});

test("registerVault: corrupt or missing registry is left untouched", () => {
  withConfig("{not json at all", (cfg) => {
    expect(registerVault("/v/mine")).toBe("unreadable");
    expect(fs.readFileSync(cfg, "utf8")).toBe("{not json at all");
  });
  withConfig(null, () => {
    expect(registerVault("/v/mine")).toBe("no-config");
  });
});

// ------------------------------------------------- mirrors the Projects page ----
// The whole point of the 2026-08-18 change: what Obsidian shows IS what the Project
// Detail explorer shows, at the same paths. These lock that, not the old curation.

function flatten(nodes: ReturnType<typeof listProjectTree>): string[] {
  const out: string[] = [];
  const walk = (ns: typeof nodes): void => {
    for (const n of ns) {
      if (n.kind === "dir") walk(n.children ?? []);
      else out.push(n.rel);
    }
  };
  walk(nodes);
  return out.sort();
}

test("planVault: the vault mirrors listProjectTree — same files, same paths", () => {
  const base = tmp("mc-ov-mirror-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);
  const prefix = `${VAULT_TOP}/alpha`;

  const inVault = plan.links.map((l) => l.rel.slice(prefix.length + 1)).sort();
  const onDisk = flatten(listProjectTree(p, { shots: true })).map(vaultRel).sort();
  expect(inVault).toEqual(onDisk);
});

test("planVault: a link's vault path is its repo path, only leading dots stripped", () => {
  const base = tmp("mc-ov-invariant-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);
  const prefix = `${VAULT_TOP}/alpha`;
  for (const l of plan.links) {
    const repoRel = path.relative(p, l.target).split(path.sep).join("/");
    expect(l.rel.slice(prefix.length + 1)).toBe(vaultRel(repoRel));
  }
});

test("planVault: the same basename in two folders is not suffixed", () => {
  const base = tmp("mc-ov-basename-");
  const p = makeProject(base, "alpha");
  const rels = planVault([row({ name: "alpha", path: p })]).links.map((l) => l.rel);
  expect(rels).toContain(`${VAULT_TOP}/alpha/README.md`);
  expect(rels).toContain(`${VAULT_TOP}/alpha/docs/wiki/README.md`);
  expect(rels.some((r) => r.includes("README_2"))).toBe(false);
});

test("planVault: node_modules and agents worktrees are never linked", () => {
  const base = tmp("mc-ov-ignore-");
  const p = makeProject(base, "alpha");
  const rels = planVault([row({ name: "alpha", path: p })]).links.map((l) => l.rel);
  expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
  expect(rels.some((r) => r.includes("/agents/"))).toBe(false);
});

test("planVault: .orches-shots is linked as orches-shots, images only", () => {
  const base = tmp("mc-ov-shots-");
  const p = makeProject(base, "alpha");
  const rels = planVault([row({ name: "alpha", path: p })]).links.map((l) => l.rel);
  // Obsidian excludes dot-prefixed segments from its index, so the dot must go
  expect(rels).toContain(`${VAULT_TOP}/alpha/orches-shots/sprint-1/web-shell/login.png`);
  expect(rels.some((r) => r.includes(".orches-shots"))).toBe(false);
  expect(rels.some((r) => r.endsWith("render.log"))).toBe(false);
});

test("planVault: no link rel is a prefix of another (never a directory symlink)", () => {
  const base = tmp("mc-ov-noprefix-");
  const p = makeProject(base, "alpha");
  const rels = planVault([row({ name: "alpha", path: p })]).links.map((l) => l.rel);
  for (const a of rels)
    for (const b of rels) if (a !== b) expect(b.startsWith(a + "/")).toBe(false);
});

test("planVault: every link's parent dir is in plan.dirs", () => {
  const base = tmp("mc-ov-dirs-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);
  const dirs = new Set(plan.dirs);
  for (const l of plan.links) {
    const parent = l.rel.split("/").slice(0, -1).join("/");
    expect(dirs.has(parent)).toBe(true);
  }
});

test("writeVault: a deeply nested link is created and resolves to the real file", () => {
  const base = tmp("mc-ov-deep-");
  const p = makeProject(base, "alpha");
  const vault = tmp("mc-ov-deepvault-");
  writeVault(planVault([row({ name: "alpha", path: p })]), vault);
  const adr = path.join(vault, VAULT_TOP, "alpha", "docs", "wiki", "decisions", "0001-storage.md");
  expect(fs.lstatSync(adr).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(adr, "utf8")).toBe("# adr");
  const shot = path.join(vault, VAULT_TOP, "alpha", "orches-shots", "sprint-1", "web-shell", "login.png");
  expect(fs.readFileSync(shot, "utf8")).toBe("png");
});

test("renderProjectNote: a sprint with no linked file is plain text, not a wikilink", () => {
  const body = renderProjectNote(row({ name: "alpha", path: "/p/alpha" }), `${VAULT_TOP}/alpha`, []);
  expect(body).toContain("| 10 | Sprint 10 | 2026-02-02 |");
  expect(body).not.toContain("[[");
});

test("renderProjectNote: a sprint doc is in the table, not repeated in the docs list", () => {
  const base = tmp("mc-ov-nodupe-");
  const p = makeProject(base, "alpha");
  const plan = planVault([row({ name: "alpha", path: p })]);
  const note = plan.notes.find((n) => n.rel.endsWith("/alpha.md"));
  const docs = (note?.body ?? "").split("## เอกสาร")[1] ?? "";
  expect(docs).not.toContain("alpha-sprint-10");
  expect(docs).toContain("docs/wiki/overview");
});

// ------------------------------------------------------- screenshot gallery ----
// ⛔⛔ ทำไมต้องมีอันนี้ (user เคาะ 2026-08-19 หลังไล่ของจริง): รูป orches-shots 187 ใบถูก
//   symlink เข้า vault มานานแล้ว แต่ **ไม่มีโน้ตไหนอ้างถึงมันเลย** (`![[` = 0 ใน 366 ไฟล์)
//   ⇒ ทางเดียวที่จะดูคือกางโฟลเดอร์ 6 ชั้นแล้วกดทีละไฟล์ ซึ่งของจริงคือสิ่งที่ user ทำเมื่อ 08:11 วันนี้
//   (workspace.json มี leaf type=image ที่ .../sprint-3/web-admin/pc/admin.png)
//   ⛔ ที่แก้คือ "ข้อความในโน้ต" เท่านั้น — ไม่ก๊อปรูป ไม่สร้างรูป symlink เดิมยังเป็นสำเนาเดียว
//   ⛔ แกลเลอรีต้องอยู่ **โน้ตแยก** ไม่ใช่ในโน้ตโปรเจกต์: newflow9/newflow10 มีรูป 54 ใบต่อโปรเจกต์
//     ⇒ ฝังในโน้ตหลักเท่ากับทำให้หน้าที่เปิดบ่อยสุดโหลดรูป 54 ใบทุกครั้ง = ทำให้ของที่ดีอยู่แล้วแย่ลง
function addShots(p: string): void {
  const s = path.join(p, ".orches-shots");
  const mk = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true });
    fs.writeFileSync(path.join(s, rel), "png");
  };
  // ⛔ สี่รูปทรงนี้มีอยู่จริงทั้งหมดในเครื่อง (นับได้ 127 / 36 / 6 / 18 ใบ) — ห้ามรองรับแค่แบบเดียว
  mk("sprint-2/web-admin/pc/admin.png"); // sprint/role/viewport/route
  mk("sprint-10/web-admin/late.png"); // sprint/role/route (เลขสองหลัก = ต้องเรียงแบบตัวเลข)
  mk("pc/root.png"); // ไม่มี sprint
  mk("flat.png"); // แบนที่รากของ shots
}

test("planVault: โปรเจกต์ที่มีรูปได้โน้ตแกลเลอรีเพิ่มหนึ่งใบ (โน้ตหลักไม่บวม)", () => {
  const base = tmp("mc-ov-shots-plan-");
  const p = makeProject(base, "alpha");
  addShots(p);
  const plan = planVault([row({ name: "alpha", path: p })]);

  expect(plan.notes.map((n) => n.rel).sort()).toEqual([
    `${VAULT_TOP}/${VAULT_TOP}.md`,
    `${VAULT_TOP}/alpha/alpha-shots.md`,
    `${VAULT_TOP}/alpha/alpha.md`,
  ]);
  // ⛔ โน้ตหลักต้องไม่ฝังรูปแม้ใบเดียว — นี่คือด่านกัน regression ของหน้าที่เปิดบ่อยสุด
  const main = plan.notes.find((n) => n.rel.endsWith("alpha/alpha.md"))!;
  expect(main.body).not.toContain("![[");
  // ...แต่ต้องมีทางไป
  expect(main.body).toContain(`[[${VAULT_TOP}/alpha/alpha-shots|`);
});

test("โน้ตแกลเลอรี: ฝังด้วย ![[ ]] เต็ม path, จัดกลุ่มตาม sprint/role, เรียงเลขแบบตัวเลข", () => {
  const base = tmp("mc-ov-shots-body-");
  const p = makeProject(base, "alpha");
  addShots(p);
  const plan = planVault([row({ name: "alpha", path: p })]);
  const g = plan.notes.find((n) => n.rel.endsWith("alpha-shots.md"))!.body;

  // marker ต้องมี ไม่งั้น prune ลบโน้ตที่ค้างไม่ได้เลย (isGeneratedNote อ่านจาก frontmatter)
  expect(g.startsWith("---\n" + MC_MARKER)).toBe(true);
  expect(g).toContain("mc: shots");
  // ⛔ ต้องเป็น embed (`!` นำ) และ **เก็บนามสกุล** ไว้ ไม่งั้น Obsidian ไม่วาดรูป
  expect(g).toContain(`![[${VAULT_TOP}/alpha/orches-shots/sprint-1/web-shell/login.png]]`);
  expect(g).toContain(`![[${VAULT_TOP}/alpha/orches-shots/sprint-2/web-admin/pc/admin.png]]`);
  expect(g).toContain(`![[${VAULT_TOP}/alpha/orches-shots/flat.png]]`);
  // หัวข้อย่อย = พับได้ในตัว Obsidian (นี่คือวิธีคุมโน้ต 54 รูปโดยไม่ต้องเขียนโค้ดคุมเอง)
  expect(g).toContain("### sprint-1 · web-shell");
  expect(g).toContain("### sprint-2 · web-admin · pc");
  expect(g).toContain("### pc");
  // ⛔ dot-dir ต้องถูกถอดจุดเหมือน symlink ที่วางไว้ ไม่งั้นลิงก์ชี้ไปที่ไม่มีในดัชนี Obsidian
  expect(g).not.toContain(".orches-shots");
  // ⛔ ไฟล์ที่ไม่ใช่รูปห้ามหลุดเข้ามา (ในทรีเดียวกันมี render.log)
  expect(g).not.toContain("render.log");
  // sprint-10 ต้องอยู่หลัง sprint-2 (เรียงแบบสตริงจะได้ 10 ก่อน 2)
  expect(g.indexOf("### sprint-2")).toBeLessThan(g.indexOf("### sprint-10"));
});

test("ไม่มีรูป = ไม่มีโน้ตแกลเลอรี และโน้ตหลักไม่มีลิงก์ค้าง", () => {
  // ⛔ ชื่อ temp dir ห้ามมีคำที่กำลังจะ assert ว่า "ไม่มี": `project_path` ในโน้ตคือ path จริงของโปรเจกต์
  //   ⇒ prefix ชื่อ mc-ov-shots-none- ทำให้ not.toContain("-shots") แดงทั้งที่โค้ดถูก (เจอสดตอนเขียนเทสนี้)
  const base = tmp("mc-ov-nopic-");
  const p = makeProject(base, "alpha");
  fs.rmSync(path.join(p, ".orches-shots"), { recursive: true, force: true });
  const plan = planVault([row({ name: "alpha", path: p })]);

  expect(plan.notes.some((n) => n.rel.endsWith("-shots.md"))).toBe(false);
  const main = plan.notes.find((n) => n.rel.endsWith("alpha/alpha.md"))!;
  expect(main.body).not.toContain("alpha-shots");
  expect(main.body).not.toContain("## รูปหน้าจอ");
  expect(main.body).toContain("shots: 0"); // ฟิลด์ยังอยู่เสมอ เพื่อให้ query ตอบ "0" ได้ ไม่ใช่ว่าง
});

test("จำนวนรูปเป็นฟิลด์ที่ query ได้ + ตารางหน้าแรกมีคอลัมน์รูป", () => {
  const base = tmp("mc-ov-shots-count-");
  const p = makeProject(base, "alpha");
  addShots(p);
  const plan = planVault([row({ name: "alpha", path: p })]);
  const main = plan.notes.find((n) => n.rel.endsWith("alpha/alpha.md"))!.body;
  expect(main).toContain("shots: 5"); // 1 จาก makeProject + 4 จาก addShots
  const index = plan.notes.find((n) => n.rel === `${VAULT_TOP}/${VAULT_TOP}.md`)!.body;
  expect(index).toContain("shots");
});

test("โน้ตแกลเลอรีลงดิสก์จริงและ prune จับได้ (มี marker)", () => {
  const base = tmp("mc-ov-shots-disk-");
  const p = makeProject(base, "alpha");
  addShots(p);
  const vault = tmp("mc-ov-shots-vault-");
  const plan = planVault([row({ name: "alpha", path: p })]);
  writeVault(plan, vault);
  const abs = path.join(vault, VAULT_TOP, "alpha", "alpha-shots.md");
  expect(fs.existsSync(abs)).toBe(true);
  expect(isGeneratedNote(abs)).toBe(true);
  // รูปที่ถูกฝังต้องเปิดได้จริงผ่าน symlink ที่ plan วางไว้
  const shot = path.join(vault, VAULT_TOP, "alpha", "orches-shots", "flat.png");
  expect(fs.existsSync(shot)).toBe(true); // existsSync ตาม symlink = ปลายทางมีจริง
  expect(fs.lstatSync(shot).isSymbolicLink()).toBe(true);
});
