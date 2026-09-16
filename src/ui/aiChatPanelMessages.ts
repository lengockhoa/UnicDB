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
// TASK-AGTUI-002: AiModelRole is the closed set used by the new
// `models` (host→webview) and `model_select` (webview→host) wire frames.
// Re-export so downstream consumers (TASK-AGTUI-006/007) can pull both the
// role literal type and the message types from this single module.
import type { AiModelRole } from "../ai/settings";
export type { AiModelRole };
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
  /**
   * TASK-011: widened to the full `AiEngine` vocabulary. The webview must
   * accept `omp` (legacy), `claude-code` (TASK-009), `codex` (TASK-010),
   * and `builtin` (fallback / no-omp). The closed-set change was driven by
   * the panel dispatch refactor (engine state is decided eagerly on first
   * ready, not by late capability discovery).
   */
  name: "omp" | "claude-code" | "codex" | "builtin";
  /** Hint shown to user when engine is not omp (install/update instructions). */
  hint?: string;
  /** Detected omp version for the banner, e.g. "18.0.1". Absent for builtin. */
  version?: string;
}

/** AIX-05: live OMP turn-lifecycle state. The host posts one transition
 * per phase (connecting → running → done/error) so the webview shows
 * session state, not just the static engine banner. `turnId` is a
 * monotonically increasing per-panel counter that stays stable across the
 * trio of posts for one turn. */
export interface AiChatPanelSessionState {
  type: "session_state";
  state: "connecting" | "running" | "done" | "error";
  turnId: string;
}

/** TASK-AIX05-103: one of the six exact OMP engine lifecycle literals,
 * mirrored verbatim from `AcpProcess`'s `OmpEngineState`. The literal set
 * is closed — no synonymous state literals exist on the wire. */
export type OmpEngineLifecycleState =
  | "stopped"
  | "starting"
  | "ready"
  | "cancelling"
  | "crashed"
  | "fallback-builtin";

