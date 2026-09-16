// webview/aiChat/overlays.ts — TASK-CHATV2-012
//
// The two overlay PRIMITIVES every V2 surface that floats above the composer
// shares:
//
//   1. `createOverlayMenu` — an anchored, NON-MODAL listbox opened from a
//      button trigger (engine pill, model chip, header overflow). It paints
//      rows, owns `aria-activedescendant` on the TRIGGER, and reports pointer
//      intent through callbacks. The caller owns the data (which rows exist,
//      which are selectable) and the TRANSPORT (which intent a selection
//      emits) — this module never posts, never sends and never mutates a draft.
//
//   2. `createConfirmDialog` — a MODAL confirmation with a safe default
//      (Cancel), Escape-to-cancel, a two-control focus trap and focus restore.
//      It is used by the busy engine-switch flow; it carries plain strings only.
//
// CONTRACT
// - Focus NEVER moves for the menu: the trigger keeps focus and the active row
//   is announced through `aria-activedescendant` (same pattern as the composer
//   autocomplete). The dialog DOES move focus, and restores it on close.
// - Every string is written with `textContent`. A row descriptor is DATA: a
//   hostile primary/description renders as text and can never create an
//   element, an attribute or a class.
// - Icon names are lookup keys only. An unknown name resolves to the inert
//   placeholder inside `createChatIcon`; the raw value never reaches the DOM.
// - Geometry is fixed here as exported constants and painted as CSS custom
//   properties so `styles.css` owns the styling and the contract stays in one
//   place: rows are 44px, menu width 280–420px, confirmation 360–560px.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework, no timers.

import { createChatIcon } from "./icons";

/** The V2 root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

function cls(name: string): string {
  return `${ROOT_CLASS}-${name}`;
}

/** Marker attribute identifying a non-modal overlay menu. */
export const OVERLAY_MENU_MARKER = "data-chat-overlay-menu";
/** Marker attribute identifying a modal confirmation dialog. */
export const OVERLAY_DIALOG_MARKER = "data-chat-overlay-dialog";
/** Stable id prefix for a menu option, so `aria-activedescendant` is predictable. */
export const OVERLAY_OPTION_ID_PREFIX = `${ROOT_CLASS}-overlay-opt-`;

/** Row height in px (PLAN §4/§5: engine and model rows are 44px). */
export const OVERLAY_ROW_HEIGHT_PX = 44;
/** Menu width bounds in px (matches the shared popover contract). */
export const OVERLAY_WIDTH_MIN = 280;
export const OVERLAY_WIDTH_MAX = 420;
/** Confirmation dialog width bounds in px (task spec: 360–560). */
export const OVERLAY_CONFIRM_WIDTH_MIN = 360;
export const OVERLAY_CONFIRM_WIDTH_MAX = 560;
/** Default leading-icon edge for a menu row, in px. */
export const OVERLAY_ROW_ICON_PX = 16;
/** Active-check glyph edge, in px (task spec: 16px active check). */
export const OVERLAY_CHECK_ICON_PX = 16;

/** One menu row. All copy is plain display text. */
export interface OverlayMenuRow {
  /** Safe identifier used for the DOM option id. Hostile ids are collapsed. */
  readonly id: string;
  /** Primary line (engine display name / model display name). */
  readonly label: string;
  /** Optional secondary line (status detail, role, latency). */
  readonly description?: string;
  /** Optional trailing badge text (quality, status). */
  readonly meta?: string;
  /** Badge tone; `neutral` when omitted. */
  readonly metaTone?: "neutral" | "warning" | "danger" | "success";
  /** Optional allowlisted leading icon name. Lookup key only. */
  readonly icon?: string;
  /** Optional leading icon edge in px (defaults to 16). */
  readonly iconSizePx?: number;
  /** True when this row is the current selection (paints a 16px check). */
  readonly checked?: boolean;
  /**
   * True when selecting this row would promise an unavailable action. A
   * disabled row can never be selected; Enter (or a click) opens its
   * `action` when one exists, otherwise it is inert.
   */
  readonly disabled?: boolean;
  /**
   * Optional row action — the "Set up" / "Open settings" affordance on an
   * unavailable or not-installed engine row. Never a selection.
   */
  readonly action?: { readonly label: string; readonly onActivate: () => void };
}

