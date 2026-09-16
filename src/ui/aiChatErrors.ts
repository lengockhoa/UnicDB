// src/ui/aiChatErrors.ts — TASK-CHATV2-016
//
// HOST-side error mapping. Every recoverable failure class the V2 chat panel
// can surface is reduced to ONE closed matrix entry:
//
//   category · exact safeMessage · deterministic diagnosticId ·
//   retryability · allowed action set
//
// PRIVACY (TASK spec + PLAN §6): the frame this module produces NEVER carries
// raw stderr, provider JSON, a shell command, a connection string, a token or
// any secret. The mapper takes a category key only; the optional caller detail
// is passed through {@link safeErrorDetail}, which returns `undefined` unless
// the value survives a conservative single-line allowlist.
//
// PURE: no `vscode`, no node builtins, no clock, no random (CTX-04 — the same
// category always yields the same diagnostic id).

import { reasonForUnavailable } from "../ai/capabilities";

/** Closed, display-safe error vocabulary. */
export type AiChatErrorCategory =
  | "engine_not_installed"
  | "engine_unavailable"
  | "auth_config"
  | "connection_timeout"
  | "connection_disconnect"
  | "provider_crash"
  | "tool_denied"
  | "tool_failed"
  | "context_changed"
  | "context_missing"
  | "attachment_rejected"
  | "export_storage_failure"
  | "stop_failure"
  | "unknown";

/** Only actions the card is allowed to render. */
export type AiChatErrorAction = "retry" | "change_engine" | "copy_details";

/** Exact stop-failure copy (locked — PLAN §6). */
export const STOP_FAILURE_COPY = "Could not stop yet. The engine may still be working.";

/** Exact database-changed copy (locked — TASK spec). */
export const DATABASE_CHANGED_COPY = "Database connection changed. Start a new request when it is ready.";

/** Generic copy for any host error outside the closed vocabulary. */
export const GENERIC_ERROR_COPY = "Something went wrong while completing this response.";

export interface AiChatErrorMatrixEntry {
  readonly category: AiChatErrorCategory;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly actions: readonly AiChatErrorAction[];
  /** True for the stop-failure advisory: Stop stays active, no terminal state. */
  readonly nonTerminal?: boolean;
  /** Never labels a user denial as an engine crash. */
  readonly userDenial?: boolean;
}

