import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// ⛔⛔ ทำไมต้องรันสคริปต์จริง ไม่ใช่ grep ข้อความ: ฟีเจอร์นี้คือ "ภาพต้องขึ้นจริงในพาเนล" — โค้ดที่มี
//   บรรทัดครบทุกบรรทัดแต่ไม่เคยวาด <img> จะผ่าน assertion แบบ contain ทั้งหมด (บทเรียนเดียวกับ
//   orchestrator.namemodal.test.ts ที่ `_nmNameTouched=!!def` ผ่านทุก contain แต่ไม่เคยทำงาน)
const SRC = fs.readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
function clientScript(): string {
  const start = SRC.lastIndexOf("<script>");
  const end = SRC.lastIndexOf("</script>");
  return SRC.slice(start + "<script>".length, end);
}

interface Stub {
  innerHTML: string;
  textContent: string;
  [k: string]: unknown;
}
interface Harness {
  el: (id: string) => Stub;
  /** node ที่ถูกขอผ่าน querySelector(sel) — ใช้ตรวจว่า .pbody ถูกวาดอะไรลงไป */
  sel: (s: string) => Stub;
  posted: { type: string; [k: string]: unknown }[];
  send: (m: Record<string, unknown>) => void;
}

function runClient(): Harness {
  const els = new Map<string, Stub>();
  const sels = new Map<string, Stub>();
  const mk = (): Stub =>
    ({
      id: "",
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
      hasAttribute: () => false,
      closest: () => null,
      // คืน node เดิมต่อ selector เพื่อให้ตรวจสิ่งที่ถูกวาดลง .pbody ได้จริง
      querySelector: (s: string) => {
        if (!sels.has(s)) sels.set(s, mk());
        return sels.get(s) as Stub;
      },
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    }) as unknown as Stub;
  const getEl = (id: string): Stub => {
    if (!els.has(id)) els.set(id, mk());
    return els.get(id) as Stub;
  };
  const document = {
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => mk(),
    addEventListener() {},
    body: mk(),
  };
  const posted: { type: string; [k: string]: unknown }[] = [];
  let onmsg: ((e: { data: unknown }) => void) | null = null;
  const win = {
    addEventListener(t: string, f: (e: { data: unknown }) => void) {
      if (t === "message") onmsg = f;
    },
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
  )(document, win, api, (f: () => void) => 0, () => {}, () => 0);
  return {
    el: getEl,
    sel: (s) => {
      if (!sels.has(s)) sels.set(s, mk());
      return sels.get(s) as Stub;
    },
    posted,
    send: (m) => onmsg?.({ data: m }),
  };
}

const SHOT = ".orches-shots/sprint-1/web-shell/login.png";
/** โครงจริงแบบที่ host ส่งมา: .orches-shots มาก่อน docs (dir เรียงก่อน file) */
function detailMsg(withPlan: boolean): Record<string, unknown> {
  const docs = {
    name: "docs",
    rel: "docs",
    kind: "dir",
    children: withPlan ? [{ name: "plan.md", rel: "docs/plan.md", kind: "file" }] : [],
  };
  return {
    type: "screen_detail",
    title: "proj",
    subtitle: "/x/proj",
    readme: null,
    tree: [
      {
        name: ".orches-shots",
        rel: ".orches-shots",
        kind: "dir",
        children: [
          {
            name: "sprint-1",
            rel: ".orches-shots/sprint-1",
            kind: "dir",
            children: [
              {
                name: "web-shell",
                rel: ".orches-shots/sprint-1/web-shell",
                kind: "dir",
                children: [{ name: "login.png", rel: SHOT, kind: "file" }],
              },
            ],
          },
        ],
      },
      ...(withPlan ? [docs] : []),
    ],
  };
}

test("ทรีแสดง .orches-shots ตามโครงจริง และไฟล์รูปใช้ไอคอนรูป", () => {
  const h = runClient();
  h.send(detailMsg(true));
  const html = h.el("content").innerHTML;
  expect(html).toContain(".orches-shots");
  expect(html).toContain('data-dir=".orches-shots"');
  // โฟลเดอร์ปิดอยู่ ⇒ ยังไม่เห็นไฟล์ข้างใน (ทรีจริงต้องกดเข้าไป ไม่ใช่แบนทุกอย่าง)
  expect(html).not.toContain("login.png");
});

test("⭐ เลือกไฟล์รูป → พาเนลขวาวาด <img> จริง (ไม่ใช่ข้อความ/ว่าง)", () => {
  const h = runClient();
  h.send(detailMsg(false)); // ไม่มี plan.md ⇒ ไฟล์แรกของทรีคือรูป → ถูกเลือกอัตโนมัติ
  // ต้องขอไฟล์ที่เลือกจาก host ด้วย rel จริง (ไม่ใช่ path ที่ประดิษฐ์เอง)
  const req = h.posted.filter((p) => p.type === "open_doc").pop();
  expect(req?.rel).toBe(SHOT);
  // host ตอบเป็น data URI (ไม่ใช่ html)
  h.send({ type: "doc_html", rel: SHOT, imgSrc: "data:image/png;base64,AAA" });
  const body = h.sel(".pbody").innerHTML;
  expect(body).toContain('<img src="data:image/png;base64,AAA"');
  expect(body).toContain('class="shot"');
});

test("ภาพใหญ่เกินเพดาน / อ่านไม่ได้ = ขึ้นข้อความ ไม่ใช่ <img> เปล่า", () => {
  const h = runClient();
  h.send(detailMsg(false));
  h.send({ type: "doc_html", rel: SHOT, error: "อ่านไฟล์รูปไม่ได้" });
  const body = h.sel(".pbody").innerHTML;
  expect(body).toContain("อ่านไฟล์รูปไม่ได้");
  expect(body).not.toContain("<img");
});

test("README ที่อยู่ในทรีแล้วต้องไม่ถูกเติมซ้ำเป็นแถวที่สอง", () => {
  const h = runClient();
  const m = detailMsg(true);
  m.readme = { rel: "README.md", label: "README" };
  (m.tree as Record<string, unknown>[]).push({
    name: "README.md",
    rel: "README.md",
    kind: "file",
  });
  h.send(m);
  const html = h.el("content").innerHTML;
  expect(html.split('data-file="README.md"').length - 1).toBe(1);
});
