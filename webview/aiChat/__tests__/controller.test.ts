// webview/aiChat/__tests__/controller.test.ts — TASK-CHATV2-009
//
// Covers the behavioral half of the single keyboard/transport owner: one
// capture-phase keydown, message ownership, submit/stop dedupe, host-ack draft
// lifecycle, autocomplete interop and disposal.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeMessageListenerCount,
  createChatController,
  type ChatController,
  type TimerHandle,
  type VsCodeApiLike,
} from "../controller";
import { AI_CHAT_PROTOCOL_VERSION_V2 } from "../../../src/ui/aiChatPanelMessages";

interface Harness {
  root: HTMLElement;
  sent: Array<Record<string, unknown>>;
  api: VsCodeApiLike;
  controller: ChatController;
  composer: ChatController["composer"];
  prompt: HTMLTextAreaElement;
}

let controllers: ChatController[] = [];

function makeHarness(): Harness {
  const root = document.createElement("div");
  root.id = "UnicDB-root";
  document.body.appendChild(root);

  const sent: Array<Record<string, unknown>> = [];
  const api: VsCodeApiLike = { postMessage: (m) => sent.push(m as Record<string, unknown>) };

  let n = 0;
  const controller = createChatController({
    root,
    vscode: api,
    nextId: () => {
      n += 1;
      return `req-${n}`;
    },
    schedule: (fn) => fn(), // render synchronously for assertions
  });
  controllers.push(controller);

  return { root, sent, api, controller, composer: controller.composer, prompt: controller.prompt };
}

/** Simulate a real user edit: set the value then fire the input event. */
function type(prompt: HTMLTextAreaElement, value: string, caret = value.length): void {
  prompt.value = value;
  prompt.setSelectionRange(caret, caret);
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(
  prompt: HTMLTextAreaElement,
  key: string,
  mods: Partial<KeyboardEventInit> = {},
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  } as KeyboardEventInit);
  prompt.dispatchEvent(ev);
  return ev;
}

function v2Frame(body: Record<string, unknown>, sequence: number, sessionId = "s1"): MessageEvent {
  return new MessageEvent("message", {
    data: { protocolVersion: AI_CHAT_PROTOCOL_VERSION_V2, sessionId, sequence, ...body },
  });
}

function sentOf(h: Harness, kind: string): Array<Record<string, unknown>> {
  return h.sent.filter((m) => m.kind === kind);
}

afterEach(() => {
  for (const c of controllers) c.dispose();
  controllers = [];
  document.body.replaceChildren();
});

beforeEach(() => {
  controllers = [];
});

describe("controller — single keyboard + message owner", () => {
  it("installs exactly one capture-phase keydown on promptV2", () => {
    const h = makeHarness();
    expect(h.prompt.id).toBe("promptV2");
    expect(h.prompt.getAttribute("data-chat-keydown-owner")).toBe("1");
  });

  it("createChatController is idempotent per root (no duplicate listener)", () => {
    const h = makeHarness();
    const before = activeMessageListenerCount();
    const again = createChatController({ root: h.root, vscode: h.api });
    controllers.push(again);
    expect(again).toBe(h.controller);
    expect(activeMessageListenerCount()).toBe(before);
  });

  it("owns window.message: a V2 frame updates state, a non-V2 frame is ignored", () => {
    const h = makeHarness();
    window.dispatchEvent(v2Frame({ kind: "models", active: "default", roles: [] }, 1));
    expect(h.controller.getState().models).not.toBeNull();

    const seqBefore = h.controller.getState().lastSequence;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "done" } }));
    expect(h.controller.getState().lastSequence).toBe(seqBefore);
  });
});

