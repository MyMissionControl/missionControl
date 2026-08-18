import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildProjectRow,
  loadProjectDocTree,
  loadProjectPlan,
  loadProjectTasks,
  parseSprintDoc,
  parseSprintTasks,
} from "./dataView";

function tmpProject(name = "proj"): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-"));
  const p = path.join(base, name);
  fs.mkdirSync(path.join(p, "docs"), { recursive: true });
  return p;
}
function writeDoc(p: string, rel: string, body: string) {
  const abs = path.join(p, "docs", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// ---- parseSprintDoc ----

test("parseSprintDoc: heading, date, done status", () => {
  const raw = "# Sprint 3 — Browse\n_2026-07-16 · สถานะ: เสร็จครบ_\n";
  expect(parseSprintDoc("proj-sprint-3.md", raw)).toMatchObject({
    n: 3,
    name: "Browse",
    date: "2026-07-16",
    done: true,
  });
});
test("parseSprintDoc: not-done status", () => {
  const raw = "# Sprint 4 — Timeline\n_2026-07-18 · สถานะ: ยังไม่เสร็จ_\n";
  expect(parseSprintDoc("sprint-4.md", raw)?.done).toBe(false);
});
test("parseSprintDoc: legacy format (no status line) counts as done", () => {
  // older orches docs had no `สถานะ:` line, just a merged-commit marker
  const raw = "# Sprint 1 — backend-core\n**merged:** `cd6252e`\n## Built\n- doing stuff";
  expect(parseSprintDoc("sprint-1.md", raw)?.done).toBe(true);
});
test("parseSprintDoc: non-sprint filename → null", () => {
  expect(parseSprintDoc("plan.md", "x")).toBeNull();
});

// ---- parseSprintTasks ----

const TASK_DOC = [
  "# Sprint 2 — Marketplace",
  "_2026-08-01 · สถานะ: เสร็จครบ_",
  "",
  "## สปรินต์นี้ทำอะไร",
  "เปิดหน้า marketplace ให้ใช้งานได้จริง",
  "",
  "## ทำอะไรเสร็จบ้าง",
  "- **หน้า marketplace ใช้งานได้จริง** — เห็นสกิลทั้งหมดเป็นการ์ด",
  "- กรองหาสกิลที่ต้องการ",
  "    - กรองด้วย tag (รายละเอียดย่อย ไม่ใช่ task)",
  "- ติดดาวสกิลที่ชอบ",
  "",
  "## ⚠️ ข้อควรรู้ / ยังค้าง",
  "- หน้ารายละเอียดสกิลยังเป็นหน้าเปล่า",
  "- ยังไม่มีหน้าแก้ไข/ลบสกิล",
  "",
  "---",
  "## 🧩 รายละเอียดเชิงเทคนิค",
  "- **ไฟล์ที่แตะ:** `app/api/skills/**`",
].join("\n");

test("parseSprintTasks: done bullets come from ทำอะไรเสร็จบ้าง", () => {
  expect(parseSprintTasks(TASK_DOC).done).toEqual([
    "หน้า marketplace ใช้งานได้จริง — เห็นสกิลทั้งหมดเป็นการ์ด",
    "กรองหาสกิลที่ต้องการ",
    "ติดดาวสกิลที่ชอบ",
  ]);
});

test("parseSprintTasks: pending bullets come from the ยังค้าง heading", () => {
  expect(parseSprintTasks(TASK_DOC).pending).toEqual([
    "หน้ารายละเอียดสกิลยังเป็นหน้าเปล่า",
    "ยังไม่มีหน้าแก้ไข/ลบสกิล",
  ]);
});

test("parseSprintTasks: a section stops at the next ## heading", () => {
  // the technical section below ยังค้าง must not leak into pending
  expect(parseSprintTasks(TASK_DOC).pending).not.toContain(
    "**ไฟล์ที่แตะ:** `app/api/skills/**`",
  );
});

test("parseSprintTasks: indented sub-bullets are not tasks", () => {
  expect(parseSprintTasks(TASK_DOC).done).not.toContain("กรองด้วย tag (รายละเอียดย่อย ไม่ใช่ task)");
});

test("parseSprintTasks: older English docs use Delivered / Built as the done list", () => {
  const raw = "# Sprint 2\n\n## Delivered — `packages/x`\n- built the thing\n\n## Verify gate\n- PASS";
  expect(parseSprintTasks(raw)).toEqual({ done: ["built the thing"], pending: [] });
  expect(parseSprintTasks("# S1\n## Built\n- the db\n").done).toEqual(["the db"]);
});

test("parseSprintTasks: a heading that merely mentions a keyword is not a task list", () => {
  // "Notes for later sprints" / "Gotchas harvested" are commentary, not ค้าง items
  const raw = "# S1\n## Notes for later sprints\n- think about caching\n";
  expect(parseSprintTasks(raw)).toEqual({ done: [], pending: [] });
});

test("parseSprintTasks: missing sections → empty lists", () => {
  expect(parseSprintTasks("# Sprint 1 — Foundation\n_2026-07-31_\n")).toEqual({
    done: [],
    pending: [],
  });
});

// ---- loadProjectTasks ----

test("loadProjectTasks: one entry per sprint doc, ascending, with counts", () => {
  const p = tmpProject("tasky");
  writeDoc(p, "plan.md", "# แผน\n- [x] Sprint 1\n- [x] Sprint 2\n");
  writeDoc(
    p,
    "tasky-sprint-2.md",
    "# Sprint 2 — Marketplace\n_2026-08-01 · สถานะ: เสร็จครบ_\n## ทำอะไรเสร็จบ้าง\n- ก\n- ข\n## ยังค้าง\n- ค\n",
  );
  writeDoc(
    p,
    "tasky-sprint-1.md",
    "# Sprint 1 — Foundation\n_2026-07-31 · สถานะ: เสร็จครบ_\n## ทำอะไรเสร็จบ้าง\n- จ\n",
  );

  const sprints = loadProjectTasks(p);
  expect(sprints.map((s) => s.n)).toEqual([1, 2]);
  expect(sprints[0]).toMatchObject({ name: "Foundation", date: "2026-07-31", done: ["จ"], pending: [] });
  expect(sprints[1]).toMatchObject({ name: "Marketplace", done: ["ก", "ข"], pending: ["ค"] });
  expect(sprints[1].file).toBe(path.join(p, "docs", "tasky-sprint-2.md"));
  // rel is what keys the sprint to its row in the file tree — without it the Data View
  // table shows the sprint doc as a plain file with no task drill-down.
  expect(sprints.map((x) => x.rel)).toEqual(["docs/tasky-sprint-1.md", "docs/tasky-sprint-2.md"]);
});

test("loadProjectTasks: project with no docs/ → empty list", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-notasks-"));
  expect(loadProjectTasks(base)).toEqual([]);
});

// ---- loadProjectPlan ----

test("loadProjectPlan: splits plan.md checklist into done / pending", () => {
  const p = tmpProject();
  writeDoc(p, "plan.md", "# แผน\n- [x] Sprint 1 — วางฐานระบบ\n- [X] Sprint 2 — Marketplace\n- [ ] Sprint 3 — รายละเอียด\n");
  const plan = loadProjectPlan(p);
  expect(plan?.rel).toBe("docs/plan.md");
  expect(plan?.file).toBe(path.join(p, "docs", "plan.md"));
  expect(plan?.done).toEqual(["Sprint 1 — วางฐานระบบ", "Sprint 2 — Marketplace"]);
  expect(plan?.pending).toEqual(["Sprint 3 — รายละเอียด"]);
});
test("loadProjectPlan: no plan.md → null", () => {
  const p = tmpProject();
  writeDoc(p, "sprint-1.md", "# Sprint 1 — x");
  expect(loadProjectPlan(p)).toBeNull();
});
test("loadProjectPlan: plan.md without checkboxes → empty lists (row still openable)", () => {
  const p = tmpProject();
  writeDoc(p, "plan.md", "# แผน\nプレーンテキスト no checklist here\n");
  const plan = loadProjectPlan(p);
  expect(plan?.done).toEqual([]);
  expect(plan?.pending).toEqual([]);
});

// ---- loadProjectDocTree ----

/** Depth-first list of every file rel in the tree, in render order. */
function flatten(nodes: ReturnType<typeof loadProjectDocTree>): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "dir") out.push(...flatten(n.children ?? []));
    else out.push(n.rel);
  }
  return out;
}