/** Host → webview: OMP engine runtime lifecycle (banner chip). */
export interface AiChatPanelEngineState {
  type: "engine_state";
  state: OmpEngineLifecycleState;
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

/** TASK-ARP06-005: per-turn usage + governance notice, posted once per
 * completed builtin turn on the done path (OMP turns post it with
 * `unknown: true` — no usage numbers exist there, and none are invented).
 *
 * PRIVACY INVARIANT (hard): this frame is SHAPE-SAFE by contract — numeric
 * fields + the policy notice string ONLY. It NEVER carries prompt text,
 * SQL, secrets/apiKeys, trace content, or tool names/arguments. The
 * webview must render it as a textContent-only status chip.
 *
 * `unknown: true` mirrors `TurnUsageSummary` (src/ai/agent): no completed
 * step reported a nonzero token count, so the totals must be treated as
 * unknown — never as an invented zero-cost turn. */
export interface AiChatPanelUsage {
  type: "usage";
  /** Exact summed input tokens for THIS turn (0 when unknown). */
  inputTokens: number;
  /** Exact summed output tokens for THIS turn (0 when unknown). */
  outputTokens: number;
  /** True iff the turn's usage is unknown — do not render the zeros as
   * confirmed cost. */
  unknown: boolean;
  /** Running panel-session totals across all posted usage frames
   * (host-side accumulator). */
  sessionTokens: { inputTokens: number; outputTokens: number };
  /** "" when the effective policy allows; otherwise the user-visible
   * policy denial notice from `EffectivePolicy.notice`. */
  policyNotice: string;
}

/** TASK-AGTUI-002: host → webview announcement of the active model role and
 * the full set of configured roles. Posted once on panel-ready so the
 * webview can render the role chip (header — TASK-AGTUI-003) and gate the
 * model picker. `active` MUST be one of the roles in `roles` (the host
 * reconciles them before posting). `roles[]` is the empty list when
 * nothing is configured — that is the "nothing configured" signal, NOT a
 * schema violation. Shape is purely additive; no field on this frame may
 * carry apiKey material. */
export interface AiChatPanelModels {
  type: "models";
  active: AiModelRole;
  roles: Array<{ role: AiModelRole; modelId: string; vision: boolean }>;
}


/** AIX-04: a reviewed change plan card (plan_change tool result). The
 * webview renders statements + danger tiers + drift and shows Approve/
 * Reject; the host funnels approve through confirmDangerousStatements. */
export interface AiChatPanelChangePlan {
  type: "change_plan";
  tool: string;
  plan: {
    intent: string;
    statements: Array<{ sql: string; tier: string; dangerNote: string }>;
    drift: string[];
    drifted: boolean;
  };
}

/** AIX-04: webview → host — user approved the plan (run the statements). */
export interface AiChatPanelPlanApprove {
  type: "plan_approve";
}

/** AIX-04: webview → host — user rejected the plan. */
export interface AiChatPanelPlanReject {
  type: "plan_reject";
}

export type AiChatPanelHostMessage =
  | AiChatPanelInit
  | AiChatPanelChangePlan
  | AiChatPanelStep
  | AiChatPanelToolResult
  | AiChatPanelDelta
  | AiChatPanelThought
  | AiChatPanelAssistant
  | AiChatPanelError
  | AiChatPanelSessionState
  | AiChatPanelEngine
  | AiChatPanelEngineState
  | AiChatPanelDone
  | AiChatPanelPermissionRequest
  | AiChatPanelResumeSessions
  | AiChatPanelHistory
  | AiChatPanelMentionObjects
  | AiChatPanelMentionMiss
  | AiChatPanelAttachError
  | AiChatPanelGroundingState
  | AiChatPanelUsage
  | AiChatPanelModels
  | AiChatPanelSchemaChanged;

/** ACTIVE-SCHEMA chip — host → chat webview. Posted whenever the
 *  active connection's pinned schema changes (status-bar click, the
 *  chat chip itself, or any other surface that mutates
 *  `ActiveSchemaStore`). The webview keeps the composer chip label
 *  in sync; the click handler routes back to `UnicDB.selectActiveSchema`
 *  which goes through the same store, so all chips stay coherent. */
export interface AiChatPanelSchemaChanged {
  type: "schemaChanged";
  schema: string | undefined;
  /** Connection id the schema belongs to. Undefined when there is no
   *  active connection (webview should show "default"). */
  connectionId: string | undefined;
}

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

/** TASK-AGTUI-002: webview → host — user picked a different active model
 * role (header chip — TASK-AGTUI-003). Kept as a dedicated message rather
 * than reusing `AiChatPanelCommand("model")` so the chip path stays typed
 * and does NOT inherit the slash-command echo behavior. The host applies
 * `role` to the active engine on receipt; the webview does NOT mutate
 * local state until the next `models` frame arrives. */
export interface AiChatPanelModelSelect {
  type: "model_select";
  role: AiModelRole;
}

/** TASK-AGTUI-002: webview → host — user toggled the "bypass permissions"
 * affordance in the composer (TASK-AGTUI-004). When `enabled` is true the
 * host will skip future permission prompts for this session until the
 * webview posts `enabled: false` again or the panel closes. The webview
 * does NOT gate outgoing messages on this flag; the host owns the
 * authoritative policy. */
export interface AiChatPanelBypassPermissions {
  type: "bypass_permissions";
  enabled: boolean;
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
  | AiChatPanelModelSelect
  | AiChatPanelBypassPermissions
  | AiChatPanelMentionList
  | AiChatPanelPlanApprove
  | AiChatPanelPlanReject
  | { type: "grounding_toggle"; enabled: boolean }
  // ACTIVE-SCHEMA chip — chat composer schema chip click. Mirrors
  // `PickActiveSchemaMessage` in `messages.ts`; typed inline (instead
  // of imported) so the chat webview bundle keeps its own narrow
  // message contract.
  | { type: "pickActiveSchema" };

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

// ===========================================================================
// V2 protocol — TASK-CHATV2-003
//
// Ordered, versioned host/webview contract that replaces the V1 shapes above
// across CHATV2-004…017. Every frame carries `protocolVersion: 2`,
// `sessionId` and a monotonic `sequence`; turn-scoped frames additionally
// carry `turnId`. V1 discriminators are NOT reused with a different meaning —
// the V2 frames live under a distinct `kind` field.
//
// The V1→V2 bridge is the single temporary module
// `src/ui/aiChatPanelV1Adapter.ts` (deleted in CHATV2-017); no V1 translation
// logic may spread into components.
//
// SECURITY: no frame may represent raw provider/secret/base64 payloads.
// `findForbiddenFieldV2` is the shape guard the protocol tests apply to every
// fixture; `error` exposes only `safeMessage` + `diagnosticId` (+ optional
// `safeDetail`).
// ===========================================================================

import type { AiEngineName, EngineCapabilitySnapshot } from "../ai/capabilities";

/** The one live protocol version. Bump only with a migration task. */
export const AI_CHAT_PROTOCOL_VERSION_V2 = 2 as const;
export type AiChatProtocolVersionV2 = typeof AI_CHAT_PROTOCOL_VERSION_V2;

/** Ordered envelope shared by every V2 host frame. */
export interface AiChatFrameEnvelopeV2 {
  readonly protocolVersion: AiChatProtocolVersionV2;
  readonly sessionId: string;
  /** Monotonic per panel/session; begins at 1 after hydration. */
  readonly sequence: number;
}

/** Closed V2 turn-phase vocabulary (PLAN §6). */
export type AiChatTurnPhaseV2 =
  | "idle"
  | "validating"
  | "connecting"
  | "waiting_for_first_event"
  | "streaming"
  | "awaiting_permission"
  | "stopping"
  | "completed"
  | "failed";

/** Tool/step status vocabulary shared by tool frames. */
export type AiChatToolStatusV2 = "ok" | "failed" | "denied";

/** Closed context-ref kind vocabulary (mirrors `ContextRef.kind`). */
export type AiChatContextRefKindV2 = "file" | "selection" | "table" | "view" | "routine" | "schema";

/** Closed context-ref status vocabulary (mirrors `ContextRef.status`). */
export type AiChatContextRefStatusV2 = "ready" | "changed" | "missing" | "forbidden";

/** One structured context reference the webview may carry on a draft.
 *
 * The ref is IDENTITY + METADATA only: `label`/`detail` are display strings and
 * `revision` is an opaque fingerprint. No file content, row bytes or base64 may
 * ever occupy a field of this shape (a ref is placed in DOM attributes and on
 * the wire). `changed`/`missing` remain as the compact legacy aliases of
 * `status`; new code reads `status`. */
export interface AiChatContextRefV2 {
  readonly kind: AiChatContextRefKindV2;
  readonly id: string;
  readonly label: string;
  /** Full distinguishing identity (path, or connection.schema.object). */
  readonly detail?: string;
  /** The literal token inserted into the composer (`@index.vue`). */
  readonly displayToken?: string;
  /**
   * Opaque source signature: a URI for file/selection refs, or
   * `connection.schema.object` for DB refs. NEVER content — it is a locator
   * only, safe in an attribute and on the wire.
   */
  readonly source?: string;
  /** Explicit status. Supersedes the `changed`/`missing` aliases. */
  readonly status?: AiChatContextRefStatusV2;
  /** Opaque snapshot fingerprint — never content. */
  readonly revision?: string;
  /** Amber state: the host resolved a change since the ref was taken. */
  readonly changed?: boolean;
  /** Amber state: the host could no longer resolve the ref. */
  readonly missing?: boolean;
}

/** Coarse mention-scope filter carried on a `search_context` intent. */
export type AiChatContextKindFilterV2 = "all" | "file" | "selection" | "database";

/** Host → webview: resolved engine capability snapshot.
 *
 * TASK-CHATV2-012 (additive): an OPTIONAL `clientRequestId` echoes the
 * `set_engine` it answers. It is present ONLY on the ack for a switch request;
 * an unsolicited snapshot (first ready, capability refresh) omits it. The
 * webview uses it to correlate an ack with its pending request and to IGNORE a
 * stale ack. Absent field ⇒ not an ack ⇒ never settles a pending switch. */
export interface AiChatHostCapabilitiesV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "capabilities";
  readonly capabilities: EngineCapabilitySnapshot;
  /** Echo of the `set_engine.clientRequestId` this frame acknowledges. */
  readonly clientRequestId?: string;
  /**
   * TASK-CHATV2-014 (additive): the session's CURRENT permission policy. It is
   * carried on every capabilities frame so the composer chip renders the truth
   * from the host, and on the ACK for a `set_permission_policy` (which echoes
   * the same `clientRequestId`) so the chip only changes on an acknowledgement.
   * Absent ⇒ default (ask). */
  readonly permissionPolicy?: "default" | "bypass";
}

/** Host → webview: initial/paged transcript hydration. */
export interface AiChatHostSessionHydratedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "session_hydrated";
  readonly hasHistory: boolean;
  readonly visionCapable: boolean;
  readonly truncated?: boolean;
  readonly truncatedCount?: number;
}

