import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { fetchSkillsFromGitHub } from "./skillsFetch";
import { browseHub, fetchHubSkill, isSafeHubName, isSafeHubOwner, isSafeHubVersion } from "./skillsHub";
import { installFetchedSkills } from "./skillsInstall";

// Frontend-only build: skills are read straight off disk from
// ~/.claude/skills/<name>/SKILL.md — no backend involved. Each skill is a
// directory containing a SKILL.md whose YAML frontmatter carries `name` and
// `description`. The panel groups them into three buckets — "system" (every
// non-uploaded, non-generated skill), "generated" (auto-created,
// installer:auto-skill) and "uploaded" (dropped in via the uploader). Uploaded
// + generated skills carry an on/off toggle; system skills are always active.
// Overridable for tests (MC_SKILLS_DIR); defaults to the real global skills dir.
// Read per-call (not a module const) so a test can point it at a temp dir even
// after the module is already imported/cached.
function skillsDir(): string {
  return process.env.MC_SKILLS_DIR || path.join(os.homedir(), ".claude", "skills");
}
// Skills added through the panel's uploader get this empty marker file so
// listSkills can force them into the synthetic "uploaded" category regardless
// of any [tag] their own SKILL.md carries.
const UPLOAD_MARKER = ".mc-uploaded";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type SkillSummary = {
  name: string;
  description: string;
  /** The skill's own [tag] (core/standard/lab/zombie…), or null when untagged.
   *  Shown verbatim on the hover chip. Uploaded skills report "uploaded". */
  category: string | null;
  /** Accordion bucket — the panel groups by THIS, not `category`. Uploaded
   *  skills are "uploaded"; auto-created skills (frontmatter installer:auto-skill)
   *  are "generated"; every other skill collapses into "system". */
  group: "system" | "uploaded" | "generated";
  path: string;
  /** True when dropped in via the uploader (has UPLOAD_MARKER). Uploaded AND
   *  generated skills get an on/off toggle; system skills are always active. */
  uploaded: boolean;
  /** False when the skill is disabled (SKILL.md renamed to SKILL.md.disabled). */
  enabled: boolean;
};

// Singleton — only one Skills panel makes sense at a time. Cleared on
// onDidDispose so the next openSkillsPanel call creates a fresh one.
let _panel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the Skills viewer panel. `projectId` is accepted for
 *  call-site parity with the other webviews but unused — skills are local. */
export function openSkillsPanel(
  _projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.skills",
    "Skills",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  // Cached so open_skill can resolve a name → on-disk path without rescanning.
  let skills = listSkills();

  panel.webview.html = renderShell();
  panel.webview.postMessage({ type: "render_list", skills });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "ready") {
      // Client finished wiring — (re)send the list so the first paint never
      // races the message listener's registration.
      panel.webview.postMessage({ type: "render_list", skills });
      return;
    }
    if (msg?.type === "close") {
      panel.dispose();
      return;
    }
    if (msg?.type === "reload") {
      skills = listSkills();
      panel.webview.postMessage({ type: "render_list", skills });
      return;
    }
    if (msg?.type === "upload_skill" && typeof msg.dataB64 === "string") {
      void handleUpload(String(msg.filename ?? ""), msg.dataB64).then((res) => {
        if (res.ok) {
          skills = listSkills();
          panel.webview.postMessage({ type: "render_list", skills });
          panel.webview.postMessage({ type: "upload_ok", name: res.name });
        } else {
          panel.webview.postMessage({ type: "upload_error", message: res.message });
        }
      });
      return;
    }
    if (msg?.type === "upload_url" && typeof msg.url === "string") {
      void handleUrlUpload(msg.url, (m) => panel.webview.postMessage(m)).then((res) => {
        skills = listSkills(); // partial success still installed something
        panel.webview.postMessage({ type: "render_list", skills });
        panel.webview.postMessage(
          res.ok
            ? { type: "upload_url_ok", installed: res.installed, skipped: res.skipped, warning: res.warning }
            : { type: "upload_error", message: res.message },
        );
      });
      return;
    }
    if (msg?.type === "hub_browse") {
      const q = typeof msg.q === "string" ? msg.q : "";
      const cursor = typeof msg.cursor === "string" ? msg.cursor : null;
      void browseHub({ q, cursor }).then((res) => {
        panel.webview.postMessage(
          res.ok
            ? {
                type: "hub_list",
                append: !!cursor,
                // "installed" is decided HERE, by the same folder check the installer
                // refuses on — so the button can never offer a download that would
                // then be rejected.
                items: res.value.items.map((s) => ({
                  ...s,
                  installed: fs.existsSync(path.join(skillsDir(), s.name)),
                })),
                nextCursor: res.value.nextCursor,
              }
            : { type: "hub_error", message: res.message },
        );
      });
      return;
    }
    if (msg?.type === "hub_install") {
      const name = msg.name;
      const version = msg.version;
      // owner disambiguates: several publishers use the same package name and the
      // registry answers 409 without it.
      const owner = typeof msg.owner === "string" ? msg.owner : "";
      if (!isSafeHubName(name) || !isSafeHubVersion(version) || (owner && !isSafeHubOwner(owner))) {
        panel.webview.postMessage({ type: "hub_error", message: "Unsafe skill name, version or owner" });
        return;
      }
      if (fs.existsSync(path.join(skillsDir(), name))) {
        // Someone installed it between the list and the click.
        panel.webview.postMessage({ type: "hub_installed", name, already: true });
        return;
      }
      void fetchHubSkill(name, version, owner).then((res) => {
        if (!res.ok) {
          panel.webview.postMessage({ type: "hub_error", name, message: res.message });
          return;
        }
        const rep = installFetchedSkills(skillsDir(), [res.value], UPLOAD_MARKER);
        if (!rep.installed.length) {
          panel.webview.postMessage({
            type: "hub_error",
            name,
            message: rep.failed[0]?.message ?? "Could not write the skill",
          });
          return;
        }
        skills = listSkills();
        panel.webview.postMessage({ type: "render_list", skills });
        panel.webview.postMessage({ type: "hub_installed", name });
      });
      return;
    }
    if (msg?.type === "toggle_skill" && typeof msg.name === "string") {
      const res = toggleSkill(msg.name, skills);
      if (res.ok) {
        skills = listSkills();
        panel.webview.postMessage({ type: "render_list", skills });
      } else {
        panel.webview.postMessage({ type: "upload_error", message: res.message });
      }
      return;
    }
    if (msg?.type === "open_skill" && typeof msg.name === "string") {
      const skill = skills.find((s) => s.name === msg.name);
      if (!skill) return;
      // Open the full SKILL.md beside the panel (preview tab is reused, so
      // repeated clicks don't stack editors).
      void vscode.window.showTextDocument(vscode.Uri.file(skill.path), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      });
      return;
    }
  });

  return panel;
}

