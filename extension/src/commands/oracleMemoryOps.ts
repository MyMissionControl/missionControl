import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Oracle memory mode (shared vs isolated) for the Settings page.
//
// The mechanism lives OUTSIDE this extension, in ~/.claude:
//   oracle-tenant-map.json     the two switches (vaults = label, isolateReads = filter)
//   oracle-tenant-migrate.ts   the only writer — --json/--label/--apply/--isolate/--unisolate
//   oracle-reindex-append.ts   stamps tenant_id on each vault's docs after a reindex
//   hooks/oracle-isolation-guard.py  blocks reading another vault's ψ while isolated
// arra-oracle-v3 itself is legacy/read-only, which is why none of this is a
// patch to the engine.
//
// This module only shells out to that CLI and parses its JSON, so there is ONE
// implementation of the rules. Everything here is pure/injectable (Runner) so
// bun test can drive it without vscode or a real DB — see oracleMemoryOps.test.ts.

export type OracleMemoryVault = {
  vault: string;
  path: string;
  scope: string;
  /** null = not labelled yet (its docs still sit in the shared 'default' tenant). */
  tenant: string | null;
  isolated: boolean;
  /** Docs this vault owns that are still on 'default' — what --apply would move. */
  pending: number;
  /** Docs already carrying this vault's tenant. */
  labelled: number;
};

export type OracleMemoryStatus = {
  mapFile: string;
  dbFile: string;
  documents: number;
  onDefault: number;
  vaults: OracleMemoryVault[];
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[]) => RunResult;

/** Resolved per call (not a module const) so tests can point MC_TENANT_CLI at a
 *  throwaway path after import — ESM hoists imports above any env setup. */
export function tenantCli(): string {
  return (
    process.env.MC_TENANT_CLI ||
    path.join(os.homedir(), ".claude", "oracle-tenant-migrate.ts")
  );
}

/** bun is how the CLI runs (bun:sqlite). Env override keeps tests hermetic. */
export function bunBin(): string {
  if (process.env.MC_BUN) return process.env.MC_BUN;
  const local = path.join(os.homedir(), ".bun", "bin", "bun");
  return fs.existsSync(local) ? local : "bun";
}

/** True when the ~/.claude side is installed — the section hides itself if not. */
export function isInstalled(): boolean {
  return fs.existsSync(tenantCli());
}

export function statusArgs(): string[] {
  return [tenantCli(), "--json"];
}

/** One switch per oracle in the UI; each maps to explicit CLI verbs.
 *  isolated → label (idempotent) + backfill old docs + turn the read filter on.
 *  shared   → just drop the read filter. Labels are inert, so nothing is undone. */
export function modeArgSteps(vault: string, isolated: boolean): string[][] {
  const cli = tenantCli();
  return isolated
    ? [
        [cli, "--label", vault],
        [cli, "--apply"],
        [cli, "--isolate", vault],
      ]
    : [[cli, "--unisolate", vault]];
}

export function parseStatus(stdout: string): OracleMemoryStatus {
  const raw = JSON.parse(stdout) as Partial<OracleMemoryStatus>;
  if (!raw || !Array.isArray(raw.vaults)) throw new Error("bad status payload");
  return {
    mapFile: String(raw.mapFile ?? ""),
    dbFile: String(raw.dbFile ?? ""),
    documents: Number(raw.documents ?? 0),
    onDefault: Number(raw.onDefault ?? 0),
    vaults: raw.vaults.map((v) => ({
      vault: String(v.vault),
      path: String(v.path ?? ""),
      scope: String(v.scope ?? ""),
      tenant: v.tenant == null ? null : String(v.tenant),
      isolated: v.isolated === true,
      pending: Number(v.pending ?? 0),
      labelled: Number(v.labelled ?? 0),
    })),
  };
}

/** Default runner: bun <args>, never throws, 20s cap. */
export const defaultRunner: Runner = (args) => {
  const r = cp.spawnSync(bunBin(), args, {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: typeof r.status === "number" ? r.status : 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
  };
};

/** null = the CLI is missing or failed; the caller renders "unavailable" rather
 *  than an empty (and misleading) "everything is shared" list. */
export function readStatus(run: Runner = defaultRunner): OracleMemoryStatus | null {
  if (!isInstalled()) return null;
  const r = run(statusArgs());
  if (r.code !== 0) return null;
  try {
    return parseStatus(r.stdout);
  } catch {
    return null;
  }
}

/** Runs the steps in order, stopping at the first failure. Returns the failing
 *  step's stderr so the UI can surface the CLI's own refusal text verbatim. */
export function setMode(
  vault: string,
  isolated: boolean,
  run: Runner = defaultRunner,
): { ok: boolean; error?: string; log: string[] } {
  const log: string[] = [];
  for (const args of modeArgSteps(vault, isolated)) {
    const r = run(args);
    log.push(`${args.slice(1).join(" ")} -> exit ${r.code}`);
    if (r.code !== 0) {
      return { ok: false, error: (r.stderr || r.stdout || "").trim() || `exit ${r.code}`, log };
    }
  }
  return { ok: true, log };
}

/** Wording for the confirm prompt shown before isolating (it writes the DB). */
export function confirmIsolateMessage(v: OracleMemoryVault): string {
  const tenant = v.tenant ?? v.vault.replace(/-oracle$/, "");
  return [
    `Isolate ${v.vault} (tenant '${tenant}')?`,
    v.pending > 0
      ? `${v.pending} existing docs get relabelled (a backup + an undo journal are written first).`
      : "No existing docs need relabelling.",
    `After this it can only search its OWN memory — not other oracles', and not the shared projects/ψ vault.`,
    "Reverting is one click (no data change).",
  ].join("\n\n");
}