test("loadProjectDocTree: the project's real structure — folders kept, nothing renamed", () => {
  const p = tmpProject("docsy");
  writeDoc(p, "plan.md", "# แผน");
  writeDoc(p, "design.md", "# design");
  writeDoc(p, "wiki/api.md", "# api");
  writeDoc(p, "wiki/decisions/0001-storage.md", "# adr");
  writeDoc(p, "docsy-sprint-1.md", "# Sprint 1 — Core");
  fs.writeFileSync(path.join(p, "README.md"), "# readme");

  const tree = loadProjectDocTree(p);
  // dirs before files at each level (alpha within each) — same order as the Projects page
  expect(tree.map((n) => n.name)).toEqual(["docs", "README.md"]);
  expect(flatten(tree)).toEqual([
    "docs/wiki/decisions/0001-storage.md",
    "docs/wiki/api.md",
    "docs/design.md",
    "docs/docsy-sprint-1.md", // sprint docs are ordinary files here, not a separate group
    "docs/plan.md", // so is plan.md
    "README.md",
  ]);
});

test("loadProjectDocTree: .orches-shots screenshots are in, images elsewhere are not", () => {
  const p = tmpProject("shotsy");
  writeDoc(p, "plan.md", "# แผน");
  const shot = path.join(p, ".orches-shots", "sprint-1", "web-shell");
  fs.mkdirSync(shot, { recursive: true });
  fs.writeFileSync(path.join(shot, "login.png"), "x");
  fs.writeFileSync(path.join(shot, "render.log"), "x"); // not an image → out
  fs.mkdirSync(path.join(p, "web", "public"), { recursive: true });
  fs.writeFileSync(path.join(p, "web", "public", "logo.png"), "x"); // outside shots → out

  expect(flatten(loadProjectDocTree(p))).toEqual([
    ".orches-shots/sprint-1/web-shell/login.png",
    "docs/plan.md",
  ]);
});

