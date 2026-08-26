// src/ui/__tests__/resultsGridModelNull.test.ts
// TASK-004 — NULL cell display + cell value viewer.
//
// jsdom bundle test for webview/main.ts (AG Grid Community v36), following
// the webviewBundle.test.ts pattern: loads dist/webview.js (built via
// `npm run compile`), dispatches state messages, then asserts the DOM +
// behaviors required by TASK-004 §Test Cases:
//
//   1. null value renders "(NULL)" in an italic `.vsdb-null` span
//   2. non-null value renders normally (no `.vsdb-null`)
//   3. undefined renders "(NULL)" the same as null
//   4. the valueFormatter only changes display — underlying data stays null
//   5. double-click on a null cell still enters edit mode
//   6. double-click on a read-only cell opens the value viewer overlay with
//      the FULL raw value (500-char string)
//
// plus a styles.css contract check for `.vsdb-null` / `.vsdb-value-viewer`
// (jsdom does not apply external stylesheets, so the rules are asserted
// against the source CSS text directly).
//
// This test MUST run after `npm run compile` so dist/webview.js exists.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
// TASK-003: ONE bundle evaluation per suite (beforeAll), not once per `it`.
// The anonymous `window.addEventListener("message", ...)` the bundle installs
// can never be removed by the test; the OLD per-test loadBundle() therefore
// installed one listener per `it`, and every subsequent dispatch ran ALL of
// them — the 6th test raced 5 stale handler closures that each called
// render() → renderGrid() on THEIR OWN grid state, so the value-viewer
// assertion became order/timing dependent (passed isolated, flaked under the
// full suite). Evaluating once and REUSING the single grid lifecycle via the
// existing message protocol removes the stale-handler race at the root.

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbGlobals {
  gridApi?: GridApi;
}
interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

/** Evaluate the bundle exactly once per suite into the shared document. The
 *  returned handles are re-used by every case; per-case state is reset
 *  through the existing message protocol, not by re-evaluating. */
function evaluateBundleOnce(): {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
} {
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

  const root = document.getElementById("vsdb-root") as HTMLDivElement;
  return { received, root };
}

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Reset the single shared grid lifecycle to a known-empty terminal state
 *  through the SAME message path the host uses (no production test hook):
 *  dispatch a running state, then the terminal state for the empty result,
 *  then flush AG Grid's animation queue. Re-created cells (like the cells
 *  re-created after a columnDefs swap in the read-only viewer case) may not
 *  be fully mounted synchronously, so this also yields to the grid's async
 *  row/gui queue via a bounded wait. */
