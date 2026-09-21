// webview/aiChat/__tests__/errorsScrollA11y.test.ts — TASK-CHATV2-016
//
// Contract tests for the cross-cutting UX: V2 error card, stop-failure
// advisory, scroll controller and a11y helpers. The owning modules are
// implemented incrementally; each suite is added (and run RED) before its
// module lands.
//
// Covers the task §Test Cases table:
//   2 security  raw provider error never enters the card DOM or copy payload
//   8 race      Retry double activation issues exactly one immutable request
//   6 boundary  narrow/zoom CSS invariants (asserted against the source CSS)
// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ERROR_CARD_MARKER,
  ERROR_CARD_TITLE,
  createErrorCard,
  createStopFailureNotice,
  errorDetailsText,
  type AiChatStructuredRequest,
} from "../errors";
import { mapHostChatError, type AiChatErrorFrame } from "../../../src/ui/aiChatErrors";
import {
  SCROLL_FOLLOW_ENTER_PX,
  SCROLL_FOLLOW_EXIT_PX,
  bottomDistance,
  createScrollController,
  scrollBehavior,
  unreadPillLabel,
} from "../scroll";
import {
  activeDescendantResolves,
  applyFocusRing,
  countLiveRegions,
  createLiveAnnouncer,
  createTooltipTarget,
  focusRingStyle,
  isAnnounceablePhase,
  linkCombobox,
  resolveLiveRegions,
} from "../a11y";
import { CHAT_V2_ALERT_LIVE_ID, CHAT_V2_STATUS_LIVE_ID, mountChatShell } from "../shell";
import type { ComposerDraft } from "../store";

/** Minimal empty draft — attachments/context are never populated here. */
function draft(text = "hello"): ComposerDraft {
  return { text, selectionStart: 5, selectionEnd: 5, revision: 1, attachments: [], context: [] };
}

function request(clientRequestId = "req-1"): AiChatStructuredRequest {
  return { clientRequestId, draft: draft() };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Error card
// ---------------------------------------------------------------------------

describe("error card — geometry + copy contract", () => {
  it("renders the exact title, safe message and short diagnostic id", () => {
    const frame = mapHostChatError({ category: "provider_crash" });
    const card = createErrorCard({ frame, request: request() });
    document.body.appendChild(card.root);

    expect(card.root.querySelector(".UnicDB-ai-chat-v2-error-card-title")!.textContent).toBe(ERROR_CARD_TITLE);
    expect(card.root.querySelector(".UnicDB-ai-chat-v2-error-card-message")!.textContent).toBe(frame.safeMessage);
    expect(card.root.querySelector(".UnicDB-ai-chat-v2-error-card-id")!.textContent).toContain(frame.diagnosticId);
    expect(card.root.getAttribute(ERROR_CARD_MARKER)).toBe("provider_crash");
  });

  it("offers Retry only when the frame allows it and a request exists", () => {
    const retryable = createErrorCard({ frame: mapHostChatError({ category: "connection_timeout" }), request: request() });
    expect(retryable.root.querySelector('[data-action="retry"]')).not.toBeNull();

    const notRetryable = createErrorCard({ frame: mapHostChatError({ category: "context_changed" }), request: request() });
    expect(notRetryable.root.querySelector('[data-action="retry"]')).toBeNull();

    const noRequest = createErrorCard({ frame: mapHostChatError({ category: "connection_timeout" }) });
    expect(noRequest.root.querySelector('[data-action="retry"]')).toBeNull();
  });

  it("offers Change engine only when the frame allows it", () => {
    const withEngine = createErrorCard({ frame: mapHostChatError({ category: "provider_crash" }), request: request() });
    expect(withEngine.root.querySelector('[data-action="change-engine"]')).not.toBeNull();

    const without = createErrorCard({ frame: mapHostChatError({ category: "connection_timeout" }), request: request() });
    expect(without.root.querySelector('[data-action="change-engine"]')).toBeNull();
  });

  it("renders the safe detail collapsed inside a <details>", () => {
    const frame = mapHostChatError({ category: "connection_timeout", detail: "retry 2 of 3" });
    const card = createErrorCard({ frame, request: request() });
    const details = card.root.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("pre")!.textContent).toBe("retry 2 of 3");
  });

  it("omits the disclosure entirely when there is no safe detail", () => {
    const frame = mapHostChatError({ category: "connection_disconnect", detail: "ECONNREFUSED 127.0.0.1:5432" });
    const card = createErrorCard({ frame, request: request() });
    expect(card.root.querySelector("details")).toBeNull();
  });
});

