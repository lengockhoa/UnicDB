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
// TASK-001 (cycle AB): MinimalAttachment is the wire shape the webview sends
// over for each image attachment. The single source of truth lives in
// src/ui/aiChatAttachments.ts (task-005); we re-export here so consumers
// can import it from either module without a hidden dep.
import type { MinimalAttachment } from "./aiChatAttachments";
export type { MinimalAttachment };

export interface AiChatPanelInit {
  type: "init";
  /** True iff the panel already holds multi-turn history. */
  hasHistory: boolean;
  /**
   * TASK-001 (cycle AB): true iff the active AI role's `models.<role>.vision`
   * is on at panel-ready time. Source: `AiConfigStore.loadSettings()`. The
   * webview gates the attach button + clipboard-paste-image affordances on
   * this flag and rejects with an inline amber notice when false. NEVER
   * carries apiKey material.
   */
  visionCapable: boolean;
}
// TASK-003 D2: init{hasHistory:false} doubles as a host-driven panel
// reset signal — Clear emits it after cancelling the in-flight turn.
// The webview applies it as "force idle": de-stream open bubble +
// re-enable input. Webview-only contract; shape unchanged.

/** A tool or thinking step the agent took this turn. */
export interface AiChatPanelStep {
  type: "step";
  /** Short human label for the step (tool name or action). */
  label: string;
}
/** AIX-03: a visible tool-call outcome card. `summary` is SHAPE ONLY
 * (never row bytes): built by the host from the result text's shape. */