async function resetGrid(
  root: HTMLDivElement,
  received: Array<Record<string, unknown>>,
): Promise<void> {
  // Clear the prior case through existing APIs/interactions before sending a
  // fresh host state. This stops an editor and exercises the real Escape close
  // path rather than reaching into production-only state.
  getGridApi()?.stopEditing(true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  received.length = 0;
  // Leave the grid tab first. This is the existing UI lifecycle boundary that
  // removes all old cell GUIs while retaining the persistent grid host.
  dispatchState(selectState({ results: [] }));
  const currentApi = getGridApi();
  currentApi?.stopEditing(true);
  currentApi?.setGridOption("rowData", []);
  currentApi?.flushAllAnimationFrames();
  await waitForGrid(() => {
    expect(root.querySelector(".vsdb-empty")).toBeTruthy();
    expect(root.querySelectorAll(".ag-cell")).toHaveLength(0);
    if (getGridApi()) expect(getGridApi()!.getEditingCells()).toHaveLength(0);
  });

  const resetResult = {
    index: 0,
    sql: "SELECT reset",
    result: {
      columns: ["reset"],
      rows: [[0]],
      rowCount: 1,
      durationMs: 0,
    },
    durationMs: 0,
  };
  // Running → terminal is the existing render lifecycle's statement-reset
  // transition. It swaps rowData without re-evaluating the bundle and is an
  // observable boundary for discarding the prior case's cells.
  dispatchState(
    selectState({ results: [{ ...resetResult, status: "running" }] }),
  );
  dispatchState(selectState({ results: [{ ...resetResult, status: "done" }] }));
  const api = getGridApi();
  if (api) api.flushAllAnimationFrames();
  // The reset column/cell is the observable boundary for the shared grid
  // lifecycle. It also proves that any previous editor has been stopped.
  await waitForGrid(() => {
    expect(root.querySelector(".vsdb-value-viewer")).toBeNull();
    expect(getGridApi()).toBeTruthy();
    expect(root.querySelector('.ag-cell[col-id="reset"]')).toBeTruthy();
    expect(getGridApi()!.getEditingCells()).toHaveLength(0);
  });
}

/** Bounded observable wait (no fixed 50 ms sleeps): polls the assertion every
 *  animation frame until it passes or the budget is exhausted. */
async function waitForGrid(
  assert: () => void,
  timeoutMs = 250,
): Promise<void> {
  await vi.waitFor(assert, {
    timeout: timeoutMs,
    interval: 16,
  });
}

function selectState(args: {
  results: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return { type: "state", header: "test.sql", busy: false, ...args };
}

function getGridApi(): GridApi | null {
  const w = window as unknown as { __vsdb?: VsdbGlobals };
  return w.__vsdb?.gridApi ?? null;
}

/** Dispatch a real-user-style double-click on a cell: mousedown to focus,
 *  then dblclick (detail: 2, bubbles) so AG Grid's own dblclick pipeline
 *  (cellDoubleClicked event + double-click-to-edit) runs exactly as it does
 *  in the VS Code webview. */
function doubleClickCell(root: HTMLElement, colId: string): void {
  const cell = root.querySelector(
    `.ag-cell[col-id="${colId}"]`,
  ) as HTMLElement | null;
  expect(cell).toBeTruthy();
  cell!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
  cell!.dispatchEvent(
    new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
  );
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

// ---- tests ----------------------------------------------------------------

describeIfBundle("TASK-004 — NULL cell display + value viewer", () => {
  let received: Array<Record<string, unknown>>;
  let root: HTMLDivElement;

  beforeAll(() => {
    ({ received, root } = evaluateBundleOnce());
  });

  beforeEach(async () => {
    await resetGrid(root, received);
  });

  itIfBundle("1. null value renders \"(NULL)\" in an italic .vsdb-null span", async () => {
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["id", "name"],
              rows: [
                [1, null],
                [2, "bob"],
              ],
              rowCount: 2,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    getGridApi()?.flushAllAnimationFrames();
    await waitForGrid(() =>
      expect(root.querySelectorAll(".vsdb-null").length).toBe(1),
    );

    // Exactly the null cell carries the placeholder span.
    const nullSpans = root.querySelectorAll(".vsdb-null");
    expect(nullSpans.length).toBe(1);
    expect(nullSpans[0].getAttribute("class")).toContain("vsdb-null");
    expect(nullSpans[0].textContent).toBe("(NULL)");
    // The span lives INSIDE the null cell (col-id="name"), not the id cell.
    const nameCell = root.querySelector(
      ".ag-cell[col-id=\"name\"]",
    ) as HTMLElement | null;
    expect(nameCell).toBeTruthy();
    expect(nameCell!.querySelector(".vsdb-null")).toBeTruthy();
    expect(nameCell!.textContent).toContain("(NULL)");
  });

  itIfBundle("2. non-null value renders normally (no .vsdb-null)", async () => {
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["id", "name"],
              rows: [[1, "hello"]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    getGridApi()?.flushAllAnimationFrames();
    await waitForGrid(() =>
      expect(root.querySelectorAll(".vsdb-null").length).toBe(0),
    );

    expect(root.querySelectorAll(".vsdb-null").length).toBe(0);
    const nameCell = root.querySelector(
      ".ag-cell[col-id=\"name\"]",
    ) as HTMLElement | null;
    expect(nameCell).toBeTruthy();
    expect(nameCell!.textContent).toContain("hello");
  });

  itIfBundle("3. undefined value renders \"(NULL)\" same as null", async () => {
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["x"],
              rows: [[undefined]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    getGridApi()?.flushAllAnimationFrames();
    await waitForGrid(() =>
      expect(root.querySelectorAll(".vsdb-null").length).toBe(1),
    );

    const nullSpans = root.querySelectorAll(".vsdb-null");
    expect(nullSpans.length).toBe(1);
    expect(nullSpans[0].textContent).toBe("(NULL)");
  });

  itIfBundle("4. valueFormatter preserves underlying data — getValue() still null", () => {
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["id", "name"],
              rows: [[1, null]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();

    const node = api!.getDisplayedRowAtIndex(0);
    expect(node).toBeTruthy();
    // The row data itself still carries a real null.
    expect((node!.data as Record<string, unknown>).name).toBe(null);
    // AG Grid's own getValue path (what editors + copy read) sees null too.
    const col = api!.getColumn("name");
    expect(col).toBeTruthy();
    const colLike = col as unknown as {
      getValue?: (n: unknown) => unknown;
    };
    if (typeof colLike.getValue === "function") {
      expect(colLike.getValue(node)).toBe(null);
    }
  });

  itIfBundle("5. double-click on null cell enters edit mode (no overlay)", async () => {
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["id", "name"],
              rows: [[1, null]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();

    doubleClickCell(root, "name");
    getGridApi()?.flushAllAnimationFrames();
    await waitForGrid(() =>
      expect(api!.getEditingCells().length).toBeGreaterThan(0),
    );

    // AG Grid's default double-click-to-edit still activates the editor.
    expect(api!.getEditingCells().length).toBeGreaterThan(0);
    // The value viewer must NOT open for an editable cell.
    expect(root.querySelector(".vsdb-value-viewer")).toBeNull();

    api!.stopEditing();
  });

  itIfBundle("6. value viewer overlay shows full content for long strings (read-only cell)", async () => {
    const longValue = "x".repeat(500);
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["id", "s"],
              rows: [[1, longValue]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();

    // Make the column read-only (the viewer's trigger condition): AG Grid
    // then never opens an editor for it, so double-click is free to open the
    // value viewer overlay instead. Tick first so the defs swap is fully
    // applied (and the cells re-created) before the double-click lands —
    // under full-suite load the flush is not synchronous.
    const defs = (api!.getColumnDefs() ?? []) as Array<Record<string, unknown>>;
    api!.setGridOption(
      "columnDefs",
      defs.map((d) => (d.field === "s" ? { ...d, editable: false } : d)),
    );
    api!.flushAllAnimationFrames();
    await waitForGrid(() => {
      const cell = root.querySelector('.ag-cell[col-id="s"]');
      expect(cell).toBeTruthy();
      expect(api!.getEditingCells()).toHaveLength(0);
      expect((api!.getColumn("s")?.getColDef() as { editable?: boolean }).editable).toBe(
        false,
      );
    });

    doubleClickCell(root, "s");
    api!.flushAllAnimationFrames();
    await waitForGrid(() =>
      expect(root.querySelector(".vsdb-value-viewer")).toBeTruthy(),
    );

    const overlay = root.querySelector(
      ".vsdb-value-viewer",
    ) as HTMLElement | null;
    expect(overlay).toBeTruthy();
    // Full raw content, plain text, nothing truncated.
    expect(overlay!.textContent).toBe(longValue);
    expect(overlay!.textContent!.length).toBe(500);

    // The viewer's real Escape interaction is also the cleanup boundary for
    // the next case; no overlay is allowed to leak across the shared bundle
    // lifecycle.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitForGrid(() =>
      expect(root.querySelector(".vsdb-value-viewer")).toBeNull(),
    );
  });
});

// ---- styles.css contract ---------------------------------------------------
// jsdom does not apply external stylesheets, so the TASK-004 acceptance
// criteria for the CSS classes are asserted against the source CSS text.
describe("TASK-004 — styles.css contract (.vsdb-null / .vsdb-value-viewer)", () => {
  const cssPath = resolve(process.cwd(), "webview", "styles.css");
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";

  it(".vsdb-null is styled italic + muted", () => {
    const m = css.match(/\.vsdb-null\s*\{[^}]*\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/font-style:\s*italic/);
    expect(m![0]).toMatch(/color\s*:/);
  });

  it(".vsdb-value-viewer overlay has padding, border, monospace font", () => {
    const m = css.match(/\.vsdb-value-viewer\s*\{[^}]*\}/);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/padding\s*:/);
    expect(m![0]).toMatch(/border\s*:/);
    expect(m![0]).toMatch(/monospace/);
  });
});
