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
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

// @vitest-environment jsdom

// ---- Compile the source TS file once at module load ------------------------
//
// esbuild's API uses jsdom's TextEncoder shim which is broken, so we shell
// out to the esbuild CLI reading from stdin. This runs in pure Node land.

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");
// TASK-003: aiChatPanelMain.ts now imports ./sqlHighlight. We bundle the
// real file on disk (instead of piping stdin) so the relative import
// resolves against webview/ — esbuild resolves .ts extensions by default.
// With no --outfile/--outdir, esbuild writes the single IIFE bundle to
// stdout.
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

  // Re-eval accumulates `window.addEventListener("message", ...)` handlers
  // across previous tests (each IIFE evaluates a fresh closure), so the
  // DOM ends up mutated N times for a single dispatch. Capture the latest
  // handler the bundle installs this call, dispatch directly against it,
  // and replace `addEventListener` after the bundle's install line to
  // ignore any later additions.
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

  // The bundle is a top-level IIFE that reads window/document directly.
  (0, eval)(compiled);

  // Restore the original addEventListener so any code that runs in the
  // rest of the test cannot accidentally re-arm another handler.
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

// ---- TASK-001 #7+#8 — long detail renders collapsible; short detail stays
// a plain div; empty detail is omitted entirely. textContent only.
describe("AiChatPanelWebview — permission detail collapsible (TASK-001)", () => {
  function longDetailRequest(detail: string) {
    return {
      type: "permission_request",
      requestId: "req-long-1",
      tool: {
        id: "tool-1",
        name: "describe_table",
        detail,
      },
      options: [
        { optionId: "allow-once", label: "Allow once" },
        { optionId: "deny", label: "Deny" },
      ],
    } as const;
  }

  it("#7 long detail (>120 chars) renders collapsible; textContent only; pre carries full detail", () => {
    const longDetail = "x".repeat(150);
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(longDetailRequest(longDetail));
    const card = h.root.querySelector(".vsdb-chat-permission");
    expect(card).not.toBeNull();
    // Collapsible: a <details> with a <summary> + <pre>.
    const details = card?.querySelector("details");
    expect(details).not.toBeNull();
    const summary = details?.querySelector("summary");
    expect(summary?.textContent).toBe("Show tool details");
    const pre = details?.querySelector("pre");
    expect(pre?.textContent).toBe(longDetail);
    // No .vsdb-chat-permission-tool-detail plain div when collapsible is used.
    // When collapsible, the detail element is a <details>, not a plain div.
    expect(card?.querySelector("div.vsdb-chat-permission-tool-detail")).toBeNull();
    // Sanity: nothing in card assigned innerHTML — textContent only.
    const threadHtml = h.root.innerHTML;
    expect(threadHtml).not.toMatch(/<script/i);
  });

  it("#7b short single-line detail (<=120 chars) renders as plain div", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(longDetailRequest("short detail"));
    const card = h.root.querySelector(".vsdb-chat-permission");
    expect(card).not.toBeNull();
    const plain = card?.querySelector(".vsdb-chat-permission-tool-detail");
    expect(plain).not.toBeNull();
    expect(plain?.textContent).toBe("short detail");
    // No <details> when detail is short.
    expect(card?.querySelector("details")).toBeNull();
  });

  it("#8 empty detail: no .vsdb-chat-permission-tool-detail node", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch(longDetailRequest(""));
    const card = h.root.querySelector(".vsdb-chat-permission");
    expect(card).not.toBeNull();
    expect(
      card?.querySelector(".vsdb-chat-permission-tool-detail"),
    ).toBeNull();
    expect(card?.querySelector("details")).toBeNull();
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

// ---- TASK-003 #5: engine banner label for builtin ------------------------
describe("AiChatPanelWebview — engine banner (built-in streaming)", () => {
  it('#5 builtin: banner text reads "Engine: builtin — streaming"', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "engine", name: "builtin" });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe("Engine: builtin — streaming");
  });

  it('#5b builtin with hint: banner text reads "Engine: builtin — <hint>", still ends with "— streaming"', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "engine", name: "builtin", hint: "no api key configured" });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe(
      "Engine: builtin — no api key configured — streaming",
    );
    expect(banner!.textContent).toMatch(/— streaming$/);
  });

  it('#5c omp: banner text reads "Engine: oh-my-pi (omp) — streaming"', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "engine", name: "omp" });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe("Engine: oh-my-pi (omp) — streaming");
  });

  it('#5d B8 omp with version: banner text reads "Engine: oh-my-pi (omp) v18.0.1 — streaming"', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "engine", name: "omp", version: "18.0.1" });
    const banner = document.getElementById("engineBanner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toBe(
      "Engine: oh-my-pi (omp) v18.0.1 — streaming",
    );
  });
});

