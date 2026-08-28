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
    const resumeBtn = document.getElementById(
      "resumeBtn",
    ) as HTMLButtonElement | null;
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

// ============================================================================
// #13 (cycle AB) — image attach button visible with the right class.
// ============================================================================
describe("AiChatPanelWebview — image attach button (cycle AB TASK-002)", () => {
  it("attachBtn exists in the DOM with class vsdb-chat-attach-btn after renderInitial", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const attachBtn = document.getElementById("attachBtn") as
      | HTMLButtonElement
      | null;
    expect(attachBtn).not.toBeNull();
    expect(attachBtn?.classList.contains("vsdb-chat-attach-btn")).toBe(true);
  });

  it("attachBtn is enabled when init reports visionCapable:true", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });
    const attachBtn = document.getElementById("attachBtn") as
      HTMLButtonElement;
    expect(attachBtn.disabled).toBe(false);
  });
});

// ============================================================================
// #14 (cycle AB) — attach button disabled when visionCapable:false.
// ============================================================================
describe("AiChatPanelWebview — visionCapable:false disables attach (cycle AB TASK-002)", () => {
  it("init{visionCapable:false} → attachBtn.disabled === true", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: false });
    const attachBtn = document.getElementById("attachBtn") as
      HTMLButtonElement;
    expect(attachBtn.disabled).toBe(true);
  });
});

// ============================================================================
// #15 (cycle AB) — caps mirror equality (webview/attachLimits.ts ≡ src/ui/aiChatAttachments.ts).
// Pure value comparison — both files export the same three constants.
// ============================================================================
describe("AiChatPanelWebview — caps mirror equality (cycle AB TASK-002)", () => {
  it("webview/attachLimits.ts values match src/ui/aiChatAttachments.ts", async () => {
    const webviewLimits = await import(
      "../../../webview/attachLimits"
    );
    const hostLimits = await import(
      "../aiChatAttachments"
    );
    expect(webviewLimits.MAX_ATTACH_BYTES).toBe(hostLimits.MAX_ATTACH_BYTES);
    expect(webviewLimits.MAX_ATTACH_BYTES).toBe(5 * 1024 * 1024);
    expect(webviewLimits.MAX_ATTACHMENTS_PER_TURN).toBe(
      hostLimits.MAX_ATTACHMENTS_PER_TURN,
    );
    expect(webviewLimits.MAX_ATTACHMENTS_PER_TURN).toBe(4);
    const webviewMimes = Array.from(webviewLimits.ATTACH_ALLOWED_MIME).sort();
    const hostMimes = Array.from(hostLimits.ATTACH_ALLOWED_MIME).sort();
    expect(webviewMimes).toEqual(hostMimes);
    expect(webviewMimes).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });
});

// ============================================================================
// #16 (cycle AB) — text-only send (no attachments) keeps legacy path. Cycle AA
// regression — the new attach UI must not change the wire shape when the
// strip is empty.
// ============================================================================
describe("AiChatPanelWebview — text-only send unchanged (cycle AB TASK-002)", () => {
  it("send with empty strip posts {type:'send', text} — no attachments field", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    const prompt = inputEl("prompt");
    prompt.value = "hello world";
    btn("sendBtn").click();

    const sends = h.received.filter((m) => m.type === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("hello world");
    // Attachments key absent (or undefined) — legacy cycle-AA path.
    expect((sends[0] as Record<string, unknown>).attachments).toBeUndefined();
  });
});