export interface OverlayMenuOptions {
  /** Element the menu is appended to (the shell root or the composer shell). */
  readonly anchor: HTMLElement;
  /** The button that keeps focus and carries the ARIA wiring. */
  readonly trigger: HTMLElement;
  /** Accessible name for the listbox. */
  readonly ariaLabel: string;
  /** Called when a SELECTABLE row is chosen. Never called for a disabled row. */
  readonly onActivate: (row: OverlayMenuRow, index: number) => void;
  /** Called after the menu closes for any reason (selection or dismissal). */
  readonly onClose?: (reason: OverlayMenuCloseReason) => void;
}

/** Why a menu closed. */
export type OverlayMenuCloseReason = "select" | "escape" | "outside" | "tab" | "api";

/** The live menu handle. */
export interface OverlayMenu {
  /** Replace the rows and repaint. Opening happens on the first `open()`. */
  setRows(rows: readonly OverlayMenuRow[]): void;
  /** The rows currently painted. */
  getRows(): readonly OverlayMenuRow[];
  /** Mount the listbox, focus the trigger and wire the ARIA state. */
  open(): void;
  /** Unmount the listbox and clear the trigger ARIA wiring. */
  close(reason?: OverlayMenuCloseReason): void;
  isOpen(): boolean;
  /** Move the active row by `delta` (clamped). No-op while closed. */
  moveActive(delta: number): void;
  setActive(index: number): void;
  getActiveIndex(): number;
  /** The active row, or null when closed/empty. */
  getActiveRow(): OverlayMenuRow | null;
  /**
   * Keyboard routing for the trigger. The caller stays the keydown owner and
   * forwards the event here; returns true when the key was consumed.
   */
  handleKey(event: KeyboardEvent): boolean;
  /** Activate the active row as if Enter had been pressed. */
  activateActive(): void;
  destroy(): void;
}

/** A safe DOM id fragment: unbounded/hostile ids never reach `id=`. */
function safeIdFragment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "row";
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

/**
 * Mount an anchored, non-modal listbox against `options.anchor`. Nothing is
 * rendered until the first `open()` call, so opening costs one render and
 * closing removes the node entirely.
 */
