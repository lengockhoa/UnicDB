// src/ui/__tests__/aiChatPanelWebviewTask002.test.ts — TASK-002
// Webview UX: thinking block, copy affordances, Enter/Shift+Enter, scroll
// discipline, message states, Regenerate, Esc-on-resume-picker.

// @vitest-environment jsdom
//
// Approach mirrors aiChatPanelWebview.test.ts: esbuild transpiles
// webview/aiChatPanelMain.ts to plain JS at module-load time, then we evaluate
// it inside a jsdom window with a stubbed acquireVsCodeApi + clipboard. The
// harness is per-test so each test starts with a clean DOM and a fresh
// `latestMessageHandler`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");
const compiled = execFileSync(
  resolve(process.cwd(), "node_modules", ".bin", "esbuild"),
  [
    "--target=es2022",
    "--format=iife",
    "--bundle",
    sourcePath,
  ],
  { encoding: "utf8" },
).toString();

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface ClipboardSpy {
  writeText: ReturnType<typeof vi.fn>;
}

interface Harness {
  received: Array<Record<string, unknown>>;
  dispatch: (msg: Record<string, unknown>) => void;
  root: HTMLDivElement;
  clipboard: ClipboardSpy;
}

// ---- Minimal vitest-like `vi` (the suite uses vitest; import vi below to
// keep this file self-contained without bringing in vitest globals). ----

import { vi } from "vitest";

function makeHarness(opts: {
  clipboard?: "ok" | "reject" | "missing";
} = {}): Harness {
  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg: unknown) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi })
    .acquireVsCodeApi = () => api;

  document.body.innerHTML =
    '<div id="vsdb-root" class="vsdb-form-body"></div>';

  // Stub navigator.clipboard BEFORE the bundle evaluates.
  const clipboardSpy: ClipboardSpy = {
    writeText: vi.fn(async (_t: string) => undefined),
  };
  if (opts.clipboard !== "missing") {
    if (opts.clipboard === "reject") {
      clipboardSpy.writeText = vi.fn(async () => {
        throw new Error("permission denied");
      });
    }
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardSpy.writeText },
    });
  } else {
    // Remove clipboard so the bundle's `navigator.clipboard?.writeText(...)`
    // path is the empty one.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
  }

  const originalAdd = window.addEventListener.bind(window);
  let latestMessageHandler: ((ev: MessageEvent) => void) | null = null;
  (window as unknown as { addEventListener: typeof originalAdd }).addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "message") {
      latestMessageHandler = listener as (ev: MessageEvent) => void;
      return;
    }
    return originalAdd(type, listener, options);
  }) as typeof originalAdd;

  (0, eval)(compiled);

  (window as unknown as { addEventListener: typeof originalAdd }).addEventListener =
    originalAdd;

  const dispatch = (msg: Record<string, unknown>): void => {
    if (latestMessageHandler) {
      latestMessageHandler(new MessageEvent("message", { data: msg }));
      return;
    }
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  };

  return {
    received,
    dispatch,
    root: document.getElementById("vsdb-root") as HTMLDivElement,
    clipboard: clipboardSpy,
  };
}

function inputEl(id: string): HTMLTextAreaElement {
  return document.getElementById(id) as HTMLTextAreaElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}
function btnContaining(
  root: HTMLElement,
  fragment: string,
): HTMLButtonElement | null {
  for (const b of Array.from(root.querySelectorAll("button"))) {
    if (b.textContent?.includes(fragment)) return b;
  }
  return null;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

// ============================================================================
// #1 Thinking block: renders collapsed by default, chunks append
// ============================================================================
describe("AiChatPanelWebview — thinking block (TASK-002 #1)", () => {
  it("renders one collapsed .vsdb-chat-thinking block per turn and appends chunks", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    h.dispatch({ type: "thought", text: "t1" });
    h.dispatch({ type: "thought", text: "t2" });

    const blocks = h.root.querySelectorAll(".vsdb-chat-thinking");
    expect(blocks).toHaveLength(1);

    // Default collapsed: no `open` attribute on the <details>.
    const block = blocks[0] as HTMLDetailsElement;
    expect(block.hasAttribute("open")).toBe(false);

    // The label "Thinking" exists as the summary.
    const summary = block.querySelector("summary");
    expect(summary?.textContent ?? "").toMatch(/Thinking/);

    // Body text is the concatenation of the two chunks (textContent order
    // matches DOM order — both chunks appended to the same body node).
    const body = block.querySelector(".vsdb-chat-thinking-body");
    expect(body?.textContent).toBe("t1t2");
  });

  it("thinking block stays visible after done (finalized, not removed)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "thought", text: "t" });
    h.dispatch({ type: "done" });
    const blocks = h.root.querySelectorAll(".vsdb-chat-thinking");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toContain("t");
  });
});

