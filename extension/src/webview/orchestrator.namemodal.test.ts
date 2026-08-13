import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ⛔⛔ ทำไมต้อง **รันสคริปต์จริง** ไม่ใช่ match string (orchestrator.client.test.ts ทำอยู่แล้ว):
//   บั๊กที่แก้ 2026-08-13 คือ `_nmNameTouched=!!def` — โค้ดเติมชื่อจาก URL อยู่ครบทุกบรรทัด
//   จึงผ่านทุก assertion แบบ contain แต่ **ไม่เคยทำงานเลย** เพราะ modal เปิดมาพร้อมชื่อที่ระบบ
//   เสนอทุกครั้ง → เงื่อนไข !_nmNameTouched เป็น false ตลอด. ต้องขับ nmResult ของจริงเท่านั้นจึงจับได้.
const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");

function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  return SRC.slice(start + "<script>".length, end);
}

interface Stub {
  id: string;
  value: string;
  textContent: string;
  className: string;
  disabled: boolean;
  style: Record<string, string>;
  innerHTML: string;
  [k: string]: unknown;
}
interface Harness {
  el: (id: string) => Stub;
  posted: { type: string; [k: string]: unknown }[];
  send: (m: Record<string, unknown>) => void;
  /** รัน callback ของ setTimeout ที่ค้างอยู่ (nmSchedule debounce 400ms) */
  flush: () => void;
}

/** DOM ปลอมเท่าที่สคริปต์ต้องใช้ตอนโหลด — พอให้ IIFE ทั้งก้อนรันจบและขับ message ได้ */
function runClient(): Harness {
  const els = new Map<string, Stub>();
  const mk = (id: string): Stub =>
    ({
      id,
      value: "",
      textContent: "",
      className: "",
      disabled: false,
      innerHTML: "",
      style: {} as Record<string, string>,
      dataset: {},
      children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {},
      removeEventListener() {},
      appendChild() {},
      insertBefore() {},
      remove() {},
      focus() {},
      select() {},
      blur() {},
      scrollIntoView() {},
      setAttribute() {},
      removeAttribute() {},
      getAttribute: () => null,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    }) as unknown as Stub;
  const getEl = (id: string): Stub => {
    if (!els.has(id)) els.set(id, mk(id));
    return els.get(id) as Stub;
  };
  const document = {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t: string) => mk(t),
    addEventListener() {},
    body: mk("body"),
  };
  const posted: { type: string; [k: string]: unknown }[] = [];
  let onmsg: ((e: { data: unknown }) => void) | null = null;
  const win = {
    addEventListener(t: string, f: (e: { data: unknown }) => void) {
      if (t === "message") onmsg = f;
    },
  };
  const timers: (() => void)[] = [];
  const fakeSetTimeout = (f: () => void) => {
    timers.push(f);
    return timers.length;
  };
  const api = () => ({ postMessage: (m: { type: string }) => posted.push(m) });
  // eslint-disable-next-line no-new-func
  new Function(
    "document",
    "window",
    "acquireVsCodeApi",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    clientScript(),
  )(document, win, api, fakeSetTimeout, () => {}, () => 0);
  return {
    el: getEl,
    posted,
    send: (m) => onmsg?.({ data: m }),
    flush: () => {
      const q = timers.splice(0);
      for (const f of q) f();
    },
  };
}

const OK = { valid: true, localTaken: false, githubChecked: true, githubTaken: false };
const AZ_HTTPS = {
  valid: true,
  provider: "azure-devops",
  providerLabel: "Azure DevOps",
  repo: "TexploreFITs",
};

test("สคริปต์ทั้งก้อนรันได้บน DOM ปลอม (พิสูจน์ว่า harness นี้ขับของจริง)", () => {
  const h = runClient();
  expect(h.posted.some((p) => p.type === "ready")).toBe(true);
});

