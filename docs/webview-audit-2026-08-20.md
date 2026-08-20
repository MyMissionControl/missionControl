# ตรวจหาบั๊กใน extension — 2026-08-20

_ตรวจอย่างเดียว **ไม่ได้แก้โค้ด** · ทั้ง 3 เรื่องระดับเล็ก ไม่มีอันไหนทำให้พัง_

## ทำไมต้องตรวจโซนนี้

ด่านที่มีอยู่เขียวหมด: **`bun test` 968 ผ่าน 0 fail** (58 ไฟล์) · **`tsc -p ./` 0 error**

แต่ **54% ของโค้ดไม่มีเทสคู่** — 14,608 จาก 27,265 บรรทัด และเกือบทั้งหมดคือ `src/webview/` ซึ่ง `tsc` มองไม่เห็นข้างใน template literal (HTML+JS เป็นสตริง คอมไพเลอร์ไม่ parse) และ `bun test` ก็ไม่มีโมดูลจะ import

ไฟล์ใหญ่สุดที่ไม่มีเทสเลย: `webview/orchestrator.ts` (2,369) · `webview/dashboard.ts` (1,538) · `webview/createRequirement.ts` (1,101) · `commands/startOrchestrator.ts` (801)

**วิธีตรวจ:** stub โมดูล `vscode` ตอน require (`Module._load` hook) → เรียก `open*Panel()` จริง → ดัก `panel.webview.html` ที่ถูก set → ได้ HTML ที่ render จริง แล้ว (ก) `node --check` สคริปต์ข้างใน (ข) เทียบ `getElementById(...)` ทุกตัวกับ `id="..."` ที่มีจริงใน HTML

ผล: **10 panel · สคริปต์ syntax ผ่านหมด** · id ชี้ถูกเกือบครบ เหลือที่รายงานข้างล่าง

> ⚠️ รอบแรกผมใช้ regex จับ `<script` จากซอร์สโดยตรง ได้ FAIL 9 อัน — **ทั้งหมดเป็นบั๊กของเครื่องมือผมเอง** (ไปจับคำว่า `<script` ที่อยู่ในคอมเมนต์ แล้วดึงข้อความคอมเมนต์มา parse เป็นโค้ด + คลาย escape ไม่ครบ) การ render HTML จริงเป็นวิธีที่ถูก เพราะไม่มีปัญหา escape เลย

---

## 1. dashboard คำนวณของที่ไม่มีใครรับ ทุก 10 วินาที

**ระดับ: เล็ก — แต่เป็น sync I/O บน extension host**

`pushSkillCount()` (`src/webview/dashboard.ts:893`) เรียก `listSkills()` แล้ว post `{type:"skill_count"}` ไปให้ element `skillsSub` — ซึ่ง **ไม่มีอยู่ใน HTML**

ฝั่งรับอยู่ที่ `dashboard.ts:1506-1507`:
```js
} else if (m.type === "skill_count") {
  const sub = document.getElementById("skillsSub");
  if (sub) sub.textContent = ...     // sub เป็น null เสมอ
```

**หลักฐาน:** grep คำว่า `skills` ใน HTML ที่ render จริง → **0 ครั้ง** การ์ด Skills ถูกถอดออกไปแล้ว แต่ฝั่ง host ยังทำงานให้มันอยู่

**ต้นทุนที่วัดได้:** `listSkills()` (`src/webview/skills.ts:209`) เดิน `readdirSync` แล้ว `readFileSync(SKILL.md, 'utf8')` **ทีละไฟล์แบบ sync** + `existsSync(marker)` + parse frontmatter
- เครื่องนี้มี **150 SKILL.md**
- วัดได้ **12.0 ms ต่อครั้ง** (เฉลี่ย 20 รอบ, page cache ร้อนแล้ว)
- `STATUS_POLL_MS = 10_000` (`dashboard.ts:78`) → **ทุก 10 วินาทีตอนเปิด dashboard**
- = 72 ms/นาที ที่ทิ้งเปล่า

ตัวเลข ms เองไม่เท่าไร **ประเด็นคือมันเป็น sync file I/O 150 ครั้งบน extension host** ถ้าดิสก์เย็นหรือช้า UI จะสะดุด

**เทียบกับกรณีข้างเคียง:** `dot` กับ `statusText` ก็หายไปเหมือนกัน แต่สองตัวนั้น **มีคอมเมนต์กำกับว่าจงใจ** (`dashboard.ts:1497-1498` — "The status pill was removed… Guard the elements so the still-firing status poll is a harmless no-op") และ host ไม่ได้ทำงานหนักเปล่า ตัว `skillsSub` ไม่มีคอมเมนต์และ host ยังทำงาน → เป็นของที่ตกค้าง ไม่ใช่ของที่ตั้งใจ

**ทางแก้ (เลือกหนึ่ง):** เอา `pushSkillCount` ออกจาก poll tick (`dashboard.ts:145`) ให้ยิงครั้งเดียวตอนเปิด · หรือเอาการ์ด Skills กลับมาถ้ายังอยากได้ตัวเลข · หรือถ้าจะคงไว้ ก็เติมคอมเมนต์แบบเดียวกับ `dot`/`statusText` และเปลี่ยน `listSkills()` เป็นแค่นับโฟลเดอร์ ไม่ต้องอ่านเนื้อไฟล์

---

## 2. ลากไฟล์มาวางที่ Skills panel ไม่มีอะไรตอบสนอง

**ระดับ: เล็ก — แต่ผู้ใช้เห็น**

`src/webview/skills.ts:1180-1189` ผูก drag/drop ไว้บน `window` และหา element `drop` มาไฮไลต์:
```js
// Drag-and-drop anywhere on the window drops straight in (no dialog), with the
// rail drop target highlighting while a file is over the window.
window.addEventListener("dragover", function (e) { … var d = document.getElementById("drop"); if (d) d.classList.add("drag"); });
```

