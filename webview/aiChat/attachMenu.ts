// webview/aiChat/attachMenu.ts — TASK-CHATV2-013
//
// The composer's attach-context menu: a non-modal listbox opened from the 32×32
// plus button, carrying one row per context/image action. It OWNS only the row
// MODEL (which actions exist, which are unavailable and the exact explanation)
// and delegates the listbox mechanics to the shared `createOverlayMenu`
// primitive from TASK-CHATV2-012.
//
// CONTRACT
// - Action set is CLOSED and ordered: Current file (`@file`), Selection
//   (`@selection`), Files…, Database object…, Image… . Image… is present ONLY
//   when the capability snapshot says `imageInput` is supported (adapter
//   transport AND active-model vision). An engine fact that can never be true
//   is HIDDEN, never shown disabled.
// - A MEANINGFUL row whose precondition is temporarily unmet STAYS, disabled,
//   with the exact explanation: `Open a workspace folder first`,
//   `Select text first`, `Select a database connection first`. It is inert on
//   click/Enter (no action is invented) but its explanation is announced.
// - Row copy is DATA rendered with `textContent` by the primitive; a hostile
//   label can never create an element, an attribute or a class.
// - Geometry is fixed here and painted onto the shared listbox element as CSS
//   custom properties so styles.css owns the styling while the 32×32 trigger,
//   the 300–420px width and the 40px / 13px / 11px rows stay a single source of
//   truth: rows 40px, icon 16px, title 13px, detail 11px.
// - The menu is NON-MODAL: focus never moves for it, the trigger carries
//   `aria-haspopup`/`aria-activedescendant`, and the caller forwards keydown.
// - The plus button remains usable while a turn is busy; this module never
//   consults turn phase, because adding to the NEXT draft is always allowed.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import {
  createOverlayMenu,
  type OverlayMenu,
  type OverlayMenuCloseReason,
  type OverlayMenuRow,
} from "./overlays";

/** The V2 root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Marker attribute identifying the attach menu listbox. */
export const ATTACH_MENU_MARKER = "data-chat-attach-menu";
/** Marker attribute on each attach menu row (carries its action). */
export const ATTACH_MENU_ROW_MARKER = "data-chat-attach-row";

/** Row height in px (task spec: attach rows are 40px, not the 44px shared default). */
export const ATTACH_MENU_ROW_HEIGHT_PX = 40;
/** Leading icon edge in px. */
export const ATTACH_MENU_ICON_PX = 16;
/** Title font size in px. */
export const ATTACH_MENU_TITLE_PX = 13;
/** Detail font size in px. */
export const ATTACH_MENU_DETAIL_PX = 11;
/** Menu width bounds in px (task spec: 300–420). */
export const ATTACH_MENU_WIDTH_MIN = 300;
export const ATTACH_MENU_WIDTH_MAX = 420;

/** Closed action vocabulary, in menu order. */
export type AttachMenuAction = "file" | "selection" | "files" | "database" | "image";

/** Canonical menu order. Frozen — callers must not reorder. */
export const ATTACH_MENU_ACTIONS: readonly AttachMenuAction[] = Object.freeze([
  "file",
  "selection",
  "files",
  "database",
  "image",
] as const);

/** Exact disabled explanations (task spec — these strings are asserted). */
export const ATTACH_REASON_NO_WORKSPACE = "Open a workspace folder first";
export const ATTACH_REASON_NO_SELECTION = "Select text first";
export const ATTACH_REASON_NO_CONNECTION = "Select a database connection first";

/**
 * What the host/capability layer knows that decides row availability.
 * `imageInput` MUST come from `EngineCapabilitySnapshot.supports.imageInput`
 * (adapter transport AND active-model vision) — never from a provider name.
 */
export interface AttachMenuAvailability {
  readonly hasWorkspaceFolder: boolean;
  readonly hasSelection: boolean;
  readonly hasDatabaseConnection: boolean;
  readonly imageInput: boolean;
}

/** One resolved attach-menu row. `detail` is the token, or the exact reason
 * when the row is disabled. */
export interface AttachMenuRow {
  readonly action: AttachMenuAction;
  /** Literal inserted by the action, or "" for the picker rows. */
  readonly token: string;
  readonly title: string;
  readonly detail: string;
  readonly disabled: boolean;
  /** Allowlisted leading icon name, or undefined (image renders via CSS). */
  readonly icon?: string;
}

