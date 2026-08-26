// src/ui/__tests__/webviewSetFilter.test.ts
// TASK-602 — Excel-style set-filter UI panel behaviour.
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches state
// messages and drives the custom SetFilterComponent the webview registers
// to assert:
//   - panel renders search + Select All + per-value checkboxes + counts + footer
//   - getModel / setModel round-trip with `{ values: [...] }`
//   - doesFilterPass membership (case-insensitive + blanks)
//   - Clear button deactivates
//   - Select All acts on search-visible entries
//   - multi-column filters compose (AND)
//
// If dist/webview.js is missing, all tests are skipped with an explanatory
// message — `npm run compile` must run first.
// @vitest-environment jsdom
import type { GridApi, IFilterComp } from "ag-grid-community";
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

interface SetFilterGui extends HTMLElement {
  querySelector<E extends Element = Element>(selectors: string): E | null;
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

async function getFilterInstance<T = IFilterComp>(
  api: GridApi,
  colKey: string,
): Promise<T> {
  const inst = await api.getColumnFilterInstance<T>(colKey);
  expect(inst).toBeTruthy();
  return inst as T;
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle — TASK-602 set-filter panel", () => {
  itIfBundle(
    "1. setFilterModel({values:['beta']}) → displayed 1, footer /1 of 3/",
    async () => {
      const { root } = loadBundle();
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: ["beta"] } });
      await flushGridEvents();