test("loadProjectDocTree: skips generated dirs and non-markdown", () => {
  const p = tmpProject("docsy3");
  writeDoc(p, "plan.md", "# แผน");
  fs.mkdirSync(path.join(p, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(p, "node_modules", "pkg", "README.md"), "# dep");
  fs.writeFileSync(path.join(p, "notes.txt"), "not markdown");

  expect(flatten(loadProjectDocTree(p))).toEqual(["docs/plan.md"]);
});

test("loadProjectDocTree: project with no markdown → empty", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-nodocs-"));
  expect(loadProjectDocTree(base)).toEqual([]);
});

// ---- buildProjectRow ----

test("buildProjectRow: plan.md checklist drives total/done + in-progress", () => {
  const p = tmpProject("agentskill-v10");
  writeDoc(p, "plan.md", "# แผน\n\n- [x] Sprint 1\n- [x] Sprint 2\n- [ ] Sprint 3\n");
  writeDoc(p, "agentskill-v10-sprint-1.md", "# Sprint 1 — Foundation\n_2026-07-15 · สถานะ: เสร็จครบ_");
  writeDoc(p, "agentskill-v10-sprint-2.md", "# Sprint 2 — Upload\n_2026-07-16 · สถานะ: เสร็จครบ_");
  const row = buildProjectRow(p)!;
  expect(row.name).toBe("agentskill-v10");
  expect(row.sprintsTotal).toBe(3);
  expect(row.sprintsDone).toBe(2);
  expect(row.percentDone).toBe(67);
  expect(row.status).toBe("in-progress");
  expect(row.latestSprint).toMatchObject({ n: 2, name: "Upload", date: "2026-07-16" });
  expect(row.updated).toBe("2026-07-16");
  expect(row.githubUrl).toBeNull();
});

