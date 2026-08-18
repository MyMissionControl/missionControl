import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  canDeleteProjectPath,
  confirmNameMatches,
  removeProjectDir,
  summarizeUnsaved,
  unsavedWarning,
} from "./deleteProject";

function tmpProjects(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-del-"));
  fs.mkdirSync(path.join(base, "projects"), { recursive: true });
  return base;
}

test("canDeleteProjectPath: ยอมรับลูกตรงใต้ projects/ ที่เป็น dir จริง", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(true);
});

test("canDeleteProjectPath: ปฏิเสธ projects root เอง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path นอก projects/", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ที่ไม่มีจริง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects", "ghost")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธไฟล์ (ไม่ใช่ dir)", () => {
  const base = tmpProjects();
  const f = path.join(base, "projects", "afile");
  fs.writeFileSync(f, "x");
  expect(canDeleteProjectPath(f).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ว่าง", () => {
  expect(canDeleteProjectPath("").ok).toBe(false);
});

test("confirmNameMatches: ตรง=true, ผิด/ว่าง=false, trim ก่อนเทียบ", () => {
  expect(confirmNameMatches("foo", "foo")).toBe(true);
  expect(confirmNameMatches("  foo  ", "foo")).toBe(true);
  expect(confirmNameMatches("foo", "bar")).toBe(false);
  expect(confirmNameMatches("", "foo")).toBe(false);
});

test("removeProjectDir: ลบ dir จริงหาย (snapshot no-op)", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(path.join(p, "agents", "r"), { recursive: true });
  fs.writeFileSync(path.join(p, "file.txt"), "x");
  const r = removeProjectDir(p, () => {}); // inject no-op → no real ~/.cache write
  expect(r.deleted).toBe(true);
  expect(fs.existsSync(p)).toBe(false);
});

test("removeProjectDir: snapshot ล้มเหลว → ไม่ลบ + reason", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "keep.txt"), "x");
  const r = removeProjectDir(p, () => {
    throw new Error("disk full");
  });
  expect(r.deleted).toBe(false);
  expect(r.reason).toContain("backup");
  expect(fs.existsSync(p)).toBe(true); // ← project untouched
});

test("removeProjectDir: snapshot ได้รับ path ของ project แล้วค่อยลบ", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p, { recursive: true });
  const resolved_p = fs.realpathSync(p);
  let seen = "";
  const r = removeProjectDir(p, (proj) => {
    seen = proj;
  });
  expect(r.deleted).toBe(true);
  expect(seen).toBe(resolved_p);
  expect(fs.existsSync(p)).toBe(false);
});

test("removeProjectDir: ปฏิเสธ path นอก projects/ (ไม่ลบ)", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  const r = removeProjectDir(p);
  expect(r.deleted).toBe(false);
  expect(fs.existsSync(p)).toBe(true);
});

// ── งานที่จะหายถาวรตอนลบ (audit 2026-07-20 · ยังไม่มีด่านเลยจนถึง 2026-08-18) ────────
// ⛔ docs ถูก snapshot ไว้แล้ว (docsBackup) แต่ **worktree ของ agent ที่ยังไม่ merge** กับ
//   **commit ที่ยังไม่ push** ไม่มีใครสำรอง — ลบแล้วกู้ไม่ได้ · ด่านนี้แค่ "บอกก่อน" ไม่บล็อก
const gitStub =
  (m: Record<string, string | null>) =>
  (args: string[]): string | null => {
    const key = args.includes("worktree") ? "worktree" : args.includes("log") ? "log" : "status";
    return m[key] ?? null;
  };

test("summarizeUnsaved: worktree หลักไม่นับ, นับแต่ของ agent", () => {
  const u = summarizeUnsaved("/p", gitStub({
    worktree: "worktree /p\nHEAD abc\n\nworktree /p/agents/api\nHEAD def\n\nworktree /p/agents/web\nHEAD 123\n",
    log: "",
    status: "",
  }));
  expect(u).toEqual({ worktrees: 2, localCommits: 0, dirty: 0 });
});

test("summarizeUnsaved: นับ commit ที่ยังไม่ push และไฟล์ที่ยังไม่ commit", () => {
  const u = summarizeUnsaved("/p", gitStub({
    worktree: "worktree /p\n",
    log: "abc1234 feat: x\ndef5678 fix: y\n",
    status: " M a.ts\n?? b.ts\n?? c/\n",
  }));
  expect(u).toEqual({ worktrees: 0, localCommits: 2, dirty: 3 });
});

// ⛔ ไม่ใช่ git repo / ไม่มี git บนเครื่อง = ต้องคืน null เงียบ ๆ ห้าม throw:
//   ปุ่มลบต้องใช้งานได้เหมือนเดิมทุกกรณี ด่านนี้เป็นของแถม ไม่ใช่เงื่อนไข
test("summarizeUnsaved: git ใช้ไม่ได้ = null ไม่ throw", () => {
  expect(summarizeUnsaved("/p", () => null)).toBeNull();
});

test("unsavedWarning: ไม่มีอะไรเสี่ยง = เงียบ (ห้ามเตือนลอย ๆ)", () => {
  expect(unsavedWarning({ worktrees: 0, localCommits: 0, dirty: 0 })).toBe("");
  expect(unsavedWarning(null)).toBe("");
});

test("unsavedWarning: บอกเฉพาะตัวที่ไม่ใช่ศูนย์ พร้อมจำนวน", () => {
  const w = unsavedWarning({ worktrees: 2, localCommits: 5, dirty: 0 });
  expect(w).toContain("worktree");
  expect(w).toContain("2");
  expect(w).toContain("5");
  expect(w).not.toContain("ยังไม่ commit");
  expect(w).toContain("กู้ไม่ได้");
});
