// Writing fetched skills to disk — the half of the URL uploader that touches the
// filesystem. Split out of skills.ts (which imports vscode) so `bun test` can run
// a real install into a temp dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isSafeRelPath, type FetchedSkill } from "./skillsFetch";

export interface InstallReport {
  installed: string[];
  /** name → why it could not be written (already there, unsafe path, disk error). */
  failed: Array<{ name: string; message: string }>;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** A folder name that is safe to create directly under the skills dir. */
export function isSafeSkillFolder(name: string): boolean {
  return SAFE_NAME.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

/** Write one fetched skill: temp dir → all files → marker → move into place.
 *
 *  ⛔ Why the temp dir instead of writing straight to the destination: a skill is
 *  LOADED AND ACTED ON by Claude. A download that dies halfway (network drop, a
 *  cap trip) would otherwise leave a folder holding a SKILL.md whose references/
 *  and scripts/ are missing — which looks installed and then misbehaves. Either
 *  the whole skill lands or nothing does.
 *
 *  Existing names are never overwritten: a re-paste must not silently revert a
 *  skill the user edited by hand. Never throws. */
export function writeFetchedSkill(
  skillsRoot: string,
  skill: FetchedSkill,
  markerName: string,
): { ok: true } | { ok: false; message: string } {
  if (!isSafeSkillFolder(skill.name)) return { ok: false, message: "unsafe name" };
  const dest = path.join(skillsRoot, skill.name);
  if (fs.existsSync(dest)) return { ok: false, message: "already installed" };
  if (!skill.files.some((f) => f.rel === "SKILL.md")) return { ok: false, message: "no SKILL.md" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skill-url-"));
  try {
    for (const f of skill.files) {
      // isSafeRelPath already gated this upstream; the resolve check is the one
      // that actually guards the filesystem call.
      if (!isSafeRelPath(f.rel)) return { ok: false, message: `unsafe path: ${f.rel}` };
      const target = path.join(tmp, f.rel);
      if (!path.resolve(target).startsWith(path.resolve(tmp) + path.sep)) {
        return { ok: false, message: `path escapes the folder: ${f.rel}` };
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    fs.writeFileSync(path.join(tmp, markerName), ""); // → the panel's "uploaded" bucket
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.cpSync(tmp, dest, { recursive: true });
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(dest, { recursive: true, force: true }); // a half-copy is worse than nothing
    } catch {
      /* best effort */
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort — temp dir cleanup */
    }
  }
}

/** Write every fetched skill; one bad skill never stops the rest. */
export function installFetchedSkills(
  skillsRoot: string,
  skills: FetchedSkill[],
  markerName: string,
): InstallReport {
  const report: InstallReport = { installed: [], failed: [] };
  for (const s of skills) {
    const r = writeFetchedSkill(skillsRoot, s, markerName);
    if (r.ok) report.installed.push(s.name);
    else report.failed.push({ name: s.name, message: r.message });
  }
  return report;
}