test("buildProjectRow: no plan.md → fallback to sprint docs + done", () => {
  const p = tmpProject("lumen");
  writeDoc(p, "sprint-1.md", "# Sprint 1 — Core\n_2026-07-10 · สถานะ: เสร็จครบ_");
  writeDoc(p, "sprint-2.md", "# Sprint 2 — API\n_2026-07-12 · สถานะ: เสร็จครบ_");
  const row = buildProjectRow(p)!;
  expect(row.sprintsTotal).toBe(2);
  expect(row.sprintsDone).toBe(2);
  expect(row.status).toBe("done");
  expect(row.percentDone).toBe(100);
});

test("buildProjectRow: unchecked plan → not-started", () => {
  const p = tmpProject("shop");
  writeDoc(p, "plan.md", "# แผน\n- [ ] Sprint 1\n");
  const row = buildProjectRow(p)!;
  expect(row.status).toBe("not-started");
  expect(row.sprintsDone).toBe(0);
});

test("buildProjectRow: no docs/ dir → null", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-empty-"));
  expect(buildProjectRow(base)).toBeNull();
});

// ---- backup merge ----

import { buildDataIndex, loadBackupRows } from "./dataView";
import { snapshotProjectDocs } from "./docsBackup";
import { afterEach, beforeEach } from "bun:test";

let bkpRoot: string;
beforeEach(() => {
  bkpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-bkp-"));
  process.env.MC_DOCS_BACKUP_DIR = bkpRoot;
});
afterEach(() => {
  delete process.env.MC_DOCS_BACKUP_DIR;
  fs.rmSync(bkpRoot, { recursive: true, force: true });
});

test("loadBackupRows: backed-up project → tagged deleted row pointing at the backup", () => {
  const p = tmpProject("gone");
  writeDoc(p, "plan.md", "# แผน\n- [x] Sprint 1\n- [ ] Sprint 2\n");
  writeDoc(p, "gone-sprint-1.md", "# Sprint 1 — Core\n_2026-07-10 · สถานะ: เสร็จครบ_");
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");

  const rows = loadBackupRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("gone");
  expect(rows[0].deleted).toBe(true);
  expect(rows[0].deletedAt).toBe("2026-07-20T00:00:00.000Z");
  expect(rows[0].path).toBe(path.join(bkpRoot, "gone"));
  expect(rows[0].githubUrl).toBeNull();
  expect(rows[0].sprintsTotal).toBe(2); // parsed from the backed-up plan.md
});

test("buildDataIndex: merges deleted projects, skips names still live", async () => {
  // an owner root with one LIVE project named 'live1'
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), "mc-owner-"));
  const projects = path.join(owner, "projects");
  const live1 = path.join(projects, "live1");
  fs.mkdirSync(path.join(live1, "docs"), { recursive: true });
  fs.writeFileSync(path.join(live1, "docs", "plan.md"), "# แผน\n- [ ] Sprint 1\n");

  // back up 'gone1' (not live) AND 'live1' (still live → must be skipped)
  const goneSrc = tmpProject("gone1");
  writeDoc(goneSrc, "plan.md", "# แผน\n- [x] Sprint 1\n");
  snapshotProjectDocs(goneSrc, "2026-07-19T00:00:00.000Z");
  snapshotProjectDocs(live1, "2026-07-18T00:00:00.000Z");

  const rows = await buildDataIndex(owner);
  const byName = (n: string) => rows.filter((r) => r.name === n);
  expect(byName("live1")).toHaveLength(1); // not duplicated by its backup
  expect(byName("live1")[0].deleted).toBeUndefined();
  expect(byName("gone1")).toHaveLength(1);
  expect(byName("gone1")[0].deleted).toBe(true);

  fs.rmSync(owner, { recursive: true, force: true });
});
