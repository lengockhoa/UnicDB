// src/ui/consolePanelMessages.ts
// TASK-001 (cycle Z) — Console host/webview message contract + save filename helper.
// TASK-AF-004 (cycle AF) — Extends the wire surface with the Console v2 ops
//   (multi-tab registry, per-statement run, selection-only run, EXPLAIN,
//    format round-trip, persisted history).
// ARP-08 TASK-ARP08-001 — Adds the persisted draft model: the versioned,
//   bounded `ConsoleDraftSnapshot` codec (encode/parse, fail-closed) plus the
//   `clearDrafts` webview→host message and the `draftsCleared` host→webview
//   acknowledgement.
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
  | { type: "updateBuffer"; tabId: string; buffer: string }
  // Cycle AIC TASK-AIC-004 — Console ghost-text autocomplete variants.
  | {
      type: "requestAutocomplete";
      tabId: string;
      requestId: string;
      cursorOffset: number;
      documentText: string;
    }
  | { type: "acceptAutocomplete"; tabId: string; requestId: string; suffix: string }
  | { type: "clearAutocomplete"; tabId: string }
  // ARP-08 TASK-ARP08-001 — Clear all persisted drafts. Intentionally
  // type-only: the host ignores any extra payload, mirroring `historyList`.
  | { type: "clearDrafts" };

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
    case "updateBuffer":
      return (
        typeof msg.tabId === "string" && typeof msg.buffer === "string"
      );
    case "requestAutocomplete":
      return (
        typeof msg.tabId === "string" &&
        typeof msg.requestId === "string" &&
        typeof msg.cursorOffset === "number" &&
        Number.isFinite(msg.cursorOffset) &&
        typeof msg.documentText === "string"
      );
    case "acceptAutocomplete":
      return (
        typeof msg.tabId === "string" &&
        typeof msg.requestId === "string" &&
        typeof msg.suffix === "string"
      );
    case "clearAutocomplete":
      return typeof msg.tabId === "string";
    case "clearDrafts":
      return true;
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
  | { type: "explainResult"; plan: string; error?: string }
  // Cycle AIC TASK-AIC-004 — Console ghost-text.
  | { type: "autocompleteResult"; tabId: string; requestId: string; suffix: string | null }
  | { type: "autocompleteClear"; tabId: string }
  // ARP-08 TASK-ARP08-001 — Acknowledgement for `clearDrafts` so the webview
  // can reset its draft-memento state after the host wipes storage.
  | { type: "draftsCleared" };

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

// ---- ARP-08 — Persisted draft model (TASK-ARP08-001) -------------------------

/** Memento key for persisted console drafts (all tabs + active tab). */
export const CONSOLE_DRAFTS_KEY = "vsdb.consoleDrafts";

/** Snapshot schema version. `parse` rejects any other value (fail-closed). */
export const CONSOLE_DRAFT_SNAPSHOT_VERSION = 1;

/** Upper bound on tabs in a draft snapshot — parse REJECTS over-cap input. */
export const CONSOLE_DRAFTS_MAX_TABS = 20;

/** Upper bound on a single tab buffer, in characters — parse REJECTS over-cap
 *  input so a corrupt/giant memento can never bloat the host. */
export const CONSOLE_DRAFTS_MAX_BUFFER_CHARS = 64_000;

/** Versioned, bounded snapshot of every console tab's draft buffer.
 *  Serialized to `CONSOLE_DRAFTS_KEY` by the host (TASK-ARP08-002). */
export interface ConsoleDraftSnapshot {
  version: 1;
  tabs: Array<{ id: string; name: string; buffer: string }>;
  activeTabId: string;
}

/** Verbatim JSON serialization of a draft snapshot. Pure encode on purpose:
 *  clamping to the caps is the host `persistDrafts()`'s job (ARP-08-002) so
 *  our own writer can never emit a snapshot its own parse rejects. */
export function encodeConsoleDraftSnapshot(snapshot: ConsoleDraftSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Fail-closed parser for untrusted draft-memento data. Returns a REBUILT
 *  object (never the raw parsed value by reference) with exactly the declared
 *  fields, or null on ANY violation:
 *   - non-string input / malformed JSON / non-object root;
 *   - missing or non-`1` version;
 *   - `tabs` not an array, EMPTY, over-cap (> CONSOLE_DRAFTS_MAX_TABS), or a
 *     tab with a non-string id/name/buffer or a buffer over
 *     CONSOLE_DRAFTS_MAX_BUFFER_CHARS;
 *   - `activeTabId` missing, non-string, or matching no tab.
 *
 *  Forward compatibility is TOLERATED-AND-STRIPPED (deliberate choice, not
 *  strict reject): unknown extra fields on the root or on a tab are ignored
 *  during validation and dropped from the rebuilt result, so an older reader
 *  survives a newer writer's additions while the persisted payload stays in
 *  the declared shape after the next encode. */
export function parseConsoleDraftSnapshot(raw: string): ConsoleDraftSnapshot | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== CONSOLE_DRAFT_SNAPSHOT_VERSION) return null;
  if (!Array.isArray(root.tabs) || root.tabs.length === 0) return null;
  if (root.tabs.length > CONSOLE_DRAFTS_MAX_TABS) return null;
  if (typeof root.activeTabId !== "string") return null;

  const tabs: Array<{ id: string; name: string; buffer: string }> = [];
  for (const entry of root.tabs) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const tab = entry as Record<string, unknown>;
    // Unknown tab fields are tolerated-and-stripped like root extras — only
    // the declared fields are validated and rebuilt below.
    if (typeof tab.id !== "string") return null;
    if (typeof tab.name !== "string") return null;
    if (typeof tab.buffer !== "string") return null;
    if (tab.buffer.length > CONSOLE_DRAFTS_MAX_BUFFER_CHARS) return null;
    tabs.push({ id: tab.id, name: tab.name, buffer: tab.buffer });
  }

  // Active-tab integrity: the id must reference a real restored tab.
  if (!tabs.some((tab) => tab.id === root.activeTabId)) return null;

  return { version: 1, tabs, activeTabId: root.activeTabId };
}
