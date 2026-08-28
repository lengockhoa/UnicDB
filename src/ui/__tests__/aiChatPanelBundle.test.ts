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

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface BundleHandle {
  received: Array<Record<string, unknown>>;
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/aiChatPanel.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-form-body"></div>';

  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
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
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
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
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    const html = root.innerHTML;
    expect(html).toMatch(/Hello/);
    expect(html).toMatch(/<h2/);
  });
});
describeIfBundle("webview/aiChatPanelMain.ts bundle (TASK-004 Resume)", () => {
  itIfBundle("#9 Resume button exists in initial render and is enabled", () => {
    const { received: _r } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
    const resumeBtn = document.getElementById(
      "resumeBtn",
    ) as HTMLButtonElement | null;
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn?.disabled).toBe(false);
  });

  itIfBundle("#10 click Resume → posts exactly one resume_list", () => {
    const { received } = loadBundle();
    dispatch({ type: "init", hasHistory: false });
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
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
    const root = document.getElementById("vsdb-root") as HTMLDivElement;
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
    const rows = root.querySelectorAll<HTMLDivElement>(".vsdb-chat-resume-row");
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

    itIfBundle("#AG9 .vsdb-btn svg sizing rule stays intact in styles.css", () => {
      const cssPath = resolve(process.cwd(), "webview", "styles.css");
      const css = readFileSync(cssPath, "utf8");
      expect(/\.vsdb-btn svg\s*\{[^}]*pointer-events:\s*none/.test(css)).toBe(
        true,
      );
    });
  },
);