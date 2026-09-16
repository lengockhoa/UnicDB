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

interface UnicDBApi {
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
  const api: UnicDBApi = {
    postMessage: (msg: unknown) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi })
    .acquireVsCodeApi = () => api;

  document.body.innerHTML =
    '<div id="UnicDB-root" class="UnicDB-form-body"></div>';

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
    root: document.getElementById("UnicDB-root") as HTMLDivElement,
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
  it("renders one collapsed .UnicDB-chat-thinking block per turn and appends chunks", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    h.dispatch({ type: "thought", text: "t1" });
    h.dispatch({ type: "thought", text: "t2" });

    const blocks = h.root.querySelectorAll(".UnicDB-chat-thinking");
    expect(blocks).toHaveLength(1);

    // Default collapsed: no `open` attribute on the <details>.
    const block = blocks[0] as HTMLDetailsElement;
    expect(block.hasAttribute("open")).toBe(false);

    // The label "Thinking" exists as the summary.
    const summary = block.querySelector("summary");
    expect(summary?.textContent ?? "").toMatch(/Thinking/);

    // Body text is the concatenation of the two chunks (textContent order
    // matches DOM order — both chunks appended to the same body node).
    const body = block.querySelector(".UnicDB-chat-thinking-body");
    expect(body?.textContent).toBe("t1t2");
  });

  it("thinking block stays visible after done (finalized, not removed)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "thought", text: "t" });
    h.dispatch({ type: "done" });
    const blocks = h.root.querySelectorAll(".UnicDB-chat-thinking");
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
      ".UnicDB-chat-thinking",
    ) as HTMLDetailsElement;
    expect(block).not.toBeNull();
    block.open = true; // user expands
    expect(block.hasAttribute("open")).toBe(true);

    h.dispatch({ type: "thought", text: "b" });
    expect(block.hasAttribute("open")).toBe(true);
    expect(block.querySelector(".UnicDB-chat-thinking-body")?.textContent).toBe(
      "ab",
    );
  });

  ;
});

// ============================================================================
// #3 Enter sends; Shift+Enter newlines; plain Enter never inserts newline
// ============================================================================
describe("AiChatPanelWebview — single composer keyboard owner (TASK-CHATV2-009)", () => {
  // TASK-CHATV2-009 moved the Enter=send keyboard path OFF the archived V1
  // `#prompt` and onto the V2 controller's single capture-phase handler on
  // `#promptV2`. The legacy `#prompt` retains its input/keyup handlers (slash +
  // mention) but installs NO submit keyboard path.

  ;

  it("the V2 promptV2 is the single transport-bearing composer input", () => {
    makeHarness();
    const v2 = inputEl("promptV2");
    expect(v2).not.toBeNull();
    expect(v2.id).toBe("promptV2");
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
      ".UnicDB-md-copy",
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
      const copyBtn = h.root.querySelector<HTMLButtonElement>(".UnicDB-md-copy");
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
    // .UnicDB-chat-copy-msg to distinguish from per-block copy buttons.
    const copyBtns = h.root.querySelectorAll<HTMLButtonElement>(
      ".UnicDB-chat-copy-msg",
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
;

// ============================================================================
// #9 Legacy Ctrl/Cmd+Enter keybind removed
// ============================================================================
;

// ============================================================================
// #10 Replay history kind agent_thought_chunk stays dropped
// ============================================================================
describe("AiChatPanelWebview — replay history agent_thought_chunk still dropped (TASK-002 #10)", () => {
  it("history item with kind agent_thought_chunk renders no .UnicDB-chat-thinking node", () => {
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
    expect(h.root.querySelectorAll(".UnicDB-chat-thinking").length).toBe(0);
    expect(h.root.textContent ?? "").not.toContain("leaked thought");

    // But the other items DID render.
    expect(h.root.querySelectorAll(".UnicDB-chat-bubble.UnicDB-chat-user").length)
      .toBe(1);
    expect(h.root.querySelectorAll(".UnicDB-chat-bubble.UnicDB-chat-assistant").length)
      .toBe(1);
  });
});

// ============================================================================
// #11 Regenerate button posts {type:"regenerate"} and is disabled while busy
// ============================================================================
;

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
    expect(h.root.querySelector(".UnicDB-chat-resume-picker")).not.toBeNull();

    // Esc keydown — target the picker element so the listener fires.
    const picker = h.root.querySelector(".UnicDB-chat-resume-picker") as
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
    expect(h.root.querySelector(".UnicDB-chat-resume-picker")).toBeNull();
  });
});

// ============================================================================
// #13 (cycle AB) — image attach button visible with the right class.
// ============================================================================
;

// ============================================================================
// #14 (cycle AB) — attach button disabled when visionCapable:false.
// ============================================================================
;

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
;

// ============================================================================
// #17 (cycle AB) — paste event with image clipboard → thumbnail added +
// click send → post carries 1 attachment.
// ============================================================================
;

// ============================================================================
// #18 (cycle AB) — send with 2 attachments → post carries attachments[2] with
// correct mime/base64/bytes fields. Exercises the local cap validator
// (≤ MAX_ATTACHMENTS_PER_TURN) and the per-attachment mime preservation.
// ============================================================================
;

// ============================================================================
// #19 (cycle AB) — attach button click opens the hidden file input.
// ============================================================================
;

// ============================================================================
// #20 (cycle AB) — host posts attach_error → warning bubble rendered.
// ============================================================================
describe("AiChatPanelWebview — attach_error renders warning bubble (cycle AB TASK-002)", () => {
  it("host posts {type:'attach_error', id, reason, message} → .UnicDB-chat-attach-warning bubble with the message text", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false, visionCapable: true });

    h.dispatch({
      type: "attach_error",
      id: "att-1",
      reason: "oversize",
      message: "File too big (6 MB > 5 MB cap)",
    });

    const warnings = h.root.querySelectorAll(".UnicDB-chat-attach-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.textContent).toContain("File too big");
  });
});