export function createOverlayMenu(options: OverlayMenuOptions): OverlayMenu {
  const { anchor, trigger } = options;
  const ariaLabel = options.ariaLabel;

  let element: HTMLElement | null = null;
  let rows: readonly OverlayMenuRow[] = [];
  let activeIndex = 0;
  let destroyed = false;

  function optionIdFor(row: OverlayMenuRow): string {
    return `${OVERLAY_OPTION_ID_PREFIX}${safeIdFragment(row.id)}`;
  }

  function applyActiveDescendant(): void {
    const row = rows[activeIndex];
    if (row === undefined || element === null) {
      trigger.removeAttribute("aria-activedescendant");
      return;
    }
    trigger.setAttribute("aria-activedescendant", optionIdFor(row));
  }

  function scrollActiveIntoView(): void {
    if (element === null) return;
    const row = element.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex];
    row?.scrollIntoView?.({ block: "nearest" });
  }

  function render(): void {
    if (destroyed || element === null) return;
    const list = element;
    list.replaceChildren();

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = cls("overlay-menu-empty");
      // Not an option: the empty state can never be selected or accepted.
      empty.setAttribute("aria-hidden", "true");
      empty.textContent = "Nothing available";
      list.appendChild(empty);
      applyActiveDescendant();
      return;
    }

    for (const [index, row] of rows.entries()) {
      const option = document.createElement("div");
      option.className = cls("overlay-menu-row");
      option.setAttribute("role", "option");
      option.id = optionIdFor(row);
      option.setAttribute("aria-selected", String(index === activeIndex));
      option.setAttribute("data-available", String(row.disabled !== true));
      if (row.disabled === true) option.setAttribute("aria-disabled", "true");

      // Leading check / icon slot (fixed width so labels align).
      const lead = document.createElement("span");
      lead.className = cls("overlay-menu-lead");
      if (row.checked === true) {
        lead.appendChild(createChatIcon("check", OVERLAY_CHECK_ICON_PX));
      } else if (typeof row.icon === "string" && row.icon.length > 0) {
        lead.appendChild(
          createChatIcon(row.icon, row.iconSizePx ?? OVERLAY_ROW_ICON_PX),
        );
      }
      option.appendChild(lead);

      const body = document.createElement("span");
      body.className = cls("overlay-menu-body");

      const label = document.createElement("span");
      label.className = cls("overlay-menu-label");
      // textContent only — hostile copy can never become markup.
      label.textContent = row.label;
      body.appendChild(label);

      if (typeof row.description === "string" && row.description.length > 0) {
        const description = document.createElement("span");
        description.className = cls("overlay-menu-description");
        description.textContent = row.description;
        body.appendChild(description);
      }
      option.appendChild(body);

      if (typeof row.meta === "string" && row.meta.length > 0) {
        const meta = document.createElement("span");
        meta.className = cls("overlay-menu-meta");
        meta.setAttribute("data-tone", row.metaTone ?? "neutral");
        meta.textContent = row.meta;
        option.appendChild(meta);
      }

      option.addEventListener("mousedown", (event) => {
        // Keep focus on the trigger; the click still fires.
        event.preventDefault();
      });
      option.addEventListener("click", () => activate(index));
      option.addEventListener("mousemove", () => {
        if (activeIndex === index) return;
        activeIndex = index;
        repaintActive();
      });

      list.appendChild(option);
    }

    applyActiveDescendant();
    scrollActiveIntoView();
  }

  /** Cheap repaint of selection state only (no rebuild) for arrow moves. */
  function repaintActive(): void {
    if (element === null) return;
    const options = element.querySelectorAll<HTMLElement>('[role="option"]');
    options.forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === activeIndex));
    });
    applyActiveDescendant();
    scrollActiveIntoView();
  }

  /** Choose a row: a selectable row reports intent; a disabled row opens its
   * action (setup help) and never reports a selection. */
  function activate(index: number): void {
    if (destroyed) return;
    const row = rows[index];
    if (row === undefined) return;
    if (row.disabled === true) {
      // "May open setup help but cannot optimistically select."
      row.action?.onActivate();
      return;
    }
    options.onActivate(row, index);
  }

  function focusTrigger(): void {
    try {
      trigger.focus();
    } catch {
      /* jsdom/older engines may reject focus on a detached node. */
    }
  }

  function ensureElement(): HTMLElement {
    if (element !== null) return element;
    const list = document.createElement("div");
    list.className = cls("overlay-menu");
    list.setAttribute(OVERLAY_MENU_MARKER, "1");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", ariaLabel);
    list.dataset.rowHeight = String(OVERLAY_ROW_HEIGHT_PX);
    // Geometry contract as custom properties; styles.css consumes them.
    list.style.setProperty("--UnicDB-row-h", `${OVERLAY_ROW_HEIGHT_PX}px`);
    list.style.setProperty("--UnicDB-list-min", `${OVERLAY_WIDTH_MIN}px`);
    list.style.setProperty("--UnicDB-list-max", `${OVERLAY_WIDTH_MAX}px`);
    anchor.appendChild(list);
    element = list;
    return list;
  }

  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const onDocumentMouseDown = (event: Event): void => {
    if (element === null) return;
    const target = event.target as Node | null;
    if (target !== null && (element.contains(target) || trigger.contains(target))) {
      return;
    }
    closeMenu("outside");
  };

  function isOpen(): boolean {
    return element !== null;
  }

  function closeMenu(reason: OverlayMenuCloseReason = "api"): void {
    if (destroyed) return;
    if (element === null) {
      trigger.setAttribute("aria-expanded", "false");
      return;
    }
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    element.remove();
    element = null;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    options.onClose?.(reason);
  }

  function moveActive(delta: number): void {
    if (destroyed || element === null || rows.length === 0) return;
    const next = clampIndex(activeIndex + delta, rows.length);
    if (next === activeIndex) return;
    activeIndex = next;
    repaintActive();
  }

  function setActive(index: number): void {
    if (destroyed || rows.length === 0) return;
    const next = clampIndex(index, rows.length);
    if (next === activeIndex) return;
    activeIndex = next;
    // While closed only the stored index moves; `open()` renders it.
    if (element !== null) repaintActive();
  }

  /** Choose the active row (Enter path). Disabled rows open setup help only. */
  function activateActive(): void {
    if (destroyed || element === null) return;
    const row = rows[activeIndex];
    if (row === undefined) return;
    if (row.disabled === true) {
      activate(activeIndex);
      return;
    }
    closeMenu("select");
    options.onActivate(row, activeIndex);
  }

  function handleMenuKey(event: KeyboardEvent): boolean {
    if (!isOpen()) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        return true;
      case "Home":
        event.preventDefault();
        setActive(0);
        return true;
      case "End":
        event.preventDefault();
        setActive(rows.length - 1);
        return true;
      case "Enter":
        event.preventDefault();
        activateActive();
        return true;
      case "Escape":
        event.preventDefault();
        closeMenu("escape");
        focusTrigger();
        return true;
      case "Tab":
        // Tab closes the listbox and lets native focus move on (PLAN §4:
        // focus never gets trapped by a non-modal menu).
        closeMenu("tab");
        return false;
      default:
        return false;
    }
  }

  return {
    setRows(next: readonly OverlayMenuRow[]): void {
      if (destroyed) return;
      rows = next;
      activeIndex = clampIndex(activeIndex, rows.length);
      render();
    },
    getRows: () => rows,
    open(): void {
      if (destroyed || element !== null) return;
      ensureElement();
      trigger.setAttribute("aria-expanded", "true");
      render();
      focusTrigger();
      document.addEventListener("mousedown", onDocumentMouseDown, true);
    },
    close: closeMenu,
    isOpen,
    moveActive,
    setActive,
    getActiveIndex: () => activeIndex,
    getActiveRow: () => (element === null ? null : rows[activeIndex] ?? null),
    handleKey: handleMenuKey,
    activateActive,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      element?.remove();
      element = null;
      rows = [];
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
    },
  };
}

