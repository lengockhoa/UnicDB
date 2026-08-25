// src/ui/__tests__/webviewBundle.test.ts
// TASK-203 — jsdom bundle test for webview/main.ts (AG Grid Community).
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches state
// messages to assert AG Grid DOM + behaviors required by TASK-203 §Test Cases.
//
// Mirrors the pattern from .cache/webview-repro/aggrid.html.
//
// IMPORTANT: This test MUST run after `npm run compile` so that dist/webview.js
// exists — see TASK-203 §Verification Commands. If missing, the test is
// skipped with an explanatory message.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
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
  checkLoadMore?: () => void;
}

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

// Each test gets a fresh document; we eval the bundle inside an isolated
// IIFE-captured acquireVsCodeApi stub.
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

  // The bundle is an IIFE — running it under jsdom installs globals + listeners.
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

function buildRows(count: number, cols: readonly string[]): unknown[][] {
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const r: unknown[] = [];
    for (let k = 0; k < cols.length; k++) {
      const c = cols[k];
      if (k === 0) r.push(i + 1);
      else if (k === 1) r.push(`name-${i}`);
      else r.push(`val-${c}-${i}`);
    }
    rows.push(r);
  }
  return rows;
}

function selectState(args: {
  results: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return { type: "state", header: "test.sql", busy: false, ...args };
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-203)", () => {
  itIfBundle("1. 3 statements render — grid AG visible with 200 rows on SELECT tab", () => {
    const { received, root } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t LIMIT 200",
            status: "done",
            result: {
              columns: ["id", "name", "category"],
              rows: buildRows(200, ["id", "name", "category"]),
              rowCount: 200,
              durationMs: 12,
            },
            durationMs: 12,
          },
          {
            index: 1,
            sql: "INSERT INTO t VALUES (1)",
            status: "done",
            result: {
              columns: [],
              rows: [],
              rowCount: 1,
              commandTag: "INSERT",
              durationMs: 5,
            },
            durationMs: 5,
          },
          {
            index: 2,
            sql: "SELECT * FROM bogus",
            status: "error",
            error: "relation 'bogus' does not exist",
            durationMs: 8,
          },
        ],
      }),
    );
    void received;

    const tabs = root.querySelectorAll(".vsdb-tab");
    expect(tabs.length).toBe(4);

    const gridHost = root.querySelector(".vsdb-grid-host");
    expect(gridHost).toBeTruthy();
    expect(gridHost!.querySelector('[class*="ag-root"]')).toBeTruthy();

    const api = getGridApi();
    expect(api).toBeTruthy();
    expect(api!.getDisplayedRowCount()).toBe(200);
  });

  itIfBundle("2. quick filter via search input filters to 1 row + footer updates", () => {
    const { received, root } = loadBundle();
    dispatchState(
      selectState({
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
      }),
    );
    void received;
    const input = root.querySelector(".vsdb-search-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const api = getGridApi();
    expect(api).toBeTruthy();
    expect(api!.getDisplayedRowCount()).toBe(1);
    const footer = root.querySelector(".vsdb-grid-footer") as HTMLElement;
    expect(footer).toBeTruthy();
    expect(footer.textContent).toMatch(/1 of 3/);
  });

  itIfBundle("3. selection + copy → postToHost {type:'copy'} with tab-separated text", () => {
    const { received, root } = loadBundle();
    dispatchState(
      selectState({
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
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();
    let rowIdx = 0;
    api!.forEachNode((node) => {
      if (rowIdx < 2 && node.data) node.setSelected(true, false, "api");
      rowIdx++;
    });
    expect(api!.getSelectedRows().length).toBe(2);

    const gridHost = root.querySelector(".vsdb-grid-host") as HTMLElement;
    expect(gridHost).toBeTruthy();
    const ev = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    gridHost.dispatchEvent(ev);

    const copyMsgs = received.filter((m) => m.type === "copy");
    expect(copyMsgs.length).toBeGreaterThan(0);
    const last = copyMsgs[copyMsgs.length - 1] as { text: string };
    expect(last.text.split("\n").length).toBe(2);
    expect(last.text).toMatch(/\t/);
  });

  itIfBundle("4. reset query (BUG 2 regression) — old rows gone, only new 50 displayed", () => {
    const { received } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t LIMIT 200",
            status: "done",
            result: {
              columns: ["id"],
              rows: Array.from({ length: 200 }, (_, i) => [i]),
              rowCount: 200,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    expect(getGridApi()!.getDisplayedRowCount()).toBe(200);

    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM other",
            status: "running",
            durationMs: 0,
          },
        ],
        busy: true,
      }),
    );

    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM other",
            status: "done",
            result: {
              columns: ["id"],
              rows: Array.from({ length: 50 }, (_, i) => [i + 1000]),
              rowCount: 50,
              durationMs: 6,
            },
            durationMs: 6,
          },
        ],
      }),
    );

    const api = getGridApi();
    expect(api).toBeTruthy();
    expect(api!.getDisplayedRowCount()).toBe(50);
    let stale = 0;
    api!.forEachNode((node) => {
      const data = node.data as { id: number };
      if (data.id < 1000) stale++;
    });
    expect(stale).toBe(0);
    void received;
  });

  itIfBundle("5. batched loadMore (BUG 1 regression) — applyTransaction append, no setRowData", () => {
    const { received } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM big",
            status: "done",
            result: {
              columns: ["id"],
              rows: Array.from({ length: 500 }, (_, i) => [i]),
              rowCount: null,
              durationMs: 1,
            },
            batched: true,
            durationMs: 1,
          },
        ],
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();
    expect(api!.getDisplayedRowCount()).toBe(500);

    const hook = (window as unknown as { __vsdb?: VsdbGlobals }).__vsdb?.checkLoadMore;
    if (typeof hook === "function") hook();
    const loadMoreCount = received.filter((m) => m.type === "loadMore").length;
    expect(loadMoreCount).toBe(1);
    const lm = received.find((m) => m.type === "loadMore") as { index: number };
    expect(lm.index).toBe(0);

    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM big",
            status: "done",
            result: {
              columns: ["id"],
              rows: Array.from({ length: 1000 }, (_, i) => [i]),
              rowCount: null,
              durationMs: 3,
            },
            batched: true,
            durationMs: 3,
          },
        ],
      }),
    );
    expect(api!.getDisplayedRowCount()).toBe(1000);
  });

  itIfBundle("6. non-SELECT ok-message — INSERT shows ✓ INSERT — 1 row affected", async () => {
    const { received, root } = loadBundle();
    // Force activeTab back to 0 by dispatching an interim state that
    // clamps it (activeTab >= results.length → clamp). Then dispatch the
    // real state — activeTab is now 0 and the click on tabs[1] actually
    // switches the panel.
    dispatchState(selectState({ results: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT 1",
            status: "done",
            result: {
              columns: ["x"],
              rows: [[1]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
          {
            index: 1,
            sql: "INSERT INTO t VALUES (1)",
            status: "done",
            result: {
              columns: [],
              rows: [],
              rowCount: 1,
              commandTag: "INSERT",
              durationMs: 5,
            },
            durationMs: 5,
          },
        ],
      }),
    );
    void received;
    const tabs = root.querySelectorAll(".vsdb-tab");
    (tabs[1] as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ok = root.querySelector(".vsdb-ok-message") as HTMLElement;
    expect(ok).toBeTruthy();
    expect(ok.textContent).toContain("✓ INSERT");
    expect(ok.textContent).toContain("1 row affected");
   });
  itIfBundle("7. error tab — .vsdb-error shows message", () => {
    const { received, root } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM bogus",
            status: "error",
            error: "table not found",
            durationMs: 1,
          },
        ],
      }),
    );
    void received;

    const err = root.querySelector(".vsdb-error") as HTMLElement;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("table not found");
  });

  itIfBundle("8. regression (CRITICAL 1) — after second render cycle, .vsdb-grid-host still contains .ag-root and rows reflect latest state", () => {
    // Reproduces the bug R4.5 reviewer flagged: render() wiped the DOM root
    // on every message, detaching the AG Grid GUI after the first render.
    // After a busy toggle + a state append, the live grid host must still
    // contain [class*=ag-root] and the displayed row count must reflect
    // the latest data — not 0 and not stale.
    const { root } = loadBundle();
    dispatchState(
      selectState({
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
      }),
    );
    const host1 = root.querySelector(".vsdb-grid-host") as HTMLElement;
    expect(host1).toBeTruthy();
    expect(host1.querySelector('[class*="ag-root"]')).toBeTruthy();
    expect(getGridApi()!.getDisplayedRowCount()).toBe(3);

    // Second render: busy toggle (fires on most query lifecycles).
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "busy", busy: true } }),
    );
    const host2 = root.querySelector(".vsdb-grid-host") as HTMLElement;
    expect(host2).toBeTruthy();
    expect(host2.querySelector('[class*="ag-root"]')).toBeTruthy();
    // Grid still mounted and still shows the same rows.
    expect(getGridApi()!.getDisplayedRowCount()).toBe(3);

    // Third render: state with more rows (append delta path).
    dispatchState(
      selectState({
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
              ],
              rowCount: 4,
              durationMs: 2,
            },
            durationMs: 2,
          },
        ],
      }),
    );
    const host3 = root.querySelector(".vsdb-grid-host") as HTMLElement;
    expect(host3).toBeTruthy();
    expect(host3.querySelector('[class*="ag-root"]')).toBeTruthy();
    expect(getGridApi()!.getDisplayedRowCount()).toBe(4);

    // Fourth render: busy off (another common toggle).
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "busy", busy: false } }),
    );
    const host4 = root.querySelector(".vsdb-grid-host") as HTMLElement;
    expect(host4).toBeTruthy();
    expect(host4.querySelector('[class*="ag-root"]')).toBeTruthy();
    expect(getGridApi()!.getDisplayedRowCount()).toBe(4);
  });

  // TASK-001 — INVERTED contract from TASK-006. The browse path no longer
  // wraps the SELECT to append `ctid`, so the column can only reach the
  // grid when it is a real user column. inferColumns no longer auto-tags
  // `ctid` as hidden — the column is rendered as an ordinary string column
  // and the user sees it like any other data column. This test locks the
  // end-to-end render path (the unit lock on inferColumns lives in
  // resultsGridModel.test.ts).
  itIfBundle("9. TASK-001 — ctid column is visible (an ordinary user column, no host wrap)", () => {
    const { root } = loadBundle();
    // Plain fixture SQL — no host wrap. ctid is a real user
    // column on `notes`.
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: 'SELECT * FROM "public"."notes"',
            status: "done",
            result: {
              columns: ["name", "created_at", "ctid"],
              rows: [
                ["alice", "2024-01-01T00:00:00.000Z", "(0,1)"],
                ["bob", "2024-02-02T00:00:00.000Z", "(0,2)"],
              ],
              rowCount: 2,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      }),
    );
    const api = getGridApi();
    expect(api).toBeTruthy();
    // The ctid column is registered (it exists in the schema) and is NOT
    // marked hidden. Both `getColumnDefs()` and `getColumnState()` should
    // report `hide` falsy.
    const colDefs = api!.getColumnDefs() ?? [];
    const ctidDef = colDefs.find(
      (c: { colId?: string; field?: string }) =>
        c.colId === "ctid" || c.field === "ctid",
    );
    expect(ctidDef).toBeDefined();
    expect((ctidDef as { hide?: boolean } | undefined)?.hide).not.toBe(true);
    const ctidState = api!
      .getColumnState()
      .find((s: { colId: string }) => s.colId === "ctid");
    expect(ctidState).toBeDefined();
    expect((ctidState as { hide?: boolean } | undefined)?.hide).not.toBe(true);
    // AG Grid also auto-creates a selection column for rowSelection; filter
    // it out so the assertion is about user-visible data columns only.
    const visibleCols = api!
      .getAllDisplayedColumns()
      .map((c: { getColId(): string }) => c.getColId())
      .filter((id: string) => id !== "ag-Grid-SelectionColumn")
      .sort();
    expect(visibleCols).toEqual(["created_at", "ctid", "name"]);
    // Reference `root` so the assertion above is not the only observable —
    // the test harness teardown uses root.
    void root;
  });
});
