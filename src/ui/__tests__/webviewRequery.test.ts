// src/ui/__tests__/webviewRequery.test.ts
// TASK-504 — bundle-eval integration test for the WHERE/ORDER BY "Re-Run"
// bar in the persistent grid toolbar.
//
// Loads dist/webview.js into jsdom, stubs acquireVsCodeApi + ResizeObserver
// + matchMedia, then dispatches a state message and asserts:
//   1. The requery bar (WHERE / ORDER BY inputs + Re-Run + Clear buttons)
//      renders once the grid is active.
//   2. Clicking "Re-Run" with WHERE / ORDER BY text posts a `requery`
//      message with the right shape.
//   3. "Clear" empties both inputs.
//
// Fix Round 2 critical #1: requery must post `status:"running"` for the
// statement before runSql so the webview's `statementReset` branch fires
// and the grid FULLY RE-RENDERS (not append-delta). Without this:
//   - Equal-row-count requery (ORDER BY change) leaves the grid STALE
//     because renderGrid's append-delta branch never fires AND no reset
//     branch fires — the existing rowData set is unchanged.
//   - Row-growing requery takes the append-delta branch and KEEPS the
//     OLD prefix (e.g. [1,2] + [12,13] rendered as [1,2,12,13]).
//
// Mirrors the bundle pattern from webviewExport.test.ts. Skipped when
// dist/webview.js is missing — `npm run compile` must run first.
// @vitest-environment jsdom
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
    ResizeObserver?: unknown;
    matchMedia?: unknown;
  };
  if (typeof g.ResizeObserver === "undefined") {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserverLike;
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

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBBundle {
  render: () => void;
  postToHost: (msg: unknown) => void;
}

interface UnicDBGlobal {
  __UnicDB?: UnicDBBundle;
  acquireVsCodeApi?: () => UnicDBApi;
}

interface GridNodeLike {
  data: Record<string, unknown>;
}

interface GridApiLike {
  forEachNode(cb: (node: GridNodeLike) => void): void;
  getDisplayedRowCount(): number;
}

interface GridHostWithApi extends HTMLElement {
  __UnicDBApi?: GridApiLike;
}

function readGridApi(host: HTMLElement | null): GridApiLike | null {
  if (!host) return null;
  return (host as GridHostWithApi).__UnicDBApi ?? null;
}

function loadBundle(): {
  received: Array<Record<string, unknown>>;
  root: HTMLDivElement;
  UnicDB: UnicDBBundle;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }
  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as UnicDBGlobal).acquireVsCodeApi = () => api;

  (0, eval)(bundleSrc);
  const UnicDB = (window as unknown as UnicDBGlobal).__UnicDB;
  if (!UnicDB) {
    throw new Error("bundle did not expose __UnicDB");
  }
  return { received, root, UnicDB };
}

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function selectState(
  overrides: {
    rows?: unknown[][];
    rowCount?: number | null;
    batched?: boolean;
  } = {},
): Record<string, unknown> {
  const r = overrides.rows ?? [
    [1, "alpha"],
    [2, "beta"],
  ];
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
          rows: r,
          rowCount: overrides.rowCount ?? r.length,
          durationMs: 1,
        },
        batched: overrides.batched,
        durationMs: 1,
      },
    ],
  };
}

function stateWithStatus(opts: {
  status: "running" | "done";
  rows: unknown[][];
  rowCount: number;
}): Record<string, unknown> {
  return {
    type: "state",
    header: "test.sql",
    busy: opts.status === "running",
    results: [
      {
        index: 0,
        sql: "SELECT * FROM t",
        status: opts.status,
        result: {
          columns: ["id", "name"],
          rows: opts.rows,
          rowCount: opts.rowCount,
          durationMs: 1,
        },
        durationMs: 1,
      },
    ],
  };
}

function collectIds(api: GridApiLike | null): number[] {
  if (!api) return [];
  const collected: Array<Record<string, unknown>> = [];
  api.forEachNode((node) => {
    collected.push(node.data);
  });
  return collected.map((row) => row.id as number);
}