// ---------------------------------------------------------------------------
// Confirmation dialog
// ---------------------------------------------------------------------------

export interface ConfirmDialogOptions {
  /** Element the dialog is appended to. */
  readonly mount: HTMLElement;
  /** Dialog title (plain text). */
  readonly title?: string;
  /** Body copy (plain text). */
  readonly body: string;
  /** Confirm button label (exact copy, e.g. "Stop and switch"). */
  readonly confirmLabel: string;
  /** Cancel button label (exact copy, e.g. "Cancel"). */
  readonly cancelLabel: string;
  /** Which control receives initial focus. Default: cancel (the safe default). */
  readonly defaultFocus?: "confirm" | "cancel";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** The live dialog handle. */
export interface ConfirmDialog {
  readonly element: HTMLElement;
  open(): void;
  close(reason?: ConfirmDialogCloseReason): void;
  isOpen(): boolean;
  /** Keyboard routing (Escape cancels, Tab traps between the two controls). */
  handleKey(event: KeyboardEvent): boolean;
  /** Focused control right now, or null while closed. */
  focusedControl(): "confirm" | "cancel" | null;
  destroy(): void;
}

export type ConfirmDialogCloseReason = "confirm" | "cancel" | "escape" | "api";

/**
 * Create a MODAL confirmation. The dialog is built eagerly (so tests and
 * callers can address it), but only appended to `mount` while open.
 */
export function createConfirmDialog(options: ConfirmDialogOptions): ConfirmDialog {
  const { mount } = options;
  let open = false;
  let destroyed = false;
  let previousFocus: HTMLElement | null = null;
  let focused: "confirm" | "cancel" | null = null;

  const dialog = document.createElement("div");
  dialog.className = cls("overlay-dialog");
  dialog.setAttribute(OVERLAY_DIALOG_MARKER, "1");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const titleId = `${ROOT_CLASS}-overlay-dialog-title`;
  const bodyId = `${ROOT_CLASS}-overlay-dialog-body`;
  if (typeof options.title === "string" && options.title.length > 0) {
    dialog.setAttribute("aria-labelledby", titleId);
  }
  dialog.setAttribute("aria-describedby", bodyId);
  dialog.style.setProperty("--UnicDB-dialog-min", `${OVERLAY_CONFIRM_WIDTH_MIN}px`);
  dialog.style.setProperty("--UnicDB-dialog-max", `${OVERLAY_CONFIRM_WIDTH_MAX}px`);

  if (typeof options.title === "string" && options.title.length > 0) {
    const title = document.createElement("div");
    title.className = cls("overlay-dialog-title");
    title.id = titleId;
    // textContent only — a hostile title can never become markup.
    title.textContent = options.title;
    dialog.appendChild(title);
  }

  const body = document.createElement("div");
  body.className = cls("overlay-dialog-body");
  body.id = bodyId;
  body.textContent = options.body;
  dialog.appendChild(body);

  const actions = document.createElement("div");
  actions.className = cls("overlay-dialog-actions");

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = cls("overlay-dialog-cancel");
  cancelButton.textContent = options.cancelLabel;
  cancelButton.addEventListener("click", () => {
    close("cancel");
    options.onCancel();
  });

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = cls("overlay-dialog-confirm");
  confirmButton.textContent = options.confirmLabel;
  confirmButton.addEventListener("click", () => {
    close("confirm");
    options.onConfirm();
  });

  actions.append(cancelButton, confirmButton);
  dialog.appendChild(actions);

  // Native focus is kept off the dialog body itself; the two buttons are the
  // only focusable controls, which is what makes the Tab trap exact.
  dialog.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Tab") {
      event.preventDefault();
      const next = focused === "cancel" ? "confirm" : "cancel";
      focusControl(next);
    }
  });

  function focusControl(which: "confirm" | "cancel"): void {
    focused = which;
    const target = which === "cancel" ? cancelButton : confirmButton;
    try {
      target.focus();
    } catch {
      /* jsdom/older engines may reject focus. */
    }
  }

  function close(reason: ConfirmDialogCloseReason = "api"): void {
    if (!open) return;
    open = false;
    focused = null;
    dialog.remove();
    // Restore focus to whatever held it before the dialog opened.
    const restore = previousFocus;
    previousFocus = null;
    try {
      restore?.focus?.();
    } catch {
      /* focus restore is best-effort */
    }
    void reason;
  }

  return {
    element: dialog,
    open(): void {
      if (destroyed || open) return;
      open = true;
      const active = document.activeElement;
      previousFocus = active instanceof HTMLElement ? active : null;
      mount.appendChild(dialog);
      // Default focus is the SAFE default. Never the confirming action.
      focusControl(options.defaultFocus ?? "cancel");
    },
    close,
    isOpen: () => open,
    handleKey(event: KeyboardEvent): boolean {
      if (!open) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape is Cancel — never the confirm path.
        close("escape");
        options.onCancel();
        return true;
      }
      return false;
    },
    focusedControl: () => focused,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      close("api");
      dialog.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Modal warning / confirm primitives + focus trap (TASK-CHATV2-014)
