// เริ่มโปรเจคจาก repo ที่มีอยู่แล้ว: MC clone ให้ก่อนปลุก oracle (user's call 2026-08-11).
//
// ⛔ ทำไม MC ทำเอง ไม่ส่ง URL ให้ engine: ผิดพลาดตอน clone (URL ผิด / auth ไม่ผ่าน / repo ใหญ่)
//    ต้องเห็นในหน้าจอทันที ไม่ใช่หลุดไปโผล่ใน tmux pane ที่ไม่มีใครดู — และ orches-skills
//    ไม่ต้องแก้แม้บรรทัดเดียว (prep-repo ข้าม `git init` ให้เองเมื่อ .git มีอยู่แล้ว).
//
// ⛔⛔ ข้อห้ามที่สำคัญที่สุดของไฟล์นี้: **ห้ามให้งานถูก push กลับขึ้นที่ที่ clone มา**
//    (user สั่งตรง ๆ 2026-08-11) · engine `ensure_remote` จะ `push -u origin main` ทันที
//    ถ้าเจอ `origin` — ซึ่งหลัง clone คือ repo ของคนอื่น. remoteRewirePlan() จึงเปลี่ยน
//    origin เป็น `upstream` ที่ push ไม่ได้ และไม่เหลือ origin ไว้เลย เพื่อให้ engine
//    สร้าง repo ของเราเองใต้ org แล้ว push ที่นั่น = พฤติกรรม default เดิมเป๊ะ.
import * as cp from "node:child_process";
import * as fs from "node:fs";

import { sanitizeName } from "./projectName";

export type RepoProvider = "github" | "azure-devops" | "gitlab" | "bitbucket" | "other";

export interface RepoUrlInfo {
  valid: boolean;
  /** เจ้าของ host ที่จำได้ — ใช้โชว์ในหน้าจอเท่านั้น ไม่เปลี่ยนวิธี clone */
  provider?: RepoProvider;
  providerLabel?: string;
  /** ชื่อ repo ที่แกะได้ (ผ่าน sanitizeName แล้ว) — เอาไปเป็นชื่อโปรเจคตั้งต้น */
  repo?: string;
  /** เหตุผลที่ใช้ไม่ได้ — ภาษาไทย โชว์ใต้ช่องกรอกตรง ๆ */
  reason?: string;
}

/** push URL ที่ยัดใส่ `upstream` เพื่อให้ทุกการ push ขึ้นต้นทางล้มแบบดัง ๆ ไม่ใช่เงียบ ๆ */
export const CLONE_SOURCE_NO_PUSH = "DISABLED-clone-source-do-not-push";

const PROVIDER_LABEL: Record<RepoProvider, string> = {
  github: "GitHub",
  "azure-devops": "Azure DevOps",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  other: "git",
};

function providerOf(host: string): RepoProvider {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "dev.azure.com" || h === "ssh.dev.azure.com" || h.endsWith(".visualstudio.com"))
    return "azure-devops";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "gitlab";
  if (h === "bitbucket.org" || h.startsWith("bitbucket.")) return "bitbucket";
  return "other";
}

/** ชื่อ repo จาก path ของ URL. Azure DevOps วาง repo ไว้หลัง `_git/` (segment ก่อนหน้าคือ
 *  ชื่อ *project* ซึ่งไม่ใช่ชื่อ repo) — ที่เหลือใช้ segment สุดท้าย. */
function repoFromPath(segments: string[]): string | null {
  const gi = segments.indexOf("_git");
  const raw = gi >= 0 ? segments[gi + 1] : segments[segments.length - 1];
  if (!raw) return null;
  return raw.replace(/\.git$/i, "");
}

/** URL ที่ปลอดภัยพอจะส่งให้ `git clone` — whitelist เท่านั้น.
 *
 *  ⛔ ไม่ใช่การกันคนพิมพ์ผิด แต่กัน **RCE**: `git clone 'ext::sh -c …'` รันคำสั่งจริง
 *  และค่าที่ขึ้นต้นด้วย `-` จะถูก git อ่านเป็น option (`--upload-pack=…`). URL นี้มาจาก
 *  webview จึงถือว่าเป็น input ที่ไม่ไว้ใจ. รับแค่ `https://`, `ssh://` และ scp-form
 *  `git@host:path` — `http://`/`file://`/transport อื่นถูกปฏิเสธพร้อมเหตุผล. */