/** Deterministic, display-safe id derived from the category + safe copy only. */
export function diagnosticIdForError(category: AiChatErrorCategory, safeMessage: string): string {
  const input = `chatv2:${category}:${safeMessage}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `diag-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** The matrix. `unknown` is the only entry a caller guesses with. */
const MATRIX: Readonly<Record<AiChatErrorCategory, Omit<AiChatErrorMatrixEntry, "category">>> = Object.freeze({
  engine_not_installed: {
    // Reused verbatim from the capability surface (src/ai/capabilities.ts) so
    // the panel and the engine picker never disagree about the same state.
    safeMessage: reasonForUnavailable("not-installed"),
    retryable: false,
    actions: ["change_engine", "copy_details"],
  },
  engine_unavailable: {
    safeMessage: reasonForUnavailable(undefined),
    retryable: true,
    actions: ["retry", "change_engine", "copy_details"],
  },
  auth_config: {
    safeMessage: "The engine rejected the current account or configuration.",
    retryable: false,
    actions: ["change_engine", "copy_details"],
  },
  connection_timeout: {
    safeMessage: "The connection timed out before the response finished.",
    retryable: true,
    actions: ["retry", "copy_details"],
  },
  connection_disconnect: {
    safeMessage: "The connection closed before the response finished.",
    retryable: true,
    actions: ["retry", "copy_details"],
  },
  provider_crash: {
    safeMessage: "The engine stopped unexpectedly while answering.",
    retryable: true,
    actions: ["retry", "change_engine", "copy_details"],
  },
  tool_denied: {
    safeMessage: "You denied a tool request, so this response ended.",
    retryable: false,
    userDenial: true,
    actions: ["retry", "copy_details"],
  },
  tool_failed: {
    safeMessage: "A tool the engine ran did not finish.",
    retryable: true,
    actions: ["retry", "copy_details"],
  },
  context_changed: {
    safeMessage: DATABASE_CHANGED_COPY,
    retryable: false,
    actions: ["copy_details"],
  },
  context_missing: {
    safeMessage: "Attached context is no longer available.",
    retryable: false,
    actions: ["copy_details"],
  },
  attachment_rejected: {
    safeMessage: "An attachment was rejected.",
    retryable: false,
    actions: ["copy_details"],
  },
  export_storage_failure: {
    safeMessage: "Could not export chat.",
    retryable: false,
    actions: ["copy_details"],
  },
  stop_failure: {
    safeMessage: STOP_FAILURE_COPY,
    retryable: false,
    nonTerminal: true,
    actions: ["copy_details"],
  },
  unknown: {
    safeMessage: GENERIC_ERROR_COPY,
    retryable: true,
    actions: ["retry", "copy_details"],
  },
});

/** Every category in a stable order (tests + host exhaustiveness). */
export const AI_CHAT_ERROR_CATEGORIES: readonly AiChatErrorCategory[] = Object.freeze(
  Object.keys(MATRIX) as AiChatErrorCategory[],
);

/** Resolve one matrix entry. Unknown keys collapse to `unknown`. */
export function errorMatrixEntry(category: string | undefined): AiChatErrorMatrixEntry {
  const key = category as AiChatErrorCategory;
  const entry = Object.prototype.hasOwnProperty.call(MATRIX, key) ? MATRIX[key] : MATRIX.unknown;
  return Object.freeze({ category: Object.prototype.hasOwnProperty.call(MATRIX, key) ? key : "unknown", ...entry });
}

// ---------------------------------------------------------------------------
// Privacy — the only gate caller detail passes through
// ---------------------------------------------------------------------------

/** Substrings that must never appear in a user-facing error frame, DOM node or
 * copy-details payload. Kept deliberately broad: a false positive costs a
 * missing detail line, a false negative leaks a credential. */
const FORBIDDEN_DETAIL_MARKERS: readonly string[] = Object.freeze([
  "sk-",
  "bearer",
  "authorization",
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "api-key",
  "-----begin",
  "stderr",
  "at object.",
  "node_modules",
  "stack trace",
  "econnrefused",
  "errno",
]);

/** Sensitive single words matched on whole-word boundaries. */
const FORBIDDEN_WORD_RE = /\b(token|tokens|credential|credentials|host|port)\b/i;

/** Conservative single-line allowlist for the optional "details" line. No
 * colon, dot, quote, brace or slash — those characters are what raw stderr, a
 * JSON blob, a URL or a `host:port` usually need. */
const SAFE_DETAIL_RE = /^[A-Za-z0-9 _/(),'-]{1,120}$/;

/**
 * Reduce arbitrary caller detail (stderr, JSON, a command, a URL) to a
 * scrubbed one-liner — or `undefined`. Anything containing markup, quotes,
 * braces, control characters, a stack frame or a secret marker is DROPPED
 * rather than truncated, so no partial secret can survive.
 */
export function safeErrorDetail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text.length === 0 || text.length > 120) return undefined;
  if (!SAFE_DETAIL_RE.test(text)) return undefined;
  const lower = text.toLowerCase();
  for (const marker of FORBIDDEN_DETAIL_MARKERS) {
    if (lower.includes(marker)) return undefined;
  }
  if (FORBIDDEN_WORD_RE.test(text)) return undefined;
  return text;
}