export interface AiChatPanelToolResult {
  type: "tool_result";
  tool: string;
  status: "ok" | "failed" | "denied";
  summary: string;
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

/** TASK-001: a live piece of the agent's reasoning chain, forwarded verbatim
 * from ACP `agent_thought_chunk` notifications. Never carries apiKey; the
 * webview renders these into a collapsible "Thinking" block (TASK-002).
 * Thoughts NEVER enter `session.buffer` or `this.history`. */
export interface AiChatPanelThought {
  type: "thought";
  text: string;
}

/** Engine mode announcement — emitted exactly once when panel first resolves engine. */
export interface AiChatPanelEngine {
  type: "engine";
  name: "omp" | "builtin";
  /** Hint shown to user when engine is not omp (install/update instructions). */
  hint?: string;
  /** Detected omp version for the banner, e.g. "18.0.1". Absent for builtin. */
  version?: string;
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
/** TASK-001 (cycle AB): host → webview rejection for one attachment.
 * The webview surfaces this as an amber notice naming the offending file.
 * Reasons:
 *   - `oversize`        : attachment.bytes > MAX_ATTACH_BYTES (5 MB).
 *   - `count_cap`       : caller sent > MAX_ATTACHMENTS_PER_TURN (4); this
 *                         single rejection covers the suffix drop.
 *   - `unsupported_type`: mime not in ATTACH_ALLOWED_MIME.
 *   - `mime_mismatch`   : declared mime disagrees with the magic bytes of the
 *                         base64 payload (defense-in-depth against a
 *                         `image/jpeg` blob that is actually `application/
 *                         octet-stream`).
 *   - `vision_unsupported`: model/engine cannot accept images (model.vision
 *                         === false OR engine === "omp"); ALL attachments
 *                         are rejected and the text-only turn proceeds.
 * `id` is the attachment id the webview sent; `message` is a human-readable
 * string. NEVER carries apiKey material. */
export interface AiChatPanelAttachError {
  type: "attach_error";
  id: string;
  reason:
    | "oversize"
    | "count_cap"
    | "unsupported_type"
    | "mime_mismatch"
    | "vision_unsupported";
  message: string;
}

/** AIX-01: host-side summary of what was attached to the turn as
 *  grounded workspace context. Webview shows this as chips. */
export interface AiChatPanelGroundingState {
  type: "grounding_state";
  selectionPath: string | null;
  fileCount: number;
  excludedCount: number;
  turnId: string;
}


export type AiChatPanelHostMessage =
  | AiChatPanelInit
  | AiChatPanelStep
  | AiChatPanelToolResult
  | AiChatPanelDelta
  | AiChatPanelThought
  | AiChatPanelAssistant
  | AiChatPanelError
  | AiChatPanelEngine
  | AiChatPanelDone
  | AiChatPanelPermissionRequest
  | AiChatPanelResumeSessions
  | AiChatPanelHistory
  | AiChatPanelMentionObjects
  | AiChatPanelMentionMiss
  | AiChatPanelAttachError
  | AiChatPanelGroundingState;

/** TASK-005: host answer for `mention_list` (≤30 DB objects + ≤20 files).
 * Each item carries `kind` discriminator (table|view|routine|file), a
 * `label` for primary text, `detail` for the secondary line (schema, kind
 * badge, file size), and the `token` the webview will insert verbatim.
 * `token` is the exact text inserted into the textarea (e.g. "public.users"
 * for a table; "src/foo.ts" for a file). Webview filters client-side on
 * each keystroke; the host posts the full list once per `@` keyup and the
 * webview narrows. */
export interface AiChatPanelMentionObjects {
  type: "mention_objects";
  items: Array<{
    kind: "table" | "view" | "routine" | "file";
    label: string;
    detail: string;
    token: string;
  }>;
}

/** TASK-005: host reports a token that the user mentioned but the host
 * could not resolve (no matching DB object AND no matching workspace file).
 * Webview surfaces this as an inline notice bubble so the user knows the
 * mention was silently dropped without throwing. */
export interface AiChatPanelMentionMiss {
  type: "mention_miss";
  token: string;
}

/** Render cap for `history` items posted to the webview (TASK-003 §Interfaces). */
export const HISTORY_RENDER_CAP = 50;

/** Webview opened the resume picker. Host lists sessions for the active cwd. */
export interface AiChatPanelResumeList {
  type: "resume_list";
}

/** Webview picked a session to resume. `sessionId` is the opaque id the host posted
 * in `resume_sessions`. */
export interface AiChatPanelResumePick {
  type: "resume_pick";
  sessionId: string;
}

/** Webview cancelled the resume picker. Host may discard any in-flight load. */
export interface AiChatPanelResumeCancel {
  type: "resume_cancel";
}

/** TASK-001: user pressed Regenerate (UI affordance lives in the webview).
 * The host pops the trailing `[user, assistant]` history pair and re-runs
 * the normal send path with the popped user text, so the chat gains exactly
 * one new pair — no duplicate pair ever. Busy (turn in flight) and empty
 * history are no-ops. After a Stop, the stopped user message is the last
 * UI exchange but was never pushed to history; in that case Regenerate
 * re-sends the stopped text verbatim (PLAN §3 supersession note). */
export interface AiChatPanelRegenerate {
  type: "regenerate";
}

/** Host answer for `resume_list`: ≤20 entries, cwd-filtered, sorted updatedAt desc,
 * current panel sessionId removed. Label is `title` if non-empty, else `"(untitled)"`;
 * detail carries message count (e.g. "12 messages"). */
export interface AiChatPanelResumeSessions {
  type: "resume_sessions";
  sessions: Array<{
    sessionId: string;
    label: string;
    detail: string;
  }>;
}

/** Host answer for `resume_pick`: replay-derived history items in original order,
 * capped at HISTORY_RENDER_CAP. If the cap truncated, `truncated === true` and
 * `truncatedCount` carries how many older items were omitted. */
export interface AiChatPanelHistory {
  type: "history";
  items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
  truncated: boolean;
  truncatedCount: number;
}

// ---- Webview → Host --------------------------------------------------------

/** Webview mounted; host posts init. */
export interface AiChatPanelReady {
  type: "ready";
}

/** User pressed Send; text is non-empty after host guard. */
export interface AiChatPanelSend {
  type: "send";
  text: string;
  /**
   * TASK-001 (cycle AB): optional list of image attachments the user
   * dropped on the composer or pasted from the clipboard. The host
   * validates bytes + count + MIME + magic bytes, gates on vision/engine,
   * and forwards surviving attachments as ChatContentPart[] image_url
   * parts on the user message. Absent OR empty array → legacy text-only
   * path (cycle AA baseline). NEVER carries apiKey material.
   */
  attachments?: MinimalAttachment[];
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

/** Local slash command requiring host settings/state access. */
export interface AiChatPanelCommand {
  type: "command";
  command: "engine" | "model";
  args: string[];
}

export type AiChatPanelWebviewMessage =
  | AiChatPanelReady
  | AiChatPanelSend
  | AiChatPanelStop
  | AiChatPanelClear
  | AiChatPanelPermissionResponse
  | AiChatPanelResumeList
  | AiChatPanelResumePick
  | AiChatPanelResumeCancel
  | AiChatPanelRegenerate
  | AiChatPanelCommand
  | AiChatPanelMentionList
  | { type: "grounding_toggle"; enabled: boolean };

/** TASK-005: webview opened the @-mention dropdown. `query` is the
 * substring after the leading `@` (e.g. "pu" or ""). The host responds
 * with `{type:"mention_objects", items:[…]}` (≤30 DB objects + ≤20 files).
 * Empty query → return the full shortlist. */
export interface AiChatPanelMentionList {
  type: "mention_list";
  query: string;
}

// ---- Internal host helpers (not webview-bound) ----------------------------

/** Snapshot of host-side history for replay into the next run. */
export type HostHistory = ChatMessage[];
