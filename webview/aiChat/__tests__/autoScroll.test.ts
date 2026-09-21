// webview/aiChat/__tests__/autoScroll.test.ts — TASK-CHATFIX-002 / TASK-CHATUX-002
//
// `createScrollController` (scroll.ts) is driven by the SINGLE coalesced
// render pass in controller.ts. TASK-CHATUX-002 replaced the boolean
// proximity model with a `following-tail | reading-history` state machine
// (enter <=72px, exit >=96px, hysteresis band between), removed the
// focus-suppression early-return, rAF-coalesced scroll writes
// (setTimeout(0) fallback), and added a guarded ResizeObserver re-pin.
//   #1 a new user-visible response auto-follows to the bottom
//   #2 reasoning-only deltas never scroll and never show the pill
//   #3 a user scrolled up keeps their position and gets the unread pill
//   #4 TASK-CHATUX-002 row 1: focused composer + delta while pinned FOLLOWS
//      (inverts the old focus suppression — RED before the fix)
//   #5 regression: the coalesced pass is the ONE driver
//   #6 fix-round-1 regression: same-message streaming growth keeps following
//      while pinned
//   #7 fix-round-1 sibling: the same growth while scrolled up never scrolls
//      and never counts
//   #8 TASK-CHATUX-002 row 2: the 72–96 hysteresis band keeps the current
//      state in BOTH directions
//   #9 TASK-CHATUX-002 row 3: scrolled-up + focused + delta → no scroll,
//      pill counts with the new "Jump to latest" copy
//   #10 TASK-CHATUX-002 row 4: no rAF → setTimeout(0) fallback still lands
//      the deferred write (re-reads scrollHeight at flush)
//   #11 TASK-CHATUX-002 row 5: mocked ResizeObserver re-pins only while
//      following-tail; destroy() disconnects
// jsdom does no layout: geometry is mocked with defineProperty, per the task.
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatController, type ChatController, type VsCodeApiLike } from "../controller";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../../src/ui/aiChatPanelMessages";
import { SCROLL_PILL_MARKER } from "../scroll";

let controllers: ChatController[] = [];

interface MockedViewport {
  readonly el: HTMLElement;
  top: number;
  /** Mutable content height — streaming growth re-pins against taller content. */
  height: number;
}

/** Mock the geometry the scroll controller reads (jsdom does no layout). */
function mockScrollGeometry(el: HTMLElement, top: number, height = 2000, client = 400): MockedViewport {
  let currentTop = top;
  let currentHeight = height;
  Object.defineProperty(el, "scrollTop", {
    get: () => currentTop,
    set: (value: number) => {
      currentTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", { get: () => currentHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => client, configurable: true });
  // Both scroll.ts branches converge on a scrollTop write; mirror scrollTo so
  // the smooth branch stays honest too.
  (el as { scrollTo?: unknown }).scrollTo = (arg: ScrollToOptions | number) => {
    currentTop = typeof arg === "number" ? arg : (arg.top ?? currentTop);
  };
  return {
    el,
    get top(): number {
      return currentTop;
    },
    set top(value: number) {
      currentTop = value;
    },
    get height(): number {
      return currentHeight;
    },
    set height(value: number) {
      currentHeight = value;
    },
  };
}

interface Harness {
  controller: ChatController;
  root: HTMLElement;
  viewport: MockedViewport;
  pill: HTMLButtonElement;
  sent: unknown[];
  send(frame: Record<string, unknown>): void;
  nextSequence(): number;
}

/** Same shape as controllerSurfaces.test.ts: stub postMessage + real controller. */
function makeHarness(): Harness {
  const root = document.createElement("div");
  root.id = "UnicDB-root";
  document.body.appendChild(root);
  const sent: unknown[] = [];
  const api: VsCodeApiLike = { postMessage: (message) => sent.push(message) };
  const controller = createChatController({
    root,
    vscode: api,
    nextId: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
    schedule: (fn) => fn(),
  });
  controllers.push(controller);

  const transcriptEl = root.querySelector<HTMLElement>(".UnicDB-ai-chat-v2-transcript");
  if (transcriptEl === null) throw new Error("transcript viewport missing");
  // 2000 - 400 - 1600 = 0px from the bottom → pinned by default.
  const viewport = mockScrollGeometry(transcriptEl, 1600);
  const pill = root.querySelector<HTMLButtonElement>(`[${SCROLL_PILL_MARKER}]`);
  if (pill === null) throw new Error("scroll pill missing");

  let sequence = 0;
  return {
    controller,
    root,
    viewport,
    pill,
    sent,
    send: (frame) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, ...frame },
        }),
      ),
    nextSequence: () => ++sequence,
  };
}

