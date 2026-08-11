#!/usr/bin/env bun
/**
 * Print the READ tenant for a vault dir, or nothing.
 *
 * Used by ~/.claude/bin/arra-mcp-capped.sh to set ORACLE_TENANT_ID per oracle:
 * the MCP server starts with cwd = that oracle's repo, so the tenant follows
 * whichever vault you are in — one global MCP entry, per-vault scoping.
 *
 * Prints only when the vault is in BOTH `vaults` and `isolateReads`
 * (~/.claude/oracle-tenant-map.json). Any other case prints nothing, which
 * leaves ORACLE_TENANT_ID unset = the reader sees every tenant, as today.
 */
import { readTenantForVault } from './oracle-tenant.ts';

try {
  const dir = process.argv[2] || process.cwd();
  process.stdout.write(readTenantForVault(dir) ?? '');
} catch {
  // Never break MCP startup over a config problem — unset means "see all".
}