export function parseRepoUrl(raw: string): RepoUrlInfo {
  const url = (raw ?? "").trim();
  if (!url) return { valid: false, reason: "ยังไม่ได้ใส่ URL" };
  if (/[\s;|&`$<>(){}'"\\]/.test(url))
    return { valid: false, reason: "URL มีช่องว่างหรืออักขระที่ใช้ไม่ได้" };
  if (url.startsWith("-"))
    return { valid: false, reason: "URL ขึ้นต้นด้วย '-' ไม่ได้ (git จะอ่านเป็น option)" };

  let host = "";
  let path = "";
  if (/^https:\/\//i.test(url) || /^ssh:\/\//i.test(url)) {
    const rest = url.replace(/^[a-z]+:\/\//i, "");
    const slash = rest.indexOf("/");
    if (slash < 0) return { valid: false, reason: "URL ไม่มี path ของ repo" };
    host = rest.slice(0, slash).replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    path = rest.slice(slash + 1);
  } else if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(url)) {
    // scp-form: git@host:owner/repo.git
    const at = url.indexOf("@");
    const colon = url.indexOf(":", at);
    host = url.slice(at + 1, colon);
    path = url.slice(colon + 1);
  } else if (/^[a-z][a-z0-9+.-]*::/i.test(url)) {
    return { valid: false, reason: "transport แบบนี้ใช้ไม่ได้ (รันคำสั่งได้ = อันตราย)" };
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return { valid: false, reason: "รับแค่ https:// หรือ ssh:// (หรือ git@host:path)" };
  } else {
    return { valid: false, reason: "รูปแบบ URL ไม่ถูก" };
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) return { valid: false, reason: "host ไม่ถูกต้อง" };
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  // ต้องมีอย่างน้อย owner/repo — `https://github.com/onlyowner` ไม่ใช่ repo
  if (segments.length < 2) return { valid: false, reason: "URL ไม่ครบ (ต้องมีถึงชื่อ repo)" };
  const repoRaw = repoFromPath(segments);
  if (!repoRaw) return { valid: false, reason: "แกะชื่อ repo จาก URL ไม่ได้" };
  const repo = sanitizeName(repoRaw);
  if (!repo) return { valid: false, reason: "ชื่อ repo ใน URL ใช้เป็นชื่อโปรเจคไม่ได้" };

  const provider = providerOf(host);
  return { valid: true, provider, providerLabel: PROVIDER_LABEL[provider], repo };
}

/** args ของ `git clone`. ⛔ `--` ต้องมาก่อน URL เสมอ — กันค่าที่หลุด validate ไปกลายเป็น option */
export function buildCloneArgs(url: string, dest: string): string[] {
  return ["clone", "--", url, dest];
}

/** แปลง stderr ของ `git clone` เป็นคำแนะนำที่ทำต่อได้ — auth ของ provider นี้ใช้ของที่มี
 *  ในเครื่องเท่านั้น (user's call: ไม่เก็บ PAT ใน MC) จึงต้องบอกให้ชัดว่าต้องไปล็อกอินที่ไหน.
 *  ⛔ ไม่รู้จัก = คืนบรรทัดจริงของ git ห้ามคืนค่าว่าง (ไม่งั้นได้ popup ที่ไม่บอกอะไร). */
export function cloneErrorHint(stderr: string): string {
  const s = (stderr ?? "").replace(/\s+/g, " ").trim();
  if (/permission denied \(publickey\)|host key verification/i.test(s))
    return "clone ไม่ผ่านเพราะ ssh key — เพิ่ม key ของเครื่องนี้ที่ provider ก่อน (หรือใช้ URL https แทน)";
  if (/authentication failed|could not read username|could not read password|403|terminal prompts disabled/i.test(s))
    return "clone ไม่ผ่านเพราะ auth — ล็อกอิน provider นั้นในเครื่องก่อน (GitHub: `gh auth login` · Azure DevOps: git credential manager / PAT ใน keyring)";
  if (/not found|does not exist|repository .* not found/i.test(s))
    return "ไม่เจอ repo ตาม URL นี้ — เช็คว่าพิมพ์ถูกและมีสิทธิ์เข้าถึง";
  return s || "clone ไม่สำเร็จ (git ไม่ได้บอกเหตุผล)";
}

/** คำสั่ง git (หลัง clone) ที่ตัดทางไม่ให้งานถูก push กลับต้นทาง.
 *  รับชื่อ default branch มาตรง ๆ เพราะ clone อาจได้ `master`/`develop` ไม่ใช่ `main`. */
export function remoteRewirePlan(defaultBranch: string): string[][] {
  const br = defaultBranch || "main";
  return [
    // rename ไม่ใช่ remove — เก็บที่มาไว้ให้คนอ่านทีหลังรู้ว่า clone มาจากไหน (fetch ยังได้)
    ["remote", "rename", "origin", "upstream"],
    ["remote", "set-url", "--push", "upstream", CLONE_SOURCE_NO_PUSH],
    // ⛔ rename ทำให้ branch.<br>.remote ชี้ upstream → `git push` เปล่า ๆ จะยิงขึ้นของคนอื่น
    ["config", "--unset", `branch.${br}.remote`],
  ];
}

export interface CloneOutcome {
  ok: boolean;
  /** default branch ที่ clone มาได้ (ใช้โชว์ + ใช้ rewire) */
  branch?: string;
  upstream?: string;
  error?: string;
}

/** clone `url` ลง `dest` แล้วตัดทาง push กลับต้นทางทันที (rewire ก่อน return เสมอ).
 *
 *  ⛔ `GIT_TERMINAL_PROMPT=0` + `ssh -oBatchMode=yes` ไม่ใช่ของประดับ: ถ้า repo เป็น
 *  private และเครื่องยังไม่ได้ล็อกอิน git จะ **นั่งรอ username ตลอดกาล** — เรียกจาก
 *  extension host คือค้างเงียบ ๆ ไม่มีใครเห็น prompt. บังคับให้ล้มเร็วแล้วบอกเหตุผลดีกว่า. */
export function cloneRepoInto(url: string, dest: string): CloneOutcome {
  const info = parseRepoUrl(url);
  if (!info.valid) return { ok: false, error: info.reason ?? "URL ใช้ไม่ได้" };
  if (fs.existsSync(dest)) return { ok: false, error: `มีโฟลเดอร์ '${dest}' อยู่แล้ว` };
  try {
    cp.execFileSync("git", buildCloneArgs(url, dest), {
      timeout: 600000, // repo ใหญ่ + เน็ตช้า — 10 นาที
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
      },
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    // git ลบโฟลเดอร์ตัวเองเมื่อ clone ล้ม แต่ถ้าเหลือซากว่างไว้ก็เก็บให้ — ไม่งั้นกดใหม่
    // จะเจอ "มีโฟลเดอร์อยู่แล้ว" ทั้งที่ยังไม่มีอะไรเลย
    try {
      if (fs.existsSync(dest) && fs.readdirSync(dest).length === 0) fs.rmdirSync(dest);
    } catch {
      /* best-effort */
    }
    return { ok: false, error: cloneErrorHint(String(err.stderr ?? "") || (err.message ?? "")) };
  }
  let branch = "main";
  try {
    branch =
      cp
        .execFileSync("git", ["-C", dest, "symbolic-ref", "--short", "HEAD"], { timeout: 5000 })
        .toString()
        .trim() || "main";
  } catch {
    /* detached/empty repo — "main" เป็นค่าที่ปลอดภัยที่สุดสำหรับ --unset */
  }
  for (const args of remoteRewirePlan(branch)) {
    try {
      cp.execFileSync("git", ["-C", dest, ...args], { timeout: 5000, stdio: "ignore" });
    } catch {
      /* --unset ที่ไม่มีคีย์ = exit 5 ซึ่งถือว่าสำเร็จแล้ว (ไม่มีอะไรต้องตัด) */
    }
  }
  // ⛔ พิสูจน์ว่า "ไม่มี origin" จริง — engine ตัดสินจากตรงนี้ว่าจะสร้าง repo ของเราเอง
  //    ถ้ายังเหลือ origin อยู่ งานจะถูก push ขึ้น repo ต้นทาง ซึ่งเป็นสิ่งที่ห้ามเด็ดขาด
  try {
    cp.execFileSync("git", ["-C", dest, "remote", "get-url", "origin"], { stdio: "ignore" });
    return { ok: false, error: "ตัด remote ต้นทางไม่สำเร็จ — ยกเลิกไว้ก่อน (ยัง push ขึ้นต้นทางได้อยู่)" };
  } catch {
    /* ไม่มี origin = ถูกต้อง */
  }
  return { ok: true, branch, upstream: url };
}
