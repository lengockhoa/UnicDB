// webview/aiChat/autocomplete.ts — TASK-CHATV2-010
//
// The ONE anchored, non-modal listbox both popovers (slash commands here;
// mentions in CHATV2-011) render through. It is a pure VIEW: it paints rows and
// reports pointer intent. It owns no keyboard handler, no timer and no
// transport — TASK-CHATV2-009's controller remains the single keydown owner and
// routes arrows/Page/Enter/Tab/Escape into `setRows`/`setActive`/`close`.
//
// CONTRACT
// - Focus NEVER leaves the textarea. The listbox is not focusable; the active
//   row is announced through `aria-activedescendant` on the textarea, and the
//   option ids are stable (`UnicDB-ai-chat-v2-ac-opt-<id>`).
// - All row copy is written with `textContent`. A descriptor is DATA: hostile
//   text renders as text and can never create an element, an attribute or a
//   class.
// - Rows are 44px, max eight visible, 12px vertical padding and a 280–420px
//   width, all expressed as CSS custom properties so `styles.css` owns the
//   styling and the geometry contract stays in one place.
// - `setActive` keeps the active row scrolled into view without stealing focus.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework, no timers.

import { createChatIcon } from "./icons";
import {
  AUTOCOMPLETE_EMPTY_MESSAGE,
  AUTOCOMPLETE_MAX_VISIBLE_ROWS,
  AUTOCOMPLETE_ROW_HEIGHT_PX,
  AUTOCOMPLETE_VERTICAL_PADDING_PX,
  AUTOCOMPLETE_WIDTH_MAX,
  AUTOCOMPLETE_WIDTH_MIN,
} from "./slash";

/** The V2 root class every selector hangs off. */
const ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Marker attribute that identifies the listbox without a class lookup. */
export const AUTOCOMPLETE_LISTBOX_MARKER = "data-chat-autocomplete";

/** Stable id prefix for an option, so `aria-activedescendant` is predictable. */
export const AUTOCOMPLETE_OPTION_ID_PREFIX = `${ROOT_CLASS}-ac-opt-`;

/** Marker attribute on a group heading element (mention rows only). */
export const AUTOCOMPLETE_GROUP_MARKER = "data-chat-autocomplete-group";
/** Marker attribute on the loading (spinner) row. */
export const AUTOCOMPLETE_LOADING_MARKER = "data-chat-autocomplete-loading";
/** Marker attribute on the error row. */
export const AUTOCOMPLETE_ERROR_MARKER = "data-chat-autocomplete-error";
/** Marker attribute on the error row's retry control. */
export const AUTOCOMPLETE_RETRY_MARKER = "data-chat-autocomplete-retry";

/** 16px semantic icon size (task spec: 16px semantic icon per row). */
export const AUTOCOMPLETE_ICON_SIZE_PX = 16;

/** One row as the view renders it. All copy is plain display text. */
export interface AutocompleteRowModel {
  /** Safe identifier (descriptor id or mention token id) — used for the DOM id. */
  readonly id: string;
  /** Primary line (e.g. `/engine`). */
  readonly primary: string;
  /** Secondary line (description, or the safe reason when unavailable). */
  readonly secondary: string;
  /** Optional declared syntax shown next to the description. */
  readonly syntax?: string;
  /** Optional provider engine badge text. */
  readonly badge?: string;
  /** True when selecting the row would promise an unavailable action. */
  readonly unavailable?: boolean;
  /**
   * Optional group heading, painted as a non-selectable row immediately before
   * this one. Only the first row of each group carries it.
   */
  readonly groupLabel?: string;
  /**
   * Optional allowlisted semantic icon name (`createChatIcon`). An unknown name
   * resolves to an inert placeholder — the value is never written to the DOM.
   */
  readonly icon?: string;
}

/** Non-selectable status rows (empty/error). Never part of the option list. */
export interface AutocompleteStatusRowModel {
  readonly id: string;
  readonly text: string;
  /** Present only on an error row; renders the retry control. */
  readonly retryLabel?: string;
}

export interface AutocompleteViewOptions {
  /** Element the popover anchors inside (the composer shell). */
  readonly anchor: HTMLElement;
  /** The textarea that keeps focus and carries `aria-activedescendant`. */
  readonly prompt: HTMLTextAreaElement;
  /** The 32×32 slash button the popover aligns to. */
  readonly slashButton?: HTMLElement;
  /** Empty-state copy override (mentions use their own). */
  readonly emptyMessage?: string;
  /** Accessible name for the listbox (mentions pass their own). */
  readonly ariaLabel?: string;
}

