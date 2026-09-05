// src/ui/__tests__/aiChatPanelBundle.test.ts — TASK-003 bundle test.
//
// Loads dist/aiChatPanel.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi, then asserts: ready posted, init renders input + Send /
// Stop / Clear buttons, sending non-empty text posts {type:"send",text}, Stop
// posts {type:"stop"}, Clear posts {type:"clear"}, and no apiKey ever
// appears in any outbound postMessage payload.
//
// IMPORTANT: must run after `npm run compile` so dist/aiChatPanel.js exists.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  // No AG Grid side-effects; nothing to stub.
});

const distPath = resolve(process.cwd(), "dist", "aiChatPanel.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

/** @internal accumulated message listeners from each bundle eval —
 * loadBundle() pops all previous ones so deltas / inits from a later test
 * aren't processed by stale bundles. The bundle's IIFE registers
 * `window.addEventListener("message", ...)` at the bottom; without this
 * teardown, test #3's delta would be handled 3 times (once per
 * accumulated eval), leaking prior-test DOM into the current test. */
const bundleListeners: Array<{
  type: string;
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
}> = [];

/** Wrap window.addEventListener so we can later remove every listener
 * that a bundle eval registered. We can't use removeEventListener with
 * an empty handler — it needs the same function reference. */
const _origAddEventListener = window.addEventListener.bind(window);
window.addEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  const evtListener =
    typeof listener === "function"
      ? (listener as EventListener)
      : (listener as EventListenerObject).handleEvent.bind(listener);
  bundleListeners.push({ type, listener: evtListener, options });
  return _origAddEventListener(type, listener, options);
} as typeof window.addEventListener;

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/aiChatPanel.js missing — run `npm run compile` before this test",
    );
  }
  // TASK-UX1-009 (R11): tear down every prior bundle's listener before
  // re-evaluating the bundle. The bundle registers
  // `window.addEventListener("message", ...)` at the bottom of its IIFE;
  // without this cleanup, test #3's delta gets appended 3 times (once per
  // accumulated eval) — which leaks prior-test state into the current
  // test's DOM and breaks the R11 fixture assertions.
  for (const { type, listener, options } of bundleListeners) {
    window.removeEventListener(type, listener, options);
  }
  bundleListeners.length = 0;
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-form-body"></div>';

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);
  return { received };
}

