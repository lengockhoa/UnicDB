// tests/webviewEditHighlight.test.ts
//
// TASK-007 — Excel editing dirty highlight + add-row / delete-row commit flow.
//
// Loads dist/webview.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, dispatches a state message,
// then exercises:
//
//  - 1) cell edit (cellValueChanged path) → grid cell carries `vsdb-cell-dirty`
//  - 2) add row → row carries `vsdb-row-new`; delete row → row carries
//       `vsdb-row-deleted`; styles.css has `.vsdb-row-deleted { text-decoration:
//       line-through; opacity: .6 }`
//  - 3) commit when 0 dirty → no saveEdits posted (no-op guard)
//  - 4) commit 1 row errors → rowErrors banner shows error, errored row keeps
//       dirty state, other rows' dirty cleared
//  - 5) saveResult ok → editState cleared (new baseline), no vsdb-cell-dirty
//       remains on any cell
//
// If dist/webview.js is missing, tests are skipped with an explanatory message.
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
  commit?: () => void;
  addRow?: () => void;
  deleteRow?: () => void;
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
    const factory = (_query: string): MediaQueryListLike => ({
      matches: false,
      media: _query,
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

function dispatchHost(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-007)", () => {
  // ---- #1: cell edit → cell has vsdb-cell-dirty ----------------------------
  itIfBundle(
    "1. cell edit applies vsdb-cell-dirty to the edited cell element",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const editState = getEditState();
      expect(editState).toBeTruthy();
      expect(editState!.dirtyCount).toBe(0);

      // Drive the bundle's REAL wiring through simulateCellEdit (same
      // code path as a real user edit).
      const sim = getSimulateEdit();
      expect(sim).toBeTruthy();
      sim!(0, "name", "new-alpha", "alpha");
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(1);

      // Find the rendered cell for (rowId=0, field=name). AG Grid renders
      // data cells with class `ag-cell` and a `col-id="<colId>"` attribute
      // (colId === field when no explicit colId is set). The dirty class
      // is appended to the cell's classList by `cellClassRules`.
      const grid = vsdbApi()!.gridApi!;
      expect(grid).toBeTruthy();
      const node = grid.getRowNode("0");
      expect(node).toBeTruthy();
      // Rendered cell: AG Grid uses `ag-cell-value` wrappers with the
      // column id in the col-id attribute. We probe by looking inside the
      // grid host for any element matching `[col-id=name]` whose row
      // index corresponds to rowId 0.
      const gridHost = document.querySelector(
        ".vsdb-grid-host",
      ) as HTMLDivElement | null;
      expect(gridHost).toBeTruthy();
      // AG Grid v36 renders rows as `role="row"` with cells
      // `role="gridcell"` + `col-id="<id>"`. Pick the cell in the row
      // matching rowId=0 (first data row).
      const cells = gridHost!.querySelectorAll(
        '.ag-row[row-index="0"] [col-id="name"]',
      );
      expect(cells.length).toBeGreaterThanOrEqual(1);
      const editedCell = cells[0] as HTMLElement;
      expect(editedCell.classList.contains("vsdb-cell-dirty")).toBe(true);
    },
  );

  // ---- #2: add row → vsdb-row-new; delete row → vsdb-row-deleted + line-through
  itIfBundle(
    "2. add row → vsdb-row-new; delete row → vsdb-row-deleted with line-through CSS",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      const grid = api.gridApi!;
      expect(typeof api.addRow).toBe("function");
      expect(typeof api.deleteRow).toBe("function");

      // Add row → new row's element carries vsdb-row-new.
      api.addRow!();
      await flushGridEvents();

      const gridHost = document.querySelector(
        ".vsdb-grid-host",
      ) as HTMLDivElement | null;
      expect(gridHost).toBeTruthy();
      const newRowEls = gridHost!.querySelectorAll(".vsdb-row-new");
      expect(newRowEls.length).toBe(1);

      // Delete row → focus the first server row (rowId=0), call deleteRow.
      const firstServerNode = grid.getDisplayedRowAtIndex(0);
      expect(firstServerNode).toBeTruthy();
      const idCol = grid.getColumnDef("id")!;
      grid.setFocusedCell(firstServerNode!.rowIndex ?? 0, idCol);
      await flushGridEvents();
      api.deleteRow!();
      await flushGridEvents();

      const deletedRowEls = gridHost!.querySelectorAll(".vsdb-row-deleted");
      expect(deletedRowEls.length).toBe(1);

      // The styles.css source must contain the `.vsdb-row-deleted` rule
      // with `line-through` — the regression assertion that the CSS
      // class actually paints strikethrough.
      const stylesPath = resolve(process.cwd(), "webview", "styles.css");
      const styles = readFileSync(stylesPath, "utf8");
      // Loose match: rule body must contain line-through. AG Grid
      // generates a `.ag-row` parent so the rule may be on `.vsdb-row-deleted
      // .ag-cell` per the task spec snippet.
      expect(styles).toMatch(/\.vsdb-row-deleted[^}]*line-through/s);
      expect(styles).toMatch(/opacity:\s*(?:\.6|0\.6)/);
    },
  );

  // ---- #3: commit with 0 dirty → no-op (no saveEdits posted) ----------------
  itIfBundle("3. commit when 0 dirty → no saveEdits posted", async () => {
    const { received } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    expect(getEditState()!.dirtyCount).toBe(0);
    received.length = 0;
    vsdbApi()!.commit!();
    await flushGridEvents();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs).toHaveLength(0);
  });

  // ---- #4: commit 1 row errors → rowErrors banner + errored row stays dirty
  itIfBundle(
    "4. saveResult with rowErrors → banner shows row error, errored row keeps dirty, others cleared",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const editState = getEditState();
      expect(editState).toBeTruthy();
      const sim = getSimulateEdit();
      expect(sim).toBeTruthy();
      // Two edits on different rows + one on a third row — we expect row 1
      // to error; rows 0 and 2 to succeed (clear dirty). EditState keys:
      //   (0, name) → dirty
      //   (1, name) → dirty
      //   (2, id)   → dirty
      sim!(0, "name", "ok-row-0", "alpha");
      sim!(1, "name", "bad-row-1", "beta");
      sim!(2, "id", 99, 3);
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(3);

      // Host returns ok:true with rowErrors marking row 1 as failed.
      dispatchHost({
        type: "saveResult",
        index: 0,
        ok: true,
        rowErrors: [{ rowId: 1, error: "duplicate key" }],
      });
      await flushGridEvents();

      // Banner must include the per-row error text.
      const banner = document.querySelector(".vsdb-save-banner");
      expect(banner).toBeTruthy();
      expect(banner!.textContent ?? "").toMatch(/row\s*1/i);
      expect(banner!.textContent ?? "").toMatch(/duplicate key/);
      // Banner is visible (no hidden class).
      const hidden =
        banner!.classList.contains("vsdb-hidden") ||
        banner!.getAttribute("hidden") !== null;
      expect(hidden).toBe(false);

      // EditState must still carry the errored row's dirty entries; the
      // successful rows' entries are cleared.
      expect(editState!.dirtyCount).toBe(1);
      const snap = editState!.snapshot();
      const keys = new Set(snap.map((s) => `${s.rowId}:${s.colIndex}`));
      expect(keys.has("1:1")).toBe(true); // (rowId=1, colIndex=1) for "name"
      expect(keys.has("0:1")).toBe(false); // row 0 cleared
      expect(keys.has("2:0")).toBe(false); // row 2 cleared
    },
  );

  // ---- #5: saveResult ok → editState cleared, no vsdb-cell-dirty remains ---
  itIfBundle(
    "5. saveResult ok → editState cleared (new baseline), no cell carries vsdb-cell-dirty",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const editState = getEditState();
      const sim = getSimulateEdit();
      expect(sim).toBeTruthy();
      sim!(0, "name", "x", "alpha");
      sim!(1, "name", "y", "beta");
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(2);

      const gridHost = document.querySelector(
        ".vsdb-grid-host",
      ) as HTMLDivElement | null;
      expect(gridHost).toBeTruthy();
      // Pre-condition: at least one cell carries vsdb-cell-dirty.
      const dirtyBefore = gridHost!.querySelectorAll(".vsdb-cell-dirty");
      expect(dirtyBefore.length).toBeGreaterThanOrEqual(1);

      // Host returns ok:true (no rowErrors) — full success.
      dispatchHost({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      expect(editState!.dirtyCount).toBe(0);

      // After clear, AG Grid must re-render and strip the dirty class.
      // (The grid applies cellClassRules from editState; with editState
      // empty, no cell should match.)
      const dirtyAfter = gridHost!.querySelectorAll(".vsdb-cell-dirty");
      expect(dirtyAfter.length).toBe(0);
    },
  );
});
// =============================================================================
// TASK-008 — unified undo/redo wiring (jsdom). #6 cell-edit + Cmd+Z revert;
// #7 commit success → undoStack cleared.
// =============================================================================
interface UndoStackHandle {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  clear(): void;
}
interface VsdbDebugUndo extends VsdbDebug {
  undoStack?: UndoStackHandle;
  undo?: () => void;
  redo?: () => void;
  redoBtn?: HTMLButtonElement;
  undoBtn?: HTMLButtonElement;
}
function undoApi(): VsdbDebugUndo | null {
  return vsdbApi() as VsdbDebugUndo | null;
}
function getUndoStack(): UndoStackHandle | null {
  return undoApi()?.undoStack ?? null;
}
describeIfBundle("webview/main.ts bundle (TASK-008 undo/redo wiring)", () => {
  itIfBundle(
    "6. cell edit → Cmd+Z reverts the cell + strips vsdb-cell-dirty; stack tracks the action",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const editState = getEditState();
      const sim = getSimulateEdit();
      const stack = getUndoStack();
      expect(sim).toBeTruthy();
      expect(editState).toBeTruthy();
      expect(stack).toBeTruthy();

      const debug = undoApi()!;
      expect(debug.undoBtn).toBeTruthy();
      expect(debug.redoBtn).toBeTruthy();
      expect(debug.undoBtn!.disabled).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(true);

      sim!(0, "name", "edited-alpha", "alpha");
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(1);
      expect(stack!.canUndo).toBe(true);
      expect(debug.undoBtn!.disabled).toBe(false);

      const gridHost = document.querySelector(
        ".vsdb-grid-host",
      ) as HTMLDivElement | null;
      expect(gridHost).toBeTruthy();
      const cellsBefore = gridHost!.querySelectorAll(
        '.ag-row[row-index="0"] [col-id="name"].vsdb-cell-dirty',
      );
      expect(cellsBefore.length).toBeGreaterThanOrEqual(1);

      gridHost!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await flushGridEvents();

      expect(editState!.dirtyCount).toBe(0);
      expect(stack!.canUndo).toBe(false);
      expect(stack!.canRedo).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(false);

      const cellsAfter = gridHost!.querySelectorAll(
        '.ag-row[row-index="0"] [col-id="name"].vsdb-cell-dirty',
      );
      expect(cellsAfter.length).toBe(0);

      debug.redo!();
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(1);
      expect(stack!.canRedo).toBe(false);
      expect(stack!.canUndo).toBe(true);
    },
  );
  itIfBundle(
    "7. saveResult ok (no rowErrors) → undoStack cleared; undo() → null",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const sim = getSimulateEdit();
      const stack = getUndoStack();
      expect(sim).toBeTruthy();
      expect(stack).toBeTruthy();

      sim!(0, "name", "x", "alpha");
      sim!(1, "name", "y", "beta");
      await flushGridEvents();
      expect(stack!.canUndo).toBe(true);
      expect(stack!.undoDepth).toBeGreaterThanOrEqual(1);

      dispatchHost({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      expect(stack!.canUndo).toBe(false);
      expect(stack!.canRedo).toBe(false);
      expect(stack!.undoDepth).toBe(0);
      const debug = undoApi()!;
      expect(debug.undoBtn!.disabled).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(true);
      debug.undo!();
      await flushGridEvents();
      expect(stack!.canUndo).toBe(false);
    },
  );
});