// ── Disk reading ───────────────────────────────────────────────────────────

/** Scan each ~/.claude/skills/<dir>/SKILL.md and return one summary per dir.
 *  Exported so the dashboard's Skills tile can show a real on-disk count. */
export function listSkills(): SkillSummary[] {
  const SKILLS_DIR = skillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, e.name);
    // A skill is normally <dir>/SKILL.md. Disabling an uploaded skill renames
    // that to SKILL.md.disabled (so Claude Code stops discovering it) while we
    // still list it here as an "off" card the user can flip back on.
    let skillPath = path.join(dir, "SKILL.md");
    let enabled = true;
    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, "utf8");
    } catch {
      const disabledPath = skillPath + ".disabled";
      try {
        raw = fs.readFileSync(disabledPath, "utf8");
        skillPath = disabledPath;
        enabled = false;
      } catch {
        continue; // neither SKILL.md nor SKILL.md.disabled — not a skill
      }
    }
    const meta = parseFrontmatter(splitFrontmatter(raw).fm);
    const rawDesc = meta.description ?? "";
    const { category, text } = splitCategory(rawDesc);
    // A marker file (dropped by the uploader) wins over the parsed tag — these
    // are surfaced under the "uploaded" category no matter what they self-tag.
    const uploaded = fs.existsSync(path.join(dir, UPLOAD_MARKER));
    // Auto-created skills stamp installer:auto-skill — they get their own
    // "generated" bucket instead of collapsing into "system".
    const generated = !uploaded && meta.installer === "auto-skill";
    out.push({
      name: meta.name || e.name,
      description: text || rawDesc,
      // `category` keeps the real [tag] for the hover chip; `group` is the
      // accordion key. uploaded wins the marker; auto-created → generated;
      // everything else → system.
      category: uploaded ? "uploaded" : generated ? meta.category || "generated" : category,
      group: uploaded ? "uploaded" : generated ? "generated" : "system",
      path: skillPath,
      uploaded,
      enabled,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Split a markdown file into its leading `---`-fenced frontmatter and body. */
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: raw };
}

/** Minimal YAML reader for the four keys we need — single-line values, plus block
 *  scalars (`description: |-` followed by indented lines), which real skills use
 *  for long multi-paragraph descriptions (anthropics/skills claude-api does). The
 *  single-line reader alone put the literal "|-" on the card. */
function parseFrontmatter(fm: string): {
  name?: string;
  description?: string;
  installer?: string;
  category?: string;
} {
  const out: { name?: string; description?: string; installer?: string; category?: string } = {};
  const lines = fm.split(/\r?\n/);
  for (const key of ["name", "description", "installer", "category"] as const) {
    const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
    if (idx < 0) continue;
    const inline = lines[idx].slice(key.length + 1).trim();
    if (/^[|>][-+\d]*$/.test(inline)) {
      // block scalar: take the following indented lines, joined into one string
      const block: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].trim() && !/^\s/.test(lines[i])) break; // back to column 0 = next key
        block.push(lines[i].replace(/^\s+/, ""));
      }
      out[key] = block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      out[key] = unquoteYaml(inline);
    }
  }
  return out;
}

function unquoteYaml(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** Pull the leading "[standard]" tag off a description and strip the
 *  "vX.Y.Z G-SKLL | " version preamble these skills embed, leaving the
 *  human-readable description. Non-tagged descriptions pass through. */
function splitCategory(desc: string): { category: string | null; text: string } {
  let category: string | null = null;
  let text = desc;
  const tag = text.match(/^\s*\[([^\]]+)\]\s*/);
  if (tag) {
    category = tag[1];
    text = text.slice(tag[0].length);
  }
  const bar = text.match(/G-SKLL\s*\|\s*([\s\S]*)$/);
  if (bar) text = bar[1];
  text = text.trim();
  // Some descriptions wrap their prose in literal quotes after the "|" — drop a
  // balanced surrounding pair so the preview reads cleanly.
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return { category, text };
}

// ── Uploading a skill (.zip) ─────────────────────────────────────────────────

/** Handle a dropped/selected .zip: unzip to a temp dir, locate the folder
 *  holding SKILL.md, and copy it into ~/.claude/skills/<name>/ with an
 *  UPLOAD_MARKER so it lands under "uploaded". Every failure returns a typed
 *  message the webview surfaces; nothing throws. */
async function handleUpload(
  filename: string,
  dataB64: string,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const SKILLS_DIR = skillsDir();
  if (!filename.toLowerCase().endsWith(".zip")) {
    return { ok: false, message: "Only .zip files are supported." };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch {
    return { ok: false, message: "Could not read the uploaded file." };
  }
  if (buf.length === 0) return { ok: false, message: "The file is empty." };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "File too large (max 25 MB)." };
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skill-"));
  const zipPath = path.join(tmpRoot, "upload.zip");
  const outDir = path.join(tmpRoot, "out");
  try {
    fs.writeFileSync(zipPath, buf);
    fs.mkdirSync(outDir);
    const un = cp.spawnSync("unzip", ["-oq", zipPath, "-d", outDir], {
      timeout: 20000,
    });
    if (un.error || un.status !== 0) {
      return {
        ok: false,
        message: "Could not unzip — the file may be corrupt or not a real .zip.",
      };
    }
    const skillDir = findSkillDir(outDir, 0);
    if (!skillDir) {
      return { ok: false, message: "No SKILL.md found inside the zip." };
    }
    const name = deriveSkillName(skillDir, outDir, filename);
    if (!isSafeName(name)) {
      return {
        ok: false,
        message: "Could not derive a safe skill name from the zip.",
      };
    }
    const dest = path.join(SKILLS_DIR, name);
    if (fs.existsSync(dest)) {
      return {
        ok: false,
        message: `A skill named "${name}" already exists — remove it first.`,
      };
    }
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.cpSync(skillDir, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, UPLOAD_MARKER), "");
    return { ok: true, name };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort — temp dir cleanup */
    }
  }
}

// ── Uploading skills from a GitHub URL ───────────────────────────────────────

/** Paste a github.com URL → install EVERY skill under it, each tagged uploaded.
 *  A folder-of-skills link (…/tree/main/skills) installs the whole set in one go;
 *  a single skill's folder installs just that one.
 *
 *  Already-installed names are skipped, not overwritten — the same rule the .zip
 *  uploader has always had, and it keeps a re-paste from silently reverting a skill
 *  the user edited locally. To take an update, delete the skill first.
 *
 *  Each skill is written to a temp dir and moved in only once ALL its files are on
 *  disk, so a mid-download failure can never leave a half-skill that Claude would
 *  load and act on. Never throws. */
