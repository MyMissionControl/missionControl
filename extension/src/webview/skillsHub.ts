// ClawHub browser — the third way to get a skill (after .zip and a GitHub link).
//
// Public REST API, no auth, generous limits (read 3000/min, download 1200/min):
//   browse    GET /api/v1/packages?family=skill&sort=downloads&limit&cursor
//   search    GET /api/v1/packages/search?q&family=skill&limit
//   files     GET /api/v1/packages/{name}/versions/{version}   → version.files[]
//   bytes     GET /api/v1/packages/{name}/file?path&version
//
// ⚠ Names are NOT unique on ClawHub. Three different owners publish "pdf", two
// publish "self-improving-agent", and asking for one by name alone answers
// 409 AMBIGUOUS_SKILL_SLUG. Every call therefore carries `?owner=<handle>`, which
// the browse/search rows supply (ownerHandle) — identity here is owner+name, not
// name. (The skills/* namespace is avoided because its browse listing has no
// owner field at all, leaving nothing to disambiguate a download with.)
//
// No vscode / no fs import: testable under `bun test` with a stubbed fetch, and
// the caller (skills.ts) owns the disk via skillsInstall.
// Downloaded skills are installed exactly like the other two sources — same path
// safety, same all-or-nothing temp-dir write, same .mc-uploaded marker.

import { isSafeRelPath, type FetchCaps, type FetchedFile, type FetchedSkill, DEFAULT_CAPS } from "./skillsFetch";

const HUB_API = "https://clawhub.ai/api/v1";
const HTTP_TIMEOUT_MS = 20000;
/** Rows per request. 100 is the registry's ceiling (asking for 200 still answers
 *  100), and one request is deliberately worth MANY screens: the panel pages the
 *  catalogue locally with numbered buttons, so 100 rows = pages 1–9 that switch
 *  instantly with no network at all. */
export const HUB_FETCH_SIZE = 100;

/** One row of the ClawHub catalogue, reduced to what the card shows. */
export interface HubSkill {
  name: string; // package name — unique, used for every API call AND as the local folder
  owner: string;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  installs: number;
  stars: number;
  official: boolean;
}

export interface HubBrowseResult {
  items: HubSkill[];
  nextCursor: string | null;
}

/** A package name is used BOTH in a URL path and as a folder under ~/.claude/skills,
 *  and it comes from a public registry anyone can publish to — so it is whitelisted
 *  the same way local skill folders are. */
export function isSafeHubName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 120 &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    !name.includes("..") &&
    name !== "." &&
    name !== ".."
  );
}

/** An owner handle safe to put in a query param. */
export function isSafeHubOwner(o: unknown): o is string {
  return typeof o === "string" && o.length > 0 && o.length <= 60 && /^[A-Za-z0-9._-]+$/.test(o);
}

/** A version string safe to put in a URL path / query. */
export function isSafeHubVersion(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 40 && /^[A-Za-z0-9._+-]+$/.test(v);
}

/** Registry row → HubSkill, or null when it is unusable (unsafe name, no version,
 *  not a skill). Pure: the shape check lives here so a registry change surfaces as
 *  "no results" rather than a crash or a bad folder name. */
export function normalizeHubItem(raw: unknown): HubSkill | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  const name = p.name;
  const version = p.latestVersion;
  if (!isSafeHubName(name) || !isSafeHubVersion(version)) return null;
  if (typeof p.family === "string" && p.family !== "skill") return null;
  const stats = (p.stats ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    name,
    owner: typeof p.ownerHandle === "string" ? p.ownerHandle : "",
    displayName: typeof p.displayName === "string" && p.displayName.trim() ? p.displayName : name,
    summary: typeof p.summary === "string" ? p.summary : "",
    version,
    downloads: num(stats.downloads),
    installs: num(stats.installs),
    stars: num(stats.stars),
    official: p.isOfficial === true,
  };
}

export type HubResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface HubOptions {
  fetchImpl?: typeof fetch;
  caps?: FetchCaps;
}

