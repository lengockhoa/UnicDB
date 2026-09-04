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
// TASK-UX2-003: `createStatusBar` returns a WRAPPER
// `{ item: vscode.StatusBarItem; setErrorBadge(reason: string | null): void;
// dispose(): void }` instead of a bare `StatusBarItem`. This is a breaking
// change for the production caller (`src/extension.ts:420`) and two test
// mocks (`src/scaffold.test.ts:16`, `src/extension.test.ts:97`). The
// migration is in the Acceptance Criteria on TASK-UX2-003.
//
// `setErrorBadge(reason)` flips the active connection chip to a red
// `$(error) <name> [driver]` with tooltip `vsdb: error: <reason>`. Calling
// it with `null` restores the normal render via the shared `render()`.
//
// Hàm export: `createStatusBar(mgr: ConnectionManager): StatusBarWrapper`.
// Caller dispose wrapper khi extension deactivate.
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
 * Wrapper returned by `createStatusBar` (TASK-UX2-003). Exposes:
 *   - `item`: the underlying `vscode.StatusBarItem` for legacy dispose /
 *     text-access call sites.
 *   - `setErrorBadge(reason: string | null)`: flip the active chip to a
 *     red error badge; pass `null` to restore the normal render.
 *   - `dispose()`: clean up subscribed listeners and the underlying item.
 */
export interface StatusBarWrapper {
  item: vscode.StatusBarItem;
  setErrorBadge(reason: string | null): void;
  dispose(): void;
}

/**
 * Tạo StatusBarItem gắn với ConnectionManager.
 * - Text = "$(database) <name> [<driver>]" nếu có active; "" nếu không.
 * - Command = "vsdb.selectConnection" — click để đổi active.
 * - Auto-update qua mgr.onDidChangeActive + mgr.onDidChangeRecoveryStatus.
 *
 * Trả về `StatusBarWrapper`. Caller dispose wrapper khi extension unload.
 */
export function createStatusBar(mgr: ConnectionManager): StatusBarWrapper {
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

  // TASK-UX2-003 — flip the active chip to a red error badge. The active
  // connection may have changed since the badge was last cleared; we
  // resolve the chip from `mgr.getActive()` so the badge is always about
  // the current chip. Passing `null` re-runs the normal render path.
  // The error text intentionally mirrors the recovery-failed literal
  // shape `$(error) <name> [driver]` so the chip is recognizable on the
  // status bar; the tooltip carries the verbatim reason.
  let errorBadgeActive = false;
  const setErrorBadge = (reason: string | null): void => {
    if (reason === null) {
      if (!errorBadgeActive) return;
      errorBadgeActive = false;
      render();
      return;
    }
    errorBadgeActive = true;
    const active = mgr.getActive();
    if (!active) {
      // No active chip — keep the item hidden but still stamp the
      // tooltip so a future show() reveals it. The panel/state should
      // not call `setErrorBadge` when no connection is active; this is
      // a defensive branch.
      item.text = "";
      item.tooltip = `vsdb: error: ${reason}`;
      item.hide();
      return;
    }
    item.text = `$(error) ${active.name} [${active.driver}]`;
    item.tooltip = `vsdb: error: ${reason}`;
    item.show();
  };

  // Dispose subs + underlying item when wrapper disposes.
  const dispose = (): void => {
    subActive.dispose();
    subRecovery.dispose();
    item.dispose();
  };

  return { item, setErrorBadge, dispose };
}