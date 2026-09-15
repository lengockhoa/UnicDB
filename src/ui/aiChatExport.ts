// src/ui/aiChatExport.ts — TASK-CHATV2-015
//
// Structured Markdown/JSON serializers for a persisted chat session, plus the
// host save orchestration. This replaces V1's DOM-scraped export
// (`webview/aiChatPanelMain.ts:653` scraped `#thread` innerText —
// docs/AI_HANDOFF/notes/chatv2-baseline.md §1.3, forbidden by PLAN §9).
//
// The serializer reads the STRUCTURED `AiChatSessionRecord` ONLY: never the
// DOM, never `innerText`, never raw provider/tool payloads.
//
// The VS Code save itself is reached through a tiny structural port
// (`AiChatExportPort`) so this module is unit-testable without `vscode`; the
// production wiring passes `vscode.window.showSaveDialog` +
// `vscode.workspace.fs.writeFile` (same mechanism as the existing audit-trace
// export in src/extension.ts).
//
// SUCCESS/FAILURE COPY (exact, locked):
//   - success toast is announced ONLY on an `export_completed` frame:
//     `Exported chat`
//   - cancel produces NO success (the caller emits nothing)
//   - failure emits `Could not export chat` plus a safe reason

import {
  migrateSessionRecord,
  scanSessionRecordForForbidden,
  type AiChatSessionRecord,
  type AiChatStoredActivity,
  type AiChatStoredMessage,
} from "./aiChatSessionStore";

/** Schema version stamped into every JSON export. */
export const AI_CHAT_EXPORT_SCHEMA_VERSION = 1 as const;

/** Exact success copy — announced only after the host confirms the write. */
export const EXPORT_SUCCESS_LABEL = "Exported chat";

/** Exact failure title. `safeMessage`/`safeReason` never carries raw detail. */
export const EXPORT_FAILURE_TITLE = "Could not export chat";

export type AiChatExportFormat = "markdown" | "json";

/**
 * One chosen save destination. `uri` is the host's opaque handle (a
 * `vscode.Uri` in production); `name` is the display filename for the
 * completion frame. The export module never inspects `uri`.
 */
export interface AiChatExportDestination {
  readonly name: string;
  readonly uri: unknown;
}

/**
 * Host save port. `chooseDestination` resolves `null` when the user cancels
 * the dialog; `write` rejects when the filesystem write fails.
 */
export interface AiChatExportPort {
  chooseDestination(input: {
    readonly format: AiChatExportFormat;
    readonly defaultFileName: string;
    readonly title: string;
  }): Promise<AiChatExportDestination | null>;
  write(destination: AiChatExportDestination, content: string): Promise<void>;
}

export type AiChatExportResult =
  | { readonly status: "completed"; readonly format: AiChatExportFormat; readonly name: string; readonly bytes: number }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly safeMessage: string; readonly safeReason: string; readonly diagnosticId: string };

const FORBIDDEN_EXPORT_FALLBACK = "Blocked: sensitive data was not included.";

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** Escape the Markdown block-level characters that could restructure output. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

function activityLine(activity: AiChatStoredActivity): string {
  const status =
    activity.status === "ok"
      ? "done"
      : activity.status === "running"
        ? "running"
        : activity.status;
  const duration = activity.durationMs === null ? "" : ` · ${activity.durationMs}ms`;
  return `- ${escapeInline(activity.label)} (${escapeInline(activity.action)}) — ${status}${duration}${activity.summary ? ` · ${escapeInline(activity.summary)}` : ""}`;
}

function contextLine(ref: { label: string; kind: string; status: string }): string {
  return `- ${escapeInline(ref.label)} _(${escapeInline(ref.kind)}, ${ref.status})_`;
}

/**
 * Serialize one session record to Markdown: the VISIBLE transcript (user +
 * assistant text) and SAFE activity summaries. Reasoning text, raw tool
 * output, secrets and attachment bytes never appear because they are never in
 * the record in the first place — and the forbidden-key scan below is a
 * belt that refuses the whole export if one ever were.
 */