describe("controller — submit dedupe and ack lifecycle", () => {
  it("plain Enter on a valid idle draft emits exactly one submit_turn", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    const ev = press(h.prompt, "Enter");

    const submits = sentOf(h, "submit_turn");
    expect(submits).toHaveLength(1);
    expect((submits[0] as { clientRequestId: string }).clientRequestId).toBe("req-1");
    expect((submits[0] as { draft: { text: string } }).draft.text).toBe("hello");
    expect(ev.defaultPrevented).toBe(true);
    expect(h.controller.getState().phase).toBe("validating");
  });

  it("rapid Enter + pointer click emits exactly one submit_turn (one clientRequestId)", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    h.controller.flushRender();
    expect(h.composer.primaryButton.disabled).toBe(false);

    press(h.prompt, "Enter");
    h.composer.primaryButton.click();

    const submits = sentOf(h, "submit_turn");
    expect(submits).toHaveLength(1);
    expect(new Set(submits.map((s) => (s as { clientRequestId: string }).clientRequestId)).size).toBe(1);
  });

  it("empty draft Enter sends nothing", () => {
    const h = makeHarness();
    type(h.prompt, "   ");
    press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
  });

  it("busy phases refuse submit but keep the draft editable", () => {
    const h = makeHarness();
    type(h.prompt, "one");
    press(h.prompt, "Enter"); // → validating
    expect(h.controller.getState().phase).toBe("validating");

    type(h.prompt, "two");
    press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(1); // no second submit
    // Draft stays editable while busy — the next draft the user typed is kept.
    expect(h.controller.getState().draft.text).toBe("two");
    expect(h.composer.prompt.disabled).toBe(false);
  });

  it("draft clears ONLY on the matching turn_started ack", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    press(h.prompt, "Enter");

    // Wrong id: preserved.
    window.dispatchEvent(v2Frame({ kind: "turn_started", turnId: "t1", clientRequestId: "nope" }, 1));
    expect(h.controller.getState().draft.text).toBe("hello");

    // Matching id: cleared.
    window.dispatchEvent(v2Frame({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }, 2));
    h.controller.flushRender();
    expect(h.controller.getState().draft.text).toBe("");
    expect(h.prompt.value).toBe("");
  });

  it("rejection (error frame) preserves the draft and allows a retry", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(1);

    window.dispatchEvent(
      v2Frame({ kind: "error", safeMessage: "engine down", diagnosticId: "d1" }, 1),
    );
    expect(h.controller.getState().draft.text).toBe("hello");
    expect(h.prompt.value).toBe("hello");
    expect(h.controller.getState().phase).toBe("failed");

    // Lock released → a retry submits again.
    press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(2);
  });
});

