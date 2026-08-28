// src/ui/consolePanelMessages.ts
// TASK-001 (cycle Z) — Console host/webview message contract + save filename helper.
// TASK-AF-004 (cycle AF) — Extends the wire surface with the Console v2 ops
//   (multi-tab registry, per-statement run, selection-only run, EXPLAIN,
//    format round-trip, persisted history).
//
// Pure on purpose: no VS Code API imports, so both the webview bundle (TASK-002)
// and the host panel (TASK-003) share one validated interface.
//
// SECURITY: values arriving via postMessage are untrusted runtime input. The
// host MUST pass every inbound message through isConsoleToHostMessage before
// routing; there is no path that trusts shape from the webview.

// ---- Webview → Host ---------------------------------------------------------

export type ConsoleToHostMessage =
  // Legacy single-tab surface (cycle Z) — preserved for regression. The host
  // routes these to the ACTIVE tab's buffer / runner.
  | { type: "runConsole"; sql: string }
  | { type: "saveConsoleAsSql"; sql: string }
  // Console v2 ops.
  | { type: "runStatement"; tabId?: string; index: number }
  | { type: "runSelection"; tabId?: string; text: string }
  | {
      type: "explain";
      tabId?: string;
      sql: string;
      analyze: boolean;
    }
  | { type: "format"; tabId?: string; sql?: string }
  | { type: "historyPush"; sql: string }
  | { type: "historyList" }
  | { type: "createTab"; name?: string }
  | { type: "closeTab"; tabId: string }
  | { type: "switchTab"; tabId: string }
  | { type: "renameTab"; tabId: string; name: string }
  | { type: "updateBuffer"; tabId: string; buffer: string };

/** Runtime guard for untrusted webview postMessage data. Rejects null,
 *  non-object carriers, unknown discriminants, and non-string fields BEFORE
 *  any host routing. */
export function isConsoleToHostMessage(
  value: unknown,
): value is ConsoleToHostMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as { type?: unknown; [k: string]: unknown };
  switch (msg.type) {
    case "runConsole":
    case "saveConsoleAsSql":
      return typeof msg.sql === "string";
    case "runStatement":
      return (
        (msg.tabId === undefined || typeof msg.tabId === "string") &&
        typeof msg.index === "number" &&
        Number.isFinite(msg.index)
      );
    case "runSelection":
      return (
        (msg.tabId === undefined || typeof msg.tabId === "string") &&
        typeof msg.text === "string"
      );
    case "explain":
      return (
        (msg.tabId === undefined || typeof msg.tabId === "string") &&
        typeof msg.sql === "string" &&
        typeof msg.analyze === "boolean"
      );
    case "format":
      return (
        (msg.tabId === undefined || typeof msg.tabId === "string") &&
        (msg.sql === undefined || typeof msg.sql === "string")
      );
    case "historyPush":
      return typeof msg.sql === "string";
    case "historyList":
      return true;
    case "createTab":
      return msg.name === undefined || typeof msg.name === "string";
    case "closeTab":
    case "switchTab":
      return typeof msg.tabId === "string";
    case "renameTab":
      return typeof msg.tabId === "string" && typeof msg.name === "string";
    case "updateBuffer":
      return (
        typeof msg.tabId === "string" && typeof msg.buffer === "string"
      );
    default:
      return false;
  }
}

// ---- Host → Webview ---------------------------------------------------------

/** A tab's snapshot — sent in the `state` payload and on every mutation. */
export interface ConsoleTabState {
  id: string;
  name: string;
  buffer: string;
  active: boolean;
}

export type ConsoleHostToWebviewMessage =
  | {
      type: "state";
      tabs: ConsoleTabState[];
      activeTabId: string;
      history: string[];
    }
  | { type: "historyList"; items: string[] }
  | { type: "explainResult"; plan: string; error?: string };

// ---- Helpers ----------------------------------------------------------------

/** Default save suggestion in local time, e.g. console_20260102_030405.sql.
 *  Every field is zero-padded so names sort lexicographically by timestamp.
 *  The Date argument is required (not defaulted) so tests stay deterministic;
 *  the save host supplies `new Date()`. */
export function suggestSaveFileName(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const ymd = [
    date.getFullYear().toString().padStart(4, "0"),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("");
  const hms = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  return `console_${ymd}_${hms}.sql`;
}

/** Generate a short, sortable, unique tab id. The host is the source of truth,
 *  but webview previews (e.g. `createTab`) echo the id so the bundle can
 *  reconcile. */
export function newTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Memento key for persisted query history. Capped at 200 entries by the host. */
export const CONSOLE_HISTORY_KEY = "vsdb.consoleHistory";

/** Cap on persisted history entries — the 201st run evicts the oldest. */
export const CONSOLE_HISTORY_CAP = 200;
