// Pure guard + fs removal for the delete-project button (orchestrator screen).
// NO vscode import — unit-tested standalone with `bun test`. The native confirm
// dialogs + tmux running-check live in webview/orchestrator.ts. The path always
// comes from a scanned ResumableProject.path, never user text; this guard is the
// last line against an rm -rf of the wrong directory.
import * as fs from "node:fs";
import * as path from "node:path";

import { snapshotProjectDocs } from "./docsBackup";

/** Deletable only when: exists, resolves (symlinks followed) to a real
 *  directory, is a DIRECT child of a dir named `projects` (i.e.
 *  `.../projects/<name>`), and is not the `projects` dir itself. */
export function canDeleteProjectPath(projectPath: string): { ok: boolean; reason?: string } {
  if (!projectPath || typeof projectPath !== "string") return { ok: false, reason: "path ว่าง" };
  let resolved: string;
  try {
    resolved = fs.realpathSync(projectPath); // follows symlinks + normalizes; throws if missing
  } catch {
    return { ok: false, reason: `ไม่พบโฟลเดอร์: ${projectPath}` };
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    return { ok: false, reason: `stat ไม่ได้: ${resolved}` };
  }
  if (!st.isDirectory()) return { ok: false, reason: "ไม่ใช่โฟลเดอร์" };
  const parent = path.dirname(resolved);
  if (resolved === parent) return { ok: false, reason: "path ไม่ถูกต้อง (root)" };
  if (path.basename(parent) !== "projects")
    return { ok: false, reason: `ต้องเป็นลูกตรงใต้ projects/ (พบ: ${resolved})` };
  return { ok: true };
}

/** type-to-confirm: พิมพ์ (trim แล้ว) ต้องตรง basename เป๊ะ. */
export function confirmNameMatches(typed: string, expected: string): boolean {
  return typeof typed === "string" && typed.trim() === expected;
}

/** Guard → snapshot docs → ลบโฟลเดอร์ (recursive). ไม่ผ่าน guard หรือ snapshot
 *  ล้มเหลว = ไม่ลบ + reason. snapshot injectable เพื่อเทส (default = ตัวจริง). */
export function removeProjectDir(
  projectPath: string,
  snapshot: (p: string) => void = snapshotProjectDocs,
): { deleted: boolean; reason?: string } {
  const g = canDeleteProjectPath(projectPath);
  if (!g.ok) return { deleted: false, reason: g.reason };
  const resolved = fs.realpathSync(projectPath);
  try {
    snapshot(resolved); // back up BEFORE the destructive delete
  } catch (e) {
    return { deleted: false, reason: `backup ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` };
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return { deleted: true };
}

/** งานที่จะหายถาวรตอนลบโปรเจค — นับจาก git ของโปรเจคเอง.
 *
 *  ⛔⛔ ทำไมต้องมี (audit 2026-07-20, ปิดช่องนี้ 2026-08-18): `docs/` ถูก snapshot ไว้แล้ว
 *  (docsBackup) แต่ **worktree ของ agent ที่ยังไม่ merge** กับ **commit ที่ยังไม่ push**
 *  ไม่มีใครสำรอง — `rmSync` แล้วกู้ไม่ได้เลย และตอนนี้ modal ไม่ได้บอกอะไรสักคำ
 *
 *  ⛔ report-only โดยเจตนา: ไม่บล็อกการลบ (โปรเจคที่มี worktree ค้างเป็นเรื่องปกติ และการบล็อก
 *  จะทำให้ปุ่มลบใช้ไม่ได้จนต้องไปล้าง worktree มือทุกครั้ง) · หน้าที่ของมันคือ "บอกก่อนกด"
 *
 *  `git` = ตัวรันที่คืน stdout หรือ null เมื่อคำสั่งล้ม — inject เพื่อเทส และเพื่อให้ฝั่ง host
 *  ยิง git แบบ async ได้ (ดู probeUnsaved ใน webview/orchestrator.ts) */
export interface UnsavedWork {
  /** worktree ของ agent (ไม่นับตัว main) — งาน sprint ที่ยังไม่ merge */
  worktrees: number;
  /** commit ที่อยู่บน branch ใน repo นี้แต่ไม่มีบน remote ไหนเลย */
  localCommits: number;
  /** ไฟล์ที่ยังไม่ commit (รวม untracked ที่ไม่ถูก gitignore) */
  dirty: number;
}

export function summarizeUnsaved(
  projectPath: string,
  git: (args: string[]) => string | null,
): UnsavedWork | null {
  // ⛔ ไม่ใช่ git repo / ไม่มี git = null ไม่ใช่ศูนย์ — "ไม่รู้" ต้องไม่ถูกอ่านว่า "ไม่มีอะไรเสี่ยง"
  const wt = git(["-C", projectPath, "worktree", "list", "--porcelain"]);
  if (wt === null) return null;
  const lines = (t: string): number => t.split("\n").filter((l) => l.trim() !== "").length;
  const worktrees = Math.max(0, wt.split("\n").filter((l) => l.startsWith("worktree ")).length - 1);
  // ⛔ `--branches --not --remotes` = commit ที่ไม่มีบน remote ไหนเลย · repo ที่ไม่มี remote จะได้
  //   ทั้งหมด ซึ่งถูกต้อง: ลบแล้วหายจริงทุก commit
  const localCommits = lines(git(["-C", projectPath, "log", "--branches", "--not", "--remotes", "--oneline"]) ?? "");
  const dirty = lines(git(["-C", projectPath, "status", "--porcelain"]) ?? "");
  return { worktrees, localCommits, dirty };
}

/** ประโยคเดียวสำหรับ modal · "" = ไม่มีอะไรเสี่ยง (ด่านที่เตือนทุกครั้งคือด่านที่คนเลิกอ่าน).
 *  ⛔ ไม่ใช้สัญลักษณ์/emoji สื่อความหมาย — user อ่านไม่ออก (renders blank) ต้องเป็นคำ */
export function unsavedWarning(u: UnsavedWork | null): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.worktrees) parts.push(`worktree ที่ยังไม่ merge ${u.worktrees}`);
  if (u.localCommits) parts.push(`commit ที่ยังไม่ push ${u.localCommits}`);
  if (u.dirty) parts.push(`ไฟล์ที่ยังไม่ commit ${u.dirty}`);
  if (!parts.length) return "";
  return `จะหายถาวรและกู้ไม่ได้: ${parts.join(" · ")}`;
}