/** The immutable copy table. `detail` is the enabled secondary line. */
interface AttachRowSpec {
  readonly action: AttachMenuAction;
  readonly token: string;
  readonly title: string;
  readonly detail: string;
  readonly icon?: string;
  /** Which availability fact gates the row, or null when always available. */
  readonly gate:
    | { readonly kind: "workspace"; readonly reason: string }
    | { readonly kind: "selection"; readonly reason: string }
    | { readonly kind: "connection"; readonly reason: string }
    | { readonly kind: "image" }
    | null;
}

const ROW_SPECS: readonly AttachRowSpec[] = Object.freeze([
  {
    action: "file",
    token: "@file",
    title: "Current file",
    detail: "@file",
    icon: "file",
    gate: { kind: "workspace", reason: ATTACH_REASON_NO_WORKSPACE },
  },
  {
    action: "selection",
    token: "@selection",
    title: "Selection",
    detail: "@selection",
    icon: "selection",
    gate: { kind: "selection", reason: ATTACH_REASON_NO_SELECTION },
  },
  {
    action: "files",
    token: "",
    title: "Files…",
    detail: "Browse workspace files",
    icon: "file",
    gate: { kind: "workspace", reason: ATTACH_REASON_NO_WORKSPACE },
  },
  {
    action: "database",
    token: "",
    title: "Database object…",
    detail: "Browse tables, views and routines",
    icon: "table",
    gate: { kind: "connection", reason: ATTACH_REASON_NO_CONNECTION },
  },
  {
    // Image… is HIDDEN (not disabled) unless the engine+model can carry images.
    action: "image",
    token: "",
    title: "Image…",
    detail: "Attach a screenshot or image",
    gate: { kind: "image" },
  },
]);

/**
 * Resolve the exact ordered rows for an availability snapshot. Pure.
 *
 * - `imageInput === false` removes the Image… row entirely (an engine that can
 *   never accept images must not advertise a dead control).
 * - A temporarily unmet precondition keeps the row, disabled, with the exact
 *   explanation as its detail.
 */
export function buildAttachMenuRows(
  availability: AttachMenuAvailability,
): readonly AttachMenuRow[] {
  const rows: AttachMenuRow[] = [];
  for (const spec of ROW_SPECS) {
    const gate = spec.gate;
    if (gate !== null && gate.kind === "image" && availability.imageInput !== true) {
      continue; // impossible feature → hidden
    }
    let disabled = false;
    let detail = spec.detail;
    if (gate !== null) {
      if (gate.kind === "workspace" && availability.hasWorkspaceFolder !== true) {
        disabled = true;
        detail = gate.reason;
      } else if (gate.kind === "selection" && availability.hasSelection !== true) {
        disabled = true;
        detail = gate.reason;
      } else if (gate.kind === "connection" && availability.hasDatabaseConnection !== true) {
        disabled = true;
        detail = gate.reason;
      }
    }
    const row: {
      -readonly [K in keyof AttachMenuRow]: AttachMenuRow[K];
    } = {
      action: spec.action,
      token: spec.token,
      title: spec.title,
      detail,
      disabled,
    };
    if (spec.icon !== undefined) row.icon = spec.icon;
    rows.push(Object.freeze(row) as AttachMenuRow);
  }
  return Object.freeze(rows);
}

export interface AttachMenuOptions {
  /** Element the listbox is appended to (the composer shell / shell root). */
  readonly anchor: HTMLElement;
  /** The 32×32 plus button that keeps focus and carries the ARIA wiring. */
  readonly trigger: HTMLElement;
  /** A selectable row was chosen. Disabled rows never fire this. */
  readonly onAction: (action: AttachMenuAction) => void;
  /** Optional close observer. */
  readonly onClose?: (reason: string) => void;
}

/** The live attach-menu handle. */
export interface AttachMenu {
  /** Replace availability and repaint (only while open is cheap). */
  setAvailability(availability: AttachMenuAvailability): void;
  /** The rows currently resolved. */
  getRows(): readonly AttachMenuRow[];
  open(): void;
  close(reason?: string): void;
  isOpen(): boolean;
  moveActive(delta: number): void;
  /** Set the active row by index (clamped). */
  setActive(index: number): void;
  getActiveRow(): AttachMenuRow | null;
  /** Forward a trigger keydown. Returns true when consumed. */
  handleKey(event: KeyboardEvent): boolean;
  activateActive(): void;
  destroy(): void;
}

/**
 * Mount the attach menu against `options.anchor`, reusing the shared overlay
 * listbox. Nothing is rendered until the first `open()`.
 */
