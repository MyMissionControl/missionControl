/**
 * Oracle per-vault tenant labelling — shared library.
 *
 * WHY this lives here and not in arra-oracle-v3:
 * the live ψ write path is the FORK indexer (~/.arra-fork-indexer, branch
 * fix/audit-bugs) which contains ZERO tenant code — it inserts documents
 * without tenant_id and the column DEFAULT ('default') applies. So no env var
 * or runWithTenant() wrapper can make it write a per-oracle tenant: the only
 * tenant-blind-indexer-compatible fix is to STAMP tenant_id right after the
 * reindex, keyed off each document's own source_file. That is what this does.
 *
 * OFF BY DEFAULT. ~/.claude/oracle-tenant-map.json ships as {"vaults":{}};
 * with no mapping every function is a no-op and behaviour is byte-identical to
 * a build without this file. Nothing here reads or writes the DB unless a
 * vault is explicitly mapped to a tenant.
 *
 * Attribution is deterministic and never guesses:
 *   1. source_file starts with 'github.com/<owner>/<vault>/'  -> that vault
 *   2. else project == 'github.com/<owner>/<vault>'           -> that vault
 *   3. else                                                   -> left alone
 * Rule 3 matters: 1,292 of 3,222 live docs carry a repoRoot-RELATIVE
 * source_file ('ψ/memory/...') with created_by='indexer', so they cannot be
 * attributed by path. They stay on 'default' = still visible to every reader.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { basename, dirname, join } from 'path';

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_MAP_FILE = process.env.ORACLE_TENANT_MAP || `${process.env.HOME}/.claude/oracle-tenant-map.json`;
export const DEFAULT_DATA_DIR = `${process.env.HOME}/.oracle`;

// Same grammar the engine validates against (src/middleware/tenant.ts).
const TENANT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RESERVED = new Set(['constructor', 'prototype']);

export type TenantMap = { vaults: Record<string, string>; isolateReads: string[] };
export type StampRow = { id: string; prev: string; via: 'path' | 'project' };

export function isValidTenantId(id: string): boolean {
  return TENANT_PATTERN.test(id) && !RESERVED.has(id.toLowerCase());
}

/** Missing / malformed / empty map all resolve to "no vault is mapped". */
export function loadTenantMap(file = DEFAULT_MAP_FILE): TenantMap {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TenantMap>;
    const vaults = raw?.vaults;
    const isolateReads = (Array.isArray(raw?.isolateReads) ? raw.isolateReads : [])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/\/+$/, ''));
    if (!vaults || typeof vaults !== 'object' || Array.isArray(vaults)) return { vaults: {}, isolateReads };
    const out: Record<string, string> = {};
    for (const [vault, tenant] of Object.entries(vaults)) {
      if (typeof tenant !== 'string') continue;
      const id = tenant.trim();
      if (!id) continue;
      if (!isValidTenantId(id)) throw new Error(`invalid tenant id for vault ${vault}: ${id}`);
      out[vault.replace(/\/+$/, '')] = id;
    }
    return { vaults: out, isolateReads };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('invalid tenant id')) throw e;
    return { vaults: {}, isolateReads: [] };
  }
}

export function vaultKey(vaultRoot: string): string {
  return basename(vaultRoot.replace(/\/+$/, ''));
}

/**
 * Most-specific key wins: absolute path, then 'github.com/<owner>/<vault>',
 * then bare directory name. Precision is available when two vaults share a
 * basename (e.g. ~/bob-oracle vs .../fufu-2345/bob-oracle); the bare name is
 * the convenient default that covers both.
 */
