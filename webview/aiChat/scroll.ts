// webview/aiChat/scroll.ts — TASK-CHATV2-016 / TASK-CHATUX-002
//
// The bottom-proximity + unread controller for the transcript viewport.
//
// CONTRACT (SPEC §7, frozen)
// - Explicit `following-tail | reading-history` state machine with a
//   hysteresis band: distance <= 72px enters following, >= 96px exits to
//   reading, and inside the band the CURRENT state is kept (no flapping).
// - The controller reads the bottom distance BEFORE it paints a new frame,
//   so an "am I pinned?" decision is made against the pre-insert geometry.
// - following-tail + a new response → scroll to the bottom. Composer focus
//   NEVER suppresses follow — a pinned reader tracks the stream while
//   typing (the old focus-suppression early-return is gone).
// - reading-history + a new response → the scroll position is PRESERVED and
//   a pill counts the missed responses.
// - Reasoning-only events never increment the unread count and never scroll.
//   Only user-visible transcript activity (an assistant text item, a tool
//   row, a terminal turn) counts as a "new response".
// - The pill is a real button, min 28px, bottom-right, labeled
//   "↓ Jump to latest — N new". Clicking it scrolls to the bottom, returns
//   to following-tail, and clears the count.
// - Scroll writes are rAF-coalesced (one per frame; setTimeout(0) fallback
//   when requestAnimationFrame is unavailable, e.g. bare jsdom). The
//   logical pin is synchronous so readers see honest geometry immediately;
//   the deferred write re-reads scrollHeight at flush to catch growth that
//   landed after the coalesced pass.
// - A guarded ResizeObserver re-pins the viewport on resize while
//   following-tail; in reading-history it is a no-op. destroy() disconnects.
// - `prefers-reduced-motion: reduce` forces `behavior: "auto"` (no smooth
//   animation). The CSS caret/spinner/pulse rules are removed in styles.css.
// - A prepended history batch preserves the visual anchor: the controller
//   measures the pre-prepend scrollHeight and re-offsets scrollTop by the
//   growth, so the message the user was reading stays put.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { CHAT_V2_ROOT_CLASS } from "./shell";

const PREFIX = CHAT_V2_ROOT_CLASS;

/** The follow machine's two states (SPEC §7). */
export type ScrollFollowState = "following-tail" | "reading-history";

/** Distance at/below which the machine enters `following-tail` (px). */
export const SCROLL_FOLLOW_ENTER_PX = 72;

/** Distance at/above which the machine exits to `reading-history` (px). */
export const SCROLL_FOLLOW_EXIT_PX = 96;

/** Minimum pill size (px) — a real, tappable control. */
export const SCROLL_PILL_MIN_PX = 28;

/** Pill copy (exact). */
export function unreadPillLabel(count: number): string {
  return `↓ Jump to latest — ${count} new`;
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
  /** Called on follow-state transitions (mirrors the reducer's
   * `scrollNearBottom`): `near` is true for `following-tail`. */
  readonly onProximityChange?(near: boolean): void;
  /** Called when the unread count changes. */
  readonly onUnreadChange?(count: number): void;
}

export interface ScrollController {
  /** Read the CURRENT bottom distance off the live element. */
  distance(): number;
  /** Recompute the follow state from live geometry (hysteresis applied)
   * and return it. */
  followState(): ScrollFollowState;
  unreadCount(): number;
  /** Capture pre-paint metrics; returns the bottom distance for this frame. */
  beginFrame(): number;
  /**
   * A new user-visible response was appended. In `following-tail` (judged on
   * the pre-frame distance) it is followed to the bottom; in
   * `reading-history` the scroll position is preserved and it is counted.
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
  /** Scroll to the bottom, return to `following-tail`, and clear unread. */
  scrollToBottom(): void;
  /** Recompute the follow state off the live element and emit callbacks. */
  sync(): void;
  destroy(): void;
}

