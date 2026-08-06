// Builds the Obsidian vault that "Open in Obsidian" opens: ONE top folder
// ("Mission Control") holding one folder per project. Each project folder gets a
// GENERATED summary note (frontmatter → Dataview can query it, since the projects'
// own plan.md carry no frontmatter) plus SYMLINKS to the project's real docs, so
// what you read in Obsidian is the live file in the repo, not a stale copy.
//
// Why per-file symlinks instead of one symlink per project: a project folder drags
// its node_modules along (up to ~1,200 extra .md per project, ~7,755 total) and
// Obsidian has no ignore mechanism — the explorer would be unusable. Per-file also
// lets us rename sprint docs to sort numerically (Obsidian sorts alphabetically, so
// raw "<proj>-sprint-10.md" lands before "-sprint-2.md").
//
// NO vscode import — pure fs/path so it unit-tests standalone with `bun test`.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectRow } from "./dataView";
import { dedupeByRealpath, projectScanDirs } from "./orchestratorResume";

/** The single top-level folder inside the vault. Everything lives under it. */
export const VAULT_TOP = "Mission Control";

/** Marker line in every generated note's frontmatter. Prune only ever deletes
 *  files carrying it — a hand-written note in the vault is never touched. */
export const MC_MARKER = "mc-vault: 1";

/** docs/ subfolders that are NOT project documentation: skipped when linking.
 *  `superpowers` is where the brainstorming/writing-plans skills drop their own
 *  specs and plans — scratch output, not something to browse per project. */
const SKIP_DOC_DIRS = new Set(["superpowers"]);

const SPRINT_RX = /sprint-(\d+)/i;

/** Vault root. Lives beside MC's other state in ~/.mission-control (NOT ~/.cache,
 *  which is fair game for cleaners). Overridable for tests. */
export function vaultRoot(): string {
  return (
    process.env.MC_OBSIDIAN_VAULT_DIR || path.join(os.homedir(), ".mission-control", "obsidian")
  );
}

/** Obsidian's own vault registry. Overridable for tests. */
export function obsidianConfigPath(): string {
  return (
    process.env.MC_OBSIDIAN_CONFIG ||
    path.join(os.homedir(), ".config", "obsidian", "obsidian.json")
  );
}

// ---------------------------------------------------------------- plan ------

export interface VaultLink {
  rel: string; // vault-relative POSIX path of the symlink to create
  target: string; // absolute path it points at (a real file/dir in the project)
}
export interface VaultNote {
  rel: string; // vault-relative POSIX path
  body: string; // full markdown, frontmatter included
}
export interface VaultPlan {
  dirs: string[]; // vault-relative dirs to ensure, parents first
  links: VaultLink[];
  notes: VaultNote[];
  projects: number; // how many projects the plan covers (dirs also holds sprint/ + parents)
}
/** A project paired with its prefix — resolved ONCE and then threaded everywhere. */
export interface PlannedProject {
  row: ProjectRow;
  prefix: string;
}

/** A project's home inside the vault, vault-relative and WITHOUT a trailing slash
 *  — e.g. "Mission Control/learningPlatform". This is the ONE place the vault's
 *  layout is decided: every dir, symlink, note path and wikilink is built from it,
 *  so putting projects somewhere else later (grouped by category, an archive area,
 *  a per-owner folder) is a change here and nowhere else. Pass a replacement as
 *  planVault's second argument to relocate everything at once. */
export function projectPrefix(row: ProjectRow): string {
  return `${VAULT_TOP}/${safeName(row.name)}`;
}

/** A project's folder-note filename (no extension) — same name as the folder, so
 *  Obsidian treats it as that folder's note. Taken from the prefix's last segment
 *  rather than the project name, so it follows a relocated layout. */
export function projectNoteName(prefix: string): string {
  return prefix.split("/").filter(Boolean).pop() || "unnamed";
}

/** Everything the vault should contain, computed WITHOUT touching the vault.
 *  Reads the projects' docs dirs to decide what to link. */