describe("error card — race: Retry double activation", () => {
  it("issues exactly one retry for a double click", () => {
    const onRetry = vi.fn();
    const card = createErrorCard({
      frame: mapHostChatError({ category: "connection_timeout" }),
      request: request("req-original"),
      callbacks: { onRetry },
    });
    document.body.appendChild(card.root);
    const btn = card.root.querySelector<HTMLButtonElement>('[data-action="retry"]')!;

    btn.click();
    btn.click();
    btn.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(card.retryInFlight).toBe(true);
    expect(btn.disabled).toBe(true);
  });

  it("preserves the original immutable structured request through retry", () => {
    const captured: AiChatStructuredRequest[] = [];
    const original = request("req-original");
    const card = createErrorCard({
      frame: mapHostChatError({ category: "provider_crash" }),
      request: original,
      callbacks: { onRetry: (r) => captured.push(r) },
    });

    card.retry();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.clientRequestId).toBe("req-original");
    expect(captured[0]!.draft.text).toBe("hello");

    // The copy is independent — mutating the original draft cannot affect it.
    expect(captured[0]!.draft).not.toBe(original.draft);
    card.settleRetry();
    card.retry();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.clientRequestId).toBe("req-original");
  });

  it("a settled card is inert", () => {
    const onRetry = vi.fn();
    const card = createErrorCard({
      frame: mapHostChatError({ category: "connection_timeout" }),
      request: request(),
      callbacks: { onRetry },
    });
    card.settle();
    expect(card.retry()).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a retry is re-armed only by settleRetry", () => {
    const onRetry = vi.fn();
    const card = createErrorCard({
      frame: mapHostChatError({ category: "connection_timeout" }),
      request: request(),
      callbacks: { onRetry },
    });
    expect(card.retry()).toBe(true);
    expect(card.retry()).toBe(false);
    card.settleRetry();
    expect(card.retry()).toBe(true);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});

describe("error card — privacy", () => {
  const RAW = [
    "Authorization: Bearer sk-live-abcdef0123456789",
    "psql --host=db.internal --password=hunter2",
    '{"error":{"message":"invalid_api_key"}}',
  ];

  it("raw provider detail never reaches the DOM", () => {
    for (const raw of RAW) {
      const card = createErrorCard({ frame: mapHostChatError({ category: "auth_config", detail: raw }), request: request() });
      document.body.appendChild(card.root);
      const html = document.body.innerHTML;
      expect(html).not.toContain("sk-live");
      expect(html).not.toContain("hunter2");
      expect(html).not.toContain("invalid_api_key");
      expect(html).not.toContain("Bearer");
      card.destroy();
    }
  });

  it("raw provider detail never reaches the copy-details payload", () => {
    for (const raw of RAW) {
      const frame = mapHostChatError({ category: "auth_config", detail: raw });
      const text = errorDetailsText(frame);
      expect(text).not.toContain("sk-live");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("invalid_api_key");
      expect(text).not.toContain("Bearer");
    }
  });

  it("copy details writes only the safe frame fields", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const frame: AiChatErrorFrame = mapHostChatError({ category: "unknown" });
    const card = createErrorCard({ frame, clipboard: { writeText } });
    document.body.appendChild(card.root);

    card.root.querySelector<HTMLButtonElement>('[data-action="copy-details"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]![0] as string;
    expect(payload).toContain(frame.diagnosticId);
    expect(payload).toContain(frame.safeMessage);
  });
});

