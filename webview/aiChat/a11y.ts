// webview/aiChat/a11y.ts — TASK-CHATV2-016
//
// Shared accessibility helpers backing the V2 shell:
//   - the ONE polite + ONE assertive live region (ids owned by shell.ts) and a
//     coalescing announcer for PHASE changes only — token/reasoning updates
//     are refused, so a streaming answer never spams a screen reader;
//   - the 2px focus ring / 2px offset helpers (PLAN §3);
//   - listbox/combobox linkage with a STABLE `aria-activedescendant`
//     (the focused input keeps focus; the active option is announced);
//   - tooltip targets with a native `title` minimum and an optional custom
//     tooltip (500ms hover, immediate on keyboard focus).
//
// Every helper is pure DOM TypeScript: no `vscode`, no node builtins.

import { CHAT_V2_ALERT_LIVE_ID, CHAT_V2_ROOT_CLASS, CHAT_V2_STATUS_LIVE_ID } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

// ---------------------------------------------------------------------------
// Focus ring (PLAN §3: 2px focus color + 2px offset)
// ---------------------------------------------------------------------------

export const FOCUS_RING_WIDTH_PX = 2;
export const FOCUS_RING_OFFSET_PX = 2;

/** The exact outline/offset pair every focusable control uses. */
export function focusRingStyle(): { outline: string; outlineOffset: string } {
  return { outline: `${FOCUS_RING_WIDTH_PX}px solid var(--vscode-focusBorder, #5f9eff)`, outlineOffset: `${FOCUS_RING_OFFSET_PX}px` };
}

/** Apply the shared focus ring inline (for dynamic nodes the stylesheet may
 * miss). Idempotent. */
export function applyFocusRing(el: HTMLElement): void {
  const ring = focusRingStyle();
  el.style.outline = ring.outline;
  el.style.outlineOffset = ring.outlineOffset;
}

// ---------------------------------------------------------------------------
// Live regions — exactly one polite + one assertive per root
// ---------------------------------------------------------------------------

export const LIVE_REGION_IDS = Object.freeze({
  polite: CHAT_V2_STATUS_LIVE_ID,
  assertive: CHAT_V2_ALERT_LIVE_ID,
});

export interface LiveRegions {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;
}

/** Resolve the shell's two live regions by their stable ids. Throws when the
 * shell has not mounted — the caller must never silently create a THIRD
 * region (that would double-announce). */
export function resolveLiveRegions(doc: Document = document): LiveRegions {
  const polite = doc.getElementById(CHAT_V2_STATUS_LIVE_ID);
  const assertive = doc.getElementById(CHAT_V2_ALERT_LIVE_ID);
  if (!polite || !assertive) {
    throw new Error("chat v2 shell live regions are not mounted");
  }
  return { polite, assertive };
}

/** Count live regions under `root` (asserts the one-polite/one-assertive rule). */
export function countLiveRegions(root: HTMLElement): { polite: number; assertive: number } {
  const all = Array.from(root.querySelectorAll<HTMLElement>("[aria-live]"));
  return {
    polite: all.filter((el) => el.getAttribute("aria-live") === "polite").length,
    assertive: all.filter((el) => el.getAttribute("aria-live") === "assertive").length,
  };
}

// ---------------------------------------------------------------------------
// Coalescing phase announcer
// ---------------------------------------------------------------------------

export interface LiveAnnouncerOptions {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;
  /** Deferral window (ms). Multiple phase changes inside one window collapse to
   * the last phase. */
  readonly coalesceMs?: number;
  /** Scheduler injection for tests. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LiveAnnouncer {
  /** Queue a PHASE announcement. Repeated identical phases collapse. */
  announcePhase(text: string, urgent?: boolean): void;
  /** Immediate, non-coalesced announcement (used by settled/terminal states). */
  announceNow(text: string, urgent?: boolean): void;
  /** Refused by contract — a token update is never announced. Returns false. */
  announceToken(text: string): boolean;
  /** Refused by contract — reasoning is never announced. Returns false. */
  announceReasoning(text: string): boolean;
  /** Flush any pending phase announcement immediately. */
  flush(): void;
  readonly pending: string | null;
  destroy(): void;
}

/** Phase copy that is allowed into a live region. A phase label is a short,
 * single line from the fixed status vocabulary; a token/reasoning chunk is raw
 * streamed prose (long, multi-line, or empty). Anything that looks like a
 * stream is refused. */
export const MAX_PHASE_ANNOUNCEMENT = 120;

export function isAnnounceablePhase(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PHASE_ANNOUNCEMENT) return false;
  // A streamed chunk almost always carries a newline; phase copy never does.
  if (/[\r\n]/.test(trimmed)) return false;
  return true;
}

/**
 * Create the coalescing announcer for the shell's live regions. Phase changes
 * inside `coalesceMs` collapse to the last one; a token or reasoning update is
 * refused outright.
 */