async function handleUrlUpload(
  url: string,
  post: (m: unknown) => void,
): Promise<
  | { ok: true; installed: string[]; skipped: string[]; warning?: string }
  | { ok: false; message: string }
> {
  const SKILLS_DIR = skillsDir();
  const res = await fetchSkillsFromGitHub(url, {
    skipName: (name) => fs.existsSync(path.join(SKILLS_DIR, name)),
    onProgress: (p) =>
      post({ type: "upload_progress", done: p.done, total: p.total, name: p.name }),
  });
  if (!res.ok) return res;

  const { installed, failed } = installFetchedSkills(SKILLS_DIR, res.skills, UPLOAD_MARKER);
  const skipped = [...res.skipped];
  const failText = failed.map((f) => `${f.name} (${f.message})`).join(" · ");
  if (!installed.length && !skipped.length) {
    return { ok: false, message: failText ? `Could not write: ${failText}` : "No skill found" };
  }
  const warning = [res.warning, failText ? `could not write: ${failText}` : ""].filter(Boolean).join(" · ");
  return { ok: true, installed, skipped, warning: warning || undefined };
}

/** Find the directory holding SKILL.md — the extraction root, or a nested
 *  folder (common when a zip wraps everything in a top-level <skill>/ dir).
 *  Bounded to two levels so a deep archive can't spin. */
