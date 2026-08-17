import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listProjectDirsIn } from "./projectScan";

function fixture(): { projects: string; real: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-scan-"));
  const real = path.join(root, "owner", "projects");
  const stray = path.join(root, "stray", "projects");
  fs.mkdirSync(path.join(real, "alive"), { recursive: true });
  fs.mkdirSync(stray, { recursive: true });
  // a bridge symlink into the real projects dir (this is what soulbrew/projects holds)
  fs.symlinkSync(path.join(real, "alive"), path.join(stray, "alive"));
  // …and one left pointing at a project that was deleted
  fs.symlinkSync(path.join(real, "deleted-project"), path.join(stray, "deleted-project"));
  fs.writeFileSync(path.join(real, "notes.txt"), "not a project");
  fs.mkdirSync(path.join(real, "ψ"), { recursive: true });
  fs.mkdirSync(path.join(real, ".hidden"), { recursive: true });
  return { projects: stray, real };
}

// The bug this locks: after a successful delete the project's card stayed in the
// list — its stray symlink still resolved as an entry, so the re-scan "found" the
// project again and the delete looked like it had failed.
test("listProjectDirsIn: a symlink to a deleted project is not a project", () => {
  const { projects } = fixture();
  expect(listProjectDirsIn(projects).map((p) => path.basename(p))).toEqual(["alive"]);
});

test("listProjectDirsIn: real dirs pass, files and the ψ/dot entries do not", () => {
  const { real } = fixture();
  expect(listProjectDirsIn(real).map((p) => path.basename(p)).sort()).toEqual(["alive"]);
});

test("listProjectDirsIn: a missing projects dir is empty, never a throw", () => {
  expect(listProjectDirsIn(path.join(os.tmpdir(), "mc-scan-does-not-exist-" + process.pid))).toEqual([]);
});
