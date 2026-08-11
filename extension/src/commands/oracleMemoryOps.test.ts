import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  confirmIsolateMessage,
  isInstalled,
  modeArgSteps,
  parseStatus,
  readStatus,
  setMode,
  statusArgs,
  tenantCli,
  type RunResult,
  type Runner,
} from "./oracleMemoryOps";

// No vscode, no bun spawn, no real oracle.db: the CLI path is faked via
// MC_TENANT_CLI and every call goes through an injected Runner.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-om-"));
const FAKE_CLI = path.join(tmp, "oracle-tenant-migrate.ts");

function withCli<T>(exists: boolean, fn: () => T): T {
  const prev = process.env.MC_TENANT_CLI;
  process.env.MC_TENANT_CLI = FAKE_CLI;
  if (exists) fs.writeFileSync(FAKE_CLI, "// fake\n");
  else if (fs.existsSync(FAKE_CLI)) fs.rmSync(FAKE_CLI);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MC_TENANT_CLI;
    else process.env.MC_TENANT_CLI = prev;
  }
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): RunResult => ({ code: 2, stdout: "", stderr });

const STATUS = JSON.stringify({
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
});

afterEach(() => {
  if (fs.existsSync(FAKE_CLI)) fs.rmSync(FAKE_CLI);
});

describe("tenantCli", () => {
  test("honours MC_TENANT_CLI, else defaults under ~/.claude", () => {
    withCli(true, () => expect(tenantCli()).toBe(FAKE_CLI));
    const prev = process.env.MC_TENANT_CLI;
    delete process.env.MC_TENANT_CLI;
    expect(tenantCli()).toBe(path.join(os.homedir(), ".claude", "oracle-tenant-migrate.ts"));
    if (prev !== undefined) process.env.MC_TENANT_CLI = prev;
  });
});

describe("argument shapes", () => {
  test("status asks for json", () => {
    withCli(true, () => expect(statusArgs()).toEqual([FAKE_CLI, "--json"]));
  });

  test("isolating = label + backfill + isolate, in that order", () => {
    withCli(true, () =>
      expect(modeArgSteps("mike-oracle", true)).toEqual([
        [FAKE_CLI, "--label", "mike-oracle"],
        [FAKE_CLI, "--apply"],
        [FAKE_CLI, "--isolate", "mike-oracle"],
      ]),
    );
  });

  test("sharing again only drops the read filter — never reverts labels", () => {
    withCli(true, () => {
      const steps = modeArgSteps("mike-oracle", false);
      expect(steps).toEqual([[FAKE_CLI, "--unisolate", "mike-oracle"]]);
      expect(JSON.stringify(steps)).not.toContain("--revert");
      expect(JSON.stringify(steps)).not.toContain("--apply");
    });
  });
});

describe("parseStatus", () => {
  test("normalises the payload", () => {
    const s = parseStatus(STATUS);
    expect(s.documents).toBe(3222);
    expect(s.vaults).toHaveLength(2);
    expect(s.vaults[0]).toMatchObject({ vault: "mike-oracle", tenant: "mike", isolated: true });
    expect(s.vaults[1].tenant).toBeNull();
    expect(s.vaults[1].isolated).toBe(false);
  });

  test("rejects a payload with no vaults array", () => {
    expect(() => parseStatus('{"documents":1}')).toThrow();
    expect(() => parseStatus("not json")).toThrow();
  });
});

describe("readStatus", () => {
  test("null when the ~/.claude side is not installed (and never runs anything)", () => {
    withCli(false, () => {
      expect(isInstalled()).toBe(false);
      let called = 0;
      const run: Runner = () => {
        called++;
        return ok(STATUS);
      };
      expect(readStatus(run)).toBeNull();
      expect(called).toBe(0);
    });
  });

  test("parses a good run", () => {
    withCli(true, () => {
      const s = readStatus(() => ok(STATUS));
      expect(s?.onDefault).toBe(2437);
    });
  });

  test("null on non-zero exit or unparseable stdout — not an empty list", () => {
    withCli(true, () => {
      expect(readStatus(() => fail("boom"))).toBeNull();
      expect(readStatus(() => ok("<html>oops"))).toBeNull();
    });
  });
});

describe("setMode", () => {
  test("runs every step when they all succeed", () => {
    withCli(true, () => {
      const seen: string[][] = [];
      const res = setMode("mike-oracle", true, (a) => {
        seen.push(a.slice(1));
        return ok();
      });
      expect(res.ok).toBe(true);
      expect(seen).toEqual([["--label", "mike-oracle"], ["--apply"], ["--isolate", "mike-oracle"]]);
    });
  });

  test("stops at the first failure and surfaces the CLI's own message", () => {
    withCli(true, () => {
      const seen: string[][] = [];
      const res = setMode("mike-oracle", true, (a) => {
        seen.push(a.slice(1));
        return a[1] === "--apply" ? fail("refusing: no vaults mapped.") : ok();
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("refusing: no vaults mapped.");
      expect(seen).toEqual([["--label", "mike-oracle"], ["--apply"]]);
    });
  });
});

describe("confirmIsolateMessage", () => {
  const row = parseStatus(STATUS).vaults[1];

  test("states the doc count, the backup, and what stops being visible", () => {
    const m = confirmIsolateMessage(row);
    expect(m).toContain("544 existing docs");
    expect(m).toContain("backup");
    expect(m).toContain("projects/ψ");
    expect(m).toContain("bob"); // derived tenant name
  });

  test("says so when there is nothing to relabel", () => {
    const m = confirmIsolateMessage({ ...row, pending: 0 });
    expect(m).toContain("No existing docs");
  });
});
