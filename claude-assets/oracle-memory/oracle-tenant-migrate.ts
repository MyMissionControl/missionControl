#!/usr/bin/env bun
/**
 * Oracle tenant migration — label existing docs per vault (blocker 2).
 *
 *   bun ~/.claude/oracle-tenant-migrate.ts                 # dry-run report (default)
 *   bun ~/.claude/oracle-tenant-migrate.ts --audit          # what COULD be attributed, map or not
 *   bun ~/.claude/oracle-tenant-migrate.ts --apply          # backup + label + write journal
 *   bun ~/.claude/oracle-tenant-migrate.ts --revert <file>  # exact undo from a journal
 *
 * Switch flipping — edits the map file for you, no hand-editing JSON:
 *   --label <vault> [tenant]   tag that vault's docs (nothing hidden yet)
 *   --isolate <vault>          that oracle now sees ONLY its own tenant
 *   --unisolate <vault>        un-isolate, keep the labels
 *   --off <vault>              drop both switches for that vault
 *
 * Nothing is written without --apply. --apply always VACUUM INTOs a backup
 * first and journals every prior tenant_id, so --revert restores row-for-row.
 *
 * READ BEFORE --apply: labelling is only half of isolation. A reader that does
 * not set ORACLE_TENANT_ID sees ALL tenants (the engine only filters when a
 * tenant is declared), so labelling alone changes nothing for today's oracles.
 * These paths are the exception — they call activeTenantId(), which falls back
 * to 'default', so they DO stop counting relabelled rows:
 *   src/server/dashboard.ts · src/routes/dashboard/session-stats.ts
 *   src/routes/traces/tenant-scope.ts · src/routes/supersede/{create,list,chain}.ts
 *   src/search/pointer-index.ts (defaults 'default'; table is EMPTY today)
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs';
import { basename, join } from 'path';
import {
  DEFAULT_DATA_DIR, DEFAULT_MAP_FILE, DEFAULT_TENANT_ID, applyStamp, backupDb, ensureTenant,
  isValidTenantId, loadTenantMap, openDb, planStamp, revertFromJournal, sourceScope, tenantForVault,
} from './oracle-tenant.ts';

const HOME = process.env.HOME!;
const BASES = [`${HOME}/Desktop/soulbrew/github.com/fufu-2345`, HOME];
const DATA_DIR = process.env.ORACLE_DATA_DIR || DEFAULT_DATA_DIR;
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

function discoverVaults(): string[] {
  const out = new Set<string>();
  for (const base of BASES) {
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const e of entries) {
      const root = join(base, e);
      if (root.includes('/.arra-oracle-v2')) continue;
      if (existsSync(join(root, 'ψ', 'memory'))) out.add(root);
    }
  }
  return [...out].sort();
}

function fmt(n: number) { return String(n).padStart(5); }

/** Machine-readable status for the Mission Control Settings page. */
function statusJson() {
  const map = loadTenantMap();
  syncIsolationMarker(map.isolateReads);
  const db = openDb(DATA_DIR, true);
  const count = (sql: string, ...a: string[]) =>
    (db.query(sql).get(...a) as { c: number }).c;
  const out = {
    mapFile: process.env.ORACLE_TENANT_MAP || `${HOME}/.claude/oracle-tenant-map.json`,
    dbFile: join(DATA_DIR, 'oracle.db'),
    documents: count('SELECT COUNT(*) c FROM oracle_documents'),
    onDefault: count('SELECT COUNT(*) c FROM oracle_documents WHERE tenant_id = ?', DEFAULT_TENANT_ID),
    vaults: discoverVaults().map((vaultRoot) => {
      const vault = basename(vaultRoot);
      const tenant = tenantForVault(vaultRoot, map) ?? null;
      return {
        vault,
        path: vaultRoot,
        scope: sourceScope(vaultRoot),
        tenant,
        isolated: map.isolateReads.some((k) => basename(k) === vault),
        pending: planStamp(db, { vaultRoot }).length,
        labelled: tenant ? count('SELECT COUNT(*) c FROM oracle_documents WHERE tenant_id = ?', tenant) : 0,
      };
    // Two roots can share a basename (~/bob-oracle vs .../fufu-2345/bob-oracle) and
    // the map keys on the name, so collapse to the one that actually owns docs —
    // otherwise the Settings page shows two rows for one oracle.
    }).filter((v) => v.tenant || v.pending > 0)
      .sort((a, b) => b.pending - a.pending)
      .filter((v, i, all) => all.findIndex((o) => o.vault === v.vault) === i),
  };
  db.close();
  console.log(JSON.stringify(out));
}

