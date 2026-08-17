import { beforeEach, describe, expect, test } from "bun:test";

import { oracleMemorySectionBody, oracleMemorySectionScript } from "./oracleMemorySection";

// The section's client script lives in a string that gets concatenated into the
// webview HTML, so tsc never sees it. This runs it for real against a stub DOM:
// syntax errors, wrong element ids and bad handler wiring all fail here instead
// of silently producing a blank panel.

type Handler = (ev: unknown) => void;

const STATE = {
  mapFile: "/home/u/.claude/oracle-tenant-map.json",
  dbFile: "/home/u/.oracle/oracle.db",
  documents: 3222,
  onDefault: 2437,
  vaults: [
    {
      vault: "mike-oracle",
      path: "/x/mike-oracle",
      scope: "github.com/o/mike-oracle",
      tenant: "mike",
      isolated: true,
      pending: 0,
      labelled: 90,
    },
    {
      vault: "bob-oracle",
      path: "/x/bob-oracle",
      scope: "github.com/o/bob-oracle",
      tenant: null,
      isolated: false,
      pending: 544,
      labelled: 0,
    },
  ],
};

let el: { id: string; innerHTML: string };
let posted: Record<string, unknown>[];
let docHandlers: Record<string, Handler[]>;
let winHandlers: Record<string, Handler[]>;

function boot(): void {
  el = { id: "oracle-memory", innerHTML: "" };
  posted = [];
  docHandlers = {};
  winHandlers = {};
  const add = (bag: Record<string, Handler[]>) => (t: string, h: Handler) => {
    (bag[t] ??= []).push(h);
  };
  (globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => (id === el.id ? el : null),
    addEventListener: add(docHandlers),
  };
  (globalThis as Record<string, unknown>).window = {
    __mcVscode: { postMessage: (m: Record<string, unknown>) => posted.push(m) },
    addEventListener: add(winHandlers),
  };
  new Function(oracleMemorySectionScript())();
}

function send(state: unknown): void {
  for (const h of winHandlers.message ?? []) h({ data: { type: "oracleMemoryState", state } });
}

beforeEach(boot);

describe("oracle memory client script", () => {
  test("parses and asks for its state on boot", () => {
    expect(posted).toEqual([{ type: "oracleMemoryReload" }]);
  });

  test("the body placeholder carries the id the script looks up", () => {
    expect(oracleMemorySectionBody()).toContain('id="oracle-memory"');
  });

  test("renders one row per vault with mode, tenant and counts", () => {
    send(STATE);
    expect(el.innerHTML).toContain("mike-oracle");
    expect(el.innerHTML).toContain("bob-oracle");
    expect(el.innerHTML).toContain("tenant mike · 90 docs");
    expect(el.innerHTML).toContain("544 docs");
    expect(el.innerHTML).toContain("3222 docs");
    // isolated vault gets the ON switch, shared one does not
    expect(el.innerHTML).toContain('class="so-switch on" data-om="mode" data-vault="mike-oracle"');
    expect(el.innerHTML).toContain('class="so-switch" data-om="mode" data-vault="bob-oracle"');
    // and each switch offers the opposite state as its next value
    expect(el.innerHTML).toContain('data-vault="mike-oracle" data-next="0"');
    expect(el.innerHTML).toContain('data-vault="bob-oracle" data-next="1"');
  });

  test("the isolate explanation is a hover badge, not a wall of text", () => {
    send(STATE);
    expect(el.innerHTML).toContain('class="hint" data-tip="เปิด isolate =');
    expect(el.innerHTML).toContain("2437 แชร์อยู่ (tenant default)"); // counts stay visible
  });

  test("null state renders the not-installed notice, not an empty list", () => {
    send(null);
    expect(el.innerHTML).toContain("~/.claude");
    expect(el.innerHTML).not.toContain("so-switch");
  });

  test("a switch click posts the requested mode for that vault", () => {
    send(STATE);
    const attrs: Record<string, string> = {
      "data-om": "mode",
      "data-vault": "bob-oracle",
      "data-next": "1",
    };
    const target = {
      closest: (sel: string) => (sel === "[data-om]" ? { getAttribute: (k: string) => attrs[k] } : null),
    };
    for (const h of docHandlers.click ?? []) h({ target });
    expect(posted.at(-1)).toEqual({
      type: "oracleMemorySet",
      vault: "bob-oracle",
      isolated: true,
    });
  });

  test("clicking outside a switch posts nothing", () => {
    send(STATE);
    const before = posted.length;
    for (const h of docHandlers.click ?? []) h({ target: { closest: () => null } });
    expect(posted).toHaveLength(before);
  });

  test("escapes vault names instead of injecting markup", () => {
    send({ ...STATE, vaults: [{ ...STATE.vaults[1], vault: "<img src=x>" }] });
    expect(el.innerHTML).toContain("&lt;img src=x&gt;");
    expect(el.innerHTML).not.toContain("<img src=x>");
  });
});
