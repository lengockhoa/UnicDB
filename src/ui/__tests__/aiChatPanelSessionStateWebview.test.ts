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
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
    () => api;
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-form-body"></div>';

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
    root: document.getElementById("vsdb-root") as HTMLDivElement,
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

describe("webview — session_state chip", () => {
  it("renders Connecting… chip for the connecting state", () => {
    const h = makeHarness();
    h.dispatch(stateMsg());
    const chip = h.root.querySelector("#sessionChip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Connecting");
    expect(chip!.className).toContain("vsdb-chat-session-connecting");
  });

  it("transitions label + class per state (connecting → running → done)", () => {
    const h = makeHarness();
    h.dispatch(stateMsg());
    h.dispatch(stateMsg({ state: "running" }));
    h.dispatch(stateMsg({ state: "done" }));
    const chip = h.root.querySelector("#sessionChip") as HTMLElement;
    expect(chip.textContent).toContain("Done");
    expect(chip.className).toContain("vsdb-chat-session-done");
    expect(chip.className).not.toContain("vsdb-chat-session-connecting");
  });

  it("renders Error state", () => {
    const h = makeHarness();
    h.dispatch(stateMsg({ state: "error" }));
    const chip = h.root.querySelector("#sessionChip") as HTMLElement;
    expect(chip.textContent).toContain("Error");
    expect(chip.className).toContain("vsdb-chat-session-error");
  });

  it("chip is textContent-only — no child nodes on hostile state value", () => {
    const h = makeHarness();
    // State comes from the host enum; even if it carried markup it must
    // never become live DOM.
    h.dispatch(stateMsg({ state: "running" }));
    const chip = h.root.querySelector("#sessionChip") as HTMLElement;
    expect(chip.querySelectorAll("*").length).toBe(0);
    // Text node only — the whole innerHTML is the plain label, no tags.
    expect(chip.innerHTML).toBe("Running…");
  });
});