function report(audit: boolean) {
  const map = loadTenantMap();
  syncIsolationMarker(map.isolateReads);
  const db = openDb(DATA_DIR, true);
  const total = (db.query('SELECT COUNT(*) c FROM oracle_documents').get() as { c: number }).c;
  const onDefault = (db.query('SELECT COUNT(*) c FROM oracle_documents WHERE tenant_id = ?')
    .get(DEFAULT_TENANT_ID) as { c: number }).c;
  console.log(`db          ${join(DATA_DIR, 'oracle.db')}`);
  console.log(`documents   ${total} total · ${onDefault} on '${DEFAULT_TENANT_ID}'`);
  console.log(`labelled    ${Object.keys(map.vaults).length ? JSON.stringify(map.vaults) : '(none = every vault shares one memory)'}`);
  console.log(`isolated    ${map.isolateReads.length ? map.isolateReads.join(', ') : '(none = every oracle still reads all tenants)'}`);
  console.log('');
  let claimed = 0;
  for (const vault of discoverVaults()) {
    const tenant = tenantForVault(vault, map);
    if (!tenant && !audit) continue;
    const rows = planStamp(db, { vaultRoot: vault });
    const byPath = rows.filter((r) => r.via === 'path').length;
    if (!audit && rows.length === 0) continue;
    claimed += tenant ? rows.length : 0;
    console.log(
      `${fmt(rows.length)} docs  ${(tenant ?? '-').padEnd(10)} ${sourceScope(vault)}` +
      `  (path ${byPath} · project ${rows.length - byPath})`,
    );
  }
  const unclaimed = onDefault - claimed;
  console.log('');
  console.log(`would relabel ${claimed} · would stay on '${DEFAULT_TENANT_ID}' ${unclaimed}`);
  if (!Object.keys(map.vaults).length) {
    console.log("nothing to do — map is empty. Add vaults to ~/.claude/oracle-tenant-map.json first.");
  } else if (!has('--apply')) {
    console.log('dry-run only. Re-run with --apply to write.');
  }
  db.close();
}

