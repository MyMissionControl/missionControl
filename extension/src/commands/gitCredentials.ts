// Git credentials ที่เครื่องนี้มี — โซน "Git" ของหน้า Connections.
//
// เก็บใน `~/.git-credentials` (helper `store` ต่อ host) ไม่ใช่ใน MC: กฎที่ user ตั้งไว้คือ
// **ไม่เก็บ secret ใน MC** — MC แค่พาไปวางในที่ที่ git อ่านเองอยู่แล้ว ทำให้ทั้ง clone จากปุ่ม,
// worker ใน tmux, และ git บน terminal ใช้ credential ตัวเดียวกันหมด.
//
// ⛔ กฎเหล็ก 2 ข้อของไฟล์นี้:
//   1) **ห้ามส่งค่า secret เข้า webview** — model ที่ list ออกมามีแค่ host + user (เหมือนที่
//      accounts.ts ทำกับ token) · secretOf() มีไว้ให้ host ใช้ทดสอบ PAT เท่านั้น
//   2) หลาย organization ใช้ host เดียวกัน (`dev.azure.com`) แล้วแยกกันด้วย **username = ชื่อ org**
//      → ทุกการเขียนต้องแตะแค่คู่ (host, user) นั้น. เคยพลาดจริงในสคริปต์ setup: ลบทุกบรรทัด
//      ของ host ก่อนเขียนใหม่ = ล้าง PAT ของ org อื่นทิ้งเงียบ ๆ
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CredRow {
  host: string;
  user: string;
}

export const CRED_FILE = path.join(os.homedir(), ".git-credentials");

/** host ที่ปลอดภัยจะเอาไปประกอบเป็น URL/คีย์ config — whitelist ล้วน */
export function isSafeCredHost(host: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,200}$/.test(host ?? "");
}

/** username (= ชื่อ org สำหรับ Azure DevOps). ⛔ ต้องกัน `\n` เพราะค่านี้ถูกเขียนลงไฟล์
 *  ที่ "1 บรรทัด = 1 credential" — ขึ้นบรรทัดใหม่ได้ = แทรก credential ปลอมได้ */
export function isSafeCredUser(user: string): boolean {
  return /^[A-Za-z0-9._@+-]{1,200}$/.test(user ?? "");
}

export function providerLabelForHost(host: string): string {
  const h = (host ?? "").toLowerCase();
  if (h === "dev.azure.com" || h === "ssh.dev.azure.com" || h.endsWith(".visualstudio.com"))
    return "Azure DevOps";
  if (h === "github.com" || h.endsWith(".github.com")) return "GitHub";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "GitLab";
  if (h === "bitbucket.org" || h.startsWith("bitbucket.")) return "Bitbucket";
  return host;
}

/** (host, user) ที่ต้องเก็บ credential ให้ URL นี้ — ให้ user วาง **URL ที่ copy มาจากปุ่ม Clone**
 *  แทนการกรอก host/org แยกช่อง (พิมพ์ผิดยากกว่า และเป็นของที่เขามีอยู่ในมือแล้ว).
 *
 *  ⛔ Azure DevOps มี 2 รูปแบบและ **ต้องได้ org เท่ากันทั้งคู่**: `https://<org>@dev.azure.com/<org>/…`
 *  (ปุ่ม Clone ใส่ org มาเป็น username) และแบบไม่มี `<org>@` ซึ่ง org อยู่ path แรก. ถ้าเก็บ
 *  credential ไว้คนละ username กับที่ URL ระบุ git จะหาไม่เจอ = auth ล้มเหมือนไม่ได้ใส่ PAT เลย.
 *  แบบเก่า `<org>.visualstudio.com` org อยู่ใน host. คืน null เมื่ออ่านไม่ออก — ไม่เดา. */