**หลักฐาน:** ใน HTML ที่ render จริง **ไม่มีทั้ง `id="drop"`, ไม่มีคลาสที่มีคำว่า drop, และไม่มีสไตล์ `.drag`** → ไฮไลต์ไม่เคยเกิดขึ้นเลย และถูกถอดออกถึงระดับ CSS แล้ว (เป็นซากค้าง ไม่ใช่ regression ที่กำลังเกิด)

**ตัวการวางยังทำงาน** — handler อยู่บน `window` แล้วเรียก `handleFile(f)` ตามปกติ **ที่หายไปคือสัญญาณตอบสนอง** ผู้ใช้จะไม่รู้ว่า panel นี้รับการลากวางได้

ผลข้างเคียงอีกอย่าง: คอมเมนต์บรรยายพฤติกรรมที่ไม่เกิด → คนอ่านโค้ดต่อจะเข้าใจผิด

**ทางแก้:** ใส่ drop zone กลับ (element + สไตล์ `.drag`) หรือถ้าไม่อยากได้ ก็ลบ 3 บรรทัดที่หา `getElementById("drop")` และแก้คอมเมนต์ให้ตรงความจริง

---

## 3. `startOrchestrator.ts:705` — กับดัก tmux ในโค้ดที่รันไม่ถึง

**ระดับ: เล็ก (โค้ดตาย) — แต่ถ้าเปิดใช้จะพังเงียบ**

```js
cp.execFileSync("tmux", ["send-keys", "-t", `=${session}`, kickoff, "Enter"]);
```

**พิสูจน์แล้วว่ารูปแบบนี้พังบน tmux 3.4** (ทดสอบบน tmux socket แยก ไม่แตะ session จริง):

| target | ผล |
|---|---|
| `'=claude-jack'` ← **โค้ดใช้อันนี้** | `can't find pane: =claude-jack` **exit 1** |
| `'=claude-jack:'` | ผ่าน |
| `'claude-jack'` | ผ่าน |
| `'=claude-jack:w.0'` | ผ่าน |
| `'=claude-jack:0'` | ผ่าน |

มีรูปแบบเดียวที่พัง และมันคือรูปแบบที่โค้ดใช้ · แล้วมันถูกครอบด้วย `catch { /* best-effort */ }` = **พังเงียบสนิท**

**โค้ดเบสนี้บันทึกบั๊กนี้ไว้เองแล้ว** ที่ `src/commands/claudeSessions.ts:95` — *"`send-keys -t '=<session>'` fails with 'can't find pane' — verified live"* และ `:108` — *"bare `=<s>` fails on send-keys on tmux 3.4; a window-qualified `=<s>:<w>` works"* ทุกจุดอื่นในโปรเจกต์ใช้รูปแบบถูกหมด (`=sess:win` หรือ pane id `%0`) **เหลือ `startOrchestrator.ts:705` ที่เดียว**

**แต่มันรันไม่ถึง** — `inject` ประกาศเป็น `let inject = false;` (`:679`) แล้ว **ไม่มีที่ไหนในทั้ง repo ตั้งเป็น `true`** (grep `inject *= *true` → 0 ผล) ดังนั้น
- `if (inject) { … }` (`:700`) เป็นโค้ดตาย
- `const command = inject ? … : …` (`:719`) เข้า else เสมอ

เป็นซากของฟีเจอร์ที่ถูกแทนด้วย twin session (`base-2`, `base-3`) ไปแล้ว — คอมเมนต์ `:682` บอกเองว่า *"no modal, no twin/inject choice"*

`tsc` ไม่ฟ้องเพราะ `let x = false` แล้ว `if (x)` ถูกกฎ และโปรเจกต์ไม่มี linter

**ทางแก้:** ลบบล็อกตายทิ้ง (สะอาดที่สุด) หรือถ้าจะเก็บไว้ ให้เติม `:` เป็น `` `=${session}:` `` เดี๋ยวนี้ ไม่ต้องรอวันที่มีคนเปิดใช้แล้วมานั่งงงว่าทำไม kickoff ไม่ถึง

---

## ที่ยังไม่ได้ตรวจ

- **`webview/orchestrator.ts` (2,369 บรรทัด ใหญ่สุด ไม่มีเทส) และ `webview/teams.ts`** ใช้ selector แบบ class ไม่ใช่ `#id` → วิธีเทียบ id ของรอบนี้เอื้อมไม่ถึง ถ้าจะไล่ต้องรันหน้าจริงใน headless browser แล้วกดปุ่มดูว่า handler ทำงานไหม
- **ตรรกะภายในสคริปต์ทุกตัว** — รอบนี้พิสูจน์แค่ว่า syntax ถูกและ DOM handle มีจริง ยังไม่ได้รันมันด้วยข้อมูลจริงแล้วตรวจว่า render ถูกไหม
- `commands/pendingAskWatch.ts` (479) กับ `commands/attachToClaude.ts` (196) ไม่มีเทสคู่ ยังไม่ได้อ่าน

## เครื่องมือที่ใช้

harness อยู่ใน scratchpad ของ session (ไม่ได้ commit — เป็นเครื่องมือตรวจ ไม่ใช่เทส) วิธีทำซ้ำ: stub `vscode` ผ่าน `Module._load`, require `out/webview/<mod>.js`, เรียก `open*Panel(ctx)`, ดัก setter ของ `panel.webview.html` · รันทีละโมดูลในโปรเซสแยกพร้อม timeout เพราะบางตัวมีงาน async ค้างทำให้แขวน
