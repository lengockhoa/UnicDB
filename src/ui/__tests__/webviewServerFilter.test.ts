// src/ui/__tests__/webviewServerFilter.test.ts
// TASK-005 — webview server-side filter + Load More paging integration.
//
// Cases 9-12 and 14 of the TASK-005 test matrix. Loads dist/webview.js
// (built via `npm run compile`) into jsdom, stubs acquireVsCodeApi +
// ResizeObserver + matchMedia, dispatches state messages and drives the
// AG Grid set-filter + load-more hooks to assert the host-ward messages.
//
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    ResizeObserver?: new () => ResizeObserverLike;
    matchMedia?: (q: string) => MediaQueryListLike;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver implements ResizeObserverLike {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as new () => ResizeObserverLike;
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
    g.matchMedia = factory;
  }
});

// ---- bundle loading --------------------------------------------------------

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbGlobals {
  gridApi?: GridApi;
}

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

function loadBundle(): {
  received: Array<Record<string, unknown>>;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }

  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-webview"></div>';

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

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function getGridApi(): GridApi | null {
  const w = window as unknown as { __vsdb?: VsdbGlobals };
  return w.__vsdb?.gridApi ?? null;
}

function selectState(args: {
  results: Array<Record<string, unknown>>;
  busy?: boolean;
}): Record<string, unknown> {
  return {
    type: "state",
    header: "test.sql",
    busy: args.busy ?? false,
    ...args,
  };
}

function rowsState(
  columns: string[],
  rows: Array<Array<unknown>>,
  options: { batched?: boolean; rowCount?: number | null } = {},
): Record<string, unknown> {
  return selectState({
    results: [
      {
        index: 0,
        sql: "SELECT * FROM t",
        status: "done",
        result: {
          columns,
          rows,
          rowCount: options.rowCount === undefined ? rows.length : options.rowCount,
          durationMs: 1,
        },
        batched: !!options.batched,
        durationMs: 1,
      },
    ],
  });
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Wait past the 150ms filter-requery debounce so the collapsed requery
 *  has been posted. */
async function flushFilterDebounce(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function requeries(received: Array<Record<string, unknown>>) {
  return received.filter((m) => m.type === "requery") as Array<
    Record<string, unknown>
  >;
}

describeIfBundle("webview/main.ts bundle — TASK-005 server-side filter", () => {
  itIfBundle(
    "9. clearing every filter re-requeries unfiltered (filters absent, append falsy)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(["id", "name"], [[1, "alpha"], [2, "beta"], [3, "gamma"]]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // First apply a real filter so a server requery with filters fires.
      api!.setFilterModel({ name: { values: ["beta"] } });
      await flushFilterDebounce();
      expect(requeries(received).length).toBe(1);

      // Now clear every filter.
      received.length = 0;
      api!.setFilterModel(null);
      await flushFilterDebounce();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      const filters = rq[0]!.filters;
      expect(filters === undefined || Object.keys(filters).length === 0).toBe(
        true,
      );
      expect(rq[0]!.append).toBeFalsy();
      expect(rq[0]!.offset).toBeUndefined();
    },
  );

  itIfBundle(
    "10. Load More while a filter is active posts a paged requery, not a loadMore",
    async () => {
      const { received } = loadBundle();
      const rows = Array.from({ length: 500 }, (_, i) => [i, `name-${i}`]);
      dispatchState(
        rowsState(["id", "name"], rows, { batched: true, rowCount: null }),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: ["name-0"] } });
      // Consume the debounced filter-change requery before driving Load More.
      await flushFilterDebounce();
      received.length = 0;

      const hook = (window as unknown as {
        __vsdbCheckLoadMoreForHost?: () => void;
      }).__vsdbCheckLoadMoreForHost;
      expect(typeof hook).toBe("function");
      hook!();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(received.filter((m) => m.type === "loadMore")).toHaveLength(0);
      expect(rq[0]!.append).toBe(true);
      expect(rq[0]!.offset).toBe(500);
      expect((rq[0]!.filters as { name?: { values?: string[] } }).name?.values).toContain(
        "name-0",
      );
    },
  );

  itIfBundle(
    "11. rapid filter changes collapse into one requery (debounce)",
    async () => {
      vi.useFakeTimers();
      try {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [[1, "alpha"], [2, "beta"], [3, "gamma"]]),
        );
        await vi.advanceTimersByTimeAsync(0);
        const api = getGridApi();
        expect(api).toBeTruthy();

        for (let i = 0; i < 5; i++) {
          api!.setFilterModel({ name: { values: [`v${i}`] } });
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(300);

        expect(requeries(received)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  itIfBundle(
    "12. posted filter model carries typed values beside display values (same length, raw numbers)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [42, "alpha"],
            [7, "beta"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ id: { values: ["42", "7"] } });
      await flushFilterDebounce();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      const model = rq[0]!.filters as {
        id?: { values: string[]; typed?: unknown[] };
      };
      const typed = model.id!.typed!;
      expect(typed).toHaveLength(model.id!.values.length);
      expect(typeof typed[0]).toBe("number");
      expect(typed[0]).toBe(42);
      expect(typed[1]).toBe(7);
    },
  );

  itIfBundle(
    "14. a selected display value with no loaded row → typed omitted for that column",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // "zzz" has no matching loaded row → typed must be dropped wholesale,
      // never a length-mismatched or undefined-padded array.
      api!.setFilterModel({ name: { values: ["alpha", "zzz"] } });
      await flushFilterDebounce();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      const model = rq[0]!.filters as {
        name?: { values: string[]; typed?: unknown[] };
      };
      expect(model.name!.typed).toBeUndefined();
      expect(model.name!.values).toEqual(["alpha", "zzz"]);
    },
  );
});
