// webview/aiChat/__tests__/messageActions.test.ts — TASK-CHATFIX-004
//
// The transcript renders copy / edit / retry / 3-dot action buttons, but the
// controller wired only copy/regenerate/load-earlier — the rest were dead
// buttons. This suite pins the LIVE wiring through the real controller
// (makeHarness pattern from controllerSurfaces.test.ts: stub postMessage, real
// controller, host frames via window.message):
//
//   1 happy  copy user message   → clipboard writeText + "Copied" toast
//   2 happy  edit user message   → text back in the composer draft + focused
//   3 happy  retry user message  → one submit_turn carrying the message text
//   4 happy  assistant 3-dot     → overlay menu with Copy/Regenerate; Esc closes
//   5 edge   clipboard rejection → "Could not copy" toast at error level
//   6 edge   blank message       → edit focuses an empty composer, retry inert
//   7 regression                 → the callbacks object must stay wired
//   8 regression                 → a RE-OPENED streaming 3-dot copies the grown
//                                  text, never the first click's snapshot
//
// Test #6 drives the controller's REAL captured callbacks against a
// reducer-built blank user item: `canSubmitDraft` blocks blank UI submits, so a
// blank user item is only reachable through the reducer — exactly the
// transcript.test.ts state-building pattern.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Transparent capture wrapper: every createTranscriptRenderer call still runs
// the real module; we only record the callbacks object the controller passes so
// test #6 can drive the production wiring against a synthetic state.
const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../transcript", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../transcript")>();
  return {
    ...actual,
    createTranscriptRenderer: (
      ...args: Parameters<typeof actual.createTranscriptRenderer>
    ) => {
      captured.push((args[1] ?? {}) as Record<string, unknown>);
      return actual.createTranscriptRenderer(...args);
    },
  };
});

import {
  createChatController,
  type ChatController,
  type VsCodeApiLike,
} from "../controller";
import {
  createInitialChatState,
  reduceChatState,
  type ChatViewState,
} from "../store";
import type { AiChatHostFrameV2 } from "../../../src/ui/aiChatPanelMessages";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../../src/ui/aiChatPanelMessages";
import {
  COPY_FAIL_LABEL,
  COPY_OK_LABEL,
  createTranscriptRenderer,
  type TranscriptCallbacks,
} from "../transcript";
import { OVERLAY_MENU_MARKER } from "../overlays";

const TOAST_CLASS = ".UnicDB-ai-chat-v2-toast";

// ---------------------------------------------------------------------------
// Harness (controllerSurfaces.test.ts:44 pattern — stub postMessage, real
// controller, synchronous renders)
// ---------------------------------------------------------------------------

let controllers: ChatController[] = [];

interface Harness {
  controller: ChatController;
  root: HTMLElement;
  sent: unknown[];
  send(frame: Record<string, unknown>): void;
}

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
  return {
    controller,
    root,
    sent,
    send: (frame) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, ...frame },
        }),
      ),
  };
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  for (const c of controllers) {
    try {
      c.dispose();
    } catch {
      /* already disposed */
    }
  }
  controllers = [];
  document.body.replaceChildren();
});

