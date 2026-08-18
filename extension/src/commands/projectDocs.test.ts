import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  listDetailDocs,
  listProjectDocs,
  listProjectTree,
  renderMarkdown,
  hasMermaid,
  resolveDocPath,
  resolveProjectFile,
  sanitizeHtml,
  type TreeNode,
} from "./projectDocs";

function tmpProject(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-docs-"));
  fs.mkdirSync(path.join(base, "docs", "wiki", "decisions"), { recursive: true });
  return base;
}

test("listProjectDocs: wiki priority order then alpha, plan, sprints numeric", () => {
  const p = tmpProject();
  const w = path.join(p, "docs", "wiki");
  for (const f of ["overview.md", "architecture.md", "setup.md", "README.md", "zeta.md"])
    fs.writeFileSync(path.join(w, f), "# " + f);
  fs.writeFileSync(path.join(w, "decisions", "0001-db.md"), "# d");
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  // sprint docs: <basename>-sprint-N.md AND legacy sprint-N.md, out of order
  fs.writeFileSync(path.join(p, "docs", path.basename(p) + "-sprint-10.md"), "s10");
  fs.writeFileSync(path.join(p, "docs", path.basename(p) + "-sprint-2.md"), "s2");
  fs.writeFileSync(path.join(p, "docs", "sprint-1.md"), "s1");

  const d = listProjectDocs(p);
  expect(d.wiki.map((x) => x.label)).toEqual([
    "README", "overview", "architecture", "setup", "zeta", "decisions/0001-db",
  ]);
  expect(d.wiki[0].rel).toBe("docs/wiki/README.md");
  expect(d.plan?.rel).toBe("docs/plan.md");
  expect(d.sprints.map((x) => x.rel)).toEqual([
    "docs/sprint-1.md",
    "docs/" + path.basename(p) + "-sprint-2.md",
    "docs/" + path.basename(p) + "-sprint-10.md",
  ]);
});

test("listProjectDocs: missing docs dir yields empty groups, no throw", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-docs-empty-"));
  const d = listProjectDocs(base);
  expect(d.wiki).toEqual([]);
  expect(d.plan).toBeNull();
  expect(d.sprints).toEqual([]);
});

test("resolveDocPath: accepts a real file under docs/, rejects traversal + missing", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "secret.txt"), "nope");
  expect(resolveDocPath(p, "docs/plan.md")).toBe(path.join(p, "docs", "plan.md"));
  expect(resolveDocPath(p, "../secret.txt")).toBeNull();
  expect(resolveDocPath(p, "docs/../secret.txt")).toBeNull();
  expect(resolveDocPath(p, "docs/nope.md")).toBeNull();
});

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.kind === "dir" ? n.name + "/" : n.name));
}

test("listProjectTree: dirs first then files (alpha), .md-only, empty branches pruned", () => {
  const p = tmpProject(); // makes docs/wiki/decisions
  fs.writeFileSync(path.join(p, "README.md"), "# r");
  fs.writeFileSync(path.join(p, "notes.txt"), "not markdown"); // non-.md → excluded
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "# o");
  fs.writeFileSync(path.join(p, "docs", "wiki", "decisions", "0001.md"), "# d");
  fs.mkdirSync(path.join(p, "empty-dir"), { recursive: true }); // no .md → pruned
  fs.mkdirSync(path.join(p, "src"), { recursive: true });
  fs.writeFileSync(path.join(p, "src", "index.ts"), "code"); // dir with no .md → pruned
  fs.mkdirSync(path.join(p, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(p, "node_modules", "x", "readme.md"), "# ignored"); // ignored dir
  fs.mkdirSync(path.join(p, "agents", "1-bob"), { recursive: true });
  fs.writeFileSync(path.join(p, "agents", "1-bob", "README.md"), "# worktree"); // orches worktree → ignored
  fs.mkdirSync(path.join(p, ".git"), { recursive: true });
  fs.writeFileSync(path.join(p, ".git", "config.md"), "# ignored"); // dot-dir → skipped

  const t = listProjectTree(p);
  // top level: docs/ (dir) before README.md (file); node_modules/.git/src/empty-dir all gone
  expect(names(t)).toEqual(["docs/", "README.md"]);
  const docs = t.find((n) => n.name === "docs")!;
  expect(docs.rel).toBe("docs");
  // inside docs: wiki/ (dir) before plan.md (file)
  expect(names(docs.children!)).toEqual(["wiki/", "plan.md"]);
  const wiki = docs.children!.find((n) => n.name === "wiki")!;
  // wiki keeps decisions/ (has a .md) then overview.md; a file carries its full rel
  expect(names(wiki.children!)).toEqual(["decisions/", "overview.md"]);
  const ov = wiki.children!.find((n) => n.name === "overview.md")!;
  expect(ov.rel).toBe("docs/wiki/overview.md");
});

