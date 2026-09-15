// src/ui/aiChatPanelV1Adapter.ts — TASK-CHATV2-003
//
// TEMPORARY V1 → V2 compatibility bridge. This is the ONLY module allowed to
// translate legacy host frames; no V1 translation logic may spread into
// components or renderers.
//
// DELETE IN CHATV2-017 once the host/webview V2 contract tests pass — see
// `V1_ADAPTER_DELETION_TASK` below and PLAN §9 ("The compatibility bridge is
// temporary and deleted in CHATV2-017").
//
// Purity contract: no `vscode`, no filesystem, no network, no child process —
// unit/webview importable. The translator is a pure function of its message +
// caller-supplied envelope context; it never throws and returns `null` for a
// legacy frame that has no semantic V2 form (the caller drops it).

import type { EngineCapabilitySnapshot } from "../ai/capabilities";
import type {
  AiChatFrameEnvelopeV2,
  AiChatHostFrameV2,
  AiChatToolStatusV2,
  AiChatTurnPhaseV2,
} from "./aiChatPanelMessages";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "./aiChatPanelMessages";
import type { AiChatPanelHostMessage } from "./aiChatPanelMessages";

/** The task that deletes this module. Pinned so 017 cannot silently skip it. */
export const V1_ADAPTER_DELETION_TASK = "CHATV2-017" as const;

/**
 * Per-frame envelope facts the host supplies when translating. The bridge does
 * NOT own the sequence counter — the panel's `postV2` wrapper does — it only
 * stamps the caller's current envelope onto the semantic frame.
 */
export interface V1TranslationContext {
  /** Live panel/session id. */
  readonly sessionId: string;
  /** Ordered sequence assigned to this frame by the host. */
  readonly sequence: number;
  /** Active turn id (turn-scoped frames). */
  readonly turnId?: string;
  /** Stable assistant message id for streamed text. */
  readonly messageId?: string;
  /** Stable tool id for tool frames. */
  readonly toolId?: string;
  /** Resolved capability snapshot (required to map an `engine` frame). */
  readonly capabilities?: EngineCapabilitySnapshot;
  /** Vision flag for a `history` frame (defaults to false). */
  readonly visionCapable?: boolean;
}

/** Terminal default used when a turn-scoped frame arrives with no active turn. */
const FALLBACK_TURN_ID = "turn-0";
const FALLBACK_MESSAGE_ID = "msg-0";
const FALLBACK_TOOL_ID = "tool-0";

/** Deterministic, display-safe diagnostic id derived from safe copy. No clock,
 * no random — the same message always yields the same id (CTX-04). */
function diagnosticIdForV1(copy: string): string {
  let hash = 0;
  for (let i = 0; i < copy.length; i++) {
    hash = (hash * 31 + copy.charCodeAt(i)) | 0;
  }
  return `diag-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Map the V1 `session_state.state` vocabulary onto V2 turn phases. */
function phaseForV1State(
  state: "connecting" | "running" | "done" | "error",
): AiChatTurnPhaseV2 {
  switch (state) {
    case "connecting":
      return "connecting";
    case "running":
      return "streaming";
    case "done":
      return "completed";
    case "error":
      return "failed";
  }
}

/**
 * Translate one legacy host message into exactly one semantic V2 frame.
 * Returns `null` when the message has no V2 mapping (unknown/unsupported kind)
 * — never throws. The caller appends the returned frame with the envelope it
 * supplied.
 */
export function translateV1HostMessage(
  msg: AiChatPanelHostMessage,
  ctx: V1TranslationContext,
): AiChatHostFrameV2 | null {
  const envelope: AiChatFrameEnvelopeV2 = {
    protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2,
    sessionId: ctx.sessionId,
    sequence: ctx.sequence,
  };
  const turnId = ctx.turnId ?? FALLBACK_TURN_ID;
  const messageId = ctx.messageId ?? FALLBACK_MESSAGE_ID;
  const toolId = ctx.toolId ?? FALLBACK_TOOL_ID;

  switch (msg.type) {
    case "init":
      return {
        ...envelope,
        kind: "session_hydrated",
        hasHistory: msg.hasHistory,
        visionCapable: msg.visionCapable,
      };

    case "engine":
      // No snapshot → no semantic capability frame can be produced.
      if (ctx.capabilities === undefined) return null;
      return { ...envelope, kind: "capabilities", capabilities: ctx.capabilities };

    case "session_state":
      return {
        ...envelope,
        kind: "phase",
        turnId: msg.turnId.length > 0 ? msg.turnId : turnId,
        phase: phaseForV1State(msg.state),
      };

    case "delta":
      return { ...envelope, kind: "text_delta", turnId, messageId, text: msg.text };

    case "thought":
      return { ...envelope, kind: "reasoning_delta", turnId, messageId, text: msg.text };

    case "step":
      return {
        ...envelope,
        kind: "tool_started",
        turnId,
        toolId,
        label: msg.label,
        action: "tool",
      };

    case "tool_result":
      return {
        ...envelope,
        kind: "tool_finished",
        turnId,
        toolId,
        label: msg.tool,
        status: msg.status satisfies AiChatToolStatusV2,
        summary: msg.summary,
      };

    case "assistant":
      return {
        ...envelope,
        kind: "text_delta",
        turnId,
        messageId,
        text: msg.text,
        markdown: msg.markdown,
      };

    case "error":
      return {
        ...envelope,
        kind: "error",
        turnId,
        safeMessage: msg.message,
        diagnosticId: diagnosticIdForV1(msg.message),
      };

    case "done":
      return { ...envelope, kind: "turn_finished", turnId, outcome: "completed" };

    case "models":
      return {
        ...envelope,
        kind: "models",
        active: msg.active,
        roles: msg.roles.map((r) => ({
          role: r.role,
          modelId: r.modelId,
          vision: r.vision,
        })),
      };

    case "schemaChanged":
      return { ...envelope, kind: "schema", schema: msg.schema, connectionId: msg.connectionId };

    case "grounding_state":
      return {
        ...envelope,
        kind: "context_status",
        turnId: msg.turnId.length > 0 ? msg.turnId : turnId,
        selectionPath: msg.selectionPath,
        fileCount: msg.fileCount,
        excludedCount: msg.excludedCount,
      };

    case "permission_request":
      return {
        ...envelope,
        kind: "permission_requested",
        turnId,
        requestId: msg.requestId,
        tool: { id: msg.tool.id, name: msg.tool.name, detail: msg.tool.detail },
        options: msg.options.map((o) => ({ optionId: o.optionId, label: o.label })),
      };

    case "history":
      return {
        ...envelope,
        kind: "session_hydrated",
        hasHistory: msg.items.length > 0,
        visionCapable: ctx.visionCapable === true,
        truncated: msg.truncated,
        truncatedCount: msg.truncatedCount,
      };

    default:
      // Unknown / not-yet-migrated legacy kind — dropped, never thrown.
      return null;
  }
}
