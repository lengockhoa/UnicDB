// src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts — TASK-AIX05-001
//
// Webview side of the OMP session-state chip: host posts `session_state`
// → a `#sessionChip` element renders the state label (Connecting… /
// Running… / Done / Error), textContent-only (no child nodes, no
// innerHTML). Harness mirrors aiChatPanelPlanWebview.test.ts.
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

const stateMsg = (
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  type: "session_state",
  state: "connecting",
  turnId: "1",
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = "";
});

;

describe("webview — usage chip (TASK-ARP06-005)", () => {
  const usageMsg = (
    over: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    type: "usage",
    inputTokens: 12,
    outputTokens: 34,
    unknown: false,
    sessionTokens: { inputTokens: 100, outputTokens: 200 },
    policyNotice: "",
    ...over,
  });

  it("renders token counts into the usage chip", () => {
    const h = makeHarness();
    h.dispatch(usageMsg());
    const chip = h.root.querySelector("#usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("12");
    expect(chip!.textContent).toContain("34");
    expect(chip!.textContent).toContain("100");
    expect(chip!.textContent).toContain("200");
    expect(chip!.className).toContain("UnicDB-chat-usage");
  });

  it("renders the unknown state instead of invented totals", () => {
    const h = makeHarness();
    h.dispatch(usageMsg({ unknown: true, inputTokens: 0, outputTokens: 0 }));
    const chip = h.root.querySelector("#usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toMatch(/unknown/i);
    // The turn's zeros must not read as a confirmed zero-cost turn — the
    // turn label is "unknown", not "0 in / 0 out". (Session totals may
    // legitimately show 0s when nothing was ever reported.)
    expect(chip!.textContent).not.toMatch(/Turn: 0 in/i);
  });

  it("renders a non-empty policyNotice on the chip", () => {
    const h = makeHarness();
    h.dispatch(
      usageMsg({
        policyNotice:
          "UnicDB AI policy: sensitive AI capabilities are unavailable — workspace is not trusted.",
      }),
    );
    const chip = h.root.querySelector("#usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("UnicDB AI policy");
  });

  it("accumulates across turns — second usage frame shows the running session totals", () => {
    const h = makeHarness();
    h.dispatch(
      usageMsg({
        inputTokens: 10,
        outputTokens: 20,
        sessionTokens: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    h.dispatch(
      usageMsg({
        inputTokens: 5,
        outputTokens: 7,
        sessionTokens: { inputTokens: 15, outputTokens: 27 },
      }),
    );
    const chip = h.root.querySelector("#usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("15");
    expect(chip!.textContent).toContain("27");
  });

  it("chip is textContent-only — no child nodes on hostile numeric/string values", () => {
    const h = makeHarness();
    // Hostile values: markup-shaped strings must never become live DOM.
    h.dispatch(
      usageMsg({
        policyNotice: "<img src=x onerror=alert(1)>",
        inputTokens: Number.NaN,
      }),
    );
    const chip = h.root.querySelector("#usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.querySelectorAll("*").length).toBe(0);
    expect(chip!.innerHTML).not.toContain("<img");
    // The hostile notice string is never rendered verbatim as markup.
    expect(chip!.innerHTML).not.toContain("<");
  });
});

describe("webview — usage/engine chips mount in the V2 header (TASK-CHATUX2-001)", () => {
  const usageMsg = (
    over: Partial<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    type: "usage",
    inputTokens: 12,
    outputTokens: 34,
    unknown: false,
    sessionTokens: { inputTokens: 100, outputTokens: 200 },
    policyNotice: "",
    ...over,
  });

  it("applyUsage writes #usageChip into #UnicDB-ai-chat-v2-usage, never as a root child", () => {
    const h = makeHarness();
    const usageEl = document.getElementById("UnicDB-ai-chat-v2-usage");
    expect(usageEl, "V2 header usage span must exist after boot").not.toBeNull();
    expect(usageEl!.hidden, "usage span starts hidden until its first frame").toBe(true);

    h.dispatch(usageMsg());

    const chip = document.getElementById("usageChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.parentElement).toBe(usageEl);
    expect(usageEl!.hidden, "first usage frame unhides the header span").toBe(false);
    expect(chip!.textContent).toContain("Turn: 12 in / 34 out");
    expect(chip!.textContent).toContain("Session: 100 in / 200 out");
    // Never an implicit grid child stacked under the composer.
    expect(chip!.parentElement).not.toBe(h.root);
    expect(
      Array.from(h.root.children).some(
        (el) => el.id === "usageChip" || el.id === "engineLifecycle",
      ),
    ).toBe(false);
  });

  it("applyEngineState writes #engineLifecycle into #UnicDB-ai-chat-v2-engine-state, never as a root child", () => {
    const h = makeHarness();
    const stateEl = document.getElementById("UnicDB-ai-chat-v2-engine-state");
    expect(stateEl, "V2 header engine-state span must exist after boot").not.toBeNull();
    expect(stateEl!.hidden, "engine-state span starts hidden").toBe(true);

    h.dispatch({ type: "engine_state", state: "ready" });

    const chip = document.getElementById("engineLifecycle") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.parentElement).toBe(stateEl);
    expect(stateEl!.hidden, "first engine_state frame unhides the header span").toBe(false);
    expect(chip!.textContent).toBe("Ready");
    expect(chip!.parentElement).not.toBe(h.root);
    expect(
      Array.from(h.root.children).some(
        (el) => el.id === "usageChip" || el.id === "engineLifecycle",
      ),
    ).toBe(false);
  });
});
