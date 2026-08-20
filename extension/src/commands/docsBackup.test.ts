import { expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { snapshotProjectDocs, listBackedUpProjects } from "./docsBackup";

let backupRoot: string;
let srcBase: string;

beforeEach(() => {
  backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-bkp-root-"));
  srcBase = fs.mkdtempSync(path.join(os.tmpdir(), "mc-bkp-src-"));
  process.env.MC_DOCS_BACKUP_DIR = backupRoot;
});
afterEach(() => {
  delete process.env.MC_DOCS_BACKUP_DIR;
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(srcBase, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const p = path.join(srcBase, name);
  fs.mkdirSync(path.join(p, "docs", "wiki"), { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# " + name);
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# แผน\n- [x] Sprint 1\n");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "overview");
  return p;
}

test("snapshotProjectDocs: copies README + full docs tree + writes manifest", () => {
  const p = makeProject("foo");
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");

  const dest = path.join(backupRoot, "foo");
  expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("# foo");
  expect(fs.existsSync(path.join(dest, "docs", "plan.md"))).toBe(true);
  expect(fs.readFileSync(path.join(dest, "docs", "wiki", "overview.md"), "utf8")).toBe("overview");

  const list = listBackedUpProjects();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "foo", backupDir: dest, deletedAt: "2026-07-20T00:00:00.000Z" });
});

test("snapshotProjectDocs: same name overwrites the older backup", () => {
  const p1 = makeProject("dup");
  snapshotProjectDocs(p1, "2026-07-01T00:00:00.000Z");
  // second project, same name, different content
  fs.rmSync(path.join(srcBase, "dup"), { recursive: true, force: true });
  const p2 = path.join(srcBase, "dup");
  fs.mkdirSync(path.join(p2, "docs"), { recursive: true });
  fs.writeFileSync(path.join(p2, "docs", "plan.md"), "NEW");
  snapshotProjectDocs(p2, "2026-07-20T00:00:00.000Z");

  expect(fs.readFileSync(path.join(backupRoot, "dup", "docs", "plan.md"), "utf8")).toBe("NEW");
  expect(fs.existsSync(path.join(backupRoot, "dup", "README.md"))).toBe(false); // p2 had none → clean overwrite
  const list = listBackedUpProjects();
  expect(list).toHaveLength(1);
  expect(list[0].deletedAt).toBe("2026-07-20T00:00:00.000Z");
});

test("snapshotProjectDocs: project with no docs/ and no README → empty backup, still recorded", () => {
  const p = path.join(srcBase, "bare");
  fs.mkdirSync(p, { recursive: true });
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");
  expect(fs.existsSync(path.join(backupRoot, "bare"))).toBe(true);
  expect(listBackedUpProjects().map((e) => e.name)).toEqual(["bare"]);
});

test("listBackedUpProjects: no manifest → empty array", () => {
  expect(listBackedUpProjects()).toEqual([]);
});

// ⛔ The old backup is often the ONLY copy: the project it came from was deleted.
// snapshotProjectDocs used to rmSync(dest) as its FIRST statement and copy after,
// so any failure mid-copy (disk full, EACCES, a source that changed shape) left the
// previous backup destroyed and a half-written one in its place — with the manifest
// still pointing at it, so "restore" would silently restore nothing.
test("snapshotProjectDocs: การคัดลอกล้มเหลว → แบ็กอัปเก่าต้องไม่หาย", () => {
  const p = makeProject("bar");
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");
  const dest = path.join(backupRoot, "bar");
  expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("# bar");

  // make the copy fail deterministically without touching permissions:
  // README.md becomes a DIRECTORY, so existsSync() still says yes and
  // copyFileSync throws EISDIR partway through the snapshot.
  fs.rmSync(path.join(p, "README.md"));
  fs.mkdirSync(path.join(p, "README.md"));
  expect(() => snapshotProjectDocs(p, "2026-08-20T00:00:00.000Z")).toThrow();

  // the first backup survived, whole
  expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("# bar");
  expect(fs.readFileSync(path.join(dest, "docs", "wiki", "overview.md"), "utf8")).toBe("overview");
  const list = listBackedUpProjects();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "bar", deletedAt: "2026-07-20T00:00:00.000Z" });
});

test("snapshotProjectDocs: ล้มเหลวแล้วไม่ทิ้งขยะ staging ไว้ในที่เก็บแบ็กอัป", () => {
  const p = makeProject("baz");
  fs.rmSync(path.join(p, "README.md"));
  fs.mkdirSync(path.join(p, "README.md"));
  expect(() => snapshotProjectDocs(p)).toThrow();
  // nothing half-written may sit in the backup area — a stray folder there is
  // indistinguishable from a real backup to anyone reading the directory.
  expect(fs.readdirSync(backupRoot).filter((e) => e !== "manifest.json")).toEqual([]);
});