async function getJson(url: string, doFetch: typeof fetch): Promise<unknown> {
  const res = await doFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "mission-control-skills" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

/**
 * One page of the catalogue. With `q` this searches; without it, the most-
 * downloaded first. `cursor` continues a browse (search returns one page only —
 * the search endpoint has no cursor).
 */
export async function browseHub(
  opts: { q?: string; cursor?: string | null } & HubOptions = {},
): Promise<HubResult<HubBrowseResult>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const q = (opts.q ?? "").trim();
  const url = q
    ? `${HUB_API}/packages/search?family=skill&limit=${HUB_FETCH_SIZE}&q=${encodeURIComponent(q)}`
    : `${HUB_API}/packages?family=skill&sort=downloads&limit=${HUB_FETCH_SIZE}` +
      (opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : "");
  let body: unknown;
  try {
    body = await getJson(url, doFetch);
  } catch (err) {
    return { ok: false, message: `ClawHub unreachable: ${errText(err)}` };
  }
  const b = (body ?? {}) as Record<string, unknown>;
  // browse → {items}, search → {results:[{score, package}]}
  const rows: unknown[] = Array.isArray(b.items)
    ? (b.items as unknown[])
    : Array.isArray(b.results)
      ? (b.results as unknown[]).map((r) => (r as Record<string, unknown>)?.package)
      : [];
  const items = rows.map(normalizeHubItem).filter((x): x is HubSkill => !!x);
  const nextCursor = !q && typeof b.nextCursor === "string" && b.nextCursor ? b.nextCursor : null;
  return { ok: true, value: { items, nextCursor } };
}

/** Download every file of one package version into a FetchedSkill, ready for
 *  skillsInstall. `owner` is REQUIRED whenever more than one publisher uses the
 *  name (the registry answers 409 without it), so it is always sent. The local
 *  folder is named after the package; a name already taken locally is refused by
 *  skillsInstall rather than overwritten, which is also what the card's
 *  "Installed" state reflects. */
export async function fetchHubSkill(
  name: string,
  version: string,
  owner: string,
  opts: HubOptions = {},
): Promise<HubResult<FetchedSkill>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const caps = opts.caps ?? DEFAULT_CAPS;
  if (!isSafeHubName(name)) return { ok: false, message: "Unsafe skill name" };
  if (!isSafeHubVersion(version)) return { ok: false, message: "Unsafe version" };
  if (owner && !isSafeHubOwner(owner)) return { ok: false, message: "Unsafe owner handle" };
  const ownerQ = owner ? `owner=${encodeURIComponent(owner)}` : "";

  let listing: unknown;
  try {
    listing = await getJson(
      `${HUB_API}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}` +
        (ownerQ ? `?${ownerQ}` : ""),
      doFetch,
    );
  } catch (err) {
    return { ok: false, message: `Could not read the file list: ${errText(err)}` };
  }
  const files = ((listing as Record<string, unknown>)?.version as Record<string, unknown>)?.files;
  if (!Array.isArray(files) || !files.length) {
    return { ok: false, message: "This version has no files" };
  }
  const wanted: Array<{ path: string; size: number }> = [];
  for (const f of files as Array<Record<string, unknown>>) {
    const p = f?.path;
    if (typeof p !== "string" || !isSafeRelPath(p)) continue; // hostile/odd paths never reach disk
    wanted.push({ path: p, size: typeof f.size === "number" ? f.size : 0 });
  }
  if (!wanted.some((f) => f.path === "SKILL.md")) {
    return { ok: false, message: "No SKILL.md in this package — not a skill" };
  }
  if (wanted.length > caps.maxFilesPerSkill) {
    return { ok: false, message: `${wanted.length} files — over the limit` };
  }
  const declared = wanted.reduce((n, f) => n + f.size, 0);
  if (declared > caps.maxSkillBytes) {
    return { ok: false, message: `Too big (${(declared / 1024 / 1024).toFixed(1)} MB)` };
  }

  const out: FetchedFile[] = [];
  let total = 0;
  try {
    const pool = 6; // polite to the registry, still ~6x faster than serial
    for (let i = 0; i < wanted.length; i += pool) {
      const batch = wanted.slice(i, i + pool);
      const got = await Promise.all(
        batch.map(async (f) => {
          const url =
            `${HUB_API}/packages/${encodeURIComponent(name)}/file` +
            `?path=${encodeURIComponent(f.path)}&version=${encodeURIComponent(version)}` +
            (ownerQ ? `&${ownerQ}` : "");
          const res = await doFetch(url, {
            headers: { "User-Agent": "mission-control-skills" },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`${f.path}: ${res.status} ${res.statusText}`);
          return { rel: f.path, data: Buffer.from(await res.arrayBuffer()) };
        }),
      );
      for (const g of got) {
        if (g.data.length > caps.maxFileBytes) throw new Error(`${g.rel} is over the size limit`);
        total += g.data.length;
        if (total > caps.maxTotalBytes) throw new Error("Total download is over the size limit");
        out.push(g);
      }
    }
  } catch (err) {
    return { ok: false, message: `Download failed: ${errText(err)}` };
  }
  return { ok: true, value: { name, dir: `clawhub:${owner ? owner + "/" : ""}${name}@${version}`, files: out } };
}

function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m === "The operation was aborted due to timeout" ? "connection timed out" : m;
}