/** The view handle the controller drives. */
export interface AutocompleteView {
  /** Replace the visible rows and set the active index (clamped by the view). */
  setRows(rows: readonly AutocompleteRowModel[], activeIndex: number): void;
  /**
   * Repaint as a NON-SELECTABLE status row (mention empty/error). The option
   * list is cleared and `aria-activedescendant`/`aria-expanded` are pointed at
   * the inert state, so Enter can never accept a status row.
   */
  setStatus(row: AutocompleteStatusRowModel): void;
  /** Repaint as the loading (spinner) row — also non-selectable. */
  setLoading(text: string): void;
  /** Pointer/click row handler. Replaces any previous handler. */
  setOnInvoke(handler: (index: number) => void): void;
  /** Retry control handler (error row only). Replaces any previous handler. */
  setOnRetry(handler: () => void): void;
  /** Move the active row without re-reading the data. */
  setActive(activeIndex: number): void;
  /** Remove the listbox and clear the textarea's aria wiring. */
  close(): void;
  /** True while a listbox is mounted. */
  isOpen(): boolean;
  /** Detach everything. Idempotent. */
  destroy(): void;
}

/** A safe DOM id fragment: unbounded/hostile ids never reach `id=`. */
function safeIdFragment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "row";
}

/**
 * Mount the shared listbox against `options.anchor`. Nothing is rendered until
 * the first `setRows` call, so opening costs one render and closing removes the
 * node entirely.
 */