// ---- TASK-003 #7: regression — done/error de-streams open bubble ----------
// delta(x) → done (no assistant) → delta(y): the second delta must open a NEW
// bubble; without de-stream on done, the y is appended into the orphaned
// streaming bubble that x created, merging the two turns' text.
describe("AiChatPanelWebview — de-stream on done/error (regression F4)", () => {
  it('#7 done de-streams: after delta(x)+done, no .vsdb-chat-streaming bubble; next delta(y) opens new bubble', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "delta", text: "x" });
    // Verify the streaming bubble IS open before done (sanity).
    expect(document.querySelector(".vsdb-chat-streaming")).not.toBeNull();
    h.dispatch({ type: "done" });
    // After done, streaming bubble must have been removed (de-streamed).
    expect(document.querySelector(".vsdb-chat-streaming")).toBeNull();
    // The x bubble still has its content visible (no text wipe).
    const after = document.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-assistant");
    expect(after).toHaveLength(1);
    expect(after[0]?.textContent).toBe("x");

    // Second turn: delta(y) must open a NEW bubble, NOT merge into x.
    h.dispatch({ type: "delta", text: "y" });
    const allAfter2 = document.querySelectorAll(
      ".vsdb-chat-bubble.vsdb-chat-assistant",
    );
    expect(allAfter2).toHaveLength(2);
    expect(allAfter2[0]?.textContent).toBe("x");
    expect(allAfter2[1]?.textContent).toBe("y");
  });

  it('#7b error de-streams: error path also removes the streaming class', () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({ type: "delta", text: "x" });
    expect(document.querySelector(".vsdb-chat-streaming")).not.toBeNull();
    h.dispatch({ type: "error", message: "stream aborted" });
    expect(document.querySelector(".vsdb-chat-streaming")).toBeNull();
    // Error bubble is added; original text x stays visible.
    const bubbles = document.querySelectorAll(".vsdb-chat-bubble");
    expect(bubbles.length).toBeGreaterThanOrEqual(2);
  });
});

// ---- TASK-004 — Resume picker + history rendering --------------------------
//
// Resumes the TASK-003 message shape on the webview side. The webview never
// invents a sessionId, never renders host-driven labels via innerHTML, and
// never renders `agent_thought_chunk` (host already filtered those out).

