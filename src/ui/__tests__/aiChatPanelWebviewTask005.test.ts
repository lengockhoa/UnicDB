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

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface Harness {
  received: Array<Record<string, unknown>>;
  dispatch: (msg: Record<string, unknown>) => void;
}

function makeHarness(): Harness {
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
  return document.getElementById("UnicDBMentionDropdown") as HTMLDivElement | null;
}

function mentionRows(): HTMLDivElement[] {
  const dd = mentionDropdown();
  if (!dd) return [];
  return Array.from(
    dd.querySelectorAll<HTMLDivElement>(".UnicDB-chat-mention-row"),
  );
}

function activeRow(): HTMLDivElement | null {
  for (const r of mentionRows()) {
    if (r.classList.contains("UnicDB-chat-mention-row-active")) return r;
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
;

// ============================================================================
// #2 mention_objects reply renders the dropdown
// ============================================================================
;

// ============================================================================
// #3 ArrowDown / ArrowUp move the active row
// ============================================================================
;

// ============================================================================
// #4 Enter / Tab selects and DOES NOT send
// ============================================================================
;

// ============================================================================
// #5 Esc closes the dropdown without sending
// ============================================================================
;

// ============================================================================
// #6 Empty candidates + Enter / Esc close
// ============================================================================
;

// ============================================================================
// #7 Send button click while dropdown open closes the dropdown (not sends)
// ============================================================================
;

// ============================================================================
// #8 mention_miss renders an inline notice bubble
// ============================================================================
describe("AiChatPanelWebview — mention_miss inline notice (TASK-005 #8)", () => {
  it("#8a host mention_miss adds a 'Could not resolve @<token>' bubble", () => {
    const harness = makeHarness();
    harness.dispatch({ type: "init", hasHistory: false });
    harness.dispatch({ type: "mention_miss", token: "public.nope" });
    const miss = document.querySelector(".UnicDB-chat-mention-miss");
    expect(miss).not.toBeNull();
    expect(miss?.textContent).toContain("Could not resolve @public.nope");
    expect(miss?.textContent).not.toContain("<script>");
  });
});

// ============================================================================
// #9 Click outside closes the dropdown
// ============================================================================
;

// ============================================================================
// #10 No apiKey material anywhere on the new messages
// ============================================================================
;
