// src/ui/__tests__/webviewClipboardPaste.test.ts
// TASK-CLIP-002 — jsdom bundle-level paste matrix for the Results grid.
//
// The suite evaluates the real dist/webview.js bundle and drives the same
// capture-phase paste listener used by the webview. It intentionally keeps
// production seams out of the test: state, gridApi, addRow, and undoStack are
// the existing __UnicDB debug handles exposed by webview/main.ts.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

interface DirtyCell {
  rowId: number;
  colIndex: number;
  value: unknown;
}

interface EditStateHandle {
  dirtyCount: number;
  snapshot: () => DirtyCell[];
}

interface UndoStackHandle {
  canUndo: boolean;
}

interface UnicDBDebug {
  gridApi?: GridApi;
  editState?: EditStateHandle;
  undoStack?: UndoStackHandle;
  addRow?: () => void;
}

interface HostApi {
  postMessage: (msg: unknown) => void;
}

function unicDb(): UnicDBDebug | null {
  return (window as unknown as { __UnicDB?: UnicDBDebug }).__UnicDB ?? null;
}

beforeAll(() => {
  const g = globalThis as unknown as {
    ResizeObserver?: typeof ResizeObserver;
    matchMedia?: (query: string) => MediaQueryListLike;
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
    g.matchMedia = (query: string): MediaQueryListLike => ({
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

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

// A bundle eval installs window-level message/mouseup listeners. Remove those
// listeners between tests so state from an earlier eval cannot process a later
// dispatch more than once.
const originalAddEventListener = window.addEventListener.bind(window);
const bundleListeners: Array<{
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}> = [];
window.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void => {
  bundleListeners.push({ type, listener, options });
  originalAddEventListener(type, listener, options);
}) as typeof window.addEventListener;

function loadBundle(): {
  root: HTMLDivElement;
  received: Array<Record<string, unknown>>;
} {
  if (!bundleSrc) {
    throw new Error("dist/webview.js missing — run `npm run compile` before this test");
  }
  for (const { type, listener, options } of bundleListeners) {
    window.removeEventListener(type, listener, options);
  }
  bundleListeners.length = 0;
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const received: Array<Record<string, unknown>> = [];
  const api: HostApi = {
    postMessage: (msg) => received.push(msg as Record<string, unknown>),
  };
  (globalThis as unknown as { acquireVsCodeApi: () => HostApi }).acquireVsCodeApi =
    () => api;
  (0, eval)(bundleSrc);
  return {
    root: document.getElementById("UnicDB-root") as HTMLDivElement,
    received,
  };
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

// AG Grid flushes row rendering and event handlers on a macrotask in jsdom;
// this integration seam must await that real browser-like event turn.
async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function gridHost(root: HTMLDivElement): HTMLDivElement {
  const host = root.querySelector(".UnicDB-grid-host") as HTMLDivElement | null;
  if (!host) throw new Error("grid host was not rendered");
  return host;
}

function dispatchPaste(target: EventTarget, text: string): void {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { getData: (_type: string) => text },
    enumerable: true,
  });
  target.dispatchEvent(ev);
}

function cell(root: HTMLDivElement, row: number, colId: string): HTMLElement {
  const result =
    (root.querySelector(
      `.ag-cell[row-index="${row}"][col-id="${colId}"]`,
    ) as HTMLElement | null) ??
    (root.querySelector(
      `.ag-row[row-index="${row}"] .ag-cell[col-id="${colId}"]`,
    ) as HTMLElement | null);
  if (!result) throw new Error(`cell ${row}:${colId} was not rendered`);
  return result;
}

function dragRange(
  root: HTMLDivElement,
  start: { row: number; colId: string },
  end: { row: number; colId: string },
): void {
  const startCell = cell(root, start.row, start.colId);
  const endCell = cell(root, end.row, end.colId);
  startCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  endCell.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function byKey(editState: EditStateHandle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of editState.snapshot()) {
    out[`${entry.rowId}:${entry.colIndex}`] = entry.value;
  }
  return out;
}

function pasteMessageCount(
  received: Array<Record<string, unknown>>,
  type: string,
): number {
  return received.filter((message) => message.type === type).length;
}

describe("webview/main.ts bundle (TASK-CLIP-002 paste matrix)", () => {
  it("paste 2x2 TSV at focused cell marks 2+2 dirty and mirrors into nodes", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = unicDb()!;
    const editState = api.editState!;
    api.gridApi!.setFocusedCell(0, "id");
    dispatchPaste(gridHost(root), "10\tx\n20\ty");
    await flushGridEvents();

    expect(editState.dirtyCount).toBe(4);
    expect(byKey(editState)).toMatchObject({
      "0:0": "10",
      "0:1": "x",
      "1:0": "20",
      "1:1": "y",
    });
    expect(api.gridApi!.getRowNode("0")!.data.id).toBe("10");
    expect(api.gridApi!.getRowNode("1")!.data.name).toBe("y");
  });

  it("Excel-origin CRLF + trailing newline parses", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = unicDb()!;
    api.gridApi!.setFocusedCell(0, "id");
    dispatchPaste(gridHost(root), "1\r\n2\r\n");
    await flushGridEvents();

    expect(api.editState!.dirtyCount).toBe(2);
    expect(byKey(api.editState!)).toMatchObject({ "0:0": "1", "1:0": "2" });
    expect(byKey(api.editState!)).not.toHaveProperty("2:0");
  });

  it("1x1 clipboard tiles into active 2x2 range", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    dragRange(root, { row: 0, colId: "id" }, { row: 1, colId: "name" });
    dispatchPaste(gridHost(root), "z");
    await flushGridEvents();

    const editState = unicDb()!.editState!;
    expect(editState.dirtyCount).toBe(4);
    expect(byKey(editState)).toMatchObject({
      "0:0": "z",
      "0:1": "z",
      "1:0": "z",
      "1:1": "z",
    });
  });

  it("3x3 clipboard into 2x2 range clips over-paste", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    dragRange(root, { row: 0, colId: "id" }, { row: 1, colId: "name" });
    dispatchPaste(gridHost(root), "a\tb\tc\nd\te\tf\ng\th\ti");
    await flushGridEvents();

    const api = unicDb()!;
    const edits = byKey(api.editState!);
    expect(api.editState!.dirtyCount).toBe(4);
    expect(edits).toMatchObject({ "0:0": "a", "0:1": "b", "1:0": "d", "1:1": "e" });
    expect(edits).not.toHaveProperty("2:0");
    expect(edits).not.toHaveProperty("0:2");
    expect(api.gridApi!.getRowNode("2")!.data.id).toBe(3);
  });

  it("paste with empty text/plain is a no-op", async () => {
    const { root, received } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();
    received.length = 0;

    dispatchPaste(gridHost(root), "");
    await flushGridEvents();

    expect(unicDb()!.editState!.dirtyCount).toBe(0);
    expect(pasteMessageCount(received, "copy")).toBe(0);
    expect(pasteMessageCount(received, "saveEdits")).toBe(0);
  });

  it("paste on filter input is user typing, not a grid edit", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const input = document.createElement("input");
    input.value = "keep me";
    gridHost(root).appendChild(input);
    input.focus();
    dispatchPaste(input, "not-a-grid-value");
    await flushGridEvents();

    expect(unicDb()!.editState!.dirtyCount).toBe(0);
    expect(input.value).toBe("keep me");
  });

  it("paste 2 rows with only 1 displayed row left clips at bottom edge", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = unicDb()!;
    api.gridApi!.setFocusedCell(2, "id");
    dispatchPaste(gridHost(root), "bottom\nignored");
    await flushGridEvents();

    expect(api.editState!.dirtyCount).toBe(1);
    expect(byKey(api.editState!)).toEqual({ "2:0": "bottom" });
    expect(api.gridApi!.getRowNode("2")!.data.id).toBe("bottom");
  });

  it("paste stops before locally-added rows", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = unicDb()!;
    api.addRow!();
    await flushGridEvents();
    const localData = api.gridApi!.getDisplayedRowAtIndex(3)!.data;
    if (!localData || typeof localData !== "object" || !("__rowId" in localData)) {
      throw new Error("local Add Row fixture did not expose __rowId");
    }
    const localRowId = localData.__rowId;
    if (typeof localRowId !== "number") throw new Error("local row id is not numeric");
    api.gridApi!.setFocusedCell(1, "id");
    dispatchPaste(gridHost(root), "R1\nR2\nR3");
    await flushGridEvents();

    const snapshot = api.editState!.snapshot();
    expect(snapshot.filter((entry) => entry.rowId === localRowId && entry.colIndex >= 0)).toEqual([]);
    expect(byKey(api.editState!)).toMatchObject({ "1:0": "R1", "2:0": "R2" });
    expect(api.gridApi!.getRowNode(String(localRowId))!.data.id).toBe("");
  });

  it("undo parity: one Cmd+Z reverts one cell-edit after a four-cell paste", async () => {
    const { root } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const api = unicDb()!;
    api.gridApi!.setFocusedCell(0, "id");
    dispatchPaste(gridHost(root), "10\tx\n20\ty");
    await flushGridEvents();
    expect(api.editState!.dirtyCount).toBe(4);
    expect(api.undoStack!.canUndo).toBe(true);

    gridHost(root).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flushGridEvents();

    expect(api.editState!.dirtyCount).toBe(3);
    expect(api.gridApi!.getRowNode("1")!.data.name).toBe("beta");
  });
});