export function createAutocompleteView(options: AutocompleteViewOptions): AutocompleteView {
  const { anchor, prompt, slashButton } = options;
  const emptyMessage = options.emptyMessage ?? AUTOCOMPLETE_EMPTY_MESSAGE;
  const ariaLabel = options.ariaLabel ?? "Command suggestions";

  let element: HTMLElement | null = null;
  /** Every row the caller handed us, in caller order (origin of truth). */
  let allRows: readonly AutocompleteRowModel[] = [];
  /** First visible index into `allRows` (windowing offset). */
  let windowStart = 0;
  /** Active index into `allRows` (never a window-local index). */
  let activeIndex = 0;
  let onInvoke: ((index: number) => void) | null = null;
  let onRetry: (() => void) | null = null;
  /** The inert status row while one is painted (empty/error/loading). */
  let statusRow: { readonly kind: "empty" | "error" | "loading"; readonly text: string; readonly retryLabel?: string } | null = null;
  let destroyed = false;

  function optionIdFor(row: AutocompleteRowModel): string {
    return `${AUTOCOMPLETE_OPTION_ID_PREFIX}${safeIdFragment(row.id)}`;
  }

  /** Append one visually-hidden group heading (mention grouping). */
  function appendGroupHeading(list: HTMLElement, label: string): void {
    const heading = document.createElement("div");
    heading.className = `${ROOT_CLASS}-autocomplete-group`;
    heading.setAttribute(AUTOCOMPLETE_GROUP_MARKER, "1");
    // Non-selectable: no `role="option"`, hidden from the a11y option stream.
    heading.setAttribute("role", "presentation");
    heading.setAttribute("aria-hidden", "true");
    // textContent only — a hostile label can never become markup.
    heading.textContent = label;
    list.appendChild(heading);
  }

  /** Append one non-selectable status row (empty/error/loading). */
  function renderStatusRow(list: HTMLElement): void {
    const row = statusRow;
    if (row === null) return;
    const node = document.createElement("div");
    node.className = `${ROOT_CLASS}-autocomplete-status`;
    node.setAttribute("role", "status");
    // Never `role="option"`: a status row can never be selected or accepted.
    node.setAttribute("aria-hidden", "false");
    if (row.kind === "loading") node.setAttribute(AUTOCOMPLETE_LOADING_MARKER, "1");
    if (row.kind === "error") node.setAttribute(AUTOCOMPLETE_ERROR_MARKER, "1");

    if (row.kind === "loading") {
      const spinner = createChatIcon("spinner", AUTOCOMPLETE_ICON_SIZE_PX);
      spinner.classList.add(`${ROOT_CLASS}-autocomplete-spinner`);
      node.appendChild(spinner);
    }

    const text = document.createElement("span");
    text.className = `${ROOT_CLASS}-autocomplete-status-text`;
    text.textContent = row.text;
    node.appendChild(text);

    if (row.kind === "error" && typeof row.retryLabel === "string") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = `${ROOT_CLASS}-autocomplete-retry`;
      retry.setAttribute(AUTOCOMPLETE_RETRY_MARKER, "1");
      retry.textContent = row.retryLabel;
      retry.addEventListener("mousedown", (event) => event.preventDefault());
      retry.addEventListener("click", () => {
        focusPrompt();
        onRetry?.();
      });
      node.appendChild(retry);
    }

    list.appendChild(node);
  }

  /** The visible slice, derived from the active row so it never scrolls off. */
  function visibleRows(): readonly AutocompleteRowModel[] {
    const total = allRows.length;
    if (total === 0) return allRows;
    const max = Math.min(total, AUTOCOMPLETE_MAX_VISIBLE_ROWS);
    windowStart = Math.min(Math.max(activeIndex - max + 1, 0), total - max);
    if (activeIndex < windowStart) windowStart = activeIndex;
    return allRows.slice(windowStart, windowStart + max);
  }

  function ensureElement(): HTMLElement {
    if (element !== null) return element;
    const list = document.createElement("div");
    list.className = `${ROOT_CLASS}-autocomplete`;
    list.setAttribute(AUTOCOMPLETE_LISTBOX_MARKER, "1");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", ariaLabel);
    list.dataset.rowHeight = String(AUTOCOMPLETE_ROW_HEIGHT_PX);
    // Geometry contract as custom properties; styles.css consumes them.
    list.style.setProperty("--UnicDB-row-h", `${AUTOCOMPLETE_ROW_HEIGHT_PX}px`);
    list.style.setProperty("--UnicDB-list-min", `${AUTOCOMPLETE_WIDTH_MIN}px`);
    list.style.setProperty("--UnicDB-list-max", `${AUTOCOMPLETE_WIDTH_MAX}px`);
    list.style.setProperty("--UnicDB-list-pad", `${AUTOCOMPLETE_VERTICAL_PADDING_PX}px`);
    // Align to the composer shell; the slash button is the visual origin when
    // it exists, so a pointer user sees the popover grow from the button.
    if (slashButton !== undefined) list.dataset.anchor = slashButton.id;
    anchor.appendChild(list);
    element = list;
    return list;
  }

  function applyActiveDescendant(): void {
    // An inert status row is open but has no active descendant, so Enter can
    // never accept it (the controller sees zero selectable items).
    if (statusRow !== null) {
      prompt.removeAttribute("aria-activedescendant");
      prompt.setAttribute("aria-expanded", "false");
      return;
    }
    const row = allRows[activeIndex];
    if (row === undefined) {
      prompt.removeAttribute("aria-activedescendant");
      prompt.setAttribute("aria-expanded", "false");
      return;
    }
    prompt.setAttribute("aria-activedescendant", optionIdFor(row));
    prompt.setAttribute("aria-expanded", "true");
  }

  function scrollActiveIntoView(): void {
    if (element === null) return;
    const local = activeIndex - windowStart;
    const row = element.querySelectorAll<HTMLElement>('[role="option"]')[local];
    row?.scrollIntoView?.({ block: "nearest" });
  }

  function render(): void {
    if (destroyed) return;
    const list = ensureElement();
    list.replaceChildren();

    // An inert status row (empty/error/loading) owns the whole popover: it
    // suppresses every data row so nothing behind it can be accepted.
    if (statusRow !== null) {
      renderStatusRow(list);
      applyActiveDescendant();
      return;
    }

    if (allRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = `${ROOT_CLASS}-autocomplete-empty`;
      // Not an option: the empty state can never be selected or accepted.
      empty.setAttribute("aria-hidden", "true");
      empty.textContent = emptyMessage;
      list.appendChild(empty);
      applyActiveDescendant();
      return;
    }

    const visible = visibleRows();
    for (const [local, row] of visible.entries()) {
      const index = windowStart + local;

      // Group heading (mention grouping) — non-selectable, outside the option
      // stream, painted immediately before its first row.
      if (typeof row.groupLabel === "string" && row.groupLabel.length > 0) {
        appendGroupHeading(list, row.groupLabel);
      }

      const option = document.createElement("div");
      option.className = `${ROOT_CLASS}-autocomplete-row`;
      option.setAttribute("role", "option");
      option.id = optionIdFor(row);
      option.setAttribute("aria-selected", String(index === activeIndex));
      option.setAttribute("data-available", String(row.unavailable !== true));
      if (row.unavailable === true) option.setAttribute("aria-disabled", "true");

      const primary = document.createElement("span");
      primary.className = `${ROOT_CLASS}-autocomplete-primary`;
      // textContent only — hostile copy can never become markup.
      primary.textContent = row.primary;

      const secondary = document.createElement("span");
      secondary.className = `${ROOT_CLASS}-autocomplete-secondary`;
      // Single-line secondary: the full distinguishing identity (path or
      // connection.schema) lives here, so duplicate labels stay apart.
      secondary.textContent = row.secondary;

      if (typeof row.icon === "string" && row.icon.length > 0) {
        // Mention row: icon beside a two-line text column. The icon NAME is a
        // lookup key only; an unknown name resolves to an inert placeholder and
        // is never written into the DOM.
        const body = document.createElement("div");
        body.className = `${ROOT_CLASS}-autocomplete-body`;
        const icon = createChatIcon(row.icon, AUTOCOMPLETE_ICON_SIZE_PX);
        icon.classList.add(`${ROOT_CLASS}-autocomplete-icon`);
        const text = document.createElement("div");
        text.className = `${ROOT_CLASS}-autocomplete-text`;
        text.append(primary, secondary);
        body.append(icon, text);
        option.appendChild(body);
      } else {
        // Slash row: the original two-line stack, unchanged.
        option.append(primary, secondary);
      }

      if (typeof row.syntax === "string" && row.syntax.length > 0) {
        const syntax = document.createElement("span");
        syntax.className = `${ROOT_CLASS}-autocomplete-syntax`;
        syntax.textContent = row.syntax;
        option.appendChild(syntax);
      }
      if (typeof row.badge === "string" && row.badge.length > 0) {
        const badge = document.createElement("span");
        badge.className = `${ROOT_CLASS}-autocomplete-badge`;
        badge.textContent = row.badge;
        option.appendChild(badge);
      }

      option.addEventListener("mousedown", (event) => {
        // Keep native focus in the textarea; the click still fires.
        event.preventDefault();
      });
      option.addEventListener("click", () => {
        if (row.unavailable === true) return;
        focusPrompt();
        onInvoke?.(index);
      });

      list.appendChild(option);
    }

    applyActiveDescendant();
    scrollActiveIntoView();
  }

  function focusPrompt(): void {
    try {
      prompt.focus();
    } catch {
      /* jsdom/older engines may reject focus on a detached node. */
    }
  }

  function clampActive(index: number): number {
    if (!Number.isFinite(index)) return 0;
    const max = Math.max(allRows.length - 1, 0);
    return Math.min(Math.max(Math.trunc(index), 0), max);
  }

  return {
    setRows(rows: readonly AutocompleteRowModel[], nextActiveIndex: number): void {
      if (destroyed) return;
      // The caller windows the list (see `buildSlashRows`); rendering exactly
      // what it passes keeps the active index the caller computed valid. Never
      // silently slice here — that would drop rows the caller believes visible.
      statusRow = null;
      allRows = rows;
      activeIndex = clampActive(nextActiveIndex);
      render();
    },
    setStatus(row: AutocompleteStatusRowModel): void {
      if (destroyed) return;
      const retryLabel = row.retryLabel;
      statusRow = {
        kind: retryLabel !== undefined && retryLabel.length > 0 ? "error" : "empty",
        text: row.text,
        ...(retryLabel !== undefined ? { retryLabel } : {}),
      };
      allRows = [];
      activeIndex = 0;
      render();
    },
    setLoading(text: string): void {
      if (destroyed) return;
      statusRow = { kind: "loading", text };
      allRows = [];
      activeIndex = 0;
      render();
    },
    setActive(nextActiveIndex: number): void {
      // An inert status row is never active; arrows are a no-op there.
      if (destroyed || element === null || statusRow !== null) return;
      const clamped = clampActive(nextActiveIndex);
      if (clamped === activeIndex) return;
      const previousStart = windowStart;
      activeIndex = clamped;
      // A window shift repaints (option ids/selection move); otherwise only the
      // two affected rows change, so we avoid a full rebuild on each arrow key.
      const total = allRows.length;
      const max = Math.min(total, AUTOCOMPLETE_MAX_VISIBLE_ROWS);
      const nextStart = total === 0 ? 0 : Math.min(Math.max(activeIndex - max + 1, 0), total - max);
      if (nextStart !== previousStart) {
        render();
        return;
      }
      const options = element.querySelectorAll<HTMLElement>('[role="option"]');
      options.forEach((option, local) => {
        option.setAttribute("aria-selected", String(windowStart + local === activeIndex));
      });
      applyActiveDescendant();
      scrollActiveIntoView();
    },
    setOnInvoke(handler: (index: number) => void): void {
      onInvoke = handler;
    },
    setOnRetry(handler: () => void): void {
      onRetry = handler;
    },
    close(): void {
      if (destroyed) return;
      element?.remove();
      element = null;
      allRows = [];
      statusRow = null;
      windowStart = 0;
      activeIndex = 0;
      prompt.removeAttribute("aria-activedescendant");
      // The popover is collapsed but the textarea stays the editable control.
      prompt.setAttribute("aria-expanded", "false");
    },
    isOpen(): boolean {
      return element !== null;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      element?.remove();
      element = null;
      allRows = [];
      statusRow = null;
      onInvoke = null;
      onRetry = null;
      prompt.removeAttribute("aria-activedescendant");
      prompt.removeAttribute("aria-expanded");
    },
  };
}
