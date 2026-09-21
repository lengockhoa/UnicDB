// webview/aiChat/activity.ts — TASK-CHATV2-007, cut over in CHATUX2-004
//
// Pure helpers for turn-phase copy, tool/engine state mapping and duration
// formatting. The DOM timeline renderer was DELETED in CHATUX2-004: the keyed
// transcript (transcript.ts) is the single renderer for `shell.transcript`,
// so nothing here may touch the DOM.
//
// CONTRACT
// - CLOSED STATE SET. A wire status is mapped to the closed visual set
//   (queued/running/succeeded/denied/failed/cancelled). An unrecognised status
//   yields `unknown` and the neutral `UNKNOWN_STATUS_LABEL` copy.
// - TEXT-ONLY. Labels and engine names are safe copy for `textContent` —
//   never markup, never a wire-derived class name.
// - TRUTHFUL ENGINE STATE. `deriveEngineState` returns
//   Ready/Starting/Working/Unavailable from the capability snapshot + live
//   phase; it is never hard-coded to "streaming".
//
// Pure TypeScript: no `vscode`, no DOM, no node builtins, no storage.

import type { AiChatTurnPhaseV2 } from "../../src/ui/aiChatPanelMessages";
import type { CapabilityStatus } from "../../src/ai/capabilities";

/** Closed set of renderable tool visual states. */
export type ActivityToolState =
  | "queued"
  | "running"
  | "succeeded"
  | "denied"
  | "failed"
  | "cancelled"
  | "unknown";

/** Closed set of renderable header engine states. */
export type ActivityEngineState = "ready" | "starting" | "working" | "unavailable";

/** Neutral status copy for an unrecognised wire status. */
export const UNKNOWN_STATUS_LABEL = "Unknown status";

/** Fallback engine label when the host has not reported a display name. */
const ENGINE_FALLBACK = "engine";

/** Longest engine label accepted into copy. */
const ENGINE_LABEL_MAX = 40;

// ---------------------------------------------------------------------------
// Pure mappings (exported for tests + reuse)
// ---------------------------------------------------------------------------

/** Map any wire status string onto the closed visual set. */
export function mapToolState(status: unknown): ActivityToolState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "ok":
    case "succeeded":
      return "succeeded";
    case "denied":
      return "denied";
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Visible status copy for a closed tool state. */
export function toolStateLabel(state: ActivityToolState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "denied":
      return "Denied";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return UNKNOWN_STATUS_LABEL;
  }
}

/** Normalise a host engine label into safe, single-line copy. */
function sanitizeEngineLabel(value: unknown): string {
  if (typeof value !== "string") return ENGINE_FALLBACK;
  const stripped = value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return ENGINE_FALLBACK;
  return collapsed.length > ENGINE_LABEL_MAX ? collapsed.slice(0, ENGINE_LABEL_MAX) : collapsed;
}

/** Format a duration in ms as `N.Ns`. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** True for phases that represent live work. */
export function isActivePhase(phase: AiChatTurnPhaseV2): boolean {
  return (
    phase === "validating" ||
    phase === "connecting" ||
    phase === "waiting_for_first_event" ||
    phase === "streaming" ||
    phase === "awaiting_permission" ||
    phase === "stopping"
  );
}

/** Derive the truthful header engine state. Never hard-coded to streaming. */
export function deriveEngineState(
  status: CapabilityStatus | null,
  phase: AiChatTurnPhaseV2,
  turnOpen: boolean,
): ActivityEngineState {
  if (status === null) return "starting";
  if (status === "starting") return "starting";
  if (status === "unavailable" || status === "fallback") return "unavailable";
  return turnOpen && isActivePhase(phase) ? "working" : "ready";
}

/** Visible header label for an engine state. */
export function engineStateLabel(state: ActivityEngineState): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "working":
      return "Working";
    case "unavailable":
      return "Unavailable";
    default:
      return "Ready";
  }
}

/** Context needed to render phase copy. */
export interface PhaseCopyContext {
  readonly displayName?: unknown;
  readonly elapsedSeconds?: number;
}

/**
 * Exact phase copy (PLAN §6). `failed` belongs to the error component, so it
 * yields the empty string here rather than inventing a status.
 */
export function phaseCopyLabel(phase: AiChatTurnPhaseV2, ctx: PhaseCopyContext = {}): string {
  switch (phase) {
    case "validating":
      return "Preparing your request…";
    case "connecting":
      return `Connecting to ${sanitizeEngineLabel(ctx.displayName)}…`;
    case "waiting_for_first_event":
      return `Working… ${Math.max(0, Math.floor(ctx.elapsedSeconds ?? 0))}s`;
    case "streaming":
      return "Responding…";
    case "awaiting_permission":
      return "Waiting for your permission";
    case "stopping":
      return "Stopping…";
    case "completed":
      return "Completed"; // duration appended by the caller via formatDuration
    default:
      return "";
  }
}