export function planVault(
  rows: ProjectRow[],
  prefixOf: (row: ProjectRow) => string = projectPrefix,
): VaultPlan {
  // ONE prefix per project, resolved up front. Nothing below re-derives it.
  const planned: PlannedProject[] = rows.map((row) => ({ row, prefix: prefixOf(row) }));

  const dirs: string[] = [VAULT_TOP];
  const links: VaultLink[] = [];
  const notes: VaultNote[] = [
    { rel: `${VAULT_TOP}/${VAULT_TOP}.md`, body: renderIndexNote(planned) },
  ];

  for (const { row, prefix } of planned) {
    dirs.push(prefix);

    // The summary note is a folder note and claims its filename first, so a doc
    // that happens to share the name gets suffixed instead of colliding.
    const note = projectNoteName(prefix);
    const used = new Set<string>([`${note}.md`.toLowerCase()]);
    const mine = projectLinks(row.path, prefix, used);
    links.push(...mine);
    if (mine.some((l) => l.rel.startsWith(`${prefix}/sprint/`))) dirs.push(`${prefix}/sprint`);
    // rendered LAST so the note can link the docs that actually got linked
    notes.push({ rel: `${prefix}/${note}.md`, body: renderProjectNote(row, prefix, mine) });
  }
  return { dirs, links, notes, projects: planned.length };
}

/** Filename (no extension) for a sprint note: zero-padded so Obsidian's
 *  alphabetical sort reads as numeric, suffixed if a number repeats. Shared by the
 *  planner and the note renderer so the timeline's links always name the files that
 *  actually get created. `seen` accumulates across one project's sprints. */
export function sprintNoteName(n: number, seen: Set<string>): string {
  const stem = `sprint-${String(n).padStart(2, "0")}`;
  let candidate = stem;
  for (let i = 2; seen.has(candidate.toLowerCase()); i++) candidate = `${stem}_${i}`;
  seen.add(candidate.toLowerCase());
  return candidate;
}

/** A wikilink carrying the FULL vault path. Basenames repeat heavily here —
 *  sprint-01.md exists once per project, README.md ~20 times — so a short
 *  `[[sprint-01]]` leaves Obsidian a dozen candidates to guess between, and
 *  nothing guarantees it picks this project's. The path form always resolves.
 *  In a table the alias pipe must be escaped or it ends the cell. */
export function wikilink(vaultPath: string, alias: string, inTable = false): string {
  return `[[${vaultPath}${inTable ? "\\|" : "|"}${mdCell(alias)}]]`;
}

/** The symlinks for one project: README, loose docs/*.md, docs/wiki/, and every
 *  sprint doc renamed into a sprint/ subfolder so it sorts numerically. */
function projectLinks(projectPath: string, base: string, used: Set<string>): VaultLink[] {
  const out: VaultLink[] = [];
  const claim = (name: string): string => {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let candidate = name;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem}_${i}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };

  for (const rel of ["README.md", "readme.md"]) {
    const abs = path.join(projectPath, rel);
    if (isFile(abs)) {
      out.push({ rel: `${base}/${claim("README.md")}`, target: abs });
      break; // one README is enough
    }
  }

  const docsDir = path.join(projectPath, "docs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(docsDir, { withFileTypes: true });
  } catch {
    return out; // no docs/ — README-only project
  }

  const sprints: { n: number; file: string }[] = [];
  const loose: string[] = [];
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      if (!SKIP_DOC_DIRS.has(e.name.toLowerCase())) subdirs.push(e.name);
      continue;
    }
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const m = SPRINT_RX.exec(e.name);
    if (m) sprints.push({ n: Number(m[1]), file: e.name });
    else loose.push(e.name);
  }

  subdirs.sort(byName);
  for (const d of subdirs)
    out.push({ rel: `${base}/${claim(d)}`, target: path.join(docsDir, d) });

  loose.sort(byName);
  for (const f of loose) out.push({ rel: `${base}/${claim(f)}`, target: path.join(docsDir, f) });

  // sprint/sprint-NN.md — zero-padded so Obsidian's alphabetical sort is numeric
  sprints.sort((a, b) => a.n - b.n || byName(a.file, b.file));
  const usedSprint = new Set<string>();
  for (const s of sprints)
    out.push({
      rel: `${base}/sprint/${sprintNoteName(s.n, usedSprint)}.md`,
      target: path.join(docsDir, s.file),
    });
  return out;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Rows for project folders that buildProjectRow() rejects: it returns null for
 *  anything without a `docs/` dir ("not a project we surface"), so README-only
 *  builds — morse, ttt, expense-tracker — are invisible to the Projects screen.
 *  The vault wants one folder per project regardless, so synthesise a minimal row
 *  for any folder holding a README that `known` doesn't already cover. */