function queryGridApiHost(): HTMLElement | null {
  // `gridHost` is the AG Grid host element (.UnicDB-ag-host class). The
  // persistent wrap carries the .UnicDB-grid-host class — different DOM.
  return document.querySelector(".UnicDB-ag-host") as HTMLElement | null;
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts WHERE/ORDER BY requery bar (TASK-504)", () => {
  itIfBundle("1. requery bar renders WHEN the grid is active (WHERE / ORDER BY inputs + Re-Run + Clear)", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    const runBtn = root.querySelector(
      ".UnicDB-requery-run",
    ) as HTMLButtonElement | null;
    const clearBtn = root.querySelector(
      ".UnicDB-requery-clear",
    ) as HTMLButtonElement | null;

    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();
    expect(runBtn).toBeTruthy();
    expect(clearBtn).toBeTruthy();
    expect(whereInput!.tagName).toBe("INPUT");
    expect(orderInput!.tagName).toBe("INPUT");
  });

  itIfBundle("2. Click Re-Run → posts { type:'requery', index, where, orderBy }", () => {
    const { received } = loadBundle();
    dispatchState(selectState());

    const whereInput = document.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = document.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    const runBtn = document.querySelector(
      ".UnicDB-requery-run",
    ) as HTMLButtonElement | null;

    whereInput!.value = "id > 1";
    orderInput!.value = "id DESC";
    runBtn!.click();

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "id > 1",
      orderBy: "id DESC",
    });
  });

  itIfBundle("3. Empty WHERE / ORDER BY → requery message carries empty strings", () => {
    const { received } = loadBundle();
    dispatchState(selectState());

    const runBtn = document.querySelector(
      ".UnicDB-requery-run",
    ) as HTMLButtonElement | null;
    runBtn!.click();

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
    });
  });

  itIfBundle("4. Clear button empties both inputs", () => {
    loadBundle();
    dispatchState(selectState());

    const whereInput = document.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = document.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    const clearBtn = document.querySelector(
      ".UnicDB-requery-clear",
    ) as HTMLButtonElement | null;

    whereInput!.value = "x = 1";
    orderInput!.value = "y DESC";
    clearBtn!.click();
    expect(whereInput!.value).toBe("");
    expect(orderInput!.value).toBe("");
  });

  // TASK-005 — layout: requery bar must sit ABOVE the AG Grid host (still
  // inside gridWrap). Inside-document order: requery bar < grid host.
  itIfBundle("5. DOM order inside gridWrap: requery bar < grid host", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const gridWrap = root.querySelector(".UnicDB-grid-host") as HTMLElement | null;
    expect(gridWrap).toBeTruthy();

    const requeryBar = gridWrap!.querySelector(
      "[data-UnicDB-requery-bar]",
    ) as HTMLElement | null;
    const gridHost = gridWrap!.querySelector(".UnicDB-ag-host") as HTMLElement | null;
    expect(requeryBar).toBeTruthy();
    expect(gridHost).toBeTruthy();

    const children = Array.from(gridWrap!.children) as HTMLElement[];
    const idxRequery = children.indexOf(requeryBar!);
    const idxHost = children.indexOf(gridHost!);
    expect(idxRequery).toBeGreaterThanOrEqual(0);
    expect(idxHost).toBeGreaterThanOrEqual(0);
    expect(idxRequery).toBeLessThan(idxHost);
  });

  // TASK-005 — layout: in document order, the requery bar must appear AFTER
  // the toolbar + tabs (which are root-level siblings of gridWrap) and
  // BEFORE the grid host (its first meaningful child).
  itIfBundle("6. Document order: toolbar < requery bar < grid host", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLElement | null;
    const requeryBar = root.querySelector(
      "[data-UnicDB-requery-bar]",
    ) as HTMLElement | null;
    const gridHost = root.querySelector(".UnicDB-ag-host") as HTMLElement | null;
    expect(toolbar).toBeTruthy();
    expect(requeryBar).toBeTruthy();
    expect(gridHost).toBeTruthy();

    // document.body is the parent of root; walk siblings via compareDocumentPosition
    const cmp = (a: Element, b: Element): number => {
      const rel = a.compareDocumentPosition(b);
      // 4 = DOCUMENT_POSITION_FOLLOWING
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    expect(cmp(toolbar!, requeryBar!)).toBe(-1);
    expect(cmp(requeryBar!, gridHost!)).toBe(-1);
  });

  // TASK-005 — edge (empty state): when no statement has been rendered the
  // gridWrap stays hidden / detached, so the requery bar (a child of
  // gridWrap) must not be visible to the user — it must not float outside
  // gridWrap into the empty-state panel. After moving the bar above the
  // grid host, it is still a child of gridWrap, so the empty-state hide
  // rule keeps it hidden.
  itIfBundle("7. Empty state: requery bar not visible (no active statement)", () => {
    const { root } = loadBundle();
    // Bundle is loaded (initial render runs) but we never dispatchState.
    // The active tab is empty → panel shows the empty placeholder, and
    // gridWrap is either detached or display:none.
    const panel = root.querySelector(".UnicDB-panel") as HTMLElement | null;
    const requeryBar = root.querySelector(
      "[data-UnicDB-requery-bar]",
    ) as HTMLElement | null;
    expect(panel).toBeTruthy();
    // No requery bar reachable through root → bar stays inside gridWrap
    // which is NOT in the live DOM during empty state.
    expect(requeryBar).toBeNull();
  });
  // TASK-005 — regression: footer placement unchanged — gridFooter sits
  // BELOW the grid host (still inside gridWrap), and the saveBanner
  // ordering relative to gridFooter is preserved (today: saveBanner is
  // appended after gridFooter — keep that).
  itIfBundle("8. gridFooter is positioned after gridHost in gridWrap", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const gridWrap = root.querySelector(".UnicDB-grid-host") as HTMLElement | null;
    expect(gridWrap).toBeTruthy();

    const gridHost = gridWrap!.querySelector(".UnicDB-ag-host") as HTMLElement | null;
    const gridFooter = gridWrap!.querySelector(
      ".UnicDB-grid-footer",
    ) as HTMLElement | null;
    expect(gridHost).toBeTruthy();
    expect(gridFooter).toBeTruthy();

    const children = Array.from(gridWrap!.children) as HTMLElement[];
    const idxHost = children.indexOf(gridHost!);
    const idxFooter = children.indexOf(gridFooter!);
    expect(idxHost).toBeGreaterThanOrEqual(0);
    expect(idxFooter).toBeGreaterThanOrEqual(0);
    // Footer must come AFTER the grid host (visually below it).
    expect(idxFooter).toBeGreaterThan(idxHost);
    // Footer must remain the LAST meaningful (non-banner) child of gridWrap
    // — i.e. no requery bar inserted between gridHost and gridFooter.
    expect(idxFooter).toBe(idxHost + 1);
  });
});