// ============================================================================
// #2 Thinking state survives append; resets next turn
// ============================================================================
describe("AiChatPanelWebview — thinking block survives toggle, resets on new send (TASK-002 #2)", () => {
  it("toggle open → next thought append still leaves block open", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    h.dispatch({ type: "thought", text: "a" });
    const block = h.root.querySelector(
      ".vsdb-chat-thinking",
    ) as HTMLDetailsElement;
    expect(block).not.toBeNull();
    block.open = true; // user expands
    expect(block.hasAttribute("open")).toBe(true);

    h.dispatch({ type: "thought", text: "b" });
    expect(block.hasAttribute("open")).toBe(true);
    expect(block.querySelector(".vsdb-chat-thinking-body")?.textContent).toBe(
      "ab",
    );
  });

  it("next user send resets thinking block to collapsed + empty", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    h.dispatch({ type: "thought", text: "first" });
    const block = h.root.querySelector(
      ".vsdb-chat-thinking",
    ) as HTMLDetailsElement;
    block.open = true;

    // Send a new prompt — start of next turn.
    const prompt = inputEl("prompt");
    prompt.value = "second";
    btn("sendBtn").click();

    // Old block removed; new (empty) block not created yet (it shows up only
    // when the host posts the first thought of the new turn).
    const blocksAfter = h.root.querySelectorAll(".vsdb-chat-thinking");
    expect(blocksAfter).toHaveLength(0);

    // Host posts a new thought — block re-created in default-collapsed state.
    h.dispatch({ type: "thought", text: "fresh" });
    const blocks = h.root.querySelectorAll(".vsdb-chat-thinking");
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as HTMLDetailsElement).hasAttribute("open")).toBe(false);
    expect(blocks[0]?.querySelector(".vsdb-chat-thinking-body")?.textContent)
      .toBe("fresh");
  });
});

// ============================================================================
// #3 Enter sends; Shift+Enter newlines; plain Enter never inserts newline
// ============================================================================
describe("AiChatPanelWebview — Enter/Shift+Enter keybind (TASK-002 #3)", () => {
  it("plain Enter sends + clears; Enter never inserts a newline", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const prompt = inputEl("prompt");
    prompt.value = "hello";
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    prompt.dispatchEvent(ev);

    const sends = h.received.filter((m) => m.type === "send");
    expect(sends).toHaveLength(1);
    expect(prompt.value).toBe("");

    // CRITICAL: Enter must NEVER insert a newline. defaultPrevented was true,
    // which means no browser-default insertion ran.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Shift+Enter does NOT send and does NOT preventDefault", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const prompt = inputEl("prompt");
    prompt.value = "line1";
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    prompt.dispatchEvent(ev);

    expect(h.received.filter((m) => m.type === "send")).toHaveLength(0);
    // Shift+Enter must fall through so the browser/textarea default inserts
    // the newline (we don't fight the platform's contract).
    expect(ev.defaultPrevented).toBe(false);
  });
});

// ============================================================================
// #4 Code-block copy button copies raw code (no fences)
// ============================================================================
describe("AiChatPanelWebview — fenced-code copy button (TASK-002 #4)", () => {
  it("renders one copy button per fenced block; click copies raw code", async () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({
      type: "assistant",
      text: "Here:\n\n```sql\nSELECT * FROM users;\n```\n",
      markdown: true,
    });

    const copyBtns = h.root.querySelectorAll<HTMLButtonElement>(
      ".vsdb-md-copy",
    );
    expect(copyBtns).toHaveLength(1);

    copyBtns[0]!.click();
    // Allow microtask (writeText is async) to resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(h.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(h.clipboard.writeText.mock.calls[0]![0]).toBe(
      "SELECT * FROM users;",
    );
  });
});