/** Host → webview: acknowledges a `submit_turn` clientRequestId. */
export interface AiChatHostTurnStartedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "turn_started";
  readonly turnId: string;
  readonly clientRequestId: string;
}

/** Host → webview: one turn-phase transition. */
export interface AiChatHostPhaseV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "phase";
  readonly turnId: string;
  readonly phase: AiChatTurnPhaseV2;
}

/** Host → webview: incremental assistant text for one stable messageId. */
export interface AiChatHostTextDeltaV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "text_delta";
  readonly turnId: string;
  readonly messageId: string;
  readonly text: string;
  readonly markdown?: boolean;
}

/** Host → webview: incremental reasoning text (rendered in a thinking block). */
export interface AiChatHostReasoningDeltaV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "reasoning_delta";
  readonly turnId: string;
  readonly messageId: string;
  readonly text: string;
}

/** Host → webview: a tool began. */
export interface AiChatHostToolStartedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "tool_started";
  readonly turnId: string;
  readonly toolId: string;
  readonly label: string;
  /** Coarse icon semantic — never a provider name. */
  readonly action: string;
}

/** Host → webview: a tool finished. `summary` is SHAPE ONLY (never row bytes). */
export interface AiChatHostToolFinishedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "tool_finished";
  readonly turnId: string;
  readonly toolId: string;
  readonly label: string;
  readonly status: AiChatToolStatusV2;
  readonly summary: string;
  readonly durationMs?: number;
}

