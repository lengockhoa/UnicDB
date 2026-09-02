// src/core/diagnostics.ts
// TASK-ARP09-001 — pure redacted diagnostics formatter.
//
// PURE module (no vscode, no fs, no net): turns category/severity/message
// (+ optional correlation id and test-seam timestamp) into ONE redacted,
// single-line string. Secrets are scrubbed by reusing `redact()` from
// src/ai/trace.ts — imported, never re-implemented. The MAX_DIAG_LINE_CHARS
// bound is applied to the FULLY ASSEMBLED line as the last step, so the
// prefix survives and only the message tail gets truncated. Never throws
// on any input (string/number/object/null/undefined/circular).
import { redact } from "../ai/trace";

export type DiagCategory = "lifecycle" | "connection" | "ai" | "schema" | "general";
export type DiagSeverity = "info" | "warn" | "error";

/** Hard bound on the fully assembled diagnostic line (prefix + message + suffix). */
export const MAX_DIAG_LINE_CHARS = 2000;

/** Correlation ids are auxiliary metadata — never allowed to eat the budget. */
const MAX_CORRELATION_ID_CHARS = 64;

/** Safe ISO timestamp — an invalid Date must not throw, fall back to now. */
function safeIso(now?: Date): string {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  return new Date().toISOString();
}

/** Total message → redacted single-line string. JSON fallback → String(). */
function toRedactedSingleLine(message: unknown): string {
  let raw: string;
  if (typeof message === "string") {
    raw = message;
  } else if (message === null || message === undefined) {
    raw = String(message); // "null" / "undefined"
  } else {
    try {
      const json = JSON.stringify(message);
      raw = json === undefined ? String(message) : json;
    } catch {
      raw = String(message); // circular / pathological objects
    }
  }
  // redact() first (pure, never throws), THEN strip line breaks so the
  // scrub replacement tokens can never be split across "lines".
  const scrubbed = redact(raw);
  const text = typeof scrubbed === "string" ? scrubbed : String(scrubbed);
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** Single-line, trimmed, bounded correlation id (or undefined when empty). */
function safeCorrelationId(correlationId: unknown): string | undefined {
  if (typeof correlationId !== "string") return undefined;
  const id = correlationId.replace(/\r\n|\r|\n/g, " ").trim().slice(0, MAX_CORRELATION_ID_CHARS);
  return id.length > 0 ? id : undefined;
}

/**
 * Format one diagnostic line:
 * `[<ISO time>] [<category>] [<severity>] <redacted single-line message>`
 * plus ` (corr:<id>)` when a non-empty correlation id is given.
 * The assembled line is trimmed and bounded to MAX_DIAG_LINE_CHARS as the
 * LAST step. Never throws on any input.
 */
export function logLine(
  category: DiagCategory,
  severity: DiagSeverity,
  message: unknown,
  correlationId?: string,
  now?: Date,
): string {
  try {
    const corr = safeCorrelationId(correlationId);
    const line =
      `[${safeIso(now)}] [${category}] [${severity}] ${toRedactedSingleLine(message)}` +
      (corr === undefined ? "" : ` (corr:${corr})`);
    const bounded = line.length > MAX_DIAG_LINE_CHARS ? line.slice(0, MAX_DIAG_LINE_CHARS) : line;
    return bounded.trim();
  } catch {
    // Last-resort total fallback: still a valid single line, still bounded.
    try {
      return `[${new Date().toISOString()}] [general] [error] <diagnostics failure>`.slice(
        0,
        MAX_DIAG_LINE_CHARS,
      );
    } catch {
      return "[general] [error] <diagnostics failure>";
    }
  }
}