/** Simulate a real user edit: set the value then fire the input event. */
function type(prompt: HTMLTextAreaElement, value: string): void {
  prompt.value = value;
  prompt.setSelectionRange(value.length, value.length);
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Hydrate, submit "hello", run the turn to completion → one idle user bubble. */
function seedIdleUserTurn(h: Harness): HTMLElement {
  h.send({
    kind: "session_hydrated",
    sessionId: "s1",
    sequence: 1,
    hasHistory: false,
    visionCapable: false,
  });
  type(h.controller.prompt, "hello");
  h.controller.requestSubmit();
  h.send({ kind: "turn_started", sessionId: "s1", sequence: 2, turnId: "t1", clientRequestId: "req-1" });
  h.send({ kind: "turn_finished", sessionId: "s1", sequence: 3, turnId: "t1", outcome: "completed" });
  h.controller.flushRender();
  const item = h.root.querySelector<HTMLElement>(
    '.UnicDB-ai-chat-v2-transcript [data-chat-key="user-req-1"]',
  );
  expect(item, "expected the user bubble user-req-1 to be rendered").not.toBeNull();
  return item!;
}

/** Stream an assistant answer into the OPEN turn (call between started/finished). */
function seedAssistantMessage(h: Harness, sequence: number, turnId: string): void {
  h.send({
    kind: "text_delta",
    sessionId: "s1",
    sequence,
    turnId,
    messageId: "m1",
    text: "answer text",
  });
  h.controller.flushRender();
}

function stubClipboard(impl: () => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function submitsOf(h: Harness): Array<Record<string, unknown>> {
  return h.sent.filter(
    (message) => (message as Record<string, unknown>).kind === "submit_turn",
  ) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests (§Test Cases table)
// ---------------------------------------------------------------------------

describe("message actions — TASK-CHATFIX-004", () => {
  it("#1 copy user message writes the exact text and toasts Copied", async () => {
    const h = makeHarness();
    const writeText = stubClipboard(() => Promise.resolve());
    const item = seedIdleUserTurn(h);

    item.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();

    expect(writeText).toHaveBeenCalledWith("hello");
    await vi.waitFor(() => {
      const toast = h.root.querySelector<HTMLElement>(TOAST_CLASS);
      expect(toast?.textContent ?? "").toContain(COPY_OK_LABEL);
    });
  });

  it("#2 edit loads the message text back into the composer draft and focuses it", () => {
    const h = makeHarness();
    const item = seedIdleUserTurn(h);

    item.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();

    expect(h.controller.prompt.value).toBe("hello");
    expect(document.activeElement).toBe(h.controller.prompt);
  });

  it("#3 retry re-sends the message text as one submit_turn while idle", () => {
    const h = makeHarness();
    const item = seedIdleUserTurn(h);
    const before = submitsOf(h).length;
    expect(before).toBe(1); // the original turn

    item.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();

    const submits = submitsOf(h);
    expect(submits).toHaveLength(before + 1);
    expect((submits.at(-1) as { draft: { text: string } }).draft.text).toBe("hello");
  });

  it("#4 assistant 3-dot opens the actions menu with Copy + Regenerate; Escape closes it", () => {
    const h = makeHarness();
    seedIdleUserTurn(h);
    // Reopen a turn for the assistant message: submit → started → delta → finished.
    type(h.controller.prompt, "again");
    h.controller.requestSubmit();
    h.send({ kind: "turn_started", sessionId: "s1", sequence: 4, turnId: "t2", clientRequestId: "req-2" });
    seedAssistantMessage(h, 5, "t2");
    h.send({ kind: "turn_finished", sessionId: "s1", sequence: 6, turnId: "t2", outcome: "completed" });
    h.controller.flushRender();

    const more = h.root.querySelector<HTMLButtonElement>(
      '[data-chat-key="m1"] [data-action="more"]',
    );
    expect(more, "expected the assistant 3-dot button").not.toBeNull();
    more!.click();

    const menu = h.root.querySelector<HTMLElement>(`[${OVERLAY_MENU_MARKER}]`);
    expect(menu, "expected the overlay menu to be mounted").not.toBeNull();
    const rows = Array.from(menu!.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (row) => row.textContent ?? "",
    );
    expect(rows.some((text) => text.includes("Copy message"))).toBe(true);
    expect(rows.some((text) => text.includes("Regenerate response"))).toBe(true);

    // Focus sits on the trigger (non-modal contract); Escape dismisses.
    more!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(h.root.querySelector(`[${OVERLAY_MENU_MARKER}]`)).toBeNull();
  });

  it("#5 clipboard rejection announces Could not copy at error level", async () => {
    const h = makeHarness();
    stubClipboard(() => Promise.reject(new Error("denied")));
    const item = seedIdleUserTurn(h);

    item.querySelector<HTMLButtonElement>('[data-action="copy"]')!.click();

    await vi.waitFor(() => {
      const toast = h.root.querySelector<HTMLElement>(
        `${TOAST_CLASS}[data-level="error"]`,
      );
      expect(toast?.textContent ?? "").toBe(COPY_FAIL_LABEL);
    });
  });

  it("#6 blank message is inert: edit focuses an empty composer, retry never posts", () => {
    const h = makeHarness();
    // The controller's REAL production callbacks (captured at mount).
    const callbacks = captured.at(-1) as TranscriptCallbacks | undefined;
    expect(callbacks, "expected the controller to mount a transcript renderer").toBeDefined();

    // A blank user item is only reducer-reachable (canSubmitDraft blocks blank
    // UI submits): build the state with the REAL reducer, render with the REAL
    // renderer wired to the controller's REAL callbacks.
    let state: ChatViewState = createInitialChatState();
    state = reduceChatState(state, {
      type: "TRANSCRIPT_PAGE_LOADED",
      items: [
        { id: "u-blank", kind: "user", clientRequestId: "c0", text: "", context: [] },
      ],
      total: 1,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const renderer = createTranscriptRenderer({ transcript: container }, callbacks);
    try {
      renderer.render(state);
      const item = container.querySelector<HTMLElement>('[data-chat-key="u-blank"]');
      expect(item, "expected the blank user bubble").not.toBeNull();

      const before = submitsOf(h).length;
      item!.querySelector<HTMLButtonElement>('[data-action="edit"]')!.click();
      expect(h.controller.prompt.value).toBe("");
      expect(document.activeElement).toBe(h.controller.prompt);

      item!.querySelector<HTMLButtonElement>('[data-action="retry"]')!.click();
      expect(submitsOf(h)).toHaveLength(before); // NO submit_turn for blank text
    } finally {
      renderer.dispose();
      container.remove();
    }
  });

  it("#7 regression: the controller wires edit/retry/3-dot (no dead buttons)", () => {
    // Pre-implementation these names appear NOWHERE in controller.ts — the
    // buttons rendered but did nothing. This pins the wiring permanently.
    // Comments are stripped first so prose cannot satisfy the pin, and the
    // patterns then match only the wiring signatures (`onEditUser(_messageId,
    // …)`) — reviewer fix-round-1: the old bare `onEditUser\s*\(` also matched
    // comments, making the pin weaker than it looked.
    const source = readFileSync(
      resolve(process.cwd(), "webview", "aiChat", "controller.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(source).toMatch(/onEditUser\s*\(\s*_messageId/);
    expect(source).toMatch(/onRetryUser\s*\(\s*_messageId/);
    expect(source).toMatch(/onMoreAssistant\s*\(\s*_messageId/);
  });

  it("#8 regression: re-opening a streaming 3-dot copies the GROWN text, not the first snapshot", async () => {
    // Reviewer CHANGES-REQUESTED (fix round 1): openMessageActions reused one
    // overlay menu per trigger whose onActivate closed over the FIRST click's
    // raw text, while record.source keeps growing during streaming — so a
    // re-opened menu silently copied a stale truncated message.
    const h = makeHarness();
    const writeText = stubClipboard(() => Promise.resolve());
    seedIdleUserTurn(h);
    // Open a turn and stream the first chunk.
    type(h.controller.prompt, "q2");
    h.controller.requestSubmit();
    h.send({ kind: "turn_started", sessionId: "s1", sequence: 4, turnId: "t2", clientRequestId: "req-2" });
    seedAssistantMessage(h, 5, "t2");

    const more = h.root.querySelector<HTMLButtonElement>(
      '[data-chat-key="m1"] [data-action="more"]',
    );
    expect(more, "expected the assistant 3-dot button").not.toBeNull();

    // First open mid-stream, then dismiss (Escape).
    more!.click();
    expect(h.root.querySelector(`[${OVERLAY_MENU_MARKER}]`)).not.toBeNull();
    more!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(h.root.querySelector(`[${OVERLAY_MENU_MARKER}]`)).toBeNull();

    // The stream grows (record.source = item.raw keeps appending)…
    h.send({
      kind: "text_delta",
      sessionId: "s1",
      sequence: 6,
      turnId: "t2",
      messageId: "m1",
      text: " + streamed tail",
    });
    h.controller.flushRender();

    // …the SAME trigger re-opens the menu…
    more!.click();
    const menu = h.root.querySelector<HTMLElement>(`[${OVERLAY_MENU_MARKER}]`);
    expect(menu, "expected the re-opened overlay menu to be mounted").not.toBeNull();

    // …and activating Copy must copy the CURRENT (grown) text.
    const copyRow = Array.from(menu!.querySelectorAll<HTMLDivElement>('[role="option"]')).find(
      (row) => (row.textContent ?? "").includes("Copy message"),
    );
    expect(copyRow, "expected a Copy message row").not.toBeNull();
    copyRow!.click();

    expect(writeText).toHaveBeenCalledWith("answer text + streamed tail");
  });
});

describe("message actions — TASK-CHATUX-003 action row visible at rest", () => {
  it("#9 CSS contract: -action has no opacity:0 gate and no hover/focus reveal rule", () => {
    // The reported "no copy button" bug was pure CSS: `opacity: 0` on
    // `-action` hid the row until hover. Pin the always-visible contract.
    const css = readFileSync(
      resolve(process.cwd(), "webview", "aiChat", "styles.css"),
      "utf8",
    );
    const rule = /\.UnicDB-ai-chat-v2-action\s*\{([^}]*)\}/.exec(css);
    expect(rule, "expected the -action rule").not.toBeNull();
    expect(rule![1]!).not.toContain("opacity: 0");
    expect(css).not.toMatch(/\.UnicDB-ai-chat-v2-item:hover\s+\.UnicDB-ai-chat-v2-action/);
    expect(css).not.toMatch(/\.UnicDB-ai-chat-v2-item:focus-within\s+\.UnicDB-ai-chat-v2-action/);
  });
});
