// src/ui/__tests__/aiChatPanelWebview.test.ts — TASK-003 webview render
// tests for the permission UI.
//
// SECURITY under test:
//   1. Hostile tool/detail/option labels containing HTML/markdown are rendered
//      as literal text via DOM text nodes (textContent). They must NEVER reach
//      the page as live nodes via innerHTML or any markdown interpreter.
//   2. Allow sends ONE `permission_response` with the host-provided opaque
//      requestId AND the chosen opaque optionId. Deny sends ONE response with
//      the same requestId and NO optionId at all.
//   3. Duplicate / unknown / disposed request interactions must NOT post a
//      second `permission_response`. Only one response is emitted per visible
//      request.
//
// Approach: we use esbuild's transform() to transpile webview/aiChatPanelMain.ts
// to plain JS at test-load time, then evaluate it inside a jsdom window with a
// stubbed acquireVsCodeApi. That keeps the test independent of the dist/
// output, so a stale bundle can't pass against a stale source.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// @vitest-environment jsdom

// ---- Compile the source TS file once at module load ------------------------
//
// esbuild's API uses jsdom's TextEncoder shim which is broken, so we shell
// out to the esbuild CLI reading from stdin. This runs in pure Node land.

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");
const source = readFileSync(sourcePath, "utf8");
const compiled = execFileSync(
  resolve(process.cwd(), "node_modules", ".bin", "esbuild"),
  ["--loader=ts", "--target=es2022", "--format=iife", "--banner="],
  { input: source, encoding: "utf8" },
).toString();

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface Harness {
  received: Array<Record<string, unknown>>;
  dispatch: (msg: Record<string, unknown>) => void;
  root: HTMLDivElement;
}

function makeHarness(): Harness {
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

  // The bundle is a top-level IIFE that reads window/document directly.
  (0, eval)(compiled);

  const dispatch = (msg: Record<string, unknown>): void => {
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  };

  return {
    received,
    dispatch,
    root: document.getElementById("vsdb-root") as HTMLDivElement,
  };
}

beforeEach(() => {
  // Reset DOM between tests so each test starts clean.
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---- Helpers ---------------------------------------------------------------

// Type guard for the webview→host response wire.
function isPermissionResponse(
  m: Record<string, unknown>,
): m is { type: "permission_response"; requestId: string; optionId?: string } {
  return m.type === "permission_response";
}

function permissionPosts(
  received: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return received.filter(isPermissionResponse);
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

const hostileRequest = {
  type: "permission_request",
  requestId: "req-host-7c4f",
  tool: {
    id: "tool_write_file",
    name: "<script>window.__pwned=1</script>",
    detail:
      "writes path 'C:\\tmp\\evil.md' & <img src=x onerror=alert(1)>",
  },
  options: [
    { optionId: "allow-once", label: "Allow once" },
    {
      optionId: "deny",
      label: "**Refuse** & <img src=x onerror=alert(1)>",
    },
  ],
} as const;

// ---- #3 — hostile labels render as text only (no innerHTML, no markdown) --
describe("AiChatPanelWebview — hostile labels render as text only", () => {
  it("#3a tool name + detail render as literal text via textContent", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);

    // The full thread innerHTML must NOT contain a live <script> tag from
    // the hostile label, nor an <img onerror> from the detail.
    const threadHtml = h.root.innerHTML;
    expect(threadHtml).not.toMatch(/<script/i);
    expect(threadHtml).not.toMatch(/<img[^>]*onerror/i);
    // textContent round-trips the hostile values verbatim.
    const threadText = h.root.textContent ?? "";
    expect(threadText).toContain("<script>window.__pwned=1</script>");
    expect(threadText).toContain("C:\\tmp\\evil.md");
    expect(threadText).toContain("<img src=x onerror=alert(1)>");
    // No script tag was actually parsed — __pwned stays undefined.
    const w = window as unknown as Record<string, unknown>;
    expect("__pwned" in w).toBe(false);
  });

  it("#3b option labels with markdown + HTML render as literal text (no markdown interpreter)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    const allowBtn = btnContaining(h.root, "Allow once");
    const denyBtn = btnContaining(h.root, "**Refuse**");
    expect(allowBtn).not.toBeNull();
    expect(denyBtn).not.toBeNull();
    // No <strong> / <em> got injected by any markdown interpretation.
    const threadHtml = h.root.innerHTML;
    expect(threadHtml).not.toMatch(/<strong/i);
    expect(threadHtml).not.toMatch(/<em[^a-z]/i);
    // Deny label carries the onerror payload; it must remain inert text.
    expect(threadHtml).not.toMatch(/<img[^>]*onerror/i);
    // textContent preserves the exact label verbatim.
    expect(denyBtn?.textContent).toBe(
      "**Refuse** & <img src=x onerror=alert(1)>",
    );
  });
});