// Fix Round 2 — Critical #1: requery must reset the grid
// =============================================================================
//
// The host posts running → done for the requery statement. The webview's
// renderGrid uses `lastResultStatus === "running" && r.status !== "running"`
// to detect a same-statement RESET (vs append-delta). If the host only
// posts done, the grid takes the append-delta / idempotent no-op branch
// and the user sees the stale data.
//
// We simulate this by dispatching a state sequence:
//   1. Initial state (done, rows [1,2,3])
//   2. running state for the SAME statement (with original rows)
//   3. done state with NEW rows [3,2,1] (ORDER BY change, equal count)
//
// Then we read the AG Grid rowData and assert it reflects [3,2,1].
// Without the fix the grid still shows [1,2,3].
describeIfBundle("webview grid reset on requery (Fix R2 critical #1)", () => {
  itIfBundle(
    "ORDER BY change with equal row count RE-RENDERS new order (not stale append)",
    () => {
      const { UnicDB } = loadBundle();
      dispatchState(
        selectState({ rows: [[1, "a"], [2, "b"], [3, "c"]], rowCount: 3 }),
      );
      const initialHost = queryGridApiHost();
      expect(initialHost).toBeTruthy();
      expect(readGridApi(initialHost)).toBeTruthy();

      // Simulate host posting running → done with reordered rows.
      // The panel's handleRequery posts running BEFORE runSql; that
      // running state carries the EXISTING row data so the grid can
      // show the spinner / busy state. Without that running post, the
      // append-delta branch fires.
      dispatchState(
        stateWithStatus({
          status: "running",
          rows: [
            [1, "a"],
            [2, "b"],
            [3, "c"],
          ],
          rowCount: 3,
        }),
      );
      UnicDB.render();
      dispatchState(
        stateWithStatus({
          status: "done",
          rows: [
            [3, "c"],
            [2, "b"],
            [1, "a"],
          ],
          rowCount: 3,
        }),
      );

      const gridHost = queryGridApiHost();
      expect(gridHost).toBeTruthy();
      const ids = collectIds(readGridApi(gridHost));
      // After the fix, the grid shows the NEW order [3,2,1].
      // Before the fix, the grid shows the OLD order [1,2,3].
      expect(ids).toEqual([3, 2, 1]);
    },
  );

  itIfBundle(
    "Row-growing requery RE-RENDERS fresh rows (no append-mix [1,2,12,13])",
    () => {
      const { UnicDB } = loadBundle();
      // Initial state: 2 rows.
      dispatchState(
        selectState({ rows: [[1, "a"], [2, "b"]], rowCount: 2 }),
      );

      const initialHost = queryGridApiHost();
      expect(initialHost).toBeTruthy();
      expect(readGridApi(initialHost)).toBeTruthy();

      // Simulate host posting running for SAME statement before requery.
      dispatchState(
        stateWithStatus({
          status: "running",
          rows: [
            [1, "a"],
            [2, "b"],
          ],
          rowCount: 2,
        }),
      );
      UnicDB.render();

      // Requery result: WHERE removed → 4 rows.
      dispatchState(
        stateWithStatus({
          status: "done",
          rows: [
            [10, "x"],
            [11, "y"],
            [12, "z"],
            [13, "w"],
          ],
          rowCount: 4,
        }),
      );
      const gridHost = queryGridApiHost();
      expect(gridHost).toBeTruthy();
      const ids = collectIds(readGridApi(gridHost));
      // After the fix: fresh rows [10,11,12,13].
      // Before the fix: append-mix [1,2,12,13] (stale prefix).
      expect(ids).toEqual([10, 11, 12, 13]);
    },
  );
});