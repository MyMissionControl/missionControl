// Pulling skills straight off GitHub — the URL half of the Skills uploader.
//
// Paste any github.com URL that CONTAINS skills (a whole repo, a folder of many
// skills, or one skill's folder) and this resolves every SKILL.md under it and
// downloads each skill's files. One paste of
// https://github.com/anthropics/skills/tree/main/skills/ = 17 skills.
//
// Why the REST tree API and not `git clone`: cloning that repo is ~4 MB of git
// objects plus a `git` binary dependency, and it drags along every skill even when
// the URL points at ONE folder. `GET /git/trees/<ref>?recursive=1` is a single
// request that returns every path in the repo, so the filtering happens here and
// only the chosen skills' blobs are downloaded (raw.githubusercontent.com, which
// does not spend the API rate limit).
//
// NO vscode and NO fs import on purpose: everything here is testable under
// `bun test` with a stubbed fetch, and the caller owns the disk.

export interface GitHubSkillSource {
  owner: string;
  repo: string;
  /** Branch/tag/sha from the URL; undefined → ask the API for the default branch. */
  ref?: string;
  /** Folder to search under, "" = the whole repo. No leading/trailing slash. */
  subPath: string;
}

export interface TreeEntry {
  path: string;
  type: string; // "blob" | "tree" | "commit" (submodule)
  size?: number;
}

export interface FetchedFile {
  /** Path relative to the skill folder, e.g. "SKILL.md", "references/api.md". */
  rel: string;
  data: Buffer;
}

export interface FetchedSkill {
  name: string; // the local folder name under ~/.claude/skills
  dir: string; // the repo path it came from
  files: FetchedFile[];
}

export interface FetchCaps {
  maxFileBytes: number;
  maxSkillBytes: number;
  maxTotalBytes: number;
  maxFilesPerSkill: number;
  maxSkills: number;
}

export const DEFAULT_CAPS: FetchCaps = {
  // Sized off the real anthropics/skills repo (18 skills · 407 files · 10.2 MB,
  // biggest single skill 5.4 MB / 83 files) with room to spare, so a normal skill
  // repo never trips a cap and a runaway one still stops.
  maxFileBytes: 8 * 1024 * 1024,
  maxSkillBytes: 40 * 1024 * 1024,
  maxTotalBytes: 120 * 1024 * 1024,
  maxFilesPerSkill: 800,
  maxSkills: 200,
};

const SAFE_SEG = /^[A-Za-z0-9._-]+$/;
const HTTP_TIMEOUT_MS = 20000;

/** Read a github.com (or raw.githubusercontent.com) URL into owner/repo/ref/subPath.
 *  Accepts what people actually paste:
 *    …/o/r · …/o/r.git · …/o/r/tree/main/skills/ · …/o/r/blob/main/skills/x/SKILL.md
 *    raw.githubusercontent.com/o/r/main/skills/x
 *  A `blob` URL points at a FILE, so its folder is used — pasting a SKILL.md link
 *  installs that skill rather than failing.
 *  ⚠ A branch name containing "/" (feature/x) cannot be told apart from the path
 *  in a GitHub URL without asking the API, so the first segment after tree/blob is
 *  taken as the ref — same assumption GitHub's own UI encodes. Returns null for
 *  anything that is not one of those hosts. */
export function parseGitHubSkillUrl(raw: string): GitHubSkillSource | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const isRaw = host === "raw.githubusercontent.com";
  if (host !== "github.com" && host !== "www.github.com" && !isRaw) return null;
  if (segs.length < 2) return null;

  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/i, "");
  if (!SAFE_SEG.test(owner) || !SAFE_SEG.test(repo)) return null;

  let ref: string | undefined;
  let rest: string[] = [];
  let pointsAtFile = false;
  if (isRaw) {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…> — always a file
    ref = segs[2];
    rest = segs.slice(3);
    pointsAtFile = rest.length > 0;
  } else if (segs[2] === "tree" || segs[2] === "blob") {
    pointsAtFile = segs[2] === "blob";
    ref = segs[3];
    rest = segs.slice(4);
  } else if (segs.length > 2) {
    return null; // /issues, /pull/… — not a file tree
  }
  if (ref !== undefined && !SAFE_SEG.test(ref)) return null;
  // A blob/raw URL names a file; search its FOLDER.
  if (pointsAtFile && rest.length) rest = rest.slice(0, -1);
  for (const s of rest) if (s === "." || s === ".." || !s.trim()) return null;

  return { owner, repo, ref, subPath: rest.join("/") };
}

/** Every folder holding a SKILL.md at or under `subPath`, in repo order.
 *  A folder that is itself inside another skill (a skill bundling a sample skill)
 *  is dropped — it would be installed twice, once standalone and once as a file of
 *  its parent. */