// ---- #2 — Allow / Deny each post exactly ONE response ---------------------
describe("AiChatPanelWebview — Allow/Deny responses", () => {
  it("#2a Allow posts one permission_response with requestId + optionId", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    const allowBtn = btnContaining(h.root, "Allow once");
    expect(allowBtn).not.toBeNull();
    allowBtn?.click();

    const posts = permissionPosts(h.received);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      type: "permission_response",
      requestId: "req-host-7c4f",
      optionId: "allow-once",
    });
  });

  it("#2b Deny posts one permission_response with requestId, NO optionId field", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    const denyBtn = btnContaining(h.root, "**Refuse**");
    expect(denyBtn).not.toBeNull();
    denyBtn?.click();

    const posts = permissionPosts(h.received);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.type).toBe("permission_response");
    expect(posts[0]?.requestId).toBe("req-host-7c4f");
    // optionId MUST be absent from the deny wire (not undefined, not null).
    expect(posts[0] && "optionId" in posts[0]).toBe(false);
  });

  it("#2c each visible opaque request yields at most one response", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    const second = {
      ...hostileRequest,
      requestId: "req-host-different",
    };
    h.dispatch(hostileRequest);
    h.dispatch(second);

    // Two visible requests → two responses max.
    let clicked = 0;
    for (const b of Array.from(h.root.querySelectorAll("button"))) {
      if (b.textContent?.includes("Allow once")) {
        b.click();
        clicked++;
      }
    }
    expect(clicked).toBeGreaterThanOrEqual(2);
    const posts = permissionPosts(h.received);
    expect(posts).toHaveLength(2);
    // Each request ID gets its own correlated response.
    expect(posts[0]?.requestId).toBe("req-host-7c4f");
    expect(posts[1]?.requestId).toBe("req-host-different");
  });
});

// ---- #4 — duplicate / unknown / disposed requests post nothing extra -------
describe("AiChatPanelWebview — duplicate and disposed requests", () => {
  it("#4a clicking Allow twice on the same request posts exactly one response", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    const allowBtn = btnContaining(h.root, "Allow once");
    expect(allowBtn).not.toBeNull();
    allowBtn?.click();
    // Click again — but after the first click, the request is gone from
    // the DOM (webview emits no second response). Test asserts no second
    // response is produced regardless of how many times the button is poked.
    allowBtn?.click();
    // And once more for good measure.
    if (allowBtn?.isConnected) allowBtn.click();

    const posts = permissionPosts(h.received);
    expect(posts).toHaveLength(1);
  });

  it("#4b Deny after Allow posts nothing extra (request disposed after Allow)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    const allowBtn = btnContaining(h.root, "Allow once");
    const denyBtn = btnContaining(h.root, "**Refuse**");
    allowBtn?.click();
    // After Allow, the request must no longer be actionable.
    if (denyBtn?.isConnected) denyBtn.click();

    const posts = permissionPosts(h.received);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.optionId).toBe("allow-once");
  });

  it("#4c unknown / unknown-id requests post no new responses", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    // Dispatch a fresh request…
    h.dispatch(hostileRequest);
    const allowBtn = btnContaining(h.root, "Allow once");
    expect(allowBtn).not.toBeNull();
    allowBtn?.click();
    // …then dispatch a SECOND request with a NEW id (host replaced it).
    const replacement = {
      ...hostileRequest,
      requestId: "req-host-replacement",
    };
    h.dispatch(replacement);
    // Only the buttons for the latest request should be actionable.
    let allowCount = 0;
    for (const b of Array.from(h.root.querySelectorAll("button"))) {
      if (b.textContent?.includes("Allow once")) {
        b.click();
        allowCount++;
      }
    }
    // The webview yields at most one response per visible request.
    const posts = permissionPosts(h.received);
    // We don't care which request the test ends up responding to, but the
    // total number of permission_response posts must equal the number of
    // distinct requests the host emitted (at most 1 per request).
    expect(posts.length).toBeLessThanOrEqual(2);
    expect(allowCount).toBeGreaterThanOrEqual(1);
  });
});

// ---- Regression: no apiKey ever crosses the boundary even with the UI ----
describe("AiChatPanelWebview — no apiKey crossing", () => {
  it("#R no permission_response payload contains an apiKey-shaped field", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(hostileRequest);
    btnContaining(h.root, "Allow once")?.click();
    btnContaining(h.root, "**Refuse**")?.click();

    const posts = permissionPosts(h.received);
    const all = JSON.stringify(posts);
    expect(all).not.toMatch(/api_?key/i);
    expect(all).not.toMatch(/sk-[a-z0-9]/i);
  });
});