// ---------------------------------------------------------------------------
//
// `createConfirmDialog` above is deliberately minimal (two fixed controls, the
// busy engine-switch flow). Permission surfaces need a MODAL that can carry an
// arbitrary button set (bypass warning: Enable/Cancel; deny confirmation:
// Deny/Keep waiting) while keeping the same non-negotiable invariants:
//
//   - default focus is the caller's SAFE action, never an approving one;
//   - Escape DISMISSES (it can never activate a button);
//   - Tab/Shift+Tab cycle only among the dialog's own controls;
//   - focus is restored to whatever held it before the dialog opened.
//
// The trap is exported on its own because the permission REQUEST sheet is
// anchored (not centered) and builds its controls dynamically — it needs the
// same trap without the fixed dialog chrome.

/** Marker attribute identifying a modal warning/confirm dialog. */
export const OVERLAY_MODAL_MARKER = "data-chat-overlay-modal";
/** Marker attribute carrying `1` while an element's Tab order is trapped. */
export const OVERLAY_FOCUS_TRAP_MARKER = "data-chat-focus-trap";

/** Default focusable selector used by the focus trap. Real controls only. */
export const OVERLAY_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Why a modal dialog closed. */
export type ModalDialogCloseReason = "action" | "escape" | "api";

/** A live focus trap over one container's focusable descendants. */
export interface FocusTrap {
  /** Remember the current focus, trap Tab inside `container` and focus
   * `initialFocus` (or the first control). No-op while already active. */
  activate(initialFocus?: HTMLElement | null): void;
  /** Release the Tab listener. Does NOT move focus. */
  deactivate(): void;
  isActive(): boolean;
  /** Focusable controls inside the container, in document order. */
  focusables(): readonly HTMLElement[];
  /** Return focus to the element that held it before `activate()`. */
  restoreFocus(): void;
  destroy(): void;
}

