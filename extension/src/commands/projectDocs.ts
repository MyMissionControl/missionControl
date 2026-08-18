import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";

export interface DocRef {
  rel: string; // project-relative POSIX path, e.g. "docs/wiki/overview.md"
  label: string; // display label, e.g. "overview" or "decisions/0001-db"
}
export interface ProjectDocs {
  wiki: DocRef[];
  plan: DocRef | null;
  sprints: DocRef[];
}

/** A node in the project's markdown file tree — a folder (with children) or an .md file. */
export interface TreeNode {
  name: string; // basename, e.g. "wiki" or "overview.md"
  rel: string; // project-relative POSIX path, e.g. "docs/wiki/overview.md"
  kind: "dir" | "file";
  children?: TreeNode[]; // dirs only
}

// Directories never worth walking for docs (huge / generated / VCS / worktrees). Dot-
// directories (.git, .claude, …) are skipped separately by the leading-dot check.
// `agents` is where orches puts per-worker git worktrees — full duplicate checkouts of
// the repo — so it would flood the tree with repeated copies of everything.
const TREE_IGNORE_DIRS = new Set([
  "node_modules", "dist", "out", "build", "coverage", ".next", ".turbo", ".cache", "target", "vendor", "agents",
]);
const TREE_MAX_DEPTH = 12; // guard against pathological / symlink-looped trees

// The one dot-directory the docs explorer DOES show: orches writes its gate screenshots
// there (<shots>/sprint-N/<role>/[<viewport>/]<route>.png). Everyone reviewing a delivery
// wants to look at them, and until now the only way was a file manager outside the editor.
// ⛔ Images are viewable ONLY from inside this folder (see resolveProjectFile): the rule
//    "other files stay hidden" has to keep being true, or the explorer becomes a file browser.
export const SHOTS_DIR = ".orches-shots";
const IMG_RX = /\.(?:png|jpe?g|gif|webp)$/i;

// Wiki pages in this priority first (by index), then everything else alphabetically.
const WIKI_PRIORITY = ["README", "overview", "architecture", "setup"];

/** List a project's docs: wiki pages (docs/wiki/**.md), plan.md, and sprint docs. */
export function listProjectDocs(projectPath: string): ProjectDocs {
  const docsDir = path.join(projectPath, "docs");
  return {
    wiki: listWiki(path.join(docsDir, "wiki")),
    plan: fs.existsSync(path.join(docsDir, "plan.md"))
      ? { rel: "docs/plan.md", label: "plan.md" }
      : null,
    sprints: listSprints(docsDir),
  };
}

function listWiki(wikiDir: string): DocRef[] {
  const rels: string[] = [];
  walkMd(wikiDir, wikiDir, rels);
  return rels
    // priority pages first, then top-level pages before subfolder pages (decisions/*), then alpha
    .sort(
      (a, b) =>
        wikiRank(a) - wikiRank(b) ||
        depth(a) - depth(b) ||
        a.localeCompare(b),
    )
    .map((relInWiki) => ({
      rel: "docs/wiki/" + relInWiki,
      label: relInWiki.replace(/\.md$/, ""),
    }));
}
function walkMd(dir: string, root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, root, out);
    else if (e.isFile() && e.name.endsWith(".md"))
      out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}
