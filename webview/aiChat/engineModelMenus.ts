// webview/aiChat/engineModelMenus.ts — TASK-CHATV2-012
//
// Engine and model selection for the V2 chat header/composer. Two independent
// controls with two independent menus:
//
//   - ENGINE MENU (opened from the header pill): the four known engines, each
//     painted from HOST-provided data (display name + status + resolution).
//     Unsupported/not-installed rows open setup help but can never be selected.
//   - MODEL MENU (opened from the composer chip): the host-advertised roles.
//     With nothing configured the chip opens SETTINGS — never an empty menu.
//
// ACKNOWLEDGED SWITCHING (`createEngineSwitchView`). A selection is a REQUEST,
// never an optimistic label change:
//   - idle   → emit `set_engine(clientRequestId, engine)`; the old pill/state
//              stay until a `capabilities` ack whose `clientRequestId` matches.
//   - busy   → a modal confirmation (`Stop and switch` / `Cancel`, Cancel is
//              the default, Escape cancels). Confirming sends ONE stop and
//              defers the switch until the turn is terminal.
//   - failure→ the old engine/model stay and a safe toast is shown.
//   - stale  → an ack whose clientRequestId is no longer pending is IGNORED.
//
// The menus never touch the composer draft: nothing here reads or writes
// `ChatViewState.draft`, so an unsent draft and its context survive every
// open, cancel, confirm and failure.
//
// FEATURE BRANCHING RULE. Nothing in this file branches a FEATURE on an engine
// name. Availability and capability come from host data; the four-engine list
// is DATA, not an `if engine ===` chain.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import type {
  AiEngineName,
  CapabilityStatus,
} from "../../src/ai/capabilities";
import type { AiModelRole } from "../../src/ai/settings";
import { createChatIcon } from "./icons";
import {
  createConfirmDialog,
  createOverlayMenu,
  OVERLAY_ROW_ICON_PX,
  type ConfirmDialog,
  type OverlayMenu,
  type OverlayMenuRow,
} from "./overlays";
import type { ChatViewState, ChatModelsState, TurnPhase } from "./store";

/** The V2 root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** Canonical menu order (task spec: OMP, Claude Code, Codex, Builtin). Frozen. */
export const ENGINE_MENU_ORDER: readonly AiEngineName[] = Object.freeze([
  "omp",
  "claude-code",
  "codex",
  "builtin",
] as const);

/** Per-role label shown in a model row (task spec). */
export const MODEL_ROLE_LABELS: Readonly<Record<AiModelRole, string>> = Object.freeze({
  work: "Work",
  smart: "Smart",
  lite: "Lite",
  autocomplete: "Autocomplete",
});

/** Per-role quality/latency badge (task spec: "quality/latency badge"). */
export const MODEL_ROLE_BADGES: Readonly<Record<AiModelRole, string>> = Object.freeze({
  work: "Standard",
  smart: "High",
  lite: "Fast",
  autocomplete: "Fast",
});

/** Canonical model-row order (task spec: Work/Smart/Lite/Autocomplete). */
export const MODEL_MENU_ORDER: readonly AiModelRole[] = Object.freeze([
  "work",
  "smart",
  "lite",
  "autocomplete",
] as const);

/** Chip copy when the host advertises no configured role at all. */
export const MODEL_CHIP_EMPTY = "Choose model";
/** Chip copy when the host advertises no configured role at all. */
export const MODEL_CHIP_UNCONFIGURED = "No model configured";

/** Busy engine-switch confirmation copy + exact button labels. */
export const ENGINE_SWITCH_CONFIRM_TITLE = "Switch engine";
export const ENGINE_SWITCH_CONFIRM_STOP_LABEL = "Stop and switch";
export const ENGINE_SWITCH_CONFIRM_CANCEL_LABEL = "Cancel";

/** Build the exact busy-switch body copy for `displayName`. */
export function engineSwitchConfirmBody(displayName: string): string {
  return `Stop the current response and switch to ${displayName}? Your unsent draft is preserved.`;
}

/** Build the exact failure toast copy for `displayName` + a safe reason. */
export function engineSwitchFailureCopy(displayName: string, reason: string): string {
  const safe = reason.trim().length > 0 ? reason.trim() : "It is not available right now.";
  return `Could not switch to ${displayName}. ${safe}`;
}

