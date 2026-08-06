import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { loadDataIndex } from "./dataView";
import {
  ensureObsidianConfig,
  planVault,
  readmeOnlyRows,
  registerVault,
  vaultRoot,
  writeVault,
  type WriteResult,
} from "./obsidianVault";

/** How to launch the Obsidian desktop app on this machine. Discovered at call time
 *  (never a hardcoded path) so it survives moving machines: PATH → user AppImage →
 *  flatpak → snap. Returns null if Obsidian can't be found. */
export function findObsidianLauncher(
  deps: {
    onPath?: (cmd: string) => boolean;
    readdir?: (dir: string) => string[];
    home?: string;
  } = {},
): { cmd: string; args: string[] } | null {
  const onPath =
    deps.onPath ??
    ((cmd: string) => {
      try {
        cp.execFileSync("which", [cmd], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
  const readdir = deps.readdir ?? ((dir: string) => fs.readdirSync(dir));
  const home = deps.home ?? os.homedir();

  // 1) a real `obsidian` binary on PATH (some installs / distro packages)
  if (onPath("obsidian")) return { cmd: "obsidian", args: [] };

  // 2) an Obsidian AppImage the user downloaded (the soulbrew VM case).
  //    --no-sandbox + --disable-gpu match what runs on this GPU-less headless VM;
  //    both are harmless elsewhere (just skip GPU accel / the unavailable sandbox).
  for (const dir of [path.join(home, "Applications"), home, path.join(home, "Downloads")]) {
    let hit: string | undefined;
    try {
      hit = readdir(dir).find((f) => /^obsidian.*\.appimage$/i.test(f));
    } catch {
      continue; // dir missing/unreadable
    }
    if (hit) {
      return {
        cmd: path.join(dir, hit),
        args: ["--appimage-extract-and-run", "--no-sandbox", "--disable-gpu"],
      };
    }
  }

  // 3) flatpak / snap installs
  if (onPath("flatpak")) return { cmd: "flatpak", args: ["run", "md.obsidian.Obsidian"] };
  if (onPath("snap")) return { cmd: "snap", args: ["run", "obsidian"] };

  return null;
}

/** Is a desktop Obsidian already up? Matters because spawning a second time only
 *  focuses the existing window — which is still showing whatever vault it opened
 *  with, so our freshly-registered vault would NOT appear. */
function obsidianRunning(): boolean {
  try {
    cp.execFileSync("pgrep", ["-f", "-i", "obsidian"], { stdio: "ignore" });
    return true;
  } catch {
    return false; // exit 1 = no match (or no pgrep — treat as not running)
  }
}

/** Refresh the project vault: one folder per project under "Mission Control",
 *  each with a generated summary note plus symlinks to the project's live docs.
 *  Deleted-project backups are left out — this vault is the work in progress. */
async function refreshVault(): Promise<{ result: WriteResult; projects: number } | null> {
  const rows = (await loadDataIndex()).filter((r) => r.deleted !== true);
  // Fold in README-only builds: buildProjectRow() drops anything without docs/, so
  // they never reach loadDataIndex() — but a project folder should still have a home.
  const { resolveOwnerRoot } = await import("./startOrchestrator");
  const owner = resolveOwnerRoot();
  if (owner) rows.push(...readmeOnlyRows(owner, new Set(rows.map((r) => r.name))));
  if (!rows.length) return null; // owner root unresolved / no projects
  const root = vaultRoot();
  const result = writeVault(planVault(rows), root);
  ensureObsidianConfig(root);
  return { result, projects: rows.length };
}

/** Build/refresh the project vault, point Obsidian at it, then launch the app.
 *  If anything about the vault fails we still open Obsidian (its last-used vault),
 *  which is what this command did before — degrade, never dead-end. */
export async function openObsidianCommand(): Promise<void> {
  const launcher = findObsidianLauncher();
  if (!launcher) {
    void vscode.window.showWarningMessage(
      "Mission Control: หา Obsidian ไม่เจอ — ลงแอป Obsidian ก่อน (obsidian.md) แล้วลองใหม่",
    );
    return;
  }

  const wasRunning = obsidianRunning();
  let note = "";
  try {
    const built = await refreshVault();
    if (!built) {
      void vscode.window.showWarningMessage(
        "Mission Control: หาโปรเจคไม่เจอ (อ่าน ~/.maw/oracles.json ไม่ได้) — เปิด Obsidian vault ล่าสุดให้แทน",
      );
    } else {
      const outcome = registerVault();
      note = `vault: ${built.projects} โปรเจค`;
      if (outcome === "no-config")
        void vscode.window.showInformationMessage(
          `Mission Control: สร้าง vault แล้วที่ ${vaultRoot()} — Obsidian ยังไม่เคยเปิดในเครื่องนี้ กด "Open folder as vault" แล้วเลือกโฟลเดอร์นี้`,
        );
      else if (outcome === "unreadable")
        void vscode.window.showWarningMessage(
          `Mission Control: อ่าน obsidian.json ไม่ได้ (ไม่แตะไฟล์) — เปิด vault เองที่ ${vaultRoot()}`,
        );
      else if (wasRunning)
        void vscode.window.showInformationMessage(
          'Mission Control: Obsidian เปิดอยู่แล้ว — ต้องสลับ vault เอง (Ctrl+P > "Open another vault" > Mission Control) หรือปิดแล้วกดปุ่มนี้อีกครั้ง',
        );
    }
  } catch (e) {
    void vscode.window.showWarningMessage(
      "Mission Control: สร้าง vault ไม่สำเร็จ — เปิด Obsidian ตามปกติให้แทน: " + String(e),
    );
  }

  try {
    const child = cp.spawn(launcher.cmd, launcher.args, { detached: true, stdio: "ignore" });
    child.unref(); // let it outlive the extension host
    vscode.window.setStatusBarMessage(
      "Mission Control: เปิด Obsidian…" + (note ? " " + note : ""),
      4000,
    );
  } catch (e) {
    void vscode.window.showErrorMessage("Mission Control: เปิด Obsidian ไม่ได้ — " + String(e));
  }
}
