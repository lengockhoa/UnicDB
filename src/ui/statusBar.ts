// src/ui/statusBar.ts
// StatusBar item hiển thị connection đang active.
//
// Text: "$(database) <name> [<driver>]" — khi không có active: ẩn hoặc text rỗng.
// Command: "vsdb.selectConnection" — click → mở quick-pick đổi active.
// Update: subscribe `onDidChangeActive` của ConnectionManager.
//
// RLX-03 TASK-RLX03-002: additionally subscribes `onDidChangeRecoveryStatus`
// and renders pinned recovery literals:
//   recovering → "$(sync~spin) <name> reconnecting (attempt/max)"
//   recovered  → "$(check) <name> reconnected"
//   failed     → "$(error) <name> reconnect failed"
// A later active-connection change returns the item to its normal text.
//
// Hàm export: `createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem`.
// Caller phải dispose item khi extension deactivate.
import * as vscode from "vscode";
import type {
  ConnectionManager,
  ConnectionRecoveryStatus,
} from "../core/connectionManager";

/**
 * Pinned recovery text for a ConnectionRecoveryStatus event.
 * Normal active rendering is left to the shared render() helper.
 */
function recoveryText(status: ConnectionRecoveryStatus, name: string): string {
  switch (status.state) {
    case "recovering":
      return `$(sync~spin) ${name} reconnecting (${status.attempt}/${status.maxAttempts})`;
    case "recovered":
      return `$(check) ${name} reconnected`;
    case "failed":
      return `$(error) ${name} reconnect failed`;
  }
}

/**
 * Tạo StatusBarItem gắn với ConnectionManager.
 * - Text = "$(database) <name> [<driver>]" nếu có active; "" nếu không.
 * - Command = "vsdb.selectConnection" — click để đổi active.
 * - Auto-update qua mgr.onDidChangeActive + mgr.onDidChangeRecoveryStatus.
 *
 * Trả về StatusBarItem. Caller dispose khi extension unload.
 */
export function createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.command = "vsdb.selectConnection";

  // Render ban đầu.
  const render = (): void => {
    const active = mgr.getActive();
    if (!active) {
      item.text = "";
      item.tooltip = undefined;
      item.hide();
      return;
    }
    item.text = `$(database) ${active.name} [${active.driver}]`;
    item.tooltip = `${active.name} — click để đổi connection`;
    item.show();
  };

  render();

  // RLX-03: render pinned recovery status for the active connection only.
  const renderRecovery = (status: ConnectionRecoveryStatus): void => {
    const active = mgr.getActive();
    if (!active || active.id !== status.connectionId) return;
    item.text = recoveryText(status, active.name);
    item.tooltip = `${active.name} — recovery ${status.state}`;
    item.show();
  };

  // Subscribe active change + recovery status.
  const subActive = mgr.onDidChangeActive(() => render());
  const subRecovery = mgr.onDidChangeRecoveryStatus((s) => renderRecovery(s));

  // Dispose subs khi item dispose (caller dispose item).
  const origDispose = item.dispose.bind(item);
  item.dispose = (): void => {
    subActive.dispose();
    subRecovery.dispose();
    origDispose();
  };

  return item;
}
