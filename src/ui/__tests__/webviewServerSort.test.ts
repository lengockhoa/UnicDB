// src/ui/__tests__/webviewServerSort.test.ts
// TASK-003 — header-click sort posts a server-side requery.
//
// Cases 1-6, 15, 16 of the TASK-003 test matrix. Loads dist/webview.js
// (built via `npm run compile`) into jsdom, drives AG Grid column state
// (applyColumnState — the same path a header click takes) and asserts the
// posted `requery` messages, including the colId quoting rule (bare
// identifiers pass through; anything else is quoted per the driver parsed
// from the state header, postgres double-quote on fallback).
//
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
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

function rowsState(
  header: string,
  columns: string[],
  rows: Array<Array<unknown>>,
): Record<string, unknown> {
  return {
    type: "state",
    header,
    busy: false,
    results: [
      {
        index: 0,
        sql: "SELECT * FROM t",
        status: "done",
        result: {
          columns,
          rows,
          rowCount: rows.length,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Header string shape the host builds: `Run at <ISO> — <driver>@<host>/<db>`. */
function driverHeader(driver: string): string {
  return `Run at 2026-08-26T00:00:00.000Z — ${driver}@localhost/db`;
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

function requeries(received: Array<Record<string, unknown>>) {
  return received.filter((m) => m.type === "requery") as Array<
    Record<string, unknown>
  >;
}

describeIfBundle("webview/main.ts bundle — TASK-003 server-side sort", () => {
  itIfBundle(
    "1. header sort posts a server requery (orderBy name ASC, index 0)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["id", "name"], [
          [1, "beta"],
          [2, "alpha"],
        ]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();
      received.length = 0;

      api!.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("name ASC");
      expect(rq[0]!.index).toBe(0);
    },
  );

  itIfBundle("2. descending sort posts orderBy name DESC", async () => {
    const { received } = loadBundle();
    dispatchState(
      rowsState(driverHeader("postgres"), ["id", "name"], [
        [1, "alpha"],
        [2, "beta"],
      ]),
    );
    await flushGridEvents();
    const api = getGridApi();
    expect(api).toBeTruthy();
    received.length = 0;

    api!.applyColumnState({
      state: [{ colId: "name", sort: "desc", sortIndex: 0 }],
    });
    await flushGridEvents();

    const rq = requeries(received);
    expect(rq).toHaveLength(1);
    expect(rq[0]!.orderBy).toBe("name DESC");
  });

  itIfBundle(
    "3. multi-column sort honours sortIndex, not colId order (a ASC, b DESC)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["a", "b"], [
          [1, 2],
          [3, 4],
        ]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();
      received.length = 0;

      // colId order deliberately reversed vs sortIndex order.
      api!.applyColumnState({
        state: [
          { colId: "b", sort: "desc", sortIndex: 1 },
          { colId: "a", sort: "asc", sortIndex: 0 },
        ],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("a ASC, b DESC");
    },
  );

  itIfBundle(
    "4. clearing the sort posts exactly one requery with orderBy ''",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["id", "name"], [
          [1, "beta"],
          [2, "alpha"],
        ]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(received).length).toBe(1);

      received.length = 0;
      api!.applyColumnState({ state: [{ colId: "name", sort: null }] });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("");
    },
  );

  itIfBundle(
    "5. sort composes with an active filter (orderBy AND filters together)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["id", "name"], [
          [1, "alpha"],
          [2, "beta"],
          [3, "gamma"],
        ]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // Activate a set filter first; consume its (debounced) requery.
      // Wait past the 150ms debounce, then DRAIN any requery posts so the
      // sort assertion below sees only the sort post. (The debounce timer
      // firing late relative to the wait window made `received.length = 0`
      // unreliable — a second post could land after the sort.)
      api!.setFilterModel({ name: { values: ["beta"] } });
      await new Promise<void>((r) => setTimeout(r, 250));
      while (requeries(received).length > 0) {
        received.length = 0;
        await new Promise<void>((r) => setTimeout(r, 50));
      }

      api!.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("name ASC");
      expect(rq[0]!.filters).toBeDefined();
    },
  );

  itIfBundle(
    "6. host-driven column-state restore posts nothing (suppressSortRequery)",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["id", "name"], [
          [1, "beta"],
          [2, "alpha"],
        ]),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();
      received.length = 0;

      // The webview restores the host-supplied sort after a state message —
      // a user click never went through this path, so nothing may be posted.
      const w = window as unknown as {
        __vsdb?: { applyHostColumnState?: (s: unknown[]) => void };
      };
      expect(typeof w.__vsdb!.applyHostColumnState).toBe("function");
      w.__vsdb!.applyHostColumnState!([
        { colId: "name", sort: "asc", sortIndex: 0 },
      ]);
      await flushGridEvents();

      expect(received.filter((m) => m.type === "requery")).toHaveLength(0);
    },
  );

  itIfBundle(
    "15. non-bare colId is quoted per dialect before sending",
    async () => {
      const dialects: Array<[string, string]> = [
        ["postgres", '"First Name" ASC'],
        ["mysql", "`First Name` ASC"],
        ["mssql", "[First Name] ASC"],
      ];
      for (const [driver, expected] of dialects) {
        const { received } = loadBundle();
        dispatchState(
          rowsState(driverHeader(driver), ["id", "First Name"], [
            [1, "beta"],
            [2, "alpha"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();
        received.length = 0;

        api!.applyColumnState({
          state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe(expected);
      }
    },
  );

  itIfBundle(
    "TASK-007. duplicate column sort posts the real column name",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(driverHeader("postgres"), ["id", "id"], [
          [1, 10],
          [2, 20],
        ]),
      );
      await flushGridEvents();
      const w = window as unknown as {
        __vsdb?: {
          debugSetSpecs?: (specs: unknown[]) => void;
          gridApi?: GridApi;
        };
      };
      expect(typeof w.__vsdb?.debugSetSpecs).toBe("function");
      w.__vsdb!.debugSetSpecs!([
        { field: "id", headerName: "id", kind: "number" },
        { field: "id__2", headerName: "id", kind: "number" },
      ]);
      received.length = 0;

      w.__vsdb!.gridApi!.applyColumnState({
        state: [{ colId: "id__2", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      expect(requeries(received)).toHaveLength(1);
      expect(requeries(received)[0]!.orderBy).toBe("id ASC");
      expect(requeries(received)[0]!.orderBy).not.toContain("id__2");
    },
  );

  itIfBundle(
    "TASK-007. Browse header dialect drives non-bare sort quoting",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(
          "Browse public.users at 2026-01-01T00:00:00.000Z — mysql@h/db",
          ["id", "First Name"],
          [[1, "alpha"]],
        ),
      );
      await flushGridEvents();
      const w = window as unknown as { __vsdb?: { gridApi?: GridApi } };
      received.length = 0;
      w.__vsdb!.gridApi!.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(received)[0]!.orderBy).toBe("`First Name` ASC");

      const legacy = loadBundle();
      dispatchState(
        rowsState(
          "Browse public.users at 2026-01-01T00:00:00.000Z",
          ["id", "First Name"],
          [[1, "alpha"]],
        ),
      );
      await flushGridEvents();
      const legacyApi = (window as unknown as { __vsdb?: { gridApi?: GridApi } }).__vsdb!.gridApi!;
      legacy.received.length = 0;
      legacyApi.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(legacy.received)[0]!.orderBy).toBe('"First Name" ASC');
    },
  );

  itIfBundle(
    "16. bare colId stays unquoted; unknown/no-connection header falls back to postgres quoting",
    async () => {
      // Bare colId — byte-identical to what cycle V accepted.
      {
        const { received } = loadBundle();
        dispatchState(
          rowsState(driverHeader("mysql"), ["id", "name"], [
            [1, "beta"],
            [2, "alpha"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();
        received.length = 0;

        api!.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)[0]!.orderBy).toBe("name ASC");
      }
      // No-connection header → postgres double-quoting for a non-bare colId.
      {
        const { received } = loadBundle();
        dispatchState(
          rowsState("Run at 2026-08-26T00:00:00.000Z — no connection", [
            "id",
            "First Name",
          ], [
            [1, "beta"],
            [2, "alpha"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();
        received.length = 0;

        api!.applyColumnState({
          state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)[0]!.orderBy).toBe('"First Name" ASC');
      }
    },
  );

  // Fix-round regressions (reviewer findings on dialect parse + sort carry).

  itIfBundle(
    "17. dialect parsed from the driver TOKEN only — mysql connection whose host/db mention postgres stays mysql",
    async () => {
      const { received } = loadBundle();
      // mysql connection on a host literally named postgres.internal with a
      // database named postgres_prod — substring-matching the whole header
      // would misdetect postgres and double-quote (rejected by MySQL host).
      dispatchState(
        rowsState(
          "Run at 2026-08-26T00:00:00.000Z — mysql@postgres.internal/postgres_prod",
          ["id", "First Name"],
          [
            [1, "beta"],
            [2, "alpha"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();
      received.length = 0;

      api!.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("`First Name` ASC");
    },
  );

  itIfBundle(
    "18. filter requery while a column is sorted keeps the ORDER BY; a pending filter debounce is superseded by the sort post",
    async () => {
      // (a) filter change AFTER a sort: the debounced filter requery must
      // carry the active grid sort, not the (empty) manual bar input.
      {
        const { received } = loadBundle();
        dispatchState(
          rowsState(driverHeader("postgres"), ["id", "name"], [
            [1, "alpha"],
            [2, "beta"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        api!.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)).toHaveLength(1);
        received.length = 0;

        api!.setFilterModel({ name: { values: ["beta"] } });
        await new Promise<void>((r) => setTimeout(r, 250));

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe("name ASC");
        expect(rq[0]!.filters).toBeDefined();
      }
      // (b) sort lands INSIDE the 150ms filter debounce: exactly one post —
      // the sort post already carries the live filter model, so the pending
      // timer must be cancelled, not fired after it (which would post a
      // newer, sort-less requery right behind the sorted one).
      // NOTE: no `await flushGridEvents()` between setFilterModel and
      // applyColumnState — both are synchronous AG Grid API dispatches, and
      // yielding a macrotask there opens a real window for the 150ms debounce
      // to fire before the sort post on a slow runner (observed as a flaky
      // 2-posts failure in aggregate runs).
      {
        const { received } = loadBundle();
        dispatchState(
          rowsState(driverHeader("postgres"), ["id", "name"], [
            [1, "alpha"],
            [2, "beta"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();
        received.length = 0;

        api!.setFilterModel({ name: { values: ["beta"] } });
        api!.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await new Promise<void>((r) => setTimeout(r, 250));

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe("name ASC");
        expect(rq[0]!.filters).toBeDefined();
      }
    },
  );
});
