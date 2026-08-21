import * as path from "node:path";

// CCS (Claude Code Switch) is NOT adopted by MC — see docs/ccs-evaluation-2026-08-20.md.
// This only resolves how the "เปิด UI ของ CCS" button opens CCS's own dashboard, using the
// doc §4 safe recipe: a contained install (pinned + --ignore-scripts + a private vendor
// prefix, never global / never on PATH) that we run CAGED with HOME=<cageHome> so CCS's
// os.homedir() physically cannot reach the real ~/.claude (verified: a caged run writes only
// under the cage). NEVER run `ccs sync` (symlinks its skills/commands into ~/.claude) and
// never pass OAuth / --dangerously-skip-permissions flags.

/** Paths of the contained CCS install + its cage. Pure (home injected). */
export function ccsPaths(home: string): { vendorRoot: string; entry: string; cageHome: string } {
  const vendorRoot = path.join(home, ".mc", "vendor", "ccs");
  return {
    vendorRoot,
    entry: path.join(vendorRoot, "node_modules", "@kaitranntt", "ccs", "dist", "ccs.js"),
    cageHome: path.join(home, ".mc", "ccs-home"),
  };
}

/** The exact command the not-installed dialog offers (contained, never global). */
export const CCS_INSTALL_CMD =
  "npm i @kaitranntt/ccs@8.9.0 --ignore-scripts --prefix ~/.mc/vendor/ccs";

export type CcsLaunch =
  | { kind: "run"; entry: string; cageHome: string }
  | { kind: "missing"; installCmd: string };

/** Decide how to open the CCS dashboard. Prefers the contained caged install; otherwise
 *  returns the copy-paste install command. `exists` is injected (fs.existsSync) so this
 *  stays pure + unit-testable. */
export function resolveCcsLaunch(home: string, exists: (p: string) => boolean): CcsLaunch {
  const { entry, cageHome } = ccsPaths(home);
  return exists(entry)
    ? { kind: "run", entry, cageHome }
    : { kind: "missing", installCmd: CCS_INSTALL_CMD };
}

/** The shell line the button runs in a VS Code terminal. HOME=<cage> is inlined so ONLY the
 *  ccs process is caged — the shell keeps the real HOME (→ real PATH so `node` resolves).
 *  Opens the dashboard only; never `sync`. */
export function ccsLaunchCommand(entry: string, cageHome: string): string {
  return `HOME=${shq(cageHome)} node ${shq(entry)} config`;
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