// ============================================================================
// #5 Clipboard rejection degrades silently
// ============================================================================
describe("AiChatPanelWebview — clipboard rejection degrades silently (TASK-002 #5)", () => {
  it("writeText rejects → no unhandled rejection, button label unchanged", async () => {
    const unhandled: Array<unknown> = [];
    const onUnhandled = (ev: PromiseRejectionEvent | unknown): void => {
      unhandled.push(ev);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const h = makeHarness({ clipboard: "reject" });
      h.dispatch({ type: "init", hasHistory: false });
      h.dispatch({
        type: "assistant",
        text: "```sql\nSELECT 1;\n```\n",
        markdown: true,
      });
      const copyBtn = h.root.querySelector<HTMLButtonElement>(".vsdb-md-copy");
      expect(copyBtn).not.toBeNull();
      const originalLabel = copyBtn?.textContent ?? "";

      expect(() => copyBtn!.click()).not.toThrow();
      // Microtasks drain — promise rejection is caught by .catch(()=>{}).
      await new Promise((r) => setTimeout(r, 10));

      expect(copyBtn?.textContent ?? "").toBe(originalLabel);
      // We can't assert unhandledrejection didn't fire (jsdom doesn't fire
      // it for catch'd promises), but the click must not throw and the
      // button must keep its label.
      expect(h.clipboard.writeText).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
      expect(unhandled).toHaveLength(0);
    }
  });
});

// ============================================================================
// #6 Message-level copy on assistant bubble
// ============================================================================
describe("AiChatPanelWebview — assistant message copy action (TASK-002 #6)", () => {
  it("assistant bubble carries a copy button that copies the raw markdown source", async () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    const source = "## Title\n\n```sql\nSELECT 2;\n```\n";
    h.dispatch({ type: "assistant", text: source, markdown: true });

    // The assistant bubble carries a copy action. We tag it with
    // .vsdb-chat-copy-msg to distinguish from per-block copy buttons.
    const copyBtns = h.root.querySelectorAll<HTMLButtonElement>(
      ".vsdb-chat-copy-msg",
    );
    expect(copyBtns).toHaveLength(1);
    copyBtns[0]!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.clipboard.writeText).toHaveBeenCalledTimes(1);
    // Raw source, not the rendered/escaped HTML.
    expect(h.clipboard.writeText.mock.calls[0]![0]).toBe(source);
  });
});

// ============================================================================
// #7 Auto-scroll threshold + jump-to-latest
// ============================================================================
describe("AiChatPanelWebview — scroll discipline + jump-to-latest (TASK-002 #7)", () => {
  it("renders #jumpLatest; click scrolls to bottom and hides", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const jump = document.getElementById("jumpLatest");
    expect(jump).not.toBeNull();

    // Stub scroll metrics on the thread so click → scrollTo is observable.
    const thread = document.getElementById("thread") as HTMLDivElement;
    let scrollTop = 0;
    const scrollHeight = 1000;
    const clientHeight = 400;
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // Pretend the user is detached (200px above the bottom).
    scrollTop = 200;

    // Dispatch a delta so the bundle calls autoScroll.
    h.dispatch({ type: "delta", text: "more" });

    // After detached append, jump button must be visible and the thread
    // must NOT have scrolled to bottom.
    expect((jump as HTMLElement).hidden).toBe(false);
    expect(scrollTop).toBe(200);

    // Click jump → scrolls to bottom, hides.
    (jump as HTMLButtonElement).click();
    expect(scrollTop).toBe(scrollHeight - clientHeight);
    expect((jump as HTMLElement).hidden).toBe(true);
  });

  it("appended delta near bottom (within 40px) scrolls to bottom; no jump button", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const jump = document.getElementById("jumpLatest") as HTMLElement;
    expect(jump).not.toBeNull();
    expect(jump.hidden).toBe(true); // initially hidden

    const thread = document.getElementById("thread") as HTMLDivElement;
    let scrollTop = 0;
    const scrollHeight = 1000;
    const clientHeight = 400;
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(thread, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    // Already at bottom — within 40px threshold.
    scrollTop = scrollHeight - clientHeight;
    h.dispatch({ type: "delta", text: "x" });

    expect(scrollTop).toBe(scrollHeight - clientHeight);
    expect(jump.hidden).toBe(true);
  });
});