describe("controller — stop dedupe", () => {
  it("emits one stop_turn per active turn and holds a 250ms primary lock", () => {
    const timers: Array<{ fn: () => void; ms: number; handle: TimerHandle }> = [];
    const cleared: TimerHandle[] = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sent: Array<Record<string, unknown>> = [];
    const controller = createChatController({
      root,
      vscode: { postMessage: (m) => sent.push(m as Record<string, unknown>) },
      schedule: (fn) => fn(),
      setTimer: (fn, ms) => {
        const handle = { fn, ms } as unknown as TimerHandle;
        timers.push({ fn, ms, handle });
        return handle;
      },
      clearTimer: (h) => cleared.push(h),
    });
    controllers.push(controller);
    const prompt = controller.prompt;

    type(prompt, "hello");
    press(prompt, "Enter");
    window.dispatchEvent(v2Frame({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }, 1));

    controller.requestSubmit(); // busy → stop
    controller.requestSubmit(); // duplicate → no-op

    const stops = sent.filter((m) => m.kind === "stop_turn");
    expect(stops).toHaveLength(1);
    expect(sent.filter((m) => m.kind === "submit_turn")).toHaveLength(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(250);

    // Terminal event releases the timer.
    window.dispatchEvent(v2Frame({ kind: "turn_finished", turnId: "t1", outcome: "stopped" }, 2));
    expect(cleared).toHaveLength(1);
  });
});

describe("controller — keyboard precedence in the real DOM", () => {
  it("Shift+Enter inserts exactly one newline and never sends", () => {
    const h = makeHarness();
    type(h.prompt, "ab", 1);
    const ev = press(h.prompt, "Enter", { shiftKey: true });

    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(h.prompt.value).toBe("a\nb");
    expect(ev.defaultPrevented).toBe(true);
    expect(h.controller.getState().draft.revision).toBeGreaterThan(1);
  });

  it("Ctrl/Cmd+Enter prevents the chat submit and leaves the text unchanged", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    const ev = press(h.prompt, "Enter", { ctrlKey: true });
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(h.prompt.value).toBe("hello");
    expect(ev.defaultPrevented).toBe(true);

    const ev2 = press(h.prompt, "Enter", { metaKey: true });
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(ev2.defaultPrevented).toBe(true);
  });

  it("IME composition Enter sends nothing and is not prevented", () => {
    const h = makeHarness();
    type(h.prompt, "日本");
    h.prompt.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const ev = press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);

    h.prompt.dispatchEvent(new Event("compositionend", { bubbles: true }));
    press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(1);
  });

  it("autocomplete Enter accepts a row and never submits", () => {
    const h = makeHarness();
    type(h.prompt, "@pu");
    h.controller.requestAutocomplete("mention", "pu");

    const revision = h.controller.getState().autocomplete.draftRevision;
    const requestId = h.controller.getState().autocomplete.requestId;
    expect(requestId).toBe("req-1");
    window.dispatchEvent(
      v2Frame(
        {
          kind: "mention_results",
          requestId,
          draftRevision: revision,
          query: "pu",
          items: [{ kind: "table", label: "public.users", detail: "", token: "@public.users" }],
        },
        1,
      ),
    );
    expect(h.controller.getState().autocomplete.items).toHaveLength(1);

    const ev = press(h.prompt, "Enter");
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(h.prompt.value).toContain("@public.users");
    expect(h.controller.getState().autocomplete.open).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Shift+Enter wins over an open autocomplete popover", () => {
    const h = makeHarness();
    type(h.prompt, "@pu");
    h.controller.requestAutocomplete("mention", "pu");
    press(h.prompt, "ArrowDown"); // still open, no items → native

    const ev = press(h.prompt, "Enter", { shiftKey: true });
    expect(sentOf(h, "submit_turn")).toHaveLength(0);
    expect(h.prompt.value).toContain("\n");
    expect(ev.defaultPrevented).toBe(true);
    expect(h.controller.getState().autocomplete.open).toBe(false);
  });

  it("Escape closes one transient surface without clearing the draft", () => {
    const h = makeHarness();
    type(h.prompt, "@pu");
    h.controller.requestAutocomplete("mention", "pu");
    const ev = press(h.prompt, "Escape");
    expect(h.controller.getState().autocomplete.open).toBe(false);
    expect(h.prompt.value).toBe("@pu");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a focused permission sheet delegates the key", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sent: Array<Record<string, unknown>> = [];
    const controller = createChatController({
      root,
      vscode: { postMessage: (m) => sent.push(m as Record<string, unknown>) },
      schedule: (fn) => fn(),
      isPermissionFocused: () => true,
    });
    controllers.push(controller);
    type(controller.prompt, "hello");
    const ev = press(controller.prompt, "Enter");
    expect(sent.filter((m) => m.kind === "submit_turn")).toHaveLength(0);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("controller — TASK-CHATV2-014 permission request lifecycle", () => {
  function requestSheet(h: Harness): HTMLElement | null {
    return h.root.querySelector<HTMLElement>("[data-chat-permission-request]");
  }

  it("a host permission_requested mounts the anchored sheet; one Deny emits one opaque response and closes it", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    press(h.prompt, "Enter");
    window.dispatchEvent(v2Frame({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }, 1));
    window.dispatchEvent(
      v2Frame(
        {
          kind: "permission_requested",
          turnId: "t1",
          requestId: "perm-1",
          tool: { id: "tool-1", name: "Run SQL", detail: "delete from t" },
          options: [{ optionId: "allow-once", label: "Allow once" }],
        },
        2,
      ),
    );

    const sheet = requestSheet(h);
    expect(sheet).not.toBeNull();
    expect(sheet!.hidden).toBe(false);

    sheet!.querySelector<HTMLButtonElement>('[data-action="deny"]')!.click();

    // Deny carries the requestId and NO optionId — never a fabricated allow.
    const responses = sentOf(h, "permission_response");
    expect(responses).toHaveLength(1);
    expect(responses[0]!.requestId).toBe("perm-1");
    expect("optionId" in responses[0]!).toBe(false);
    expect(sheet!.hidden).toBe(true);
    expect(h.controller.getState().pendingHostRequests).toHaveLength(0);
  });

  it("case #7: a stopped turn settles the pending request — the sheet does not stay open", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    press(h.prompt, "Enter");
    window.dispatchEvent(v2Frame({ kind: "turn_started", turnId: "t1", clientRequestId: "req-1" }, 1));
    window.dispatchEvent(
      v2Frame(
        {
          kind: "permission_requested",
          turnId: "t1",
          requestId: "perm-1",
          tool: { id: "tool-1", name: "Run SQL", detail: "delete from t" },
          options: [{ optionId: "allow-once", label: "Allow once" }],
        },
        2,
      ),
    );
    expect(requestSheet(h)!.hidden).toBe(false);

    h.controller.requestSubmit(); // busy → stop
    window.dispatchEvent(v2Frame({ kind: "turn_finished", turnId: "t1", outcome: "stopped" }, 3));
    h.controller.flushRender();

    // The terminal turn must not leave a live sheet asking about a dead turn.
    expect(h.controller.getState().pendingHostRequests).toHaveLength(0);
    expect(requestSheet(h)!.hidden).toBe(true);
    expect(h.controller.getState().phase).not.toBe("awaiting_permission");
  });
});

describe("controller — disposal", () => {
  it("dispose removes the message listener, timers and is idempotent", () => {
    const h = makeHarness();
    const withController = activeMessageListenerCount();
    h.controller.dispose();
    h.controller.dispose(); // idempotent
    expect(activeMessageListenerCount()).toBe(withController - 1);

    const seqBefore = h.controller.getState().lastSequence;
    window.dispatchEvent(v2Frame({ kind: "models", active: "x", roles: [] }, 5));
    expect(h.controller.getState().lastSequence).toBe(seqBefore);
  });

  it("remount after dispose installs exactly one new listener", () => {
    const h = makeHarness();
    const baseline = activeMessageListenerCount();
    h.controller.dispose();
    expect(activeMessageListenerCount()).toBe(baseline - 1);

    const fresh = createChatController({ root: h.root, vscode: h.api, schedule: (fn) => fn() });
    controllers.push(fresh);
    expect(activeMessageListenerCount()).toBe(baseline);
    expect(fresh).not.toBe(h.controller);

    fresh.announceReady();
    expect(h.sent.filter((m) => m.kind === "ready_v2")).toHaveLength(1);
  });
});

describe("controller — transport shape", () => {
  it("every outbound intent carries protocolVersion 2", () => {
    const h = makeHarness();
    type(h.prompt, "hello");
    press(h.prompt, "Enter");
    for (const m of h.sent) {
      expect(m.protocolVersion).toBe(AI_CHAT_PROTOCOL_VERSION_V2);
    }
  });

  it("does not acquire the VS Code API when one is injected", () => {
    const spy = vi.fn(() => ({ postMessage: () => undefined }));
    (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = spy;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const c = createChatController({ root, vscode: { postMessage: () => undefined } });
    controllers.push(c);
    expect(spy).not.toHaveBeenCalled();
    delete (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  });
});