function apply() {
  const map = loadTenantMap();
  if (!Object.keys(map.vaults).length) {
    console.error('refusing: ~/.claude/oracle-tenant-map.json has no vaults mapped.');
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const db = openDb(DATA_DIR);
  const backup = backupDb(db, join(DATA_DIR, `oracle.db.tenant-bak-${stamp}`));
  const journal = join(DATA_DIR, `tenant-migrate-${stamp}.jsonl`);
  console.log(`backup      ${backup}`);
  console.log(`journal     ${journal}`);
  let changed = 0;
  for (const vault of discoverVaults()) {
    const tenant = tenantForVault(vault, map);
    if (!tenant) continue;
    const rows = planStamp(db, { vaultRoot: vault });
    if (!rows.length) { console.log(`  0 ${sourceScope(vault)} -> ${tenant} (nothing on default)`); continue; }
    ensureTenant(db, tenant);
    const n = applyStamp(db, rows, tenant, journal);
    changed += n;
    console.log(`${fmt(n)} ${sourceScope(vault)} -> ${tenant}`);
  }
  console.log(`\nrelabelled ${changed} docs. Undo: bun ${import.meta.path} --revert ${journal}`);
  db.close();
}

function revert(file: string) {
  if (!existsSync(file)) { console.error(`journal not found: ${file}`); process.exit(2); }
  const db = openDb(DATA_DIR);
  const n = revertFromJournal(db, file);
  console.log(`restored ${n} docs from ${file}`);
  db.close();
}

const MARK = process.env.ORACLE_ISOLATION_MARK || `${HOME}/.claude/oracle-isolation-ON`;

/**
 * Marker file the PreToolUse ψ-guard hook checks before starting python.
 *
 * WHY a marker and not "grep the map": the guard hook runs on every
 * Read/Grep/Glob/Bash/Edit/Write, and a python start costs ~35ms on this box
 * (measured) — unacceptable while isolation is off. Greping the JSON was the
 * first attempt and it FAILED twice: it matched a filled-in `_example` line
 * (guard ran always), and anchoring the pattern then missed a single-line map
 * (guard silently never ran). A marker is format-independent: `[ -e ]` costs
 * nothing and cannot half-match. Re-synced on every map write and every status
 * read, so it self-heals.
 */
export function syncIsolationMarker(isolateReads: string[], file = MARK): void {
  // one vault dir NAME per line — the bash guard compares basenames, so paths
  // in the map must be normalised here, not in the hot hook.
  if (isolateReads.length) writeFileSync(file, isolateReads.map((v) => basename(v)).join('\n') + '\n');
  else if (existsSync(file)) rmSync(file);
}

/** Rewrites only `vaults` / `isolateReads`; every other key (the _doc help) is kept. */
function editMap(mutate: (m: { vaults: Record<string, string>; isolateReads: string[] }) => string): void {
  const file = DEFAULT_MAP_FILE;
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  raw.vaults ??= {};
  raw.isolateReads ??= [];
  const msg = mutate(raw);
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  syncIsolationMarker(raw.isolateReads);
  console.log(msg);
  console.log(`\nlabelled    ${JSON.stringify(raw.vaults)}`);
  console.log(`isolated    ${raw.isolateReads.length ? raw.isolateReads.join(', ') : '(none)'}`);
}

/** Accepts a vault dir name or any path to it. */
function vaultArg(value: string | undefined): string {
  const key = basename((value ?? '').replace(/\/+$/, ''));
  if (!key) { console.error('usage: --label|--isolate|--unisolate|--off <vault-dir> [tenant]'); process.exit(2); }
  const known = discoverVaults().map((v) => basename(v));
  if (!known.includes(key)) console.error(`warning: no vault named '${key}' found (known: ${known.join(', ')})`);
  return key;
}

function label(vault: string, tenant?: string) {
  const id = (tenant ?? vault.replace(/-oracle$/, '')).trim();
  if (!isValidTenantId(id)) { console.error(`invalid tenant id: ${id}`); process.exit(2); }
  editMap((m) => {
    m.vaults[vault] = id;
    return `labelled ${vault} -> tenant '${id}'. Next: --report then --apply to backfill old docs.`;
  });
}

function isolate(vault: string, on: boolean) {
  if (on && !loadTenantMap().vaults[vault]) {
    console.error(`refusing: ${vault} has no tenant yet — run --label ${vault} first.`);
    process.exit(2);
  }
  editMap((m) => {
    m.isolateReads = m.isolateReads.filter((v: string) => basename(v) !== vault);
    if (on) m.isolateReads.push(vault);
    return on
      ? `isolated ${vault}. Restart that oracle's session; it will read only its own tenant.`
      : `un-isolated ${vault}. Labels kept; it reads all tenants again.`;
  });
}

function off(vault: string) {
  editMap((m) => {
    delete m.vaults[vault];
    m.isolateReads = m.isolateReads.filter((v: string) => basename(v) !== vault);
    return `${vault} back to shared. Existing labels stay in the DB — undo them with --revert <journal>.`;
  });
}

const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const revertIdx = args.indexOf('--revert');
if (revertIdx >= 0) revert(args[revertIdx + 1] ?? '');
else if (has('--json')) statusJson();
else if (has('--label')) label(vaultArg(flag('--label')), args[args.indexOf('--label') + 2]);
else if (has('--isolate')) isolate(vaultArg(flag('--isolate')), true);
else if (has('--unisolate')) isolate(vaultArg(flag('--unisolate')), false);
else if (has('--off')) off(vaultArg(flag('--off')));
else if (has('--apply')) apply();
else report(has('--audit'));
