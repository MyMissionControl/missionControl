import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { installFetchedSkills, isSafeSkillFolder, writeFetchedSkill } from "./skillsInstall";
import type { FetchedSkill } from "./skillsFetch";

const MARKER = ".mc-uploaded";
const roots: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mc-install-test-"));
  roots.push(d);
  return path.join(d, "skills"); // does not exist yet — the writer must create it
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const skill = (name: string, files: Array<[string, string]>): FetchedSkill => ({
  name,
  dir: "skills/" + name,
  files: files.map(([rel, body]) => ({ rel, data: Buffer.from(body) })),
});

test("writeFetchedSkill: files land with their subfolders, plus the uploaded marker", () => {
  const root = tmpRoot();
  const r = writeFetchedSkill(
    root,
    skill("pdf", [
      ["SKILL.md", "---\nname: pdf\n---\nbody"],
      ["scripts/fill.py", "print(1)"],
      ["references/forms.md", "ref"],
    ]),
    MARKER,
  );
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, "pdf", "SKILL.md"), "utf8")).toContain("name: pdf");
  expect(fs.readFileSync(path.join(root, "pdf", "scripts", "fill.py"), "utf8")).toBe("print(1)");
  expect(fs.existsSync(path.join(root, "pdf", MARKER))).toBe(true); // → "uploaded" bucket
});

test("writeFetchedSkill: an existing skill is never overwritten", () => {
  const root = tmpRoot();
  writeFetchedSkill(root, skill("pdf", [["SKILL.md", "mine, hand-edited"]]), MARKER);
  const again = writeFetchedSkill(root, skill("pdf", [["SKILL.md", "from github"]]), MARKER);
  expect(again.ok).toBe(false);
  expect(fs.readFileSync(path.join(root, "pdf", "SKILL.md"), "utf8")).toBe("mine, hand-edited");
});

test("writeFetchedSkill: refuses a traversal path and writes NOTHING", () => {
  const root = tmpRoot();
  const r = writeFetchedSkill(
    root,
    skill("evil", [
      ["SKILL.md", "ok"],
      ["../../escaped.txt", "pwned"],
    ]),
    MARKER,
  );
  expect(r.ok).toBe(false);
  expect(fs.existsSync(path.join(root, "evil"))).toBe(false); // temp dir discarded
  expect(fs.existsSync(path.join(path.dirname(root), "escaped.txt"))).toBe(false);
  expect(fs.existsSync(path.join(root, "..", "..", "escaped.txt"))).toBe(false);
});

test("writeFetchedSkill: a skill without SKILL.md is rejected, not half-installed", () => {
  const root = tmpRoot();
  const r = writeFetchedSkill(root, skill("empty", [["notes.md", "x"]]), MARKER);
  expect(r.ok).toBe(false);
  expect(fs.existsSync(path.join(root, "empty"))).toBe(false);
});

test("isSafeSkillFolder: rejects traversal, slashes and empties", () => {
  expect(isSafeSkillFolder("pdf")).toBe(true);
  expect(isSafeSkillFolder("my.skill_1-x")).toBe(true);
  expect(isSafeSkillFolder("..")).toBe(false);
  expect(isSafeSkillFolder("a..b")).toBe(false);
  expect(isSafeSkillFolder("a/b")).toBe(false);
  expect(isSafeSkillFolder("")).toBe(false);
});

test("installFetchedSkills: one bad skill does not stop the good ones", () => {
  const root = tmpRoot();
  const report = installFetchedSkills(
    root,
    [
      skill("a", [["SKILL.md", "a"]]),
      skill("bad", [["SKILL.md", "x"], ["../out.txt", "x"]]),
      skill("b", [["SKILL.md", "b"]]),
    ],
    MARKER,
  );
  expect(report.installed).toEqual(["a", "b"]);
  expect(report.failed.map((f) => f.name)).toEqual(["bad"]);
  expect(fs.existsSync(path.join(root, "b", "SKILL.md"))).toBe(true);
});
