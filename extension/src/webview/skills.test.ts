import { describe, expect, mock, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// skills.ts imports vscode only for the panel/handlers (not for listSkills),
// so a bare stub lets us load the module and test the pure disk-reading path.
mock.module("vscode", () => ({}));

function writeSkill(root: string, name: string, frontmatter: string, uploaded = false): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n\nbody\n`);
  if (uploaded) fs.writeFileSync(path.join(dir, ".mc-uploaded"), "");
}

describe("listSkills grouping", () => {
  test("auto-created skills land in the 'generated' bucket, distinct from system/uploaded", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skills-"));
    process.env.MC_SKILLS_DIR = tmp;
    try {
      writeSkill(tmp, "gen-one",
        "name: gen-one\ndescription: a generated one\ninstaller: auto-skill\ncategory: testing");
      writeSkill(tmp, "sys-one",
        "name: sys-one\ndescription: '[core] v1 G-SKLL | a normal skill'");
      writeSkill(tmp, "up-one", "name: up-one\ndescription: an uploaded one", true);

      const { listSkills } = await import("./skills");
      const byName = Object.fromEntries(listSkills().map((s) => [s.name, s]));

      expect(byName["gen-one"].group).toBe("generated");
      expect(byName["gen-one"].category).toBe("testing"); // uses frontmatter category
      expect(byName["sys-one"].group).toBe("system");
      expect(byName["up-one"].group).toBe("uploaded");
    } finally {
      delete process.env.MC_SKILLS_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a block-scalar description (|-) reads as text, not the literal '|-'", async () => {
    // Real skills use this for long descriptions (anthropics/skills claude-api),
    // and they arrive here through the GitHub uploader.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skills-"));
    process.env.MC_SKILLS_DIR = tmp;
    try {
      writeSkill(tmp, "blocky", "name: blocky\ndescription: |-\n  first line here.\n  second line here.");
      writeSkill(tmp, "folded", "name: folded\ndescription: >\n  folded text.\ninstaller: auto-skill\ncategory: testing");
      const { listSkills } = await import("./skills");
      const byName = Object.fromEntries(listSkills().map((s) => [s.name, s]));
      expect(byName["blocky"].description).toBe("first line here. second line here.");
      expect(byName["folded"].description).toBe("folded text.");
      // keys AFTER the block scalar are still read — the block must stop at column 0
      expect(byName["folded"].category).toBe("testing");
    } finally {
      delete process.env.MC_SKILLS_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("generated skills can be toggled off/on (rename SKILL.md <-> .disabled); system skills cannot", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skills-"));
    process.env.MC_SKILLS_DIR = tmp;
    try {
      writeSkill(tmp, "gen-x",
        "name: gen-x\ndescription: a generated one\ninstaller: auto-skill");
      writeSkill(tmp, "sys-x", "name: sys-x\ndescription: a system one");

      const { listSkills, toggleSkill } = await import("./skills");

      // generated → toggle off
      let list = listSkills();
      expect(toggleSkill("gen-x", list).ok).toBe(true);
      expect(fs.existsSync(path.join(tmp, "gen-x", "SKILL.md.disabled"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "gen-x", "SKILL.md"))).toBe(false);

      // still listed as generated but now disabled
      list = listSkills();
      const off = list.find((s) => s.name === "gen-x")!;
      expect(off.group).toBe("generated");
      expect(off.enabled).toBe(false);

      // toggle back on
      expect(toggleSkill("gen-x", list).ok).toBe(true);
      expect(fs.existsSync(path.join(tmp, "gen-x", "SKILL.md"))).toBe(true);
      expect(listSkills().find((s) => s.name === "gen-x")!.enabled).toBe(true);

      // system skills refuse to toggle
      const res = toggleSkill("sys-x", listSkills());
      expect(res.ok).toBe(false);
    } finally {
      delete process.env.MC_SKILLS_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
