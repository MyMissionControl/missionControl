import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyMcService } from "./localhostKill";

export type Listener = {
  port: number;
  pid: number;
  pgid: number;
  comm: string;
  role: string;
};
export type ProjectGroup = { project: string; entries: Listener[] };
export type RawListener = {
  port: number;
  pid: number;
  cwd: string | null;
  pgid: number;
  comm: string;
};

/** Parse `ss -ltnpH` output → [{port, pid}]. The local address is the first
 *  token ending in `:<digits>` (the peer column ends in `:*`). Lines with no
 *  `pid=` (root-owned sockets we cannot inspect) are skipped. */
export function parseSsListeners(ssOutput: string): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = [];
  const seen = new Set<string>();
  for (const raw of ssOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const pidM = /pid=(\d+)/.exec(line);
    if (!pidM) continue;
    const local = line.split(/\s+/).find((t) => /:\d+$/.test(t));
    if (!local) continue;
    const portM = /:(\d+)$/.exec(local);
    if (!portM) continue;
    const port = Number(portM[1]);
    const pid = Number(pidM[1]);
    const key = `${port}/${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid });
  }
  return out;
}

/** Parse `ps -o pid=,pgid=,comm=` output → Map<pid, {pgid, comm}>.
 *  comm may contain spaces, so everything after the second number is the comm. */
export function parsePsOutput(out: string): Map<number, { pgid: number; comm: string }> {
  const m = new Map<number, { pgid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!mm) continue;
    m.set(Number(mm[1]), { pgid: Number(mm[2]), comm: mm[3].trim() });
  }
  return m;
}

/** Project name if `cwd` is strictly inside `<projectsRoot>/<name>/...`, else null. */
export function projectFromCwd(cwd: string | null, projectsRoot: string): string | null {
  if (!cwd) return null;
  const prefix = projectsRoot.replace(/\/+$/, "") + "/";
  if (!cwd.startsWith(prefix)) return null;
  const name = cwd.slice(prefix.length).split("/")[0];
  return name || null;
}

/** Light label from comm/port. Best-effort only. */
export function guessRole(comm: string, port: number): string {
  const c = comm.toLowerCase();
  if (/uvicorn|gunicorn|python|flask|django/.test(c) || port === 8000) return "api";
  if (/next|vite|node|astro|webpack|remix/.test(c)) return "web";
  return "srv";
}

/** Group raw listeners by the project their cwd lives in. Drops listeners not
 *  under any project. Groups sorted by name, entries sorted by port. */
export function groupListeners(raws: RawListener[], projectsRoot: string): ProjectGroup[] {
  const byProject = new Map<string, Listener[]>();
  for (const r of raws) {
    const project = projectFromCwd(r.cwd, projectsRoot);
    if (!project) continue;
    const list = byProject.get(project) ?? [];
    list.push({ port: r.port, pid: r.pid, pgid: r.pgid, comm: r.comm, role: guessRole(r.comm, r.port) });
    byProject.set(project, list);
  }
  const groups: ProjectGroup[] = [];
  for (const [project, entries] of byProject) {
    entries.sort((a, b) => a.port - b.port);
    groups.push({ project, entries });
  }
  groups.sort((a, b) => a.project.localeCompare(b.project));
  return groups;
}

// ── Live collectors ────────────────────────────────────────────────────────

/** `<owner>/projects` derived portably from ~/.maw/oracles.json (the same
 *  `.../github.com/<owner>` derivation as startOrchestrator.resolveOwnerRoot,
 *  inlined here so this module stays free of the `vscode` import — that keeps
 *  the scan unit-testable under `bun test`). null if it can't be resolved. */
export function getProjectsRoot(): string | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".maw", "oracles.json"), "utf8");
    const data = JSON.parse(raw) as { oracles?: { local_path?: string }[] };
    for (const o of data?.oracles ?? []) {
      const p = o?.local_path;
      if (typeof p !== "string" || !p) continue;
      const m = p.replace(/\/+$/, "").match(/^(.*\/github\.com\/[^/]+)\/[^/]+$/);
      if (m) return path.join(m[1], "projects");
    }
  } catch {
    /* file missing / malformed → unresolved */
  }
  return null;
}

function ssRaw(): string {
  try {
    return cp.execSync("ss -ltnpH", { encoding: "utf8", timeout: 4000 });
  } catch {
    try {
      return cp.execSync("ss -ltnp", { encoding: "utf8", timeout: 4000 });
    } catch {
      return "";
    }
  }
}

function psRaw(pids: number[]): string {
  if (!pids.length) return "";
  try {
    return cp.execSync(`ps -o pid=,pgid=,comm= -p ${pids.join(",")}`, {
      encoding: "utf8",
      timeout: 4000,
    });
  } catch {
    return "";
  }
}

/** Enumerate listeners and enrich each with cwd/pgid/comm. Two subprocesses
 *  total (one ss, one ps). Unreadable pids (root-owned) get cwd=null and are
 *  dropped by groupListeners. */
export function collectRaw(): RawListener[] {
  const listeners = parseSsListeners(ssRaw());
  const info = parsePsOutput(psRaw(listeners.map((l) => l.pid)));
  const raws: RawListener[] = [];
  for (const { port, pid } of listeners) {
    let cwd: string | null = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    const ps = info.get(pid);
    raws.push({ port, pid, cwd, pgid: ps?.pgid ?? 0, comm: ps?.comm ?? "" });
  }
  return raws;
}

/** Full scan: listeners grouped by project. Empty array if the projects root or
 *  ss is unavailable — callers render "unavailable" and move on. */
export function scanLocalhosts(): ProjectGroup[] {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return [];
  return groupListeners(collectRaw(), projectsRoot);
}

// ── Enriched scan (for the Localhosts panel: kind badge, command, RAM, uptime) ─

/** Data-color category the strip is painted with. null = couldn't classify;
 *  the panel then omits the badge rather than inventing a generic one. */
export type Kind = "web" | "api" | "db" | "docs";

export type PortInfo = {
  port: number;
  pid: number;
  pgid: number;
  kind: Kind | null;
  cmd: string; // owning command, prettified (e.g. "uvicorn app:api")
  memMB: number; // resident set size at scan time, in MB
  uptime: string; // human elapsed time (e.g. "3h 12m")
};
export type EnrichedGroup = { project: string; path: string; ports: PortInfo[]; mc?: boolean };

/** Classify a listener into a data-color kind from its command + args + port.
 *  Order matters (db/docs before the broad web/api); a bare `node` with a vite
 *  arg lands as web because the web test also reads `args`. Returns null when
 *  nothing matches so the caller can drop the badge. */
export function classifyKind(comm: string, args: string, port: number): Kind | null {
  const s = ((comm || "") + " " + (args || "")).toLowerCase();
  if (/postgres|mysqld|mariadb|\bredis|\bmongod?\b|cockroach/.test(s)) return "db";
  if (/storybook|docusaurus|vitepress|mkdocs|mintlify/.test(s)) return "docs";
  if (/\bvite\b|next-server|\bnext\b|nuxt|astro|webpack|remix|react-scripts|@angular|ng serve/.test(s)) return "web";
  if (/uvicorn|gunicorn|hypercorn|fastify|express|flask|django|\brails\b|\bpuma\b|\bnode\b|\bbun\b|\bdeno\b/.test(s)) return "api";
  if ([5432, 5433, 3306, 6379, 27017].includes(port)) return "db";
  if ([3000, 5173, 4321, 8080].includes(port)) return "web";
  if ([8000, 8001, 4000, 5000, 3001].includes(port)) return "api";
  return null;
}

/** Prettify a full command line for display: replace each path-like token with
 *  its basename so "/home/u/.local/bin/uvicorn app:api" → "uvicorn app:api" and
 *  "/usr/bin/node …/.bin/vite --host" → "node vite --host". Falls back to comm
 *  when args are empty. */
export function prettyCmd(args: string, comm: string): string {
  const a = (args || "").trim();
  if (!a) return (comm || "").trim();
  const toks = a.split(/\s+/).filter(Boolean).map((t) => (t.includes("/") ? t.split("/").pop() || t : t));
  const s = toks.join(" ").trim();
  return s || (comm || "").trim();
}

/** Human-readable elapsed time from whole seconds (ps etimes). */
export function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "";
  let s = Math.floor(secs);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** Parse `ps -o pid=,rss=,etimes=,args=` → Map<pid,{rssKB,etimes,args}>.
 *  args is the remainder of the line (may contain spaces). */
export function parsePsFull(out: string): Map<number, { rssKB: number; etimes: number; args: string }> {
  const m = new Map<number, { rssKB: number; etimes: number; args: string }>();
  for (const line of out.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!mm) continue;
    m.set(Number(mm[1]), { rssKB: Number(mm[2]), etimes: Number(mm[3]), args: mm[4].trim() });
  }
  return m;
}

function psFullRaw(pids: number[]): string {
  const uniq = [...new Set(pids)];
  if (!uniq.length) return "";
  try {
    return cp.execSync(`ps -o pid=,rss=,etimes=,args= -p ${uniq.join(",")}`, {
      encoding: "utf8",
      timeout: 4000,
    });
  } catch {
    return "";
  }
}

/** Enriched scan for the panel: listeners grouped by project, each port carrying
 *  its kind, prettified command, current RAM (MB) and uptime. Empty array when
 *  the projects root or ss is unavailable. */
export function scanLocalhostsEnriched(): EnrichedGroup[] {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return [];
  const raws = collectRaw();
  const info = parsePsFull(psFullRaw(raws.map((r) => r.pid)));
  const home = os.homedir();
  const byProject = new Map<string, PortInfo[]>();
  for (const r of raws) {
    const project = projectFromCwd(r.cwd, projectsRoot);
    if (!project) continue;
    const f = info.get(r.pid);
    const args = f?.args ?? "";
    const list = byProject.get(project) ?? [];
    list.push({
      port: r.port,
      pid: r.pid,
      pgid: r.pgid,
      kind: classifyKind(r.comm, args, r.port),
      cmd: prettyCmd(args, r.comm),
      memMB: f ? Math.round(f.rssKB / 1024) : 0,
      uptime: f ? formatUptime(f.etimes) : "",
    });
    byProject.set(project, list);
  }
  const groups: EnrichedGroup[] = [];
  for (const [project, ports] of byProject) {
    ports.sort((a, b) => a.port - b.port);
    const full = projectsRoot.replace(/\/+$/, "") + "/" + project;
    const path = full.startsWith(home) ? "~" + full.slice(home.length) : full;
    groups.push({ project, path, ports });
  }
  groups.sort((a, b) => a.project.localeCompare(b.project));
  return groups;
}

/** MC-managed services (e.g. the CCS dashboard) as a synthetic group, so the panel
 *  can surface + stop them even though they run OUTSIDE any project (their cwd is
 *  home/workspace, so scanLocalhostsEnriched drops them). Matched by args signature
 *  in classifyMcService — only our own vendored processes. Empty when none run. */
export function scanMcServices(): EnrichedGroup[] {
  const raws = collectRaw();
  const info = parsePsFull(psFullRaw(raws.map((r) => r.pid)));
  const ports: PortInfo[] = [];
  for (const r of raws) {
    const f = info.get(r.pid);
    const svc = classifyMcService(f?.args ?? "");
    if (!svc) continue;
    ports.push({
      port: r.port,
      pid: r.pid,
      pgid: r.pgid,
      kind: "web", // dashboards are web UIs
      cmd: svc.label,
      memMB: f ? Math.round(f.rssKB / 1024) : 0,
      uptime: f ? formatUptime(f.etimes) : "",
    });
  }
  if (!ports.length) return [];
  ports.sort((a, b) => a.port - b.port);
  return [{ project: "MC services", path: "caged · not a project", ports, mc: true }];
}
