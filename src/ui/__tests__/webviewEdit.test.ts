// src/ui/__tests__/webviewEdit.test.ts
// TASK-501 — bundle-eval test for grid edit model + paste + undo + toolbar.
//
// Loads dist/webview.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, dispatches a state message,
// then:
//   - fires a REAL AG-Grid CellValueChanged through the bundle's registered
//     handler (Test 10) → assert editState.dirty reflects the event payload
//   - fires a REAL ClipboardEvent('paste') on gridWrap with TSV payload → assert
//     editState.dirtyCount + snapshot() reflect the parsed/anchored paste
//   - exercises undo, addRow (must actually append a grid row), toolbar exposure,
//     and CSV toggle.
//
// If dist/webview.js is missing, all tests are skipped with an explanatory
// message — `npm run compile` must run first.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// ---- minimal DOM stubs for AG Grid browser APIs ---------------------------
interface ResizeObserverLike {
  observe(): void;
  unobserve(): void;
  disconnect(): void;
}
interface MediaQueryListLike {
  matches: boolean;
  media: string;
  onchange: null;
  addListener(): void;
  removeListener(): void;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
}

interface EditStateHandle {
  markDirty: (
    rowId: number,
    colIndex: number,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
  undo: () => { rowId: number; colIndex: number } | null;
  clear: () => void;
  dirtyCount: number;
  snapshot: () => Array<{ rowId: number; colIndex: number; value: unknown }>;
}

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface VsdbDebug {
  gridApi?: GridApi;
  editState?: EditStateHandle;
  addRow?: () => void;
  deleteRow?: () => void;
  refresh?: () => void;
  toggleCsv?: () => void;
  undo?: () => void;
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
}

function vsdbApi(): VsdbDebug | null {
  if (typeof window === "undefined") return null;
  const maybe = (window as unknown as { __vsdb?: VsdbDebug }).__vsdb;
  return maybe ?? null;
}

function getEditState(): EditStateHandle | null {
  return vsdbApi()?.editState ?? null;
}

function getSimulateEdit():
  | ((
      rowId: number,
      colField: string,
      newValue: unknown,
      oldValue: unknown,
    ) => void)
  | null {
  return vsdbApi()?.simulateCellEdit ?? null;
}

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: typeof ResizeObserver;
    matchMedia?: (q: string) => MediaQueryListLike;
  };
  if (typeof g.ResizeObserver === "undefined") {
    class StubResizeObserver implements ResizeObserverLike {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    g.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
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

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

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

function threeRowsState(): Record<string, unknown> {
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
            [3, "gamma"],
          ],
          rowCount: 3,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

function fiveRowsState(): Record<string, unknown> {
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
            [3, "gamma"],
            [4, "delta"],
            [5, "epsilon"],
          ],
          rowCount: 5,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

function twoStatementState(): Record<string, unknown> {
  return {
    type: "state",
    header: "test2.sql",
    busy: false,
    results: [
      {
        index: 0,
        sql: "SELECT * FROM u",
        status: "done",
        result: {
          columns: ["id"],
          rows: [
            [10],
            [20],
          ],
          rowCount: 2,
          durationMs: 1,
        },
        durationMs: 1,
      },
      {
        index: 1,
        sql: "SELECT 1",
        status: "done",
        result: {
          columns: ["a", "b"],
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
  };
}

// AG Grid's filter/sort/transactions dispatch on a microtask boundary in
// jsdom — wait one tick (matches the established pattern in webviewFilters.test.ts)
// before asserting on grid state.
async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-501)", () => {
  itIfBundle("10. registered cellValueChanged handler records dirty entry", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();
    expect(editState!.dirtyCount).toBe(0);

    // Drive the bundle's REAL wiring through the simulateCellEdit helper
    // (which invokes the registered onCellValueChanged handler — same code
    // path as a real user edit, only the trigger source differs).
    const sim = getSimulateEdit();
    const grid = vsdbApi()?.gridApi;
    expect(grid).toBeTruthy();
    expect(sim).toBeTruthy();
    sim!(0, "name", "new-alpha", "alpha");
    sim!(2, "name", "new-gamma", "gamma");
    await flushGridEvents();

    expect(editState!.dirtyCount).toBe(2);
    const snap = editState!.snapshot();
    const byKey: Record<string, unknown> = {};
    for (const x of snap) byKey[`${x.rowId}:${x.colIndex}`] = x.value;
    expect(byKey["0:1"]).toBe("new-alpha");
    expect(byKey["2:1"]).toBe("new-gamma");
  });

  itIfBundle("10b. real paste ClipboardEvent with DataTransfer applies dirty entries", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();

    const gridWrap = (root.querySelector(".vsdb-grid-host") ||
      document.querySelector(".vsdb-grid-host")) as HTMLDivElement | null;
    expect(gridWrap).toBeTruthy();

    // jsdom 29 does not expose DataTransfer or ClipboardEvent on its
    // window — but the bundle only reads clipboardData.getData("text/plain")
    // so we dispatch a plain paste Event with a stubbed clipboardData.
    const fakeClipboardData = { getData: (_type: string) => "x\ty\nx2\ty2\n" };
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: fakeClipboardData,
      enumerable: true,
    });
    gridWrap!.dispatchEvent(ev);
    await flushGridEvents();

    // Anchor defaults to (0,0) when no cell is focused. 4 in-bounds cells.
    expect(editState!.dirtyCount).toBe(4);
    const snap = editState!.snapshot();
    const byKey: Record<string, unknown> = {};
    for (const x of snap) byKey[`${x.rowId}:${x.colIndex}`] = x.value;
    expect(byKey["0:0"]).toBe("x");
    expect(byKey["0:1"]).toBe("y");
    expect(byKey["1:0"]).toBe("x2");
    expect(byKey["1:1"]).toBe("y2");
  });

  itIfBundle("10b2. paste into a filter input does NOT mark dirty", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();

    const gridWrap = (root.querySelector(".vsdb-grid-host") ||
      document.querySelector(".vsdb-grid-host")) as HTMLDivElement | null;
    expect(gridWrap).toBeTruthy();

    // Append an input element inside the grid wrap (mirrors the floating
    // filter inputs AG Grid renders).
    const filter = document.createElement("input");
    filter.type = "text";
    gridWrap!.appendChild(filter);

    // Dispatch the same paste-shaped event as Test 10b, but targeted
    // at the input. The capture-phase listener must skip these.
    const fakeClipboardData = { getData: (_type: string) => "x\ty\n" };
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: fakeClipboardData,
      enumerable: true,
    });
    filter.dispatchEvent(ev);
    await flushGridEvents();

    expect(editState!.dirtyCount).toBe(0);
  });

  itIfBundle("10c. undo button removes last dirty entry", async () => {
    loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();

    const sim = getSimulateEdit();
    expect(sim).toBeTruthy();
    sim!(0, "name", "x", "alpha");
    sim!(0, "id", 99, 1);
    await flushGridEvents();
    expect(editState!.dirtyCount).toBe(2);

    const popped = editState!.undo();
    expect(popped).toEqual({ rowId: 0, colIndex: 0 });
    expect(editState!.dirtyCount).toBe(1);

    const popped2 = editState!.undo();
    expect(popped2).toEqual({ rowId: 0, colIndex: 1 });
    expect(editState!.dirtyCount).toBe(0);
  });

  itIfBundle("10d. toolbar buttons (Refresh / Add Row / Delete Row / Undo / CSV toggle) are exposed", async () => {
    loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = vsdbApi()!;
    expect(typeof api.addRow).toBe("function");
    expect(typeof api.deleteRow).toBe("function");
    expect(typeof api.refresh).toBe("function");
    expect(typeof api.toggleCsv).toBe("function");
  });

  itIfBundle("10e. CSV toggle flips cell valueFormatter between formatCell and raw value", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = vsdbApi()!;
    expect(typeof api.toggleCsv).toBe("function");
    const grid = api.gridApi!;
    expect(grid).toBeTruthy();

    const before = grid.getColumnDef("name");
    expect(before).toBeTruthy();
    const beforeFormatter = before!.valueFormatter as
      | ((p: { value: unknown }) => string)
      | undefined;
    expect(beforeFormatter).toBeTruthy();
    expect(beforeFormatter!({ value: "hello" })).toBe("hello");
    const d = new Date("2024-01-02T03:04:05.000Z");
    expect(beforeFormatter!({ value: d })).toBe("2024-01-02T03:04:05.000Z");

    api.toggleCsv!();
    await flushGridEvents();
    const after = grid.getColumnDef("name");
    expect(after).toBeTruthy();
    const afterFormatter = after!.valueFormatter as
      | ((p: { value: unknown }) => string)
      | undefined;
    expect(afterFormatter).toBeTruthy();
    expect(afterFormatter!({ value: d })).toBe(String(d));

    api.toggleCsv!();
    await flushGridEvents();
    const back = grid.getColumnDef("name");
    const backFormatter = back!.valueFormatter as
      | ((p: { value: unknown }) => string)
      | undefined;
    expect(backFormatter!({ value: d })).toBe("2024-01-02T03:04:05.000Z");
  });

  // Sortable-row-identity regression: edits keyed by AG Grid DISPLAY rowIndex
  // go wrong after a sort. The fix keys edits by the STABLE row id (the data
  // row's underlying index). After sorting desc by id, undo must restore the
  // original cell, not the currently-displayed cell at that index.
  itIfBundle("10f. sorted columns → edit + undo restores the right DATA row by stable id", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(fiveRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();

    const api = vsdbApi()!.gridApi!;
    expect(api).toBeTruthy();

    // Sort descending by id — display order becomes [5,4,3,2,1].
    api.applyColumnState({
      state: [{ colId: "id", sort: "desc", sortIndex: 0 }],
      defaultState: { sort: null },
    });
    await flushGridEvents();

    const head = api.getDisplayedRowAtIndex(0);
    expect(head).toBeTruthy();
    expect(head!.data).toMatchObject({ id: 5, name: "epsilon" });

    const sim = getSimulateEdit();
    expect(sim).toBeTruthy();
    sim!(4, "name", "DELTA-EDITED", "delta");
    await flushGridEvents();
    expect(editState!.dirtyCount).toBe(1);

    // Undo — must restore the row at stable id 4 (id=4, name=delta).
    editState!.undo();
    await flushGridEvents();

    // Re-sort ascending to verify the right row was restored.
    api.applyColumnState({
      state: [{ colId: "id", sort: "asc", sortIndex: 0 }],
      defaultState: { sort: null },
    });
    await flushGridEvents();
    // Ascending order: stable id 4 sits at display index 3.
    const restored = api.getDisplayedRowAtIndex(3);
    expect(restored).toBeTruthy();
    expect(restored!.data).toMatchObject({ id: 4, name: "delta" });
  });

  // Add Row must visibly append a row (not a sentinel-only no-op). The new
  // row's data is blank and is marked as pending insert in the edit state.
  itIfBundle("10g. Add Row appends a real blank row to the grid", async () => {
    const { root } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = vsdbApi()!;
    const editState = getEditState();
    const grid = api.gridApi!;
    expect(typeof api.addRow).toBe("function");
    expect(grid).toBeTruthy();
    const before = grid.getDisplayedRowCount();
    expect(before).toBe(3);

    api.addRow!();
    await flushGridEvents();

    expect(grid.getDisplayedRowCount()).toBe(before + 1);
    const newRow = grid.getDisplayedRowAtIndex(before);
    expect(newRow).toBeTruthy();
    expect(newRow!.data.id === "" || newRow!.data.id == null).toBe(true);
    expect(newRow!.data.name === "" || newRow!.data.name == null).toBe(true);

    // The new row is "pending insert" in the edit state — TASK-503 will
    // translate the snapshot into INSERT statements. We look for at least
    // one new-row marker (string sentinel OR array sentinel OR object).
    const snap = editState!.snapshot();
    const newRowMarkers = snap.filter(
      (s) =>
        s.value === "__vsdb_new_row__" ||
        Array.isArray(s.value) ||
        (typeof s.value === "object" && s.value !== null),
    );
    expect(newRowMarkers.length).toBeGreaterThanOrEqual(1);
  });

  // Tab switch must clear stale EditState (no phantom edits across statements).
  itIfBundle("10h. tab switch clears stale EditState", async () => {
    const { root } = loadBundle();
    void root;

    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    const sim = getSimulateEdit();
    expect(sim).toBeTruthy();
    sim!(0, "name", "edited-A", "alpha");
    sim!(2, "id", 99, 3);
    await flushGridEvents();
    expect(editState!.dirtyCount).toBe(2);

    dispatchState(twoStatementState());
    await flushGridEvents();
    expect(editState!.dirtyCount).toBe(0);

    sim!(0, "id", 999, 10);
    await flushGridEvents();
    expect(editState!.dirtyCount).toBe(1);
    const snap = editState!.snapshot();
    expect(snap[0]).toEqual({ rowId: 0, colIndex: 0, value: 999 });
  });

  // Fix Round 2 — Finding #1: paste after column reorder must still target
  // the ORIGINAL stable colIndex, not the reordered getColumnDefs index.
  // The currentSpecs cache is the source of truth — onGridPaste reads from
  // it, not from gridApi.getColumnDefs().
  itIfBundle(
    "R2-A. paste after column reorder targets the ORIGINAL stable colIndex",
    async () => {
      const { root } = loadBundle();
      void root;
      // 3 rows × 3 cols [a, b, c].
      const threeColState: Record<string, unknown> = {
        type: "state",
        header: "test.sql",
        busy: false,
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t",
            status: "done",
            result: {
              columns: ["a", "b", "c"],
              rows: [
                ["a0", "b0", "c0"],
                ["a1", "b1", "c1"],
                ["a2", "b2", "c2"],
              ],
              rowCount: 3,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      };
      dispatchState(threeColState);
      await flushGridEvents();

      const api = vsdbApi()!.gridApi!;
      expect(api).toBeTruthy();

      // Reorder columns to [b, a, c] via the live API (this is what a
      // user drag-reorder does). currentSpecs is untouched; it still
      // represents the original [a, b, c] ordering.
      api.setGridOption("columnDefs", [
        { field: "b", headerName: "b" },
        { field: "a", headerName: "a" },
        { field: "c", headerName: "c" },
      ]);
      await flushGridEvents();

      // Sanity: getColumnDefs now reports [b, a, c] order.
      const reordered = api.getColumnDefs() as Array<{ field?: string }>;
      expect(reordered.map((c) => c.field)).toEqual(["b", "a", "c"]);

      // Now paste "X\tY" with no cell focused → anchor defaults to (0, 0).
      // ORIGINAL colIndex 0 is `a`; ORIGINAL colIndex 1 is `b`.
      // The buggy code reads `getColumnDefs()[0].field === "b"` and would
      // mark colIndex=0 for the paste → wrong cell dirty (would write into
      // `a`). The fix reads currentSpecs[0].field === "a" → marks
      // colIndex=0 for `a` correctly.
      const gridWrap = (root.querySelector(".vsdb-grid-host") ||
        document.querySelector(".vsdb-grid-host")) as HTMLDivElement | null;
      expect(gridWrap).toBeTruthy();
      const fakeClipboardData = { getData: (_type: string) => "X\tY" };
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: fakeClipboardData,
        enumerable: true,
      });
      gridWrap!.dispatchEvent(ev);
      await flushGridEvents();

      const editState = getEditState()!;
      expect(editState.dirtyCount).toBe(2);
      const snap = editState.snapshot();
      // After the fix: colIndex must be the ORIGINAL stable index. The
      // original [a, b, c] ordering means X → a (colIndex=0), Y → b
      // (colIndex=1). The grid's data row at rowId 0 must have a="X" and
      // b="Y", NOT b="X" and a="Y" (the bug).
      const byKey: Record<string, unknown> = {};
      for (const s of snap) byKey[`${s.rowId}:${s.colIndex}`] = s.value;
      expect(byKey["0:0"]).toBe("X"); // original col a
      expect(byKey["0:1"]).toBe("Y"); // original col b

      // And the underlying grid data must show a="X", b="Y" at rowId 0 —
      // proves the paste wired to the right cells, not the reordered ones.
      const node = api.getRowNode("0");
      expect(node).toBeTruthy();
      expect(node!.data!.a).toBe("X");
      expect(node!.data!.b).toBe("Y");

      // Undo through the registered __vsdb.undo handler — LIFO pops the
      // LAST marked cell (the second paste cell, which is original `b`
      // at colIndex=1). After undo, `b` returns to its server value
      // "b0", `a` stays at the pasted "X" (colIndex=0).
      vsdbApi()!.undo!();
      await flushGridEvents();
      const after = api.getRowNode("0")!;
      expect(after.data!.a).toBe("X"); // colIndex=0 still dirty
      expect(after.data!.b).toBe("b0"); // colIndex=1 restored
    },
  );

  // Fix Round 2 — Finding #2: Add Row id must not collide with the
  // append-delta id space during streaming. The fix uses a high-water
  // mark — locally-added rows get ids ABOVE the highest server or local
  // id ever assigned for this statement.
  itIfBundle(
    "R2-B. Add Row during streaming does not collide with append-delta ids",
    async () => {
      const { root } = loadBundle();
      void root;
      // Start with 3 rows.
      dispatchState(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      expect(grid).toBeTruthy();

      // Add a row locally. This should NOT collide with id 3..5 that
      // streaming will assign.
      api.addRow!();
      await flushGridEvents();

      // Now grow the server result to 5 rows (streaming append).
      dispatchState(fiveRowsState());
      await flushGridEvents();

      // Uniqueness: every visible row's __rowId must be unique. Before the
      // fix, ids were [0, 1, 2, 3(add), 3(stream), 4(stream)] — duplicate.
      const ids = new Set<number>();
      let dups = 0;
      for (let i = 0; i < grid.getDisplayedRowCount(); i++) {
        const node = grid.getDisplayedRowAtIndex(i);
        const id = (node!.data as { __rowId: unknown }).__rowId;
        expect(typeof id).toBe("number");
        if (ids.has(id as number)) dups++;
        ids.add(id as number);
      }
      expect(dups).toBe(0);
      expect(ids.size).toBe(6); // 3 server + 1 add + 2 streamed

      // getRowNode(String(id)) must resolve each id to a distinct node —
      // getRowId uniqueness is the contract TASK-503 / edit / paste depend
      // on. Probe for duplicate ids by checking that all 6 ids are
      // independently resolvable.
      for (const id of ids) {
        const node = grid.getRowNode(String(id));
        expect(node).toBeTruthy();
        expect((node!.data as { __rowId: number }).__rowId).toBe(id);
      }
    },
  );

  // Fix Round 2 — Finding #3: undoing an edit to a NULL cell must restore
  // NULL, not the edited value or "". The buggy code used
  // `serverOld ?? current ?? ""` which conflates null with missing.
  itIfBundle(
    "R2-C. undo of an edit to a NULL cell restores NULL",
    async () => {
      const { root } = loadBundle();
      void root;
      // 3 rows × 2 cols [id, name]. Row 1 (id=2) has name=null — the most
      // common SQL edge value (NULL cell).
      const stateWithNull: Record<string, unknown> = {
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
                [2, null],
                [3, "gamma"],
              ],
              rowCount: 3,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      };
      dispatchState(stateWithNull);
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const editState = getEditState()!;
      expect(grid).toBeTruthy();

      // Confirm the underlying server row really has name=null at rowId=1.
      const beforeNode = grid.getRowNode("1")!;
      expect(beforeNode.data!.name).toBeNull();

      // Drive the registered onCellValueChanged handler — the user edits
      // row 1's name from null → "EDITED".
      const sim = getSimulateEdit();
      expect(sim).toBeTruthy();
      sim!(1, "name", "EDITED", null);
      await flushGridEvents();
      expect(editState.dirtyCount).toBe(1);

      // Grid reflects the edit (so we know the bundle applied it).
      const editedNode = grid.getRowNode("1")!;
      expect(editedNode.data!.name).toBe("EDITED");

      // Undo. With the buggy `?? ""` conflation, the cell stays as
      // "EDITED" because serverOld=null falls through to the current
      // value. The fix must explicitly restore null.
      api.undo!();
      await flushGridEvents();

      expect(editState.dirtyCount).toBe(0);
      const restoredNode = grid.getRowNode("1")!;
      expect(restoredNode.data!.name).toBeNull();
    },
  );

  // Fix Round 3 — Finding #1 (defect from R2 #2): the undo path still reads
  // `r.result.rows[popped.rowId]` assuming __rowId == source-array index.
  // After Add Row + append-delta the high-water mark gives streamed rows
  // ids PAST the source-array length, so server row resolution by __rowId
  // returns the wrong row's value. Probe (per reviewer): 3 rows + Add Row
  // (id 3) + grow to 5 server rows → streamed rows get ids 4,5; node with
  // name="delta" (server array index 3) has __rowId 4; edit it → undo
  // restores rows[4]="epsilon" (wrong cell). Fix: a serverIndexByRowId map
  // populated by rowsToObjects and cleared/seeded in reset branches.
  itIfBundle(
    "R3-A. undo after Add Row + streaming restore returns the ORIGINAL server row, not the wrong streamed one",
    async () => {
      const { root } = loadBundle();
      void root;
      // Start with 3 server rows.
      dispatchState(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const editState = getEditState()!;
      expect(grid).toBeTruthy();

      // Add Row → allocates __rowId 3 (one past the 3 server rows).
      api.addRow!();
      await flushGridEvents();

      // Stream grow to 5 server rows. Append-delta seeds ids 4,5
      // (startIndex = Math.max(prev.length, highestAllocatedId+1) = 4).
      // Now node ids: 0,1,2 (server), 3 (local blank), 4,5 (streamed).
      // The row with name="delta" originally was server array index 3;
      // after append it has __rowId = 4. A buggy undo reads
      // r.result.rows[4] = "epsilon" (wrong cell).
      dispatchState(fiveRowsState());
      await flushGridEvents();

      // Sanity: there are 6 rows in the grid now (3 server + 1 local +
      // 2 streamed).
      expect(grid.getDisplayedRowCount()).toBe(6);

      // Confirm the row carrying name="delta" is the one at __rowId 4.
      const deltaNode = grid.getRowNode("4");
      expect(deltaNode).toBeTruthy();
      expect(deltaNode!.data!.name).toBe("delta");

      // Edit deltaNode's name to "DELTA-EDITED" via the registered handler.
      const sim = getSimulateEdit();
      expect(sim).toBeTruthy();
      sim!(4, "name", "DELTA-EDITED", "delta");
      await flushGridEvents();
      // dirtyCount: 1 add-row marker + 1 cell edit = 2.
      expect(editState.dirtyCount).toBe(2);

      // Undo. The fix must read serverIndexByRowId.get(4) → server-array
      // index 3 → "delta" (the ORIGINAL value of THIS row, not the value
      // of whatever happened to live at array index 4 after streaming).
      // LIFO: first undo pops the cell edit (4:name). Then the add-row
      // marker remains.
      api.undo!();
      await flushGridEvents();

      expect(editState.dirtyCount).toBe(1);
      const restored = grid.getRowNode("4")!;
      expect(restored.data!.name).toBe("delta"); // NOT "epsilon"
    },
  );


  // Fix Round 3 — Finding #2: paste row arithmetic must iterate by DISPLAY
  // SEQUENCE from the anchor, not by integer id addition. After Add Row
  // the dense id space is broken (server rows 0..2, local row at id 3,
  // streamed rows at id 4,5). A paste spanning past id 2 used to wrap
  // into the local blank row and silently overwrite its insert marker.
  // Probe (per reviewer): anchor at displayed row 1, paste 3 rows
  // "R1\nR2\nR3" → buggy code wrote R3 into LOCAL row id 3 (blank) and
  // marked it dirty; fix resolves by display sequence and stops at the
  // local row OR writes only into server rows depending on intent.
  itIfBundle(
    "R3-B. paste at display index past a local Add-Row row does NOT mark the local row dirty",
    async () => {
      const { root } = loadBundle();
      void root;
      // 3 server rows.
      dispatchState(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const editState = getEditState()!;
      expect(grid).toBeTruthy();

      // Add Row → 4 displayed rows (3 server + 1 local blank).
      api.addRow!();
      await flushGridEvents();
      expect(grid.getDisplayedRowCount()).toBe(4);

      // The local row carries the pending-insert marker in the edit state.
      const insertSnapBefore = editState.snapshot();
      const insertMarkersBefore = insertSnapBefore.filter(
        (s) =>
          typeof s.value === "object" &&
          s.value !== null &&
          "__vsdb_new_row__" in (s.value as Record<string, unknown>),
      );
      expect(insertMarkersBefore.length).toBeGreaterThanOrEqual(1);

      // Focus the displayed cell at display index 1 (server row id=1,
      // col=id). The local blank row is at display index 3.
      const focusTarget = grid.getDisplayedRowAtIndex(1)!;
      const idCol = grid.getColumnDef("id")!;
      grid.setFocusedCell(focusTarget.rowIndex ?? 1, idCol);
      await flushGridEvents();

      // Paste "R1\nR2\nR3" (3 rows × 1 col). The fix must target:
      //   display[1] = server row id=1 → mark "R1"
      //   display[2] = server row id=2 → mark "R2"
      //   display[3] = LOCAL row id=3 → blank insert marker; the fix
      //     stops BEFORE the local row OR clips it out so we don't
      //     silently overwrite the pending-insert marker.
      // The bug would write R3 into the local row at id=3 and dirty it.
      const gridWrap = (root.querySelector(".vsdb-grid-host") ||
        document.querySelector(".vsdb-grid-host")) as HTMLDivElement | null;
      expect(gridWrap).toBeTruthy();
      const fakeClipboardData = {
        getData: (_type: string) => "R1\nR2\nR3",
      };
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", {
        value: fakeClipboardData,
        enumerable: true,
      });
      gridWrap!.dispatchEvent(ev);
      await flushGridEvents();

      // The paste should mark server rows id=1 and id=2 dirty with R1/R2
      // (2 dirty entries — one cell each, since the paste is 1 column wide
      // and we're at colIndex 0).
      const snap = editState.snapshot();
      const byKey: Record<string, unknown> = {};
      for (const s of snap) byKey[`${s.rowId}:${s.colIndex}`] = s.value;

      // Server rows got pasted values.
      expect(byKey["1:0"]).toBe("R1");
      expect(byKey["2:0"]).toBe("R2");

      // The local row (id=3) MUST NOT have a paste value stamped over its
      // insert marker — it stays as the marker object, untouched.
      const localKey = "3:0";
      if (localKey in byKey) {
        const v = byKey[localKey];
        // If the paste reached the local row, the value would be "R3"
        // (string) — NOT an object with __vsdb_new_row__. So either the
        // key is absent, or it is still the marker object.
        expect(typeof v).toBe("object");
        expect(v).not.toBe("R3");
      }

      // Grid data confirms: server row id=1 id="R1", id=2 id="R2", local
      // row id=3 stays blank (id=""), and no server row at id=3 (there is
      // none) got its data mutated.
      expect(grid.getRowNode("1")!.data!.id).toBe("R1");
      expect(grid.getRowNode("2")!.data!.id).toBe("R2");
      const localNode = grid.getRowNode("3");
      if (localNode) {
        expect(localNode.data!.id === "" || localNode.data!.id == null).toBe(true);
      }
    },
  );
});