describe("stop failure advisory", () => {
  it("renders the locked copy and is a status, never a Stopped state", () => {
    const notice = createStopFailureNotice("Could not stop yet. The engine may still be working.");
    document.body.appendChild(notice.root);
    expect(notice.root.getAttribute("role")).toBe("status");
    expect(notice.root.textContent).toContain("Could not stop yet. The engine may still be working.");
    expect(notice.root.textContent).not.toContain("Stopped");
  });
});

// ---------------------------------------------------------------------------
// Scroll controller
// ---------------------------------------------------------------------------

/** Build a fake scrolling viewport (jsdom has no layout). */
function makeViewport(): { viewport: HTMLElement; host: HTMLElement; set(top: number, height: number, client: number): void } {
  const host = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.className = "UnicDB-ai-chat-v2-transcript";
  host.appendChild(viewport);
  document.body.appendChild(host);
  let scrollTop = 0;
  let scrollHeight = 1000;
  let clientHeight = 200;
  Object.defineProperty(viewport, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(viewport, "clientHeight", { get: () => clientHeight, configurable: true });
  viewport.scrollTo = ((arg: ScrollToOptions | number) => {
    scrollTop = typeof arg === "number" ? arg : arg.top ?? scrollTop;
  }) as typeof viewport.scrollTo;
  return {
    viewport,
    host,
    set(top, height, client) {
      scrollTop = top;
      scrollHeight = height;
      clientHeight = client;
    },
  };
}

describe("scroll controller — proximity discipline", () => {
  it("auto-scrolls when the pre-frame distance is within the 72px enter edge", () => {
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    // Exactly at the enter edge: 1000 - 200 - 728 = 72px → following-tail.
    viewport.scrollTop = 1000 - 200 - SCROLL_FOLLOW_ENTER_PX;
    c.beginFrame();
    c.notifyNewResponse();
    expect(viewport.scrollTop).toBe(1000);
    expect(c.unreadCount()).toBe(0);
    c.destroy();
  });

  it("far from the bottom preserves scroll and increments the pill", () => {
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    viewport.scrollTop = 100; // 1000 - 200 - 100 = 700px away
    c.beginFrame();
    c.notifyNewResponse();
    expect(viewport.scrollTop).toBe(100);
    expect(c.unreadCount()).toBe(1);

    c.beginFrame();
    c.notifyNewResponse();
    expect(c.unreadCount()).toBe(2);
    c.destroy();
  });

  it("pill copy is exact for 1 and n", () => {
    expect(unreadPillLabel(1)).toBe("↓ Jump to latest — 1 new");
    expect(unreadPillLabel(4)).toBe("↓ Jump to latest — 4 new");
  });

  it("renders a real min-28px pill in the host and clears on click", () => {
    const { viewport, host } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true, pillHost: host });
    viewport.scrollTop = 0;
    c.beginFrame();
    c.notifyNewResponse();
    const pill = host.querySelector<HTMLButtonElement>("[data-chat-scroll-pill]")!;
    expect(pill).not.toBeNull();
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe("↓ Jump to latest — 1 new");

    pill.click();
    expect(viewport.scrollTop).toBe(1000);
    expect(c.unreadCount()).toBe(0);
    expect(pill.hidden).toBe(true);
    c.destroy();
  });

  it("reasoning-only events neither increment nor scroll", () => {
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    viewport.scrollTop = 0;
    c.beginFrame();
    c.notifyReasoningActivity();
    c.notifyReasoningActivity();
    expect(c.unreadCount()).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    c.destroy();
  });

  it("composer focus does not suppress follow", () => {
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    viewport.scrollTop = 800; // 0px from bottom → following-tail
    c.beginFrame();
    c.notifyNewResponse();
    // TASK-CHATUX-002: focus suppression removed — a pinned viewport follows
    // the stream even while the composer owns focus.
    expect(viewport.scrollTop).toBe(1000);
    textarea.remove();
    c.destroy();
  });

  it("smooth behavior is disabled under reduced motion", () => {
    expect(scrollBehavior(true)).toBe("auto");
    expect(scrollBehavior(false)).toBe("smooth");
  });

  it("prepended history preserves the visual anchor", () => {
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    viewport.scrollTop = 400;
    c.notifyPrependedHistory(() => {
      // Simulate 500px of older messages inserted above.
      Object.defineProperty(viewport, "scrollHeight", { get: () => 1500, configurable: true });
    });
    expect(viewport.scrollTop).toBe(900); // 400 + 500 growth
    c.destroy();
  });

  it("bottomDistance clamps at 0 and followState honors the 72/96 hysteresis edges", () => {
    expect(bottomDistance({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(0);
    const { viewport } = makeViewport();
    const c = createScrollController({ viewport, reducedMotion: true });
    // scrollHeight 1000, clientHeight 200 → distance = 800 - scrollTop.
    viewport.scrollTop = 800 - SCROLL_FOLLOW_ENTER_PX; // 72px — enter edge
    expect(c.followState()).toBe("following-tail");
    viewport.scrollTop = 800 - (SCROLL_FOLLOW_ENTER_PX + 8); // 80px — band keeps following
    expect(c.followState()).toBe("following-tail");
    viewport.scrollTop = 800 - SCROLL_FOLLOW_EXIT_PX; // 96px — exit edge
    expect(c.followState()).toBe("reading-history");
    viewport.scrollTop = 800 - (SCROLL_FOLLOW_EXIT_PX - 8); // 88px — band keeps reading
    expect(c.followState()).toBe("reading-history");
    c.destroy();
  });
});

// ---------------------------------------------------------------------------
// Accessibility helpers
// ---------------------------------------------------------------------------

describe("a11y — live regions", () => {
  function mountShellRegions(): { polite: HTMLElement; assertive: HTMLElement; root: HTMLElement } {
    const root = document.createElement("div");
    root.className = "UnicDB-ai-chat-v2";
    document.body.appendChild(root);
    mountChatShell(root);
    return {
      root,
      polite: document.getElementById(CHAT_V2_STATUS_LIVE_ID)!,
      assertive: document.getElementById(CHAT_V2_ALERT_LIVE_ID)!,
    };
  }

  it("resolves exactly one polite + one assertive region and never adds a third", () => {
    const { root } = mountShellRegions();
    const regions = resolveLiveRegions(document);
    expect(regions.polite.id).toBe(CHAT_V2_STATUS_LIVE_ID);
    expect(regions.assertive.id).toBe(CHAT_V2_ALERT_LIVE_ID);
    expect(regions.polite.getAttribute("aria-live")).toBe("polite");
    expect(regions.assertive.getAttribute("aria-live")).toBe("assertive");
    expect(countLiveRegions(root)).toEqual({ polite: 1, assertive: 1 });
  });

  it("coalesces rapid phase changes to the last one", () => {
    vi.useFakeTimers();
    try {
      const { polite, assertive } = mountShellRegions();
      const announcer = createLiveAnnouncer({ polite, assertive, coalesceMs: 100 });
      announcer.announcePhase("Preparing your request…");
      announcer.announcePhase("Connecting to omp…");
      announcer.announcePhase("Working… 1s");
      expect(polite.textContent).toBe("");
      vi.advanceTimersByTime(120);
      expect(polite.textContent).toBe("Working… 1s");
      announcer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses token and reasoning updates", () => {
    const { polite, assertive } = mountShellRegions();
    const announcer = createLiveAnnouncer({ polite, assertive, coalesceMs: 10 });
    expect(announcer.announceToken("Hel")).toBe(false);
    expect(announcer.announceReasoning("Let me think about this")).toBe(false);
    announcer.flush();
    expect(polite.textContent).toBe("");
    expect(assertive.textContent).toBe("");
  });

  it("refuses multi-line / oversized stream chunks even via announcePhase", () => {
    const { polite, assertive } = mountShellRegions();
    const announcer = createLiveAnnouncer({ polite, assertive, coalesceMs: 10 });
    announcer.announcePhase("line one\nline two");
    announcer.announcePhase("x".repeat(200));
    announcer.flush();
    expect(polite.textContent).toBe("");
    expect(isAnnounceablePhase("Responding…")).toBe(true);
    expect(isAnnounceablePhase("a\nb")).toBe(false);
    expect(isAnnounceablePhase("")).toBe(false);
  });

  it("urgent announcements go to the assertive region immediately", () => {
    const { polite, assertive } = mountShellRegions();
    const announcer = createLiveAnnouncer({ polite, assertive, coalesceMs: 100 });
    announcer.announceNow("Could not complete this response.");
    expect(assertive.textContent).toBe("Could not complete this response.");
    expect(polite.textContent).toBe("");
    announcer.destroy();
  });

  it("pure helpers refuse empty/undefined input", () => {
    expect(isAnnounceablePhase(undefined as unknown as string)).toBe(false);
  });
});

describe("a11y — focus ring + combobox linkage + tooltip", () => {
  it("exposes the exact 2px ring / 2px offset contract", () => {
    const ring = focusRingStyle();
    expect(ring.outline).toContain("2px solid");
    expect(ring.outlineOffset).toBe("2px");
    const btn = document.createElement("button");
    applyFocusRing(btn);
    expect(btn.style.outlineOffset).toBe("2px");
  });

  it("links a listbox to the focused input with a resolvable activedescendant", () => {
    const input = document.createElement("textarea");
    const list = document.createElement("ul");
    const option = document.createElement("li");
    option.id = "opt-1";
    option.setAttribute("role", "option");
    list.appendChild(option);
    document.body.append(input, list);

    const link = linkCombobox({ input, list, listId: "ac-list" });
    expect(list.getAttribute("role")).toBe("listbox");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe("ac-list");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    link.setExpanded(true);
    link.setActive("opt-1");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(activeDescendantResolves(input, list)).toBe(true);
    expect(document.activeElement).not.toBe(option); // focus never moves into the list

    link.setActive("missing-id");
    expect(activeDescendantResolves(input, list)).toBe(false);

    link.destroy();
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("tooltip: native title minimum + custom tooltip on 500ms hover and instant focus", () => {
    vi.useFakeTimers();
    try {
      const target = document.createElement("button");
      document.body.appendChild(target);
      const tip = createTooltipTarget({ target, label: "Send message" });
      expect(target.title).toBe("Send message");
      expect(target.getAttribute("aria-label")).toBe("Send message");
      expect(tip.tooltip!.hidden).toBe(true);

      target.dispatchEvent(new Event("pointerenter"));
      vi.advanceTimersByTime(499);
      expect(tip.tooltip!.hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(tip.tooltip!.hidden).toBe(false);

      target.dispatchEvent(new Event("pointerleave"));
      expect(tip.tooltip!.hidden).toBe(true);

      // Keyboard focus is immediate — no timer advance.
      target.dispatchEvent(new Event("focus"));
      expect(tip.tooltip!.hidden).toBe(false);
      expect(target.getAttribute("aria-describedby")).toBe(tip.tooltip!.id);

      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(tip.tooltip!.hidden).toBe(true);
      tip.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("nativeOnly renders no custom tooltip node", () => {
    const target = document.createElement("button");
    const tip = createTooltipTarget({ target, label: "Stop", nativeOnly: true });
    expect(tip.tooltip).toBeNull();
    expect(target.title).toBe("Stop");
  });
});

// ---------------------------------------------------------------------------
// Scoped CSS contract (jsdom cannot prove geometry; these guard the rules)
// ---------------------------------------------------------------------------

describe("responsive/HC/reduced-motion CSS contract", () => {
  const css = existsSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"))
    ? readFileSync(resolve(process.cwd(), "webview", "aiChat", "styles.css"), "utf8")
    : "";

  /** Body of the FIRST rule whose selector text matches. */
  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "m"));
    return m?.[2] ?? "";
  }

  it("stylesheet exists and every new selector is scoped to the V2 root", () => {
    expect(css).not.toBe("");
    for (const selector of [
      ".UnicDB-ai-chat-v2-error-card",
      ".UnicDB-ai-chat-v2-scroll-pill",
      ".UnicDB-ai-chat-v2-stop-failure",
      ".UnicDB-ai-chat-v2-tooltip",
    ]) {
      expect(css).toContain(selector);
    }
    // No unscoped global leaked into this file.
    expect(css).not.toMatch(/(^|\n)\.chat\s*\{/);
  });

  it("error card: assistant width, 10x12 padding, 3px danger border", () => {
    const body = ruleBody(".UnicDB-ai-chat-v2-error-card");
    expect(body).toContain("width: 880px");
    expect(body).toContain("max-width: 92%");
    expect(body).toContain("padding: 10px 12px");
    expect(body).toContain("border-left: 3px solid var(--UnicDB-ai-chat-v2-danger)");
    expect(body).toContain("background: color-mix");
  });

  it("error card actions are real >=32px controls with a 2px/2px ring", () => {
    const body = ruleBody(".UnicDB-ai-chat-v2-error-card-action");
    expect(body).toContain("min-height: 32px");
    expect(body).toContain("min-width: 32px");
    const focus = ruleBody(".UnicDB-ai-chat-v2-error-card-action:focus-visible");
    expect(focus).toContain("outline: 2px solid");
    expect(focus).toContain("outline-offset: 2px");
  });

  it("scroll pill is bottom-right and at least 28px", () => {
    const body = ruleBody(".UnicDB-ai-chat-v2-scroll-pill");
    expect(body).toContain("position: absolute");
    expect(body).toContain("right: 12px");
    expect(body).toContain("bottom: 12px");
    expect(body).toContain("min-width: 28px");
    expect(body).toContain("min-height: 28px");
  });

  it("send/stop stay 32x32 and generic controls stay >=32px", () => {
    const send = ruleBody(".UnicDB-ai-chat-v2-send");
    expect(send).toContain("width: 32px");
    expect(send).toContain("height: 32px");
    const control = ruleBody(".UnicDB-ai-chat-v2-control");
    if (control) {
      expect(control).toContain("min-height: 32px");
    }
    const stop = ruleBody(".UnicDB-ai-chat-v2-stop");
    expect(css).toContain(".UnicDB-ai-chat-v2-stop");
  });

  it("under 420px hidden labels keep their aria-label (not display:none on the control)", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 419px)"));
    expect(narrow).toContain(".UnicDB-ai-chat-v2-label-optional");
    // The hidden thing is the optional LABEL span, never the button itself.
    expect(narrow).not.toMatch(/\.UnicDB-ai-chat-v2-send\s*\{\s*display: none/);
  });

  it("under 320px composer/card actions wrap into two rows", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 319px)"));
    expect(narrow).toContain(".UnicDB-ai-chat-v2-error-card-actions");
    expect(narrow).toContain("grid-template-columns");
  });

  it("reduced motion disables animation/transition on the new surfaces", () => {
    const blocks = css.split("@media (prefers-reduced-motion: reduce)");
    expect(blocks.length).toBeGreaterThan(2);
    const tail = blocks[blocks.length - 1]!;
    expect(tail).toContain(".UnicDB-ai-chat-v2-error-card");
    expect(tail).toContain(".UnicDB-ai-chat-v2-scroll-pill");
    expect(tail).toContain("animation: none");
    expect(tail).toContain("transition: none");
    expect(tail).toContain("scroll-behavior: auto");
  });

  it("high contrast keeps system colors + highlight ring", () => {
    const hc = css.split("@media (forced-colors: active)").pop()!;
    expect(hc).toContain("ButtonBorder");
    expect(hc).toContain("Highlight");
  });

  it("no horizontal page overflow: min-width:0 + overflow-wrap on the card", () => {
    const body = ruleBody(".UnicDB-ai-chat-v2-error-card");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-width: 0");
    expect(body).not.toContain("width: 100vw");
  });
});