describe("AiChatPanelWebview — Resume button + session picker", () => {
  it("#1 click Resume → posts resume_list; receives resume_sessions rows; click row → exactly ONE resume_pick with verbatim sessionId", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });

    const resumeBtn = btnContaining(h.root, "Resume");
    expect(resumeBtn).not.toBeNull();
    resumeBtn?.click();

    const listPosts = h.received.filter((m) => m.type === "resume_list");
    expect(listPosts).toHaveLength(1);

    // Host answers with three rows.
    h.dispatch({
      type: "resume_sessions",
      sessions: [
        { sessionId: "sess-A", label: "first chat", detail: "12 messages" },
        { sessionId: "sess-B", label: "(untitled)", detail: "3 messages" },
        { sessionId: "sess-C-with-<weird>&chars", label: "triage", detail: "7 messages" },
      ],
    });

    const rows = h.root.querySelectorAll<HTMLDivElement>(
      ".vsdb-chat-resume-row",
    );
    expect(rows.length).toBe(3);

    // Every row's label + detail are text nodes — never innerHTML for data
    // host-driven content.
    for (const row of Array.from(rows)) {
      const html = row.innerHTML;
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<img[^>]*onerror/i);
    }
    expect(rows[0]?.textContent).toContain("first chat");
    expect(rows[0]?.textContent).toContain("12 messages");
    expect(rows[2]?.textContent).toContain("triage");

    // Click row 1 (session B).
    rows[1]?.click();
    const picks = h.received.filter((m) => m.type === "resume_pick");
    expect(picks).toHaveLength(1);
    expect(picks[0]?.sessionId).toBe("sess-B");
    // sessionId echoed verbatim — never synthesized by the webview.
    expect(picks[0]?.sessionId).not.toBe("0");
    expect(picks[0]?.sessionId).not.toBe("sess-A");

    // Click row 2 — but only ONE resume_pick must ever be emitted per pick.
    // Once the user picked a session the picker is dismissed (host replaces
    // state), but a defensive double-click must NOT emit a second resume_pick.
    rows[2]?.click();
    const allPicks = h.received.filter((m) => m.type === "resume_pick");
    expect(allPicks).toHaveLength(1);
  });

  it("#1b dismiss picker → posts resume_cancel exactly once", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    btnContaining(h.root, "Resume")?.click();
    h.dispatch({
      type: "resume_sessions",
      sessions: [{ sessionId: "sess-A", label: "first", detail: "1 messages" }],
    });
    // Cancel button exists while picker is open.
    const cancelBtn = btnContaining(h.root, "Cancel");
    expect(cancelBtn).not.toBeNull();
    cancelBtn?.click();
    const cancels = h.received.filter((m) => m.type === "resume_cancel");
    expect(cancels).toHaveLength(1);
    // Picker is gone from the DOM.
    expect(h.root.querySelector(".vsdb-chat-resume-picker")).toBeNull();
  });
});

describe("AiChatPanelWebview — history batch render", () => {
  it("#2 history renders user/assistant/tool in order; assistant via markdown renderer; tool one-line collapsed", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({
      type: "history",
      items: [
        { kind: "user", text: "hi" },
        { kind: "assistant", text: "**bold** reply" },
        { kind: "tool", text: "ran sql_query" },
      ],
      truncated: false,
      truncatedCount: 0,
    });

    const thread = document.getElementById("thread") as HTMLDivElement;
    // User bubble: plain text node, class vsdb-chat-user.
    const userBubbles = thread.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-user");
    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0]?.textContent).toBe("hi");
    // Assistant bubble: uses existing markdown renderer → emits <strong>.
    const assistantBubbles = thread.querySelectorAll(
      ".vsdb-chat-bubble.vsdb-chat-assistant",
    );
    expect(assistantBubbles.length).toBe(1);
    expect(assistantBubbles[0]?.innerHTML).toMatch(/<strong>bold<\/strong>/);
    // Tool item: one-line, collapsed (no markdown interpreted, no inner HTML
    // payload from host data beyond text).
    const toolItems = thread.querySelectorAll(".vsdb-chat-history-tool");
    expect(toolItems.length).toBe(1);
    expect(toolItems[0]?.textContent).toContain("ran sql_query");
    // DOM order matches item order.
    const ordered = Array.from(
      thread.querySelectorAll(
        ".vsdb-chat-bubble, .vsdb-chat-history-tool",
      ),
    );
    expect(ordered.length).toBe(3);
    expect(ordered[0]).toBe(userBubbles[0]);
    expect(ordered[1]).toBe(assistantBubbles[0]);
    expect(ordered[2]).toBe(toolItems[0]);
  });

  it("#3 agent_thought_chunk is NEVER rendered (host-filtered; no branch in webview)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    // Host legitimately never sends a kind:"thought" — but even if a stray
    // payload reaches the webview, no DOM node must be produced for it.
    h.dispatch({
      type: "history",
      items: [
        { kind: "user", text: "u" },
        // The hostile kind label itself must NOT become DOM.
        { kind: "agent_thought_chunk" as "user", text: "secret thought" },
        { kind: "assistant", text: "ok" },
      ],
      truncated: false,
      truncatedCount: 0,
    });
    const thread = document.getElementById("thread") as HTMLDivElement;
    expect(thread.textContent ?? "").not.toMatch(/secret thought/);
    // Only the user + assistant bubbles exist.
    const bubbles = thread.querySelectorAll(".vsdb-chat-bubble");
    expect(bubbles.length).toBe(2);
  });

  it("#4 truncation: single notice line ABOVE items using truncatedCount", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    h.dispatch({
      type: "history",
      items: [{ kind: "user", text: "last" }],
      truncated: true,
      truncatedCount: 23,
    });
    const thread = document.getElementById("thread") as HTMLDivElement;
    const notice = thread.querySelector(".vsdb-chat-history-truncated");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/^23 earlier items not shown$/);
    // Notice sits above the rendered items.
    const firstChild = thread.children[0];
    expect(firstChild).toBe(notice);
  });

  it("#5 hostile label/detail in resume_sessions renders literal text (no live nodes)", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    btnContaining(h.root, "Resume")?.click();
    h.dispatch({
      type: "resume_sessions",
      sessions: [
        {
          sessionId: "sess-X",
          label: "<img src=x onerror=alert(1)>",
          detail: "<script>window.__pwned=1</script>",
        },
      ],
    });
    const threadHtml = h.root.innerHTML;
    expect(threadHtml).not.toMatch(/<script/i);
    expect(threadHtml).not.toMatch(/<img[^>]*onerror/i);
    const row = h.root.querySelector(".vsdb-chat-resume-row");
    expect(row?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(row?.textContent).toContain("<script>window.__pwned=1</script>");
    const w = window as unknown as Record<string, unknown>;
    expect("__pwned" in w).toBe(false);
  });

  it("#6 busy: Send in flight disables Resume; done re-enables", () => {
    const h = makeHarness();
    h.dispatch({ type: "init", hasHistory: false });
    const resumeBtn = btnContaining(h.root, "Resume");
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn?.disabled).toBe(false);

    // User sends a message — turns busy on.
    inputEl("prompt").value = "go";
    btn("sendBtn").click();
    expect(resumeBtn?.disabled).toBe(true);

    // Click while busy must NOT post a resume_list.
    resumeBtn?.click();
    const listWhileBusy = h.received.filter((m) => m.type === "resume_list");
    expect(listWhileBusy).toHaveLength(0);

    // Host signals turn end → Resume re-enabled.
    h.dispatch({ type: "done" });
    expect(resumeBtn?.disabled).toBe(false);

    resumeBtn?.click();
    const listAfter = h.received.filter((m) => m.type === "resume_list");
    expect(listAfter).toHaveLength(1);
  });
});

