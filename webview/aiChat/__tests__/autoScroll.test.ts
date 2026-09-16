// webview/aiChat/__tests__/autoScroll.test.ts — TASK-CHATFIX-002
//
// `createScrollController` (scroll.ts) is fully implemented but was never
// driven. These tests prove the SINGLE coalesced render pass in controller.ts
// now drives it:
//   #1 a new user-visible response auto-follows to the bottom
//   #2 reasoning-only deltas never scroll and never show the pill
//   #3 a user scrolled up keeps their position and gets the unread pill
//   #4 composer textarea focus mid-turn never scroll-jacks the transcript
//      (plan-review edge row, scroll.ts isInputFocused contract)
//   #5 regression: the coalesced pass is the ONE driver (RED today)
// Rows 1/3/5 were executed RED against the pre-wiring controller and pasted
// into the task's Executor Report; rows 2/4 are "never scrolls" invariants.
// jsdom does no layout: geometry is mocked with defineProperty, per the task.
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createChatController, type ChatController, type VsCodeApiLike } from "../controller";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../../src/ui/aiChatPanelMessages";
import { SCROLL_PILL_MARKER } from "../scroll";

let controllers: ChatController[] = [];

interface MockedViewport {
  readonly el: HTMLElement;
  top: number;
}

/** Mock the geometry the scroll controller reads (jsdom does no layout). */
function mockScrollGeometry(el: HTMLElement, top: number, height = 2000, client = 400): MockedViewport {
  let currentTop = top;
  Object.defineProperty(el, "scrollTop", {
    get: () => currentTop,
    set: (value: number) => {
      currentTop = value;
    },
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
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
    expect(h.pill.textContent).toBe("↓ 1 new response");
  });

  it("#4 composer focus mid-turn never scroll-jacks the transcript", () => {
    const h = makeHarness();
    openTurn(h);
    h.viewport.top = 1600; // near bottom
    h.controller.prompt.focus();
    expect(document.activeElement).toBe(h.controller.prompt);
    h.send({ kind: "text_delta", sessionId: "s1", sequence: h.nextSequence(), turnId: "t1", messageId: "m1", text: "more" });
    h.controller.flushRender();
    expect(h.viewport.top).toBe(1600);
    expect(h.pill.hidden).toBe(true);
  });

  it("#5 regression: the coalesced render pass is the ONE driver of the scroll controller", () => {
    const source = readFileSync(resolve(process.cwd(), "webview", "aiChat", "controller.ts"), "utf8");
    // Exactly one call site per driver method — no scattered notify calls.
    expect(source.match(/scroll\.beginFrame\(\)/g)?.length).toBe(1);
    expect(source.match(/scroll\.notifyNewResponse\(\)/g)?.length).toBe(1);
    expect(source.match(/scroll\.notifyReasoningActivity\(\)/g)?.length).toBe(1);
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
  });
});
