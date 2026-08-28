// src/ui/__tests__/aiChatPanelDbAwareWebview.test.ts — TASK-002 (cycle AD)
//
// Webview smoke for DB-aware tool permission requests. The webview already
// renders `permission_request` cards for any tool id/name/detail/options —
// the cycle AD DB-aware tools (count_rows, list_table_data_sample,
// run_readonly_query, explain_query, get_table_relationships) reuse the
// same wire shape and the same `.vsdb-chat-permission` card. This file
// pins that contract from the webview side:
//
//   * host posts permission_request with requestId `dbtool-…` + tool.name
//     `count_rows` + the standard 3 options → card renders with the
//     `.vsdb-chat-permission` class, the data-request-id attribute, a
//     `.vsdb-chat-permission-tool-name` node carrying the tool name, and
//     three buttons (allow once / allow session / deny).
//   * clicking Deny posts a `permission_response` back to the host with the
//     matching requestId and NO optionId field (matches webview
//     renderPermissionRequest — deny is the implicit "no optionId" wire).
//
// The harness mirrors src/ui/__tests__/aiChatPanelWebviewTask002.test.ts:
// @vitest-environment jsdom
// esbuild transpiles webview/aiChatPanelMain.ts to plain JS at module-load
// time, then we evaluate it inside a jsdom window with a stubbed
// acquireVsCodeApi. Each test starts with a clean DOM and a fresh
// `latestMessageHandler`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { vi } from "vitest";

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
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ============================================================================
// #1 DB-aware tool permission_request renders card with the standard shape
// ============================================================================
describe("AiChatPanelWebview — DB-aware tool permission_request card (cycle AD TASK-002)", () => {
  it("renders a card with .vsdb-chat-permission + data-request-id + 3 option buttons for count_rows", () => {
    const h = makeHarness();
    h.dispatch({
      type: "init",
      engine: { name: "builtin" },
      busy: false,
      attachmentsCapable: false,
      visionCapable: false,
      cwdLabel: "/workspace",
    });

    h.dispatch({
      type: "permission_request",
      requestId: "dbtool-1k7c-0",
      tool: {
        id: "dbtool:count_rows",
        name: "count_rows",
        detail: "schema=public table=users where=active=true",
      },
      options: [
        { optionId: "allow_once", label: "Allow once" },
        { optionId: "allow_session", label: "Allow session" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const card = h.root.querySelector(
      '.vsdb-chat-permission[data-request-id="dbtool-1k7c-0"]',
    );
    expect(card).not.toBeNull();
    if (!card) return;
    // The card carries the tool name verbatim in a dedicated node — that's
    // the DOM marker PLAN_AD.md §Acceptance #12 calls for.
    const nameNode = card.querySelector(".vsdb-chat-permission-tool-name");
    expect(nameNode?.textContent).toBe("count_rows");
    // Tool id is rendered alongside (matches the ACP card shape).
    const idNode = card.querySelector(".vsdb-chat-permission-tool-id");
    expect(idNode?.textContent).toBe("dbtool:count_rows");
    // Three buttons: allow once / allow session / deny — rendered with
    // the cycle AC class split (allow → primary, deny → secondary).
    const buttons = Array.from(
      card.querySelectorAll("button.vsdb-chat-permission-allow, button.vsdb-chat-permission-deny"),
    );
    expect(buttons.length).toBe(3);
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toEqual(["Allow once", "Allow session", "Deny"]);
    const deny = buttons.find((b) =>
      b.classList.contains("vsdb-chat-permission-deny"),
    );
    expect(deny).toBeDefined();
    expect(deny?.dataset.optionId).toBe("deny");
  });
});

// ============================================================================
// #2 Clicking Deny posts permission_response with matching requestId,
//    no optionId field (deny is the implicit default on the wire)
// ============================================================================
describe("AiChatPanelWebview — DB-aware tool Deny emits permission_response (cycle AD TASK-002)", () => {
  it("clicking Deny on a dbtool-… card posts {type:permission_response,requestId} with no optionId", () => {
    const h = makeHarness();
    h.dispatch({
      type: "init",
      engine: { name: "builtin" },
      busy: false,
      attachmentsCapable: false,
      visionCapable: false,
      cwdLabel: "/workspace",
    });

    h.dispatch({
      type: "permission_request",
      requestId: "dbtool-1k7c-0",
      tool: {
        id: "dbtool:count_rows",
        name: "count_rows",
        detail: "schema=public table=users",
      },
      options: [
        { optionId: "allow_once", label: "Allow once" },
        { optionId: "allow_session", label: "Allow session" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const card = h.root.querySelector<HTMLDivElement>(
      '.vsdb-chat-permission[data-request-id="dbtool-1k7c-0"]',
    );
    expect(card).not.toBeNull();
    if (!card) return;

    const deny = Array.from(
      card.querySelectorAll<HTMLButtonElement>(
        "button.vsdb-chat-permission-deny",
      ),
    ).find((b) => b.dataset.optionId === "deny");
    expect(deny).toBeDefined();
    deny!.click();

    // Exactly one permission_response — the deny path emits no optionId.
    const responses = h.received.filter(
      (m) => m.type === "permission_response",
    );
    expect(responses.length).toBe(1);
    const wire = responses[0];
    expect(wire.type).toBe("permission_response");
    expect(wire.requestId).toBe("dbtool-1k7c-0");
    expect(Object.prototype.hasOwnProperty.call(wire, "optionId")).toBe(
      false,
    );
    // Card is gone after the click — one response per visible request.
    expect(
      h.root.querySelector('.vsdb-chat-permission[data-request-id="dbtool-1k7c-0"]'),
    ).toBeNull();
    // A second click on a stale deny button (now orphaned) emits nothing.
    deny!.click();
    const responsesAfter = h.received.filter(
      (m) => m.type === "permission_response",
    );
    expect(responsesAfter.length).toBe(1);
  });
});

// ============================================================================
// #3 Allow Once echoes optionId on the wire
// ============================================================================
describe("AiChatPanelWebview — DB-aware tool Allow Once echoes optionId (cycle AD TASK-002)", () => {
  it("clicking Allow once posts {type:permission_response,requestId,optionId:'allow_once'}", () => {
    const h = makeHarness();
    h.dispatch({
      type: "init",
      engine: { name: "builtin" },
      busy: false,
      attachmentsCapable: false,
      visionCapable: false,
      cwdLabel: "/workspace",
    });

    h.dispatch({
      type: "permission_request",
      requestId: "dbtool-9zzz-3",
      tool: {
        id: "dbtool:run_readonly_query",
        name: "run_readonly_query",
        detail: "SELECT id FROM public.users LIMIT 5",
      },
      options: [
        { optionId: "allow_once", label: "Allow once" },
        { optionId: "allow_session", label: "Allow session" },
        { optionId: "deny", label: "Deny" },
      ],
    });

    const card = h.root.querySelector<HTMLDivElement>(
      '.vsdb-chat-permission[data-request-id="dbtool-9zzz-3"]',
    );
    expect(card).not.toBeNull();
    if (!card) return;

    const allowOnce = Array.from(
      card.querySelectorAll<HTMLButtonElement>(
        "button.vsdb-chat-permission-allow",
      ),
    ).find((b) => b.dataset.optionId === "allow_once");
    expect(allowOnce).toBeDefined();
    allowOnce!.click();

    const responses = h.received.filter(
      (m) => m.type === "permission_response",
    );
    expect(responses.length).toBe(1);
    expect(responses[0].type).toBe("permission_response");
    expect(responses[0].requestId).toBe("dbtool-9zzz-3");
    expect(responses[0].optionId).toBe("allow_once");
  });
});