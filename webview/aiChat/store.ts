// webview/aiChat/store.ts — TASK-CHATV2-004
//
// The single state authority for V2. Host frames and local semantic actions
// update ONE pure, serializable `ChatViewState` via `reduceChatState`; renderers
// read this state and never infer business state from the DOM or CSS classes.
//
// PURITY CONTRACT. This module has no `vscode`, no DOM, no transport, no clock,
// no `Math.random`, no `crypto`, no `postMessage` and no storage. It is a pure
// function of `(state, action)`. Every id it stores either came from a host
// frame or is derived deterministically from one (e.g. the user bubble id
// `user-<clientRequestId>`), so state is always JSON-serializable.
//
// AUTHORITY. The host owns session/protocol/sequence, turn lifecycle, engine,
// model and permission policy. The webview owns draft/caret, open popover,
// collapsed panels and scroll proximity. A frame for the wrong session, a stale
// sequence, or a delta for a closed/other turn is ignored by returning the
// SAME state object (identity), so callers can cheaply detect a no-op.

import type { EngineCapabilitySnapshot } from "../../src/ai/capabilities";
import { mapHostChatError, type AiChatErrorFrame } from "../../src/ui/aiChatErrors";
import type { MinimalAttachment } from "../../src/ui/aiChatAttachments";
import type {
  AiChatContextRefStatusV2,
  AiChatContextRefV2,
  AiChatHostFrameMentionResultsV2,
  AiChatHostFrameV2,
  AiChatTurnPhaseV2,
  AiChatToolStatusV2,
} from "../../src/ui/aiChatPanelMessages";

/** Closed turn-phase vocabulary. Mirrors the wire phase type so the protocol
 * and the reducer can never drift into two different phase sets. */
export type TurnPhase = AiChatTurnPhaseV2;

/** Phases in which a turn is live: submitting is refused and the composer keeps
 * an editable next draft. */
const BUSY_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  "validating",
  "connecting",
  "waiting_for_first_event",
  "streaming",
  "awaiting_permission",
  "stopping",
]);

/** Terminal phases: the turn has closed and a late frame cannot reopen it. */
const TERMINAL_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  "completed",
  "failed",
]);

function isBusyPhase(phase: TurnPhase): boolean {
  return BUSY_PHASES.has(phase);
}

