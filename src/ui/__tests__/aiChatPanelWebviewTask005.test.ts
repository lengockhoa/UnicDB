// src/ui/__tests__/aiChatPanelWebviewTask005.test.ts — TASK-005 webview tests.
//
// @-mention dropdown lifecycle + keyboard nav + Enter-semantics interop
// with the wave-2 Enter=send keybind. Mirrors the esbuild/jsdom harness
// pattern from aiChatPanelWebviewTask002.test.ts.
//
// Coverage:
//   1. typing `@` posts `mention_list` with the live query
//   2. host `mention_objects` reply renders the dropdown DOM
//   3. ArrowDown / ArrowUp move the active row
//   4. Enter / Tab with dropdown open inserts the @token and CLOSES the
//      dropdown — DOES NOT post a send
//   5. Esc closes the dropdown without sending
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// @vitest-environment jsdom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");

const esbuildBin = (() => {
  const here = resolve(process.cwd(), "node_modules", ".bin", "esbuild");
  if (existsSync(here)) return here;
  // Worktree: fall back to the parent repo's node_modules.
  const parent = resolve(process.cwd(), "..", "..", "node_modules", ".bin", "esbuild");
  if (existsSync(parent)) return parent;
  return here;
})();
const compiled = execFileSync(
  esbuildBin,
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

  return { received, dispatch };
}

function promptEl(): HTMLTextAreaElement {
  return document.getElementById("prompt") as HTMLTextAreaElement;
}

function sendBtnEl(): HTMLButtonElement {
  return document.getElementById("sendBtn") as HTMLButtonElement;
}

function mentionDropdown(): HTMLDivElement | null {
  return document.getElementById("vsdbMentionDropdown") as HTMLDivElement | null;
}

function mentionRows(): HTMLDivElement[] {
  const dd = mentionDropdown();
  if (!dd) return [];
  return Array.from(
    dd.querySelectorAll<HTMLDivElement>(".vsdb-chat-mention-row"),
  );
}

function activeRow(): HTMLDivElement | null {
  for (const r of mentionRows()) {
    if (r.classList.contains("vsdb-chat-mention-row-active")) return r;
  }
  return null;
}

function dispatchMentionObjects(
  harness: Harness,
  items: Array<{
    kind: "table" | "view" | "routine" | "file";
    label: string;
    detail: string;
    token: string;
  }>,
): void {
  harness.dispatch({ type: "mention_objects", items });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ============================================================================
// #1 Typing @ posts mention_list with the live query
// ============================================================================
describe("AiChatPanelWebview — @-mention dropdown open + refresh (TASK-005 #1)", () => {
  it("#1a typing `@` posts exactly one mention_list with empty query", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.focus();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    const listPosts = harness.received.filter((m) => m.type === "mention_list");
    expect(listPosts.length).toBe(1);
    expect(listPosts[0]).toEqual({ type: "mention_list", query: "" });
  });

  it("#1b typing `@pu` posts mention_list with query 'pu'", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.focus();
    prompt.value = "@pu";
    prompt.setSelectionRange(3, 3);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "u" }));
    const listPosts = harness.received.filter((m) => m.type === "mention_list");
    expect(listPosts.length).toBeGreaterThanOrEqual(1);
    const last = listPosts[listPosts.length - 1];
    expect(last).toEqual({ type: "mention_list", query: "pu" });
  });

  it("#1c backspacing past `@` does NOT post mention_list", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "hello";
    prompt.setSelectionRange(5, 5);
    // No `@` in text — backspace of 'o' should not open the dropdown.
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace" }));
    const listPosts = harness.received.filter((m) => m.type === "mention_list");
    expect(listPosts.length).toBe(0);
  });
});

// ============================================================================
// #2 mention_objects reply renders the dropdown
// ============================================================================
describe("AiChatPanelWebview — dropdown DOM render (TASK-005 #2)", () => {
  it("#2a mention_objects creates the dropdown + one row per item", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.focus();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "public.users", detail: "public · table", token: "public.users" },
      { kind: "table", label: "users", detail: "public · table", token: "users" },
      { kind: "view", label: "public.v", detail: "public · view", token: "public.v" },
      { kind: "file", label: "src/foo.ts", detail: "file", token: "src/foo.ts" },
    ]);
    const rows = mentionRows();
    expect(rows.length).toBe(4);
    expect(rows[0]?.textContent).toContain("table");
    expect(rows[0]?.textContent).toContain("public.users");
  });

  it("#2b first row is initially active (vsdb-chat-mention-row-active)", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "users", detail: "public · table", token: "users" },
      { kind: "view", label: "v", detail: "public · view", token: "v" },
    ]);
    expect(activeRow()?.textContent).toContain("users");
  });
});

// ============================================================================
// #3 ArrowDown / ArrowUp move the active row
// ============================================================================
describe("AiChatPanelWebview — ArrowDown/ArrowUp active-row navigation (TASK-005 #3)", () => {
  it("#3a ArrowDown advances the active row", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "a", detail: "a", token: "a" },
      { kind: "table", label: "b", detail: "b", token: "b" },
      { kind: "table", label: "c", detail: "c", token: "c" },
    ]);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(activeRow()?.getAttribute("data-token")).toBe("b");
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(activeRow()?.getAttribute("data-token")).toBe("c");
  });

  it("#3b ArrowUp from the first row wraps to the last row", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "a", detail: "a", token: "a" },
      { kind: "table", label: "b", detail: "b", token: "b" },
      { kind: "table", label: "c", detail: "c", token: "c" },
    ]);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(activeRow()?.getAttribute("data-token")).toBe("c");
  });
});