export function credTargetFromUrl(url: string): CredRow | null {
  const raw = (url ?? "").trim();
  if (!/^https:\/\//i.test(raw)) return null;
  const rest = raw.slice("https://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const hostPart = rest.slice(0, slash);
  const at = hostPart.lastIndexOf("@");
  const inUrlUser = at >= 0 ? hostPart.slice(0, at) : "";
  const host = (at >= 0 ? hostPart.slice(at + 1) : hostPart).replace(/:\d+$/, "");
  if (!isSafeCredHost(host)) return null;
  const segments = rest
    .slice(slash + 1)
    .split("/")
    .filter(Boolean);
  if (!segments.length) return null;
  let user = inUrlUser;
  if (!user) {
    const h = host.toLowerCase();
    // org อยู่ใน host สำหรับโดเมนเก่าของ Azure — path แรกคือชื่อ *project* ไม่ใช่ org
    user = h.endsWith(".visualstudio.com") ? host.slice(0, host.indexOf(".")) : segments[0];
  }
  user = dec(user);
  if (!isSafeCredUser(user)) return null;
  return { host, user };
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // ไม่ใช่ percent-encoding ที่ถูกต้อง → ใช้ค่าเดิมดีกว่าโยนทิ้ง
  }
}

/** `https://user:secret@host` → {user, host}. คืนเฉพาะบรรทัดที่อ่านออก — ไฟล์นี้คนแก้มือได้
 *  จึงต้องทนบรรทัดเสียโดยไม่ล้มทั้งไฟล์. ⛔ ไม่คืน secret ออกไปไหนเลย */
export function parseCredentialLines(raw: string): CredRow[] {
  const out: CredRow[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = /^https?:\/\/([^@/]*)@([^/]+)\/?$/.exec(s);
    if (!m) continue;
    const at = m[1];
    const colon = at.indexOf(":");
    const user = dec(colon >= 0 ? at.slice(0, colon) : at);
    const host = m[2];
    if (!user || !host) continue;
    out.push({ host, user });
  }
  return out;
}

/** secret ของคู่ (host, user) — **host-side เท่านั้น** (ใช้ทดสอบ PAT) ห้ามส่งต่อเข้า webview */
export function secretOf(raw: string, host: string, user: string): string | null {
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const s = line.trim();
    const m = /^https?:\/\/([^@/]*)@([^/]+)\/?$/.exec(s);
    if (!m || m[2] !== host) continue;
    const at = m[1];
    const colon = at.indexOf(":");
    if (colon < 0) continue;
    if (dec(at.slice(0, colon)) !== user) continue;
    return dec(at.slice(colon + 1));
  }
  return null;
}

function samePair(line: string, host: string, user: string): boolean {
  const m = /^https?:\/\/([^@/]*)@([^/]+)\/?$/.exec(line.trim());
  if (!m || m[2] !== host) return false;
  const at = m[1];
  const colon = at.indexOf(":");
  return dec(colon >= 0 ? at.slice(0, colon) : at) === user;
}

function joinLines(lines: string[]): string {
  const kept = lines.filter((l) => l.trim() !== "");
  return kept.length ? kept.join("\n") + "\n" : "";
}

/** เขียน/ทับ credential ของคู่ (host, user) — บรรทัดอื่นไม่ถูกแตะ.
 *  encode ทั้ง user และ secret: PAT ที่มี `@` หรือ `:` จะทำให้ git อ่าน host เพี้ยนถ้าเขียนดิบ */
export function upsertCredentialLine(raw: string, host: string, user: string, secret: string): string {
  const kept = (raw ?? "").split(/\r?\n/).filter((l) => l.trim() !== "" && !samePair(l, host, user));
  kept.push(`https://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@${host}`);
  return joinLines(kept);
}

export function removeCredentialLine(raw: string, host: string, user: string): string {
  return joinLines((raw ?? "").split(/\r?\n/).filter((l) => !samePair(l, host, user)));
}

