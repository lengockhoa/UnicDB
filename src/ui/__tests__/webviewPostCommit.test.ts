// src/ui/__tests__/webviewPostCommit.test.ts
//
// TASK-006 (cycle U) — post-commit grid refresh after a successful saveEdits.
//
// Bundle-eval tests (webview side):
//   1. saveResult.ok=true  → webview posts `requery` (index/where/orderBy)
//   2. requery.where mirrors the requery bar's WHERE input
//   3. requery.orderBy mirrors the sort state held in the ORDER BY input
//      (TASK-003's getTableSortQuery composes server-side sorts through
//      this field — the bar IS the sort-state surface in this architecture)
//   4. dirty state cleared for saved rows BEFORE the requery fires
//   6. saveResult with rowErrors (partial failure) does NOT auto-requery
//
// Test case 5 (host side — previous batched cursor closed before the
// post-commit requery SQL runs) lives in resultsPanelRequery.test.ts:
// vi.mock("vscode") does not resolve under jsdom (same split as
// webviewRetry.test.ts → resultsPanelRetry.test.ts).
//
// Bundle tests load dist/webview.js into jsdom (built via `npm run compile`),
// stub acquireVsCodeApi + ResizeObserver + matchMedia, dispatch state
// messages, and interact through the `window.__vsdb` debug object.
// If dist/webview.js is missing, all tests are skipped.
// @vitest-environment jsdom
import type { ColumnSpec } from "../resultsGridModel";
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
  isCellDirty: (rowId: number, colIndex: number) => boolean;
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

/** Bundle handle per test. `dirtyCountAtRequery` records the webview's
 *  editState.dirtyCount AT THE MOMENT each `requery` message is posted —
 *  this is how test 4 proves the dirty clear happens BEFORE the requery
 *  fires (both run inside the same saveResult handler, so post-hoc
 *  inspection alone cannot establish ordering). */
interface BundleHandle {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
  dirtyCountAtRequery: number[];
}

function loadBundle(): BundleHandle {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }

  document.body.innerHTML = '<div id="vsdb-root" class="vsdb-webview"></div>';
  const root = document.getElementById("vsdb-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const dirtyCountAtRequery: number[] = [];
  const api: VsdbApi = {
    postMessage: (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.type === "requery") {
        dirtyCountAtRequery.push(
          ((window as unknown as { __vsdb?: { editState?: { dirtyCount: number } } })
            .__vsdb?.editState?.dirtyCount) ?? -1,
        );
      }
      received.push(m);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => VsdbApi }).acquireVsCodeApi =
    () => api;

  (0, eval)(bundleSrc);

  return { received, root, dirtyCountAtRequery };
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

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts post-commit requery (TASK-006)", () => {
  itIfBundle(
    "1. saveResult ok:true ⇒ posts exactly one requery { type:'requery', index, where, orderBy }; grid then re-renders with fresh server data",
    async () => {
      const { received, root } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "typed", "alpha");
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(1);

      received.length = 0;
      api.commit!();
      await flushGridEvents();
      expect(received.filter((m) => m.type === "saveEdits")).toHaveLength(1);

      // Host acks full success.
      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      const requeryMsgs = received.filter((m) => m.type === "requery");
      expect(requeryMsgs).toHaveLength(1);
      expect(requeryMsgs[0]).toEqual({
        type: "requery",
        index: 0,
        where: "",
        orderBy: "",
      });

      // Host answers the requery with fresh server rows (e.g. a computed
      // `now()` default that changed on commit). The grid must show them.
      dispatchMsg(
        stateWith(
          ["id", "name"],
          [
            [1, "typed"],
            [2, "beta"],
            [3, "gamma"],
          ],
        ),
      );
      await flushGridEvents();
      const grid = vsdbApi()!.gridApi!;
      expect(grid.getDisplayedRowAtIndex(0)!.data.name).toBe("typed");
      void root;
    },
  );

  itIfBundle(
    "2. post-commit requery carries the CURRENT WHERE from the requery bar",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const whereInput = document.querySelector(
        ".vsdb-requery-where",
      ) as HTMLInputElement | null;
      expect(whereInput).toBeTruthy();
      whereInput!.value = "id > 1";

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "typed", "alpha");
      await flushGridEvents();
      api.commit!();
      await flushGridEvents();

      received.length = 0;
      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      const requeryMsgs = received.filter((m) => m.type === "requery");
      expect(requeryMsgs).toHaveLength(1);
      expect((requeryMsgs[0] as { where: string }).where).toBe("id > 1");
    },
  );

  itIfBundle(
    "3. post-commit requery carries the CURRENT ORDER BY from the sort state",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      // The user sorted by name DESC — the ORDER BY input is the bar's
      // sort-state surface (server-side sort composition reads this field).
      const orderInput = document.querySelector(
        ".vsdb-requery-order",
      ) as HTMLInputElement | null;
      expect(orderInput).toBeTruthy();
      orderInput!.value = "name DESC";

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "typed", "alpha");
      await flushGridEvents();
      api.commit!();
      await flushGridEvents();

      received.length = 0;
      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      const requeryMsgs = received.filter((m) => m.type === "requery");
      expect(requeryMsgs).toHaveLength(1);
      expect((requeryMsgs[0] as { orderBy: string }).orderBy).toBe("name DESC");
    },
  );

  itIfBundle(
    "4. dirty state cleared for saved rows BEFORE the requery fires (isCellDirty false; ordering captured at post time)",
    async () => {
      const { received, dirtyCountAtRequery } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "typed", "alpha");
      api.simulateCellEdit!(1, "name", "typed2", "beta");
      await flushGridEvents();
      const editState = getEditState()!;
      expect(editState.dirtyCount).toBe(2);
      expect(editState.isCellDirty(0, 1)).toBe(true);
      expect(editState.isCellDirty(1, 1)).toBe(true);

      api.commit!();
      await flushGridEvents();

      dispatchMsg({ type: "saveResult", index: 0, ok: true });
      await flushGridEvents();

      // All saved rows are clean after the ack…
      expect(editState.isCellDirty(0, 1)).toBe(false);
      expect(editState.isCellDirty(1, 1)).toBe(false);
      expect(editState.dirtyCount).toBe(0);

      // …and the requery that went out already saw a clean editState —
      // the clear happens BEFORE the post, not after.
      expect(received.filter((m) => m.type === "requery")).toHaveLength(1);
      expect(dirtyCountAtRequery).toEqual([0]);
    },
  );

  itIfBundle(
    "6. Edge. saveResult ok:true WITH rowErrors (partial failure) ⇒ NO auto-requery; saved rows cleared, errored row kept dirty",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      const api = vsdbApi()!;
      api.simulateCellEdit!(0, "name", "saved", "alpha");
      api.simulateCellEdit!(1, "name", "failed", "beta");
      await flushGridEvents();

      api.commit!();
      await flushGridEvents();

      received.length = 0;
      dispatchMsg({
        type: "saveResult",
        index: 0,
        ok: true,
        rowErrors: [{ rowId: 1, error: "constraint violation" }],
      });
      await flushGridEvents();

      // No requery — the server data is unchanged for the failed batch,
      // and an auto-requery would wipe the errored row the user retries.
      expect(received.filter((m) => m.type === "requery")).toHaveLength(0);

      const editState = getEditState()!;
      expect(editState.dirtyCount).toBe(1);
      expect(editState.isCellDirty(0, 1)).toBe(false);
      expect(editState.isCellDirty(1, 1)).toBe(true);
    },
  );
});
