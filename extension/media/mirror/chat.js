/* Mission Control — Claude Chat grid (webview client). Renders each pane's
 * conversation (parsed from its transcript, relayed by the host) as HTML chat
 * bubbles — Thai displays perfectly, no terminal. One composer per panel; input
 * goes to the live pane via the host (tmux send-keys). No xterm. */
(function () {
  "use strict";
  var vscode = acquireVsCodeApi();
  var grid = document.getElementById("grid");
  var emptyEl = document.getElementById("empty");
  var orchCol = document.getElementById("orchCol");
  var workerCol = document.getElementById("workerCol");
  var wakeBar = document.getElementById("wakeBar");
  var tpl = document.getElementById("panelTpl");
  var panels = new Map(); // id -> { el, msgsEl, roleEl, labelEl, ctxfill, ctxpct, hidew, isWorker, workerName }
  var teamSet = {}; // oracle name -> true, from the latest team roster (gates the "ปิด" button)
  var DEFAULT_EMPTY = emptyEl.textContent; // "กำลังต่อ session…" — restored when re-emptied

  // ---- emoji removal --------------------------------------------------------
  // This user cannot read emoji AND the webview font renders them as blank tofu
  // squares. Strip emoji glyphs from displayed content (Claude's / a skill's output
  // may include them) so nothing shows as a square \u2014 WITHOUT touching text-default
  // symbols people rely on (\u00A9 \u00AE \u2122 \u25B6 \u25C0 \u2714 \u2194 \u2192 \u2022 \u2605 \u2026), which render as normal glyphs.
  // Matches: (1) any emoji-capable base + VS16 U+FE0F (\u26A0\uFE0F \u2714\uFE0F \u00A9\uFE0F \u2014 explicitly
  // emoji-styled); (2) default-color emoji (\p{Emoji_Presentation}: \uD83D\uDE00 \uD83D\uDC4B \u26D4 \u2705),
  // regional-indicator flags, skin-tone modifiers, enclosing-keycap marks
  // (U+20DD\u2013U+20E4, kills the leftover box in 1\uFE0F\u20E3), and stray joiners/selectors
  // (ZWJ, VS16). Bare \u00A9 \u00AE \u2122 \u25B6 \u2714 (no VS16) are intentionally KEPT. V8 (Node +
  // the webview's Chromium) supports \p{Emoji}/\p{Emoji_Presentation} with the u flag.
  var EMOJI_RE = /\p{Emoji}\uFE0F|[\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{20DD}-\u{20E4}\u200D\uFE0F]/gu;
  // Pure removal \u2014 safe for <pre>/code/tool paths, where whitespace is significant
  // and must be preserved. Inline bubble text does its own whitespace tidy below.
  function stripEmoji(s) { return String(s == null ? "" : s).replace(EMOJI_RE, ""); }

  // ---- safe markdown-lite (strip emoji, escape, then a few inline forms) -----
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function inlineMd(t) {
    // Strip emoji, then tidy the whitespace their removal leaves behind (collapse
    // runs, trim line ends). Inline bubbles render in normal flow so HTML would
    // collapse it anyway \u2014 this just keeps the emitted markup clean. NOT applied to
    // <pre>/code, whose spacing is meaningful.
    t = stripEmoji(t)
      .replace(/[ \t]{2,}/g, " ")
      .replace(/(^|\n)[ \t]+/g, "$1")
      .replace(/[ \t]+(\n|$)/g, "$1");
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return t.replace(/\n/g, "<br>");
  }
  function mdLite(src) {
    var parts = String(src || "").split("```");
    var html = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var body = parts[i].replace(/^[^\n]*\n/, ""); // drop the ```lang line
        html += "<pre><code>" + esc(stripEmoji(body)) + "</code></pre>";
      } else {
        html += inlineMd(parts[i]);
      }
    }
    return html;
  }

  // ---- panel lifecycle -------------------------------------------------------
  function createPanel(id) {
    var node = tpl.content.cloneNode(true);
    var el = node.querySelector(".panel");
    // NOT appended here — onPanes places it into orchCol (left) or workerCol (right)
    var rec = {
      el: el,
      msgsEl: el.querySelector(".msgs"),
      roleEl: el.querySelector(".role"),
      labelEl: el.querySelector(".label"),
      ctxfill: el.querySelector(".ctxfill"),
      ctxpct: el.querySelector(".ctxpct"),
      hidew: el.querySelector(".hidew"),
      ta: el.querySelector("textarea"),
      isWorker: false,
      workerName: "",
    };
    panels.set(id, rec);
    // "ปิด" hides this worker from the grid (host: pane-layout hide → worker keeps running)
    rec.hidew.addEventListener("click", function () { if (rec.workerName) vscode.postMessage({ type: "closeWorker", worker: rec.workerName }); });
    function submit() {
      var t = rec.ta.value; if (!t) return;
      vscode.postMessage({ type: "send", pane: id, d: t });
      rec.ta.value = ""; autoGrow(rec.ta); rec.ta.focus();
    }
    rec.ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    rec.ta.addEventListener("input", function () { autoGrow(rec.ta); });
    el.querySelector(".send").addEventListener("click", submit);
    el.querySelector(".clip").addEventListener("click", function () { vscode.postMessage({ type: "attach", pane: id }); });
    // click (or Enter/Space) the ctx meter → ask the host to force /compact on this pane
    var ctxEl = el.querySelector(".ctx");
    function compact() { vscode.postMessage({ type: "compact", pane: id }); }
    ctxEl.addEventListener("click", compact);
    ctxEl.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); compact(); } });
    // drag-drop a file onto the panel
    ["dragenter", "dragover"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); el.style.outline = "2px dashed var(--vscode-focusBorder)"; }); });
    ["dragleave", "drop"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); el.style.outline = ""; }); });
    el.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files; if (!files) return;
      for (var i = 0; i < files.length; i++) (function (f) {
        var r = new FileReader();
        r.onload = function () { var s = String(r.result || ""); var c = s.indexOf(","); if (c < 0) return; vscode.postMessage({ type: "drop", pane: id, name: f.name, data: s.slice(c + 1) }); };
        r.readAsDataURL(f);
      })(files[i]);
    });
    return rec;
  }
  function autoGrow(ta) { ta.style.height = "32px"; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.3) + "px"; }

  function onPanes(list) {
    var seen = {};
    // A team session (maw team up) has NO orchestrator — every pane is a plain
    // member. Sending them all to the "everything else" column would stack them
    // in the right half with the left half blank, so with no orchestrator the
    // panes just fill both columns in order.
    var hasOrch = (list || []).some(function (p) { return p.role === "orchestrator"; });
    grid.classList.toggle("no-orch", !hasOrch); // even columns when there is no wider orchestrator panel
    var i = 0;
    (list || []).forEach(function (p) {
      seen[p.id] = true;
      var rec = panels.get(p.id) || createPanel(p.id);
      var isOrch = p.role === "orchestrator";
      rec.isWorker = p.role === "worker";
      rec.workerName = rec.isWorker ? (p.label || "") : "";
      rec.roleEl.textContent = p.role || "";
      rec.labelEl.textContent = stripEmoji(p.label || p.id);
      rec.el.classList.toggle("orchestrator", isOrch);
      // place/move into the correct column: orchestrator LEFT, everything else
      // RIGHT — or, with no orchestrator at all, alternate to use both columns.
      var col = hasOrch ? (isOrch ? orchCol : workerCol) : (i % 2 === 0 ? orchCol : workerCol);
      i++;
      if (rec.el.parentNode !== col) col.appendChild(rec.el);
    });
    panels.forEach(function (rec, id) { if (!seen[id]) { if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el); panels.delete(id); } });
    refreshHideButtons();
    updateEmpty();
  }

  // "ปิด" is shown only on a worker panel whose name is in the resolved team roster
  // (so it can never be a silently-dead button). Explicit "inline-block" — NOT "" —
  // because the CSS default is display:none, which "" would fall back to.
  function refreshHideButtons() {
    panels.forEach(function (rec) {
      rec.hidew.style.display = (rec.isWorker && !!teamSet[rec.workerName]) ? "inline-block" : "none";
    });
  }

  // "empty" overlay when no panels; collapse the worker column when there are no
  // VISIBLE worker panels (so the orchestrator takes the full width). The "เปิด"
  // chips live in the top wakeBar, not the column.
  function updateEmpty() {
    if (!panels.size) emptyEl.textContent = DEFAULT_EMPTY; // reset any stale warning on re-empty
    emptyEl.style.display = panels.size ? "none" : "";
    // Collapse the right column only when it holds NO panel at all — count actual
    // children (workers AND any transient null-role pane live there), so a pane is
    // never hidden by the collapse.
    var wc = 0;
    panels.forEach(function (r) { if (r.el.parentNode === workerCol) wc++; });
    grid.classList.toggle("no-workers", wc === 0);
  }

  // OLD-UI selector format (top bar): "<project> / <team>" header · "orchestrator: <name>"
  // (NOT clickable) · then every worker as a chip — click a worker → show ITS pane. Awake
  // workers first (shown ones highlighted with ●), asleep ones dim (click wakes+shows).
  function onTeam(msg) {
    var workers = (msg && msg.workers) || [];
    teamSet = {};
    workers.forEach(function (w) { if (w && w.name) teamSet[w.name] = true; });
    refreshHideButtons(); // roster arrived → (un)gate "ปิด" on existing worker panels
    while (wakeBar.firstChild) wakeBar.removeChild(wakeBar.firstChild);

    // header: project / team, then the orchestrator name as a plain (non-clickable) badge
    if (msg && msg.label) {
      var sname = document.createElement("span");
      sname.className = "wsession";
      sname.textContent = stripEmoji(msg.label);
      wakeBar.appendChild(sname);
    }
    if (msg && msg.orch) {
      var oname = document.createElement("span");
      oname.className = "worch";
      oname.textContent = "orchestrator: " + stripEmoji(msg.orch);
      oname.title = "orchestrator — อยู่คอลัมน์ซ้าย (กดไม่ได้)";
      wakeBar.appendChild(oname);
    }
    if (!workers.length) { updateEmpty(); return; }

    var sep = document.createElement("span"); sep.className = "wsep"; wakeBar.appendChild(sep);
    var lbl = document.createElement("span"); lbl.className = "wlbl"; lbl.textContent = "worker:"; wakeBar.appendChild(lbl);

    var awake = workers.filter(function (w) { return w && w.awake; });
    var asleep = workers.filter(function (w) { return w && !w.awake; });
    var MAXW = 3; // pane-layout MAX_ORACLES — grid shows at most 3 worker panes at once
    var shownN = workers.filter(function (w) { return w && w.shown; }).length;
    awake.concat(asleep).forEach(function (w) {
      var b = document.createElement("button");
      b.className = "wchip" + (w.shown ? " on" : (w.awake ? "" : " off"));
      b.textContent = stripEmoji(w.name);
      b.title = w.shown ? "กำลังแสดงอยู่ — คลิกเพื่อโฟกัส"
        : (w.awake ? "คลิกเพื่อแสดง pane ของ " + w.name : "หลับอยู่ — คลิกเพื่อปลุก + แสดง " + w.name);
      b.addEventListener("click", function () { vscode.postMessage({ type: "openWorker", worker: w.name }); });
      wakeBar.appendChild(b);
    });
    if (shownN >= MAXW) {
      var full = document.createElement("span");
      full.className = "wlbl";
      full.textContent = "(กริดเต็ม " + MAXW + " — ปิดตัวอื่นก่อนเปิดเพิ่ม)";
      wakeBar.appendChild(full);
    }
    updateEmpty();
  }

  // ---- render one message's blocks -------------------------------------------
  function appendMsg(rec, m) {
    m.blocks.forEach(function (b) {
      var node;
      if (b.kind === "text") {
        node = document.createElement("div");
        node.className = "msg " + (m.role === "user" ? "user" : "assistant");
        node.innerHTML = mdLite(b.text);
      } else if (b.kind === "thinking") {
        node = document.createElement("details");
        node.className = "think";
        node.innerHTML = "<summary>thinking…</summary><div>" + mdLite(b.text) + "</div>";
      } else if (b.kind === "tool_use" && b.ask && b.ask.length) {
        // AskUserQuestion → a PROMINENT (never-collapsed) question card. Without this the
        // question hides inside the generic "tool: AskUserQuestion" chip below → the human
        // can't see what Claude is asking, can't answer, and thinks the session hung.
        node = document.createElement("div");
        node.className = "msg assistant askcard";
        var h = '<div class="askhdr">Claude กำลังถาม — ตอบโดยพิมพ์ด้านล่างแล้ว Send</div>';
        b.ask.forEach(function (q) {
          h += '<div class="askq">';
          if (q.header) h += '<div class="askqh">' + esc(stripEmoji(q.header)) + (q.multiSelect ? " (เลือกได้หลายข้อ)" : "") + "</div>";
          h += '<div class="askqt">' + esc(stripEmoji(q.question)) + "</div><ol class=\"askopts\">";
          (q.options || []).forEach(function (o) {
            h += "<li><b>" + esc(stripEmoji(o.label)) + "</b>" + (o.description ? ' — <span class="askdesc">' + esc(stripEmoji(o.description)) + "</span>" : "") + "</li>";
          });
          h += "</ol></div>";
        });
        node.innerHTML = h;
      } else if (b.kind === "tool_use") {
        node = document.createElement("details");
        node.className = "tool";
        var inp = "";
        try { inp = JSON.stringify(b.input, null, 2); } catch (e) { inp = String(b.input); }
        if (inp && inp.length > 4000) inp = inp.slice(0, 4000) + "\n… (truncated)";
        node.innerHTML = "<summary>tool: " + esc(stripEmoji(b.name || "tool")) + "</summary><pre>" + esc(stripEmoji(inp || "")) + "</pre>";
      } else if (b.kind === "tool_result") {
        node = document.createElement("details");
        node.className = "tool";
        if (b.isError) node.setAttribute("data-err", "1");
        var txt = b.text || "";
        if (txt.length > 6000) txt = txt.slice(0, 6000) + "\n… (truncated)";
        node.innerHTML = "<summary>result" + (b.isError ? " (error)" : "") + "</summary><pre>" + esc(stripEmoji(txt)) + "</pre>";
      } else if (b.kind === "image") {
        node = document.createElement("div");
        node.className = "msg " + (m.role === "user" ? "user" : "assistant");
        node.textContent = "[image]";
      }
      if (node) rec.msgsEl.appendChild(node);
    });
  }

  function onMessages(msg) {
    var rec = panels.get(msg.pane);
    if (!rec) return;
    var near = rec.msgsEl.scrollTop + rec.msgsEl.clientHeight >= rec.msgsEl.scrollHeight - 50;
    if (msg.reset) rec.msgsEl.innerHTML = "";
    (msg.msgs || []).forEach(function (m) { appendMsg(rec, m); });
    // cap DOM growth on long sessions (retainContextWhenHidden keeps this alive)
    var MAXN = 600;
    while (rec.msgsEl.childNodes.length > MAXN) rec.msgsEl.removeChild(rec.msgsEl.firstChild);
    if (msg.reset || near) rec.msgsEl.scrollTop = rec.msgsEl.scrollHeight;
  }

  function onCtx(ctx) {
    panels.forEach(function (rec, id) {
      var info = ctx ? ctx[id] : null;
      if (!info || typeof info.pct !== "number") { rec.ctxfill.style.width = "0%"; rec.ctxpct.textContent = "—"; return; }
      var pct = Math.max(0, Math.min(100, info.pct));
      rec.ctxfill.style.width = pct + "%";
      rec.ctxfill.style.background = "hsl(" + Math.round(120 * (1 - pct / 100)) + ",70%,45%)";
      rec.ctxpct.textContent = pct + "%";
      rec.ctxpct.title = info.tokens + " / " + info.trigger + " tokens";
    });
  }

  // attached file path(s) → APPEND into this pane's composer (visible feedback; multiple
  // attaches accumulate; the user adds a prompt and sends it all together). Brief highlight
  // so it's obvious the attach landed. No emoji (user can't read them).
  function onAttachPaths(pane, paths) {
    var rec = panels.get(pane);
    if (!rec || !rec.ta || !paths || !paths.length) return;
    var add = paths.join(" ") + " ";
    var cur = rec.ta.value;
    rec.ta.value = cur ? (cur.replace(/\s*$/, "") + " " + add) : add;
    autoGrow(rec.ta);
    rec.ta.focus();
    try { rec.ta.setSelectionRange(rec.ta.value.length, rec.ta.value.length); } catch (e) {}
    var ta = rec.ta, prev = ta.style.boxShadow;
    ta.style.boxShadow = "0 0 0 2px var(--vscode-focusBorder)";
    setTimeout(function () { ta.style.boxShadow = prev; }, 600);
  }

  window.addEventListener("message", function (e) {
    var m = e.data; if (!m || typeof m.type !== "string") return;
    if (m.type === "panes") onPanes(m.panes);
    else if (m.type === "messages") onMessages(m);
    else if (m.type === "ctx") onCtx(m.ctx);
    else if (m.type === "team") onTeam(m);
    else if (m.type === "attachPaths") onAttachPaths(m.pane, m.paths);
    else if (m.type === "status") { if (emptyEl) emptyEl.textContent = String(m.text || ""); }
  });

  vscode.postMessage({ type: "ready" });
})();