// ---------------------------------------------------------------------------
// Engine rows
// ---------------------------------------------------------------------------

/** Host-provided availability for one engine. DATA — never derived by name. */
export interface EngineMenuEntry {
  readonly engine: AiEngineName;
  /** Fixed, allowlisted display name (host-provided). */
  readonly displayName: string;
  /** Ready | Starting | Unavailable | Not installed (structural mirror). */
  readonly status: "ready" | "starting" | "unavailable" | "not-installed";
  /** One-line safe resolution shown when the engine cannot be selected. */
  readonly resolution: string;
  /** True when a setup/help affordance exists for a non-selectable row. */
  readonly setupAvailable?: boolean;
}

/** Human label for an engine status. */
export function engineStatusLabel(status: EngineMenuEntry["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "unavailable":
      return "Unavailable";
    case "not-installed":
      return "Not installed";
  }
}

/** A row is selectable only when the host reports it ready. */
export function isEngineSelectable(entry: EngineMenuEntry): boolean {
  return entry.status === "ready";
}

/** Build the menu row for one engine. `checked` marks the active engine. */
export function engineRowModel(
  entry: EngineMenuEntry,
  activeEngine: AiEngineName | null,
  onSetup: (engine: AiEngineName) => void,
): OverlayMenuRow {
  const selectable = isEngineSelectable(entry);
  const row: {
    -readonly [K in keyof OverlayMenuRow]: OverlayMenuRow[K];
  } = {
    id: entry.engine,
    label: entry.displayName,
    description: selectable ? engineStatusLabel(entry.status) : entry.resolution,
    meta: engineStatusLabel(entry.status),
    metaTone:
      entry.status === "ready"
        ? "success"
        : entry.status === "starting"
          ? "warning"
          : "danger",
    icon: "plug",
    iconSizePx: OVERLAY_ROW_ICON_PX,
    checked: activeEngine === entry.engine,
  };
  if (!selectable) {
    row.disabled = true;
    if (entry.setupAvailable === true) {
      row.action = { label: "Set up", onActivate: () => onSetup(entry.engine) };
    }
  }
  return row;
}

/** Build the full engine row list in the canonical order. */
export function buildEngineRows(
  entries: readonly EngineMenuEntry[],
  activeEngine: AiEngineName | null,
  onSetup: (engine: AiEngineName) => void,
): OverlayMenuRow[] {
  const byEngine = new Map<AiEngineName, EngineMenuEntry>();
  for (const entry of entries) byEngine.set(entry.engine, entry);
  const rows: OverlayMenuRow[] = [];
  for (const engine of ENGINE_MENU_ORDER) {
    const entry = byEngine.get(engine);
    if (entry === undefined) continue;
    rows.push(engineRowModel(entry, activeEngine, onSetup));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Engine pill
// ---------------------------------------------------------------------------

/** Status word shown on the pill. Nothing here is ever unconditionally
 * "streaming": the word is derived from the live capability status and the
 * current turn phase. */
export type EnginePillStatusWord = "Ready" | "Starting" | "Working" | "Unavailable";

export interface EnginePillModel {
  readonly displayName: string;
  readonly statusWord: EnginePillStatusWord;
  readonly label: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
}

/** Busy phases that mean the active engine is producing a response. */
const ENGINE_WORKING_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  "validating",
  "connecting",
  "waiting_for_first_event",
  "streaming",
  "awaiting_permission",
  "stopping",
]);

/** Map a capability status to the pill word. `fallback` means the ACTIVE
 * engine is running (a different requested engine was unavailable), so it is
 * truthfully "Ready" here; the fallback reason rides the banner instead. */
function statusWordFor(status: CapabilityStatus): EnginePillStatusWord {
  switch (status) {
    case "ready":
    case "fallback":
      return "Ready";
    case "starting":
      return "Starting";
    case "unavailable":
      return "Unavailable";
  }
}

/**
 * Resolve the engine pill from the live capability snapshot and turn phase.
 * A busy phase while the engine can run reports "Working"; an unavailable
 * engine never claims to be working.
 */