/**
 * Create a Tab/Shift+Tab trap over `container`. The trap listens on the
 * container itself (capture phase) so a keydown anywhere inside it is routed
 * before native focus traversal.
 */
export function createFocusTrap(
  container: HTMLElement,
  focusableSelector: string = OVERLAY_FOCUSABLE_SELECTOR,
): FocusTrap {
  let active = false;
  let previousFocus: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (node) => node.hidden !== true && node.getAttribute("aria-hidden") !== "true",
    );
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!active || event.key !== "Tab") return;
    const items = focusables();
    // No focusable control: keep focus from escaping into the background.
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const current = document.activeElement;
    const index = current instanceof HTMLElement ? items.indexOf(current) : -1;
    const delta = event.shiftKey ? -1 : 1;
    let next = index === -1 ? (event.shiftKey ? items.length - 1 : 0) : index + delta;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    try {
      items[next]?.focus();
    } catch {
      /* jsdom/older engines may reject focus. */
    }
  }

  container.setAttribute(OVERLAY_FOCUS_TRAP_MARKER, "0");

  function deactivate(): void {
    if (!active) return;
    active = false;
    container.removeEventListener("keydown", onKeydown, true);
    container.setAttribute(OVERLAY_FOCUS_TRAP_MARKER, "0");
  }

  return {
    activate(initialFocus?: HTMLElement | null): void {
      if (active) return;
      active = true;
      const current = document.activeElement;
      previousFocus = current instanceof HTMLElement ? current : null;
      container.setAttribute(OVERLAY_FOCUS_TRAP_MARKER, "1");
      container.addEventListener("keydown", onKeydown, true);
      const target = initialFocus ?? focusables()[0] ?? null;
      try {
        target?.focus();
      } catch {
        /* jsdom/older engines may reject focus. */
      }
    },
    deactivate,
    isActive: () => active,
    focusables,
    restoreFocus(): void {
      const target = previousFocus;
      previousFocus = null;
      try {
        target?.focus?.();
      } catch {
        /* focus restore is best-effort */
      }
    },
    destroy(): void {
      deactivate();
      previousFocus = null;
    },
  };
}

/** One button in a modal warning/confirm. */
export interface ModalAction {
  readonly id: string;
  readonly label: string;
  /** Visual tone only; it never changes what the button does. */
  readonly tone?: "neutral" | "primary" | "warning" | "danger";
  readonly onActivate: () => void;
}

export interface ModalDialogOptions {
  /** Element the dialog is appended to while open. */
  readonly mount: HTMLElement;
  /** Dialog title (plain text). */
  readonly title: string;
  /** Body copy (plain text, pre-formatted with newlines preserved by CSS). */
  readonly body: string;
  /** Buttons, painted in order. Must contain at least one action. */
  readonly actions: readonly ModalAction[];
  /** Action focused on open. MUST be the caller's SAFE (non-destructive) one. */
  readonly defaultActionId: string;
  /** Optional extra tone hook (`warning` paints the amber variant). */
  readonly tone?: "warning" | "confirm";
  /** Called once on every close, including Escape and `close()`. */
  readonly onDismiss?: (reason: ModalDialogCloseReason) => void;
}

