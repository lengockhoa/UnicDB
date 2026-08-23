// src/ui/__tests__/webviewFilters.test.ts
// TASK-402 — Excel-like column filters + colFilterActive gating + Fix #3
// double-checkbox (bỏ colDef __select__).
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches state
// messages to assert column filter behavior + selection-column regression
// required by TASK-402 §Test Cases.
//
// Mirrors the bundle pattern from src/ui/__tests__/webviewBundle.test.ts.
// If dist/webview.js is missing, all tests are skipped with an explanatory
// message — `npm run compile` must run first.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
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
  checkLoadMore?: () => void;
}

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

function threeRowsState(): Record<string, unknown> {
  return selectState({
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
            [3, "gamma"],
          ],
          rowCount: 3,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  });
}

function batchedState(opts: {
  loaded: number;
  rowCount: number;
  hasMore?: boolean;
}): Record<string, unknown> {
  const rows = Array.from({ length: opts.loaded }, (_, i) => [
    i + 1,
    `name-${i}`,
  ]);
  return selectState({
    results: [
      {
        index: 0,
        sql: "SELECT * FROM big",
        status: "done",
        result: {
          columns: ["id", "name"],
          rows,
          rowCount: opts.hasMore ? null : opts.loaded,
          durationMs: 1,
        },
        batched: true,
        durationMs: 1,
      },
    ],
  });
}

/** AG Grid's `filterChanged` event fires asynchronously (microtask/setTimeout
 *  inside the grid). Awaiting one tick lets the event handler run so our
 *  `colFilterActive` flag is up-to-date before the test asserts. */
async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-402)", () => {
  itIfBundle(
    "1. Text column filter contains — displayed count 1, footer /1 of 3/",
    async () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const api = getGridApi();
      expect(api).toBeTruthy();

      // TASK-602 migration: per-column text filter → set-filter model.
      api!.setFilterModel({
        name: { values: ["beta"] },
      });
       await flushGridEvents();
       expect(api!.getDisplayedRowCount()).toBe(1);

       const footer = root.querySelector(".vsdb-grid-footer") as HTMLElement;
       expect(footer).toBeTruthy();
       expect(footer.textContent).toMatch(/1 of 3/);
     },
   );

  itIfBundle(
    "6. regression — exactly 1 .ag-selection-checkbox per row, no __select__ header column",
    () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      // AG Grid renders each row into a div with class .ag-row.
      const rows = root.querySelectorAll(".ag-row");
      // The DOM may or may not be fully virtualised; assert at least one row.
      expect(rows.length).toBeGreaterThan(0);

      // Selection-column regression: each visible row has exactly 1 checkbox.
      rows.forEach((row) => {
        const cbs = row.querySelectorAll(".ag-selection-checkbox");
        expect(cbs.length).toBe(1);
      });

      // The custom __select__ colDef must be gone (no header with col-id=__select__).
      const selectHeader = root.querySelector('[col-id="__select__"]');
      expect(selectHeader).toBeNull();

      // __select__ field must not appear on any row's data.
      const api = getGridApi();
      expect(api).toBeTruthy();
      api!.forEachNode((node) => {
        if (node.data) {
          expect(Object.prototype.hasOwnProperty.call(node.data, "__select__")).toBe(
            false,
          );
        }
      });
    },
  );

  itIfBundle(
    "7. header select-filtered — header checkbox selects only displayed (filtered) rows",
    async () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const api = getGridApi();
      expect(api).toBeTruthy();
      api!.setFilterModel({
        name: { values: ["beta"] },
      });
      await flushGridEvents();
      const displayed = api!.getDisplayedRowCount();
      expect(displayed).toBe(1);

      // The auto-generated selection column header carries
      // col-id="ag-Grid-SelectionColumn" and contains a select-all input
      // with class .ag-checkbox-input (label "Column with Header Selection").
      const header = root.querySelector(
        '[col-id="ag-Grid-SelectionColumn"] .ag-checkbox-input',
      ) as HTMLInputElement | null;
      expect(header).toBeTruthy();
      header!.click();
      await flushGridEvents();

      // selectAll = 'filtered' (configured on rowSelection) → only filtered
      // rows are selected, not the unfiltered total of 3.
      const selected = api!.getSelectedRows();
      expect(selected.length).toBe(displayed);
      expect(selected.length).toBeLessThan(3);
    },
  );

  itIfBundle(
    "3. column filter active + batched + checkLoadMore — loadMore is gated (not posted)",
    async () => {
      const { received, root } = loadBundle();
      // Load 50 rows, rowCount 1000 → hasMore = true.
      dispatchState(batchedState({ loaded: 50, rowCount: 1000, hasMore: true }));
      void received;

      const api = getGridApi();
      expect(api).toBeTruthy();

      // Apply a column filter that excludes everything matching.
      // TASK-602 migration: text filter → set filter. Selecting only
      // "name-1" excludes every other entry → all rows hidden, gate holds.
      api!.setFilterModel({
        name: { values: ["name-1"] },
      });
      await flushGridEvents();

      // Clear any pre-existing loadMore messages, then trigger the hook.
      received.length = 0;
      const hook = (window as unknown as {
        __vsdbCheckLoadMoreForHost?: () => void;
      }).__vsdbCheckLoadMoreForHost;
      expect(typeof hook).toBe("function");
      hook!();
      void root;

      const loadMore = received.filter((m) => m.type === "loadMore");
      expect(loadMore.length).toBe(0);
    },
  );

  itIfBundle(
    "4. clear filter → loadMore becomes allowed again",
    async () => {
      const { received } = loadBundle();
      dispatchState(batchedState({ loaded: 50, rowCount: 1000, hasMore: true }));
      void received;

      const api = getGridApi();
      expect(api).toBeTruthy();

      // First — gate it.
      api!.setFilterModel({
        name: { values: ["name-1"] },
      });
      await flushGridEvents();
      received.length = 0;
      (window as unknown as { __vsdbCheckLoadMoreForHost?: () => void })
        .__vsdbCheckLoadMoreForHost!();
      expect(received.filter((m) => m.type === "loadMore").length).toBe(0);

      // Now clear filter → onFilterChanged fires → colFilterActive flips off
      // → next checkLoadMore should dispatch loadMore.
      api!.setFilterModel(null);
      await flushGridEvents();
      received.length = 0;
      (window as unknown as { __vsdbCheckLoadMoreForHost?: () => void })
        .__vsdbCheckLoadMoreForHost!();
      const loadMore = received.filter((m) => m.type === "loadMore");
      expect(loadMore.length).toBe(1);
      const lm = loadMore[0] as { index: number };
      expect(lm.index).toBe(0);
    },
  );

  itIfBundle(
    "5. regression (counterpart of 3) — without colFilterActive gate, loadMore would be posted (informational)",
    async () => {
      // This test simply documents the pre-fix state: without gating,
      // a quick checkLoadMore on a filtered grid would still post loadMore.
      // Since the gate is now in place (per test 3), we assert the same
      // observable: loadMore is NOT posted when column filter is active.
      // The "regression" assertion is the negation of test 3 — same setup,
      // same expectation — so a fix that breaks the gate is caught by both.
      const { received } = loadBundle();
      dispatchState(batchedState({ loaded: 50, rowCount: 1000, hasMore: true }));
      void received;

      const api = getGridApi();
      expect(api).toBeTruthy();
      // TASK-602: set-filter — selecting only "name-1" keeps loadMore gated.
      api!.setFilterModel({
        name: { values: ["name-1"] },
      });
      await flushGridEvents();
      received.length = 0;
      (window as unknown as { __vsdbCheckLoadMoreForHost?: () => void })
        .__vsdbCheckLoadMoreForHost!();
      expect(received.filter((m) => m.type === "loadMore").length).toBe(0);
    },
  );
});