/** Host → webview: the engine needs a permission decision. */
export interface AiChatHostPermissionRequestedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "permission_requested";
  readonly turnId: string;
  readonly requestId: string;
  readonly tool: { readonly id: string; readonly name: string; readonly detail: string };
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
}

/** Host → webview: non-terminal advisory. */
export interface AiChatHostWarningV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "warning";
  readonly safeMessage: string;
}

/**
 * Host → webview: terminal error. PRIVACY: only mapped copy + a short
 * diagnostic id; `safeDetail` is a pre-scrubbed single line (optional).
 */
export interface AiChatHostErrorV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "error";
  readonly turnId?: string;
  readonly safeMessage: string;
  readonly diagnosticId: string;
  readonly safeDetail?: string;
}

/** Host → webview: the turn closed exactly once. */
export interface AiChatHostTurnFinishedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "turn_finished";
  readonly turnId: string;
  readonly outcome: "completed" | "stopped" | "failed";
}

/** Host → webview: answer to `search_context`, correlated to the request.
 *
 * `items` may now carry full structured refs (ids/status/snapshot for the chip
 * strip). The legacy `token` field stays REQUIRED so the V1 mention popover and
 * the single-session bridge keep parsing; a structured item sets `ref` in
 * addition. */
export interface AiChatHostFrameMentionResultsV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "mention_results";
  readonly requestId: string;
  readonly draftRevision: number;
  readonly query: string;
  readonly items: ReadonlyArray<{
    readonly kind: "table" | "view" | "routine" | "file";
    readonly label: string;
    readonly detail: string;
    readonly token: string;
    /** Present on structured rows — the chip identity for this result. */
    readonly ref?: AiChatContextRefV2;
  }>;
}

/** Host → webview: the re-validated status of ONE context ref at send time.
 * The host is authoritative; the webview never invents a status. */
export interface AiChatHostContextResolvedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "context_resolved";
  readonly requestId: string;
  readonly ref: AiChatContextRefV2;
  readonly status: AiChatContextRefStatusV2;
  /** Fresh snapshot fingerprint, or the captured one when unchanged. */
  readonly revision: string;
  readonly label: string;
  readonly detail: string;
  readonly displayToken: string;
}

/** Host → webview: the outcome of a `submit_turn` whose draft carried refs that
 * were no longer clean. The turn did NOT run; the webview must present the
 * explicit resolution choices and send again. */
export interface AiChatHostContextBlockedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "context_blocked";
  readonly clientRequestId: string;
  readonly blocked: ReadonlyArray<{
    readonly refId: string;
    readonly status: Exclude<AiChatContextRefStatusV2, "ready">;
  }>;
}

/** Host → webview: current grounded-context status for a turn. */
export interface AiChatHostContextStatusV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "context_status";
  readonly turnId: string;
  readonly selectionPath: string | null;
  readonly fileCount: number;
  readonly excludedCount: number;
}

/** Host → webview: one attachment was rejected by the AUTHORITATIVE host
 * validation (MIME allowlist, magic bytes, count cap, byte cap, active-model
 * vision, engine transport). TASK-CHATV2-013.
 *
 * PRIVACY: the frame names the attachment by id and carries the exact, mapped
 * reason copy — it NEVER echoes base64, a data URL or any raw bytes. The host
 * re-validates independently of the webview's early warning; a rejection of one
 * image never discards a valid sibling or a text-only request. */
export interface AiChatHostAttachErrorV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "attach_error";
  /** The attachment id the webview sent. */
  readonly id: string;
  /** Mapped reject reason, mirrored from `AttachRejectReason`. */
  readonly reason: "oversize" | "count_cap" | "unsupported_type" | "mime_mismatch" | "vision_unsupported";
  /** Safe, user-facing single-line copy (never contains payload bytes). */
  readonly message: string;
}

/** Host → webview: the configured model roles + active role.
 *
 * TASK-CHATV2-012 (additive): an OPTIONAL `clientRequestId` is present only
 * when this frame ACKS a `set_model`, so the chip commits on correlation. */
export interface AiChatHostModelsV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "models";
  readonly active: AiModelRole;
  readonly roles: ReadonlyArray<{ readonly role: AiModelRole; readonly modelId: string; readonly vision: boolean }>;
  /** Echo of the `set_model.clientRequestId` this frame acknowledges. */
  readonly clientRequestId?: string;
}

/** Host → webview: the active schema chip changed. */
export interface AiChatHostSchemaV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "schema";
  readonly schema: string | undefined;
  readonly connectionId: string | undefined;
}