test("listProjectTree: missing project dir yields empty array, no throw", () => {
  expect(listProjectTree(path.join(os.tmpdir(), "mc-no-such-" + process.pid))).toEqual([]);
});

test("listDetailDocs: tree mirrors the REAL project structure — no virtual folders, no renames", () => {
  const p = tmpProject(); // makes docs/wiki/decisions
  fs.writeFileSync(path.join(p, "README.md"), "# root readme");
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "# o");
  const proj = path.basename(p);
  fs.writeFileSync(path.join(p, "docs", proj + "-sprint-2.md"), "s2");
  fs.writeFileSync(path.join(p, "docs", proj + "-sprint-10.md"), "s10");

  const d = listDetailDocs(p);
  expect(d.readme?.rel).toBe("README.md"); // still offered for the default selection
  // ⛔ rooted at the PROJECT, not at docs/: dirs first, then files — exactly the real layout
  expect(names(d.tree)).toEqual(["docs/", "README.md"]);
  const docs = d.tree.find((n) => n.name === "docs")!;
  // ⛔ no virtual "sprint" folder and no shortened names: the file names are the real ones
  expect(names(docs.children!)).toEqual([
    "wiki/",
    proj + "-sprint-10.md",
    proj + "-sprint-2.md",
    "plan.md",
  ]);
  expect(docs.children!.find((c) => c.name === "plan.md")!.rel).toBe("docs/plan.md");
  const wiki = docs.children!.find((n) => n.name === "wiki")!;
  expect(names(wiki.children!)).toEqual(["overview.md"]);
});

test("listDetailDocs: .orches-shots is shown (images only), nested viewport folders kept", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  const shots = path.join(p, ".orches-shots", "sprint-1", "web-shell");
  fs.mkdirSync(path.join(shots, "pc"), { recursive: true });
  fs.writeFileSync(path.join(shots, "login.png"), "png");
  fs.writeFileSync(path.join(shots, "pc", "root.png"), "png");
  fs.writeFileSync(path.join(shots, "render.log"), "log"); // ⛔ ไม่ใช่รูป = ไม่แสดง
  fs.writeFileSync(path.join(shots, "notes.md"), "# md inside shots is fine");

  const d = listDetailDocs(p);
  expect(names(d.tree)).toEqual([".orches-shots/", "docs/"]);
  const s1 = d.tree[0].children![0];
  expect(s1.name).toBe("sprint-1");
  const role = s1.children![0];
  expect(role.name).toBe("web-shell");
  expect(names(role.children!)).toEqual(["pc/", "login.png", "notes.md"]);
  expect(role.children!.find((c) => c.name === "login.png")!.rel).toBe(
    ".orches-shots/sprint-1/web-shell/login.png",
  );
  expect(names(role.children!.find((c) => c.name === "pc")!.children!)).toEqual(["root.png"]);
});

test("listDetailDocs: other dot-dirs, worktrees and node_modules stay hidden", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  for (const d of [".git", ".claude", "agents/web-shell/docs", "node_modules/pkg", "web/src"])
    fs.mkdirSync(path.join(p, d), { recursive: true });
  fs.writeFileSync(path.join(p, ".git", "notes.md"), "# nope");
  fs.writeFileSync(path.join(p, ".claude", "x.md"), "# nope");
  fs.writeFileSync(path.join(p, "agents", "web-shell", "docs", "a.md"), "# dup checkout");
  fs.writeFileSync(path.join(p, "node_modules", "pkg", "readme.md"), "# dep");
  fs.writeFileSync(path.join(p, "web", "src", "App.tsx"), "code"); // ⛔ ไฟล์อื่นไม่แสดงเหมือนเดิม

  const d = listDetailDocs(p);
  expect(names(d.tree)).toEqual(["docs/"]);
});

test("listDetailDocs: no README, no docs dir → null readme + empty tree, no throw", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-detail-empty-"));
  const d = listDetailDocs(base);
  expect(d.readme).toBeNull();
  expect(d.tree).toEqual([]);
});

