// Durable snapshot of a project's docs, taken right before the project is
// deleted (deleteProject.ts). Mirrors the Budget ledger pattern (usage.ts):
// a name-keyed manifest under ~/.cache/mission-control/, surviving the delete.
// NO vscode import — unit-tested standalone with `bun test`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MANIFEST_VERSION = 1;

export interface BackupEntry {
  name: string; // project name — manifest key and backup folder name
  backupDir: string; // absolute path to the backup folder
  deletedAt: string; // ISO date the snapshot was taken
}

/** Root of the backup area. Overridable via MC_DOCS_BACKUP_DIR (tests). */
function backupRoot(): string {
  return (
    process.env.MC_DOCS_BACKUP_DIR ||
    path.join(os.homedir(), ".cache", "mission-control", "docs-backup")
  );
}
function manifestPath(): string {
  return path.join(backupRoot(), "manifest.json");
}

function readManifest(): Record<string, BackupEntry> {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as {
      v?: number;
      entries?: Record<string, BackupEntry>;
    };
    if (obj?.v === MANIFEST_VERSION && obj.entries) return obj.entries;
  } catch {
    /* no/corrupt manifest → treated as empty (spec: no auto-repair) */
  }
  return {};
}
function writeManifest(entries: Record<string, BackupEntry>): void {
  fs.mkdirSync(backupRoot(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify({ v: MANIFEST_VERSION, entries }));
}

/** Copy <project>/README.md + <project>/docs/ into the backup area and record
 *  the manifest entry (keyed by project name). THROWS on any fs failure — the
 *  caller treats a throw as "do not proceed with the delete". A same-name
 *  backup is overwritten (project names are unique per GitHub repo; see spec). */
export function snapshotProjectDocs(
  projectPath: string,
  deletedAt: string = new Date().toISOString(),
): void {
  const name = path.basename(projectPath);
  const root = backupRoot();
  const dest = path.join(root, name);
  // ⛔ Copy into staging, THEN swap. The older backup is usually the only copy left
  // (its project was deleted), so it must survive until the new one is complete on
  // disk: rmSync-first meant one failed copy (disk full, EACCES, a source that
  // changed shape) destroyed the old backup and left a half-written folder that the
  // manifest still pointed at — a "restore" that silently restores nothing.
  // Dot-prefixed so a half-written copy can never be mistaken for a real backup.
  const staging = path.join(root, `.staging-${name}`);
  fs.mkdirSync(root, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const readme = path.join(projectPath, "README.md");
    if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(staging, "README.md"));
    const docs = path.join(projectPath, "docs");
    if (fs.existsSync(docs)) fs.cpSync(docs, path.join(staging, "docs"), { recursive: true });
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true }); // leave no debris behind
    throw e;
  }
  fs.rmSync(dest, { recursive: true, force: true }); // the swap: old out...
  fs.renameSync(staging, dest); //                     ...new in, same filesystem
  const entries = readManifest();
  entries[name] = { name, backupDir: dest, deletedAt };
  writeManifest(entries);
}

/** Every recorded backup. Empty if nothing has been backed up yet. */
export function listBackedUpProjects(): BackupEntry[] {
  return Object.values(readManifest());
}