/** Host → webview: a host-side export finished writing. */
export interface AiChatHostExportCompletedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "export_completed";
  readonly format: "markdown" | "json";
  readonly name: string;
}

/** Host → webview: a host-side export failed (safe copy only). */
export interface AiChatHostExportFailedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "export_failed";
  readonly safeMessage: string;
  readonly diagnosticId: string;
}

/** Host → webview: the resumable session list. */
export interface AiChatHostSessionsV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "sessions";
  readonly items: ReadonlyArray<{
    readonly sessionId: string;
    readonly label: string;
    readonly detail: string;
  }>;
}

/** Host → webview: the session title was renamed (host-acknowledged). */
export interface AiChatHostTitleUpdatedV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "title_updated";
  readonly title: string;
}

/** Host → webview: transient toast.
 *
 * TASK-CHATV2-012 (additive): an OPTIONAL `clientRequestId` links the toast to
 * the rejected request (e.g. a failed `set_engine`), so a failure can settle
 * exactly the request it answers and leave a stale one inert. */
export interface AiChatHostToastV2 extends AiChatFrameEnvelopeV2 {
  readonly kind: "toast";
  readonly level: "info" | "warning" | "error";
  readonly safeMessage: string;
  /** Echo of the rejected request's clientRequestId (failure toasts only). */
  readonly clientRequestId?: string;
}

/** Closed host → webview V2 frame union. */
export type AiChatHostFrameV2 =
  | AiChatHostCapabilitiesV2
  | AiChatHostSessionHydratedV2
  | AiChatHostTurnStartedV2
  | AiChatHostPhaseV2
  | AiChatHostTextDeltaV2
  | AiChatHostReasoningDeltaV2
  | AiChatHostToolStartedV2
  | AiChatHostToolFinishedV2
  | AiChatHostPermissionRequestedV2
  | AiChatHostWarningV2
  | AiChatHostErrorV2
  | AiChatHostTurnFinishedV2
  | AiChatHostFrameMentionResultsV2
  | AiChatHostContextResolvedV2
  | AiChatHostContextBlockedV2
  | AiChatHostContextStatusV2
  | AiChatHostAttachErrorV2
  | AiChatHostModelsV2
  | AiChatHostSchemaV2
  | AiChatHostExportCompletedV2
  | AiChatHostExportFailedV2
  | AiChatHostSessionsV2
  | AiChatHostTitleUpdatedV2
  | AiChatHostToastV2;

/** The immutable draft carried by `submit_turn`. */
export interface AiChatSubmitDraftV2 {
  readonly text: string;
  readonly revision: number;
  readonly context: ReadonlyArray<AiChatContextRefV2>;
  readonly attachments: ReadonlyArray<MinimalAttachment>;
}

/** Webview → host V2 intents. Mutating intents carry `clientRequestId`. */
export type AiChatWebviewIntentV2 =
  | { readonly kind: "ready_v2"; readonly protocolVersion: AiChatProtocolVersionV2 }
  | {
      readonly kind: "submit_turn";
      readonly protocolVersion: AiChatProtocolVersionV2;
      readonly clientRequestId: string;
      readonly draft: AiChatSubmitDraftV2;
    }
  | { readonly kind: "stop_turn"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string }
  | { readonly kind: "set_engine"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly engine: AiEngineName }
  | { readonly kind: "set_model"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly role: AiModelRole }
  | {
      readonly kind: "search_context";
      readonly protocolVersion: AiChatProtocolVersionV2;
      readonly clientRequestId: string;
      readonly requestId: string;
      readonly draftRevision: number;
      readonly query: string;
      /** Coarse scope filter. Absent means "all" (legacy callers). */
      readonly kindFilter?: AiChatContextKindFilterV2;
      /** Open generation; echoed back so a closed popover's answer is inert. */
      readonly generation?: number;
    }
  | { readonly kind: "resolve_context"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly ref: AiChatContextRefV2 }
  | { readonly kind: "remove_context"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly refId: string }
  | { readonly kind: "preview_context"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly ref: AiChatContextRefV2 }
  | {
      readonly kind: "permission_response";
      readonly protocolVersion: AiChatProtocolVersionV2;
      readonly clientRequestId: string;
      readonly requestId: string;
      readonly optionId?: string;
    }
  | {
      readonly kind: "set_permission_policy";
      readonly protocolVersion: AiChatProtocolVersionV2;
      readonly clientRequestId: string;
      readonly policy: "default" | "bypass";
    }
  | { readonly kind: "list_sessions"; readonly protocolVersion: AiChatProtocolVersionV2 }
  | { readonly kind: "resume_saved_session"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly sessionId: string }
  | { readonly kind: "create_session"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string }
  | { readonly kind: "rename_session"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly title: string }
  | { readonly kind: "clear_session"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string }
  | { readonly kind: "export_session"; readonly protocolVersion: AiChatProtocolVersionV2; readonly clientRequestId: string; readonly format: "markdown" | "json" }
  | { readonly kind: "pick_active_schema"; readonly protocolVersion: AiChatProtocolVersionV2 }
  | { readonly kind: "open_settings"; readonly protocolVersion: AiChatProtocolVersionV2 };

