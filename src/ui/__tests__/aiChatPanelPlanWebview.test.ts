// src/ui/__tests__/aiChatPanelPlanWebview.test.ts — TASK-AIX04-003
//
// Webview side of the plan_change consent card: host posts `change_plan`
// → the card renders intent, per-statement SQL + tier badge + dangerNote,
// drift lines, and Approve/Reject buttons. Approve is disabled while the
// plan is drifted. Buttons post plan_approve / plan_reject. DOM text only
// (no innerHTML on plan content).
//
// Harness mirrors aiChatPanelDbAwareWebview.test.ts.
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const sourcePath = resolve(process.cwd(), "webview", "aiChatPanelMain.ts");
const compiled = execFileSync(
  resolve(process.cwd(), "node_modules", ".bin", "esbuild"),
  ["--target=es2022", "--format=iife", "--bundle", sourcePath],
  { encoding: "utf8" },
).toString();

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface Harness {
  received: Array<Record<string, unknown>>;
  dispatch: (msg: Record<string, unknown>) => void;
  root: HTMLDivElement;
}

function makeHarness(): Harness {
  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg: unknown) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
    () => api;

  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-form-body"></div>';

  const originalAdd = window.addEventListener.bind(window);
  let latestMessageHandler: ((ev: MessageEvent) => void) | null = null;
  (window as unknown as { addEventListener: typeof originalAdd }).addEventListener =
    ((
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

  return {
    received,
    dispatch: (msg: Record<string, unknown>) => {
      latestMessageHandler?.({ data: msg } as MessageEvent);
    },
    root: document.getElementById("UnicDB-root") as HTMLDivElement,
  };
}

const planMsg = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  type: "change_plan",
  tool: "plan_change",
  plan: {
    intent: "add column c",
    statements: [
      { sql: "UPDATE users SET b = 1 WHERE a = 2", tier: "amber", dangerNote: "" },
      {
        sql: "DROP TABLE old_backup",
        tier: "red",
        dangerNote: "destructive — will be confirmed",
      },
    ],
    drift: [],
    drifted: false,
  },
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("webview — change_plan card", () => {
  it("renders intent, statements with tier + dangerNote, and approve/reject buttons", () => {
    const h = makeHarness();
    h.dispatch(planMsg());

    const cards = h.root.querySelectorAll(".UnicDB-chat-plan");
    expect(cards.length).toBe(1);
    const card = cards[0] as HTMLElement;
    expect(card.textContent).toContain("add column c");
    expect(card.textContent).toContain("UPDATE users SET b = 1 WHERE a = 2");
    expect(card.textContent).toContain("DROP TABLE old_backup");
    // dangerNote rendered
    expect(card.textContent).toContain("destructive — will be confirmed");
    // tier classes
    expect(card.querySelector(".UnicDB-chat-plan-tier-red")).not.toBeNull();
    expect(card.querySelector(".UnicDB-chat-plan-tier-amber")).not.toBeNull();
    // buttons
    const approve = card.querySelector<HTMLButtonElement>(".UnicDB-chat-plan-approve");
    const reject = card.querySelector<HTMLButtonElement>(".UnicDB-chat-plan-reject");
    expect(approve).not.toBeNull();
    expect(reject).not.toBeNull();
    expect(approve!.disabled).toBe(false);
  });

  it("renders drift lines and disables Approve when drifted", () => {
    const h = makeHarness();
    h.dispatch(
      planMsg({
        plan: {
          intent: "add column c",
          statements: [{ sql: "UPDATE users SET b = 1 WHERE a = 2", tier: "amber", dangerNote: "" }],
          drift: ["missing: c", "unexpected: x"],
          drifted: true,
        },
      }),
    );

    const card = h.root.querySelector(".UnicDB-chat-plan") as HTMLElement;
    expect(card.textContent).toContain("missing: c");
    const approve = card.querySelector<HTMLButtonElement>(".UnicDB-chat-plan-approve");
    expect(approve!.disabled).toBe(true);
  });

  it("Approve button posts plan_approve; Reject posts plan_reject", () => {
    const h = makeHarness();
    h.dispatch(planMsg());
    const card = h.root.querySelector(".UnicDB-chat-plan") as HTMLElement;
    (card.querySelector(".UnicDB-chat-plan-approve") as HTMLButtonElement).click();
    (card.querySelector(".UnicDB-chat-plan-reject") as HTMLButtonElement).click();

    expect(h.received.some((m) => m.type === "plan_approve")).toBe(true);
    expect(h.received.some((m) => m.type === "plan_reject")).toBe(true);
  });

  it("no innerHTML/outerHTML/insertAdjacentHTML on plan content (text-only)", () => {
    const h = makeHarness();
    // Hostile SQL in the plan must never become live markup.
    h.dispatch(
      planMsg({
        plan: {
          intent: "<img src=x onerror=alert(1)>",
          statements: [
            {
              sql: "<script>alert('xss')</script>",
              tier: "red",
              dangerNote: "<b>bold</b>",
            },
          ],
          drift: [],
          drifted: false,
        },
      }),
    );
    const card = h.root.querySelector(".UnicDB-chat-plan") as HTMLElement;
    expect(card.querySelector("script")).toBeNull();
    expect(card.querySelector("img")).toBeNull();
    // raw text preserved verbatim
    expect(card.textContent).toContain("<script>alert('xss')</script>");
  });
});