// ============================================================================
// #4 Enter / Tab selects and DOES NOT send
// ============================================================================
describe("AiChatPanelWebview — Enter / Tab select, never send (TASK-005 #4)", () => {
  it("#4a Enter while dropdown open inserts `@token ` and closes the dropdown", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@us";
    prompt.setSelectionRange(3, 3);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "s" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "users", detail: "public · table", token: "users" },
    ]);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Dropdown closed.
    expect(mentionDropdown()).toBeNull();
    // Token inserted; @-span replaced.
    expect(prompt.value).toBe("@users ");
    // NO send was posted.
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });

  it("#4b Tab also inserts the @token and never sends", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "file", label: "src/foo.ts", detail: "file", token: "src/foo.ts" },
    ]);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(prompt.value).toBe("@src/foo.ts ");
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });

  it("#4c Enter with dropdown CLOSED still sends (wave-2 keybind preserved)", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "hello world";
    prompt.setSelectionRange(11, 11);
    // No `@` → dropdown not open.
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(1);
    expect(sends[0]).toEqual({ type: "send", text: "hello world" });
  });
});

// ============================================================================
// #5 Esc closes the dropdown without sending
// ============================================================================
describe("AiChatPanelWebview — Esc dismisses the mention dropdown (TASK-005 #5)", () => {
  it("#5a Esc closes the dropdown; no send posted; token NOT inserted", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@us";
    prompt.setSelectionRange(3, 3);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "s" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "users", detail: "public · table", token: "users" },
    ]);
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mentionDropdown()).toBeNull();
    expect(prompt.value).toBe("@us");
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });
});

// ============================================================================
// #6 Empty candidates + Enter / Esc close
// ============================================================================
describe("AiChatPanelWebview — No-matches state (TASK-005 #6)", () => {
  it("#6a mention_objects with [] renders a 'No matches' row; Enter closes", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@xyz";
    prompt.setSelectionRange(4, 4);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "z" }));
    dispatchMentionObjects(harness, []);
    const dd = mentionDropdown();
    expect(dd).not.toBeNull();
    expect(dd?.textContent).toContain("No matches");
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mentionDropdown()).toBeNull();
    // No send.
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });
});

// ============================================================================
// #7 Send button click while dropdown open closes the dropdown (not sends)
// ============================================================================
describe("AiChatPanelWebview — Send click while dropdown open (TASK-005 #7)", () => {
  it("#7a clicking Send while dropdown is open closes the dropdown and never sends", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "users", detail: "public · table", token: "users" },
    ]);
    expect(mentionDropdown()).not.toBeNull();
    sendBtnEl().click();
    expect(mentionDropdown()).toBeNull();
    const sends = harness.received.filter((m) => m.type === "send");
    expect(sends.length).toBe(0);
  });
});

// ============================================================================
// #8 mention_miss renders an inline notice bubble
// ============================================================================
describe("AiChatPanelWebview — mention_miss inline notice (TASK-005 #8)", () => {
  it("#8a host mention_miss adds a 'Could not resolve @<token>' bubble", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    harness.dispatch({ type: "mention_miss", token: "public.nope" });
    const miss = document.querySelector(".vsdb-chat-mention-miss");
    expect(miss).not.toBeNull();
    expect(miss?.textContent).toContain("Could not resolve @public.nope");
    expect(miss?.textContent).not.toContain("<script>");
  });
});

// ============================================================================
// #9 Click outside closes the dropdown
// ============================================================================
describe("AiChatPanelWebview — click-outside closes dropdown (TASK-005 #9)", () => {
  it("#9a mousedown outside the dropdown + textarea closes it", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@";
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "@" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "users", detail: "public · table", token: "users" },
    ]);
    expect(mentionDropdown()).not.toBeNull();
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(mentionDropdown()).toBeNull();
  });
});

// ============================================================================
// #10 No apiKey material anywhere on the new messages
// ============================================================================
describe("AiChatPanelWebview — no apiKey across mention exchanges (TASK-005 #10)", () => {
  it("#10a typing @ + clicking dropdown + host reply: no apiKey-shaped strings", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    const prompt = promptEl();
    prompt.value = "@public.users secret_sk-123";
    prompt.setSelectionRange(13, 13);
    prompt.dispatchEvent(new KeyboardEvent("keyup", { key: "s" }));
    dispatchMentionObjects(harness, [
      { kind: "table", label: "public.users", detail: "public · table", token: "public.users" },
    ]);
    const allText = JSON.stringify(harness.received);
    // The webview's mention exchanges should never echo a sk-… or api_key
    // string. Note: the user's own prompt text contains `secret_sk-123`,
    // which is fine to carry on send — the assertion is that no NEW outbound
    // post shaped as mention_list or mention_objects carries apiKey
    // material.
    const newPosts = harness.received.filter(
      (m) => m.type === "mention_list" || m.type === "mention_objects",
    );
    const newText = JSON.stringify(newPosts);
    expect(newText).not.toMatch(/sk-[a-z0-9]/i);
    expect(newText).not.toMatch(/api_?key/i);
    void allText;
  });
});
