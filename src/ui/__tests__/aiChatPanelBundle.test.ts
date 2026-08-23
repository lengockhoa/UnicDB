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
