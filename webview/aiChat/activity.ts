// webview/aiChat/activity.ts — TASK-CHATV2-007
//
// The keyed activity timeline: turn-phase status header, per-tool lifecycle
// rows, and the gated reasoning section. It reads ONE pure `ChatViewState`
// (TASK-CHATV2-004) and never owns raw source in the DOM.
//
// CONTRACT
// - KEYED ROWS. Every tool item owns exactly one row, addressed by
//   `data-chat-key` = the host tool/event id. `tool_started` (running) creates
//   the row; a later `tool_finished` (ok/failed/denied/cancelled) UPDATES the
//   same row — never a second node.
// - CLOSED STATE SET. A wire status is mapped to the closed visual set
//   (queued/running/succeeded/denied/failed/cancelled). An unrecognised status
//   renders a safe generic warning and NEVER contributes a class name taken
//   from the wire.
// - TEXT-ONLY. Labels, summaries, engine names and reasoning text are written
//   through `textContent`. No `innerHTML`, no wire-derived class names.
// - REASONING GATE. Private reasoning is never labelled `Thinking`. When the
//   engine does not support thought streaming, or no allowed reasoning event
//   exists, the timeline shows the neutral `Working… Ns` status instead. When
//   allowed events exist they render in a collapsed `Reasoning` section that is
//   NOT announced in the live region and NOT persisted (nothing is written to
//   any storage here).
// - TRUTHFUL HEADER. The engine banner is Ready/Starting/Working/Unavailable,
//   derived from the capability snapshot + live phase. It is never hard-coded
//   to "streaming".
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no storage.

import type { AiChatTurnPhaseV2 } from "../../src/ui/aiChatPanelMessages";
import type { CapabilityStatus } from "../../src/ai/capabilities";
import type { ChatToolItem, ChatViewState } from "./store";
import { createChatIcon } from "./icons";
import { CHAT_V2_ROOT_CLASS } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

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

/** One optional allowlisted detail block for a single tool row. */
export interface ActivityDetailInput {
  /** Safe, host-allowlisted single line. Rendered with `textContent`. */
  readonly text: string;
  /** When true (and only then) a Copy control is offered for this detail. */
  readonly copyable?: boolean;
}

/** Optional per-render view inputs that do not live in `ChatViewState`. */
export interface ActivityViewInput {
  /** Seconds since the last user-visible event (from the timer service). */
  readonly elapsedSeconds?: number;
  /** Total turn duration in ms once the turn is terminal. */
  readonly turnDurationMs?: number | null;
  /** Allowlisted details keyed by tool/event id. Absent = no detail toggles. */
  readonly details?: Readonly<Record<string, ActivityDetailInput>>;
}

/** Container + live regions the timeline paints into. */
export interface ChatActivityRefs {
  /** The timeline mount point. The renderer owns its children. */
  readonly activities: HTMLElement;
  readonly statusLiveRegion?: HTMLElement | null;
  /** Reserved for future assertive announcements (never reasoning). */
  readonly alertLiveRegion?: HTMLElement | null;
  /** Optional shell header engine pill to keep in sync. */
  readonly engineButton?: HTMLElement | null;
  readonly engineLabel?: HTMLElement | null;
}

/** Controller callbacks. Missing callbacks make the control a no-op. */
export interface ActivityCallbacks {
  /** Copy one allowlisted detail line (fired only when `copyable`). */
  onCopyDetail?(toolId: string, text: string): void;
  /** Expanded/collapsed state changed (host may persist layout). */
  onToggleExpanded?(expanded: boolean): void;
}

/** Public timeline handle. */
export interface ActivityTimeline {
  /** Paint (or incrementally update) the timeline for `state`. */
  render(state: ChatViewState, view?: ActivityViewInput): void;
  /** Remove every node this timeline created. */
  dispose(): void;
}

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