function findSkillDir(root: string, depth: number): string | null {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return root;
  if (depth >= 2) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "__MACOSX") continue;
    const found = findSkillDir(path.join(root, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** Skill name = the SKILL.md's folder name when it sits in a named subdir,
 *  else the zip's filename stem. Slugified to a filesystem-safe token. */
function deriveSkillName(
  skillDir: string,
  outRoot: string,
  zipFilename: string,
): string {
  const base =
    path.resolve(skillDir) === path.resolve(outRoot)
      ? zipFilename
      : path.basename(skillDir);
  return slugifyName(base);
}

function slugifyName(s: string): string {
  return s
    .trim()
    .replace(/\.(zip|skill)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Guard against path traversal / weird names before we touch the FS. */
function isSafeName(name: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("..")
  );
}

/** Flip a skill on/off by renaming SKILL.md <-> SKILL.md.disabled. Both
 *  uploaded and auto-created ("generated") skills toggle; system skills stay
 *  always-active. Exported for unit tests. */
export function toggleSkill(
  name: string,
  skills: SkillSummary[],
): { ok: true } | { ok: false; message: string } {
  const s = skills.find((x) => x.name === name);
  if (!s) return { ok: false, message: "Skill not found." };
  if (!s.uploaded && s.group !== "generated") {
    return { ok: false, message: "Only uploaded or generated skills can be toggled." };
  }
  const dir = path.dirname(s.path);
  const on = path.join(dir, "SKILL.md");
  const off = path.join(dir, "SKILL.md.disabled");
  try {
    if (fs.existsSync(on)) {
      fs.renameSync(on, off); // enabled -> disabled
    } else if (fs.existsSync(off)) {
      fs.renameSync(off, on); // disabled -> enabled
    } else {
      return { ok: false, message: "SKILL.md is missing." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Webview shell ────────────────────────────────────────────────────────────
//
// Bento redesign: a persistent filter rail (ALL / SYSTEM / GENERATED / UPLOADED)
// plus a paginated 3-column card grid (15 per page). No accordion. Every count
// (header pill + each rail tile sub-line) is derived live from the skill list so
// a toggle updates them instantly.
//
// IMPORTANT: the client <script> below lives inside this template literal, so
// any backslash here is consumed by the template (e.g. a `\/` in a regex would
// collapse to `//` and comment out the rest of a line). Keep the client script
// backslash-free — the only regexes used (escapeHtml) contain none.

function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#11171d; --editor:#0f151b; --card:#161f28;
    --border:rgba(255,255,255,.07); --border2:rgba(255,255,255,.13);
    --txt:#e7eef5; --muted:#8a97a4; --faint:#5c6773;
    --accent:#2f9dc4; --accent2:#40c8ea; --accentSoft:rgba(47,157,196,.15); --accentGlow:rgba(64,200,234,.28);
    --dot:rgba(255,255,255,.028); --primaryGrad:linear-gradient(180deg,#33a6cf,#1f7ea3);
  }
  :root[data-theme="light"] {
    --bg:#e9edf1; --panel:#f9fbfc; --editor:#ffffff; --card:#ffffff;
    --border:rgba(15,30,45,.10); --border2:rgba(15,30,45,.17);
    --txt:#132029; --muted:#5a6b78; --faint:#94a1ad;
    --accent:#0e88ad; --accent2:#0e7fa3; --accentSoft:rgba(14,136,173,.10); --accentGlow:rgba(14,136,173,.18);
    --dot:rgba(15,30,45,.035); --primaryGrad:linear-gradient(180deg,#13a0c9,#0e88ad);
  }
  :root { --pad:20px; --gap:14px; --radius:14px; --fs:13.5px;
    --uifont:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono',var(--vscode-editor-font-family),ui-monospace,monospace; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: var(--uifont); font-size: var(--fs); color: var(--txt);
    background: var(--editor); background-image: radial-gradient(var(--dot) 1px, transparent 1px);
    background-size: 24px 24px; margin: 0; padding: var(--pad);
    display: flex; flex-direction: column; overflow: hidden; }
  .wrap { max-width: 1060px; width: 100%; margin: 0 auto; flex: 1; display: flex; flex-direction: column; min-height: 0; }

  /* Header */
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .head h1 { font-size: 19px; font-weight: 700; margin: 0; }
  .pill { font-family: var(--mono); font-size: 11px; border-radius: 999px; padding: 3px 10px;
    background: var(--card); border: 1px solid var(--border); color: var(--muted); }
  .pill .tot { color: var(--faint); }
  .head .spacer { flex: 1; }
  .search { display: flex; align-items: center; gap: 6px; width: 210px; height: 30px; padding: 0 10px;
    border-radius: 7px; background: var(--card); border: 1px solid var(--border); }
  .search svg { width: 12px; height: 12px; color: var(--faint); flex-shrink: 0; }
  .search input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--txt); font-size: 11.5px; outline: none; font-family: var(--uifont); }
  .search input::placeholder { color: var(--faint); }
  .btn { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; border-radius: 7px;
    font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: var(--uifont); white-space: nowrap; }
  .btn svg { width: 13px; height: 13px; }
  .btn.sec { background: var(--card); border: 1px solid var(--border2); color: var(--muted); }
  .btn.sec:hover { border-color: var(--accent); color: var(--txt); }
  .btn.pri { border: none; background: var(--primaryGrad); color: #fff; box-shadow: 0 2px 8px var(--accentGlow); }
  .btn.pri:hover { filter: brightness(1.06); }
  .btn[disabled] { opacity: .5; cursor: default; }

  /* Body: rail + grid */
  .body { flex: 1; display: flex; gap: var(--gap); min-height: 0; }
  .rail { width: 184px; flex: none; display: flex; flex-direction: column; gap: 6px; }
  .tile { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 10px;
    cursor: pointer; background: var(--card); border: 1px solid var(--border); color: var(--muted); }
  .tile:hover { border-color: var(--accent); }
  .tile.active { background: var(--accentSoft); border-color: var(--accent); color: var(--txt); }
  .tile .cbar { width: 3px; align-self: stretch; border-radius: 2px; background: var(--tc, var(--accent2)); flex-shrink: 0; }
  .tile .tb { flex: 1; min-width: 0; }
  .tile .tl { font-family: var(--mono); font-size: 11px; letter-spacing: 1.4px; font-weight: 600; }
  .tile .ts { font-family: var(--mono); font-size: 10px; color: var(--faint); margin-top: 3px; }
  .tile .tc { font-family: var(--mono); font-size: 15px; font-weight: 600; flex-shrink: 0; }

  .grid-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .grid-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .grid-head .gl { font-family: var(--mono); font-size: 10.5px; letter-spacing: 2px; font-weight: 600; color: var(--faint); }
  .grid-head .rng { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  .grid-head .spacer { flex: 1; }
  .pager { display: flex; align-items: center; gap: 6px; }
  /* the hidden attribute alone loses to display:flex — without this the pager
     showed even when there is a single page. */
  .pager[hidden] { display: none; }
  .pager .pnums { display: flex; align-items: center; gap: 5px; }
  .pager .pg { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; background: var(--card); border: 1px solid var(--border2); color: var(--txt); cursor: pointer; }
  .pager .pg svg { width: 13px; height: 13px; }
  .pager .pg:hover:not([disabled]) { border-color: var(--accent); }
  .pager .pg[disabled] { color: var(--faint); opacity: .4; cursor: default; }
  /* Numbered pages: you can see how many there are and jump straight to one. */
  .pager .pgn { height: 26px; min-width: 26px; padding: 0 7px; border-radius: 7px; font-family: var(--mono); font-size: 11px;
    background: var(--card); border: 1px solid var(--border2); color: var(--muted); cursor: pointer; }
  .pager .pgn:hover { border-color: var(--accent); color: var(--txt); }
  .pager .pgn.cur { background: var(--accentSoft); border-color: var(--accent); color: var(--txt); font-weight: 700; }
  /* The one page whose rows are not downloaded yet — dashed = "this one fetches". */
  .pager .pgn.more { border-style: dashed; }
  .pager .pgn[disabled] { opacity: .5; cursor: default; }
  .pager .gap { font-family: var(--mono); font-size: 11px; color: var(--faint); padding: 0 1px; }

  /* grid-auto-rows: max-content is load-bearing. With plain auto rows, a grid
     taller than its own box squeezes EVERY row to an equal slice of that box
     (measured: 42px rows holding 177px cards) and .scard's overflow:hidden then
     silently ate the summary and half the download button. Rows size to their
     content; the GRID scrolls. */
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; align-content: start;
    grid-auto-rows: max-content; flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
  @media (max-width: 780px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  /* A ClawHub row carries a registry name + owner + version + downloads + summary,
     which does not fit a local-skill column: wider columns, fewer of them. */
  .grid.hub { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }

  .scard { position: relative; padding: 13px 13px 13px 16px; border-radius: 11px; background: var(--card);
    border: 1px solid var(--border); overflow: hidden; cursor: pointer; }
  .scard:hover { border-color: var(--accent); }
  .scard.off { opacity: .5; }
  .scard .cbar { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--sc, var(--accent2)); }
  .scard .top { display: flex; align-items: flex-start; gap: 8px; }
  .scard .ctext { flex: 1; min-width: 0; }
  .scard .cname { font-family: var(--mono); font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scard .ccat { font-family: var(--mono); font-size: 9px; letter-spacing: 1.2px; color: var(--faint); margin-top: 4px; }
  /* Three lines, then an ellipsis: a registry summary can run six lines in a
     narrow column, which turns the grid into a wall of text with no two cards
     the same height. The full text is on the card's title attribute. */
  .scard .cdesc { font-size: 10.5px; color: var(--muted); line-height: 1.55; margin-top: 9px;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }

  /* On/off switch (generated + uploaded) */
  .sw { flex: none; position: relative; width: 32px; height: 18px; border-radius: 9px; cursor: pointer;
    background: var(--border); border: 1px solid var(--border2); transition: .18s; padding: 0; }
  .sw .knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--faint); transition: .18s; }
  .sw.on { background: #5ecf8f; border-color: rgba(94,207,143,.5); }
  .sw.on .knob { left: 16px; background: #0e2019; }

  /* Built-in badge (system) */
  .badge { flex: none; display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 9px;
    letter-spacing: .5px; color: var(--faint); border: 1px solid var(--border); border-radius: 5px; padding: 2px 6px; }
  .badge svg { width: 9px; height: 9px; }

  .empty { color: var(--faint); font-size: 13px; padding: 30px 4px; }

  /* ClawHub (remote catalogue) cards: same shell as a local skill card, but the
     card is not clickable (there is no local file to open yet) and the control is
     a download button on its OWN row. Sharing the local card's top row put a
     ~90px button beside the title in a ~270px column, which chopped every name
     down to "self-improv…" — the name now owns the full width and wraps once. */
  .scard.hub { cursor: default; padding: 13px 14px 12px 16px; }
  .scard.hub .cname { white-space: normal; overflow: hidden; text-overflow: clip; font-size: 12.5px; line-height: 1.35;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .scard.hub .ccat { text-transform: none; letter-spacing: 0; font-family: var(--mono); font-size: 9.5px; }
  .scard.hub .cdesc { margin-top: 8px; }
  .hfoot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 11px; }
  .hfoot .off { margin-right: auto; font-family: var(--mono); font-size: 9.5px; color: var(--faint); }
  .hbtn { flex: none; padding: 6px 14px; border-radius: 8px; font-size: 11.5px; font-weight: 700; cursor: pointer;
    background: rgba(139,124,246,.16); color: var(--txt); border: 1px solid #8b7cf6; }
  .hbtn:hover { filter: brightness(1.2); }
  .hbtn[disabled], .hbtn.busy { opacity: .55; cursor: default; filter: none; }
  /* "Installed" is a STATE, not a button — flat, no hover, nothing to press. */
  .hbtn.done { background: transparent; border-color: var(--border2); color: var(--faint); cursor: default; font-weight: 600; }
  .scard.hub.installed { opacity: .72; }
  .hretry { display: flex; justify-content: center; padding: 6px 0 2px; }

  /* Browse-skills modal */
  .scrim { position: fixed; inset: 0; background: rgba(3,8,12,.62); display: flex; align-items: center; justify-content: center;
    padding: 34px; z-index: 60; }
  .scrim[hidden] { display: none; }
  .dialog { width: min(560px, 100%); max-height: 100%; display: flex; flex-direction: column; border-radius: 15px;
    background: var(--panel); border: 1px solid var(--border2); box-shadow: 0 30px 70px rgba(0,0,0,.55); overflow: hidden; }
  .dhead { display: flex; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
  .dhead .dt { font-size: 15px; font-weight: 700; }
  .dhead .spacer { flex: 1; }
  .dclose { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px;
    background: transparent; border: 1px solid var(--border2); color: var(--muted); cursor: pointer; }
  .dclose:hover { border-color: var(--accent); color: var(--txt); }
  .dclose svg { width: 13px; height: 13px; }
  .dbody { padding: 14px 18px 18px; overflow-y: auto; }
  .localrow { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px;
    border: 1px dashed var(--accent); background: var(--accentSoft); cursor: pointer; }
  .localrow:hover { filter: brightness(1.1); }
  .localrow svg.folder { width: 17px; height: 17px; color: var(--accent2); flex-shrink: 0; }
  .localrow .lt { flex: 1; min-width: 0; }
  .localrow .l1 { font-size: 12.5px; font-weight: 700; }
  .localrow .l2 { font-size: 10.5px; color: var(--muted); margin-top: 3px; }
  .localrow .kc { font-family: var(--mono); font-size: 10px; color: var(--faint); border: 1px solid var(--border2); border-radius: 5px; padding: 2px 6px; }

  /* URL row: paste a github link, get every skill under it. Sits UNDER the
     local-file row — margins live on the separator and the hint, so the two
     options can be reordered without leaving a double gap. */
  .urlrow { display: flex; gap: 8px; }
  .urlrow input { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px; font-family: var(--mono); font-size: 11.5px;
    background: var(--bg); color: var(--txt); border: 1px solid var(--border2); }
  .urlrow input:focus { outline: none; border-color: var(--accent); }
  .urlrow button { flex: none; padding: 0 14px; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer;
    background: var(--accentSoft); color: var(--txt); border: 1px solid var(--accent); }
  .urlrow button:hover { filter: brightness(1.15); }
  .urlrow button[disabled] { opacity: .5; cursor: default; filter: none; }
  .urlhint { font-size: 10.5px; color: var(--muted); margin: 7px 0 0; line-height: 1.5; }
  .urlhint code { font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .dsep { display: flex; align-items: center; gap: 10px; margin: 13px 0; color: var(--faint); font-size: 10.5px; }
  .dsep::before, .dsep::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* Toast */
  #toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 70; display: none;
    font-size: 12px; padding: 9px 16px; border-radius: 9px; background: var(--panel); border: 1px solid var(--border2);
    box-shadow: 0 10px 30px rgba(0,0,0,.4); }
  /* warn = nothing to do (already installed) — neither a success nor a failure,
     so it must not be red: red reads as "the paste broke". */
  #toast.ok { color: #5ecf8f; } #toast.err { color: #f4796b; } #toast.warn { color: #e0b341; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>Skill Library</h1>
    <span class="pill" id="pill"></span>
    <span class="spacer"></span>
    <span class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg><input id="q" type="text" placeholder="ค้นหา skill…" /></span>
    <button class="btn sec" id="reload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>Reload</button>
    <button class="btn pri" id="upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M12 3v13M7 8l5-5 5 5"/></svg>Upload Skill</button>
  </div>

  <div class="body">
    <div class="rail" id="rail"></div>
    <div class="grid-col">
      <div class="grid-head">
        <span class="gl" id="grid-label">ALL SKILLS</span>
        <span class="rng" id="grid-range"></span>
        <span class="spacer"></span>
        <div class="pager" id="pager" hidden>
          <button class="pg" id="pg-prev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <span class="pnums" id="pg-nums"></span>
          <button class="pg" id="pg-next"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        </div>
      </div>
      <div class="grid" id="grid"></div>
    </div>
  </div>
</div>

<div class="scrim" id="scrim" hidden>
  <div class="dialog">
    <div class="dhead"><span class="dt">Add a skill</span><span class="spacer"></span><button class="dclose" id="dclose"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
    <div class="dbody">
      <div class="localrow" id="localrow">
        <svg class="folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>
        <div class="lt"><div class="l1">Pick a skill from this machine</div><div class="l2">Opens the system file browser</div></div>
        <span class="kc">Ctrl O</span>
      </div>
      <div class="dsep">or</div>
      <div class="urlrow">
        <input id="urlInput" type="text" spellcheck="false" placeholder="Paste a GitHub link — https://github.com/anthropics/skills/tree/main/skills" />
        <button id="urlGo">Fetch</button>
      </div>
      <div class="urlhint">A link to a folder of skills installs every skill in it at once · a single skill's link works too · all land under <code>uploaded</code> · ones you already have are skipped</div>
    </div>
  </div>
</div>

<input type="file" id="fileInput" accept=".zip" style="display:none" />
<div id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();
  (function () { var b = document.body.classList;
    document.documentElement.dataset.theme = (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) ? "light" : "dark"; })();

  var PAGE_SIZE = 15;
  var HUB_PAGE = 12;   // rows per SCREEN; the host fetches 100 rows per request
  var STATE = { skills: [], filter: "all", page: 0, query: "" };
  // ClawHub tab: a REMOTE catalogue, so it keeps its own list/cursor/errors and
  // never mixes into STATE.skills (which is "what is on this machine").
  // HUB.page is a page of what has been downloaded so far — one request brings
  // 100 rows, i.e. pages 1–9, and only page 10 has to go back to the network.
  var HUB = { items: [], cursor: null, loading: false, error: "", loaded: false, q: "", busy: {}, page: 0 };
  var CATS = [
    { key: "all", label: "ALL SKILLS", color: "var(--accent2)" },
    { key: "system", label: "SYSTEM", color: "#4f9cf9" },
    { key: "generated", label: "GENERATED", color: "#e8a33d" },
    { key: "uploaded", label: "UPLOADED", color: "#e879a8" },
    { key: "clawhub", label: "CLAWHUB", color: "#8b7cf6" }
  ];
  function catMeta(k) { for (var i = 0; i < CATS.length; i++) if (CATS[i].key === k) return CATS[i]; return CATS[0]; }
  function catColor(g) { return catMeta(g === "system" || g === "generated" || g === "uploaded" ? g : "all").color; }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // A system skill is always on; toggleable skills follow their enabled flag.
  function isOn(s) { return (s.group === "system") ? true : !!s.enabled; }
  // In the ALL view, order by group (system → generated → uploaded), then
  // alphabetically within each group. A single-category filter is already one
  // group, so its list stays plain alphabetical (as the server sent it).
  var GROUP_RANK = { system: 0, generated: 1, uploaded: 2 };
  function listFor(cat) {
    if (cat !== "all") return STATE.skills.filter(function (s) { return (s.group || "system") === cat; });
    return STATE.skills.slice().sort(function (a, b) {
      var ra = GROUP_RANK[a.group || "system"], rb = GROUP_RANK[b.group || "system"];
      if (ra == null) ra = 9; if (rb == null) rb = 9;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }
  function counts(cat) {
    var l = listFor(cat), on = 0;
    for (var i = 0; i < l.length; i++) if (isOn(l[i])) on++;
    return { total: l.length, on: on };
  }

  function filtered() {
    var l = listFor(STATE.filter);
    var q = STATE.query.trim().toLowerCase();
    if (q) l = l.filter(function (s) {
      return s.name.toLowerCase().indexOf(q) !== -1 || String(s.description || "").toLowerCase().indexOf(q) !== -1;
    });
    return l;
  }

  function renderPill() {
    var c = counts("all");
    document.getElementById("pill").innerHTML = c.on + ' <span class="tot">/ ' + c.total + " on</span>";
  }
  function renderRail() {
    var html = CATS.map(function (c) {
      var active = STATE.filter === c.key ? " active" : "";
      // CLAWHUB counts nothing local — its sub-line says what it is, and its
      // count is however many rows are loaded from the registry so far.
      if (c.key === "clawhub") {
        return '<div class="tile' + active + '" data-filter="clawhub" style="--tc:' + c.color + '">' +
          '<span class="cbar"></span>' +
          '<div class="tb"><div class="tl">' + c.label + '</div><div class="ts">online catalogue</div></div>' +
          '<div class="tc">' + (HUB.items.length ? HUB.items.length + (HUB.cursor ? "+" : "") : "→") + "</div></div>";
      }
      var n = counts(c.key);
      var sub = c.key === "system" ? "always on" : (n.on + " / " + n.total + " on");
      return '<div class="tile' + active + '" data-filter="' + c.key + '" style="--tc:' + c.color + '">' +
        '<span class="cbar"></span>' +
        '<div class="tb"><div class="tl">' + c.label + '</div><div class="ts">' + sub + "</div></div>" +
        '<div class="tc">' + n.total + "</div></div>";
    }).join("");
    document.getElementById("rail").innerHTML = html;
  }

  // ── ClawHub cards ──
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(n);
  }
  // The download control sits on its OWN row: sharing the title row put a ~90px
  // button in a ~270px column and every name came out as "self-improv…".
  function hubCard(s) {
    var busy = !!HUB.busy[s.name];
    var btn = s.installed
      ? '<span class="hbtn done">Installed</span>'
      : '<button class="hbtn' + (busy ? " busy" : "") + '" data-get="' + esc(s.name) + '" data-ver="' + esc(s.version) + '" data-owner="' + esc(s.owner) + '"' +
        (busy ? " disabled" : "") + '>' + (busy ? "Downloading…" : "Download") + '</button>';
    var meta = '@' + esc(s.owner) + ' · v' + esc(s.version) + ' · ' + fmtNum(s.downloads) + ' dl';
    return '<div class="scard hub' + (s.installed ? " installed" : "") + '" style="--sc:#8b7cf6" title="' + esc(s.name) + '">' +
      '<span class="cbar"></span>' +
      '<div class="cname">' + esc(s.displayName) + "</div>" +
      '<div class="ccat">' + meta + "</div>" +
      '<div class="cdesc" title="' + esc(s.summary) + '">' + (s.summary ? esc(s.summary) : "(no description)") + "</div>" +
      '<div class="hfoot">' + btn + "</div></div>";
  }

  function requestHub(cursor) {
    HUB.loading = true;
    HUB.error = "";
    if (!cursor) { HUB.items = []; HUB.cursor = null; HUB.page = 0; }
    HUB.q = STATE.query;
    render();
    vscode.postMessage({ type: "hub_browse", q: STATE.query, cursor: cursor || null });
  }

  // Jump to a ClawHub page. Pages past what is downloaded are legal: the page
  // number itself pulls the next 100 rows and then lands there, which is why the
  // pager can offer page N+1 before its rows exist.
  function gotoHubPage(n) {
    if (n < 0) return;
    var loaded = Math.ceil(HUB.items.length / HUB_PAGE);
    if (n >= loaded) {
      if (!HUB.cursor || HUB.loading) return;
      HUB.page = n;
      requestHub(HUB.cursor);
      return;
    }
    HUB.page = n;
    render();
    document.getElementById("grid").scrollTop = 0;
  }

  function renderHub() {
    var grid = document.getElementById("grid");
    grid.classList.add("hub");
    var total = HUB.items.length;
    var loaded = Math.max(1, Math.ceil(total / HUB_PAGE));
    if (!HUB.loading && HUB.page > loaded - 1) HUB.page = loaded - 1;
    if (HUB.page < 0) HUB.page = 0;
    var start = HUB.page * HUB_PAGE;
    var slice = HUB.items.slice(start, start + HUB_PAGE);

    document.getElementById("grid-label").textContent = "CLAWHUB";
    document.getElementById("grid-range").textContent = slice.length
      ? ("— " + (start + 1) + "–" + (start + slice.length) + " of " + total + (HUB.cursor ? "+" : "") +
        (STATE.query ? ' for "' + esc(STATE.query) + '"' : " by downloads"))
      : "";

    var body;
    if (HUB.error) body = '<div class="empty">' + esc(HUB.error) + '<div class="hretry"><button class="hbtn" id="hub-retry">Retry</button></div></div>';
    else if (HUB.loading && !slice.length) body = '<div class="empty">Loading from ClawHub…</div>';
    else if (!total) body = '<div class="empty">No skill found on ClawHub</div>';
    else body = slice.map(hubCard).join("");
    grid.innerHTML = body;

    // One extra page number when the registry says there is more — clicking it
    // fetches. Everything before it is already in memory and switches instantly.
    // The pager is drawn from what is LOADED, not from what is on screen, so it
    // stays put while that fetch runs instead of blinking away for a second.
    renderPager(HUB.page, HUB.error || !total ? 0 : loaded + (HUB.cursor ? 1 : 0), !!HUB.cursor);
  }

  // ── Pager ──
  // Up to 7 slots: first, last, current ±1, "…" for what is skipped.
  function pageWindow(cur, pages) {
    var out = [], i;
    if (pages <= 7) { for (i = 1; i <= pages; i++) out.push(i); return out; }
    var lo = Math.max(2, cur - 1), hi = Math.min(pages - 1, cur + 1);
    if (cur <= 3) { lo = 2; hi = 4; }
    if (cur >= pages - 2) { lo = pages - 3; hi = pages - 1; }
    out.push(1);
    if (lo > 2) out.push("gap");
    for (i = lo; i <= hi; i++) out.push(i);
    if (hi < pages - 1) out.push("gap");
    out.push(pages);
    return out;
  }
  function renderPager(cur, pages, lastNeedsFetch) {
    var pager = document.getElementById("pager");
    if (pages <= 1) { pager.setAttribute("hidden", ""); return; }
    pager.removeAttribute("hidden");
    document.getElementById("pg-nums").innerHTML = pageWindow(cur + 1, pages).map(function (p) {
      if (p === "gap") return '<span class="gap">…</span>';
      var more = lastNeedsFetch && p === pages;
      return '<button class="pgn' + (p === cur + 1 ? " cur" : "") + (more ? " more" : "") +
        '" data-page="' + p + '" title="' + (more ? "Load the next 100 from ClawHub" : "Page " + p) + '">' + p + "</button>";
    }).join("");
    var prev = document.getElementById("pg-prev"), next = document.getElementById("pg-next");
    if (cur <= 0) prev.setAttribute("disabled", ""); else prev.removeAttribute("disabled");
    if (cur >= pages - 1) next.setAttribute("disabled", ""); else next.removeAttribute("disabled");
  }

  function skillCard(s) {
    var col = catColor(s.group);
    var toggleable = s.uploaded || s.group === "generated";
    var off = toggleable && !s.enabled;
    var right = toggleable
      ? '<button class="sw ' + (s.enabled ? "on" : "") + '" data-tog="' + esc(s.name) + '" title="' + (s.enabled ? "ปิด skill นี้" : "เปิด skill นี้") + '"><span class="knob"></span></button>'
      : '<span class="badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>BUILT-IN</span>';
    var cat = (s.group || "system").toUpperCase();
    var desc = s.description ? esc(s.description) : "(ไม่มีคำอธิบาย)";
    return '<div class="scard' + (off ? " off" : "") + '" data-name="' + esc(s.name) + '" style="--sc:' + col + '">' +
      '<span class="cbar"></span>' +
      '<div class="top"><div class="ctext"><div class="cname" title="' + esc(s.name) + '">' + esc(s.name) + "</div>" +
      '<div class="ccat">' + cat + "</div></div>" + right + "</div>" +
      '<div class="cdesc">' + desc + "</div></div>";
  }

  function render() {
    renderPill();
    renderRail();
    if (STATE.filter === "clawhub") { renderHub(); return; }
    var list = filtered();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (STATE.page >= pages) STATE.page = pages - 1;
    if (STATE.page < 0) STATE.page = 0;
    var start = STATE.page * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);

    document.getElementById("grid-label").textContent = catMeta(STATE.filter).label;
    document.getElementById("grid-range").textContent = total ? ("— " + (start + 1) + "–" + (start + slice.length) + " จาก " + total) : "";

    var grid = document.getElementById("grid");
    grid.classList.remove("hub");
    if (!total) {
      grid.innerHTML = '<div class="empty">' + (STATE.query ? "ไม่พบ skill ที่ตรงกับคำค้น" : "ไม่พบ skill ในหมวดนี้") + "</div>";
    } else {
      grid.innerHTML = slice.map(skillCard).join("");
    }
    renderPager(STATE.page, total ? pages : 0, false);
  }

  // ── Upload / modal ──
  var fileInput = document.getElementById("fileInput");
  function openModal() { document.getElementById("scrim").removeAttribute("hidden"); }
  function closeModal() { document.getElementById("scrim").setAttribute("hidden", ""); }
  function toast(text, kind) {
    var t = document.getElementById("toast");
    t.textContent = text; t.className = kind || "";
    t.style.display = "block";
    if (t._h) clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = "none"; }, 3200);
  }
  function toB64(buf) {
    var bytes = new Uint8Array(buf), bin = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) { toast("Only .zip files are supported", "err"); return; }
    if (file.size > 25 * 1024 * 1024) { toast("File too large (max 25 MB)", "err"); return; }
    closeModal();
    toast("Uploading " + file.name + " …", "");
    try {
      var buf = await file.arrayBuffer();
      vscode.postMessage({ type: "upload_skill", filename: file.name, dataB64: toB64(buf) });
    } catch (e) { toast("Could not read the file: " + (e && e.message ? e.message : e), "err"); }
  }

  // ── Pull skills from a GitHub URL ──
  // The button locks while the host works: one paste can be 400 files, and a second
  // click would run the whole traversal again against a half-written skills dir.
  var urlBusy = false;
  function setUrlBusy(on) {
    urlBusy = on;
    var b = document.getElementById("urlGo");
    if (on) b.setAttribute("disabled", ""); else b.removeAttribute("disabled");
    b.textContent = on ? "Fetching…" : "Fetch";
  }
  function submitUrl() {
    if (urlBusy) return;
    var input = document.getElementById("urlInput");
    var url = (input.value || "").trim();
    if (!url) { toast("Paste a GitHub link first", "err"); return; }
    // No regex on purpose — this script lives in a TS template literal where a
    // backslash is eaten (see the IMPORTANT note above renderShell).
    var lower = url.toLowerCase();
    if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) {
      toast("The link must start with http(s)://", "err"); return;
    }
    setUrlBusy(true);
    toast("Reading the skill list…", "");
    vscode.postMessage({ type: "upload_url", url: url });
  }

  // ── Events (delegated) ──
  document.addEventListener("click", function (e) {
    var t = e.target;
    var tile = t.closest ? t.closest(".tile") : null;
    if (tile) {
      STATE.filter = tile.getAttribute("data-filter"); STATE.page = 0;
      // Fetch the catalogue the first time the tab is opened, not on panel load —
      // a user who never opens it never calls out to the network.
      if (STATE.filter === "clawhub" && !HUB.loaded && !HUB.loading) { HUB.loaded = true; requestHub(null); return; }
      render(); return;
    }

    var get = t.closest ? t.closest(".hbtn[data-get]") : null;
    if (get) {
      e.stopPropagation();
      var gname = get.getAttribute("data-get");
      if (HUB.busy[gname]) return;          // already downloading this one
      HUB.busy[gname] = true; render();
      vscode.postMessage({ type: "hub_install", name: gname, version: get.getAttribute("data-ver"), owner: get.getAttribute("data-owner") });
      return;
    }

    var pgn = t.closest ? t.closest(".pgn[data-page]") : null;
    if (pgn) {
      var pnum = Number(pgn.getAttribute("data-page")) - 1;
      if (STATE.filter === "clawhub") gotoHubPage(pnum);
      else { STATE.page = pnum; render(); document.getElementById("grid").scrollTop = 0; }
      return;
    }

    var tog = t.closest ? t.closest(".sw") : null;
    if (tog) { e.stopPropagation(); vscode.postMessage({ type: "toggle_skill", name: tog.getAttribute("data-tog") }); return; }

    var card = t.closest ? t.closest(".scard") : null;
    // A ClawHub card is not a local file — nothing to open in the editor.
    if (card && !card.classList.contains("hub")) { vscode.postMessage({ type: "open_skill", name: card.getAttribute("data-name") }); return; }

    var id = (t.closest ? t.closest("[id]") : null);
    id = id ? id.id : "";
    if (id === "reload") { vscode.postMessage({ type: "reload" }); }
    else if (id === "urlGo") { submitUrl(); }
    else if (id === "upload") { openModal(); }
    else if (id === "dclose" || id === "scrim") { closeModal(); }
    else if (id === "localrow") { fileInput.click(); }
    else if (id === "pg-prev") {
      if (STATE.filter === "clawhub") gotoHubPage(HUB.page - 1);
      else if (STATE.page > 0) { STATE.page--; render(); document.getElementById("grid").scrollTop = 0; }
    }
    else if (id === "pg-next") {
      if (STATE.filter === "clawhub") gotoHubPage(HUB.page + 1);
      else { STATE.page++; render(); document.getElementById("grid").scrollTop = 0; }
    }
    else if (id === "hub-retry") { requestHub(null); }
  });
  // The one search box drives both views. Local filtering is instant, so it stays
  // keystroke-by-keystroke; ClawHub is a network call, so it waits for a pause.
  var hubDebounce = null;
  document.addEventListener("input", function (e) {
    if (!e.target || e.target.id !== "q") return;
    STATE.query = e.target.value || ""; STATE.page = 0;
    if (STATE.filter === "clawhub") {
      if (hubDebounce) clearTimeout(hubDebounce);
      hubDebounce = setTimeout(function () { HUB.loaded = true; requestHub(null); }, 350);
      return;
    }
    render();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
    // Enter in the URL box = press Fetch. Paste-and-go is the whole point of the row.
    else if (e.key === "Enter" && e.target && e.target.id === "urlInput") { e.preventDefault(); submitUrl(); }
  });
  fileInput.addEventListener("change", function () {
    var f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    fileInput.value = "";
  });

  // Drag-and-drop anywhere on the window drops straight in (no dialog), with the
  // rail drop target highlighting while a file is over the window.
  window.addEventListener("dragover", function (e) { e.preventDefault(); var d = document.getElementById("drop"); if (d) d.classList.add("drag"); });
  window.addEventListener("dragleave", function (e) { if (e.relatedTarget === null) { var d = document.getElementById("drop"); if (d) d.classList.remove("drag"); } });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    var d = document.getElementById("drop"); if (d) d.classList.remove("drag");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "render_list") { STATE.skills = m.skills || []; render(); }
    else if (m.type === "upload_ok") { STATE.filter = "uploaded"; STATE.page = 0; render(); toast("Installed " + m.name, "ok"); }
    else if (m.type === "upload_progress") {
      // "3/17 · pdf" — a 10 MB repo takes a while and a silent toast reads as a hang.
      toast("Fetching " + (m.done + 1) + "/" + m.total + (m.name ? " · " + m.name : "") + " …", "");
    }
    else if (m.type === "upload_url_ok") {
      setUrlBusy(false);
      closeModal();
      STATE.filter = "uploaded"; STATE.page = 0; render();
      var names = m.installed || [], skips = m.skipped || [];
      var ins = names.length, sk = skips.length;
      // Nothing installed because it is ALREADY here is not a failure and must not
      // read like "no skill found" — that wording belongs to an empty link.
      var msg;
      if (ins) msg = "Installed " + ins + " skill" + (ins > 1 ? "s" : "") + (sk ? " · " + sk + " already installed" : "");
      else if (sk === 1) msg = "Skill already installed: " + skips[0];
      else msg = sk + " skills already installed";
      if (m.warning) msg += " · " + m.warning;
      toast(msg, ins ? "ok" : "warn");
    }
    else if (m.type === "upload_error") { setUrlBusy(false); toast(m.message || "Upload failed", "err"); }
    else if (m.type === "hub_list") {
      HUB.loading = false; HUB.error = "";
      HUB.items = m.append ? HUB.items.concat(m.items || []) : (m.items || []);
      HUB.cursor = m.nextCursor || null;
      if (STATE.filter === "clawhub") { render(); document.getElementById("grid").scrollTop = 0; }
    }
    else if (m.type === "hub_error") {
      HUB.loading = false;
      if (m.name) { delete HUB.busy[m.name]; toast(m.message || "Download failed", "err"); }
      // A page we already have must stay on screen: only a first page that never
      // arrived turns the whole grid into an error with a Retry.
      else if (HUB.items.length) toast(m.message || "ClawHub unreachable", "err");
      else HUB.error = m.message || "ClawHub unreachable";
      render();
    }
    else if (m.type === "hub_installed") {
      delete HUB.busy[m.name];
      // Flip THIS card to "Installed" in place — no re-fetch of the catalogue, and
      // the button can never be clicked twice into a duplicate install.
      for (var hi = 0; hi < HUB.items.length; hi++) if (HUB.items[hi].name === m.name) HUB.items[hi].installed = true;
      render();
      toast(m.already ? ("Skill already installed: " + m.name) : ("Installed " + m.name), m.already ? "warn" : "ok");
    }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body></html>`;
}
