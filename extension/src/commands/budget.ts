import * as vscode from "vscode";

import { computeUsage, getInstantUsage } from "../usage";
import { buildBudgetView, openBudgetPanel } from "../webview/budget";

// Real Claude Code spend, computed locally from ~/.claude/projects transcripts —
// no backend. Primary UI is a floating QuickPick popup (no editor tab); the
// "ดูแบบละเอียด" item opens the themed webview panel for the full view.
// Compute logic is shared with the panel via buildBudgetView.

interface Row extends vscode.QuickPickItem {
  action?: "detail";
}

/** Show the budget as a floating QuickPick. */
async function showBudgetPopup(): Promise<void> {
  // Instant: use the cached snapshot (kicks a background refresh for next time);
  // only the very first run ever awaits a scan. The QuickPick is one-shot so it
  // shows the cached numbers — a budget glance doesn't need sub-15s freshness.
  const u = (await getInstantUsage()) ?? (await computeUsage());
  const v = await buildBudgetView(u);

  const items: Row[] = [
    { label: "$(calendar) " + v.last30Fmt, description: "30 วันล่าสุด" },
    { label: "$(clock) " + v.todayFmt, description: "วันนี้" },
    { label: "$(history) " + v.last7Fmt, description: "7 วันล่าสุด" },
    { label: "$(graph) " + v.allTimeFmt, description: "ทั้งหมด" },
  ];
  if (v.providerNote) {
    items.push({ label: "$(warning) " + v.providerNote });
  }

  const tokFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  items.push({ label: "Top projects", kind: vscode.QuickPickItemKind.Separator });
  for (const p of [...v.projects].sort((a, b) => b.cost - a.cost).slice(0, 5)) {
    const name = p.live ? p.name : p.name + " (ลบแล้วจากเครื่อง)";
    items.push({ label: name, description: p.costFmt + " · " + tokFmt.format(p.tokens) + " tok" });
  }

  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: "$(list-tree) ดูแบบละเอียด",
    description: "เปิดหน้ารายละเอียดเต็ม (hero · tiles · progress bar)",
    action: "detail",
  });

  const qp = vscode.window.createQuickPick<Row>();
  qp.title = "Claude usage: " + v.last30Fmt + " in the last 30 days";
  qp.placeholder = v.sessions + " sessions · คำนวณจาก ~/.claude/projects · Anthropic list pricing";
  // (v.sessions counts real sessions — subagent/workflow transcripts belong to one)
  qp.items = items;
  qp.matchOnDescription = true;

  const picked = await new Promise<Row | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!picked?.action) return;
  if (picked.action === "detail") {
    openBudgetPanel();
  }
}

export async function budgetCommand(_context: vscode.ExtensionContext): Promise<void> {
  try {
    await showBudgetPopup();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Budget failed — ${msg}`);
  }
}