export function createScrollController(options: ScrollControllerOptions): ScrollController {
  const viewport = options.viewport;
  const pillHost = options.pillHost ?? viewport.parentElement ?? viewport;

  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  let unread = 0;
  let followState: ScrollFollowState = "following-tail";
  let destroyed = false;
  // Distance captured BEFORE the current paint was applied.
  let preFrameDistance = bottomDistance(readMetrics(viewport));
  // rAF-coalesced scroll write: one pending flush per frame at most.
  let scrollWriteScheduled = false;
  let pendingPinTop = 0;

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

  /** Hysteresis classifier: inside the 72–96px band the CURRENT state wins. */
  function classify(distancePx: number, current: ScrollFollowState): ScrollFollowState {
    if (distancePx <= SCROLL_FOLLOW_ENTER_PX) return "following-tail";
    if (distancePx >= SCROLL_FOLLOW_EXIT_PX) return "reading-history";
    return current;
  }

  function setFollowState(next: ScrollFollowState): void {
    if (next === followState) return;
    followState = next;
    options.onProximityChange?.(next === "following-tail");
  }

  function distance(): number {
    return bottomDistance(readMetrics(viewport));
  }

  /** The deferred half of a pin: re-reads scrollHeight so growth that landed
   * after the coalesced pass is still followed. Skipped when the reader
   * moved the viewport off the pin between schedule and flush. */
  function flushScrollWrite(): void {
    scrollWriteScheduled = false;
    if (destroyed) return;
    if (viewport.scrollTop !== pendingPinTop) return;
    const top = viewport.scrollHeight;
    if (!reducedMotion && typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top, behavior: scrollBehavior(false) });
    }
    viewport.scrollTop = top;
    preFrameDistance = bottomDistance(readMetrics(viewport));
  }

  /** One scroll write per frame: rAF when present, setTimeout(0) fallback. */
  function scheduleScrollWrite(): void {
    if (scrollWriteScheduled) return;
    scrollWriteScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => flushScrollWrite());
    } else {
      setTimeout(() => flushScrollWrite(), 0);
    }
  }

  function scrollToBottom(): void {
    // The logical pin is synchronous — readers (sync(), the next frame's
    // beginFrame) must see honest geometry immediately. The DOM write is
    // coalesced: at most one deferred write per frame, re-reading
    // scrollHeight at flush.
    pendingPinTop = viewport.scrollHeight;
    if (!reducedMotion && typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: pendingPinTop, behavior: scrollBehavior(false) });
    }
    viewport.scrollTop = pendingPinTop;
    preFrameDistance = bottomDistance(readMetrics(viewport));
    setFollowState("following-tail");
    scheduleScrollWrite();
    unread = 0;
    emitUnread();
  }

  function notifyNewResponse(): void {
    if (classify(preFrameDistance, followState) === "following-tail") {
      scrollToBottom();
      return;
    }
    // Reading history: preserve scroll, count the response.
    setFollowState("reading-history");
    unread += 1;
    emitUnread();
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
    setFollowState(classify(distance(), followState));
    if (followState === "following-tail" && unread > 0) {
      unread = 0;
      emitUnread();
    }
    preFrameDistance = distance();
  }

  // Re-pin on viewport resize while following the tail; a reader mid-history
  // is left alone. Guarded: jsdom and older runtimes lack ResizeObserver.
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => {
      if (destroyed || followState !== "following-tail") return;
      pendingPinTop = viewport.scrollHeight;
      viewport.scrollTop = pendingPinTop;
      preFrameDistance = bottomDistance(readMetrics(viewport));
      scheduleScrollWrite();
    });
    resizeObserver.observe(viewport);
  }

  options.onUnreadChange?.(0);
  setFollowState(classify(distance(), followState));

  return {
    distance,
    followState: () => {
      setFollowState(classify(distance(), followState));
      return followState;
    },
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
      destroyed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
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