function isTerminalPhase(phase: TurnPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Which overlay the composer is currently presenting. */
export type ComposerMode =
  | "draft"
  | "slash"
  | "mention"
  | "model-menu"
  | "engine-menu"
  | "permission";

/** Editable composer state. The webview owns this; the host never mutates it
 * except by acknowledging a submitted draft via `turn_started`. */
export interface ComposerDraft {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  /** Bumped on every edit; responses are correlated to a revision. */
  readonly revision: number;
  readonly attachments: readonly MinimalAttachment[];
  readonly context: readonly AiChatContextRefV2[];
}

/** One row in the anchored slash/mention popover. */
export type AutocompleteItem = AiChatHostFrameMentionResultsV2["items"][number];

/** Anchored, non-modal popover state. `generation` is bumped on every open and
 * every close so a late response from a previous open cannot be applied. */
export interface AutocompleteState {
  readonly open: boolean;
  readonly mode: ComposerMode;
  readonly requestId: string | null;
  readonly draftRevision: number;
  readonly query: string;
  readonly items: readonly AutocompleteItem[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly generation: number;
}

/** One renderable transcript entity. Discriminated on `kind`; every variant is
 * plain data (no Element/Blob/function). */
export interface ChatUserItem {
  readonly id: string;
  readonly kind: "user";
  readonly clientRequestId: string;
  readonly text: string;
  readonly context: readonly AiChatContextRefV2[];
}

export interface ChatTextItem {
  readonly id: string;
  readonly kind: "text";
  readonly turnId: string;
  readonly messageId: string;
  readonly raw: string;
  readonly streaming: boolean;
}

export interface ChatReasoningItem {
  readonly id: string;
  readonly kind: "reasoning";
  readonly turnId: string;
  readonly messageId: string;
  readonly raw: string;
  readonly streaming: boolean;
}

export interface ChatToolItem {
  readonly id: string;
  readonly kind: "tool";
  readonly turnId: string;
  readonly toolId: string;
  readonly label: string;
  readonly action: string;
  /** TASK-CHATFIX-003: shape-only IN line from the host ("" when absent —
   * legacy frames degrade to label + summary only). */
  readonly detail: string;
  readonly status: "running" | AiChatToolStatusV2;
  readonly summary: string;
  readonly durationMs: number | null;
}

export type ChatTranscriptItem =
  | ChatUserItem
  | ChatTextItem
  | ChatReasoningItem
  | ChatToolItem;

/** Viewport paging metadata. `renderOrder` is capped; the session record is
 * NOT — this is a viewport limit, never data loss. */
export interface TranscriptPaging {
  readonly cap: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface ChatTranscript {
  readonly entities: Readonly<Record<string, ChatTranscriptItem>>;
  readonly order: readonly string[];
  /** The capped viewport list (last `cap` ids of `order`). */
  readonly renderOrder: readonly string[];
  readonly paging: TranscriptPaging;
}

/** Non-modal banners (errors/warnings pinned above the transcript). */
export interface ChatBanner {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly title: string;
  readonly message: string;
  readonly diagnosticId: string | null;
}

/** Host-reviewed change plan waiting for one explicit user outcome. */
export interface ChatChangePlan {
  readonly tool: string;
  readonly plan: {
    readonly intent: string;
    readonly statements: readonly { readonly sql: string; readonly tier: string; readonly dangerNote: string }[];
    readonly drift: readonly string[];
    readonly drifted: boolean;
  };
}

/** Safe failed-turn data. The structured retry draft never comes from DOM. */
export interface ChatErrorState {
  readonly frame: AiChatErrorFrame;
  readonly request: { readonly clientRequestId: string; readonly draft: ComposerDraft } | null;
}

/** Transient toasts. Capped ring — oldest evicted first. */
export interface ChatToast {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
}

export interface ChatPendingRequest {
  readonly requestId: string;
  readonly turnId: string;
  readonly tool: { readonly id: string; readonly name: string; readonly detail: string };
  readonly options: readonly { readonly optionId: string; readonly label: string }[];
}

export interface ChatHydration {
  readonly hydrated: boolean;
  readonly hasHistory: boolean;
  readonly visionCapable: boolean;
  readonly truncated: boolean;
  readonly truncatedCount: number;
}

export interface ChatLayout {
  readonly collapsedTranscript: boolean;
  readonly collapsedActivities: boolean;
  readonly scrollNearBottom: boolean;
  readonly unreadCount: number;
}

export interface ChatModelsState {
  readonly active: string;
  readonly roles: readonly { readonly role: string; readonly modelId: string; readonly vision: boolean }[];
}

export interface ChatSchemaState {
  readonly schema: string | null;
  readonly connectionId: string | null;
}

/** TASK-CHATV2-013: one inline amber attachment rejection. `message` is safe
 * host copy; `reason` is a closed vocabulary. No payload bytes, ever. */
export interface ChatAttachNotice {
  readonly id: string;
  readonly attachmentId: string;
  readonly reason: "oversize" | "count_cap" | "unsupported_type" | "mime_mismatch" | "vision_unsupported";
  readonly message: string;
}

export interface ChatActiveTurn {
  readonly turnId: string;
  readonly closed: boolean;
  readonly outcome: "completed" | "stopped" | "failed" | null;
}

/** The single serializable view state. */
export interface ChatViewState {
  readonly protocolVersion: 2;
  readonly sessionId: string | null;
  readonly lastSequence: number;
  readonly capabilities: EngineCapabilitySnapshot | null;
  /**
   * TASK-CHATV2-014: the session's live permission policy, mirrored from the
   * host `capabilities` frame. The webview NEVER infers it — it changes only
   * when the host says so (an initial snapshot or a correlated policy ack).
   */
  readonly permissionPolicy: "default" | "bypass";
  readonly hydration: ChatHydration;
  readonly phase: TurnPhase;
  readonly turn: ChatActiveTurn | null;
  readonly transcript: ChatTranscript;
  readonly draft: ComposerDraft;
  /** CHATUX2-002: FIFO of draft snapshots queued by Enter-while-busy. The
   * controller drains it on `turn_finished`; a session reset clears it so a
   * queued draft can never leak into another session. */
  readonly steerQueue: readonly ComposerDraft[];
  readonly autocomplete: AutocompleteState;
  readonly layout: ChatLayout;
  readonly banners: readonly ChatBanner[];
  /** The one pending reviewed plan, if the host has offered one. */
  readonly changePlan: ChatChangePlan | null;
  /** The current terminal error card, derived only from safe host metadata. */
  readonly error: ChatErrorState | null;
  readonly toasts: readonly ChatToast[];
  /** TASK-CHATV2-013: inline, per-item attachment rejection notices. */
  readonly attachNotices: readonly ChatAttachNotice[];
  readonly models: ChatModelsState | null;
  readonly schema: ChatSchemaState | null;
  readonly sessionTitle: string | null;
  readonly sessions: readonly { readonly sessionId: string; readonly label: string; readonly detail: string }[];
  readonly pendingHostRequests: readonly ChatPendingRequest[];
  /** The submit effect awaiting controller dispatch (null once posted). */
  readonly pendingSubmit: { readonly clientRequestId: string; readonly draft: ComposerDraft } | null;
  /** Last immutable structured request, retained only to offer a safe Retry. */
  readonly lastSubmittedRequest: { readonly clientRequestId: string; readonly draft: ComposerDraft } | null;
  /** The submit effect awaiting controller dispatch, kept until the host acks. */
  readonly pendingStop: { readonly clientRequestId: string } | null;
  /** The last submitted clientRequestId; cleared when the host acknowledges it. */
  readonly awaitingAckRequestId: string | null;
}

/** Local (webview-owned) semantic actions. */
export type ChatLocalAction =
  | { readonly type: "DRAFT_CHANGED"; readonly text: string; readonly selectionStart?: number; readonly selectionEnd?: number }
  | { readonly type: "SELECTION_CHANGED"; readonly selectionStart: number; readonly selectionEnd: number }
  | { readonly type: "ATTACHMENT_ADDED"; readonly attachment: MinimalAttachment }
  | { readonly type: "ATTACHMENT_REMOVED"; readonly id: string }
  | { readonly type: "CONTEXT_ADDED"; readonly ref: AiChatContextRefV2 }
  | { readonly type: "CONTEXT_REMOVED"; readonly refId: string }
  | {
      readonly type: "CONTEXT_REF_RESOLVED";
      readonly refId: string;
      readonly status: AiChatContextRefStatusV2;
    }
  | {
      readonly type: "AUTOCOMPLETE_OPENED";
      readonly mode: ComposerMode;
      readonly requestId: string;
      readonly draftRevision: number;
      readonly query: string;
    }
  | { readonly type: "AUTOCOMPLETE_CLOSED"; readonly reason: "escape" | "commit" | "selection" | "blur" }
  | { readonly type: "AUTOCOMPLETE_ACTIVE_MOVED"; readonly delta: number }
  | { readonly type: "COLLAPSE_TOGGLED"; readonly panel: "transcript" | "activities" }
  | { readonly type: "SCROLL_PROXIMITY_CHANGED"; readonly distancePx: number }
  | { readonly type: "SUBMIT_REQUESTED"; readonly clientRequestId: string; readonly draft?: ComposerDraft }
  | { readonly type: "SUBMIT_CONSUMED"; readonly clientRequestId: string }
  | { readonly type: "STEER_ENQUEUED" }
  | { readonly type: "STEER_DEQUEUED" }
  | { readonly type: "STOP_REQUESTED"; readonly clientRequestId: string }
  | { readonly type: "STOP_DISPATCHED"; readonly clientRequestId: string }
  | { readonly type: "PERMISSION_RESPONDED"; readonly requestId: string }
  | { readonly type: "TRANSCRIPT_PAGE_LOADED"; readonly items: readonly ChatTranscriptItem[]; readonly total: number };

/** The complete action vocabulary the reducer understands. */
export type ChatAction = { readonly type: "HOST_FRAME"; readonly frame: AiChatHostFrameV2 } | ChatLocalAction;

/** Maximum renderable transcript ids kept in the viewport list. */
export const RENDER_CAP = 200;

/** Maximum retained toasts. */
export const TOAST_CAP = 3;

/** Maximum retained inline attachment rejection notices. */
export const ATTACH_NOTICE_CAP = 8;

/** Maximum queued steer drafts (CHATUX2-002). At the cap `STEER_ENQUEUED`
 * is a same-state no-op — the draft stays in the composer, never dropped. */
export const STEER_QUEUE_CAP = 8;

/** Distance (px) within which the transcript counts as "at the bottom". */
export const SCROLL_NEAR_BOTTOM_PX = 48;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

function emptyTranscript(): ChatTranscript {
  return {
    entities: {},
    order: [],
    renderOrder: [],
    paging: { cap: RENDER_CAP, total: 0, hasMore: false },
  };
}

/** Build the pristine view state. Deterministic — safe to call anywhere. */
export function createInitialChatState(): ChatViewState {
  return {
    protocolVersion: 2,
    sessionId: null,
    lastSequence: 0,
    capabilities: null,
    permissionPolicy: "default",
    hydration: {
      hydrated: false,
      hasHistory: false,
      visionCapable: false,
      truncated: false,
      truncatedCount: 0,
    },
    phase: "idle",
    turn: null,
    transcript: emptyTranscript(),
    draft: {
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
      revision: 0,
      attachments: [],
      context: [],
    },
    steerQueue: [],
    autocomplete: {
      open: false,
      mode: "draft",
      requestId: null,
      draftRevision: 0,
      query: "",
      items: [],
      activeIndex: 0,
      loading: false,
      generation: 0,
    },
    layout: {
      collapsedTranscript: false,
      collapsedActivities: false,
      scrollNearBottom: true,
      unreadCount: 0,
    },
    banners: [],
    changePlan: null,
    error: null,
    toasts: [],
    attachNotices: [],
    models: null,
    schema: null,
    sessionTitle: null,
    sessions: [],
    pendingHostRequests: [],
    pendingSubmit: null,
    lastSubmittedRequest: null,
    pendingStop: null,
    awaitingAckRequestId: null,
  };
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------

function withRenderOrder(order: readonly string[], total: number): ChatTranscript {
  const renderOrder = order.length > RENDER_CAP ? order.slice(order.length - RENDER_CAP) : order.slice();
  return {
    entities: {},
    order,
    renderOrder,
    paging: { cap: RENDER_CAP, total, hasMore: order.length > RENDER_CAP || total > order.length },
  };
}

/** Insert or replace one entity, keeping insertion order stable by id. */
function putItem(
  transcript: ChatTranscript,
  id: string,
  item: ChatTranscriptItem,
): ChatTranscript {
  const entities = { ...transcript.entities, [id]: item };
  const order = transcript.entities[id] !== undefined ? transcript.order : [...transcript.order, id];
  const next = withRenderOrder(order, Math.max(transcript.paging.total, order.length));
  return { ...next, entities };
}

/** Apply an incremental text/reasoning delta to the SAME stable item. */
function upsertStreamingText(
  transcript: ChatTranscript,
  kind: "text" | "reasoning",
  id: string,
  turnId: string,
  messageId: string,
  chunk: string,
): ChatTranscript {
  const existing = transcript.entities[id];
  if (existing !== undefined && existing.kind === kind) {
    const merged: ChatTextItem | ChatReasoningItem = { ...existing, raw: existing.raw + chunk, streaming: true };
    return { ...transcript, entities: { ...transcript.entities, [id]: merged } };
  }
  const item: ChatTextItem | ChatReasoningItem =
    kind === "text"
      ? { id, kind: "text", turnId, messageId, raw: chunk, streaming: true }
      : { id, kind: "reasoning", turnId, messageId, raw: chunk, streaming: true };
  return putItem(transcript, id, item);
}

/** Mark every still-streaming item terminal (used when a turn closes). */
function sealStreaming(transcript: ChatTranscript): ChatTranscript {
  const entities: Record<string, ChatTranscriptItem> = {};
  for (const [id, item] of Object.entries(transcript.entities)) {
    entities[id] =
      item.kind === "text" || item.kind === "reasoning" ? { ...item, streaming: false } : item;
  }
  return { ...transcript, entities };
}

// ---------------------------------------------------------------------------
// Host frame application
// ---------------------------------------------------------------------------

function sameState(state: ChatViewState): ChatViewState {
  return state;
}

/** True when this frame advances the live session (or adopts the first one). */
function frameAccepted(state: ChatViewState, frame: AiChatHostFrameV2): boolean {
  if (frame.protocolVersion !== 2) return false;
  if (state.sessionId === null) return true;
  if (frame.sessionId !== state.sessionId) return false;
  return frame.sequence > state.lastSequence;
}

function applyTurnFrame(
  state: ChatViewState,
  frame: AiChatHostFrameV2,
  body: Record<string, unknown>,
): ChatViewState {
  // `turn_started` opens the turn; it is applied directly so that the turn it
  // creates exists for the frames that follow.
  if (frame.kind === "turn_started") return applyFrameBody(state, frame, body);

  const turnId = body["turnId"];
  // Turn-scoped frames are ignored unless they belong to the live, open turn.
  if (typeof turnId !== "string") return state;
  if (state.turn === null || state.turn.turnId !== turnId) return state;
  if (state.turn.closed && frame.kind !== "turn_finished") return state;
  return applyFrameBody(state, frame, body);
}

function applyFrameBody(
  state: ChatViewState,
  frame: AiChatHostFrameV2,
  body: Record<string, unknown>,
): ChatViewState {
  switch (frame.kind) {
    case "capabilities": {
      // TASK-CHATV2-014: mirror the host's permission policy too. An absent
      // field keeps the current value (never an invented reset).
      const f = frame as {
        capabilities: EngineCapabilitySnapshot;
        permissionPolicy?: "default" | "bypass";
      };
      return {
        ...state,
        capabilities: f.capabilities,
        permissionPolicy:
          f.permissionPolicy === "bypass" || f.permissionPolicy === "default"
            ? f.permissionPolicy
            : state.permissionPolicy,
      };
    }

    case "session_hydrated": {
      const f = frame as {
        hasHistory: boolean;
        visionCapable: boolean;
        truncated?: boolean;
        truncatedCount?: number;
      };
      return {
        ...state,
        hydration: {
          hydrated: true,
          hasHistory: f.hasHistory === true,
          visionCapable: f.visionCapable === true,
          truncated: f.truncated === true,
          truncatedCount: typeof f.truncatedCount === "number" ? f.truncatedCount : 0,
        },
        // CHATUX2-002: a (re)hydration is the session boundary — a queued
        // steer draft must never send into the session that follows.
        steerQueue: [],
      };
    }

    case "turn_started": {
      const f = frame as { turnId: string; clientRequestId: string };
      if (state.turn !== null && !state.turn.closed) return state;
      if (state.awaitingAckRequestId === null || f.clientRequestId !== state.awaitingAckRequestId) {
        // Unacknowledged id mismatch: do not open the turn and do not touch the
        // draft. The user's text is never destroyed by an unrelated ack.
        return state;
      }
      return {
        ...state,
        phase: "validating",
        turn: { turnId: f.turnId, closed: false, outcome: null },
        awaitingAckRequestId: null,
        pendingSubmit: null,
        // A new turn consumes the previous draft: inline rejection notices for
        // the sent batch have served their purpose.
        attachNotices: [],
        draft: {
          ...state.draft,
          text: "",
          selectionStart: 0,
          selectionEnd: 0,
          revision: state.draft.revision + 1,
          attachments: [],
          context: [],
        },
      };
    }

    case "phase": {
      const f = frame as { turnId: string; phase: TurnPhase };
      if (isTerminalPhase(state.phase)) return state;
      return { ...state, phase: f.phase };
    }

    case "text_delta": {
      const f = frame as { turnId: string; messageId: string; text: string };
      const transcript = upsertStreamingText(state.transcript, "text", f.messageId, f.turnId, f.messageId, f.text);
      return { ...state, transcript, phase: nextStreamingPhase(state.phase) };
    }

    case "reasoning_delta": {
      const f = frame as { turnId: string; messageId: string; text: string };
      const id = `reasoning-${f.messageId}`;
      const transcript = upsertStreamingText(state.transcript, "reasoning", id, f.turnId, f.messageId, f.text);
      return { ...state, transcript };
    }

    case "tool_started": {
      const f = frame as {
        turnId: string;
        toolId: string;
        label: string;
        action: string;
        detail?: string;
      };
      const item: ChatToolItem = {
        id: f.toolId,
        kind: "tool",
        turnId: f.turnId,
        toolId: f.toolId,
        label: f.label,
        action: f.action,
        // TASK-CHATFIX-003: absent/legacy field degrades to "" (never invented).
        detail: typeof f.detail === "string" ? f.detail : "",
        status: "running",
        summary: "",
        durationMs: null,
      };
      return { ...state, transcript: putItem(state.transcript, f.toolId, item) };
    }

    case "tool_finished": {
      const f = frame as {
        turnId: string;
        toolId: string;
        label: string;
        status: AiChatToolStatusV2;
        summary: string;
        durationMs?: number;
      };
      const existing = state.transcript.entities[f.toolId];
      const item: ChatToolItem = {
        id: f.toolId,
        kind: "tool",
        turnId: f.turnId,
        toolId: f.toolId,
        label: f.label,
        action: existing?.kind === "tool" ? existing.action : "",
        // TASK-CHATFIX-003: the terminal frame carries no detail — the start
        // frame's value is authoritative and is preserved here.
        detail: existing?.kind === "tool" ? existing.detail : "",
        status: f.status,
        summary: f.summary,
        durationMs: typeof f.durationMs === "number" ? f.durationMs : null,
      };
      return { ...state, transcript: putItem(state.transcript, f.toolId, item) };
    }

    case "permission_requested": {
      const f = frame as {
        turnId: string;
        requestId: string;
        tool: { id: string; name: string; detail: string };
        options: readonly { optionId: string; label: string }[];
      };
      const seen = state.pendingHostRequests.some((r) => r.requestId === f.requestId);
      const pendingHostRequests = seen
        ? state.pendingHostRequests
        : [...state.pendingHostRequests, { requestId: f.requestId, turnId: f.turnId, tool: f.tool, options: f.options }];
      return { ...state, pendingHostRequests, phase: "awaiting_permission" };
    }

    case "warning":
      return pushToast(state, "warning", (frame as { safeMessage: string }).safeMessage);

    case "error": {
      const f = frame as { category?: string; safeMessage: string; diagnosticId: string; safeDetail?: string };
      const mapped = mapHostChatError({ category: f.category, detail: f.safeDetail });
      // The host safe copy/id are authoritative; the closed matrix supplies only
      // the permitted action vocabulary and category (unknown on absent/invalid).
      const error = {
        frame: {
          ...mapped,
          safeMessage: f.safeMessage,
          diagnosticId: f.diagnosticId,
          ...(f.safeDetail === undefined ? {} : { safeDetail: f.safeDetail }),
        },
        request: state.lastSubmittedRequest,
      };
      const banners = [
        ...state.banners,
        {
          id: `banner-${f.diagnosticId}`,
          level: "error" as const,
          title: "Could not complete this response",
          message: f.safeMessage,
          diagnosticId: f.diagnosticId,
        },
      ];
      const transcript = sealStreaming(state.transcript);
      const turn = state.turn === null ? null : { ...state.turn, closed: true, outcome: "failed" as const };
      return { ...state, phase: "failed", banners, error, transcript, turn };
    }

    case "turn_finished": {
      const f = frame as { turnId: string; outcome: "completed" | "stopped" | "failed" };
      if (state.turn === null || state.turn.closed) return state;
      const transcript = sealStreaming(state.transcript);
      // TASK-CHATV2-014: a terminal turn can never be answered. Drop the
      // requests it owned so a Stop/settle does not leave a live sheet asking
      // about a dead turn (durable Stop behaviour, not host-trust dependent).
      const pendingHostRequests = state.pendingHostRequests.filter((r) => r.turnId !== f.turnId);
      return {
        ...state,
        phase: f.outcome === "failed" ? "failed" : "completed",
        turn: { ...state.turn, closed: true, outcome: f.outcome },
        transcript,
        pendingHostRequests,
        pendingStop: null,
      };
    }

    case "mention_results": {
      const f = frame as AiChatHostFrameMentionResultsV2;
      const ac = state.autocomplete;
      // Apply ONLY when the popover is still open on the same request+revision.
      if (!ac.open || ac.requestId !== f.requestId || ac.draftRevision !== f.draftRevision) {
        return state;
      }
      return {
        ...state,
        autocomplete: { ...ac, items: f.items, loading: false, activeIndex: 0 },
      };
    }

    case "models": {
      const f = frame as { active: string; roles: readonly { role: string; modelId: string; vision: boolean }[] };
      return { ...state, models: { active: f.active, roles: f.roles } };
    }

    case "schema": {
      const f = frame as { schema: string | undefined; connectionId: string | undefined };
      return { ...state, schema: { schema: f.schema ?? null, connectionId: f.connectionId ?? null } };
    }

    case "toast": {
      const f = frame as { level: "info" | "warning" | "error"; safeMessage: string };
      return pushToast(state, f.level, f.safeMessage);
    }

    case "export_completed":
      return pushToast(state, "info", `Exported ${(frame as { name: string }).name}.`);

    case "export_failed": {
      const f = frame as { safeMessage: string; diagnosticId: string };
      return pushToast(state, "error", `${f.safeMessage} (${f.diagnosticId})`);
    }

    case "sessions": {
      const f = frame as { items: readonly { sessionId: string; label: string; detail: string }[] };
      return { ...state, sessions: f.items };
    }

    case "change_plan": {
      const f = frame as ChatChangePlan;
      return { ...state, changePlan: { tool: f.tool, plan: f.plan } };
    }

    case "title_updated":
      return { ...state, sessionTitle: (frame as { title: string }).title };

    case "context_status":
      // Grounded-context status is advisory; no reducer field is authoritative
      // for it yet (a later task adds the strip model).
      return state;

    case "attach_error": {
      // TASK-CHATV2-013: a host-side rejection is INLINE, per-item state. It
      // names one attachment id and the exact reason — it never mutates the
      // draft (a rejected sibling must not drop survivors), and its message is
      // already safe copy produced by the host.
      const f = frame as {
        id: string;
        reason: ChatAttachNotice["reason"];
        message: string;
      };
      const notice: ChatAttachNotice = {
        id: `attach-${f.id}-${f.reason}`,
        attachmentId: f.id,
        reason: f.reason,
        message: f.message,
      };
      if (state.attachNotices.some((n) => n.id === notice.id)) return state;
      return { ...state, attachNotices: [...state.attachNotices, notice].slice(-ATTACH_NOTICE_CAP) };
    }

    default:
      return state;
  }
}

/** Streaming phase only advances; it never reverts a stopping/terminal phase. */
function nextStreamingPhase(phase: TurnPhase): TurnPhase {
  if (isTerminalPhase(phase) || phase === "stopping" || phase === "awaiting_permission") return phase;
  return "streaming";
}

function pushToast(state: ChatViewState, level: ChatToast["level"], message: string): ChatViewState {
  const toast: ChatToast = { id: `toast-${message}`, level, message };
  const toasts = [...state.toasts, toast].slice(-TOAST_CAP);
  return { ...state, toasts };
}

// ---------------------------------------------------------------------------
// Local action application
// ---------------------------------------------------------------------------

function applyLocal(state: ChatViewState, action: ChatLocalAction): ChatViewState {
  switch (action.type) {
    case "DRAFT_CHANGED": {
      const text = action.text;
      const selectionStart = clamp(action.selectionStart ?? text.length, 0, text.length);
      const selectionEnd = clamp(action.selectionEnd ?? selectionStart, selectionStart, text.length);
      return {
        ...state,
        draft: { ...state.draft, text, selectionStart, selectionEnd, revision: state.draft.revision + 1 },
      };
    }

    case "SELECTION_CHANGED": {
      const len = state.draft.text.length;
      const a = clamp(action.selectionStart, 0, len);
      const b = clamp(action.selectionEnd, 0, len);
      return { ...state, draft: { ...state.draft, selectionStart: Math.min(a, b), selectionEnd: Math.max(a, b) } };
    }

    case "ATTACHMENT_ADDED": {
      if (state.draft.attachments.some((a) => a.id === action.attachment.id)) return state;
      return { ...state, draft: { ...state.draft, attachments: [...state.draft.attachments, action.attachment] } };
    }

    case "ATTACHMENT_REMOVED": {
      const attachments = state.draft.attachments.filter((a) => a.id !== action.id);
      if (attachments.length === state.draft.attachments.length) return state;
      return { ...state, draft: { ...state.draft, attachments } };
    }

    case "CONTEXT_ADDED": {
      if (state.draft.context.some((r) => r.id === action.ref.id)) return state;
      return { ...state, draft: { ...state.draft, context: [...state.draft.context, action.ref] } };
    }

    case "CONTEXT_REMOVED": {
      const context = state.draft.context.filter((r) => r.id !== action.refId);
      if (context.length === state.draft.context.length) return state;
      return { ...state, draft: { ...state.draft, context } };
    }

    case "CONTEXT_REF_RESOLVED": {
      // The HOST's re-validated status is authoritative — the webview never
      // invents one. Only that one ref changes; siblings are untouched.
      let changed = false;
      const context = state.draft.context.map((ref) => {
        if (ref.id !== action.refId) return ref;
        if (ref.status === action.status) return ref;
        changed = true;
        return { ...ref, status: action.status, changed: action.status === "changed", missing: action.status === "missing" };
      });
      if (!changed) return state;
      return { ...state, draft: { ...state.draft, context } };
    }

    case "AUTOCOMPLETE_OPENED":
      return {
        ...state,
        autocomplete: {
          open: true,
          mode: action.mode,
          requestId: action.requestId,
          draftRevision: action.draftRevision,
          query: action.query,
          items: [],
          activeIndex: 0,
          loading: true,
          // Bumping the generation invalidates every in-flight response for a
          // previous open state.
          generation: state.autocomplete.generation + 1,
        },
      };

    case "AUTOCOMPLETE_CLOSED": {
      if (!state.autocomplete.open && state.autocomplete.mode === "draft") return state;
      return {
        ...state,
        autocomplete: {
          ...state.autocomplete,
          open: false,
          mode: "draft",
          requestId: null,
          items: [],
          activeIndex: 0,
          loading: false,
          // A close is a new generation: a late mention response can never
          // reopen the popover.
          generation: state.autocomplete.generation + 1,
        },
      };
    }

    case "AUTOCOMPLETE_ACTIVE_MOVED": {
      const ac = state.autocomplete;
      if (!ac.open || ac.items.length === 0) return state;
      const activeIndex = clamp(ac.activeIndex + action.delta, 0, ac.items.length - 1);
      if (activeIndex === ac.activeIndex) return state;
      return { ...state, autocomplete: { ...ac, activeIndex } };
    }

    case "COLLAPSE_TOGGLED": {
      const layout = { ...state.layout };
      return action.panel === "transcript"
        ? { ...state, layout: { ...layout, collapsedTranscript: !layout.collapsedTranscript } }
        : { ...state, layout: { ...layout, collapsedActivities: !layout.collapsedActivities } };
    }

    case "SCROLL_PROXIMITY_CHANGED": {
      const near = action.distancePx <= SCROLL_NEAR_BOTTOM_PX;
      return { ...state, layout: { ...state.layout, scrollNearBottom: near, unreadCount: near ? 0 : state.layout.unreadCount } };
    }

    case "SUBMIT_REQUESTED": {
      if (isBusyPhase(state.phase)) return state;
      const draft = action.draft ?? state.draft;
      const userItem: ChatUserItem = {
        id: `user-${action.clientRequestId}`,
        kind: "user",
        clientRequestId: action.clientRequestId,
        text: draft.text,
        context: draft.context,
      };
      return {
        ...state,
        phase: "validating",
        error: null,
        transcript: putItem(state.transcript, userItem.id, userItem),
        pendingHostRequests: [],
        pendingSubmit: { clientRequestId: action.clientRequestId, draft },
        lastSubmittedRequest: { clientRequestId: action.clientRequestId, draft },
        awaitingAckRequestId: action.clientRequestId,
      };
    }

    case "SUBMIT_CONSUMED": {
      if (state.pendingSubmit === null || state.pendingSubmit.clientRequestId !== action.clientRequestId) {
        return state;
      }
      return { ...state, pendingSubmit: null };
    }

    case "STEER_ENQUEUED": {
      // CHATUX2-002: Enter-while-busy queues a snapshot of the live draft and
      // clears the composer text for the next one. Only while a turn is live
      // and only under the cap — at the cap the draft stays put (same-state
      // no-op) so nothing is ever silently dropped.
      if (!isBusyPhase(state.phase)) return state;
      if (state.steerQueue.length >= STEER_QUEUE_CAP) return state;
      return {
        ...state,
        steerQueue: [...state.steerQueue, { ...state.draft }],
        draft: {
          ...state.draft,
          text: "",
          selectionStart: 0,
          selectionEnd: 0,
          revision: state.draft.revision + 1,
        },
      };
    }

    case "STEER_DEQUEUED": {
      // The controller pops the head right before re-submitting it; an empty
      // queue is a same-state no-op.
      if (state.steerQueue.length === 0) return state;
      return { ...state, steerQueue: state.steerQueue.slice(1) };
    }

    case "STOP_REQUESTED": {
      // Stop intent records the effect but does NOT move the phase yet: the
      // phase changes only after the controller dispatches it.
      if (!isBusyPhase(state.phase) || state.pendingStop !== null) return state;
      return { ...state, pendingStop: { clientRequestId: action.clientRequestId } };
    }

    case "STOP_DISPATCHED": {
      if (state.pendingStop === null || state.pendingStop.clientRequestId !== action.clientRequestId) {
        return state;
      }
      return { ...state, phase: "stopping", pendingStop: { clientRequestId: action.clientRequestId } };
    }

    case "PERMISSION_RESPONDED": {
      const pendingHostRequests = state.pendingHostRequests.filter((r) => r.requestId !== action.requestId);
      if (pendingHostRequests.length === state.pendingHostRequests.length && state.phase !== "awaiting_permission") {
        return state;
      }
      return {
        ...state,
        pendingHostRequests,
        phase: pendingHostRequests.length === 0 && state.phase === "awaiting_permission" ? "streaming" : state.phase,
      };
    }

    case "TRANSCRIPT_PAGE_LOADED": {
      let transcript = state.transcript;
      for (const item of action.items) {
        transcript = putItem(transcript, item.id, item);
      }
      const total = Math.max(action.total, transcript.order.length);
      return {
        ...state,
        transcript: { ...transcript, paging: { cap: RENDER_CAP, total, hasMore: transcript.order.length > RENDER_CAP || total > transcript.order.length } },
      };
    }

    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Pure, exhaustive reducer. Unknown/malformed input returns the SAME state. */
export function reduceChatState(state: ChatViewState, action: ChatAction): ChatViewState {
  if (action.type === "HOST_FRAME") {
    const frame = action.frame;
    if (!frameAccepted(state, frame)) return sameState(state);

    const adopted: ChatViewState =
      state.sessionId === null ? { ...state, sessionId: frame.sessionId } : state;

    const body = frame as unknown as Record<string, unknown>;
    const withSequence: ChatViewState = { ...adopted, lastSequence: frame.sequence };

    // Turn-scoped frames must resolve to the live open turn; everything else is
    // applied directly.
    if (TURN_SCOPED_KINDS.has(frame.kind)) {
      return applyTurnFrame(withSequence, frame, body);
    }
    return applyFrameBody(withSequence, frame, body);
  }
  return applyLocal(state, action);
}

const TURN_SCOPED_KINDS: ReadonlySet<string> = new Set([
  "turn_started",
  "phase",
  "text_delta",
  "reasoning_delta",
  "tool_started",
  "tool_finished",
  "permission_requested",
  "turn_finished",
]);