export function readmeOnlyRows(ownerRoot: string, known: Set<string>): ProjectRow[] {
  const candidates: string[] = [];
  for (const dir of projectScanDirs(ownerRoot)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // no such projects/ dir
    }
    for (const n of names) {
      if (n === "ψ" || n.startsWith(".") || known.has(n)) continue;
      candidates.push(path.join(dir, n));
    }
  }

  const rows: ProjectRow[] = [];
  const seenNames = new Set<string>();
  for (const p of dedupeByRealpath(candidates, (q) => fs.realpathSync(q))) {
    const name = path.basename(p);
    if (seenNames.has(name)) continue;
    let readme = "";
    for (const cand of ["README.md", "readme.md"]) {
      if (isFile(path.join(p, cand))) {
        readme = path.join(p, cand);
        break;
      }
    }
    if (!readme) continue; // nothing to read → nothing to show
    seenNames.add(name);
    let updated: string | null = null;
    try {
      updated = new Date(fs.statSync(readme).mtimeMs).toISOString().slice(0, 10);
    } catch {
      /* keep null */
    }
    rows.push({
      name,
      path: p,
      sprintsTotal: 0,
      sprintsDone: 0,
      percentDone: 0,
      status: "not-started",
      sprints: [],
      latestSprint: null,
      updated,
      hasPreview: fs.existsSync(path.join(p, ".orches-preview.sh")),
      githubUrl: null,
    });
  }
  return rows;
}

/** Strip path separators and characters Obsidian/filesystems choke on. Project
 *  names come from folder names, so this is a belt-and-braces guard. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|#^[\]]/g, "-").replace(/^\.+/, "").trim();
  return cleaned || "unnamed";
}

// -------------------------------------------------------------- render ------

/** The per-project summary note. The frontmatter is the whole point: the projects'
 *  own plan.md have no frontmatter at all, so this is what gives Dataview
 *  something real to query. */