/** Hydrate, type, submit, and ack the host turn so deltas have a live turn. */
function openTurn(h: Harness, text = "hello"): void {
  h.send({ kind: "session_hydrated", sessionId: "s1", sequence: h.nextSequence(), hasHistory: false, visionCapable: false });
  h.controller.prompt.value = text;
  h.controller.prompt.dispatchEvent(new Event("input", { bubbles: true }));
  h.controller.requestSubmit();
  const submit = h.sent.find((intent) => (intent as { kind?: string }).kind === "submit_turn") as
    | { clientRequestId: string }
    | undefined;
  if (submit === undefined) throw new Error("submit_turn was not posted");
  h.send({
    kind: "turn_started",
    sessionId: "s1",
    sequence: h.nextSequence(),
    turnId: "t1",
    clientRequestId: submit.clientRequestId,
  });
}

afterEach(() => {
  for (const c of controllers) {
    try {
      c.dispose();
    } catch {
      /* already disposed */
    }
  }
  controllers = [];
  document.body.innerHTML = "";
});

describe("auto-scroll — the render pass drives the scroll controller (TASK-CHATFIX-002)", () => {
  it("#1 a new user-visible response auto-follows to the bottom", () => {
    const h = makeHarness();
    openTurn(h);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2000);
    expect(h.pill.hidden).toBe(true);
  });

  it("#2 reasoning-only deltas never scroll and never show the pill", () => {
    const h = makeHarness();
    openTurn(h);
    h.viewport.top = 1600; // pinned again after the user bubble followed
    h.send({ kind: "reasoning_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "thinking" });
    h.send({ kind: "reasoning_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: " still thinking" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(1600);
    expect(h.pill.hidden).toBe(true);
  });

  it("#3 user scrolled up: position preserved and the pill counts the missed response", () => {
    const h = makeHarness();
    openTurn(h);
    h.viewport.top = 0; // 2000 - 400 - 0 = 1600px away — far past the 48px pin
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "the answer" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(0);
    expect(h.pill.hidden).toBe(false);
    expect(h.pill.textContent).toBe("↓ Jump to latest — 1 new");
  });

  it("#4 focused textarea + new text_delta while pinned follows to bottom", () => {
    const h = makeHarness();
    openTurn(h);
    h.viewport.top = 1600; // near bottom
    h.controller.prompt.focus();
    expect(document.activeElement).toBe(h.controller.prompt);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "more" });
    h.controller.flushRender();
    // TASK-CHATUX-002: composer focus no longer suppresses follow — the
    // pinned viewport tracks the stream while the user types.
    expect(h.viewport.top).toBe(2000);
    expect(h.pill.hidden).toBe(true);
  });

  it("#5 regression: the coalesced render pass is the ONE driver of the scroll controller", () => {
    const source = readFileSync(resolve(process.cwd(), "webview", "aiChat", "controller.ts"), "utf8");
    // Exactly one beginFrame capture — the pre-frame distance every notify in
    // the pass is judged on.
    expect(source.match(/scroll\.beginFrame\(\)/g)?.length).toBe(1);
    // The driver lives inside the single coalesced pass: beginFrame BEFORE the
    // transcript/activity paints, the notify diff after them, sync last.
    const passStart = source.indexOf("function renderState");
    const passEnd = source.indexOf("function renderChangePlan");
    expect(passStart).toBeGreaterThan(0);
    expect(passEnd).toBeGreaterThan(passStart);
    const renderPass = source.slice(passStart, passEnd);
    expect(renderPass).toContain("scroll.beginFrame()");
    expect(renderPass.indexOf("scroll.beginFrame()")).toBeLessThan(renderPass.indexOf("transcript.render(state)"));
    expect(renderPass).toContain("scroll.notifyNewResponse()");
    expect(renderPass).toContain("scroll.notifyReasoningActivity()");
    expect(renderPass).toContain("scroll.sync()");
    // Fix round 1: the pinned-growth branch legitimately calls
    // notifyNewResponse a second time (new id vs growth of an existing id) —
    // the invariant is not a textual count, it is that ZERO driver sites live
    // OUTSIDE the single coalesced pass.
    expect(source.match(/scroll\.notifyNewResponse\(\)/g)?.length).toBe(
      renderPass.match(/scroll\.notifyNewResponse\(\)/g)?.length,
    );
    expect(source.match(/scroll\.notifyReasoningActivity\(\)/g)?.length).toBe(
      renderPass.match(/scroll\.notifyReasoningActivity\(\)/g)?.length,
    );
  });

  it("#6 fix-round regression: same-message streaming growth keeps following (no spurious pill)", () => {
    const h = makeHarness();
    openTurn(h);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2000); // first delta pinned at the bottom
    // Mid-message growth: SAME messageId (store.ts merges deltas into one
    // item), longer raw — the viewport must keep following instead of
    // stopping after the first delta.
    h.viewport.height = 2400;
    h.send({
      kind: "text_delta",
      sessionId: "s1",
      sequence: h.nextSequence(),
      turnId: "t1",
      messageId: "m1",
      text: "hi — now a much longer streamed answer",
    });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2400);
    expect(h.pill.hidden).toBe(true);
    // Growth again — each bump is exactly clientHeight (400px): the mock's
    // scrollTo overshoots to scrollTop = scrollHeight where a real browser
    // clamps, leaving 400px of slack per frame; beyond that the mock's static
    // geometry would read "far" where a real browser's PRE-frame capture
    // (old scrollHeight) still reads pinned. Cumulative growth is now 800px
    // and the viewport has followed every frame.
    h.viewport.height = 2800;
    h.send({
      kind: "text_delta",
      sessionId: "s1",
      sequence: h.nextSequence(),
      turnId: "t1",
      messageId: "m1",
      text: "hi — now a much longer streamed answer, still streaming on",
    });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2800);
    expect(h.pill.hidden).toBe(true);
    // …so the NEXT new id never lands far-from-bottom: no spurious unread
    // pill for content the user never scrolled away from (unread stays 0).
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m2", text: "next block" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2800);
    expect(h.pill.hidden).toBe(true);
    expect(h.pill.textContent).toBe("↓ Jump to latest — 0 new");
  });

  it("#7 fix-round sibling: same-message growth while scrolled up never scrolls and never counts", () => {
    const h = makeHarness();
    openTurn(h);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();
    h.viewport.top = 0; // reader scrolled far up mid-stream
    h.viewport.height = 2400; // the message keeps growing below
    h.send({
      kind: "text_delta",
      sessionId: "s1",
      sequence: h.nextSequence(),
      turnId: "t1",
      messageId: "m1",
      text: "hi — now a much longer streamed answer",
    });
    h.controller.flushRender();
    // Far from the bottom, growth stays mere activity: position preserved,
    // no scroll, and the unread count is never incremented (still 0 — a
    // spurious count would read "↓ Jump to latest — 1 new" with the pill visible).
    expect(h.viewport.top).toBe(0);
    expect(h.pill.hidden).toBe(true);
    expect(h.pill.textContent).toBe("↓ Jump to latest — 0 new");
  });

  it("#8 distance inside the 72–96 hysteresis band keeps the current state", () => {
    const h = makeHarness();
    openTurn(h);
    // From following-tail: 80px of drift (inside the band) still follows.
    h.viewport.top = 1520; // 2000 - 400 - 1520 = 80px — inside the band
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2000);
    expect(h.pill.hidden).toBe(true);

    // From reading-history: the same 80px distance keeps reading — no
    // scroll, and the missed response is counted.
    h.viewport.top = 0; // scrolled far up → exits to reading-history
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m2", text: "far" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(0);
    expect(h.pill.hidden).toBe(false);
    h.viewport.top = 1520; // 80px — inside the band, state must not flap
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m3", text: "still far" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(1520);
    expect(h.pill.textContent).toBe("↓ Jump to latest — 2 new");
  });

  it("#9 scrolled-up + focused + delta → no scroll, pill counts", () => {
    const h = makeHarness();
    openTurn(h);
    h.viewport.top = 0; // far from the bottom
    h.controller.prompt.focus();
    expect(document.activeElement).toBe(h.controller.prompt);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "the answer" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(0);
    expect(h.pill.hidden).toBe(false);
    expect(h.pill.textContent).toBe("↓ Jump to latest — 1 new");
  });

  it("#10 jsdom without rAF constructs and follows via the setTimeout fallback", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const h = makeHarness(); // must not throw without rAF/ResizeObserver
    openTurn(h);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "hi" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(2000); // logical pin is synchronous
    // The deferred write re-reads scrollHeight at flush: content that grew
    // after the pass is still caught by the setTimeout(0) fallback.
    h.viewport.height = 2400;
    vi.runOnlyPendingTimers();
    expect(h.viewport.top).toBe(2400);
    vi.useRealTimers();
  });

  it("#11 mocked ResizeObserver re-pins only while following-tail", () => {
    let captured: (() => void) | null = null;
    let disconnected = false;
    class FakeResizeObserver {
      constructor(cb: () => void) {
        captured = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        disconnected = true;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const h = makeHarness();
    openTurn(h);
    expect(captured).not.toBeNull();
    const fire = (): void => (captured as unknown as () => void)();

    // following-tail: a viewport resize re-pins to the bottom.
    h.viewport.top = 1200; // simulate the viewport drifting off the pin
    fire();
    expect(h.viewport.top).toBe(2000);

    // reading-history: the same callback leaves the reader alone.
    h.viewport.top = 0;
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "far" });
    h.controller.flushRender(); // exits to reading-history, pill counts
    expect(h.pill.hidden).toBe(false);
    h.viewport.top = 500;
    fire();
    expect(h.viewport.top).toBe(500);

    h.controller.dispose();
    expect(disconnected).toBe(true);
  });
});
