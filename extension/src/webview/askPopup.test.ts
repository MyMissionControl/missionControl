import { expect, test } from "bun:test";

import { renderAskCard, renderAskPopup } from "./askPopup";

const single = {
  session: "09-foreman",
  pane: "%0",
  ask: {
    header: "Tech stack",
    question: "frontend/backend อยากใช้อะไร?",
    multiSelect: false,
    options: [
      { key: 1, label: "Next.js full-stack", description: "App Router เดียวจบ" },
      { key: 2, label: "React + Express", description: "คนละ service" },
    ],
  },
};

const multi = {
  session: "09-foreman",
  pane: "%2",
  ask: {
    header: "ผลไม้",
    question: "ชอบผลไม้อะไรบ้าง",
    multiSelect: true,
    options: [
      { key: 1, label: "มะม่วง", description: "น้ำดอกไม้" },
      { key: 2, label: "ทุเรียน", description: "" },
    ],
  },
};

test("A1 renders every option with its printed digit and description", () => {
  const h = renderAskPopup(single);
  expect(h).toContain("Next.js full-stack");
  expect(h).toContain("App Router เดียวจบ");
  expect(h).toContain("React + Express");
  expect(h).toContain('data-key="2"');
});

test("A2 shows whose question it is and what is being asked", () => {
  const h = renderAskPopup(single);
  expect(h).toContain("09-foreman");
  expect(h).toContain("Tech stack");
  expect(h).toContain("frontend/backend อยากใช้อะไร?");
});

// ⛔⛔ นี่คือบั๊กที่ user รายงาน ("ปุ่ม submit หาย"): ของเดิมเป็น QuickPick ซึ่งส่งได้แค่ "กดเลข"
//   ส่วนกล่อง multiSelect ของ REPL ไม่มีเลขให้ Submit (เป็นแท็บที่ต้องเดินไป) → โค้ดเดิมจึงยอมแพ้
//   แล้วโชว์แค่ "เปิดเพนไปตอบเอง" = ไม่มีปุ่ม Submit ให้กดใน MC เลย
//   กฎที่ล็อกไว้: ปุ่ม Submit ต้องอยู่ใน HTML **เสมอ** ห้ามผูกกับการที่มีคนติ๊กหรือยัง
//   (ปุ่มที่โผล่มาทีหลังคือปุ่มที่ user บอกว่า "หาย")
test("A3 multiSelect always ships a Submit button, disabled until something is ticked", () => {
  const h = renderAskPopup(multi);
  expect(h).toContain('id="submit"');
  expect(h).toContain("Submit");
  expect(h).toContain('type="checkbox"');
  expect(h).toContain("disabled"); // ห้ามส่งกล่องเปล่า แต่ปุ่มยังต้องมองเห็น
});

test("A4 single-select has no checkbox and no Submit (คลิก = ตอบเลย เหมือน REPL)", () => {
  const h = renderAskPopup(single);
  expect(h).not.toContain('type="checkbox"');
  expect(h).not.toContain('id="submit"');
});

test("A5 escapes HTML — a label/description is untrusted agent text", () => {
  const h = renderAskPopup({
    ...single,
    ask: {
      ...single.ask,
      question: "<img src=x onerror=alert(1)>",
      options: [{ key: 1, label: "<script>bad()</script>", description: "a & b" }],
    },
  });
  expect(h).not.toContain("<script>bad()</script>");
  expect(h).not.toContain("<img src=x");
  expect(h).toContain("&lt;script&gt;");
  expect(h).toContain("a &amp; b");
});

test("A6 renders with no header/question (a box that set neither)", () => {
  const h = renderAskPopup({
    session: "s",
    pane: "%1",
    ask: { header: "", question: "", multiSelect: false, options: [{ key: 1, label: "ok", description: "" }] },
  });
  expect(h).toContain("ok");
  expect(h).toContain("<body");
});

// ⛔ ทั้งสองผิว (panel เดิม + sidebar ใหม่) ต้องมาจาก builder ตัวเดียวกัน — สองสำเนาคือกับดักที่รีโปนี้
//   เจอซ้ำ ๆ (แก้ที่เดียว อีกที่โกหกต่อ) · การ์ดต้องเป็น "ชิ้นส่วน" ล้วน ๆ ฝังในหน้าอื่นได้
test("renderAskCard: ชิ้นส่วนล้วน — ไม่มี doctype/style/script ติดมา", () => {
  const html = renderAskCard(single);
  expect(html).not.toContain("<!doctype");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<style");
  expect(html.trimStart().startsWith('<div class="card">')).toBe(true);
});

test("renderAskCard: ตัวเลือก/หัวข้อ/ปุ่ม Submit ครบเหมือนเดิม", () => {
  const one = renderAskCard(single);
  expect(one).toContain('data-key="1"');
  expect(one).toContain("คลิกข้อที่ต้องการ");
  const many = renderAskCard(multi);
  expect(many).toContain('type="checkbox"');
  expect(many).toContain('id="submit"');
});

test("⭐ panel เดิมต้องใช้การ์ดใบเดียวกันจริง (ไม่ใช่สำเนา)", () => {
  expect(renderAskPopup(single)).toContain(renderAskCard(single));
});