export function renderProjectNote(
  row: ProjectRow,
  prefix = projectPrefix(row),
  links: VaultLink[] = [],
): string {
  const fm = [
    "---",
    MC_MARKER,
    "mc: project",
    `project: ${yamlStr(row.name)}`,
    `status: ${row.status}`,
    `sprints_total: ${row.sprintsTotal}`,
    `sprints_done: ${row.sprintsDone}`,
    `percent_done: ${row.percentDone}`,
    `updated: ${row.updated ?? "null"}`,
    `has_preview: ${row.hasPreview}`,
    `deleted: ${row.deleted === true}`,
    `project_path: ${yamlStr(row.path)}`,
    "tags:",
    `  - mc/project`,
    `  - mc/status/${row.status}`,
    "---",
    "",
  ];

  const head = [
    `# ${row.name}`,
    "",
    [
      `**${row.percentDone}%**`,
      `sprint ${row.sprintsDone}/${row.sprintsTotal}`,
      row.updated ? `อัปเดต ${row.updated}` : null,
      row.deleted ? "(ลบไปแล้ว — อ่านจาก backup)" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ];

  const dir = prefix; // the project's ONE prefix — never re-derived here
  const seen = new Set<string>();
  const timeline = row.sprints.length
    ? [
        "## Sprint",
        "",
        "| # | หัวข้อ | วันที่ |",
        "| --- | --- | --- |",
        ...row.sprints.map(
          (s) =>
            `| ${s.n} | ${wikilink(`${dir}/sprint/${sprintNoteName(s.n, seen)}`, s.name, true)} | ${s.date ?? "-"} |`,
        ),
        "",
      ]
    : [];

  // Everything linked into this project's folder except the sprints (already in the
  // table above). Directory links are left out — Obsidian can't wikilink a folder.
  // wikilink targets carry NO extension — "<dir>/README", not "<dir>/README.md"
  const docs = links
    .filter((l) => !l.rel.startsWith(`${dir}/sprint/`) && l.rel.toLowerCase().endsWith(".md"))
    .map((l) => l.rel.slice(dir.length + 1).replace(/\.md$/i, ""));
  const docsSection = docs.length
    ? ["## เอกสาร", "", ...docs.map((d) => `- ${wikilink(`${dir}/${d}`, d)}`), ""]
    : [];

  return [...fm, ...head, ...timeline, ...docsSection].join("\n");
}

/** The vault's front page: a Dataview table over every project note. Takes the
 *  already-resolved prefixes so it never re-derives where a project lives. */
export function renderIndexNote(planned: PlannedProject[]): string {
  const list = [...planned]
    .sort(
      (a, b) =>
        (b.row.updated ?? "").localeCompare(a.row.updated ?? "") || byName(a.row.name, b.row.name),
    )
    .map(({ row: r, prefix }) => {
      const target = `${prefix}/${projectNoteName(prefix)}`; // full path — see wikilink()
      return `- ${wikilink(target, r.name)} — ${r.percentDone}% · sprint ${r.sprintsDone}/${r.sprintsTotal}`;
    });

  return [
    "---",
    MC_MARKER,
    "mc: index",
    `projects: ${planned.length}`,
    "---",
    "",
    `# ${VAULT_TOP}`,
    "",
    "```dataview",
    'TABLE WITHOUT ID file.link AS "โปรเจค", status, percent_done AS "%",',
    '  (sprints_done + "/" + sprints_total) AS "sprint", updated AS "อัปเดต"',
    "FROM #mc/project",
    "SORT updated DESC",
    "```",
    "",
    "## ทั้งหมด",
    "",
    ...list,
    "",
  ].join("\n");
}

function yamlStr(s: string): string {
  return JSON.stringify(s ?? ""); // double-quoted + escaped is valid YAML
}
function mdCell(s: string): string {
  return s.replace(/[|\][]/g, " ").replace(/\s+/g, " ").trim();
}

// --------------------------------------------------------------- write ------

export interface WriteResult {
  projects: number;
  links: number;
  notes: number;
  pruned: string[];
  skipped: string[]; // links we refused to create because a real file sits there
}

/** Materialize the plan. Creates dirs, (re)points symlinks, writes notes, then
 *  prunes leftovers. Only ever unlinks symlinks and notes carrying MC_MARKER —
 *  a real file in the vault is left alone, and we never follow a symlink to
 *  delete on the other side. */
export function writeVault(plan: VaultPlan, root = vaultRoot()): WriteResult {
  const res: WriteResult = { projects: 0, links: 0, notes: 0, pruned: [], skipped: [] };

  for (const d of plan.dirs) fs.mkdirSync(path.join(root, ...d.split("/")), { recursive: true });
  res.projects = plan.projects; // from the plan, not guessed from dirs — a relocated
  // layout can add intermediate folders (archive/, category/…) that aren't projects

  const wanted = new Set<string>();
  for (const l of plan.links) {
    const abs = path.join(root, ...l.rel.split("/"));
    wanted.add(abs);
    if (!fs.existsSync(l.target)) continue; // project doc vanished — skip, no dead link
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      /* nothing there yet */
    }
    if (st && !st.isSymbolicLink()) {
      res.skipped.push(l.rel); // a real file/dir — never clobber it
      continue;
    }
    if (st) {
      if (safeReadlink(abs) === l.target) {
        res.links++;
        continue; // already correct
      }
      fs.unlinkSync(abs); // repoint (unlink removes the LINK, not the target)
    }
    fs.symlinkSync(l.target, abs);
    res.links++;
  }

  for (const n of plan.notes) {
    const abs = path.join(root, ...n.rel.split("/"));
    wanted.add(abs);
    fs.writeFileSync(abs, n.body, "utf8");
    res.notes++;
  }

  res.pruned = pruneStale(path.join(root, VAULT_TOP), wanted);
  return res;
}

/** Remove vault entries no longer in the plan. Symlinks are unlinked; regular
 *  files only if they carry MC_MARKER; directories only when they end up empty.
 *  Never descends INTO a symlinked dir. */
function pruneStale(topDir: string, wanted: Set<string>): string[] {
  const removed: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        if (!wanted.has(abs)) {
          try {
            fs.unlinkSync(abs);
            removed.push(abs);
          } catch {
            /* raced away */
          }
        }
        continue; // never follow it
      }
      if (e.isDirectory()) {
        walk(abs);
        if (!wanted.has(abs)) {
          try {
            if (fs.readdirSync(abs).length === 0) {
              fs.rmdirSync(abs);
              removed.push(abs);
            }
          } catch {
            /* not empty / gone */
          }
        }
        continue;
      }
      if (!wanted.has(abs) && isGeneratedNote(abs)) {
        try {
          fs.unlinkSync(abs);
          removed.push(abs);
        } catch {
          /* raced away */
        }
      }
    }
  };
  walk(topDir);
  return removed;
}

