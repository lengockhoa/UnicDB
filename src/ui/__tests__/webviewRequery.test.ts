// src/ui/__tests__/webviewRequery.test.ts
// TASK-504 — bundle-eval integration test for the WHERE/ORDER BY "Re-Run"
// bar in the persistent grid toolbar.
//
// Loads dist/webview.js into jsdom, stubs acquireVsCodeApi + ResizeObserver
// + matchMedia, then dispatches a state message and asserts:
//   1. The requery bar (WHERE / ORDER BY inputs + Re-Run + Clear buttons)
//      renders once the grid is active.
//   2. Clicking "Re-Run" with WHERE / ORDER BY text posts a `requery`
//      message with the right shape.
//   3. "Clear" empties both inputs.
//
// Mirrors the bundle pattern from webviewExport.test.ts. Skipped when
// dist/webview.js is missing — `npm run compile` must run first.
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs for AG Grid browser APIs ---------------------------
type ResizeObserverLike = {
  observe(): void;
  unobserve(): void;
  disconnect(): void;
};
type MediaQueryListLike = {
  matches: boolean;
  media: string;
  onchange: null;
  addListener(): void;
  removeListener(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
};

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: unknown;
    matchMedia?: unknown;
  };
  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserverLike;
  }
  if (typeof g.matchMedia === "undefined") {
    const factory = (query: string): MediaQueryListLike => ({
      matches: false,
      media: query,
      onchange: null,
      addListener(): void {},
      removeListener(): void {},
      addEventListener(): void {},
      removeEventListener(): void {},
      dispatchEvent(): boolean {
        return false;
      },
    });
  }
});

// ---- bundle loading --------------------------------------------------------

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

function loadBundle(): {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-webview"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);
  return { received, root };
}

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function selectState(): Record<string, unknown> {
  return {
    type: "state",
    header: "test.sql",
    busy: false,
    results: [
      {
        index: 0,
        sql: "SELECT * FROM t",
        status: "done",
        result: {
          columns: ["id", "name"],
          rows: [
            [1, "alpha"],
            [2, "beta"],
          ],
          rowCount: 2,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts WHERE/ORDER BY requery bar (TASK-504)", () => {
  itIfBundle("1. requery bar renders WHEN the grid is active (WHERE / ORDER BY inputs + Re-Run + Clear)", () => {
    const { root, received } = loadBundle();
    dispatchState(selectState());
    void received;

    const whereInput = root.querySelector(
      ".vsdb-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".vsdb-requery-order",
    ) as HTMLInputElement | null;
    const runBtn = root.querySelector(
      ".vsdb-requery-run",
    ) as HTMLButtonElement | null;
    const clearBtn = root.querySelector(
      ".vsdb-requery-clear",
    ) as HTMLButtonElement | null;

    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();
    expect(runBtn).toBeTruthy();
    expect(clearBtn).toBeTruthy();
    expect(whereInput!.tagName).toBe("INPUT");
    expect(orderInput!.tagName).toBe("INPUT");
  });

  itIfBundle("2. Click Re-Run → posts { type:'requery', index, where, orderBy }", () => {
    const { root, received } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".vsdb-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".vsdb-requery-order",
    ) as HTMLInputElement | null;
    const runBtn = root.querySelector(
      ".vsdb-requery-run",
    ) as HTMLButtonElement | null;

    whereInput!.value = "id > 1";
    orderInput!.value = "id DESC";
    runBtn!.click();

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "id > 1",
      orderBy: "id DESC",
    });
  });

  itIfBundle("3. Empty WHERE / ORDER BY → requery message carries empty strings", () => {
    const { root, received } = loadBundle();
    dispatchState(selectState());

    const runBtn = root.querySelector(
      ".vsdb-requery-run",
    ) as HTMLButtonElement | null;
    runBtn!.click();

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
    });
  });

  itIfBundle("4. Clear button empties both inputs", () => {
    const { root, received } = loadBundle();
    dispatchState(selectState());
    void received;

    const whereInput = root.querySelector(
      ".vsdb-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".vsdb-requery-order",
    ) as HTMLInputElement | null;
    const clearBtn = root.querySelector(
      ".vsdb-requery-clear",
    ) as HTMLButtonElement | null;

    whereInput!.value = "x = 1";
    orderInput!.value = "y DESC";
    clearBtn!.click();
    expect(whereInput!.value).toBe("");
    expect(orderInput!.value).toBe("");
  });
});