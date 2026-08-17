// Which entries under a projects/ dir are real projects. fs only, no vscode —
// so `bun test` can run it against a real temp tree (see projectScan.test.ts).

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Entries under one projects/ dir that can actually BE a project: real
 * directories, following symlinks.
 *
 * ⛔ The stat is the point. `soulbrew/projects/` holds bridge symlinks into
 * owner-root/projects, and deleting a project leaves its link behind pointing at
 * nothing. Those dangling links used to list as ghost projects: the card stayed
 * on screen after a SUCCESSFUL delete (so the delete looked broken — reported
 * 2026-08-17, with the folder gone and the docs backup written), and the row
 * then spawned `git` in a cwd that no longer exists ("spawn git ENOENT" in the
 * extension host log). A link to nowhere is not a project.
 */
export function listProjectDirsIn(projectsDir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(projectsDir);
  } catch {
    return out; // no such projects/ dir
  }
  for (const n of names) {
    if (n === "ψ" || n.startsWith(".")) continue;
    const p = path.join(projectsDir, n);
    try {
      if (!fs.statSync(p).isDirectory()) continue; // statSync follows the symlink
    } catch {
      continue; // dangling symlink / vanished mid-scan
    }
    out.push(p);
  }
  return out;
}