// ── วันหมดอายุของ PAT ────────────────────────────────────────────────────────
//
// ⛔ ทำไมต้องให้ user กรอกเอง ไม่ดึงจาก Azure: PAT lifecycle API (`_apis/tokens/pats`) รับ
//    **Entra/AAD access token เท่านั้น** — เอา PAT ไปถามอายุของ PAT ตัวเองไม่ได้ (401). สิ่งที่
//    PAT ถามได้คือ "ยังใช้ได้ไหม" (testGitCredential ยิง `_apis/projects` → 401/203 = ตาย) ซึ่ง
//    ตอบได้เฉพาะ **หลัง** หมดอายุ. หน้าจอที่บอกได้แค่ตอนสายไปแล้ว = เตือนล่วงหน้าไม่ได้ จึงเก็บ
//    วันที่ที่หน้าเว็บ Azure โชว์ตอนสร้าง token ไว้เอง แล้วนับถอยหลังจากมันตรง ๆ
//
// ⛔ เก็บ **แยกไฟล์จาก ~/.git-credentials** โดยเจตนา: ไฟล์นั้นมีรูปแบบ "1 บรรทัด = 1 credential"
//    ที่ git เป็นเจ้าของ — แทรก metadata ลงไปคือทำให้ git อ่านเพี้ยน. ไฟล์นี้ **ไม่มี secret เลย**
//    (host + org + วันที่) จึงไม่ต้อง 0600 แต่ก็ให้ไว้เพราะไม่มีเหตุให้คนอื่นอ่าน
export const PAT_META_FILE = path.join(os.homedir(), ".claude", ".mc-git-pat.json");

/** YYYY-MM-DD ที่เป็นวันจริง (ไม่ใช่ 2026-13-40) */
export function isValidExpiryDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** คีย์ของ metadata = คู่ (host, user) เดียวกับที่ ~/.git-credentials แยกกัน */
export function patMetaKey(host: string, user: string): string {
  return `${host} ${user}`;
}

export type PatExpiryLevel = "unknown" | "ok" | "soon" | "expired";
export interface PatExpiry {
  level: PatExpiryLevel;
  /** วันที่เหลือ (ติดลบ = เลยมาแล้ว) — null เมื่อไม่รู้วันหมดอายุ */
  days: number | null;
  text: string;
}

/** เตือนล่วงหน้ากี่วันจึงนับเป็น "ใกล้หมด" — 14 วันพอให้ไปสร้าง PAT ใหม่โดยไม่ต้องรีบ */
export const PAT_SOON_DAYS = 14;

/** สถานะวันหมดอายุ — **pure** (รับ now เข้ามา) เพื่อเทสได้ไม่ต้องอิงเวลาจริง.
 *  ⛔ นับเป็น "วันตามปฏิทิน UTC" ไม่ใช่ (ts2-ts1)/86400e3: PAT หมดอายุ "สิ้นวันนั้น" และการ
 *  ปัดเศษชั่วโมงทำให้วันสุดท้ายกลายเป็น "หมดอายุแล้ว" ตอนบ่าย ซึ่งผิดและกวนคน */
export function patExpiryState(expiresAt: string | null | undefined, nowMs: number): PatExpiry {
  if (!expiresAt || !isValidExpiryDate(expiresAt))
    return { level: "unknown", days: null, text: "ไม่รู้วันหมดอายุ" };
  const [y, mo, d] = expiresAt.split("-").map(Number);
  const end = Date.UTC(y, mo - 1, d);
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((end - today) / 86400000);
  if (days < 0) return { level: "expired", days, text: `หมดอายุแล้ว (${expiresAt})` };
  if (days === 0) return { level: "soon", days, text: `หมดอายุวันนี้ (${expiresAt})` };
  if (days <= PAT_SOON_DAYS)
    return { level: "soon", days, text: `อีก ${days} วันหมดอายุ (${expiresAt})` };
  return { level: "ok", days, text: `หมดอายุ ${expiresAt} (อีก ${days} วัน)` };
}