export function tenantForVault(vaultRoot: string, map: TenantMap = loadTenantMap()): string | undefined {
  const clean = vaultRoot.replace(/\/+$/, '');
  for (const key of [clean, sourceScope(clean), vaultKey(clean)]) {
    const hit = map.vaults[key];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Reading is a SEPARATE switch from labelling, on purpose: `vaults` only tags
 * rows (invisible to every reader that does not declare a tenant), while
 * `isolateReads` is what actually narrows what an oracle can see. Label first,
 * verify with --report, then opt the vault into isolateReads.
 */
export function readTenantForVault(vaultRoot: string, map: TenantMap = loadTenantMap()): string | undefined {
  const tenant = tenantForVault(vaultRoot, map);
  if (!tenant) return undefined;
  const clean = vaultRoot.replace(/\/+$/, '');
  const keys = [clean, sourceScope(clean), vaultKey(clean)];
  return map.isolateReads.some((k) => keys.includes(k)) ? tenant : undefined;
}

/**
 * The source_file prefix the indexer writes for this vault. source_file is
 * stored relative to the ghq-style root, e.g.
 *   /home/u/Desktop/soulbrew/github.com/fufu-2345/bob-oracle
 *     -> 'github.com/fufu-2345/bob-oracle'
 */
export function sourceScope(vaultRoot: string): string {
  const clean = vaultRoot.replace(/\/+$/, '');
  const name = basename(clean);
  const owner = basename(dirname(clean));
  const host = basename(dirname(dirname(clean)));
  return host.includes('.') ? `${host}/${owner}/${name}` : name;
}

export function openDb(dataDir = process.env.ORACLE_DATA_DIR || DEFAULT_DATA_DIR, readonly = false): Database {
  const file = join(dataDir, 'oracle.db');
  if (!existsSync(file)) throw new Error(`oracle db not found: ${file}`);
  // bun:sqlite: {readonly:false} is SQLITE_MISUSE — omit the options entirely.
  const db = readonly ? new Database(file, { readonly: true }) : new Database(file);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Idempotent — closes blocker 1 (documents.tenant_id references tenants.id). */
export function ensureTenant(db: Database, tenantId: string): void {
  if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
  const now = Date.now();
  db.query(
    'INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(tenantId, tenantId, 'active', now, now);
}

/** Rows this vault owns that still sit on `from`. Read-only: safe to call always. */
export function planStamp(
  db: Database,
  opts: { vaultRoot: string; from?: string },
): StampRow[] {
  const scope = sourceScope(opts.vaultRoot);
  const from = opts.from ?? DEFAULT_TENANT_ID;
  return db.query(
    `SELECT id, tenant_id AS prev,
            CASE WHEN source_file LIKE ?1 THEN 'path' ELSE 'project' END AS via
       FROM oracle_documents
      WHERE tenant_id = ?3
        AND (source_file LIKE ?1 OR project = ?2)`,
  ).all(`${scope}/%`, scope, from) as StampRow[];
}

/**
 * Apply a plan. Journals every prior value first (JSONL) so revert is exact,
 * then updates in ONE transaction. Returns the number of rows changed.
 */
export function applyStamp(
  db: Database,
  rows: StampRow[],
  tenantId: string,
  journalFile: string,
): number {
  if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${tenantId}`);
  if (rows.length === 0) return 0;
  appendFileSync(
    journalFile,
    rows.map((r) => JSON.stringify({ id: r.id, prev: r.prev, next: tenantId })).join('\n') + '\n',
  );
  const stmt = db.query('UPDATE oracle_documents SET tenant_id = ?1 WHERE id = ?2 AND tenant_id = ?3');
  const run = db.transaction((batch: StampRow[]) => {
    let n = 0;
    for (const r of batch) n += (stmt.run(tenantId, r.id, r.prev) as { changes: number }).changes;
    return n;
  });
  return run(rows) as number;
}

/** Exact per-row undo from a journal written by applyStamp. */
export function revertFromJournal(db: Database, journalFile: string): number {
  const lines = readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim().startsWith('{'));
  const entries = lines.map((l) => JSON.parse(l) as { id: string; prev: string; next: string });
  const stmt = db.query('UPDATE oracle_documents SET tenant_id = ?1 WHERE id = ?2 AND tenant_id = ?3');
  const run = db.transaction((batch: typeof entries) => {
    let n = 0;
    for (const e of batch.reverse()) n += (stmt.run(e.prev, e.id, e.next) as { changes: number }).changes;
    return n;
  });
  return run(entries) as number;
}

/** Consistent snapshot even with WAL active (sqlite >= 3.27). */
export function backupDb(db: Database, target: string): string {
  db.query(`VACUUM INTO '${target.replace(/'/g, "''")}'`).run();
  return target;
}
