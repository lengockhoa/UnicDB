// src/ui/statusBar.ts
// StatusBar item hiển thị connection đang active.
//
// Text: "$(database) <name> [<driver>]" — khi không có active: ẩn hoặc text rỗng.
// Command: "vsdb.selectConnection" — click → mở quick-pick đổi active.
// Update: subscribe `onDidChangeActive` của ConnectionManager.
//
// Hàm export: `createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem`.
// Caller phải dispose item khi extension deactivate.
import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connectionManager";

/**
 * Tạo StatusBarItem gắn với ConnectionManager.
 * - Text = "$(database) <name> [<driver>]" nếu có active; "" nếu không.
 * - Command = "vsdb.selectConnection" — click để đổi active.
 * - Auto-update qua mgr.onDidChangeActive.
 *
 * Trả về StatusBarItem. Caller dispose khi extension unload.
 */
export function createStatusBar(mgr: ConnectionManager): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.command = "vsdb.selectConnection";

  // Render banh đầu.
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

  // Subscribe active change.
  const sub = mgr.onDidChangeActive(() => render());

  // Dispose sub khi item dispose (caller dispose item).
  const origDispose = item.dispose.bind(item);
  item.dispose = (): void => {
    sub.dispose();
    origDispose();
  };

  return item;
}