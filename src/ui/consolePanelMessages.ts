// src/ui/consolePanelMessages.ts
// TASK-001 — Console host/webview message contract + save filename helper.
// Pure on purpose: no VS Code API imports, so both the webview bundle (TASK-002)
// and the host panel (TASK-003) share one validated interface (plan §3.1).
//
// SECURITY: values arriving via postMessage are untrusted runtime input. The
// host MUST pass every inbound message through isConsoleToHostMessage before
// routing; there is no path that trusts shape from the webview.

export type ConsoleToHostMessage =
  | { type: "runConsole"; sql: string }
  | { type: "saveConsoleAsSql"; sql: string };

/** Runtime guard for untrusted webview postMessage data. Rejects null,
 *  non-object carriers, unknown discriminants, and non-string `sql` BEFORE any
 *  host routing (messages.ts house rule: unknown messages ignored). */
export function isConsoleToHostMessage(
  value: unknown,
): value is ConsoleToHostMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const msg = value as { type?: unknown; sql?: unknown };
  if (
    msg.type !== "runConsole" &&
    msg.type !== "saveConsoleAsSql"
  ) {
    return false;
  }
  return typeof msg.sql === "string";
}

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