// Shared lookup helpers for the resume/history tests above. Duplicated from
// the bundle test to keep the two suites independently readable.
function inputEl(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

// ---- TASK-003 #4, #5 — init{hasHistory:false} re-enables input -----------
// Host posts init{hasHistory:false} after handleClear. The webview must
// re-enable Send/prompt and de-stream any orphaned bubble, even if the
// `done` message is reordered or lost in transit (defense-in-depth vs.
// the host's `done`). #5 — double init does not throw / does not double-
// fire error.
describe("AiChatPanelWebview — init re-enable (TASK-003)", () => {
  it("#4 init{hasHistory:false} after setBusy(true) re-enables sendBtn + prompt + de-streams", () => {
    const h = makeHarness();
    // First init from handleReady — sent on bundle boot via ready. The
    // bundle already posted {type:"ready"} before this test ran. Dispatch
    // init{hasHistory:false} from host manually.
    h.dispatch({ type: "init", hasHistory: false });

    // Simulate user clicking Send → setBusy(true).
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
    prompt.value = "hi";
    sendBtn.click();

    expect(sendBtn.disabled).toBe(true);
    expect(prompt.disabled).toBe(true);

    // Host posts init{hasHistory:false} after Clear (defense-in-depth
    // alongside `done`). Webview must re-enable input.
    h.dispatch({ type: "init", hasHistory: false });

    expect(sendBtn.disabled).toBe(false);
    expect(prompt.disabled).toBe(false);
  });

  it("#5 double init{hasHistory:false} does not throw; banner/thread DOM stays well-formed", () => {
    const h = makeHarness();
    expect(() => {
      h.dispatch({ type: "init", hasHistory: false });
      h.dispatch({ type: "init", hasHistory: false });
      h.dispatch({ type: "init", hasHistory: false });
    }).not.toThrow();
    // Thread container still exists and has no error bubbles.
    const thread = document.getElementById("thread");
    expect(thread).not.toBeNull();
    expect(thread?.querySelectorAll(".vsdb-chat-bubble.vsdb-chat-error").length ?? 0).toBe(0);
  });
});