export function serializeSessionToMarkdown(record: AiChatSessionRecord): string {
  const lines: string[] = [];
  lines.push(`# ${escapeInline(record.title.length > 0 ? record.title : "Untitled chat")}`);
  lines.push("");
  lines.push(
    `- Session: \`${record.id}\``,
  );
  lines.push(`- Engine: ${escapeInline(record.engine)} · Model: ${escapeInline(record.model)}`);
  lines.push(`- Created: ${record.createdAt}`);
  lines.push(`- Updated: ${record.updatedAt}`);
  lines.push(`- Final state: ${record.terminalState}`);
  if (record.diagnosticIds.length > 0) {
    lines.push(`- Diagnostics: ${record.diagnosticIds.map((d) => `\`${d}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("> Saved UnicDB chat transcript. This is not a provider-native session export.");
  lines.push("");

  for (const message of record.messages) {
    if (message.role === "user") {
      lines.push(`## You`);
      if (message.context !== undefined && message.context.length > 0) {
        lines.push("");
        lines.push("Selected context:");
        for (const ref of message.context) lines.push(contextLine(ref));
      }
      lines.push("");
      lines.push(message.text);
      lines.push("");
      continue;
    }
    lines.push(`## Assistant`);
    if (message.partial === true) {
      lines.push("");
      lines.push("_(stopped — partial response)_");
    }
    lines.push("");
    lines.push(message.text);
    lines.push("");
    if (message.activities !== undefined && message.activities.length > 0) {
      lines.push("Activity:");
      for (const activity of message.activities) lines.push(activityLine(activity));
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Structured JSON payload. `schemaVersion` is mandatory and first-class. */
export interface AiChatSessionExportJson {
  readonly schemaVersion: typeof AI_CHAT_EXPORT_SCHEMA_VERSION;
  readonly kind: "UnicDB.aiChat.session";
  readonly session: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly engine: string;
    readonly model: string;
    readonly terminalState: string;
    readonly diagnosticIds: readonly string[];
    readonly messages: readonly AiChatStoredMessage[];
  };
}

/**
 * Serialize one session record to a structured JSON document. The payload is
 * built from the typed record fields (never a spread of arbitrary input), so
 * an unexpected extra property can never ride out.
 */
export function serializeSessionToJson(record: AiChatSessionRecord): AiChatSessionExportJson {
  return {
    schemaVersion: AI_CHAT_EXPORT_SCHEMA_VERSION,
    kind: "UnicDB.aiChat.session",
    session: {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      engine: record.engine,
      model: record.model,
      terminalState: record.terminalState,
      diagnosticIds: record.diagnosticIds.slice(),
      messages: record.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
        ...(message.partial === true ? { partial: true } : {}),
        ...(message.context !== undefined ? { context: message.context.map((r) => ({ ...r })) } : {}),
        ...(message.activities !== undefined
          ? { activities: message.activities.map((a) => ({ ...a })) }
          : {}),
      })),
    },
  };
}

/** Serialize a record to the exact text written for `format`. */
export function serializeSessionForExport(
  record: AiChatSessionRecord,
  format: AiChatExportFormat,
): string {
  return format === "json"
    ? `${JSON.stringify(serializeSessionToJson(record), null, 2)}\n`
    : serializeSessionToMarkdown(record);
}

/** Default filename for a session + format (a safe slug, never the raw title). */
export function exportFileName(record: AiChatSessionRecord, format: AiChatExportFormat): string {
  const slug =
    record.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unicdb-chat";
  return `${slug}.${format === "json" ? "json" : "md"}`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Short, safe diagnostic id. Deliberately derived from a fixed vocabulary —
 * never from raw error text.
 */
export function exportDiagnosticId(reason: string): string {
  let hash = 0;
  for (let i = 0; i < reason.length; i += 1) {
    hash = (hash * 31 + reason.charCodeAt(i)) >>> 0;
  }
  return `exp-${hash.toString(36).slice(0, 8)}`;
}

/** Map an unknown throw to a short SAFE reason (never a stack/stderr echo). */
function safeReasonFor(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}` : typeof error;
  switch (raw) {
    case "Error":
      return "The chat export could not be written.";
    case "AbortError":
      return "The chat export was interrupted.";
    case "TypeError":
      return "The chat export destination was not writable.";
    default:
      return "The chat export could not be written.";
  }
}

/**
 * Export one session through `port`.
 *
 * - cancel (null destination) → `{ status: "cancelled" }` — the caller emits
 *   NO success frame (task: "cancel = no success").
 * - write failure → `{ status: "failed" }` with the exact `Could not export
 *   chat` title baked into {@link EXPORT_FAILURE_TITLE} and a safe reason.
 * - success → `{ status: "completed" }`; the caller announces
 *   {@link EXPORT_SUCCESS_LABEL} only now.
 *
 * An unsafe record (forbidden key present) fails closed BEFORE any dialog is
 * shown: nothing sensitive is ever offered to the writer.
 */
export async function exportSession(
  record: AiChatSessionRecord,
  format: AiChatExportFormat,
  port: AiChatExportPort,
): Promise<AiChatExportResult> {
  const safety = scanSessionRecordForForbidden(record);
  if (!safety.ok) {
    const reason = FORBIDDEN_EXPORT_FALLBACK;
    return {
      status: "failed",
      safeMessage: EXPORT_FAILURE_TITLE,
      safeReason: reason,
      diagnosticId: exportDiagnosticId(reason),
    };
  }

  const defaultFileName = exportFileName(record, format);
  let destination: AiChatExportDestination | null;
  try {
    destination = await port.chooseDestination({
      format,
      defaultFileName,
      title: format === "json" ? "Export chat as JSON" : "Export chat as Markdown",
    });
  } catch {
    const reason = safeReasonFor(new TypeError("dialog"));
    return {
      status: "failed",
      safeMessage: EXPORT_FAILURE_TITLE,
      safeReason: reason,
      diagnosticId: exportDiagnosticId(reason),
    };
  }
  if (destination === null) return { status: "cancelled" };

  const content = serializeSessionForExport(record, format);
  try {
    await port.write(destination, content);
  } catch (error) {
    const reason = safeReasonFor(error);
    return {
      status: "failed",
      safeMessage: EXPORT_FAILURE_TITLE,
      safeReason: reason,
      diagnosticId: exportDiagnosticId(reason),
    };
  }
  return {
    status: "completed",
    format,
    name: destination.name,
    bytes: content.length,
  };
}

/** Re-export the parser so a host can validate a re-imported export. */
export { migrateSessionRecord };
