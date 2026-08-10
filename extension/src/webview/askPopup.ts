// The agent's choice box, rendered as MC's own popup instead of a native
// QuickPick.
//
// ⛔ WHY NOT QuickPick (user's call, twice): a QuickPick can only express "pick
// one row", so the multi-select shape had no home in it — the old code detected
// one and showed a single "เปิดเพนไปตอบเอง" row, i.e. **no Submit button at
// all**, which is the "ปุ่ม submit หาย" report. It also looks nothing like the
// box the human sees inside the pane. This renders the REPL's own shape: header
// chip, question, numbered options with their descriptions, checkboxes when the
// box is multi-select, and a Submit that is always visible.
//
// ⛔ NO vscode import — pure string builder, unit-tested with `bun test`
// (askPopup.test.ts). The panel, polling and send-keys live in pendingAskWatch.ts.

/** Just enough of `PendingHit` to render — kept structural so the test does not
 *  need the vscode half. */
export interface AskView {
  session: string;
  pane: string;
  ask: {
    header: string;
    question: string;
    multiSelect: boolean;
    options: { key: number; label: string; description: string }[];
  };
}

/** Everything interpolated below is agent-authored text (labels, questions come
 *  from another model's tool call) — escape it all, including inside attributes. */
function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAskPopup(v: AskView): string {
  const { ask } = v;
  const multi = ask.multiSelect;
  const rows = ask.options
    .map((o) => {
      const box = multi ? `<input type="checkbox" class="cb" data-key="${o.key}" id="o${o.key}">` : "";
      const desc = o.description ? `<div class="desc">${esc(o.description)}</div>` : "";
      return `<label class="opt" data-key="${o.key}" for="o${o.key}">
  ${box}<span class="num">${o.key}.</span>
  <span class="body"><span class="label">${esc(o.label)}</span>${desc}</span>
</label>`;
    })
    .join("\n");

  // ⛔ ปุ่ม Submit ต้องอยู่ใน HTML เสมอเมื่อกล่องเป็น multiSelect — disabled ได้ แต่ห้ามหาย
  //   (ปุ่มที่โผล่มาเมื่อติ๊กแล้วคือปุ่มที่ user รายงานว่า "หาย")
  const footer = multi
    ? `<div class="footer">
  <div class="hint">เลือกได้หลายข้อ · ติ๊กแล้วกด Submit</div>
  <button id="submit" disabled>✓ Submit</button>
</div>`
    : `<div class="footer"><div class="hint">คลิกข้อที่ต้องการ = ส่งคำตอบทันที (เหมือนกดเลขในเพน)</div></div>`;

  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 18px; font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); font-size: 13px; }
  .card { max-width: 720px; margin: 0 auto; border: 1px solid var(--vscode-panel-border, #8884);
          border-radius: 10px; overflow: hidden; }
  .top { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
         background: var(--vscode-editorWidget-background, #0002); border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .chip { font-weight: 600; }
  .who { opacity: .65; font-size: 12px; margin-left: auto; }
  .q { padding: 14px 14px 4px; font-size: 15px; font-weight: 600; }
  .opts { padding: 6px 8px 10px; }
  .opt { display: flex; gap: 8px; align-items: flex-start; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
  .opt:hover { background: var(--vscode-list-hoverBackground, #8882); }
  .opt.on { background: var(--vscode-list-activeSelectionBackground, #0a48); }
  .num { opacity: .55; min-width: 1.4em; }
  .label { font-weight: 500; }
  .desc { opacity: .7; margin-top: 2px; }
  /* ⛔ sticky: กล่องที่ตัวเลือกยาวต้องยังเห็นปุ่ม Submit — เลื่อนลงไปหาไม่เจอ = "ปุ่มหาย" อีกแบบ */
  .footer { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px;
            background: var(--vscode-editorWidget-background, #0002); border-top: 1px solid var(--vscode-panel-border, #8884); }
  .hint { opacity: .7; font-size: 12px; }
  button { margin-left: auto; padding: 6px 16px; border: 0; border-radius: 6px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 13px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  #note { max-width: 720px; margin: 10px auto 0; padding: 8px 12px; border-radius: 8px; display: none;
          background: var(--vscode-inputValidation-infoBackground, #0a42); }
</style></head>
<body>
<div class="card">
  <div class="top">
    <span class="chip">${multi ? "☑" : "☐"} ${esc(ask.header || "คำถาม")}</span>
    <span class="who">${esc(v.session)} · ${esc(v.pane)}</span>
  </div>
  ${ask.question ? `<div class="q">${esc(ask.question)}</div>` : ""}
  <div class="opts">
${rows}
  </div>
  ${footer}
</div>
<div id="note"></div>
<script>
  const vs = acquireVsCodeApi();
  const multi = ${multi ? "true" : "false"};
  const note = document.getElementById("note");
  const submit = document.getElementById("submit");
  const picked = () => [...document.querySelectorAll(".cb")].filter(c => c.checked).map(c => +c.dataset.key);

  function sync() {
    document.querySelectorAll(".opt").forEach(o => {
      const cb = o.querySelector(".cb");
      o.classList.toggle("on", !!(cb && cb.checked));
    });
    if (submit) submit.disabled = picked().length === 0;
  }

  if (multi) {
    document.querySelectorAll(".cb").forEach(cb => cb.addEventListener("change", sync));
    submit.addEventListener("click", () => {
      submit.disabled = true;
      vs.postMessage({ type: "submit", keys: picked() });
    });
  } else {
    document.querySelectorAll(".opt").forEach(o =>
      o.addEventListener("click", () => vs.postMessage({ type: "answer", key: +o.dataset.key })));
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type !== "result") return;
    note.style.display = "block";
    note.textContent = m.text || "";
    if (!m.ok && submit) submit.disabled = picked().length === 0;   // ให้ลองใหม่ได้ ปุ่มไม่ค้าง disabled
  });
  sync();
</script>
</body></html>`;
}