test("resolveProjectFile: images open ONLY under .orches-shots, never elsewhere", () => {
  const p = tmpProject();
  const shots = path.join(p, ".orches-shots", "sprint-1");
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, "root.png"), "png");
  fs.mkdirSync(path.join(p, "web", "public"), { recursive: true });
  fs.writeFileSync(path.join(p, "web", "public", "logo.png"), "png");

  expect(resolveProjectFile(p, ".orches-shots/sprint-1/root.png")).toBe(
    path.join(shots, "root.png"),
  );
  // ⛔ รูปที่อื่นในโปรเจกต์ยังเปิดไม่ได้ — ไม่งั้น "ไฟล์อื่นไม่แสดง" กลายเป็นคำพูดลอย ๆ
  expect(resolveProjectFile(p, "web/public/logo.png")).toBeNull();
  expect(resolveProjectFile(p, "../outside.png")).toBeNull();
});

test("resolveProjectFile: accepts any .md under project, rejects traversal, non-md, missing", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "README.md"), "# r");
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "secret.txt"), "nope");
  expect(resolveProjectFile(p, "README.md")).toBe(path.join(p, "README.md"));
  expect(resolveProjectFile(p, "docs/plan.md")).toBe(path.join(p, "docs", "plan.md"));
  expect(resolveProjectFile(p, "../secret.txt")).toBeNull(); // escapes project
  expect(resolveProjectFile(p, "secret.txt")).toBeNull(); // not .md
  expect(resolveProjectFile(p, "docs/nope.md")).toBeNull(); // missing
});

test("renderMarkdown: headings, lists, and inline code become HTML", () => {
  const html = renderMarkdown("# Title\n\n- one\n- two\n\n`code`");
  expect(html).toContain("<h1");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<code>code</code>");
});

test("sanitizeHtml: strips <script>, on* handlers, and javascript: hrefs", () => {
  const dirty =
    '<p onclick="steal()">x</p><script>evil()</script>' +
    '<a href="javascript:alert(1)">l</a><iframe src="http://x"></iframe>';
  const clean = sanitizeHtml(dirty);
  expect(clean).not.toContain("<script");
  expect(clean).not.toContain("onclick");
  expect(clean).not.toContain("javascript:");
  expect(clean).not.toContain("<iframe");
});

// ── mermaid fences (wiki-diagram ของ /orches-drive เขียนบล็อกพวกนี้ทุก sprint) ──────────
// ⛔ กับดักที่เทสพวกนี้ล็อกไว้: ถ้าปล่อยให้ marked escape ตามปกติ `-->` จะกลายเป็น `--&gt;`
//    และ `A & B` เป็น `A &amp; B` → mermaid parse ไม่ผ่าน = ขึ้นกล่อง error แทนรูป
test("mermaid fence → <pre class=mermaid> and arrows survive un-escaped", () => {
  const html = renderMarkdown('```mermaid\nflowchart LR\n  A --> B\n```');
  expect(html).toContain('<pre class="mermaid">');
  expect(html).toContain("A --> B");
  expect(html).not.toContain("--&gt;");
  expect(html).not.toContain('class="language-mermaid"');
});

test("mermaid: & and < are entity-escaped (textContent decodes them back for mermaid)", () => {
  const html = renderMarkdown('```mermaid\nflowchart LR\n  A["a & b"] --> B\n```');
  expect(html).toContain("&amp;");
  expect(html).not.toContain('"a & b"'); // raw & would be invalid HTML
});

test("non-mermaid fences are untouched (still escaped code blocks)", () => {
  const html = renderMarkdown("```ts\nconst x = 1 < 2;\n```");
  expect(html).toContain("<code");
  expect(html).toContain("1 &lt; 2");
  expect(html).not.toContain('class="mermaid"');
});

test("hasMermaid gates the 3.4MB bundle: true only when a block exists", () => {
  expect(hasMermaid(renderMarkdown("```mermaid\nflowchart LR\n A-->B\n```"))).toBe(true);
  expect(hasMermaid(renderMarkdown("# just prose\n\nno diagram here"))).toBe(false);
  expect(hasMermaid(renderMarkdown("```ts\nconst a=1;\n```"))).toBe(false);
});

test("mermaid block survives sanitizeHtml (pre/class must not be stripped)", () => {
  const html = renderMarkdown('```mermaid\nsequenceDiagram\n  A->>B: hi\n```');
  expect(html).toContain('<pre class="mermaid">');
  expect(html).toContain("A->>B: hi");
});
