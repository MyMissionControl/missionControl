import {
  readStatus,
  type OracleMemoryStatus,
} from "../commands/oracleMemoryOps";

// "Oracle memory" section of the Settings page: one switch per oracle —
// shared (default) vs isolated. Mirrors searchSection.ts: a state builder + a
// style/body/script triple that settings.ts injects into the shell, so all the
// vscode wiring stays in one place.
//
// Reuses the .so-* classes from searchSectionStyle() (same page, already global)
// and only adds what it needs of its own.

export function buildOracleMemoryState(): OracleMemoryStatus | null {
  return readStatus();
}

export function oracleMemorySectionStyle(): string {
  return [
    ".om-tot{font-size:11.5px;color:var(--pmuted);margin:-4px 0 10px}",
    ".om-tag{font-family:var(--pmono);font-size:9px;font-weight:700;letter-spacing:.08em;padding:2px 7px;border-radius:6px;margin-left:8px;background:var(--pfield);color:var(--pmuted);border:1px solid var(--pborder)}",
    ".om-tag.iso{background:rgba(196,127,26,.16);color:#e0a33d;border-color:rgba(196,127,26,.5)}",
  ].join("\n");
}

export function oracleMemorySectionBody(): string {
  return '<section class="so-wrap" id="oracle-memory"><div class="so-off">กำลังโหลดสถานะ Oracle memory…</div></section>';
}

// NOTE: plain string, NO backtick / NO backslash anywhere below (same rule as
// searchSection.ts — this is concatenated into the webview HTML).
const _script = [
  '(function(){',
  '  var vs = window.__mcVscode;',
  '  function esc(s){s=String(s==null?"":s);return s.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split(String.fromCharCode(34)).join("&quot;");}',
  '  function post(t,extra){var m={type:t};if(extra){for(var k in extra){m[k]=extra[k];}}vs.postMessage(m);}',
  '  function row(v){',
  // data-vault carries a directory name read off disk — escape it, or a crafted
  // name breaks out of the attribute (caught by oracleMemorySection.client.test).
  '    var sw = "<div class=" + q("so-switch" + (v.isolated ? " on" : "")) + " data-om=" + q("mode") + " data-vault=" + q(esc(v.vault)) + " data-next=" + q(v.isolated ? "0" : "1") + "><div class=" + q("kn") + "></div></div>";',
  '    var tag = v.isolated ? "<span class=" + q("om-tag iso") + ">isolated</span>" : "<span class=" + q("om-tag") + ">shared</span>";',
  '    var bits = [];',
  '    if (v.tenant) bits.push("tenant " + esc(v.tenant) + " · " + v.labelled + " docs");',
  '    else bits.push("ยังไม่ติดป้าย");',
  '    if (v.pending > 0) bits.push(v.pending + " docs รอย้าย");',
  '    bits.push(esc(v.scope));',
  '    return "<div class=" + q("so-row") + "><div><div class=" + q("so-rl") + ">" + esc(v.vault) + tag + "</div><div class=" + q("so-rh") + ">" + bits.join(" · ") + "</div></div>" + sw + "</div>";',
  '  }',
  '  function q(s){return String.fromCharCode(34) + s + String.fromCharCode(34);}',
  '  function render(v){',
  '    var el = document.getElementById("oracle-memory"); if(!el) return;',
  '    if (!v) { el.innerHTML = "<h2>Oracle memory</h2><div class=" + q("so-off") + ">ยังไม่ได้ติดตั้งฝั่ง ~/.claude (oracle-tenant-migrate.ts) — ส่วนนี้จึงปิดอยู่</div>"; return; }',
  '    var rows = v.vaults.map(row).join("");',
  '    if (!rows) rows = "<div class=" + q("so-off") + ">ไม่พบ vault ที่มีเอกสาร</div>";',
  '    el.innerHTML = "<h2>Oracle memory</h2>"',
  // The explanation is behind a "?" badge (hover 2s) — engine in settings.ts.
'      + "<div class=" + q("om-tot") + ">" + v.documents + " docs · " + v.onDefault + " แชร์อยู่ (tenant default)" + "<span class=" + q("hint") + " data-tip=" + q("เปิด isolate = oracle ตัวนั้นค้นเจอแค่ความรู้ของตัวเอง รวมถึงมองไม่เห็นคลังกลาง projects/ψ") + ">?</span></div>"',
  '      + rows;',
  '  }',
  '  document.addEventListener("click", function(e){',
  '    var t = e.target; if(!t || !t.closest) return;',
  '    var host = t.closest("[data-om]"); if(!host) return;',
  '    if (host.getAttribute("data-om") === "mode") {',
  '      post("oracleMemorySet", { vault: host.getAttribute("data-vault"), isolated: host.getAttribute("data-next") === "1" });',
  '    }',
  '  });',
  '  window.addEventListener("message", function(ev){ var m=ev.data; if(m && m.type==="oracleMemoryState"){ render(m.state); } });',
  '  post("oracleMemoryReload");',
  '})();',
].join("\n");

export function oracleMemorySectionScript(): string {
  return _script;
}