      expect(api!.getDisplayedRowCount()).toBe(1);
      const footer = root.querySelector(".vsdb-grid-footer") as HTMLElement;
      expect(footer).toBeTruthy();
      expect(footer.textContent).toMatch(/1 of 3/);
    },
  );

  itIfBundle(
    "2. panel DOM: search input + Select All + entries + counts + footer All/N of M + Clear + Close",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // Force AG Grid to instantiate the filter by setting a model on
      // the column. The filter is created lazily on first setFilterModel.
      api!.setFilterModel({ name: { values: [] } });
      await flushGridEvents();

      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      const gui = filter.getGui() as SetFilterGui;
      expect(gui).toBeTruthy();
      // The component root class
      expect(gui.classList.contains("vsdb-setfilter")).toBe(true);

      // Search input
      const search = gui.querySelector(".vsdb-setfilter-search");
      expect(search).toBeTruthy();

      // Select All checkbox
      const selectAll = gui.querySelector(
        ".vsdb-setfilter-selectall",
      ) as HTMLInputElement | null;
      expect(selectAll).toBeTruthy();
      expect(selectAll!.type).toBe("checkbox");

      // Per-value entries: one per value + checkbox + count, right-aligned
      const entries = Array.from(
        gui.querySelectorAll(".vsdb-setfilter-entry"),
      ) as HTMLElement[];
      expect(entries.length).toBe(3);
      const labels = entries.map(
        (e) => (e.querySelector(".vsdb-setfilter-label") as HTMLElement).textContent,
      );
      expect(labels).toEqual(["alpha", "beta", "gamma"]);

      for (const entry of entries) {
        const cb = entry.querySelector(
          ".vsdb-setfilter-entry-checkbox",
        ) as HTMLInputElement | null;
        expect(cb).toBeTruthy();
        expect(cb!.type).toBe("checkbox");
        const label = entry.querySelector(".vsdb-setfilter-label");
        const count = entry.querySelector(".vsdb-setfilter-count");
        expect(label).toBeTruthy();
        expect(count).toBeTruthy();
        // Count is right-aligned: margin-left:auto on the count element.
        const cs = window.getComputedStyle(count as HTMLElement);
        expect(cs.marginLeft).toBe("auto");
      }

      // Footer: status text + Clear + Close
      const status = gui.querySelector(".vsdb-setfilter-status") as HTMLElement;
      expect(status).toBeTruthy();
      // All entries checked by default → status text is "All" or "3 of 3"
      expect(status.textContent).toMatch(/All|3 of 3/);
      const clear = gui.querySelector(
        ".vsdb-setfilter-clear",
      ) as HTMLButtonElement | null;
      expect(clear).toBeTruthy();
      const close = gui.querySelector(
        ".vsdb-setfilter-close",
      ) as HTMLButtonElement | null;
      expect(close).toBeTruthy();
    },
  );

  itIfBundle(
    "3. (Blanks) entry filters blank rows only",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, null],
            [3, ""],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: ["(Blanks)"] } });
      await flushGridEvents();
      expect(api!.getDisplayedRowCount()).toBe(2);
    },
  );

  itIfBundle(
    "4. case-variant merge: BUMD+bumd → 1 entry count 2; selecting it shows 2 rows",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "BUMD"],
            [2, "bumd"],
            [3, "X"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // Programmatically set model with the merged display → 2 rows pass.
      api!.setFilterModel({ name: { values: ["BUMD"] } });
      await flushGridEvents();
      expect(api!.getDisplayedRowCount()).toBe(2);

      // Also: the panel's entries should show ONE entry for BUMD with count 2.
      api!.setFilterModel({ name: { values: [] } });
      await flushGridEvents();
      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      const gui = filter.getGui() as SetFilterGui;
      const entries = Array.from(
        gui.querySelectorAll(".vsdb-setfilter-entry"),
      ) as HTMLElement[];
      // BUMD merged, X distinct → 2 entries
      const labels = entries.map(
        (e) => (e.querySelector(".vsdb-setfilter-label") as HTMLElement).textContent,
      );
      expect(labels).toContain("BUMD");
      expect(labels).not.toContain("bumd");
      const bumdEntry = entries.find(
        (e) =>
          (e.querySelector(".vsdb-setfilter-label") as HTMLElement).textContent ===
          "BUMD",
      );
      const bumdCount = bumdEntry!.querySelector(
        ".vsdb-setfilter-count",
      ) as HTMLElement;
      expect(bumdCount.textContent.trim()).toBe("2");
    },
  );

  itIfBundle(
    "5. search box narrows list; Select All acts on VISIBLE entries only",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "BUMD"],
            [2, "BUMN"],
            [3, "banana"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      // Trigger filter instantiation
      api!.setFilterModel({ name: { values: [] } });
      await flushGridEvents();
      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      const gui = filter.getGui() as SetFilterGui;

      const search = gui.querySelector(".vsdb-setfilter-search") as HTMLInputElement;
      expect(search).toBeTruthy();

      // Simulate typing "bu" into the search box. Dispatch input event so
      // the component reacts.
      search.value = "bu";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await flushGridEvents();

      // After filter: visible entries are BUMD + BUMN (2). banana hidden.
      const visibleEntries = Array.from(
        gui.querySelectorAll(
          ".vsdb-setfilter-entry:not(.vsdb-setfilter-entry-hidden)",
        ),
      ) as HTMLElement[];
      expect(visibleEntries.length).toBe(2);

      // Click Select All → only visible entries get checked; banana stays unchecked.
      const selectAll = gui.querySelector(
        ".vsdb-setfilter-selectall",
      ) as HTMLInputElement;
      selectAll.checked = true;
      selectAll.dispatchEvent(new Event("change", { bubbles: true }));
      await flushGridEvents();
      // Read model from the grid and confirm it contains BUMD + BUMN only.
      const m = api!.getFilterModel();
      const values = (m as { name?: { values?: string[] } }).name?.values;
      expect(values).toBeTruthy();
      // Order-insensitive comparison: the component pushes checked
      // entries into the model in render iteration order (BUMD before
      // BUMN alphabetically), not the order they were clicked.
      expect([...values!].sort((a, b) => a.localeCompare(b))).toEqual(["BUMD", "BUMN"]);
    },
  );

  itIfBundle(
    "6. live apply + round-trip + Clear → filter not present + getModel name null",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: ["beta"] } });
      await flushGridEvents();
      expect(api!.isColumnFilterPresent()).toBe(true);
      const m1 = api!.getFilterModel() as { name?: { values?: string[] } | null };
      expect(m1.name?.values?.slice().sort()).toEqual(["beta"]);

      // Open panel, click Clear button → filter inactive.
      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      const gui = filter.getGui() as SetFilterGui;
      const clear = gui.querySelector(
        ".vsdb-setfilter-clear",
      ) as HTMLButtonElement;
      expect(clear).toBeTruthy();
      clear.click();
      await flushGridEvents();

      expect(api!.isColumnFilterPresent()).toBe(false);
      const m2 = api!.getFilterModel() as { name?: unknown };
      expect(m2.name ?? null).toBeNull();
    },
  );

  itIfBundle(
    "7. multi-column filters compose (AND) — beta AND id=2 → 1 row",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({
        name: { values: ["beta"] },
        id: { values: ["2"] },
      });
      await flushGridEvents();
      expect(api!.getDisplayedRowCount()).toBe(1);

      // Loosen name to all → id=2 alone still shows 1 row.
      api!.setFilterModel({ id: { values: ["2"] } });
      await flushGridEvents();
      expect(api!.getDisplayedRowCount()).toBe(1);

      // Both loose → all 3 rows.
      api!.setFilterModel(null);
      await flushGridEvents();
      expect(api!.getDisplayedRowCount()).toBe(3);
    },
  );

  itIfBundle(
    "8. getModel / setModel round-trip on the component instance",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: [] } });
      await flushGridEvents();
      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      // isFilterActive default false on a fresh filter with empty model
      // (active means at least one value selected)
      filter.setModel({ values: ["beta"] });
      expect(filter.isFilterActive()).toBe(true);
      const m = filter.getModel() as { values: string[] };
      expect(m.values.slice().sort()).toEqual(["beta"]);
    },
  );

  // R1 fix regression — gridWrap.style.display must NOT be 'none' once a

  // statement tab renders results. Without the un-hide line in
  // renderActivePanel, the grid stays invisible in a real browser after the
  // first teardown/re-mount cycle (e.g. switching to Messages and back).
  itIfBundle(
    "9. regression — gridWrap display is unhidden when statement tab activates",
    async () => {
      const { root } = loadBundle();
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const gridWrap = root.querySelector(".vsdb-grid-host") as HTMLElement;
      expect(gridWrap).toBeTruthy();
      // jsdom reflects the inline style. After the fix the wrap's inline
      // display is "" (CSS class governs: `display: flex`); before the fix
      // teardownGridWrap()'s `display: "none"` survives re-mount, so the
      // grid stays invisible across tab switches.
      expect(gridWrap.style.display).not.toBe("none");
    },
  );

  // R1 fix regression — Close button must hide the filter popup. In AG Grid
  // Community, custom-filter panels are hosted inside the column-menu popup;
  // the API to dismiss it is hidePopupMenu(). The fix wires onClose() to
  // invoke api.hidePopupMenu(). We monkey-patch hidePopupMenu on the api
  // instance BEFORE clicking Close (the filter captured params.api at init()
  // time, and the instance property assignment is visible through that
  // reference).
  itIfBundle(
    "10. regression — Close button calls api.hidePopupMenu()",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: [] } });
      await flushGridEvents();
      const filter = await getFilterInstance<IFilterComp>(api!, "name");
      const gui = filter.getGui() as SetFilterGui;
      const close = gui.querySelector(
        ".vsdb-setfilter-close",
      ) as HTMLButtonElement | null;
      expect(close).toBeTruthy();

      // Patch hidePopupMenu on the api instance so the spy records the call.
      const spy = vi.fn();
      const apiInst = api as unknown as Record<string, unknown>;
      const original = apiInst.hidePopupMenu;
      apiInst.hidePopupMenu = () => {
        spy();
        if (typeof original === "function") {
          return (original as () => void).call(apiInst);
        }
      };

      close!.click();
      await flushGridEvents();

      expect(spy).toHaveBeenCalled();
    },
  );

  // TASK-004 case 4 — the typed resolver maps whitespace-only cells to the
  // (Blanks) group: the whitespace row passes the filter AND the server
  // requery posts a RESOLVED typed blank (the raw "   "), not an unresolved
  // display-only model.
  itIfBundle(
    "11. whitespace (Blanks): whitespace row passes filter and requery posts a typed blank",
    async () => {
      const { received } = loadBundle();
      dispatchState(
        rowsState(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "   "],
          ],
        ),
      );
      await flushGridEvents();
      const api = getGridApi();
      expect(api).toBeTruthy();

      api!.setFilterModel({ name: { values: ["(Blanks)"] } });
      await flushGridEvents();
      // The whitespace-only cell is a blank → only row 2 passes.
      expect(api!.getDisplayedRowCount()).toBe(1);

      // The debounced server requery resolves the raw whitespace cell.
      await flushFilterDebounce();
      const rqs = received.filter((m) => m.type === "requery") as Array<
        Record<string, unknown>
      >;
      expect(rqs.length).toBeGreaterThan(0);
      const filters = (rqs[rqs.length - 1]!.filters ?? {}) as {
        name?: { values?: string[]; typed?: unknown[] };
      };
      expect(filters.name?.values).toContain("(Blanks)");
      expect(filters.name?.typed).toEqual(["   "]);
    },
  );
});