/** The live modal handle. */
export interface ModalDialog {
  readonly element: HTMLElement;
  open(): void;
  close(reason?: ModalDialogCloseReason): void;
  isOpen(): boolean;
  /** The action id that currently holds focus, or null while closed. */
  focusedActionId(): string | null;
  destroy(): void;
}

/**
 * Build a MODAL warning or confirmation. Same safe-default / Escape /
 * focus-trap contract as {@link createConfirmDialog}, but with a caller-defined
 * action set. Escape NEVER activates an action — it only dismisses.
 */
function buildModalDialog(options: ModalDialogOptions): ModalDialog {
  const { mount } = options;
  const tone = options.tone ?? "confirm";
  let open = false;
  let destroyed = false;
  let focusedId: string | null = null;

  const dialog = document.createElement("div");
  dialog.className = cls("overlay-modal");
  dialog.setAttribute(OVERLAY_MODAL_MARKER, "1");
  dialog.setAttribute("data-tone", tone);
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  const titleId = `${ROOT_CLASS}-overlay-modal-title`;
  const bodyId = `${ROOT_CLASS}-overlay-modal-body`;
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", bodyId);
  // Same width contract as the confirmation dialog (360–560px).
  dialog.style.setProperty("--UnicDB-dialog-min", `${OVERLAY_CONFIRM_WIDTH_MIN}px`);
  dialog.style.setProperty("--UnicDB-dialog-max", `${OVERLAY_CONFIRM_WIDTH_MAX}px`);

  const title = document.createElement("div");
  title.className = cls("overlay-modal-title");
  title.id = titleId;
  // textContent only — a hostile title can never become markup.
  title.textContent = options.title;
  dialog.appendChild(title);

  const body = document.createElement("div");
  body.className = cls("overlay-modal-body");
  body.id = bodyId;
  body.textContent = options.body;
  dialog.appendChild(body);

  const actions = document.createElement("div");
  actions.className = cls("overlay-modal-actions");
  const actionButtons = new Map<string, HTMLButtonElement>();
  for (const action of options.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = cls("overlay-modal-action");
    button.setAttribute("data-action-id", action.id);
    button.setAttribute("data-tone", action.tone ?? "neutral");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      close("action");
      action.onActivate();
    });
    actions.appendChild(button);
    actionButtons.set(action.id, button);
  }
  dialog.appendChild(actions);

  const trap = createFocusTrap(dialog);

  // Escape dismisses; it can never select an action. Tab is owned by the trap.
  dialog.addEventListener("keydown", (event) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    close("escape");
  });

  function focusAction(id: string | null): void {
    focusedId = id;
    if (id === null) return;
    const button = actionButtons.get(id);
    try {
      button?.focus();
    } catch {
      /* jsdom/older engines may reject focus. */
    }
  }

  function close(reason: ModalDialogCloseReason = "api"): void {
    if (!open) return;
    open = false;
    focusedId = null;
    trap.deactivate();
    dialog.remove();
    trap.restoreFocus();
    options.onDismiss?.(reason);
  }

  return {
    element: dialog,
    open(): void {
      if (destroyed || open) return;
      open = true;
      mount.appendChild(dialog);
      // Default focus is the caller's SAFE action, never an approving one.
      trap.activate(actionButtons.get(options.defaultActionId) ?? null);
      focusAction(options.defaultActionId);
    },
    close,
    isOpen: () => open,
    focusedActionId: () => focusedId,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      close("api");
      dialog.remove();
    },
  };
}

/** Create an amber-styled modal warning (e.g. the bypass-permission notice). */
export function createModalWarning(options: ModalDialogOptions): ModalDialog {
  return buildModalDialog({ ...options, tone: "warning" });
}

/** Create a neutral modal confirmation with an arbitrary action set. */
export function createModalConfirm(options: ModalDialogOptions): ModalDialog {
  return buildModalDialog({ ...options, tone: "confirm" });
}