export function createAttachMenu(options: AttachMenuOptions): AttachMenu {
  const { anchor, trigger } = options;

  let rows = buildAttachMenuRows({
    hasWorkspaceFolder: true,
    hasSelection: false,
    hasDatabaseConnection: false,
    imageInput: false,
  });
  let destroyed = false;

  function overlayRows(): readonly OverlayMenuRow[] {
    return rows.map((row) => {
      const descriptor: {
        -readonly [K in keyof OverlayMenuRow]: OverlayMenuRow[K];
      } = {
        id: row.action,
        label: row.title,
        description: row.detail,
        disabled: row.disabled,
      };
      if (row.icon !== undefined) descriptor.icon = row.icon;
      descriptor.iconSizePx = ATTACH_MENU_ICON_PX;
      return descriptor;
    });
  }

  const menu: OverlayMenu = createOverlayMenu({
    anchor,
    trigger,
    ariaLabel: "Attach context",
    onActivate: (row) => {
      options.onAction(row.id as AttachMenuAction);
    },
    ...(options.onClose !== undefined ? { onClose: (reason) => options.onClose?.(reason) } : {}),
  });

  /**
   * Paint the attach geometry onto the shared listbox element. The overlay
   * primitive owns behaviour; this function owns the 40px/13px/11px contract
   * and the 300–420px width, so styles.css can stay generic.
   */
  function decorate(): void {
    if (!menu.isOpen()) return;
    const list = anchor.querySelector<HTMLElement>(`[data-chat-overlay-menu]`);
    if (list === null) return;
    list.setAttribute(ATTACH_MENU_MARKER, "1");
    list.classList.add(`${ROOT_CLASS}-attach-menu`);
    list.dataset.rowHeight = String(ATTACH_MENU_ROW_HEIGHT_PX);
    list.style.setProperty("--UnicDB-row-h", `${ATTACH_MENU_ROW_HEIGHT_PX}px`);
    list.style.setProperty("--UnicDB-attach-icon", `${ATTACH_MENU_ICON_PX}px`);
    list.style.setProperty("--UnicDB-attach-title", `${ATTACH_MENU_TITLE_PX}px`);
    list.style.setProperty("--UnicDB-attach-detail", `${ATTACH_MENU_DETAIL_PX}px`);
    list.style.setProperty("--UnicDB-list-min", `${ATTACH_MENU_WIDTH_MIN}px`);
    list.style.setProperty("--UnicDB-list-max", `${ATTACH_MENU_WIDTH_MAX}px`);

    // Bind each painted option back to its action and give the Image… row its
    // CSS-rendered 16px glyph (there is no `image` glyph in the allowlist).
    const optionNodes = list.querySelectorAll<HTMLElement>('[role="option"]');
    optionNodes.forEach((option, index) => {
      const row = rows[index];
      if (row === undefined) return;
      option.setAttribute(ATTACH_MENU_ROW_MARKER, row.action);
      if (row.disabled) option.setAttribute("data-attach-disabled", "true");
      const lead = option.querySelector<HTMLElement>(`.${ROOT_CLASS}-overlay-menu-lead`);
      if (lead !== null && row.icon === undefined) {
        // No allowlisted glyph: mark the lead so CSS paints a neutral 16px box.
        lead.setAttribute("data-glyph", row.action);
      }
    });
  }

  return {
    setAvailability(availability: AttachMenuAvailability): void {
      if (destroyed) return;
      rows = buildAttachMenuRows(availability);
      menu.setRows(overlayRows());
      decorate();
    },
    getRows: () => rows,
    open(): void {
      if (destroyed) return;
      menu.setRows(overlayRows());
      menu.open();
      decorate();
    },
    close(reason?: string): void {
      if (destroyed) return;
      menu.close((reason ?? "api") as OverlayMenuCloseReason);
    },
    isOpen: () => !destroyed && menu.isOpen(),
    moveActive(delta: number): void {
      if (destroyed) return;
      menu.moveActive(delta);
    },
    setActive(index: number): void {
      if (destroyed) return;
      menu.setActive(index);
    },
    getActiveRow(): AttachMenuRow | null {
      const active = menu.getActiveRow();
      if (active === null) return null;
      return rows.find((row) => row.action === active.id) ?? null;
    },
    handleKey(event: KeyboardEvent): boolean {
      if (destroyed) return false;
      return menu.handleKey(event);
    },
    activateActive(): void {
      if (destroyed) return;
      menu.activateActive();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      menu.destroy();
    },
  };
}