function wikiRank(relInWiki: string): number {
  const base = relInWiki.replace(/\.md$/, "").split("/").pop() || "";
  const i = WIKI_PRIORITY.indexOf(base);
  return i === -1 ? WIKI_PRIORITY.length : i;
}
function depth(relInWiki: string): number {
  return (relInWiki.match(/\//g) || []).length;
}

function listSprints(docsDir: string): DocRef[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(docsDir);
  } catch {
    return [];
  }
  const rx = /^(?:.+-)?sprint-(\d+).*\.md$/;
  return entries
    .map((f) => ({ f, m: rx.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || a.f.localeCompare(b.f))
    .map((x) => ({ rel: "docs/" + x.f, label: x.f.replace(/\.md$/, "") }));
}

/** Build the project's markdown file tree: only .md files and the folders that
 *  contain them (folders with no .md descendant are pruned). Rooted at the project
 *  dir so README.md, docs/, etc. all appear. Dirs first then files, alpha within each. */
export function listProjectTree(projectPath: string, opts?: { shots?: boolean }): TreeNode[] {
  return buildTree(projectPath, projectPath, 0, opts?.shots === true, false);
}
/** `shots` = also walk <project>/.orches-shots and keep image files inside it.
 *  ⛔ Off by default: Data View walks this same builder and must stay markdown-only. */
function buildTree(
  dir: string,
  root: string,
  depth: number,
  shots = false,
  inShots = false,
): TreeNode[] {
  if (depth > TREE_MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: TreeNode[] = [];
  const files: TreeNode[] = [];
  for (const e of entries) {
    // hide dot-files/dirs (.git, .claude, …) — except the screenshots folder when asked
    const isShotsRoot = shots && e.isDirectory() && e.name === SHOTS_DIR;
    if (e.name.startsWith(".") && !isShotsRoot) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (TREE_IGNORE_DIRS.has(e.name)) continue;
      const children = buildTree(full, root, depth + 1, shots, inShots || isShotsRoot);
      if (children.length) dirs.push({ name: e.name, rel, kind: "dir", children }); // prune empties
    } else if (
      e.isFile() &&
      (e.name.toLowerCase().endsWith(".md") || (inShots && IMG_RX.test(e.name)))
    ) {
      files.push({ name: e.name, rel, kind: "file" });
    }
  }
  const byName = (a: TreeNode, b: TreeNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

/** Docs view for the Project Detail page: a README pointer (used for the default
 *  selection) plus the project's own file tree — **the real structure, unmodified**.
 *  ⛔⛔ It used to be curated: rooted at docs/ (so `docs/` itself never appeared), README
 *     removed, and the flat sprint docs collapsed into a virtual `sprint/` folder with
 *     shortened names. User's call 2026-08-18: show the structure the project actually has,
 *     because a tree that does not match the repo makes every path in it a guess — and the
 *     rename meant the name in the explorer was not the name on disk (or in a git log).
 *  Shows `.md` anywhere + the `.orches-shots/` screenshot tree; every other file stays hidden. */
export interface DetailDocs {
  readme: DocRef | null; // null → no README anywhere obvious
  tree: TreeNode[]; // the real project tree (.md + .orches-shots/), project-rooted
}

export function listDetailDocs(projectPath: string): DetailDocs {
  return { readme: findReadme(projectPath), tree: listProjectTree(projectPath, { shots: true }) };
}
function findReadme(projectPath: string): DocRef | null {
  for (const rel of ["README.md", "docs/README.md"]) {
    try {
      if (fs.statSync(path.join(projectPath, rel)).isFile()) return { rel, label: "README" };
    } catch {
      // not there — try the next candidate
    }
  }
  return null;
}

/** Resolve a project-relative .md path, guarding against traversal outside the project.
 *  Returns the absolute path only if it is a real .md file under <project>/. */
export function resolveProjectFile(projectPath: string, rel: string): string | null {
  const root = path.resolve(projectPath);
  const abs = path.resolve(projectPath, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) return null;
  // markdown anywhere, images ONLY under .orches-shots/ — anything else is not viewable
  const relPosix = path.relative(root, abs).split(path.sep).join("/");
  const inShots = relPosix === SHOTS_DIR || relPosix.startsWith(SHOTS_DIR + "/");
  if (!abs.toLowerCase().endsWith(".md") && !(inShots && IMG_RX.test(abs))) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/** Resolve a project-relative doc path, guarding against traversal outside docs/.
 *  Returns the absolute path only if it is a real file under <project>/docs/. */
export function resolveDocPath(projectPath: string, rel: string): string | null {
  const docsRoot = path.resolve(projectPath, "docs");
  const abs = path.resolve(projectPath, rel);
  const within = abs === docsRoot || abs.startsWith(docsRoot + path.sep);
  if (!within) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/** True when the rendered HTML carries at least one mermaid block — the webview uses this
 *  to decide whether to pull in the 3.4 MB mermaid bundle (lazily, once per panel). */
export function hasMermaid(html: string): boolean {
  return html.includes('<pre class="mermaid">');
}

/** ```mermaid fences → `<pre class="mermaid">`, everything else = normal marked output.
 *  ⛔ Escape ONLY `&` and `<`. The browser decodes entities when mermaid reads
 *  `textContent`, so the diagram source arrives byte-identical — while escaping `>`
 *  would be wrong to leave unescaped-by-hand and escaping the whole thing (marked's
 *  default `escape`) turns `-->` into `--&gt;` and `A & B` into `A &amp; B`, which
 *  mermaid then fails to parse. This is why we override the renderer instead of
 *  post-processing marked's `<code class="language-mermaid">` output. */
function mermaidAwareMarked(md: string): string {
  const renderer = new marked.Renderer();
  const base = renderer.code.bind(renderer);
  renderer.code = function (code: string, lang?: string, escaped?: boolean): string {
    if ((lang || "").trim().toLowerCase().split(/\s+/)[0] === "mermaid") {
      const src = code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return `<pre class="mermaid">${src}</pre>\n`;
    }
    return base(code, lang, escaped ?? false);
  };
  return marked.parse(md, { renderer }) as string; // marked v4: synchronous, returns string
}

/** Render markdown → sanitized HTML for injection into the webview. Content is our own
 *  generated docs in the user's repo (trusted), but we sanitize defensively anyway. */
export function renderMarkdown(md: string): string {
  return sanitizeHtml(mermaidAwareMarked(md));
}

/** Remove script/dangerous tags, inline event handlers, and javascript: URLs. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}