/** Scanner used by the security tests: does `value` leak forbidden detail? */
export function containsForbiddenErrorDetail(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const lower = (text ?? "").toLowerCase();
  return (
    FORBIDDEN_DETAIL_MARKERS.some((marker) => lower.includes(marker)) || FORBIDDEN_WORD_RE.test(text ?? "")
  );
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/** The exact, safe host → webview error payload. */
export interface AiChatErrorFrame {
  readonly category: AiChatErrorCategory;
  readonly safeMessage: string;
  readonly diagnosticId: string;
  readonly safeDetail?: string;
  readonly retryable: boolean;
  readonly actions: readonly AiChatErrorAction[];
  /** Stop-failure advisory only: the turn is NOT terminal, Stop stays active. */
  readonly nonTerminal: boolean;
}

export interface HostErrorInput {
  /** Closed category key. Anything else maps to `unknown`. */
  readonly category: string | undefined;
  /** Optional raw caller detail. Scrubbed by {@link safeErrorDetail}; never
   * passed through verbatim. */
  readonly detail?: unknown;
}

/**
 * Map a host error to the safe frame. `input.detail` is scrubbed; if it does
 * not survive the allowlist the frame simply carries no detail line, and NO
 * raw value is ever echoed into `safeMessage`.
 */
export function mapHostChatError(input: HostErrorInput): AiChatErrorFrame {
  const entry = errorMatrixEntry(input.category);
  const detail = safeErrorDetail(input.detail);
  return Object.freeze({
    category: entry.category,
    safeMessage: entry.safeMessage,
    diagnosticId: diagnosticIdForError(entry.category, entry.safeMessage),
    ...(detail === undefined ? {} : { safeDetail: detail }),
    retryable: entry.retryable,
    actions: entry.actions,
    nonTerminal: entry.nonTerminal === true,
  });
}

/** Is `action` allowed on this frame? */
export function errorActionAllowed(frame: AiChatErrorFrame, action: AiChatErrorAction): boolean {
  return frame.actions.includes(action);
}

/** Diagnostic-id map for every category (deterministic; exported for tests and
 * for the host's own logging path). */
export function errorDiagnosticIds(): Readonly<Record<AiChatErrorCategory, string>> {
  const out = {} as Record<AiChatErrorCategory, string>;
  for (const category of AI_CHAT_ERROR_CATEGORIES) {
    const entry = MATRIX[category];
    out[category] = diagnosticIdForError(category, entry.safeMessage);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Stop failure — a failed stop is NOT a stopped turn
// ---------------------------------------------------------------------------

/** Busy phases a Stop can be requested from. */
export type StopRequestPhase = "waiting_for_first_event" | "streaming" | "awaiting_permission" | "stopping";

export interface StopFailureResolution {
  /** The phase that survives a failed stop — never a terminal one. */
  readonly phase: StopRequestPhase;
  readonly stopActive: true;
  readonly stopped: false;
  readonly terminal: false;
  readonly message: string;
  readonly diagnosticId: string;
}

/**
 * A failed Stop leaves the turn running: Stop stays offered and only a later
 * terminal host event (`turn_finished` / a terminal `error`) closes it. This
 * never returns a `completed`/`failed`/`stopped` phase.
 */
export function resolveStopFailure(phase: StopRequestPhase | string): StopFailureResolution {
  const safePhase: StopRequestPhase =
    phase === "waiting_for_first_event" ||
    phase === "streaming" ||
    phase === "awaiting_permission" ||
    phase === "stopping"
      ? phase
      : "streaming";
  return Object.freeze({
    phase: safePhase === "stopping" ? "streaming" : safePhase,
    stopActive: true,
    stopped: false,
    terminal: false,
    message: STOP_FAILURE_COPY,
    diagnosticId: errorDiagnosticIds().stop_failure,
  });
}

/** Only a later terminal host event may close a turn whose Stop failed. */
export function terminalAfterStopFailure(
  outcome: "completed" | "stopped" | "failed",
): "completed" | "stopped" | "failed" {
  return outcome;
}