/** One host frame with its envelope stripped (the semantic body). A plain
 * `Omit` over the union collapses to common keys, so distribute explicitly. */
export type AiChatHostFrameV2Body = AiChatHostFrameV2 extends infer T
  ? T extends AiChatFrameEnvelopeV2
    ? Omit<T, keyof AiChatFrameEnvelopeV2>
    : never
  : never;

/** Sequence gate a downstream reducer keeps per live session. */
export interface AiChatHostSequenceGateV2 {
  readonly sessionId: string;
  readonly lastSequence: number;
}

// ---- Runtime helpers -------------------------------------------------------

function isRecordV2(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HOST_FRAME_KINDS_V2: ReadonlySet<string> = new Set([
  "capabilities",
  "session_hydrated",
  "turn_started",
  "phase",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "permission_requested",
  "warning",
  "error",
  "turn_finished",
  "mention_results",
  "context_resolved",
  "context_blocked",
  "context_status",
  "attach_error",
  "models",
  "schema",
  "export_completed",
  "export_failed",
  "sessions",
  "title_updated",
  "toast",
]);

const TURN_SCOPED_KINDS_V2: ReadonlySet<string> = new Set([
  "turn_started",
  "phase",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "permission_requested",
  "context_status",
  "turn_finished",
]);

const AI_ENGINE_NAMES_V2: ReadonlySet<string> = new Set([
  "builtin",
  "omp",
  "claude-code",
  "codex",
]);

const AI_MODEL_ROLES_V2: ReadonlySet<string> = new Set([
  "work",
  "smart",
  "autocomplete",
  "lite",
]);

const CONTEXT_REF_KINDS_V2: ReadonlySet<string> = new Set([
  "file",
  "selection",
  "table",
  "view",
  "routine",
  "schema",
]);

const CONTEXT_REF_STATUSES_V2: ReadonlySet<string> = new Set([
  "ready",
  "changed",
  "missing",
  "forbidden",
]);

const CONTEXT_KIND_FILTERS_V2: ReadonlySet<string> = new Set([
  "all",
  "file",
  "selection",
  "database",
]);

/**
 * Runtime narrow guard for a V2 host frame. Validates the envelope, the closed
 * `kind` set and the per-kind mandatory correlation fields. Never throws.
 */
export function isAiChatHostFrameV2(value: unknown): value is AiChatHostFrameV2 {
  if (!isRecordV2(value)) return false;
  if (value["protocolVersion"] !== AI_CHAT_PROTOCOL_VERSION_V2) return false;
  const sessionId = value["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const sequence = value["sequence"];
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
    return false;
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !HOST_FRAME_KINDS_V2.has(kind)) return false;
  if (TURN_SCOPED_KINDS_V2.has(kind)) {
    const turnId = value["turnId"];
    if (typeof turnId !== "string" || turnId.length === 0) return false;
  }
  if (kind === "mention_results") {
    const requestId = value["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0) return false;
    if (typeof value["draftRevision"] !== "number") return false;
  }
  return true;
}

/**
 * Compute the next ordered envelope. The FIRST post-hydration frame is
 * `sequence: 1`; a new session id restarts the counter at 1. The host owns the
 * counter — a client-supplied sequence is never an input here.
 */
export function nextV2Envelope(
  previous: AiChatFrameEnvelopeV2 | null,
  sessionId: string,
): AiChatFrameEnvelopeV2 {
  if (previous === null || previous.sessionId !== sessionId) {
    return {
      protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
      sessionId,
      sequence: 1,
    };
  }
  return {
    protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
    sessionId,
    sequence: previous.sequence + 1,
  };
}

/**
 * Downstream reducer gate: a frame is accepted only for the live session AND
 * with a strictly newer sequence. Wrong session or `sequence <= lastSequence`
 * is rejected deterministically (never applied, never thrown).
 */
export function shouldAcceptHostFrameV2(
  gate: AiChatHostSequenceGateV2,
  frame: AiChatFrameEnvelopeV2,
): boolean {
  if (frame.protocolVersion !== AI_CHAT_PROTOCOL_VERSION_V2) return false;
  if (frame.sessionId !== gate.sessionId) return false;
  return frame.sequence > gate.lastSequence;
}

/**
 * A `mention_results` frame is current only when the popover is still open on
 * the SAME requestId and draftRevision. A dismissed/open-on-other-revision
 * popover can never be reopened by a late response.
 */
export function isMentionResponseCurrentV2(
  open: { readonly requestId: string; readonly draftRevision: number } | null,
  response: { readonly requestId: string; readonly draftRevision: number },
): boolean {
  if (open === null) return false;
  return (
    open.requestId === response.requestId &&
    open.draftRevision === response.draftRevision
  );
}

// ---- Webview intent validation ---------------------------------------------

export type AiChatIntentParseResultV2 =
  | { readonly ok: true; readonly intent: AiChatWebviewIntentV2 }
  | { readonly ok: false; readonly reason: string };

function isNonEmptyStringV2(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sanitizeContextRefV2(raw: unknown): AiChatContextRefV2 | null {
  if (!isRecordV2(raw)) return null;
  const kind = raw["kind"];
  if (typeof kind !== "string" || !CONTEXT_REF_KINDS_V2.has(kind)) return null;
  const id = raw["id"];
  const label = raw["label"];
  if (!isNonEmptyStringV2(id) || typeof label !== "string") return null;
  const ref: {
    -readonly [K in keyof AiChatContextRefV2]: AiChatContextRefV2[K];
  } = { kind: kind as AiChatContextRefV2["kind"], id, label };
  const detail = raw["detail"];
  if (typeof detail === "string") ref.detail = detail;
  const displayToken = raw["displayToken"];
  if (typeof displayToken === "string") ref.displayToken = displayToken;
  const source = raw["source"];
  if (typeof source === "string") ref.source = source;
  const status = raw["status"];
  if (typeof status === "string" && CONTEXT_REF_STATUSES_V2.has(status)) {
    ref.status = status as AiChatContextRefStatusV2;
  }
  const revision = raw["revision"];
  if (typeof revision === "string") ref.revision = revision;
  if (raw["changed"] === true) ref.changed = true;
  if (raw["missing"] === true) ref.missing = true;
  return Object.freeze(ref);
}

function sanitizeAttachmentV2(raw: unknown): MinimalAttachment | null {
  if (!isRecordV2(raw)) return null;
  const id = raw["id"];
  const mime = raw["mime"];
  const base64 = raw["base64"];
  const bytes = raw["bytes"];
  if (!isNonEmptyStringV2(id)) return null;
  if (!isNonEmptyStringV2(mime)) return null;
  if (typeof base64 !== "string") return null;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  return Object.freeze({ id, mime, base64, bytes });
}

/**
 * Parse + validate one raw webview → host V2 intent. Unknown kinds, wrong
 * protocol versions, missing correlation ids and malformed payloads all return
 * `{ ok: false }` — the function NEVER throws, so a hostile/malformed message
 * can never surface as an extension-host exception. Extra fields (including a
 * client-supplied `sequence`) are dropped, never trusted.
 */
export function parseAiChatWebviewIntentV2(raw: unknown): AiChatIntentParseResultV2 {
  try {
    if (!isRecordV2(raw)) return { ok: false, reason: "not-an-object" };
    if (raw["protocolVersion"] !== AI_CHAT_PROTOCOL_VERSION_V2) {
      return { ok: false, reason: "unsupported-protocol-version" };
    }
    const kind = raw["kind"];
    if (typeof kind !== "string") return { ok: false, reason: "missing-kind" };
    const version = AI_CHAT_PROTOCOL_VERSION_V2;

    // Intents with no host state mutation and no correlation id.
    if (kind === "ready_v2") return { ok: true, intent: { kind, protocolVersion: version } };
    if (kind === "list_sessions") return { ok: true, intent: { kind, protocolVersion: version } };
    if (kind === "pick_active_schema") return { ok: true, intent: { kind, protocolVersion: version } };
    if (kind === "open_settings") return { ok: true, intent: { kind, protocolVersion: version } };

    // Every other intent mutates host state and MUST carry clientRequestId.
    const clientRequestId = raw["clientRequestId"];
    if (!isNonEmptyStringV2(clientRequestId)) {
      return { ok: false, reason: "missing-client-request-id" };
    }

    switch (kind) {
      case "submit_turn": {
        const draft = raw["draft"];
        if (!isRecordV2(draft)) return { ok: false, reason: "missing-draft" };
        const text = draft["text"];
        const revision = draft["revision"];
        if (typeof text !== "string") return { ok: false, reason: "invalid-draft-text" };
        if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
          return { ok: false, reason: "invalid-draft-revision" };
        }
        const rawContext = draft["context"];
        const rawAttachments = draft["attachments"];
        if (!Array.isArray(rawContext) || !Array.isArray(rawAttachments)) {
          return { ok: false, reason: "invalid-draft-collections" };
        }
        const context: AiChatContextRefV2[] = [];
        for (const entry of rawContext) {
          const ref = sanitizeContextRefV2(entry);
          if (ref === null) return { ok: false, reason: "invalid-context-ref" };
          context.push(ref);
        }
        const attachments: MinimalAttachment[] = [];
        for (const entry of rawAttachments) {
          const att = sanitizeAttachmentV2(entry);
          if (att === null) return { ok: false, reason: "invalid-attachment" };
          attachments.push(att);
        }
        return {
          ok: true,
          intent: {
            kind,
            protocolVersion: version,
            clientRequestId,
            draft: Object.freeze({
              text,
              revision,
              context: Object.freeze(context),
              attachments: Object.freeze(attachments),
            }),
          },
        };
      }
      case "stop_turn":
      case "create_session":
      case "clear_session":
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId } };
      case "set_engine": {
        const engine = raw["engine"];
        if (typeof engine !== "string" || !AI_ENGINE_NAMES_V2.has(engine)) {
          return { ok: false, reason: "invalid-engine" };
        }
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, engine: engine as AiEngineName } };
      }
      case "set_model": {
        const role = raw["role"];
        if (typeof role !== "string" || !AI_MODEL_ROLES_V2.has(role)) {
          return { ok: false, reason: "invalid-role" };
        }
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, role: role as AiModelRole } };
      }
      case "search_context": {
        const requestId = raw["requestId"];
        const draftRevision = raw["draftRevision"];
        const query = raw["query"];
        if (!isNonEmptyStringV2(requestId)) return { ok: false, reason: "invalid-request-id" };
        if (typeof draftRevision !== "number" || !Number.isInteger(draftRevision) || draftRevision < 0) {
          return { ok: false, reason: "invalid-draft-revision" };
        }
        if (typeof query !== "string") return { ok: false, reason: "invalid-query" };
        const intent: {
          -readonly [K in keyof Extract<AiChatWebviewIntentV2, { kind: "search_context" }>]:
            Extract<AiChatWebviewIntentV2, { kind: "search_context" }>[K];
        } = { kind, protocolVersion: version, clientRequestId, requestId, draftRevision, query };
        const kindFilter = raw["kindFilter"];
        if (kindFilter !== undefined) {
          if (typeof kindFilter !== "string" || !CONTEXT_KIND_FILTERS_V2.has(kindFilter)) {
            return { ok: false, reason: "invalid-kind-filter" };
          }
          intent.kindFilter = kindFilter as AiChatContextKindFilterV2;
        }
        const generation = raw["generation"];
        if (generation !== undefined) {
          if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
            return { ok: false, reason: "invalid-generation" };
          }
          intent.generation = generation;
        }
        return { ok: true, intent };
      }
      case "resolve_context":
      case "preview_context": {
        const ref = sanitizeContextRefV2(raw["ref"]);
        if (ref === null) return { ok: false, reason: "invalid-context-ref" };
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, ref } };
      }
      case "remove_context": {
        const refId = raw["refId"];
        if (!isNonEmptyStringV2(refId)) return { ok: false, reason: "invalid-ref-id" };
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, refId } };
      }
      case "permission_response": {
        const requestId = raw["requestId"];
        if (!isNonEmptyStringV2(requestId)) return { ok: false, reason: "invalid-request-id" };
        const optionId = raw["optionId"];
        if (optionId !== undefined && !isNonEmptyStringV2(optionId)) {
          return { ok: false, reason: "invalid-option-id" };
        }
        const intent: {
          -readonly [K in keyof Extract<AiChatWebviewIntentV2, { kind: "permission_response" }>]:
            Extract<AiChatWebviewIntentV2, { kind: "permission_response" }>[K];
        } = { kind, protocolVersion: version, clientRequestId, requestId };
        if (optionId !== undefined) intent.optionId = optionId;
        return { ok: true, intent };
      }
      case "set_permission_policy": {
        const policy = raw["policy"];
        if (policy !== "default" && policy !== "bypass") {
          return { ok: false, reason: "invalid-policy" };
        }
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, policy } };
      }
      case "resume_saved_session": {
        const sessionId = raw["sessionId"];
        if (!isNonEmptyStringV2(sessionId)) return { ok: false, reason: "invalid-session-id" };
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, sessionId } };
      }
      case "rename_session": {
        const title = raw["title"];
        if (typeof title !== "string") return { ok: false, reason: "invalid-title" };
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, title } };
      }
      case "export_session": {
        const format = raw["format"];
        if (format !== "markdown" && format !== "json") {
          return { ok: false, reason: "invalid-format" };
        }
        return { ok: true, intent: { kind, protocolVersion: version, clientRequestId, format } };
      }
      default:
        return { ok: false, reason: "unknown-kind" };
    }
  } catch {
    // Defense-in-depth: any unforeseen input shape fails closed, never throws.
    return { ok: false, reason: "malformed" };
  }
}

/** Re-export the engine vocabulary the V2 intents reference, so consumers of
 * the protocol import it from this single module. */
export type { AiEngineName };