export function skillDirsUnder(entries: TreeEntry[], subPath: string): string[] {
  const prefix = subPath ? subPath.replace(/\/+$/, "") + "/" : "";
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const p = e.path;
    if (!p.endsWith("SKILL.md")) continue;
    if (p !== "SKILL.md" && !p.endsWith("/SKILL.md")) continue; // not "MYSKILL.md"
    if (prefix && !p.startsWith(prefix)) continue;
    const dir = p === "SKILL.md" ? "" : p.slice(0, p.length - "/SKILL.md".length);
    if (subPath && dir !== subPath.replace(/\/+$/, "") && !dir.startsWith(prefix)) continue;
    dirs.push(dir);
  }
  return dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + "/")));
}

/** The blobs that belong to a skill folder, as paths relative to it. Submodules
 *  and anything with an unsafe segment are dropped rather than fetched. */
export function skillFileEntries(entries: TreeEntry[], dir: string): Array<TreeEntry & { rel: string }> {
  const prefix = dir ? dir + "/" : "";
  const out: Array<TreeEntry & { rel: string }> = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    if (prefix && !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (!rel || !isSafeRelPath(rel)) continue;
    out.push({ ...e, rel });
  }
  return out;
}

/** A relative path that is safe to join onto the skills dir: no absolute path, no
 *  "..", no empty/dot segments, nothing exotic. The names are attacker-controlled
 *  (any repo can be pasted), so this is a hard gate, not a tidy-up. */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.length > 400 || rel.startsWith("/") || rel.includes("\\")) return false;
  if (rel.includes("\0")) return false;
  const segs = rel.split("/");
  if (segs.length > 12) return false;
  return segs.every((s) => s !== "" && s !== "." && s !== ".." && SAFE_SEG.test(s));
}

/** Local folder name for a fetched skill: the repo folder it lives in, or the repo
 *  name itself when SKILL.md sits at the repo root. */
export function skillNameFromDir(dir: string, repo: string): string {
  const base = dir ? dir.split("/").pop() || repo : repo;
  return base
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
}

/** Is this SKILL.md a real skill, or just a file that happens to be called that?
 *  Claude loads a skill by its YAML frontmatter, so `---` + a `name:` is the
 *  minimum that makes the folder a skill at all — matches what the panel's own
 *  reader (splitFrontmatter/parseFrontmatter) needs to show a row. Deliberately
 *  lenient beyond that: a missing description is a poor skill, not a fake one. */
export function looksLikeSkill(md: string): boolean {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  return /^name:[ \t]*\S/m.test(m[1]);
}

export type FetchResult =
  | { ok: true; skills: FetchedSkill[]; skipped: string[]; warning?: string }
  | { ok: false; message: string };

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  /** Names already on disk → do not download them at all (checked BEFORE the
   *  blobs are pulled, so a re-paste of a 10 MB repo costs one tree call). */
  skipName?: (name: string) => boolean;
  onProgress?: (p: { done: number; total: number; name: string }) => void;
  caps?: FetchCaps;
  token?: string;
}

/** Resolve a GitHub URL to downloaded skills. Never throws: every failure comes
 *  back as { ok:false, message } worded for the user. */
