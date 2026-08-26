// src/ui/__tests__/webviewCommitRefresh.test.ts
//
// TASK-002 (cycle T) — bundle-eval tests for:
//   A5  — grid shows stale values after a successful commit / refresh.
//   A7  — insert/delete markers stored at colIndex 0 collide with a real
//         edit on column 0.
//   A13 — Refresh silently discards unsaved edits and never messages the
//         host.
//   A16 — Ctrl+C leaks hidden columns, ignores a focused range, and fires
//         twice.
//
// Loads dist/webview.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, dispatches state messages,
// and interacts through the `window.__vsdb` debug object.
//
// If dist/webview.js is missing, all tests are skipped.
// @vitest-environment jsdom
import type { ColumnSpec } from "../resultsGridModel";
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// AG Grid's StateService debounces state dispatches with setTimeout(0).
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

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

// ---- bundle loading --------------------------------------------------------

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface EditStateHandle {
  markDirty: (
    rowId: number,
    colIndex: number,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
  clear: () => void;
  dirtyCount: number;
  snapshot: () => Array<{ rowId: number; colIndex: number; value: unknown }>;
  isRowNew: (rowId: number) => boolean;
}

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface VsdbDebug {
  gridApi?: GridApi;
  editState?: EditStateHandle;
  currentSpecs?: readonly ColumnSpec[];
  commit?: () => void;
  addRow?: () => void;
  deleteRow?: () => void;
  refresh?: () => void;
  debugSetSpecs?: (specs: readonly ColumnSpec[]) => void;
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

function dispatchMsg(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function stateWith(
  columns: string[],
  rows: unknown[][],
): Record<string, unknown> {
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

function threeRowsState(): Record<string, unknown> {
  return stateWith(
    ["id", "name"],
    [
      [1, "alpha"],
      [2, "beta"],
      [3, "gamma"],
    ],
  );
}

function ctrlC(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-002)", () => {
  // ---- A5 — Happy: commit → fresh values / R(A5) ---------------------------
  itIfBundle(
    "A5. same statement, same row count, changed values ⇒ grid shows fresh values (no stale cells)",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const grid = vsdbApi()!.gridApi!;
      expect(grid.getDisplayedRowAtIndex(0)!.data.name).toBe("alpha");

      // Host echoes back the same statement with row 0's value changed —
      // e.g. right after a successful commit, or a background refresh.
      dispatchMsg(
        stateWith(
          ["id", "name"],
          [
            [1, "alpha-updated"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();

      expect(grid.getDisplayedRowCount()).toBe(3);
      expect(grid.getDisplayedRowAtIndex(0)!.data.name).toBe("alpha-updated");
    },
  );

  // ---- A5 idempotent guard ---------------------------------------------------
  itIfBundle(
    "Edge (idempotent). commit with unchanged values ⇒ no redundant setGridOption/applyTransaction, dirtyCount === 0 after ack",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      api.simulateCellEdit!(0, "name", "new-alpha", "alpha");
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(1);

      received.length = 0;
      api.commit!();
      await flushGridEvents();
      expect(received.filter((m) => m.type === "saveEdits")).toHaveLength(1);

      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(0);

      const setSpy = vi.spyOn(grid, "setGridOption");
      const txnSpy = vi.spyOn(grid, "applyTransaction");

      // Host's post-commit state echo carries EXACTLY the same rows the
      // grid already had before the local edit (i.e. the commit's target
      // value never actually differed from server truth) — the new
      // "values differ" branch must correctly see no diff and no-op.
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      expect(setSpy).not.toHaveBeenCalledWith(
        "rowData",
        expect.anything(),
      );
      expect(txnSpy).not.toHaveBeenCalled();
      expect(getEditState()!.dirtyCount).toBe(0);
    },
  );

  // ---- A6 — Happy: Add Row → commit payload / R(A6) -------------------------
  itIfBundle(
    "A6. Add Row → commit payload: edits[0].value.values is unknown[] of columns.length, DEFAULT_CELL sentinel (never '')",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.addRow!();
      await flushGridEvents();

      received.length = 0;
      api.commit!();
      await flushGridEvents();

      const saveMsgs = received.filter((m) => m.type === "saveEdits");
      expect(saveMsgs).toHaveLength(1);
      const payload = saveMsgs[0] as {
        edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      };
      const markerEntry = payload.edits.find(
        (e) =>
          typeof e.value === "object" &&
          e.value !== null &&
          (e.value as Record<string, unknown>).__vsdb_new_row__ === true,
      );
      expect(markerEntry).toBeTruthy();
      const values = (markerEntry!.value as { values: unknown }).values;
      expect(Array.isArray(values)).toBe(true);
      const arr = values as unknown[];
      // threeRowsState has 2 columns (id, name).
      expect(arr).toHaveLength(2);
      for (const cell of arr) {
        expect(cell).not.toBe("");
        expect(cell).toEqual({ __vsdb_default__: true });
      }
      // Marker lives at MARKER_COL_INSERT (-1), never colIndex 0.
      expect(markerEntry!.colIndex).toBe(-1);
    },
  );

  // ---- A7 — Edge (collision): Add Row then type in column 0 -----------------
  itIfBundle(
    "Edge (collision) / R(A7). Add Row then edit column 0 of the new row ⇒ snapshot has BOTH the insert marker and the cell edit (2 entries)",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const before = grid.getDisplayedRowCount();
      api.addRow!();
      await flushGridEvents();

      const newRow = grid.getDisplayedRowAtIndex(before);
      const newRowId = newRow!.data.__rowId as number;

      // Column 0 is "id" — typing in it must NOT clobber the insert
      // marker (old bug: both were stored at colIndex 0, and
      // EditState.markDirty coalesces same-key writes).
      api.simulateCellEdit!(newRowId, "id", 999, "");
      await flushGridEvents();

      const editState = getEditState()!;
      expect(editState.dirtyCount).toBe(2);
      const snap = editState.snapshot();
      const forRow = snap.filter((s) => s.rowId === newRowId);
      expect(forRow).toHaveLength(2);
      const colIndices = forRow.map((s) => s.colIndex).sort((a, b) => a - b);
      expect(colIndices).toEqual([-1, 0]);
      const marker = forRow.find((s) => s.colIndex === -1);
      expect(
        (marker!.value as Record<string, unknown>).__vsdb_new_row__,
      ).toBe(true);
      const cellEdit = forRow.find((s) => s.colIndex === 0);
      expect(cellEdit!.value).toBe(999);
    },
  );

  // ---- A13 — Edge (permission/confirm): Refresh with dirtyCount > 0 ---------
  itIfBundle(
    "Edge (permission/confirm) / R(A13). Refresh with dirtyCount > 0: in-DOM Cancel preserves edits; Discard requeries",
    async () => {
      const { received, root } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "edited", "alpha");
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(1);

      // The VS Code webview does not provide window.confirm.
      delete (window as unknown as { confirm?: unknown }).confirm;
      received.length = 0;
      api.refresh!();
      await flushGridEvents();

      expect(getEditState()!.dirtyCount).toBe(1);
      expect(received).toHaveLength(0);
      const banner = root.querySelector(".vsdb-save-banner")!;
      expect(banner.classList.contains("vsdb-hidden")).toBe(false);
      const cancel = banner.querySelector("[data-vsdb-refresh-cancel]") as HTMLButtonElement;
      const discard = banner.querySelector("[data-vsdb-refresh-discard]") as HTMLButtonElement;
      expect(cancel).toBeTruthy();
      expect(discard).toBeTruthy();

      cancel.click();
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(1);
      expect(received).toHaveLength(0);

      api.refresh!();
      await flushGridEvents();
      discard.click();
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(0);
      expect(received.filter((m) => m.type === "requery")).toHaveLength(1);
    },
  );

  // ---- A13 — Refresh with nothing dirty: no confirm, still requeries -------
  itIfBundle(
    "Refresh with dirtyCount === 0: posts requery without confirm banner",
    async () => {
      const { received, root } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      received.length = 0;
      vsdbApi()!.refresh!();
      await flushGridEvents();

      expect(received.filter((m) => m.type === "requery")).toHaveLength(1);
      expect(root.querySelector("[data-vsdb-refresh-cancel]")).toBeNull();
      expect(root.querySelector("[data-vsdb-refresh-discard]")).toBeNull();
    },
  );

  // ---- A16 — Edge (double-fire) ---------------------------------------------
  itIfBundle(
    "Edge (double-fire). one Ctrl+C keypress on a focused grid cell ⇒ exactly 1 copy message",
    async () => {
      const { root, received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const grid = vsdbApi()!.gridApi!;
      let idx = 0;
      grid.forEachNode((node) => {
        if (idx < 2 && node.data) node.setSelected(true, false, "api");
        idx++;
      });
      // The double-fire bug only reproduces when the keydown originates on
      // an ACTUAL grid cell element — that is what AG Grid's own
      // `onCellKeyDown` grid-option listens for internally. Dispatching
      // directly on the gridWrap wrapper (an ancestor of every cell) only
      // ever reaches the capture-phase wrapper listener, never AG Grid's
      // own cell-level listener, so it can't catch a double-binding
      // regression.
      grid.setFocusedCell(0, "name");
      await flushGridEvents();
      const cell = root.querySelector(".ag-cell") as HTMLElement | null;
      expect(cell).toBeTruthy();

      received.length = 0;
      ctrlC(cell!);
      await flushGridEvents();

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs).toHaveLength(1);
    },
  );

  // ---- A16 — Edge (hidden column) --------------------------------------------
  itIfBundle(
    "Edge (hidden column). copy with spec.hidden column ⇒ hidden column absent from copied TSV",
    async () => {
      const { root, received } = loadBundle();
      dispatchMsg(stateWith(["id", "secret"], [[1, "s3cr3t"]]));
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const specs = api.currentSpecs!;
      expect(specs.map((s) => s.field)).toEqual(["id", "secret"]);
      api.debugSetSpecs!(
        specs.map((s) => (s.field === "secret" ? { ...s, hidden: true } : s)),
      );

      let idx = 0;
      grid.forEachNode((node) => {
        if (node.data) node.setSelected(true, false, "api");
        idx++;
      });
      void idx;

      const gridWrap = root.querySelector(".vsdb-grid-host") as HTMLElement;
      received.length = 0;
      ctrlC(gridWrap);
      await flushGridEvents();

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs).toHaveLength(1);
      const text = (copyMsgs[0] as { text: string }).text;
      expect(text).not.toContain("s3cr3t");
      expect(text).toContain("1");
    },
  );

  // ---- A16 — Edge (duplicate names): hiddenColumns via headerName -----------
  itIfBundle(
    "Edge (duplicate names). SELECT a.id, b.id with 2nd column hidden ⇒ hiddenColumns derived from headerName excludes it from the TSV export",
    async () => {
      const { root, received } = loadBundle();
      // Raw wire columns literally duplicate "id" (as postgres would for
      // `SELECT a.id, b.id`) — this is the scenario TASK-003's dedup
      // targets, but the raw column NAME list on the wire is unaffected
      // by that fix (it always mirrors the driver's column names).
      dispatchMsg(stateWith(["id", "id"], [[1, 2]]));
      await flushGridEvents();

      const api = vsdbApi()!;
      const specs = api.currentSpecs!;
      // Simulate TASK-003's dedup output: unique `field`, duplicated
      // `headerName`, 2nd column hidden.
      api.debugSetSpecs!([
        { ...specs[0], field: "id", headerName: "id", hidden: false },
        { ...specs[1], field: "id__2", headerName: "id", hidden: true },
      ]);

      const copyBtn = root.querySelector(
        ".vsdb-export-copy",
      ) as HTMLButtonElement | null;
      expect(copyBtn).toBeTruthy();
      received.length = 0;
      copyBtn!.click();
      await flushGridEvents();

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs).toHaveLength(1);
      const text = (copyMsgs[0] as { text: string }).text;
      // The hidden value (2) must not survive into the export. Deriving
      // hiddenColumns from `field` ("id__2") would match NOTHING in the
      // raw ["id","id"] columns array and leak it through.
      expect(text).not.toContain("2");
    },
  );

  // ---- A16 — Edge (duplicate names, values): field-keyed copy survives ------
  itIfBundle(
    "Edge (duplicate names, values). distinct id/id__2 values survive Ctrl+C copy keyed on field, not headerName",
    async () => {
      const { root, received } = loadBundle();
      dispatchMsg(stateWith(["id", "id"], [[1, 2]]));
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      const specs = api.currentSpecs!;
      // Same TASK-003-shaped injection as above, but BOTH columns visible
      // this time — the point is field-based indexing, not hiding.
      api.debugSetSpecs!([
        { ...specs[0], field: "id", headerName: "id", hidden: false },
        { ...specs[1], field: "id__2", headerName: "id", hidden: false },
      ]);
      // Seed matching row data keyed by the deduped fields — this is what
      // rowsToObjects would produce once TASK-003's dedup lands; injecting
      // it directly here keeps this test independent of that parallel
      // worktree's state.
      grid.setGridOption("rowData", [
        { __rowId: 0, id: "distinct-a", id__2: "distinct-b" },
      ]);
      await flushGridEvents();

      // Exercise Add Row too (per the test case: "Add Row then Ctrl+C")
      // — it must not corrupt the field mapping for the existing row.
      api.addRow!();
      await flushGridEvents();

      let idx = 0;
      grid.forEachNode((node) => {
        // Select only the original (pre-existing) row, not the new blank
        // one, so the copied text is unambiguous.
        if (idx === 0 && node.data) node.setSelected(true, false, "api");
        idx++;
      });

      const gridWrap = root.querySelector(".vsdb-grid-host") as HTMLElement;
      received.length = 0;
      ctrlC(gridWrap);
      await flushGridEvents();

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs).toHaveLength(1);
      const text = (copyMsgs[0] as { text: string }).text;
      // If :2199-equivalent indexing were keyed on headerName ("id") for
      // both columns, this would collapse to a single repeated value
      // instead of carrying both distinct values.
      expect(text).toBe("distinct-a\tdistinct-b");
    },
  );

  // ---- A16 — Edge (focus vs selection) ---------------------------------------
  itIfBundle(
    "Edge (focus vs selection). Ctrl+C with a focused cell and no checkbox selection copies the focused row, not ''",
    async () => {
      const { root, received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const grid = vsdbApi()!.gridApi!;
      expect(grid.getSelectedRows()).toHaveLength(0);
      grid.setFocusedCell(1, "name");
      await flushGridEvents();

      const gridWrap = root.querySelector(".vsdb-grid-host") as HTMLElement;
      received.length = 0;
      ctrlC(gridWrap);
      await flushGridEvents();

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs).toHaveLength(1);
      const text = (copyMsgs[0] as { text: string }).text;
      expect(text).not.toBe("");
      expect(text).toContain("beta");
    },
  );

  // ---- A12 — saveEdits carries serverIndexByRowId ----------------------------
  itIfBundle(
    "R(A12). saveEdits message carries serverIndexByRowId for every rendered row",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.simulateCellEdit!(1, "name", "new-beta", "beta");
      await flushGridEvents();

      received.length = 0;
      api.commit!();
      await flushGridEvents();

      const saveMsgs = received.filter((m) => m.type === "saveEdits");
      expect(saveMsgs).toHaveLength(1);
      const payload = saveMsgs[0] as {
        serverIndexByRowId?: Record<string, number>;
      };
      expect(payload.serverIndexByRowId).toBeTruthy();
      // threeRowsState has 3 rows, __rowId 0/1/2 map 1:1 to source index.
      expect(payload.serverIndexByRowId).toMatchObject({
        "0": 0,
        "1": 1,
        "2": 2,
      });
    },
  );

  // ---- Finding 4 (review fix round, cycle T) --------------------------------
  itIfBundle(
    "Finding 4. Add Row -> commit -> post-commit refresh grows row count ⇒ no phantom placeholder row survives",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      expect(grid.getDisplayedRowCount()).toBe(3);

      api.addRow!();
      await flushGridEvents();
      expect(grid.getDisplayedRowCount()).toBe(4);

      api.simulateCellEdit!(3, "name", "delta", "");
      await flushGridEvents();

      received.length = 0;
      api.commit!();
      await flushGridEvents();
      expect(
        received.filter((m) => m.type === "saveEdits"),
      ).toHaveLength(1);

      // Host's success ack clears editState/undoStack — mirrors
      // handleSaveResult's real ok:true path — but the placeholder row
      // itself and newRowCount are untouched by this message alone.
      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(0);

      // Post-commit refresh: the host re-runs the original SELECT and
      // echoes back the authoritative row set, now grown by exactly the
      // one committed row (id 4, name "delta").
      dispatchMsg(
        stateWith(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
            [4, "delta"],
          ],
        ),
      );
      await flushGridEvents();

      // Must be exactly 4 — the old bug appended the new server row via
      // append-delta WITHOUT removing the local placeholder, leaving a
      // phantom 5th (blank) row.
      expect(grid.getDisplayedRowCount()).toBe(4);
      const names: string[] = [];
      grid.forEachNode((node) => {
        if (node.data) names.push(node.data.name as string);
      });
      expect(names.sort()).toEqual(["alpha", "beta", "delta", "gamma"]);
    },
  );

  // ---- Finding 4 (fix round 2) — partial commit ------------------------------
  itIfBundle(
    "Finding 4 (fix round 2). partial commit: one Add-Row row commits, the other errors ⇒ committed placeholder is replaced by the server row (no phantom), errored placeholder + its edits survive untouched",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      expect(grid.getDisplayedRowCount()).toBe(3);

      // Add two rows: rowId 3 will commit successfully, rowId 4 will be
      // reported as an errored row in the saveResult ack (TASK-007
      // per-row error handling).
      api.addRow!();
      await flushGridEvents();
      api.addRow!();
      await flushGridEvents();
      expect(grid.getDisplayedRowCount()).toBe(5);

      api.simulateCellEdit!(3, "name", "delta-committed", "");
      await flushGridEvents();
      api.simulateCellEdit!(4, "name", "epsilon-failed", "");
      await flushGridEvents();

      received.length = 0;
      api.commit!();
      await flushGridEvents();
      expect(
        received.filter((m) => m.type === "saveEdits"),
      ).toHaveLength(1);

      // Partial success: rowId 3 committed, rowId 4 errored. The old bug
      // gated the phantom-placeholder cleanup on `dirtyCount === 0`,
      // which never holds here (rowId 4's edits are intentionally kept
      // dirty for retry) — so rowId 3's placeholder was never reconciled
      // away either.
      dispatchMsg({
        type: "saveResult",
        index: 0,
        ok: true,
        rowErrors: [{ rowId: 4, error: "constraint violation" }],
      });
      await flushGridEvents();

      const editState = getEditState()!;
      // rowId 4's insert marker + cell edit must survive the ack — this
      // is the guard against the naive "just clear everything" fix,
      // which would silently drop the user's still-unsaved edits.
      expect(editState.dirtyCount).toBe(2);

      // Post-commit refresh: server now has the 3 original rows PLUS the
      // one committed row (id 4, name "delta-committed"). rowId 4 (the
      // errored local row) was never persisted, so it is absent from the
      // server echo.
      dispatchMsg(
        stateWith(
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
            [3, "gamma"],
            [4, "delta-committed"],
          ],
        ),
      );
      await flushGridEvents();

      // Must be exactly 5: 4 authoritative server rows + the 1 still-
      // errored local placeholder (rowId 4, "epsilon-failed") kept for
      // retry. The old bug left a 6th phantom blank row (rowId 3's
      // committed placeholder, never reconciled) sitting alongside it.
      expect(grid.getDisplayedRowCount()).toBe(5);
      const names: string[] = [];
      grid.forEachNode((node) => {
        if (node.data) names.push(node.data.name as string);
      });
      expect(names.sort()).toEqual([
        "alpha",
        "beta",
        "delta-committed",
        "epsilon-failed",
        "gamma",
      ]);

      // The still-pending errored row must still be recognized as a
      // dirty new-row (retry banner / vsdb-row-new styling depend on
      // this) with its typed value intact.
      expect(editState.isRowNew(4)).toBe(true);
      const snap = editState.snapshot();
      const row4Edits = snap.filter((s) => s.rowId === 4);
      expect(row4Edits).toHaveLength(2);
      const cellEdit = row4Edits.find((s) => s.colIndex === 1);
      expect(cellEdit!.value).toBe("epsilon-failed");
    },
  );
});