/** Allowlisted icon per closed tool state (queued is a plain CSS dot). */
function toolStateIcon(state: ActivityToolState): "spinner" | "check" | "shield-alert" | "x" | "stop-square" | "warning" | null {
  switch (state) {
    case "running":
      return "spinner";
    case "succeeded":
      return "check";
    case "denied":
      return "shield-alert";
    case "failed":
      return "x";
    case "cancelled":
      return "stop-square";
    case "unknown":
      return "warning";
    default:
      return null; // queued — gray dot
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
function isActivePhase(phase: AiChatTurnPhaseV2): boolean {
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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function cls(name: string): string {
  return `${PREFIX}-activity-${name}`;
}

function el(tag: string, ...classes: string[]): HTMLElement {
  const node = document.createElement(tag);
  node.className = classes.join(" ");
  return node;
}

/** Per-tool row bookkeeping. */
interface ToolRecord {
  readonly root: HTMLElement;
  readonly icon: HTMLElement;
  readonly label: HTMLElement;
  readonly status: HTMLElement;
  readonly duration: HTMLElement;
  readonly toggle: HTMLButtonElement | null;
  readonly details: HTMLElement | null;
  readonly copy: HTMLButtonElement | null;
  state: ActivityToolState;
  announced: boolean;
}

let uid = 0;
function nextId(suffix: string): string {
  uid += 1;
  return `${PREFIX}-activity-${suffix}-${uid}`;
}

/**
 * Create the activity timeline bound to `refs`.
 */
export function createActivityTimeline(
  refs: ChatActivityRefs,
  callbacks: ActivityCallbacks = {},
): ActivityTimeline {
  const container = refs.activities;
  const toolRecords = new Map<string, ToolRecord>();
  let disposed = false;

  // Header (collapsed summary) + body (rows) are created once.
  const header = el("button", cls("header"));
  header.type = "button";
  const bodyId = nextId("body");
  header.setAttribute("aria-controls", bodyId);
  header.setAttribute("aria-expanded", "false");

  const chevron = el("span", cls("chevron"));
  chevron.setAttribute("aria-hidden", "true");
  chevron.appendChild(createChatIcon("chevron-right", 12));
  header.appendChild(chevron);

  const engineIcon = el("span", cls("header-state"));
  engineIcon.setAttribute("aria-hidden", "true");
  header.appendChild(engineIcon);

  const summary = el("span", cls("summary"));
  header.appendChild(summary);

  const headerDuration = el("span", cls("duration"));
  header.appendChild(headerDuration);

  const body = el("div", cls("body"));
  body.id = bodyId;
  body.setAttribute("role", "list");

  container.append(header, body);

  // Reasoning section — built LAZILY, only once the gate opens, so an engine
  // without thought streaming never advertises a `Reasoning` label at all.
  let reasoning: HTMLElement | null = null;
  let reasoningHeader: HTMLButtonElement | null = null;
  let reasoningBody: HTMLElement | null = null;

  let expanded = false;
  let reasoningExpanded = false;
  let lastAnnouncedPhase: AiChatTurnPhaseV2 | null = null;

  function syncExpanded(): void {
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    body.hidden = !expanded;
    chevron.textContent = "";
    chevron.appendChild(createChatIcon(expanded ? "chevron-down" : "chevron-right", 12));
  }

  function syncReasoningExpanded(): void {
    if (!reasoningHeader || !reasoningBody) return;
    reasoningHeader.setAttribute("aria-expanded", reasoningExpanded ? "true" : "false");
    reasoningBody.hidden = !reasoningExpanded;
  }

  /** Create the collapsed Reasoning section on first allowed reasoning event. */
  function ensureReasoningSection(): void {
    if (reasoning !== null) return;
    const section = el("div", cls("reasoning"));
    const head = el("button", cls("reasoning-header"));
    head.type = "button";
    const bodyEl = el("div", cls("reasoning-body"));
    const rid = nextId("reasoning-body");
    head.setAttribute("aria-controls", rid);
    head.setAttribute("aria-expanded", "false");
    head.textContent = "Reasoning";
    bodyEl.id = rid;
    bodyEl.hidden = true;
    head.addEventListener("click", () => {
      reasoningExpanded = !reasoningExpanded;
      syncReasoningExpanded();
    });
    section.append(head, bodyEl);
    container.appendChild(section);
    reasoning = section;
    reasoningHeader = head;
    reasoningBody = bodyEl;
    syncReasoningExpanded();
  }

  header.addEventListener("click", () => {
    expanded = !expanded;
    syncExpanded();
    callbacks.onToggleExpanded?.(expanded);
  });
  syncExpanded();

  function announce(message: string): void {
    const region = refs.statusLiveRegion;
    if (region && message.length > 0) region.textContent = message;
  }

  /** Render one icon into a holder, replacing any previous glyph. */
  function paintIcon(holder: HTMLElement, state: ActivityToolState): void {
    holder.textContent = "";
    // Closed-set class only — never a wire value.
    holder.className = `${cls("icon")} ${cls(`state-${state}`)}`;
    const icon = toolStateIcon(state);
    if (icon) holder.appendChild(createChatIcon(icon, 16));
    else holder.appendChild(el("span", cls("dot")));
  }

  function createToolRecord(item: ChatToolItem): ToolRecord {
    const root = el("div", cls("row"));
    root.setAttribute("role", "listitem");
    root.setAttribute("data-chat-key", item.id);

    const icon = el("span", cls("icon"));
    icon.setAttribute("aria-hidden", "true");
    root.appendChild(icon);

    const label = el("span", cls("label"));
    root.appendChild(label);

    const status = el("span", cls("status"));
    root.appendChild(status);

    const duration = el("span", cls("row-duration"));
    root.appendChild(duration);

    const record: ToolRecord = {
      root,
      icon,
      label,
      status,
      duration,
      toggle: null,
      details: null,
      copy: null,
      state: "queued",
      announced: false,
    };
    return record;
  }

  function ensureDetail(record: ToolRecord, item: ChatToolItem, detail: ActivityDetailInput): void {
    const detailId = nextId("detail");
    const toggle = el("button", cls("detail-toggle"));
    toggle.type = "button";
    toggle.setAttribute("aria-controls", detailId);
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Show details");
    toggle.appendChild(createChatIcon("chevron-right", 12));
    const pane = el("div", cls("detail"));
    pane.id = detailId;
    pane.hidden = true;
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      pane.hidden = !open;
    });

    record.root.append(toggle, pane);
    (record as { toggle: HTMLButtonElement | null }).toggle = toggle;
    (record as { details: HTMLElement | null }).details = pane;
    if (detail.copyable === true) ensureCopy(record, item, detail.text);
  }

  /** Add the copy control for an allowlisted+copyable detail, at most once. */
  function ensureCopy(record: ToolRecord, item: ChatToolItem, text: string): void {
    if (record.copy !== null || record.details === null) return;
    if (typeof callbacks.onCopyDetail !== "function") return;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = cls("copy");
    copy.setAttribute("aria-label", "Copy details");
    copy.title = "Copy details";
    copy.appendChild(createChatIcon("copy", 14));
    copy.addEventListener("click", () => callbacks.onCopyDetail?.(item.id, text));
    record.details.appendChild(copy);
    (record as { copy: HTMLButtonElement | null }).copy = copy;
  }

  function updateTool(item: ChatToolItem, record: ToolRecord, detail: ActivityDetailInput | undefined): void {
    const state = mapToolState(item.status);
    if (state !== record.state) {
      record.state = state;
      paintIcon(record.icon, state);
    }
    // textContent only — labels/status copy never become markup.
    record.label.textContent = item.label;
    record.status.textContent = toolStateLabel(state);
    record.status.setAttribute("data-state", state);
    // ROW-LEVEL class derived from the closed set only.
    record.root.setAttribute("data-state", state);

    const dur = formatDuration(item.durationMs);
    record.duration.textContent = dur ?? "";
    record.duration.hidden = dur === null;

    // Detail toggle appears only for an allowlisted, non-empty host detail.
    if (detail && detail.text.length > 0) {
      if (record.toggle === null) ensureDetail(record, item, detail);
      else if (detail.copyable === true) ensureCopy(record, item, detail.text);
      const pane = record.details;
      if (pane) {
        // Detail text is a leading child so the copy control keeps identity.
        const existing = pane.querySelector<HTMLElement>(`.${cls("detail-text")}`);
        const textNode = existing ?? el("span", cls("detail-text"));
        textNode.textContent = detail.text;
        if (!existing) pane.insertBefore(textNode, pane.firstChild);
      }
    } else if (record.toggle) {
      record.toggle.hidden = true;
      if (record.details) record.details.hidden = true;
    }

    // Announce terminal tool transitions once (never reasoning).
    if (!record.announced && state !== "queued" && state !== "running") {
      record.announced = true;
      announce(`${item.label}: ${toolStateLabel(state)}`);
    }
  }

  function render(state: ChatViewState, view: ActivityViewInput = {}): void {
    if (disposed) return;

    const caps = state.capabilities;
    const turnOpen = state.turn !== null && !state.turn.closed;
    const engineState = deriveEngineState(caps?.status ?? null, state.phase, turnOpen);
    const engineLabel = engineStateLabel(engineState);

    // Header engine pill (optional refs).
    if (refs.engineButton) {
      refs.engineButton.classList.remove(
        `${PREFIX}-engine-ready`,
        `${PREFIX}-engine-starting`,
        `${PREFIX}-engine-working`,
        `${PREFIX}-engine-unavailable`,
      );
      refs.engineButton.classList.add(`${PREFIX}-engine-${engineState}`);
    }
    if (refs.engineLabel) refs.engineLabel.textContent = engineLabel;

    // Tool rows: keyed by event id, in transcript order.
    const toolIds = state.transcript.order.filter((id) => state.transcript.entities[id]?.kind === "tool");

    for (const [id, record] of toolRecords) {
      if (!toolIds.includes(id)) {
        record.root.remove();
        toolRecords.delete(id);
      }
    }

    let reference: Node | null = null;
    for (const id of toolIds) {
      const item = state.transcript.entities[id];
      if (!item || item.kind !== "tool") continue;
      let record = toolRecords.get(id);
      if (!record) {
        record = createToolRecord(item);
        toolRecords.set(id, record);
      }
      updateTool(item, record, view.details?.[id]);
      // Reconcile order (move only when out of place).
      if (reference === null) {
        if (body.firstChild !== record.root) body.insertBefore(record.root, body.firstChild);
      } else if (reference.nextSibling !== record.root) {
        body.insertBefore(record.root, reference.nextSibling);
      }
      reference = record.root;
    }

    // Reasoning gate: capability + at least one allowed event.
    const reasoningAllowed = caps?.supports.streamThought === true;
    const reasoningIds = reasoningAllowed
      ? state.transcript.order.filter((id) => state.transcript.entities[id]?.kind === "reasoning")
      : [];
    const hasReasoning = reasoningIds.length > 0;

    // Header summary: semantic counts + duration, never raw tool output.
    const toolCount = toolIds.length;
    const parts: string[] = [];
    parts.push(toolCount === 1 ? "1 tool" : `${toolCount} tools`);
    if (reasoningAllowed && hasReasoning) parts.push("Reasoning");
    const phaseCopy = phaseCopyLabel(state.phase, {
      displayName: caps?.displayName,
      elapsedSeconds: view.elapsedSeconds,
    });
    if (phaseCopy.length > 0) parts.push(phaseCopy);
    const turnDuration = formatDuration(view.turnDurationMs ?? null);
    summary.textContent = parts.join(" · ");
    headerDuration.textContent = turnDuration ?? "";

    if (hasReasoning) {
      // Safe, textContent-only reasoning body. Collapsed by default. NEVER
      // announced in the live region.
      ensureReasoningSection();
      const texts = reasoningIds
        .map((id) => state.transcript.entities[id])
        .filter((it): it is Extract<typeof it, { kind: "reasoning" }> => it?.kind === "reasoning")
        .map((it) => it.raw);
      if (reasoningBody) reasoningBody.textContent = texts.join("");
    } else if (reasoning !== null) {
      reasoning.hidden = true;
      if (reasoningBody) reasoningBody.textContent = "";
    }

    // Announce phase transitions only (this is where reasoning is filtered
    // out by construction — it never reaches `announce`).
    if (state.phase !== lastAnnouncedPhase) {
      lastAnnouncedPhase = state.phase;
      if (isActivePhase(state.phase)) announce(phaseCopy);
    }
  }

  return {
    render,
    dispose(): void {
      disposed = true;
      toolRecords.clear();
      container.textContent = "";
    },
  };
}