// ============================================================================
// #17 (cycle AB) — paste event with image clipboard → thumbnail added +
// click send → post carries 1 attachment.
// ============================================================================
describe("AiChatPanelWebview — clipboard paste adds thumbnail + send carries attachment (cycle AB TASK-002)", () => {
  it("paste event with image/* clipboard → strip has 1 thumb, send carries 1 attachment", async () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    // Stub FileReader to immediately resolve with a data URL + bytes.
    const fakeBytes = new Uint8Array([1, 2, 3, 4]);
    const fakeDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    class FakeFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((ev: ProgressEvent) => void) | null = null;
      public onerror: ((ev: ProgressEvent) => void) | null = null;
      readonly _self = "FakeFileReader";
      readAsDataURL(_blob: Blob): void {
        // Fire onload on next tick so listeners attached after .readAsDataURL
        // can still receive the event.
        Promise.resolve().then(() => {
          this.result = fakeDataUrl;
          this.onload?.(new ProgressEvent("load"));
        });
      }
    }
    (globalThis as unknown as { FileReader: typeof FakeFileReader }).FileReader =
      FakeFileReader as unknown as typeof FileReader;

    // Build a fake clipboard item mimicking an image paste.
    const blob = new Blob([fakeBytes], { type: "image/png" });
    const fakeItem = {
      kind: "file",
      type: "image/png",
      getAsFile: () => blob,
    } as unknown as DataTransferItem;
    const clipboardData = {
      items: [fakeItem],
    } as unknown as DataTransfer;

    const prompt = inputEl("prompt");
    const pasteEv = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, "clipboardData", { value: clipboardData });
    prompt.dispatchEvent(pasteEv);

    // Wait a microtask for FileReader onload.
    await Promise.resolve();
    await Promise.resolve();

    // Strip has one thumb.
    const strip = document.querySelector(".vsdb-chat-attachments");
    expect(strip).not.toBeNull();
    const thumbs = strip?.querySelectorAll(".vsdb-chat-thumb") ?? [];
    expect(thumbs.length).toBe(1);

    // Click send — payload must carry one attachment with mime+base64+bytes.
    prompt.value = "describe";
    btn("sendBtn").click();

    const sends = h.received.filter((m) => m.type === "send");
    expect(sends).toHaveLength(1);
    const atts = (sends[0] as { attachments?: unknown }).attachments as
      | Array<{ id: string; mime: string; base64: string; bytes: number }>
      | undefined;
    expect(atts).toBeDefined();
    expect(atts).toHaveLength(1);
    expect(atts?.[0]?.mime).toBe("image/png");
    expect(atts?.[0]?.base64.length).toBeGreaterThan(0);
    expect(typeof atts?.[0]?.bytes).toBe("number");
  });
});