/** True only for notes this module wrote (MC_MARKER inside the frontmatter). */
export function isGeneratedNote(abs: string): boolean {
  if (!abs.toLowerCase().endsWith(".md")) return false;
  try {
    const head = fs.readFileSync(abs, "utf8").slice(0, 400);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    return fm ? fm[1].split(/\r?\n/).some((l) => l.trim() === MC_MARKER) : false;
  } catch {
    return false;
  }
}
function safeReadlink(abs: string): string | null {
  try {
    return fs.readlinkSync(abs);
  } catch {
    return null;
  }
}

// -------------------------------------------------------- obsidian cfg ------

/** Seed the vault's .obsidian/ so Dataview is on the first time it opens. The
 *  plugin is COPIED from another vault on this machine (it ships as plain files) —
 *  no network, no manual "install community plugin" step. Returns whether Dataview
 *  ended up present. Never overwrites an existing config the user has tuned. */
export function ensureObsidianConfig(root = vaultRoot()): boolean {
  const cfg = path.join(root, ".obsidian");
  fs.mkdirSync(cfg, { recursive: true });
  writeIfMissing(path.join(cfg, "app.json"), "{}\n");
  writeIfMissing(path.join(cfg, "appearance.json"), "{}\n");
  writeIfMissing(path.join(cfg, "community-plugins.json"), '[\n  "dataview"\n]\n');

  const dest = path.join(cfg, "plugins", "dataview");
  if (isFile(path.join(dest, "main.js"))) return true;
  const src = findDataviewPlugin(root);
  if (!src) return false;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    try {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
    } catch {
      /* styles.css is optional */
    }
  }
  return isFile(path.join(dest, "main.js"));
}
function writeIfMissing(abs: string, body: string): void {
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, body, "utf8");
}

/** Look for an installed Dataview in any OTHER vault Obsidian already knows. */
export function findDataviewPlugin(selfRoot: string): string | null {
  for (const v of readVaults()) {
    if (path.resolve(v.path) === path.resolve(selfRoot)) continue;
    const p = path.join(v.path, ".obsidian", "plugins", "dataview");
    if (isFile(path.join(p, "main.js"))) return p;
  }
  return null;
}

interface VaultEntry {
  id: string;
  path: string;
  ts?: number;
  open?: boolean;
}
function readVaults(): VaultEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(obsidianConfigPath(), "utf8")) as {
      vaults?: Record<string, { path?: string; ts?: number; open?: boolean }>;
    };
    return Object.entries(raw?.vaults ?? {})
      .filter(([, v]) => typeof v?.path === "string" && v.path)
      .map(([id, v]) => ({ id, path: v.path as string, ts: v.ts, open: v.open }));
  } catch {
    return [];
  }
}

/** Stable 16-hex id derived from the path, so re-running never adds a duplicate
 *  entry (Obsidian's own ids are random, but any stable id works). */
export function vaultId(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

export type RegisterOutcome = "registered" | "already-open" | "no-config" | "unreadable";

/** Point Obsidian at our vault: merge an entry into its registry and mark it the
 *  one to open. Other vaults are preserved (just not `open`). Written atomically.
 *  A missing/corrupt registry is left completely alone — better to open the wrong
 *  vault than to destroy the user's list. */
export function registerVault(root = vaultRoot(), now = Date.now()): RegisterOutcome {
  const cfgPath = obsidianConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return "no-config"; // Obsidian never launched here yet
  }
  let data: { vaults?: Record<string, { path?: string; ts?: number; open?: boolean }> };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return "unreadable";
  }
  if (!data || typeof data !== "object") return "unreadable";

  const vaults = data.vaults ?? (data.vaults = {});
  const resolved = path.resolve(root);
  const id = vaultId(resolved);
  // fold away any pre-existing entry for the same path under a different id
  for (const [k, v] of Object.entries(vaults))
    if (k !== id && typeof v?.path === "string" && path.resolve(v.path) === resolved)
      delete vaults[k];

  const wasOpen = vaults[id]?.open === true;
  for (const v of Object.values(vaults)) if (v) v.open = false;
  vaults[id] = { path: resolved, ts: now, open: true };

  const tmp = cfgPath + ".mc-tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, cfgPath); // atomic swap — never a half-written registry
  return wasOpen ? "already-open" : "registered";
}