function dispatch(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

describeIfBundle("webview/aiChatPanelMain.ts bundle (TASK-003)", () => {
  itIfBundle("#1 bundle exists after compile", () => {
    expect(bundleSrc).not.toBeNull();
    expect(bundleSrc!.length).toBeGreaterThan(0);
  });

  itIfBundle("#2 init renders input + Send/Stop/Clear buttons + posts ready", () => {
    const { received } = loadBundle();
    expect(received.some((m) => m.type === "ready")).toBe(true);
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    for (const id of ["prompt", "sendBtn", "stopBtn", "clearBtn"]) {
      expect(root.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  itIfBundle("#3 type text + click Send → posts {type:'send', text}", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    inputEl("prompt").value = "show me users";
    btn("sendBtn").click();
    const sends = received.filter((m) => m.type === "send");
    expect(sends.length).toBe(1);
    const msg = sends[0] as { text: string };
    expect(msg.text).toBe("show me users");
  });

  itIfBundle("#4 empty prompt → Send does NOT post", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    inputEl("prompt").value = "   ";
    btn("sendBtn").click();
    const sends = received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });

  itIfBundle("#5 Stop button → posts {type:'stop'}", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    btn("stopBtn").click();
    const stops = received.filter((m) => m.type === "stop");
    expect(stops.length).toBe(1);
  });

  itIfBundle("#6 Clear button → posts {type:'clear'}", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    btn("clearBtn").click();
    const clears = received.filter((m) => m.type === "clear");
    expect(clears.length).toBe(1);
  });

  itIfBundle("#7 no apiKey material anywhere in outbound messages", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    inputEl("prompt").value = "secret";
    btn("sendBtn").click();
    btn("stopBtn").click();
    btn("clearBtn").click();
    const allText = JSON.stringify(received);
    expect(allText).not.toMatch(/sk-/i);
    expect(allText).not.toMatch(/api_?key/i);
  });

  itIfBundle("#8 assistant messages render (markdown allowed)", () => {
    loadBundle();
    dispatch({ type: "init", hasHistory: false });
    dispatch({
      type: "assistant",
      text: "## Hello\n\nWorld",
      markdown: true,
    });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    const html = root.innerHTML;
    expect(html).toMatch(/Hello/);
    expect(html).toMatch(/<h2/);
  });
});
describeIfBundle("webview/aiChatPanelMain.ts bundle (TASK-004 Resume)", () => {
  itIfBundle("#9 Resume button exists in initial render and is enabled", () => {
    const { received: _r } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    const resumeBtn = document.getElementById(
      "resumeBtn",
    ) as HTMLButtonElement | null;
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn?.disabled).toBe(false);
  });

  itIfBundle("#10 click Resume → posts exactly one resume_list", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    const resumeBtn = document.getElementById(
      "resumeBtn",
    ) as HTMLButtonElement | null;
    expect(resumeBtn).not.toBeNull();
    resumeBtn?.click();
    const listPosts = received.filter((m) => m.type === "resume_list");
    expect(listPosts).toHaveLength(1);
  });

  itIfBundle("#11 no apiKey material across resume picker exchanges", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("UnicDB-root") as HTMLDivElement;
    const resumeBtn = document.getElementById(
      "resumeBtn",
    ) as HTMLButtonElement | null;
    resumeBtn?.click();
    dispatch({
      type: "resume_sessions",
      sessions: [
        { sessionId: "sess-A", label: "first", detail: "1 messages" },
        { sessionId: "sess-B", label: "second", detail: "2 messages" },
      ],
    });
    const rows = root.querySelectorAll<HTMLDivElement>(".UnicDB-chat-resume-row");
    rows[0]?.click();
    const allText = JSON.stringify(received);
    expect(allText).not.toMatch(/sk-/i);
    expect(allText).not.toMatch(/api_?key/i);
  });
});


// ============================================================================
// TASK-AG-001 — icon-only composer toolbar (inline SVG + hover tooltips)
// ============================================================================

/** The six composer action buttons, in DOM order. */
const COMPOSER_BUTTON_IDS = [
  "resumeBtn",
  "clearBtn",
  "regenerateBtn",
  "stopBtn",
  "attachBtn",
  "sendBtn",
] as const;