// ============================================================================
// #8 Queued placeholder lifecycle
// ============================================================================
describe("AiChatPanelWebview — queued placeholder + error (TASK-002 #8)", () => {
  it("user bubble shows queued marker until first delta; removed on delta", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const prompt = inputEl("prompt");
    prompt.value = "ask";
    btn("sendBtn").click();

    // After send, the user bubble carries a queued marker.
    const userBubbles = h.root.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-user");
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0]?.classList.contains("vsdb-chat-queued")).toBe(true);
    expect(userBubbles[0]?.querySelector(".vsdb-chat-queued")).not.toBeNull();

    // First delta removes the queued state.
    h.dispatch({ type: "delta", text: "hi" });
    expect(userBubbles[0]?.classList.contains("vsdb-chat-queued")).toBe(false);
    expect(userBubbles[0]?.querySelector(".vsdb-chat-queued")).toBeNull();
  });

  it("error after queued → user bubble loses queued marker + honest error bubble rendered", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const prompt = inputEl("prompt");
    prompt.value = "ask";
    btn("sendBtn").click();

    h.dispatch({ type: "error", message: "boom" });

    const userBubble = h.root.querySelector(
      ".vsdb-chat-bubble.vsdb-chat-user",
    ) as HTMLDivElement;
    expect(userBubble.classList.contains("vsdb-chat-queued")).toBe(false);

    const errorBubble = h.root.querySelector(
      ".vsdb-chat-bubble.vsdb-chat-error",
    );
    expect(errorBubble).not.toBeNull();
    expect(errorBubble?.textContent).toContain("boom");
  });
});

// ============================================================================
// #9 Legacy Ctrl/Cmd+Enter keybind removed
// ============================================================================
describe("AiChatPanelWebview — legacy Ctrl/Cmd+Enter keybind removed (TASK-002 #9)", () => {
  it("Ctrl+Enter does NOT post send", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "ctrl-send";
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(h.received.filter((m) => m.type === "send")).toHaveLength(0);
  });

  it("Meta+Enter does NOT post send", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "meta-send";
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(h.received.filter((m) => m.type === "send")).toHaveLength(0);
  });
});

// ============================================================================
// #10 Replay history kind agent_thought_chunk stays dropped
// ============================================================================
describe("AiChatPanelWebview — replay history agent_thought_chunk still dropped (TASK-002 #10)", () => {
  it("history item with kind agent_thought_chunk renders no .vsdb-chat-thinking node", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({
      type: "history",
      items: [
        { kind: "agent_thought_chunk", text: "leaked thought" },
        { kind: "user", text: "real user" },
        { kind: "assistant", text: "real assistant" },
      ],
      truncated: false,
      truncatedCount: 0,
    });

    // Thought must NOT have been rendered into a thinking block (the live
    // thinking source is the `thought` message; replay must stay filtered).
    expect(h.root.querySelectorAll(".vsdb-chat-thinking").length).toBe(0);
    expect(h.root.textContent ?? "").not.toContain("leaked thought");

    // But the other items DID render.
    expect(h.root.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-user").length)
      .toBe(1);
    expect(h.root.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-assistant").length)
      .toBe(1);
  });
});

// ============================================================================
// #11 Regenerate button posts {type:"regenerate"} and is disabled while busy
// ============================================================================
describe("AiChatPanelWebview — Regenerate button (TASK-002 #11)", () => {
  it("renders a Regenerate button that posts {type:'regenerate'}", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const regenBtn = document.getElementById("regenerateBtn") as
      | HTMLButtonElement
      | null;
    expect(regenBtn).not.toBeNull();
    regenBtn?.click();

    const regenPosts = h.received.filter((m) => m.type === "regenerate");
    expect(regenPosts).toHaveLength(1);
  });

  it("Regenerate is disabled while busy (after Send) and re-enabled on done", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const regenBtn = document.getElementById("regenerateBtn") as
      HTMLButtonElement;
    expect(regenBtn.disabled).toBe(false);

    const prompt = inputEl("prompt");
    prompt.value = "hi";
    btn("sendBtn").click();

    expect(regenBtn.disabled).toBe(true);

    h.dispatch({ type: "done" });
    expect(regenBtn.disabled).toBe(false);
  });
});

// ============================================================================
// #12 Esc on resume picker → exactly one resume_cancel + picker removed
// ============================================================================
describe("AiChatPanelWebview — Esc dismisses resume picker (TASK-002 #12)", () => {
  it("Esc keydown while picker open posts exactly one resume_cancel + removes the picker", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    // Open the picker.
    const resumeBtn = btnContaining(h.root, "Resume");
    resumeBtn?.click();
    h.dispatch({
      type: "resume_sessions",
      sessions: [
        { sessionId: "s1", label: "first", detail: "1 messages" },
      ],
    });
    expect(h.root.querySelector(".vsdb-chat-resume-picker")).not.toBeNull();

    // Esc keydown — target the picker element so the listener fires.
    const picker = h.root.querySelector(".vsdb-chat-resume-picker") as
      HTMLDivElement;
    picker.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    const cancels = h.received.filter((m) => m.type === "resume_cancel");
    expect(cancels).toHaveLength(1);
    expect(h.root.querySelector(".vsdb-chat-resume-picker")).toBeNull();
  });
});
