import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { compatLabel } from "../compat";
import { requiresProfileReauthorization } from "../oauth";

/**
 * Status bar item: the active account + the 5h window usage %.
 * Clicking opens the quick account switcher.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly store: AccountStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeProviderSwitcher.switchAccount";
    this.item.show();
  }

  refresh(): void {
    const activeId = this.store.getActiveId();
    const active = activeId ? this.store.get(activeId) : undefined;

    if (!active) {
      this.item.text = "$(account) Claude: no profile";
      this.item.tooltip = "Click to add or switch a Claude account or API provider";
      this.item.backgroundColor = undefined;
      return;
    }

    // API-provider profiles have no usage windows; show what they are pointed at instead.
    if (active.kind === "api") {
      const model = active.provider?.model;
      this.item.text = `$(plug) ${active.label}`;
      this.item.tooltip = [
        `Active Claude Code provider: ${active.label}`,
        `  Endpoint: ${active.provider?.baseUrl ?? "not configured"}`,
        model ? `  Model: ${model}` : "  Model: endpoint default",
        `  Conversation group: ${compatLabel(active)}`,
        "Click to switch profile.",
      ].join("\n");
      this.item.backgroundColor = undefined;
      return;
    }

    const usage = active.lastUsage;
    const session = usage?.sessionPercent;
    const pctText = typeof session === "number" ? ` · ${session}%` : "";
    this.item.text = `$(account) ${active.label}${pctText}`;

    const lines = [`Active Claude account: ${active.label}`];
    if (usage) {
      for (const w of usage.windows) {
        lines.push(`  ${w.label}: ${w.percent}%`);
      }
      if (usage.error) {
        lines.push(`  ⚠ ${displayUsageError(usage.error)}`);
      }
    }
    lines.push("Click to switch account.");
    this.item.tooltip = lines.join("\n");

    const warn = vscode.workspace
      .getConfiguration("claudeProviderSwitcher")
      .get<number>("warnThresholdPercent", 80);
    this.item.backgroundColor =
      typeof session === "number" && session >= warn
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function displayUsageError(error: string): string {
  return requiresProfileReauthorization(error)
    ? "Needs reauthorization. Use Auth to refresh this profile."
    : error;
}