describeIfBundle(
  "webview/aiChatPanelMain.ts bundle (TASK-AG-001 icon-only composer)",
  () => {
    itIfBundle(
      "#AG1 each composer button renders exactly one inline SVG icon",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        for (const id of COMPOSER_BUTTON_IDS) {
          const b = btn(id);
          expect(
            b,
            `#${id} must exist in the composer actions row`,
          ).not.toBeNull();
          const svgs = b.querySelectorAll("svg");
          expect(svgs.length, `#${id} must contain exactly one <svg>`).toBe(1);
          expect(
            svgs[0]?.getAttribute("aria-hidden"),
            `#${id} svg must be aria-hidden`,
          ).toBe("true");
        }
      },
    );

    itIfBundle("#AG2 composer actions row carries zero visible text labels", () => {
      loadBundle();
      dispatch({ type: "init", hasHistory: false });
      for (const id of COMPOSER_BUTTON_IDS) {
        const b = btn(id);
        expect(
          (b.textContent ?? "").trim(),
          `#${id} must be icon-only (no visible text)`,
        ).toBe("");
      }
    });

    itIfBundle(
      "#AG3 every composer button has a non-empty title synced with aria-label",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        for (const id of COMPOSER_BUTTON_IDS) {
          const b = btn(id);
          const title = b.getAttribute("title") ?? "";
          const aria = b.getAttribute("aria-label") ?? "";
          expect(title, `#${id} must carry a hover tooltip`).not.toBe("");
          expect(aria, `#${id} must carry an accessible name`).not.toBe("");
          expect(
            title === aria,
            `#${id} title and aria-label must match ("${title}" vs "${aria}")`,
          ).toBe(true);
        }
      },
    );

    itIfBundle(
      "#AG7 composer click handlers still post send/stop/clear/regenerate/resume_list",
      () => {
        const { received } = loadBundle();
        dispatch({ type: "init", hasHistory: false });
        inputEl("prompt").value = "go";
        btn("sendBtn").click();
        btn("stopBtn").click();
        btn("clearBtn").click();
        // Clear's host reply (init{hasHistory:false}) un-busies the panel;
        // emulate it so the busy guards on regenerate/resume handlers let
        // their posts through (both guard on state.busy by design).
        dispatch({ type: "init", hasHistory: false });
        btn("regenerateBtn").click();
        btn("resumeBtn").click();
        const types = received.map((m) => m.type);
        expect(types).toContain("send");
        expect(types).toContain("stop");
        expect(types).toContain("clear");
        expect(types).toContain("regenerate");
        expect(types).toContain("resume_list");
      },
    );

    itIfBundle(
      "#AG8 resume flow keeps working via #resumeBtn (selector migration)",
      () => {
        const { received } = loadBundle();
        dispatch({ type: "init", hasHistory: false });
        btn("resumeBtn").click();
        const listPosts = received.filter((m) => m.type === "resume_list");
        expect(listPosts).toHaveLength(1);
      },
    );

    itIfBundle("#AG9 .UnicDB-btn svg sizing rule stays intact in styles.css", () => {
      const cssPath = resolve(process.cwd(), "webview", "styles.css");
      const css = readFileSync(cssPath, "utf8");
      expect(/\.UnicDB-btn svg\s*\{[^}]*pointer-events:\s*none/.test(css)).toBe(
        true,
      );
    });
  },
);

describeIfBundle("webview/aiChatPanelMain.ts bundle (slash commands)", () => {
  itIfBundle("typing slash opens a local command picker", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "/";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".UnicDB-chat-slash-dropdown")).not.toBeNull();
    expect(received.filter((m) => m.type === "send")).toHaveLength(0);
  });

  itIfBundle("Enter on /resume reuses resume picker and never sends", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "/resume";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(received.filter((m) => m.type === "resume_list")).toEqual([
      { type: "resume_list" },
    ]);
    expect(received.filter((m) => m.type === "send")).toHaveLength(0);
  });

  itIfBundle("Enter on incomplete slash input selects a candidate, never sends", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "/";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(prompt.value).toBe("/clear ");
    expect(received.filter((m) => m.type === "send")).toHaveLength(0);
  });

  itIfBundle("ordinary text containing slash still uses normal send", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const prompt = inputEl("prompt");
    prompt.value = "explain /model in this query";
    btn("sendBtn").click();
    expect(received.filter((m) => m.type === "send")).toHaveLength(1);
    expect(received.filter((m) => m.type === "command")).toHaveLength(0);
  });
});

// ============================================================================
// TASK-UX1-009 — R11 chat improvements: thinking row + streamed code blocks
// + right-edge text truncation. Cases 1–7 (case 8 lives in chatLayoutCss.test.ts).
// ============================================================================

