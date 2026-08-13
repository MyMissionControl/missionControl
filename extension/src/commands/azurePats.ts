// ดึง "วันหมดอายุจริง" ของ PAT จาก Azure DevOps — เพื่อไม่ให้ user ต้องมานั่งกรอกวันที่เอง
//
// ⛔⛔ ข้อเท็จจริงที่ทำให้ไฟล์นี้หน้าตาแบบนี้ (ยืนยันกับของจริงบนเครื่องนี้ 2026-08-13):
//   1) เอา **PAT ไปถามอายุของ PAT ไม่ได้** — เอกสาร MS: "the PAT Management Lifecycle APIs
//      support only Microsoft Entra tokens" (หน้า reference ของ /tokens/pats/list มีบล็อก
//      Security ที่เขียนว่า basic/PAT ไว้ — นั่นเป็น boilerplate ที่ generate อัตโนมัติ ห้ามเชื่อ)
//   2) แต่ **Entra token จาก `az` ใช้ได้** — ยิง GET .../_apis/tokens/pats ด้วย Bearer จาก
//      `az account get-access-token --resource <AZDO>` ได้ HTTP 200 จริงบน org ของ user
//   3) response ไม่คืนค่า token (`token: null`) ⇒ **จับคู่ว่า PAT ที่เก็บไว้เป็นตัวไหนไม่ได้**
//      จึงคืนรายการมาให้ user เลือกชื่อ (1 คลิก) แทนการเดา — และถ้ามี active ตัวเดียวก็เลือกให้เลย
//
// ทุกทางล้ม = คืน ok:false พร้อมเหตุผล แล้วให้ UI ถอยไปใช้ช่องกรอกวันที่เหมือนเดิม
// (ฟีเจอร์นี้เป็นของแถม ห้ามทำให้การใส่ PAT ล้มเพราะ az ไม่มี/ไม่ได้ล็อกอิน)
import * as cp from "node:child_process";

/** resource id ของ Azure DevOps ใน Entra — ค่าคงที่ของ Microsoft ทุก tenant ใช้ตัวเดียวกัน */
export const AZDO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export interface AzPat {
  name: string;
  /** YYYY-MM-DD (ตัดเวลาออก — ที่ UI ใช้คือวัน) */
  expiresAt: string;
  scope: string;
}
export interface AzPatList {
  ok: boolean;
  pats: AzPat[];
  reason?: string;
}

/** `2026-11-30T04:04:38.5233333Z` → `2026-11-30` · คืน "" ถ้าอ่านไม่ออก (ไม่เดา) */
export function dayOf(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? "").trim());
  return m ? m[1] : "";
}

/** แปลง response ของ /_apis/tokens/pats → รายการที่ UI ใช้ได้ — **pure** เทสได้ไม่ต้องต่อเน็ต.
 *
 *  ⛔ เรียงตามวันหมดอายุจากไกลไปใกล้: ตัวที่เพิ่งสร้าง (อายุยาวสุด) มักเป็นตัวที่ user กำลังวางอยู่
 *  ⛔ ทิ้งตัวที่อ่านวันไม่ออก แทนที่จะใส่ค่าว่างเข้า UI (จะกลายเป็น "ไม่รู้วันหมดอายุ" แบบเงียบ ๆ) */
export function parsePatList(body: unknown): AzPat[] {
  const raw = (body as { patTokens?: unknown })?.patTokens;
  if (!Array.isArray(raw)) return [];
  const out: AzPat[] = [];
  for (const t of raw) {
    const o = t as { displayName?: unknown; validTo?: unknown; scope?: unknown };
    const day = dayOf(String(o?.validTo ?? ""));
    if (!day) continue;
    out.push({
      name: typeof o?.displayName === "string" && o.displayName ? o.displayName : "(ไม่มีชื่อ)",
      expiresAt: day,
      scope: typeof o?.scope === "string" ? o.scope : "",
    });
  }
  return out.sort((a, b) => (a.expiresAt < b.expiresAt ? 1 : a.expiresAt > b.expiresAt ? -1 : 0));
}

/** org ที่ปลอดภัยจะเอาไปต่อเป็น URL — whitelist (ค่านี้มาจาก URL ที่ user วางใน webview) */
export function isSafeOrg(org: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(org ?? "");
}

/** Entra access token จาก az CLI. ⛔ ห้าม log ค่า และห้ามส่งออกจาก host เด็ดขาด */
function entraToken(): string | null {
  try {
    const out = cp.execFileSync(
      "az",
      ["account", "get-access-token", "--resource", AZDO_RESOURCE, "--query", "accessToken", "-o", "tsv"],
      { timeout: 20000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const t = out.toString().trim();
    return t || null;
  } catch {
    return null; // az ไม่มี / ยังไม่ได้ az login / tenant ไม่ยอม
  }
}

/** รายการ PAT ของ user ใน org นี้ พร้อมวันหมดอายุจริง */
export async function listAzurePats(org: string): Promise<AzPatList> {
  if (!isSafeOrg(org)) return { ok: false, pats: [], reason: "ชื่อ org ไม่ถูกต้อง" };
  const token = entraToken();
  if (!token)
    return {
      ok: false,
      pats: [],
      reason: "ดึงวันหมดอายุอัตโนมัติไม่ได้ (ต้องมี az CLI + az login ใน tenant เดียวกัน)",
    };
  const url =
    `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/tokens/pats` +
    `?api-version=7.1-preview.1&displayFilterOption=active&$top=100`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, pats: [], reason: "Entra token ไม่มีสิทธิ์อ่านรายการ PAT ของ org นี้" };
    if (!res.ok) return { ok: false, pats: [], reason: `Azure ตอบ HTTP ${res.status}` };
    return { ok: true, pats: parsePatList(await res.json()) };
  } catch (e) {
    return { ok: false, pats: [], reason: `ต่อ Azure DevOps ไม่ได้: ${(e as Error).message}` };
  }
}