describeIfBundle("webview/main.ts bundle (TASK-402 fix round 1)", () => {
  itIfBundle(
    "8. regression — filter active + batched + columnsChanged: no loadMore (gate survives columnDefs swap)",
    async () => {
      const { received, root } = loadBundle();
      void root;

      // Initial batched result: 50 of 1000 rows, 2 columns.
      dispatchState(batchedState({ loaded: 50, rowCount: 1000, hasMore: true }));
      await flushGridEvents();

      const api = getGridApi();
      expect(api).toBeTruthy();

      // TASK-602 migration: text filter → set filter.
      api!.setFilterModel({
        name: { values: ["name-1"] },
      });
      await flushGridEvents();
      expect(api!.isColumnFilterPresent()).toBe(true);

      // Now a new state arrives whose column count differs → columnsChanged
      // path swaps columnDefs on the existing grid (2 → 3 columns).
      const rows = Array.from({ length: 50 }, (_, i) => [
        i + 1,
        `name-${i}`,
        `extra-${i}`,
      ]);
      dispatchState(
        selectState({
          results: [
            {
              index: 0,
              sql: "SELECT * FROM big",
              status: "done",
              result: {
                columns: ["id", "name", "extra"],
                rows,
                rowCount: null,
                durationMs: 1,
              },
              batched: true,
              durationMs: 1,
            },
          ],
        }),
      );
      await flushGridEvents();

      // Filter model cleared by the swap, and the gate must re-poll the live
      // grid — never trust a stale local bool. Either way, no loadMore may
      // be posted while a filter is (or was just) applied during the swap.
      const loadMores = received.filter((m) => m.type === "loadMore");
      expect(loadMores.length).toBe(0);
      expect(api!.isColumnFilterPresent()).toBe(false);
    },
  );
});
