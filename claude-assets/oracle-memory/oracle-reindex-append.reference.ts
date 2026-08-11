/**
 * Append-mode reindex wrapper for the Oracle auto-index hook.
 *
 * The default CLI (src/indexer/cli.ts) runs a NON-append reindex, which
 * smart-deletes every indexer doc whose source file does not exist under the
 * current repoRoot. With a single shared DB (~/.oracle) that means editing one
 * vault wipes every OTHER vault from the index ("1 DB = 1 active vault").
 *
 * Append mode skips smart-delete, so multiple vaults (bob, jack, ...) can
 * coexist in one DB. repoRoot is taken from ORACLE_REPO_ROOT (set by the hook).
 *
 * Tradeoff: append never removes docs for deleted files; run a manual
 * non-append reindex of a single vault when you need to prune it.
 *
 * SELF-CAP (2026-07-18): the alpha indexer (runner.ts) leaks anon memory to
 * 6-8GB per run — uncapped runs spawned by cached PostToolUse hooks repeatedly
 * ballooned and (pre-guard) froze the whole 15GB VM 3x today. Callers cache
 * the COMMAND but this script body is read fresh on every spawn, so the cap
 * lives HERE: before importing anything heavy, re-exec self under a systemd
 * user scope with MemoryMax=3G + MemorySwapMax=512M. A leaking run is then
 * cgroup-killed alone (exit code surfaces; the next memory write retries)
 * instead of taking down the host. Fallback: if the user manager is
 * unreachable (e.g. no XDG_RUNTIME_DIR), run uncapped — callers like the
 * systemd watcher already fence that case with their own service cgroup.
 */
const CAP_FLAG = 'ORACLE_REINDEX_SELF_CAPPED';
if (!process.env[CAP_FLAG]) {
  const probe = Bun.spawnSync(['systemd-run', '--user', '--scope', '-q', 'true'], {
    stdout: 'ignore', stderr: 'ignore',
  });
  if (probe.exitCode === 0) {
    const child = Bun.spawnSync(
      [
        'systemd-run', '--user', '--scope', '-q',
        '-p', 'MemoryMax=3G', '-p', 'MemorySwapMax=512M',
        process.execPath, import.meta.path,
      ],
      {
        env: { ...process.env, [CAP_FLAG]: '1' },
        stdout: 'inherit', stderr: 'inherit',
      },
    );
    process.exit(child.exitCode ?? 1);
  }
  // No user manager reachable — proceed uncapped rather than break indexing.
}

// 2026-07-18: import the FORK's indexer (branch fix/audit-bugs via a read-only
// git worktree), NOT the alpha global install — alpha's runner leaks >8GB on
// EVERY run (even zero-delta) and dies before inserting, so file-based ψ
// indexing was silently broken since the 07-17 migration. The fork indexer was
// memory-stable for months. Worktree adds no commits — the legacy repo stays
// pristine; revert this import when upstream fixes the leak.
const { runOracleReindex } = await import(
  '/home/chillox-intern/.arra-fork-indexer/src/indexer/runner.ts'
);

/**
 * Per-vault tenant stamping (opt-in, OFF by default).
 *
 * The fork indexer above has NO tenant code — it inserts documents without
 * tenant_id, so the column DEFAULT 'default' applies and every vault lands in
 * one shared tenant. Neither ORACLE_TENANT_ID nor runWithTenant() can change
 * that (the engine's env fallback is on the MCP path only, and this indexer
 * never enters it). So the write side is closed HERE: right after a successful
 * append-reindex, label the docs this vault owns.
 *
 * No-op unless ~/.claude/oracle-tenant-map.json maps this vault. Fails OPEN:
 * if stamping breaks, docs stay on 'default' = visible to every reader, never
 * indexed-but-unfindable. Reindex exit code is unaffected.
 */
async function stampTenant(): Promise<void> {
  const vault = process.env.ORACLE_REPO_ROOT;
  if (!vault) return;
  const lib = await import('/home/chillox-intern/.claude/oracle-tenant.ts');
  const tenant = lib.tenantForVault(vault);
  if (!tenant) return;
  const db = lib.openDb(process.env.ORACLE_DATA_DIR || undefined);
  try {
    const rows = lib.planStamp(db, { vaultRoot: vault });
    if (!rows.length) return;
    const dir = process.env.ORACLE_DATA_DIR || `${process.env.HOME}/.oracle`;
    lib.ensureTenant(db, tenant);
    const n = lib.applyStamp(db, rows, tenant, `${dir}/tenant-stamp.jsonl`);
    const { appendFileSync } = await import('fs');
    appendFileSync(`${dir}/tenant-stamp.log`, `${new Date().toISOString()} ${vault} -> ${tenant} (${n})\n`);
  } finally {
    db.close();
  }
}

runOracleReindex({ append: true })
  .then(() => stampTenant().catch((e) => console.error('tenant stamp skipped:', e)))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Append reindex failed:', err);
    process.exit(1);
  });