/** map คีย์ → วันหมดอายุ. ไฟล์เสีย/ไม่มี = ว่าง (ไม่ล้ม — metadata หายไม่ใช่เหตุให้หน้าจอพัง) */
export function readPatMeta(): Record<string, string> {
  let raw = "";
  try {
    raw = fs.readFileSync(PAT_META_FILE, "utf8");
  } catch {
    return {};
  }
  try {
    const d = JSON.parse(raw) as { pats?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d?.pats ?? {}))
      if (typeof v === "string" && isValidExpiryDate(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** ตั้ง/ลบวันหมดอายุของคู่ (host, user) — คู่อื่นไม่ถูกแตะ (บทเรียนเดียวกับ upsertCredentialLine) */
export function setPatExpiry(host: string, user: string, expiresAt: string | null): void {
  const meta = readPatMeta();
  const key = patMetaKey(host, user);
  if (expiresAt && isValidExpiryDate(expiresAt)) meta[key] = expiresAt;
  else delete meta[key];
  try {
    fs.mkdirSync(path.dirname(PAT_META_FILE), { recursive: true });
    fs.writeFileSync(PAT_META_FILE, JSON.stringify({ pats: meta }, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* เขียนไม่ได้ = เสียแค่การเตือนล่วงหน้า ไม่ควรทำให้การใส่ PAT ล้ม */
  }
}

// ── ฝั่งที่แตะดิสก์/เครือข่าย ────────────────────────────────────────────────

function readFileSafe(): string {
  try {
    return fs.readFileSync(CRED_FILE, "utf8");
  } catch {
    return "";
  }
}

function writeCredFile(content: string): void {
  fs.writeFileSync(CRED_FILE, content, { mode: 0o600 });
  try {
    fs.chmodSync(CRED_FILE, 0o600); // ไฟล์ที่มีอยู่ก่อนอาจสิทธิ์หลวม — บีบทุกครั้งที่เขียน
  } catch {
    /* best-effort */
  }
}

function gitConfigGlobal(args: string[]): string {
  try {
    return cp.execFileSync("git", ["config", "--global", ...args], { timeout: 5000 }).toString();
  } catch {
    return "";
  }
}

/** host ที่มี credential helper ตั้งไว้แล้ว (คีย์เป็นแบบ **ต่อ host** — `credential.helper`
 *  เปล่า ๆ จะคืนค่าว่างและทำให้เข้าใจผิดว่า "ไม่มี helper") */
export function helperHosts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of gitConfigGlobal(["--list"]).split(/\r?\n/)) {
    const m = /^credential\.https:\/\/([^.=]+(?:\.[^.=]+)*)\.helper=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (!m[2]) continue; // บรรทัด `=` ว่าง = การรีเซ็ตของ gh ไม่ใช่ helper จริง
    out[m[1]] = m[2];
  }
  return out;
}

export interface GitCredView {
  host: string;
  user: string;
  provider: string;
  /** helper ของ host นี้ถูกตั้งไว้ไหม — ไม่ตั้ง = git ไม่เคยอ่านไฟล์นี้เลย */
  helper: boolean;
  /** วันหมดอายุที่ user บอกไว้ (YYYY-MM-DD) — null = ไม่รู้ */
  expiresAt: string | null;
  expiry: PatExpiry;
}

export function listGitCredentials(nowMs?: number): { rows: GitCredView[]; ghLogin: string | null } {
  const helpers = helperHosts();
  const meta = readPatMeta();
  const now = nowMs ?? Date.now();
  const rows = parseCredentialLines(readFileSafe()).map((r) => {
    const expiresAt = meta[patMetaKey(r.host, r.user)] ?? null;
    return {
      host: r.host,
      user: r.user,
      provider: providerLabelForHost(r.host),
      helper: !!helpers[r.host],
      expiresAt,
      expiry: patExpiryState(expiresAt, now),
    };
  });
  let ghLogin: string | null = null;
  try {
    const out = cp.execFileSync("gh", ["auth", "status"], { timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
    const m = /Logged in to \S+ account (\S+)/.exec(out.toString());
    ghLogin = m ? m[1] : "logged in";
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    const txt = String(err.stdout ?? "") + String(err.stderr ?? "");
    const m = /Logged in to \S+ account (\S+)/.exec(txt);
    ghLogin = m ? m[1] : null; // gh เขียน status ลง stderr ในบางเวอร์ชัน
  }
  return { rows, ghLogin };
}

export function setGitCredential(
  host: string,
  user: string,
  secret: string,
  expiresAt?: string,
): { ok: boolean; error?: string } {
  if (!isSafeCredHost(host)) return { ok: false, error: `host ไม่ถูกต้อง: ${host}` };
  if (!isSafeCredUser(user)) return { ok: false, error: "ชื่อ org/username ใช้ได้เฉพาะ A-Z a-z 0-9 . _ @ + -" };
  if (!secret || /[\r\n]/.test(secret)) return { ok: false, error: "PAT ว่าง หรือมีการขึ้นบรรทัดใหม่" };
  // ⛔ วันที่ผิดรูปแบบ = ปฏิเสธก่อนเขียน PAT ไม่ใช่เขียน PAT แล้วเงียบ ๆ ทิ้งวันที่
  //    (ไม่งั้นได้ credential ที่ใช้ได้แต่หน้าจอบอก "ไม่รู้วันหมดอายุ" ทั้งที่ user กรอกมาแล้ว)
  if (expiresAt !== undefined && expiresAt !== "" && !isValidExpiryDate(expiresAt))
    return { ok: false, error: "วันหมดอายุต้องเป็น YYYY-MM-DD (เช่น 2026-09-30)" };
  try {
    writeCredFile(upsertCredentialLine(readFileSafe(), host, user, secret));
  } catch (e) {
    return { ok: false, error: `เขียน ${CRED_FILE} ไม่ได้: ${(e as Error).message}` };
  }
  if (expiresAt !== undefined) setPatExpiry(host, user, expiresAt || null);
  // ⛔ ไม่มี helper = ไฟล์นี้ไม่ถูกอ่านเลย (อาการ "ใส่ PAT แล้วยัง auth ไม่ผ่าน")
  //    ตั้งแบบ **ต่อ host** เท่านั้น — ห้ามแตะ credential.helper ตัวกลางที่ gh เป็นเจ้าของ
  gitConfigGlobal([`credential.https://${host}.helper`, "store"]);
  return { ok: true };
}

export function removeGitCredential(host: string, user: string): { ok: boolean; error?: string } {
  if (!isSafeCredHost(host) || !isSafeCredUser(user)) return { ok: false, error: "host/user ไม่ถูกต้อง" };
  try {
    writeCredFile(removeCredentialLine(readFileSafe(), host, user));
    setPatExpiry(host, user, null); // ลบ PAT แล้วต้องไม่เหลือวันหมดอายุกำพร้าไว้หลอกรอบหน้า
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** ทดสอบว่า PAT ยังใช้ได้จริง — ไม่ใช่แค่ "มีบรรทัดอยู่ในไฟล์".
 *  Azure DevOps: เรียก REST `_apis/projects` ด้วย basic auth (PAT เป็น password) → 200 = ใช้ได้,
 *  401/203 = PAT ผิด/หมดอายุ. host อื่นไม่มี endpoint กลางให้ยิง → บอกตรง ๆ ว่าเช็คไม่ได้
 *  แทนที่จะเดาว่า "ผ่าน" (vacuous PASS คือสิ่งที่ด่านในระบบนี้เคยพลาดมาแล้ว). */
export async function testGitCredential(
  host: string,
  user: string,
): Promise<{ ok: boolean; text: string }> {
  if (!isSafeCredHost(host) || !isSafeCredUser(user)) return { ok: false, text: "host/user ไม่ถูกต้อง" };
  const secret = secretOf(readFileSafe(), host, user);
  if (!secret) return { ok: false, text: "ไม่เจอ credential ของคู่นี้ในไฟล์" };
  if (providerLabelForHost(host) !== "Azure DevOps")
    return { ok: false, text: `ทดสอบอัตโนมัติได้เฉพาะ Azure DevOps — ${host} ต้องลอง clone ดู` };
  const org = user; // Azure DevOps: ปุ่ม Clone ใส่ชื่อ org มาเป็น username ของ URL
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?api-version=7.0&$top=1`;
  const auth = Buffer.from(`:${secret}`).toString("base64");
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 200) return { ok: true, text: `PAT ใช้ได้ (org ${org})` };
    if (res.status === 401 || res.status === 203)
      return { ok: false, text: "PAT ผิด/หมดอายุ หรือไม่มีสิทธิ์ org นี้ (ต้องมี scope Code:Read)" };
    if (res.status === 404) return { ok: false, text: `ไม่เจอ org '${org}' — ชื่อ org ผิด?` };
    return { ok: false, text: `Azure ตอบ HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, text: `ต่อ Azure DevOps ไม่ได้: ${(e as Error).message}` };
  }
}