describeIfBundle(
  "webview/aiChatPanelMain.ts bundle (TASK-UX1-009 R11: thinking row + code blocks + truncation)",
  () => {
    /** Cast helpers for the bundle DOM assertions. */
    function rootEl(): HTMLDivElement {
      return document.getElementById("UnicDB-root") as HTMLDivElement;
    }

    /** Send a prompt through the composer and wait one microtask for the
      * synchronous DOM mutations to flush (loadBundle runs synchronously,
      * so `Send` click is already reflected before we resolve). */
    function sendViaComposer(text: string): void {
      const prompt = inputEl("prompt");
      prompt.value = text;
      btn("sendBtn").click();
    }

    itIfBundle(
      "#1 send shows thinking row; first delta removes it",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("show me users");
        const root = rootEl();
        // After send: queued user bubble visible AND a separate thinking row
        // lives BELOW it (not as an overlay on the bubble text). The row
        // carries the assistant-side "AI is thinking…" label.
        const thinkingRows = root.querySelectorAll<HTMLElement>(
          ".UnicDB-chat-thinking-row",
        );
        expect(
          thinkingRows.length,
          "send must append exactly one .UnicDB-chat-thinking-row",
        ).toBe(1);
        expect(
          (thinkingRows[0]?.textContent ?? "").trim(),
          "thinking row must carry 'AI is thinking…' (R11 spec)",
        ).toBe("AI is thinking…");
        // The thinking row lives BELOW the user bubble (appendChild order).
        const queuedUser = root.querySelector(
          ".UnicDB-chat-bubble.UnicDB-chat-user.UnicDB-chat-queued",
        );
        expect(queuedUser).not.toBeNull();
        // Position assertion: queuedUser is BEFORE the thinking row in DOM
        // order (so the row is below — user sees thinking as a separate row).
        if (queuedUser) {
          const comparison = queuedUser.compareDocumentPosition(
            thinkingRows[0] as Node,
          );
          // DOCUMENT_FOLLOWING (4) means thinkingRows[0] is after queuedUser.
          expect(
            (comparison & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
            ".UnicDB-chat-thinking-row must come AFTER the queued user bubble (separate row, not overlay)",
          ).toBe(true);
        }
        // First delta of the turn removes the row.
        dispatch({ type: "delta", text: "hi" });
        expect(
          root.querySelector(".UnicDB-chat-thinking-row"),
          "first delta must remove .UnicDB-chat-thinking-row",
        ).toBeNull();
      },
    );

    itIfBundle(
      "#2 closed fence mid-stream renders boxed code with copy button (data-raw un-escape path)",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("explain");
        // Remove the thinking row so the streaming bubble is the active child.
        dispatch({ type: "delta", text: "hi" });
        // Stream an open fence first (still plain text), then the closing
        // fence — the task spec says the streaming bubble gets re-rendered
        // through the markdown pipeline once a fence closes.
        dispatch({ type: "delta", text: "\n\n```sql\nSELECT 1 FROM users;\n```\n" });
        const bubble = rootEl().querySelector(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        ) as HTMLDivElement | null;
        expect(bubble).not.toBeNull();
        const codePre = bubble?.querySelector("pre.UnicDB-md-code");
        expect(codePre, "closed fence must render pre.UnicDB-md-code in bubble").not.toBeNull();
        const copyBtn = bubble?.querySelector("button.UnicDB-md-copy");
        expect(copyBtn, "closed fence must render button.UnicDB-md-copy").not.toBeNull();
        // data-raw round-trip contract: clicking the button un-escapes the
        // attribute and writes the raw code to the clipboard.
        // jsdom doesn't ship a working clipboard; assert writeText was
        // invoked with the correct un-escaped code.
        let written = "";
        const stub = (s: string): Promise<void> => {
          written = s;
          return Promise.resolve();
        };
        (navigator as unknown as { clipboard: { writeText: typeof stub } }).clipboard = {
          writeText: stub,
        };
        (copyBtn as HTMLButtonElement | null)?.click();
        expect(written).toBe("SELECT 1 FROM users;");
      },
    );

    itIfBundle(
      "#3 open fence mid-stream stays plain text; closing fence renders once",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("explain");
        // First delta removes the thinking row.
        dispatch({ type: "delta", text: "hi" });
        // Open fence but NO closing fence — bubble should NOT yet contain
        // a pre.UnicDB-md-code (mid-stream re-render guard).
        dispatch({ type: "delta", text: "```sql\nSELECT 1 FROM users" });
        const bubbleAfterOpen = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(
          bubbleAfterOpen?.querySelector("pre.UnicDB-md-code"),
          "open fence (no closing) must NOT yet render pre.UnicDB-md-code",
        ).toBeNull();
        // Now send the closing newline and backticks.
        dispatch({ type: "delta", text: ";\n```\n" });
        const bubbleAfterClose = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(
          bubbleAfterClose?.querySelector("pre.UnicDB-md-code"),
          "closing fence must render pre.UnicDB-md-code exactly once",
        ).not.toBeNull();
        const codeCount = bubbleAfterClose?.querySelectorAll("pre.UnicDB-md-code").length;
        expect(codeCount, "exactly one pre.UnicDB-md-code after close").toBe(1);
      },
    );

    itIfBundle(
      "#4 {type:'error'} or terminal assistant message removes the thinking row",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("hello");
        // Error path.
        let row = rootEl().querySelector(".UnicDB-chat-thinking-row");
        expect(row, "send must show the thinking row").not.toBeNull();
        dispatch({ type: "error", message: "boom" });
        expect(
          rootEl().querySelector(".UnicDB-chat-thinking-row"),
          "error must remove .UnicDB-chat-thinking-row (no orphaned spinner)",
        ).toBeNull();
        // Host's terminal lifecycle post — only `done` re-enables the
        // composer (sendBtn.disabled === state.busy, see setBusy). Match
        // the real wire so the second send is accepted.
        dispatch({ type: "done" });
        // Terminal assistant message path.
        sendViaComposer("again");
        row = rootEl().querySelector(".UnicDB-chat-thinking-row");
        expect(row, "second send must re-show the thinking row").not.toBeNull();
        dispatch({ type: "assistant", text: "reply", markdown: true });
        expect(
          rootEl().querySelector(".UnicDB-chat-thinking-row"),
          "terminal assistant must remove .UnicDB-chat-thinking-row",
        ).toBeNull();
      },
    );

    itIfBundle(
      "#5 hostile streamed content never becomes live HTML (escape-first preserved through re-render)",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("hello");
        dispatch({ type: "delta", text: "x" }); // remove thinking row
        // Stream a fenced payload containing an <img onerror=...> tag.
        dispatch({
          type: "delta",
          text:
            "```\n<img src=x onerror=\"alert(1)\">\n```\n",
        });
        const bubble = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(bubble).not.toBeNull();
        // No element with tag "img" must exist anywhere in the bubble
        // (the escape-first contract must survive the mid-stream re-render).
        expect(
          bubble?.querySelectorAll("img").length ?? 0,
          "hostile streamed <img> must NEVER appear as a live element in the bubble",
        ).toBe(0);
        // The text content of the code element must still carry the raw
        // hostile text (escaped in the DOM, not dropped).
        const code = bubble?.querySelector("pre.UnicDB-md-code code");
        expect(code?.textContent ?? "").toContain("<img src=x onerror=\"alert(1)\">");
      },
    );

    itIfBundle(
      "#6 repeated deltas over a closed fence do not duplicate copy buttons",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("hello");
        dispatch({ type: "delta", text: "x" }); // remove thinking row
        // Send one closed fence, then 3 more deltas (plain text).
        dispatch({ type: "delta", text: "```sql\nSELECT 1;\n```\n" });
        dispatch({ type: "delta", text: "tail 1\n" });
        dispatch({ type: "delta", text: "tail 2\n" });
        dispatch({ type: "delta", text: "tail 3\n" });
        const bubble = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(bubble).not.toBeNull();
        // Exactly one copy button per fenced block — even after repeated
        // deltas. (The re-render replaces the bubble's innerHTML, not the
        // bubble itself, so copy buttons are not duplicated.)
        const copyBtns = bubble?.querySelectorAll("button.UnicDB-md-copy").length;
        expect(copyBtns, "exactly one .UnicDB-md-copy per fenced block").toBe(1);
      },
    );

    itIfBundle(
      "#7 regression: queued user bubble lifecycle unchanged (resolve on first delta)",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("show me users");
        // Queued marker present after send.
        let queuedUser = rootEl().querySelector(
          ".UnicDB-chat-bubble.UnicDB-chat-user.UnicDB-chat-queued",
        );
        expect(queuedUser, "queued user bubble present after send").not.toBeNull();
        // First delta resolves the queued marker (UX1-008 lifecycle invariant).
        dispatch({ type: "delta", text: "hi" });
        queuedUser = rootEl().querySelector(
          ".UnicDB-chat-bubble.UnicDB-chat-user.UnicDB-chat-queued",
        );
        expect(
          queuedUser,
          "first delta must clear the .UnicDB-chat-queued marker on the user bubble",
        ).toBeNull();
      },
    );

    itIfBundle(
      "#8 R4.5 fix: history replay (resume_pick) does NOT surface a thinking row",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: true });
        // No live turn is running — the resume picker dispatches `history`
        // to rehydrate the thread. Replayed items must not leave an
        // orphan "AI is thinking…" row (a real turn isn't producing it).
        dispatch({
          type: "history",
          items: [
            { kind: "user", text: "earlier question" },
            { kind: "assistant", text: "earlier answer", markdown: true },
          ],
        });
        expect(
          rootEl().querySelector(".UnicDB-chat-thinking-row"),
          "history replay must NOT append a thinking row (no live turn)",
        ).toBeNull();
        // The user's next live turn must still surface the thinking row.
        sendViaComposer("new question");
        expect(
          rootEl().querySelector(".UnicDB-chat-thinking-row"),
          "subsequent live send must re-show the thinking row",
        ).not.toBeNull();
        // And it must clear on the next terminal assistant message.
        dispatch({ type: "assistant", text: "reply", markdown: true });
        expect(
          rootEl().querySelector(".UnicDB-chat-thinking-row"),
          "terminal assistant must remove the live-turn thinking row",
        ).toBeNull();
      },
    );

    itIfBundle(
      "#9 R4.5 fix: multi-fence streamed reply does not corrupt source on re-render",
      () => {
        loadBundle();
        dispatch({ type: "init", hasHistory: false });
        sendViaComposer("show me two snippets");
        dispatch({ type: "delta", text: "x" }); // remove thinking row
        // Stream TWO fenced blocks. The first close triggers a re-render
        // that previously read from bubble.textContent — which now
        // includes the copy button's literal "Copy" label and consumes
        // the first fence markers. On the SECOND close the re-render
        // would inline that stray "Copy" text and unbox the first block.
        // The fix tracks raw stream text in a dataset attribute.
        dispatch({
          type: "delta",
          text: "```sql\nSELECT 1;\n```\n",
        });
        dispatch({
          type: "delta",
          text: "and\n\n```py\nprint(2)\n```\ntail\n",
        });
        const bubble = rootEl().querySelector<HTMLDivElement>(
          ".UnicDB-chat-bubble.UnicDB-chat-assistant.UnicDB-chat-streaming",
        );
        expect(bubble).not.toBeNull();
        // Both code blocks must be rendered as boxed pre.UnicDB-md-code
        // elements — the first one must NOT be inlined as plain text
        // just because the source was re-rendered on the second close.
        const pres = bubble?.querySelectorAll("pre.UnicDB-md-code");
        expect(
          pres?.length ?? 0,
          "two streamed code blocks must both render as pre.UnicDB-md-code",
        ).toBe(2);
        // The bubble must NOT contain a stray literal "Copy" word from
        // the first block's copy button leaking back into the markdown
        // pipeline. (Word-boundary check keeps "copy" inside CSS class
        // names from false-positiving.)
        const stray = bubble?.textContent ?? "";
        expect(/\bCopy\b/.test(stray), "stray 'Copy' label must not appear in bubble text").toBe(
          false,
        );
        // Terminal assistant message self-heals via the regular path.
        dispatch({
          type: "assistant",
          text: "```sql\nSELECT 1;\n```\n\n```py\nprint(2)\n```\ntail\n",
          markdown: true,
        });
        // After settlement the streaming class is gone; nothing to
        // assert beyond a clean no-throw render.
        expect(
          rootEl().querySelector(".UnicDB-chat-bubble.UnicDB-chat-streaming"),
          "terminal assistant must close the streaming bubble",
        ).toBeNull();
      },
    );
  },
);