export function enginePillModel(state: {
  readonly capabilities: ChatViewState["capabilities"];
  readonly phase: TurnPhase;
}): EnginePillModel {
  const snapshot = state.capabilities;
  if (snapshot === null) {
    // Pre-hydration: the pill must not claim ready or streaming.
    return { displayName: "Engine", statusWord: "Starting", label: "Engine · Starting", tone: "neutral" };
  }
  const runnable = snapshot.status === "ready" || snapshot.status === "fallback";
  const working = runnable && ENGINE_WORKING_PHASES.has(state.phase);
  const statusWord: EnginePillStatusWord = working ? "Working" : statusWordFor(snapshot.status);
  const tone: EnginePillModel["tone"] =
    snapshot.status === "unavailable"
      ? "danger"
      : snapshot.status === "starting"
        ? "warning"
        : working
          ? "warning"
          : "success";
  return {
    displayName: snapshot.displayName,
    statusWord,
    label: `${snapshot.displayName} · ${statusWord}`,
    tone,
  };
}

/** Render the pill into its trigger element (reuses the shell's label/dot). */
export function renderEnginePill(
  trigger: HTMLButtonElement,
  state: { readonly capabilities: ChatViewState["capabilities"]; readonly phase: TurnPhase },
): EnginePillModel {
  const model = enginePillModel(state);
  trigger.classList.remove(cls("engine-ready"), cls("engine-starting"), cls("engine-working"), cls("engine-unavailable"));
  trigger.classList.add(cls(`engine-${model.statusWord.toLowerCase()}`));
  trigger.setAttribute("data-engine-status", model.tone);
  trigger.title = model.label;
  trigger.setAttribute("aria-label", `Engine: ${model.label}`);

  const dot = trigger.querySelector<HTMLElement>(`.${cls("engine-dot")}`);
  dot?.setAttribute("data-tone", model.tone);

  const label = trigger.querySelector<HTMLElement>(`.${cls("engine-label")}`);
  if (label !== null) label.textContent = model.label;
  return model;
}

// ---------------------------------------------------------------------------
// Model chip + rows
// ---------------------------------------------------------------------------

/** Friendly, provider-neutral display name for a configured model id. */
export function friendlyModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return "";
  const lastSegment = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  return lastSegment.length > 0 ? lastSegment : trimmed;
}

/** The active role's row, or null when the host advertises no configured role. */
export function activeModelRoleState(models: ChatModelsState | null): {
  readonly role: AiModelRole;
  readonly modelId: string;
  readonly vision: boolean;
} | null {
  if (models === null || models.roles.length === 0) return null;
  const active = models.roles.find((r) => r.role === models.active);
  const chosen = active ?? models.roles[0];
  if (chosen === undefined) return null;
  return { role: chosen.role as AiModelRole, modelId: chosen.modelId, vision: chosen.vision };
}

export interface ModelChipModel {
  /** True when there is no configured model — the chip opens settings. */
  readonly empty: boolean;
  readonly label: string;
  readonly tone: "neutral" | "success";
}

/**
 * Resolve the model chip. `<friendly model> · <quality>` when a role is
 * configured, `Choose model` / `No model configured` otherwise — NEVER an
 * empty menu.
 */
export function modelChipModel(models: ChatModelsState | null): ModelChipModel {
  const active = activeModelRoleState(models);
  if (active === null) {
    return { empty: true, label: MODEL_CHIP_UNCONFIGURED, tone: "neutral" };
  }
  const friendly = friendlyModelName(active.modelId);
  if (friendly.length === 0) {
    return { empty: true, label: MODEL_CHIP_UNCONFIGURED, tone: "neutral" };
  }
  return {
    empty: false,
    label: `${friendly} · ${MODEL_ROLE_BADGES[active.role]}`,
    tone: "success",
  };
}

