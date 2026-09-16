// webview/aiChat/scroll.ts — TASK-CHATV2-016
//
// The bottom-proximity + unread controller for the transcript viewport.
//
// CONTRACT (PLAN §6, exact)
// - The controller reads the bottom distance BEFORE it paints a new frame, so
//   an "am I pinned?" decision is made against the pre-insert geometry.
// - Auto-scroll happens ONLY when the distance was <= 48px. Further away, the
//   scroll position is PRESERVED and a pill counts the missed responses.
// - Reasoning-only events never increment the unread count and never scroll.
//   Only user-visible transcript activity (an assistant text item, a tool row,
//   a terminal turn) counts as a "new response".
// - The pill is a real button, min 28px, bottom-right. Clicking it scrolls to
//   the bottom and clears the count.
// - Composer focus must NOT jump the viewport: the controller never scrolls on
//   focus and never steals scrollTop while an input owns focus.
// - `prefers-reduced-motion: reduce` forces `behavior: "auto"` (no smooth
//   animation). The CSS caret/spinner/pulse rules are removed in styles.css.
// - A prepended history batch preserves the visual anchor: the controller
//   measures the pre-prepend scrollHeight and re-offsets scrollTop by the
//   growth, so the message the user was reading stays put.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { CHAT_V2_ROOT_CLASS } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

/** Exact bottom-proximity threshold (px) from PLAN §6. */
export const SCROLL_BOTTOM_THRESHOLD_PX = 48;

/** Minimum pill size (px) — a real, tappable control. */
export const SCROLL_PILL_MIN_PX = 28;

/** Pill copy (exact). */
export function unreadPillLabel(count: number): string {
  return count === 1 ? "↓ 1 new response" : `↓ ${count} new responses`;
}

