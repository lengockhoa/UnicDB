// src/ui/aiChatPanelMessages.ts
// Message protocol between AiChatPanel (host) and the webview chat UI.
// Mirrors the house pattern (aiSettingsFormMessages.ts / newTableFormMessages.ts):
// type discriminator, unknown ignored.
//
// SECURITY: aiChatPanel NEVER carries apiKey material. Errors surface message
// strings only (provider scrubs upstream). The host may post `step` labels
// and `assistant` text; the webview may request send/stop/clear and may
// respond to permission requests with one opaque {requestId, optionId?}.

import type { ChatMessage } from "../ai/provider";

// ---- Host → Webview --------------------------------------------------------

export interface AiChatPanelInit {
  type: "init";
  /** True iff the panel already holds multi-turn history. */
  hasHistory: boolean;
}

/** A tool or thinking step the agent took this turn. */
export interface AiChatPanelStep {
  type: "step";
  /** Short human label for the step (tool name or action). */
  label: string;
}

/** Final assistant reply for the current turn. */
export interface AiChatPanelAssistant {
  type: "assistant";
  text: string;
  /** True if text contains markdown that the webview should render. */
  markdown: boolean;
}

/** Non-fatal error bubble (provider messages are apiKey-FREE). */
export interface AiChatPanelError {
  type: "error";
  message: string;
}

/** Turn boundary: host promises no further assistant/step/error for this turn. */
export interface AiChatPanelDone {
  type: "done";
}

export interface AiChatPanelDelta {
  type: "delta";
  /** Incremental text from an in-flight assistant message (omp streaming). */
  text: string;
}

/** Engine mode announcement — emitted exactly once when panel first resolves engine. */
export interface AiChatPanelEngine {
  type: "engine";
  name: "omp" | "builtin";
  /** Hint shown to user when engine is not omp (install/update instructions). */
  hint?: string;
}

/** A single permission choice the user may grant for an ACP server request.
 * The `requestId` is a host-generated opaque token; the webview must echo it
 * back verbatim when the user picks an option (or denies). The webview never
 * invents or rewrites IDs — it only renders names + details verbatim as text
 * and emits the literal ID it was given. */
export interface AiChatPanelPermissionRequest {
  type: "permission_request";
  requestId: string;
  tool: {
    id: string;
    name: string;
    detail: string;
  };
  options: Array<{
    optionId: string;
    label: string;
  }>;
}

export type AiChatPanelHostMessage =
  | AiChatPanelInit
  | AiChatPanelStep
  | AiChatPanelDelta
  | AiChatPanelAssistant
  | AiChatPanelError
  | AiChatPanelEngine
  | AiChatPanelDone
  | AiChatPanelPermissionRequest;

// ---- Webview → Host --------------------------------------------------------

/** Webview mounted; host posts init. */
export interface AiChatPanelReady {
  type: "ready";
}

/** User pressed Send; text is non-empty after host guard. */
export interface AiChatPanelSend {
  type: "send";
  text: string;
}

/** User pressed Stop mid-turn; host flips abort token. */
export interface AiChatPanelStop {
  type: "stop";
}

/** User pressed Clear; host resets internal history. */
export interface AiChatPanelClear {
  type: "clear";
}

/** Webview answered a single host `permission_request`. `requestId` is the
 * opaque ID the host posted. If the user picked an option, `optionId` is its
 * opaque ID; if the user denied (or the request timed out / was replaced),
 * `optionId` is omitted entirely from the wire — never undefined/null. */
export interface AiChatPanelPermissionResponse {
  type: "permission_response";
  requestId: string;
  optionId?: string;
}

export type AiChatPanelWebviewMessage =
  | AiChatPanelReady
  | AiChatPanelSend
  | AiChatPanelStop
  | AiChatPanelClear
  | AiChatPanelPermissionResponse;

// ---- Internal host helpers (not webview-bound) ----------------------------

/** Snapshot of host-side history for replay into the next run. */
export type HostHistory = ChatMessage[];
