// src/ui/__tests__/webviewDistinctValues.test.ts
// TASK-003 — set-filter dropdown populated from host DISTINCT values.
//
// Cases 7-14 of the TASK-003 test matrix. Loads dist/webview.js into jsdom,
// opens the set filter (the webview requests DISTINCT values from the host on
// popup open / init), replies with `distinctValues`, and asserts the checkbox
// list, the request caching, stale-response handling, the loaded-row
// fallback, and typed-value resolution beyond the loaded window.
//
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
// @vitest-environment jsdom
import type { GridApi, IFilterComp } from "ag-grid-community";
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
interface SetFilterGui extends HTMLElement {
  querySelector<E extends Element = Element>(selectors: string): E | null;
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
  columns: string[],
  rows: Array<Array<unknown>>,
): Record<string, unknown> {
  return {
    type: "state",
    header: "Run at 2026-08-26T00:00:00.000Z — postgres@localhost/db",
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

async function openFilter(
  api: GridApi,
  colKey: string,
): Promise<IFilterComp> {
  // Force AG Grid to instantiate the filter (lazy until first use), then
  // read its instance. `init` fires on instantiation — the webview posts
  // requestDistinctValues from there when no open hook exists.
  api.setFilterModel({ [colKey]: { values: [] } });
  await flushGridEvents();
  const inst = await api.getColumnFilterInstance<IFilterComp>(colKey);
  expect(inst).toBeTruthy();
  return inst as IFilterComp;
}

function entryLabels(gui: SetFilterGui): string[] {
  return Array.from(gui.querySelectorAll(".vsdb-setfilter-entry")).map((e) =>
    (e.querySelector(".vsdb-setfilter-label") as HTMLElement | null)?.textContent ?? "",
  );
}

function requestDistincts(received: Array<Record<string, unknown>>) {
  return received.filter((m) => m.type === "requestDistinctValues") as Array<
    Record<string, unknown>
  >;
}

function requeries(received: Array<Record<string, unknown>>) {
  return received.filter((m) => m.type === "requery") as Array<
    Record<string, unknown>
  >;
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle(
  "webview/main.ts bundle — TASK-003 distinct-value set filter",
  () => {
    itIfBundle(
      "7. opening a filter requests distinct values ({index:0, column:'name'})",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "alpha"],
            [2, "beta"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();
        received.length = 0;

        await openFilter(api!, "name");
        await flushGridEvents();

        const reqs = requestDistincts(received);
        expect(reqs.length).toBeGreaterThanOrEqual(1);
        expect(reqs[0]!.index).toBe(0);
        expect(reqs[0]!.column).toBe("name");
      },
    );

    itIfBundle(
      "8. distinct response drives the checkbox list (value in NO loaded row)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        const filter = await openFilter(api!, "name");
        const gui = filter.getGui() as SetFilterGui;
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "name",
          values: ["zzz"],
          truncated: false,
        });
        await flushGridEvents();

        expect(entryLabels(gui)).toContain("zzz");
      },
    );

    itIfBundle(
      "9. second open of the same column does not re-request (cache)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "alpha"],
            [2, "beta"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        await openFilter(api!, "name");
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "name",
          values: ["alpha", "beta"],
          truncated: false,
        });
        await flushGridEvents();
        received.length = 0;

        // Re-open: destroy + recreate the instance (popup reopen path).
        api!.destroyFilter("name");
        await flushGridEvents();
        await openFilter(api!, "name");
        await flushGridEvents();

        expect(requestDistincts(received)).toHaveLength(0);
      },
    );

    itIfBundle(
      "10. a response for a different column is ignored (list unchanged)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        const filter = await openFilter(api!, "name");
        const gui = filter.getGui() as SetFilterGui;
        const before = entryLabels(gui).join("|");
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "other",
          values: ["zzz", "qqq"],
          truncated: false,
        });
        await flushGridEvents();

        expect(entryLabels(gui).join("|")).toBe(before);
        expect(entryLabels(gui)).not.toContain("zzz");
      },
    );

    itIfBundle(
      "11. no response yet ⇒ loaded-row entries (fallback)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
            [2, "b"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        const filter = await openFilter(api!, "name");
        const gui = filter.getGui() as SetFilterGui;
        await flushGridEvents();

        // No distinctValues dispatched — entries equal loaded values.
        expect(entryLabels(gui).sort()).toEqual(["a", "b"]);
      },
    );

    itIfBundle(
      "12. typed[] resolves from the distinct cache beyond the loaded window",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        await openFilter(api!, "id");
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "id",
          values: [42],
          truncated: false,
        });
        await flushGridEvents();
        received.length = 0;

        api!.setFilterModel({ id: { values: ["42"] } });
        await new Promise<void>((r) => setTimeout(r, 250));

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        const typed = (
          rq[0]!.filters as { id?: { typed?: unknown[] } }
        ).id?.typed;
        expect(typed).toEqual([42]);
      },
    );

    itIfBundle(
      "13. a null distinct value maps to the (Blanks) entry",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        const filter = await openFilter(api!, "name");
        const gui = filter.getGui() as SetFilterGui;
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "name",
          values: [null, "a"],
          truncated: false,
        });
        await flushGridEvents();

        const labels = entryLabels(gui);
        expect(labels.filter((l) => l === "(Blanks)")).toHaveLength(1);
        expect(labels).not.toContain("null");
        expect(labels).toContain("a");
      },
    );

    itIfBundle(
      "14. typed[] length parity on a partial resolve (never length 1)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [7, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        await openFilter(api!, "id");
        // Cache holds ONLY 42; 7 is resolvable from a loaded row.
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "id",
          values: [42],
          truncated: false,
        });
        await flushGridEvents();
        received.length = 0;

        api!.setFilterModel({ id: { values: ["42", "7"] } });
        await new Promise<void>((r) => setTimeout(r, 250));

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        const entry = (rq[0]!.filters as { id?: { typed?: unknown[] } }).id;
        if (entry?.typed !== undefined) {
          expect(entry.typed).toHaveLength(2);
        } else {
          expect(entry?.typed).toBeUndefined();
        }
      },
    );

    itIfBundle(
      "15. statement replacement invalidates the distinct cache: a live filter re-requests and refreshes (fix round)",
      async () => {
        const { received } = loadBundle();
        dispatchState(
          rowsState(["id", "name"], [
            [1, "a"],
          ]),
        );
        await flushGridEvents();
        const api = getGridApi();
        expect(api).toBeTruthy();

        const filter = await openFilter(api!, "name");
        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "name",
          values: ["a"],
          truncated: false,
        });
        await flushGridEvents();
        expect(entryLabels(filter.getGui() as SetFilterGui)).toEqual(["a"]);

        // Statement replaced: different sql at the same index. The old
        // cached ["a"] is wrong data; the still-mounted filter must
        // re-request and its list must pick up the new values.
        const state2 = rowsState(["id", "name"], [[2, "b"]]);
        (state2.results![0] as Record<string, unknown>).sql =
          "SELECT * FROM t2";
        dispatchState(state2);
        await flushGridEvents();

        const reqs = requestDistincts(received);
        expect(reqs.length).toBeGreaterThanOrEqual(2);
        expect(reqs[reqs.length - 1]!.column).toBe("name");

        dispatchState({
          type: "distinctValues",
          index: 0,
          column: "name",
          values: ["b", "c"],
          truncated: false,
        });
        await flushGridEvents();
        expect(entryLabels(filter.getGui() as SetFilterGui).sort()).toEqual([
          "b",
          "c",
        ]);
      },
    );
  },
);