/** Build the model row list. Empty when the host configures no role. */
export function buildModelRows(models: ChatModelsState | null): OverlayMenuRow[] {
  if (models === null || models.roles.length === 0) return [];
  const byRole = new Map<string, { readonly modelId: string; readonly vision: boolean }>();
  for (const r of models.roles) byRole.set(r.role, { modelId: r.modelId, vision: r.vision });
  const rows: OverlayMenuRow[] = [];
  for (const role of MODEL_MENU_ORDER) {
    const entry = byRole.get(role);
    if (entry === undefined) continue;
    const friendly = friendlyModelName(entry.modelId);
    if (friendly.length === 0) continue; // unconfigured role is not offered
    const row: {
      -readonly [K in keyof OverlayMenuRow]: OverlayMenuRow[K];
    } = {
      id: role,
      label: friendly,
      description: MODEL_ROLE_LABELS[role],
      meta: MODEL_ROLE_BADGES[role],
      metaTone: "neutral",
      checked: models.active === role,
      // Image icon ONLY when the host proves this role accepts images.
      icon: entry.vision ? "view" : undefined,
      iconSizePx: OVERLAY_ROW_ICON_PX,
    };
    if (row.icon === undefined) delete row.icon;
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Engine menu view
// ---------------------------------------------------------------------------

export interface EngineMenuOptions {
  /** Element the menu is appended to. */
  readonly anchor: HTMLElement;
  /** The header pill that keeps focus and carries the ARIA wiring. */
  readonly trigger: HTMLButtonElement;
  /** A selectable engine was chosen (idle path). */
  readonly onSelectEngine: (engine: AiEngineName) => void;
  /** A non-selectable row's setup affordance was activated. */
  readonly onOpenSetup: (engine: AiEngineName) => void;
  readonly ariaLabel?: string;
}

export interface EngineMenuView {
  setEntries(entries: readonly EngineMenuEntry[]): void;
  setActiveEngine(engine: AiEngineName | null): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  handleKey(event: KeyboardEvent): boolean;
  /** Click handler the trigger should call. */
  toggle(): void;
  readonly menu: OverlayMenu;
  destroy(): void;
}

/** Mount the engine listbox against the header pill. */
export function createEngineMenu(options: EngineMenuOptions): EngineMenuView {
  let entries: readonly EngineMenuEntry[] = [];
  let activeEngine: AiEngineName | null = null;

  const menu = createOverlayMenu({
    anchor: options.anchor,
    trigger: options.trigger,
    ariaLabel: options.ariaLabel ?? "Select engine",
    onActivate: (row) => options.onSelectEngine(row.id as AiEngineName),
  });

  function repaint(): void {
    const rows = buildEngineRows(entries, activeEngine, options.onOpenSetup);
    menu.setRows(rows);
    // A reopen starts on the ACTIVE engine row, never an arbitrary one.
    const index = rows.findIndex((row) => row.checked === true);
    if (index >= 0) menu.setActive(index);
  }

  return {
    setEntries(next: readonly EngineMenuEntry[]): void {
      entries = next;
      repaint();
    },
    setActiveEngine(engine: AiEngineName | null): void {
      activeEngine = engine;
      repaint();
    },
    open(): void {
      repaint();
      menu.open();
    },
    close(): void {
      menu.close("api");
    },
    isOpen: () => menu.isOpen(),
    handleKey: (event) => menu.handleKey(event),
    toggle(): void {
      if (menu.isOpen()) menu.close("api");
      else this.open();
    },
    menu,
    destroy(): void {
      menu.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Model menu view
// ---------------------------------------------------------------------------

export interface ModelMenuOptions {
  /** Element the menu is appended to. */
  readonly anchor: HTMLElement;
  /** The composer model chip that keeps focus. */
  readonly trigger: HTMLButtonElement;
  /** A selectable role was chosen. */
  readonly onSelectModel: (role: AiModelRole) => void;
  /** No configured model: the chip must open settings, not an empty menu. */
  readonly onOpenSettings: () => void;
  readonly ariaLabel?: string;
}

export interface ModelMenuView {
  setModels(models: ChatModelsState | null): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  handleKey(event: KeyboardEvent): boolean;
  toggle(): void;
  /** Re-render the chip from state (label + chevron, no optimistic swap). */
  renderChip(state: ChatViewState): ModelChipModel;
  readonly menu: OverlayMenu;
  destroy(): void;
}

/** Mount the model listbox against the composer chip. */
export function createModelMenu(options: ModelMenuOptions): ModelMenuView {
  let models: ChatModelsState | null = null;

  const menu = createOverlayMenu({
    anchor: options.anchor,
    trigger: options.trigger,
    ariaLabel: options.ariaLabel ?? "Select model",
    onActivate: (row) => options.onSelectModel(row.id as AiModelRole),
  });

  function rows(): OverlayMenuRow[] {
    return buildModelRows(models);
  }

  return {
    setModels(next: ChatModelsState | null): void {
      models = next;
      menu.setRows(rows());
    },
    open(): void {
      // No configured role ⇒ settings, never an empty menu.
      const list = rows();
      if (list.length === 0) {
        options.onOpenSettings();
        return;
      }
      menu.setRows(list);
      // A reopen starts on the active role row.
      const index = list.findIndex((row) => row.checked === true);
      if (index >= 0) menu.setActive(index);
      menu.open();
    },
    close(): void {
      menu.close("api");
    },
    isOpen: () => menu.isOpen(),
    handleKey: (event) => menu.handleKey(event),
    toggle(): void {
      if (menu.isOpen()) menu.close("api");
      else this.open();
    },
    renderChip(state: ChatViewState): ModelChipModel {
      const chip = modelChipModel(state.models);
      const label = options.trigger.querySelector<HTMLElement>(`.${cls("label-optional")}`);
      if (label !== null) label.textContent = chip.label;
      options.trigger.title = `Model: ${chip.label}`;
      options.trigger.setAttribute("aria-label", `Model: ${chip.label}`);
      return chip;
    },
    menu,
    destroy(): void {
      menu.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Acknowledged engine switching
// ---------------------------------------------------------------------------

/** Switch-flow state. `pending` holds a request whose ack has not arrived. */
export type EngineSwitchState =
  | { readonly kind: "stable" }
  | { readonly kind: "pending"; readonly clientRequestId: string; readonly engine: AiEngineName }
  | { readonly kind: "confirming"; readonly engine: AiEngineName }
  | { readonly kind: "stopping"; readonly engine: AiEngineName; readonly clientRequestId: string };

export interface EngineSwitchViewOptions {
  /** Mount for the modal confirmation. */
  readonly mount: HTMLElement;
  /** Deterministic request-id source (injected in tests). */
  readonly getRequestId: () => string;
  /** Emit `set_engine(clientRequestId, engine)`. */
  readonly postSetEngine: (clientRequestId: string, engine: AiEngineName) => void;
  /** Emit `set_model(clientRequestId, role)`. */
  readonly postSetModel: (clientRequestId: string, role: AiModelRole) => void;
  /** Emit `stop_turn(clientRequestId)`. */
  readonly postStop: (clientRequestId: string) => void;
  /** Safe transient copy (failure / acknowledgement notice). */
  readonly onToast: (message: string, level: "info" | "warning" | "error") => void;
  /** Display name for the confirmation copy (host-provided). */
  readonly displayNameFor: (engine: AiEngineName) => string;
  /** Update the pill ONLY on a matching ack (never optimistically). */
  readonly onEngineCommitted: (engine: AiEngineName) => void;
  /** Update the model chip ONLY on a matching ack. */
  readonly onModelCommitted: (clientRequestId: string) => void;
}

export interface EngineSwitchView {
  readonly state: () => EngineSwitchState;
  /** Idle selection: request the switch now. */
  requestIdle(engine: AiEngineName): void;
  /** Busy selection: open the stop-and-switch confirmation. */
  requestBusy(engine: AiEngineName): void;
  /** Request a model role change: emits `set_model`; commits only on the ack. */
  requestModel(role: AiModelRole): void;
  /** Host frame hook. Consumes ack-bearing capabilities/models + turn end. */
  handleHostFrame(frame: EngineSwitchHostFrame): void;
  /** Safe failure report for a pending request. */
  failPending(reason: string): void;
  /** The confirmation dialog while one is open (tests/a11y assertions). */
  getDialog(): ConfirmDialog | null;
  destroy(): void;
}

/** The subset of host frames the switch flow correlates against. */
export interface EngineSwitchHostFrame {
  readonly kind: string;
  /** Correlation id echoed on a `capabilities` ack by the host. */
  readonly clientRequestId?: string;
  /** Safe mapped copy carried by an `error` frame. */
  readonly safeMessage?: string;
}

/**
 * Own the request/ack lifecycle for engine and model switches. The webview is
 * authoritative for nothing here: the visible engine/model change only when a
 * matching ack arrives; a stale ack is dropped.
 */
export function createEngineSwitchView(options: EngineSwitchViewOptions): EngineSwitchView {
  let state: EngineSwitchState = { kind: "stable" };
  let dialog: ConfirmDialog | null = null;
  /** Pending `set_model` requests by clientRequestId (ack correlation). */
  const pendingModelRequests = new Set<string>();

  function pendingEngine(): AiEngineName | null {
    return state.kind === "pending" ? state.engine : null;
  }

  function closeDialog(): void {
    dialog?.destroy();
    dialog = null;
  }

  function openConfirm(engine: AiEngineName): void {
    closeDialog();
    dialog = createConfirmDialog({
      mount: options.mount,
      title: ENGINE_SWITCH_CONFIRM_TITLE,
      body: engineSwitchConfirmBody(options.displayNameFor(engine)),
      confirmLabel: ENGINE_SWITCH_CONFIRM_STOP_LABEL,
      cancelLabel: ENGINE_SWITCH_CONFIRM_CANCEL_LABEL,
      // Cancel is the default and Escape cancels: switching away from a live
      // response is never the accidental outcome of a stray keypress.
      defaultFocus: "cancel",
      onConfirm: () => {
        // ONE stop; the switch is deferred until the turn is terminal.
        const clientRequestId = options.getRequestId();
        options.postStop(clientRequestId);
        dialog = null;
        state = { kind: "stopping", engine, clientRequestId };
      },
      onCancel: () => {
        dialog = null;
        state = { kind: "stable" };
      },
    });
    dialog.open();
    state = { kind: "confirming", engine };
  }

  return {
    state: () => state,
    requestIdle(engine: AiEngineName): void {
      const clientRequestId = options.getRequestId();
      // Old pill/state stay until the ack: we only record the request.
      state = { kind: "pending", clientRequestId, engine };
      options.postSetEngine(clientRequestId, engine);
    },
    requestBusy(engine: AiEngineName): void {
      openConfirm(engine);
    },
    requestModel(role: AiModelRole): void {
      // The chip does NOT change here — only a matching ack moves it.
      const clientRequestId = options.getRequestId();
      pendingModelRequests.add(clientRequestId);
      options.postSetModel(clientRequestId, role);
    },
    handleHostFrame(frame: EngineSwitchHostFrame): void {
      if (frame.kind === "capabilities") {
        // The switch commits ONLY when the ack correlates with the pending
        // request — a stale/failed/late ack leaves the old engine in place.
        if (state.kind !== "pending") return;
        if (frame.clientRequestId !== state.clientRequestId) return;
        const engine = state.engine;
        state = { kind: "stable" };
        options.onEngineCommitted(engine);
        return;
      }
      if (frame.kind === "models") {
        // Model ack: the chip only reflects a role the host acknowledged, and
        // ONLY while that request id is still pending (a stale ack is dropped).
        const id = frame.clientRequestId;
        if (typeof id !== "string" || !pendingModelRequests.has(id)) return;
        pendingModelRequests.delete(id);
        options.onModelCommitted(id);
        return;
      }
      if (frame.kind === "turn_finished") {
        // Terminal after a confirmed stop: now (and only now) request switch.
        if (state.kind !== "stopping") return;
        const engine = state.engine;
        const clientRequestId = options.getRequestId();
        state = { kind: "pending", clientRequestId, engine };
        options.postSetEngine(clientRequestId, engine);
        return;
      }
      if (frame.kind === "error") {
        // A failed switch keeps the old engine and reports a safe reason.
        const engine = pendingEngine();
        if (engine === null) {
          // A failed stop leaves the LIVE turn in charge: drop the request.
          if (state.kind === "stopping") state = { kind: "stable" };
          return;
        }
        const reason = typeof frame.safeMessage === "string" ? frame.safeMessage : "";
        state = { kind: "stable" };
        options.onToast(engineSwitchFailureCopy(options.displayNameFor(engine), reason), "error");
        return;
      }
    },
    failPending(reason: string): void {
      const engine = pendingEngine();
      // A failed MODEL request retains the prior model (the chip never moved).
      pendingModelRequests.clear();
      if (engine === null) return;
      state = { kind: "stable" };
      options.onToast(engineSwitchFailureCopy(options.displayNameFor(engine), reason), "error");
    },
    getDialog(): ConfirmDialog | null {
      return dialog;
    },
    destroy(): void {
      closeDialog();
      pendingModelRequests.clear();
      state = { kind: "stable" };
    },
  };
}