export function createLiveAnnouncer(options: LiveAnnouncerOptions): LiveAnnouncer {
  const coalesceMs = options.coalesceMs ?? 100;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  let pending: string | null = null;
  let lastWritten = "";
  let cancel: (() => void) | null = null;
  let destroyed = false;

  function write(text: string, urgent: boolean): void {
    const region = urgent ? options.assertive : options.polite;
    if (region.textContent === text) return;
    region.textContent = text;
    lastWritten = text;
  }

  function flush(): void {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (pending === null) return;
    const text = pending;
    pending = null;
    write(text, false);
  }

  return {
    announcePhase: (text: string, urgent = false) => {
      if (destroyed || !isAnnounceablePhase(text)) return;
      if (text === pending || text === lastWritten) return;
      pending = text;
      if (cancel) cancel();
      if (urgent) {
        // Urgent phases (failures) are not deferred.
        pending = null;
        write(text, true);
        return;
      }
      cancel = schedule(() => flush(), coalesceMs);
    },
    announceNow: (text: string, urgent = true) => {
      if (destroyed || !isAnnounceablePhase(text)) return;
      if (cancel) {
        cancel();
        cancel = null;
      }
      pending = null;
      write(text, urgent);
    },
    announceToken: () => false,
    announceReasoning: () => false,
    flush,
    get pending() {
      return pending;
    },
    destroy: () => {
      destroyed = true;
      if (cancel) cancel();
      cancel = null;
      pending = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Listbox / combobox linkage
// ---------------------------------------------------------------------------

/** Role the focused text input carries while a listbox is open. */
export const COMBOBOX_ROLE = "combobox";

export interface ComboboxLinkOptions {
  /** The focused text input — it KEEPS focus. */
  readonly input: HTMLElement;
  readonly list: HTMLElement;
  /** Stable list id (assigned if absent). */
  readonly listId: string;
}

export interface ComboboxLink {
  readonly listId: string;
  /** Point `aria-activedescendant` at a stable option id. */
  setActive(optionId: string | null): void;
  /** Open/closed ARIA state. */
  setExpanded(expanded: boolean): void;
  destroy(): void;
}

/**
 * Wire a listbox to the focused input. The input keeps keyboard focus the whole
 * time (never moved into the list) and announces the active option through a
 * STABLE `aria-activedescendant` id.
 */
export function linkCombobox(options: ComboboxLinkOptions): ComboboxLink {
  const { input, list, listId } = options;
  if (!list.id) list.id = listId;
  list.setAttribute("role", "listbox");
  input.setAttribute("role", COMBOBOX_ROLE);
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-expanded", "false");
  const previousActivte = input.getAttribute("aria-activedescendant");
  void previousActivte;

  return {
    listId: list.id,
    setActive: (optionId: string | null) => {
      if (optionId === null) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      input.setAttribute("aria-activedescendant", optionId);
    },
    setExpanded: (expanded: boolean) => {
      input.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (!expanded) input.removeAttribute("aria-activedescendant");
    },
    destroy: () => {
      input.removeAttribute("aria-activedescendant");
      input.removeAttribute("aria-controls");
      input.removeAttribute("aria-haspopup");
      input.removeAttribute("aria-expanded");
      if (input.getAttribute("role") === COMBOBOX_ROLE) input.removeAttribute("role");
    },
  };
}

/** True when `input.aria-activedescendant` points at an EXISTING element inside
 * `list` (a stable, resolvable id). */
export function activeDescendantResolves(input: HTMLElement, list: HTMLElement): boolean {
  const id = input.getAttribute("aria-activedescendant");
  if (!id) return false;
  const target = list.ownerDocument.getElementById(id);
  return !!target && list.contains(target);
}

// ---------------------------------------------------------------------------
// Tooltip targets — native title minimum + optional custom tooltip
// ---------------------------------------------------------------------------

/** Hover delay before the custom tooltip appears (ms). Keyboard focus is
 * immediate. */
export const TOOLTIP_HOVER_DELAY_MS = 500;

export interface TooltipTargetOptions {
  readonly target: HTMLElement;
  readonly label: string;
  /** Prefer the native `title` only (no extra DOM). */
  readonly nativeOnly?: boolean;
  /** Reduced motion removes the fade; the tooltip still appears. */
  readonly reducedMotion?: boolean;
  readonly hoverDelayMs?: number;
}

export interface TooltipTarget {
  readonly tooltip: HTMLElement | null;
  show(): void;
  hide(): void;
  destroy(): void;
}

/**
 * Give `target` an accessible name plus a native `title` minimum, and (unless
 * `nativeOnly`) a custom tooltip that appears on 500ms hover and IMMEDIATELY on
 * keyboard focus. Escape hides it.
 */
export function createTooltipTarget(options: TooltipTargetOptions): TooltipTarget {
  const { target, label } = options;
  const delay = options.hoverDelayMs ?? TOOLTIP_HOVER_DELAY_MS;
  if (!target.getAttribute("aria-label")) target.setAttribute("aria-label", label);
  target.title = label;

  let tooltip: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let describedBy: string | null = null;
  let counter = 0;

  if (!options.nativeOnly) {
    tooltip = document.createElement("div");
    counter += 1;
    tooltip.id = `${PREFIX}-tooltip-${counter}`;
    tooltip.className = `${PREFIX}-tooltip`;
    if (options.reducedMotion) tooltip.setAttribute("data-reduced-motion", "1");
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = label;
    tooltip.hidden = true;
    target.appendChild(tooltip);
    describedBy = tooltip.id;
  }

  function show(): void {
    if (tooltip === null) return;
    tooltip.hidden = false;
    target.setAttribute("aria-describedby", describedBy!);
  }

  function hide(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (tooltip === null) return;
    tooltip.hidden = true;
    target.removeAttribute("aria-describedby");
  }

  function onEnter(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      show();
    }, delay);
  }

  function onFocus(): void {
    // Keyboard focus is immediate — no delay.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    show();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") hide();
  }

  target.addEventListener("pointerenter", onEnter);
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", onFocus);
  target.addEventListener("blur", hide);
  target.addEventListener("keydown", onKeydown);

  return {
    tooltip,
    show,
    hide,
    destroy: () => {
      hide();
      target.removeEventListener("pointerenter", onEnter);
      target.removeEventListener("pointerleave", hide);
      target.removeEventListener("focus", onFocus);
      target.removeEventListener("blur", hide);
      target.removeEventListener("keydown", onKeydown);
      tooltip?.remove();
    },
  };
}