// ============================================================================
// #18 (cycle AB) — send with 2 attachments → post carries attachments[2] with
// correct mime/base64/bytes fields. Exercises the local cap validator
// (≤ MAX_ATTACHMENTS_PER_TURN) and the per-attachment mime preservation.
// ============================================================================
describe("AiChatPanelWebview — send with 2 attachments (cycle AB TASK-002)", () => {
  it("paste two images (png + jpeg) → strip carries 2 thumbs → send carries attachments[2]", async () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    const fakeBytesPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fakeBytesJpg = new Uint8Array([0xff, 0xd8, 0xff]);
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
    const jpgDataUrl =
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wD/2Q==";

    let readIndex = 0;
    const dataUrls = [pngDataUrl, jpgDataUrl];
    const byteLengths = [fakeBytesPng.length, fakeBytesJpg.length];
    class FakeFileReader {
      public result: string | ArrayBuffer | null = null;
      public onload: ((ev: ProgressEvent) => void) | null = null;
      public onerror: ((ev: ProgressEvent) => void) | null = null;
      readAsDataURL(_blob: Blob): void {
        const idx = readIndex++;
        const url = dataUrls[idx] ?? "";
        Promise.resolve().then(() => {
          this.result = url;
          this.onload?.(new ProgressEvent("load"));
        });
      }
    }
    (globalThis as unknown as { FileReader: typeof FakeFileReader }).FileReader =
      FakeFileReader as unknown as typeof FileReader;

    // Build clipboard items: png first, then jpeg.
    const pngBlob = new Blob([fakeBytesPng], { type: "image/png" });
    const jpgBlob = new Blob([fakeBytesJpg], { type: "image/jpeg" });
    const items = [
      {
        kind: "file",
        type: "image/png",
        getAsFile: () => pngBlob,
      },
      {
        kind: "file",
        type: "image/jpeg",
        getAsFile: () => jpgBlob,
      },
    ] as unknown as DataTransferItem[];
    const clipboardData = { items } as unknown as DataTransfer;

    const prompt = inputEl("prompt");
    const pasteEv = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, "clipboardData", { value: clipboardData });
    prompt.dispatchEvent(pasteEv);

    // Wait microtasks for FileReader onload.
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // Strip carries 2 thumbs.
    const strip = document.querySelector(".vsdb-chat-attachments");
    expect(strip).not.toBeNull();
    const thumbs = strip?.querySelectorAll(".vsdb-chat-thumb") ?? [];
    expect(thumbs.length).toBe(2);

    // Click send — payload carries 2 attachments in the same order.
    prompt.value = "two";
    btn("sendBtn").click();

    const sends = h.received.filter((m) => m.type === "send");
    expect(sends).toHaveLength(1);
    const atts = (sends[0] as { attachments?: unknown }).attachments as
      | Array<{ id: string; mime: string; base64: string; bytes: number }>
      | undefined;
    expect(atts).toBeDefined();
    expect(atts).toHaveLength(2);
    expect(atts?.[0]?.mime).toBe("image/png");
    expect(atts?.[0]?.base64.length).toBeGreaterThan(0);
    expect(typeof atts?.[0]?.bytes).toBe("number");
    expect(atts?.[1]?.mime).toBe("image/jpeg");
    expect(atts?.[1]?.base64.length).toBeGreaterThan(0);
    expect(typeof atts?.[1]?.bytes).toBe("number");

    // Bytes field = base64-decoded byte length (host validates via
    // Buffer.byteLength). The webview's `approximateBytesFromBase64`
    // applies the same 4-chars-→-3-bytes rule so the value matches.
    function approxB64Bytes(b64: string): number {
      const len = b64.length;
      if (len === 0) return 0;
      let p = 0;
      if (b64[len - 1] === "=") p = 1;
      if (len > 1 && b64[len - 2] === "=") p = 2;
      return Math.floor((len * 3) / 4) - p;
    }
    expect(atts?.[0]?.bytes).toBe(approxB64Bytes(atts![0]!.base64));
    expect(atts?.[1]?.bytes).toBe(approxB64Bytes(atts![1]!.base64));
    // And those lengths equal what we'd get from the test's data URLs.
    expect(atts?.[0]?.bytes).toBe(approxB64Bytes(
      pngDataUrl.split(",")[1] ?? "",
    ));
    expect(atts?.[1]?.bytes).toBe(approxB64Bytes(
      jpgDataUrl.split(",")[1] ?? "",
    ));
  });
});

// ============================================================================
// #19 (cycle AB) — attach button click opens the hidden file input.
// ============================================================================
describe("AiChatPanelWebview — attach button click opens file input (cycle AB TASK-002)", () => {
  it("clicking attachBtn programmatically invokes .click() on the file input", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    const fileInput = document.getElementById("attachFileInput") as
      | HTMLInputElement
      | null;
    expect(fileInput).not.toBeNull();
    expect(fileInput?.type).toBe("file");
    expect(fileInput?.accept).toBe("image/*");
    expect(fileInput?.multiple).toBe(true);
    expect(fileInput?.hidden).toBe(true);

    // Spy on .click() — jsdom normally throws because the input is hidden +
    // not in the document; we patch .click to a no-op spy for this assertion.
    let clickCount = 0;
    fileInput!.click = () => {
      clickCount++;
    };
    btn("attachBtn").click();
    expect(clickCount).toBe(1);
  });
});

// ============================================================================
// #20 (cycle AB) — host posts attach_error → warning bubble rendered.
// ============================================================================
describe("AiChatPanelWebview — attach_error renders warning bubble (cycle AB TASK-002)", () => {
  it("host posts {type:'attach_error', id, reason, message} → .vsdb-chat-attach-warning bubble with the message text", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    h.dispatch({
      type: "attach_error",
      id: "att-1",
      reason: "oversize",
      message: "File too big (6 MB > 5 MB cap)",
    });

    const warnings = h.root.querySelectorAll(".vsdb-chat-attach-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.textContent).toContain("File too big");
  });
});