/** Marker attribute for the pill button. */
export const SCROLL_PILL_MARKER = "data-chat-scroll-pill";

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Distance from the current viewport bottom to the content bottom. */
export function bottomDistance(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

/** Is the viewport pinned close enough to auto-follow? */
export function isNearBottom(metrics: ScrollMetrics, threshold = SCROLL_BOTTOM_THRESHOLD_PX): boolean {
  return bottomDistance(metrics) <= Math.max(0, threshold);
}

/** The scroll behavior to use for this environment. */
export function scrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export interface ScrollControllerOptions {
  /** The scrolling viewport element (`.UnicDB-ai-chat-v2-transcript`). */
  readonly viewport: HTMLElement;
  /** Where the pill is appended. Defaults to the viewport's parent. */
  readonly pillHost?: HTMLElement;
  /** Reduce-motion source. Defaults to the live media query (or false). */
  readonly reducedMotion?: boolean;
  /** Called when proximity changes (mirrors the reducer's `scrollNearBottom`). */
  readonly onProximityChange?(near: boolean): void;
  /** Called when the unread count changes. */
  readonly onUnreadChange?(count: number): void;
}

export interface ScrollController {
  /** Read the CURRENT bottom distance off the live element. */
  distance(): number;
  nearBottom(): boolean;
  unreadCount(): number;
  /** Capture pre-paint metrics; returns the bottom distance for this frame. */
  beginFrame(): number;
  /**
   * A new user-visible response was appended. If the pre-frame distance was
   * <= 48px, follow it; otherwise preserve scroll and count it as unread.
   */
  notifyNewResponse(): void;
  /**
   * A reasoning-only event arrived. Never scrolls and never increments — the
   * viewport is left exactly as it was.
   */
  notifyReasoningActivity(): void;
  /**
   * History was PREPENDED above the viewport. Re-anchors the scroll position
   * so the message the user was reading stays visually fixed.
   */
  notifyPrependedHistory(prepend: () => void): void;
  /** Scroll to the bottom and clear the unread count. */
  scrollToBottom(): void;
  /** Recompute proximity from the live element and emit change callbacks. */
  sync(): void;
  destroy(): void;
}

export function createScrollController(options: ScrollControllerOptions): ScrollController {
  const viewport = options.viewport;
  const pillHost = options.pillHost ?? viewport.parentElement ?? viewport;

  let reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  let unread = 0;
  let lastNear = true;
  // Distance captured BEFORE the current paint was applied.
  let preFrameDistance = bottomDistance(readMetrics(viewport));

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = `${PREFIX}-scroll-pill`;
  pill.setAttribute(SCROLL_PILL_MARKER, "1");
  pill.hidden = true;
  pill.setAttribute("aria-label", unreadPillLabel(0));
  pill.appendChild(document.createTextNode("↓"));
  pill.addEventListener("click", () => scrollToBottom());
  pillHost.appendChild(pill);

  function readMetrics(el: HTMLElement): ScrollMetrics {
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }

  function emitUnread(): void {
    pill.textContent = unreadPillLabel(unread);
    pill.setAttribute("aria-label", unreadPillLabel(unread));
    pill.hidden = unread <= 0;
    options.onUnreadChange?.(unread);
  }

  function emitProximity(near: boolean): void {
    if (near === lastNear) return;
    lastNear = near;
    options.onProximityChange?.(near);
  }

  function distance(): number {
    return bottomDistance(readMetrics(viewport));
  }

  function applyBottom(): void {
    viewport.scrollTop = viewport.scrollHeight;
    preFrameDistance = bottomDistance(readMetrics(viewport));
    emitProximity(true);
  }

  function scrollToBottom(): void {
    if (!reducedMotion && typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: scrollBehavior(false) });
      // A smooth scroll is applied asynchronously; the logical state is pinned
      // the moment the user asked for it.
      viewport.scrollTop = viewport.scrollHeight;
      preFrameDistance = 0;
      emitProximity(true);
    } else {
      // Reduced motion (or no scrollTo): a jump, never an animation.
      applyBottom();
    }
    unread = 0;
    emitUnread();
  }

  /** Composer focus must NOT move the viewport. Read statelessly (no global
   * listener to leak) — a focused text field suppresses auto-follow so the
   * caret the user is typing into never jumps. */
  function isInputFocused(): boolean {
    if (typeof document === "undefined") return false;
    const active = document.activeElement as HTMLElement | null;
    return !!active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  }

  function notifyNewResponse(): void {
    if (preFrameDistance <= SCROLL_BOTTOM_THRESHOLD_PX) {
      // Composer focus must not jump the viewport: follow silently next time.
      if (isInputFocused()) {
        preFrameDistance = distance();
        return;
      }
      scrollToBottom();
      return;
    }
    // Far from the bottom: preserve scroll, count the response.
    unread += 1;
    emitUnread();
    emitProximity(false);
    preFrameDistance = distance();
  }

  function notifyReasoningActivity(): void {
    // Reasoning is not a new response: no increment, no scroll. Only refresh
    // the captured distance so the next real response is judged correctly.
    preFrameDistance = distance();
  }

  function notifyPrependedHistory(prepend: () => void): void {
    const beforeHeight = viewport.scrollHeight;
    const beforeTop = viewport.scrollTop;
    prepend();
    const grew = viewport.scrollHeight - beforeHeight;
    if (grew > 0) {
      // Push the viewport down by the growth so the same pixel content stays
      // under the reader's eye.
      viewport.scrollTop = beforeTop + grew;
    }
    preFrameDistance = distance();
  }

  function sync(): void {
    const near = distance() <= SCROLL_BOTTOM_THRESHOLD_PX;
    emitProximity(near);
    if (near && unread > 0) {
      unread = 0;
      emitUnread();
    }
    preFrameDistance = distance();
  }

  options.onUnreadChange?.(0);
  emitProximity(distance() <= SCROLL_BOTTOM_THRESHOLD_PX);

  return {
    distance,
    nearBottom: () => distance() <= SCROLL_BOTTOM_THRESHOLD_PX,
    unreadCount: () => unread,
    beginFrame: () => {
      preFrameDistance = distance();
      return preFrameDistance;
    },
    notifyNewResponse,
    notifyReasoningActivity,
    notifyPrependedHistory,
    scrollToBottom,
    sync,
    destroy: () => {
      pill.remove();
    },
  };
}

/** Read `prefers-reduced-motion` from the live environment (jsdom-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The pill node for a controller's host — exported so tests/CSS can target it
 * without a second creation path. */
export function mountScrollPill(host: HTMLElement, controller: ScrollController): HTMLElement {
  const pill = host.querySelector<HTMLElement>(`.${PREFIX}-scroll-pill`);
  if (pill) return pill;
  const created = document.createElement("button");
  created.type = "button";
  created.className = `${PREFIX}-scroll-pill`;
  created.setAttribute(SCROLL_PILL_MARKER, "1");
  created.addEventListener("click", () => controller.scrollToBottom());
  host.appendChild(created);
  return created;
}