test("⛔ บั๊กที่แก้: แปะ URL แล้วต้องเติมชื่อ repo ทับชื่อที่ระบบเสนอ", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  expect(h.el("nm-input").value).toBe("my-project");
  h.send({ type: "name_result", name: "my-project", check: OK, url: AZ_HTTPS });
  expect(h.el("nm-input").value).toBe("TexploreFITs");
  // และต้องยิงเช็คชื่อใหม่ทันที ไม่ใช่ปล่อยให้ปุ่มค้างสถานะของชื่อเก่า
  h.flush();
  const last = h.posted.filter((p) => p.type === "check_name").pop();
  expect(last?.name).toBe("TexploreFITs");
});

test("urlSuggest (ชื่อที่ bump แล้วว่างจริง) ชนะชื่อ repo ดิบ", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  h.send({
    type: "name_result",
    name: "my-project",
    check: OK,
    url: AZ_HTTPS,
    urlSuggest: "TexploreFITs-v2",
  });
  expect(h.el("nm-input").value).toBe("TexploreFITs-v2");
});

test("user พิมพ์ชื่อเองแล้ว = URL ห้ามทับ", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  h.el("nm-input").value = "ชื่อที่ผมตั้งเอง".replace(/[^\w-]/g, "x"); // ผ่าน sanitize ได้
  // จำลองการพิมพ์: handler input ตัวจริงถูกผูกไว้ตอนโหลด แต่ stub ไม่เก็บ listener →
  // ใช้เส้นทางที่ผูกไว้จริงแทน: เปิด modal ใหม่พร้อม nameFromUser
  h.send({ type: "open_namemodal", default: "xxxxxxxxxxxxxxx", url: "https://x/y/z", nameFromUser: true });
  h.send({ type: "name_result", name: "xxxxxxxxxxxxxxx", check: OK, url: AZ_HTTPS });
  expect(h.el("nm-input").value).toBe("xxxxxxxxxxxxxxx");
});

test("URL ใช้ไม่ได้ = ไม่แตะช่องชื่อ + ปุ่มถัดไปติด", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  h.send({
    type: "name_result",
    name: "my-project",
    check: OK,
    url: { valid: false, reason: "รูปแบบ URL ไม่ถูก" },
  });
  expect(h.el("nm-input").value).toBe("my-project");
  expect(h.el("nm-ok").disabled).toBe(true);
  expect(h.el("nm-urlstatus").textContent).toBe("รูปแบบ URL ไม่ถูก");
});

test("ไม่ใส่ URL = สร้างเปล่าได้เหมือนเดิม (ปุ่มไม่ติด)", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  h.send({ type: "name_result", name: "my-project", check: OK });
  expect(h.el("nm-input").value).toBe("my-project");
  expect(h.el("nm-ok").disabled).toBe(false);
});

test("ชื่อที่เติมจาก URL ถ้าซ้ำ → ปุ่มติด + บอกเหตุผล (ไม่เงียบ)", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  const taken = {
    type: "name_result",
    name: "TexploreFITs",
    check: { valid: true, localTaken: true, githubChecked: true, githubTaken: false },
    url: AZ_HTTPS,
  };
  // รอบแรก = เติมชื่อจาก URL แล้วยิงเช็คใหม่ (status ยังเป็น "กำลังเช็ค…")
  h.send(taken);
  expect(h.el("nm-input").value).toBe("TexploreFITs");
  expect(h.el("nm-ok").disabled).toBe(true);
  // รอบสอง = ชื่อในช่องตรงกับที่เสนอแล้ว → ต้องเห็น verdict จริง
  h.send(taken);
  expect(h.el("nm-status").textContent).toContain("ซ้ำ");
  expect(h.el("nm-ok").disabled).toBe(true);
});

test("⛔ กันลูป: suggest แกว่งไปมาต้องหยุดเอง ไม่วน postMessage ไม่จบ", () => {
  const h = runClient();
  h.send({ type: "open_namemodal", default: "my-project" });
  for (let i = 0; i < 12; i++) {
    h.send({
      type: "name_result",
      name: "x",
      check: OK,
      url: AZ_HTTPS,
      urlSuggest: i % 2 ? "A" : "B", // แกว่งสองค่าสลับกัน
    });
    h.flush();
  }
  expect(h.posted.filter((p) => p.type === "check_name").length).toBeLessThanOrEqual(5);
});