export async function fetchSkillsFromGitHub(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const caps = opts.caps ?? DEFAULT_CAPS;
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const src = parseGitHubSkillUrl(url);
  if (!src) {
    return {
      ok: false,
      message: "Needs a GitHub link, e.g. https://github.com/<owner>/<repo>/tree/main/skills",
    };
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mission-control-skills",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const get = async (target: string, kind: "json" | "bytes") => {
    const res = await doFetch(target, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return kind === "json" ? await res.json() : Buffer.from(await res.arrayBuffer());
  };

  let ref = src.ref;
  try {
    if (!ref) {
      const repoInfo = (await get(
        `https://api.github.com/repos/${src.owner}/${src.repo}`,
        "json",
      )) as { default_branch?: string };
      ref = repoInfo?.default_branch;
      if (!ref) return { ok: false, message: "Could not find this repo's default branch" };
    }
  } catch (err) {
    return { ok: false, message: `Could not open the repo: ${errText(err)}` };
  }

  let tree: TreeEntry[];
  let truncated = false;
  try {
    const t = (await get(
      `https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      "json",
    )) as { tree?: TreeEntry[]; truncated?: boolean };
    tree = Array.isArray(t?.tree) ? t.tree : [];
    truncated = !!t?.truncated;
  } catch (err) {
    return { ok: false, message: `Could not read the file list: ${errText(err)}` };
  }

  const dirs = skillDirsUnder(tree, src.subPath);
  if (!dirs.length) {
    return {
      ok: false,
      message: src.subPath
        ? `No skill found under '${src.subPath}' in this link`
        : "No skill found in this repo",
    };
  }
  if (dirs.length > caps.maxSkills) {
    return { ok: false, message: `Found ${dirs.length} skills — over the limit of ${caps.maxSkills}` };
  }

  // Names first: what is already installed never gets downloaded.
  const planned = dirs.map((dir) => ({ dir, name: skillNameFromDir(dir, src.repo) }));
  const skipped: string[] = [];
  const todo: typeof planned = [];
  const claimed = new Set<string>();
  for (const p of planned) {
    if (!p.name) continue;
    // Two folders that slugify to the same local name: keep the first, report the rest.
    if (claimed.has(p.name) || opts.skipName?.(p.name)) {
      skipped.push(p.name);
      continue;
    }
    claimed.add(p.name);
    todo.push(p);
  }
  if (!todo.length) return { ok: true, skills: [], skipped, warning: truncatedWarning(truncated) };

  // PHASE 1 — is there a real skill here? Pull ONLY each candidate's SKILL.md
  // (a few KB) and check its frontmatter before touching the bulk files. A folder
  // holding a SKILL.md that is not a skill would otherwise cost a multi-MB
  // download and then install something Claude cannot load.
  const verified: Array<{ dir: string; name: string; md: Buffer }> = [];
  const notSkills: string[] = [];
  for (const { dir, name } of todo) {
    let md: Buffer;
    try {
      md = (await get(rawUrl(src.owner, src.repo, ref, dir ? `${dir}/SKILL.md` : "SKILL.md"), "bytes")) as Buffer;
    } catch (err) {
      return { ok: false, message: `Could not read SKILL.md for '${name}': ${errText(err)}` };
    }
    if (looksLikeSkill(md.toString("utf8"))) verified.push({ dir, name, md });
    else notSkills.push(name);
  }
  if (!verified.length) {
    return {
      ok: false,
      message: `No skill found — ${notSkills.length} SKILL.md file(s) here have no frontmatter (name:), so nothing was downloaded`,
    };
  }

  const skills: FetchedSkill[] = [];
  let totalBytes = 0;
  for (let i = 0; i < verified.length; i++) {
    const { dir, name, md } = verified[i];
    opts.onProgress?.({ done: i, total: verified.length, name });
    const entries = skillFileEntries(tree, dir);
    if (entries.length > caps.maxFilesPerSkill) {
      return { ok: false, message: `Skill '${name}' has ${entries.length} files — over the limit` };
    }
    const declared = entries.reduce((n, e) => n + (e.size ?? 0), 0);
    if (declared > caps.maxSkillBytes) {
      return { ok: false, message: `Skill '${name}' is over the size limit (${mb(declared)} MB)` };
    }
    // SKILL.md is already in hand from the verification pass — never re-download it.
    const files: FetchedFile[] = [{ rel: "SKILL.md", data: md }];
    totalBytes += md.length;
    const rest = entries.filter((e) => e.rel !== "SKILL.md");
    try {
      // A small pool: 400 files one-at-a-time is a long stare at a toast, and a big
      // fan-out is rude to raw.githubusercontent.
      const pool = 6;
      for (let start = 0; start < rest.length; start += pool) {
        const batch = rest.slice(start, start + pool);
        const got = await Promise.all(
          batch.map(async (e) => ({
            rel: e.rel,
            data: (await get(rawUrl(src.owner, src.repo, ref!, e.path), "bytes")) as Buffer,
          })),
        );
        for (const g of got) {
          if (g.data.length > caps.maxFileBytes) {
            throw new Error(`File ${g.rel} is over the size limit`);
          }
          totalBytes += g.data.length;
          if (totalBytes > caps.maxTotalBytes) throw new Error("Total download is over the size limit");
          files.push(g);
        }
      }
    } catch (err) {
      return { ok: false, message: `Could not download '${name}': ${errText(err)}` };
    }
    skills.push({ name, dir, files });
  }
  opts.onProgress?.({ done: verified.length, total: verified.length, name: "" });
  // Folders whose SKILL.md is not a skill are reported, never installed — a silent
  // drop would read as "the uploader missed some".
  const notSkillWarning = notSkills.length
    ? `skipped ${notSkills.length} folder(s) whose SKILL.md is not a skill (${notSkills.slice(0, 5).join(", ")})`
    : undefined;
  const warning = [truncatedWarning(truncated), notSkillWarning].filter(Boolean).join(" · ");
  return { ok: true, skills, skipped, warning: warning || undefined };
}

/** raw.githubusercontent URL with each path segment encoded on its own, so "/"
 *  stays a separator while spaces and "#" in a filename do not break the URL. */
export function rawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const enc = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${enc}`;
}

function truncatedWarning(truncated: boolean): string | undefined {
  return truncated
    ? "this repo is so big GitHub truncated the file list — some skills may be missing; paste a link to the folder instead"
    : undefined;
}

function errText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m === "The operation was aborted due to timeout" ? "connection timed out" : m;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
