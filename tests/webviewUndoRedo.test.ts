// tests/webviewUndoRedo.test.ts
//
// TASK-008 — Unified Excel-like undo/redo stack wiring (jsdom). #6 cell-edit
// + Cmd+Z reverts cell + strips vsdb-cell-dirty; #7 saveResult ok clears the
// stack (undo past DB write is out of scope).
//
// Loads dist/webview.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, dispatches a state message,
// then exercises the unified undo/redo stack via the toolbar buttons + the
// Cmd/Ctrl+Z keyboard handler. TASK-007 tests live in webviewEditHighlight.test.ts
// (append was rejected by the editor in this session — kept separate to
// avoid double-creating the same describe; both files cover the bundle).
//
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

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface UndoStackHandle {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  clear(): void;
}

interface VsdbDebug {
  gridApi?: GridApi;
  editState?: {
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
  };
  commit?: () => void;
  addRow?: () => void;
  deleteRow?: () => void;
  undo?: () => void;
  redo?: () => void;
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
  undoStack?: UndoStackHandle;
  undoBtn?: HTMLButtonElement;
  redoBtn?: HTMLButtonElement;
}

function vsdbApi(): VsdbDebug | null {
  if (typeof window === "undefined") return null;
  const maybe = (window as unknown as { __vsdb?: VsdbDebug }).__vsdb;
  return maybe ?? null;
}

function getEditState(): VsdbDebug["editState"] | null {
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

function getUndoStack(): UndoStackHandle | null {
  return vsdbApi()?.undoStack ?? null;
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

describeIfBundle("webview/main.ts bundle (TASK-008 undo/redo wiring)", () => {
  // ---- #6: cell edit → Cmd+Z revert + stack tracking --------------------
  itIfBundle(
    "6. cell edit + Cmd+Z reverts cell + strips vsdb-cell-dirty; redo replays",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const editState = getEditState();
      const sim = getSimulateEdit();
      const stack = getUndoStack();
      const debug = vsdbApi()!;
      expect(sim).toBeTruthy();
      expect(editState).toBeTruthy();
      expect(stack).toBeTruthy();

      // Toolbar buttons reflect the empty stack (initially disabled).
      expect(debug.undoBtn).toBeTruthy();
      expect(debug.redoBtn).toBeTruthy();
      expect(debug.undoBtn!.disabled).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(true);

      // Drive an edit through the real wiring.
      sim!(0, "name", "edited-alpha", "alpha");
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(1);
      expect(stack!.canUndo).toBe(true);
      expect(stack!.undoDepth).toBe(1);
      expect(debug.undoBtn!.disabled).toBe(false);
      // Redo is still disabled (no undos yet).
      expect(debug.redoBtn!.disabled).toBe(true);

      const gridHost = document.querySelector(
        ".vsdb-grid-host",
      ) as HTMLDivElement | null;
      expect(gridHost).toBeTruthy();
      const cellsBefore = gridHost!.querySelectorAll(
        '.ag-row[row-index="0"] [col-id="name"].vsdb-cell-dirty',
      );
      expect(cellsBefore.length).toBeGreaterThanOrEqual(1);

      // Dispatch Cmd+Z on the grid wrap (capture-phase listener).
      gridHost!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await flushGridEvents();

      // After undo: dirty map empty, undo branch empty, redo branch holds
      // the popped action, dirty class stripped, redo button enabled.
      expect(editState!.dirtyCount).toBe(0);
      expect(stack!.canUndo).toBe(false);
      expect(stack!.canRedo).toBe(true);
      expect(debug.undoBtn!.disabled).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(false);

      const cellsAfter = gridHost!.querySelectorAll(
        '.ag-row[row-index="0"] [col-id="name"].vsdb-cell-dirty',
      );
      expect(cellsAfter.length).toBe(0);

      // Redo replays — dirty + newValue back, undo button enabled again.
      debug.redo!();
      await flushGridEvents();
      expect(editState!.dirtyCount).toBe(1);
      expect(stack!.canRedo).toBe(false);
      expect(stack!.canUndo).toBe(true);
      expect(debug.undoBtn!.disabled).toBe(false);
      expect(debug.redoBtn!.disabled).toBe(true);
    },
  );

  // ---- #7: full commit success → undoStack cleared ----------------------
  itIfBundle(
    "7. saveResult ok (no rowErrors) → undoStack cleared; undo() → null",
    async () => {
      const { root } = loadBundle();
      void root;
      dispatchState(threeRowsState());
      await flushGridEvents();

      const sim = getSimulateEdit();
      const stack = getUndoStack();
      const debug = vsdbApi()!;
      expect(sim).toBeTruthy();
      expect(stack).toBeTruthy();

      sim!(0, "name", "x", "alpha");
      sim!(1, "name", "y", "beta");
      await flushGridEvents();
      expect(stack!.canUndo).toBe(true);
      expect(stack!.undoDepth).toBeGreaterThanOrEqual(1);

      // Full success (no rowErrors) → editState.clear AND undoStack.clear.
      dispatchHost({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      expect(stack!.canUndo).toBe(false);
      expect(stack!.canRedo).toBe(false);
      expect(stack!.undoDepth).toBe(0);
      expect(debug.undoBtn!.disabled).toBe(true);
      expect(debug.redoBtn!.disabled).toBe(true);
      // Subsequent undo is a no-op (null, no throw).
      debug.undo!();
      await flushGridEvents();
      expect(stack!.canUndo).toBe(false);
    },
  );
});
