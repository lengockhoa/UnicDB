// src/ui/__tests__/webviewServerSort.test.ts
// TASK-003 — header-click sort posts a server-side requery.
//
// Cases 1-6, 15, 16 of the TASK-003 test matrix (plus the TASK-007 fix-round
// regressions and the case-18 debounce regressions). Loads dist/webview.js
// (built via `npm run compile`) into jsdom, drives AG Grid column state
// (applyColumnState — the same path a header click takes) and asserts the
// posted `requery` messages, including the colId quoting rule (bare
// identifiers pass through; anything else is quoted per the driver parsed
// from the state header, postgres double-quote on fallback).
//
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
//
// TASK-008 stabilization: ONE bundle evaluation per suite. The anonymous
// `window.addEventListener("message", ...)` installed by the bundle
// (webview/main.ts) can never be removed by the test, so the old
// loadBundle-per-`it` pattern accumulated one MORE listener per case; every
// dispatch then ran ALL generations' handlers, and a stale generation's
// 150ms filter-debounce closure could post out of nowhere behind the current
// case's requery (the flaky case-18 "N != 1 posts" failure under parallel
// full-suite runs). Evaluating once removes the listener pile-up at the
// root; per-case isolation comes from mounting statements through the
// production render lifecycle and waiting observably for the message stream
// to go quiet — no reloads, no arbitrary sleeps, no production hooks.
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
// Evaluated EXACTLY ONCE per suite. Per-case isolation flows through the
// existing message protocol (dispatchState → render lifecycle) below.

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbGlobals {
  gridApi?: GridApi;
}
interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

/** Evaluate the bundle exactly once per suite into the shared document. */
function evaluateBundleOnce(): {
  received: Array<Record<string, unknown>>;
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

  return { received };
}

// Single shared collector for the whole suite; bound in the describe's
// beforeAll. Its CONTENT is emptied at every isolation boundary so each case
// observes only what it caused.
let received!: Array<Record<string, unknown>>;

function dispatchState(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function getGridApi(): GridApi | null {
  const w = window as unknown as { __vsdb?: VsdbGlobals };
  return w.__vsdb?.gridApi ?? null;
}

// ---- timing model (TASK-008) ------------------------------------------------

/** The webview's filter-requery debounce period (webview/main.ts
 *  FILTER_REQUERY_DEBOUNCE_MS). Mirrored here so every wait derives from the
 *  real timeout instead of an arbitrary sleep. */
const FILTER_REQUERY_DEBOUNCE_MS = 150;
/** A pending debounce timer is invisible in grid state — the only observable
 *  completion signal is the POST ITSELF landing. The stream therefore counts
 *  as settled only after staying unchanged for one full debounce window plus
 *  scheduler slack. */
const QUIET_SLACK_MS = 50;
/** Message stream must stay unchanged this long to count as settled
 *  (strictly longer than the debounce window itself). */
const SETTLE_QUIET_MS = FILTER_REQUERY_DEBOUNCE_MS + QUIET_SLACK_MS;
/** Hard cap for any single settle wait; tripping it fails loudly with the
 *  stream tail attached instead of guessing. */
const SETTLE_TIMEOUT_MS = FILTER_REQUERY_DEBOUNCE_MS * 10;

function requeries(list: Array<Record<string, unknown>>) {
  return list.filter((m) => m.type === "requery");
}

/**
 * Observable, bounded wait for the shared message stream to go QUIET:
 * resolves once no NEW posted message arrived for one full debounce window,
 * throws loudly otherwise. Replaces every fixed setTimeout sleep the old
 * version used around the 150ms debounce.
 */
async function waitForSettledStream(context: string): Promise<void> {
  let observed = -1;
  let lastChangeAt: number | null = null;
  try {
    await vi.waitFor(
      () => {
        if (received.length !== observed) {
          observed = received.length;
          lastChangeAt = Date.now();
        }
        expect(lastChangeAt).not.toBeNull();
        expect(Date.now() - (lastChangeAt as number)).toBeGreaterThanOrEqual(
          SETTLE_QUIET_MS,
        );
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: 16 },
    );
  } catch (err) {
    throw new Error(
      `${context}: message stream never settled within ` +
        `${SETTLE_TIMEOUT_MS}ms (observed ${observed} msgs, tail: ` +
        `${JSON.stringify(received.slice(-4))})`,
      { cause: err },
    );
  }
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Header string shape the host builds: `Run at <ISO> — <driver>@<host>/<db>`. */
function driverHeader(driver: string): string {
  return `Run at 2026-08-26T00:00:00.000Z — ${driver}@localhost/db`;
}

/** Statement shape the host sends for results grids (subset the webview
 *  consumes; shared by every case through the single dispatch path). */
function rowsState(
  header: string,
  columns: string[],
  rows: Array<Array<unknown>>,
): Record<string, unknown> {
  return {
    type: "state",
    header,
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

/**
 * Mount one statement into the SINGLE shared grid lifecycle with the exact
 * precondition the old per-case loadBundle() created: a grid whose column
 * defs were built fresh for THIS statement's columns, no filters, no sorts,
 * and an empty collector.
 *
 * How, purely through production behavior: the webview rebuilds columnDefs +
 * clears the filter model whenever the incoming column COUNT changes
 * (webview/main.ts columnsChanged branch). Park first on a 1-column
 * statement, then mount the real one — so the real mount ALWAYS lands as a
 * full defs reset regardless of which case ran before it (seed-order safe),
 * and the filter-clearing side effect's debounced api-source post is
 * absorbed by the settle wait instead of leaking into assertions.
 */
async function mountStatement(
  context: string,
  header: string,
  columns: string[],
  rows: Array<Array<unknown>>,
): Promise<GridApi> {
  dispatchState(
    rowsState("Run at 2026-08-26T00:00:00.000Z — postgres@localhost/db", [
      "park",
    ], [[0]]),
  );
  await flushGridEvents();

  dispatchState(rowsState(header, columns, rows));
  await flushGridEvents();
  await waitForSettledStream(`${context} mount`);

  const api = getGridApi();
  expect(api).toBeTruthy();
  received.length = 0;
  return api!;
}

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle — TASK-003 server-side sort", () => {
  beforeAll(() => {
    ({ received } = evaluateBundleOnce());
  });

  /** TASK-008 per-case reset through existing behavior only: stop a
   *  surviving cell editor, wait observably for any scheduled debounce work
   *  from the previous case to land, then hand the next case an empty
   *  collector. No reload, no production test hook. */
  beforeEach(async () => {
    getGridApi()?.stopEditing(true);
    await waitForSettledStream("between-cases drain");
    received.length = 0;
  });

  itIfBundle(
    "1. header sort posts a server requery (orderBy name ASC, index 0)",
    async () => {
      const api = await mountStatement(
        "case 1",
        driverHeader("postgres"),
        ["id", "name"],
        [
          [1, "beta"],
          [2, "alpha"],
        ],
      );

      api.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("name ASC");
      expect(rq[0]!.index).toBe(0);
    },
  );

  itIfBundle("2. descending sort posts orderBy name DESC", async () => {
    const api = await mountStatement(
      "case 2",
      driverHeader("postgres"),
      ["id", "name"],
      [
        [1, "alpha"],
        [2, "beta"],
      ],
    );

    api.applyColumnState({
      state: [{ colId: "name", sort: "desc", sortIndex: 0 }],
    });
    await flushGridEvents();

    const rq = requeries(received);
    expect(rq).toHaveLength(1);
    expect(rq[0]!.orderBy).toBe("name DESC");
  });

  itIfBundle(
    "3. multi-column sort honours sortIndex, not colId order (a ASC, b DESC)",
    async () => {
      const api = await mountStatement(
        "case 3",
        driverHeader("postgres"),
        ["a", "b"],
        [
          [1, 2],
          [3, 4],
        ],
      );

      // colId order deliberately reversed vs sortIndex order.
      api.applyColumnState({
        state: [
          { colId: "b", sort: "desc", sortIndex: 1 },
          { colId: "a", sort: "asc", sortIndex: 0 },
        ],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("a ASC, b DESC");
    },
  );

  itIfBundle(
    "4. clearing the sort posts exactly one requery with orderBy ''",
    async () => {
      const api = await mountStatement(
        "case 4",
        driverHeader("postgres"),
        ["id", "name"],
        [
          [1, "beta"],
          [2, "alpha"],
        ],
      );

      api.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(received).length).toBe(1);

      received.length = 0;
      api.applyColumnState({ state: [{ colId: "name", sort: null }] });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("");
    },
  );

  itIfBundle(
    "5. sort composes with an active filter (orderBy AND filters together)",
    async () => {
      const api = await mountStatement(
        "case 5",
        driverHeader("postgres"),
        ["id", "name"],
        [
          [1, "alpha"],
          [2, "beta"],
          [3, "gamma"],
        ],
      );

      // Activate a set filter first; consume its (debounced) requery
      // observably — wait for the stream to carry the post and go quiet for
      // one full debounce window — then DRAIN the collector so the sort
      // assertion below sees only the sort post. The old fixed 250 ms sleep +
      // while-loop drain raced the same debounce window; this settles it.
      api.setFilterModel({ name: { values: ["beta"] } });
      await waitForSettledStream("case 5 filter drain");
      received.length = 0;

      api.applyColumnState({
        state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("name ASC");
      expect(rq[0]!.filters).toBeDefined();
    },
  );

  itIfBundle(
    "6. host-driven column-state restore posts nothing (suppressSortRequery)",
    async () => {
      const api = await mountStatement(
        "case 6",
        driverHeader("postgres"),
        ["id", "name"],
        [
          [1, "beta"],
          [2, "alpha"],
        ],
      );
      void api;

      // The webview restores the host-supplied sort after a state message —
      // a user click never went through this path, so nothing may be posted.
      const w = window as unknown as {
        __vsdb?: { applyHostColumnState?: (s: unknown[]) => void };
      };
      expect(typeof w.__vsdb!.applyHostColumnState).toBe("function");
      w.__vsdb!.applyHostColumnState!([
        { colId: "name", sort: "asc", sortIndex: 0 },
      ]);
      await flushGridEvents();

      expect(received.filter((m) => m.type === "requery")).toHaveLength(0);
    },
  );

  itIfBundle(
    "15. non-bare colId is quoted per dialect before sending",
    async () => {
      const dialects: Array<[string, string]> = [
        ["postgres", '"First Name" ASC'],
        ["mysql", "`First Name` ASC"],
        ["mssql", "[First Name] ASC"],
      ];
      for (const [driver, expected] of dialects) {
        const api = await mountStatement(
          `case 15 ${driver}`,
          driverHeader(driver),
          ["id", "First Name"],
          [
            [1, "beta"],
            [2, "alpha"],
          ],
        );

        api.applyColumnState({
          state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe(expected);
      }
    },
  );

  itIfBundle(
    "TASK-007. duplicate column sort posts the real column name",
    async () => {
      const api = await mountStatement(
        "TASK-007 duplicate",
        driverHeader("postgres"),
        ["id", "id"],
        [
          [1, 10],
          [2, 20],
        ],
      );
      const w = window as unknown as {
        __vsdb?: { debugSetSpecs?: (specs: unknown[]) => void };
      };
      expect(typeof w.__vsdb?.debugSetSpecs).toBe("function");
      w.__vsdb!.debugSetSpecs!([
        { field: "id", headerName: "id", kind: "number" },
        { field: "id__2", headerName: "id", kind: "number" },
      ]);

      api.applyColumnState({
        state: [{ colId: "id__2", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      expect(requeries(received)).toHaveLength(1);
      expect(requeries(received)[0]!.orderBy).toBe("id ASC");
      expect(requeries(received)[0]!.orderBy).not.toContain("id__2");
    },
  );

  itIfBundle(
    "TASK-007. Browse header dialect drives non-bare sort quoting",
    async () => {
      // Driver token present in a Browse header → mysql quoting…
      const mysqlApi = await mountStatement(
        "TASK-007 browse mysql",
        "Browse public.users at 2026-01-01T00:00:00.000Z — mysql@h/db",
        ["id", "First Name"],
        [[1, "alpha"]],
      );
      mysqlApi.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(received)[0]!.orderBy).toBe("`First Name` ASC");

      // …and the LEGACY bare Browse header parses no driver token, so the
      // dialect falls back to postgres quoting — same assertions as the old
      // second-loadBundle form, driven through the same single bundle.
      const legacyApi = await mountStatement(
        "TASK-007 browse legacy",
        "Browse public.users at 2026-01-01T00:00:00.000Z",
        ["id", "First Name"],
        [[1, "alpha"]],
      );
      legacyApi.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();
      expect(requeries(received)[0]!.orderBy).toBe('"First Name" ASC');
    },
  );

  itIfBundle(
    "16. bare colId stays unquoted; unknown/no-connection header falls back to postgres quoting",
    async () => {
      // Bare colId — byte-identical to what cycle V accepted.
      {
        const api = await mountStatement(
          "case 16 bare",
          driverHeader("mysql"),
          ["id", "name"],
          [
            [1, "beta"],
            [2, "alpha"],
          ],
        );
        api.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)[0]!.orderBy).toBe("name ASC");
      }
      // No-connection header → postgres double-quoting for a non-bare colId.
      {
        const api = await mountStatement(
          "case 16 no-connection",
          "Run at 2026-08-26T00:00:00.000Z — no connection",
          ["id", "First Name"],
          [
            [1, "beta"],
            [2, "alpha"],
          ],
        );
        api.applyColumnState({
          state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)[0]!.orderBy).toBe('"First Name" ASC');
      }
    },
  );

  // Fix-round regressions (reviewer findings on dialect parse + sort carry).

  itIfBundle(
    "17. dialect parsed from the driver TOKEN only — mysql connection whose host/db mention postgres stays mysql",
    async () => {
      // mysql connection on a host literally named postgres.internal with a
      // database named postgres_prod — substring-matching the whole header
      // would misdetect postgres and double-quote (rejected by MySQL host).
      const api = await mountStatement(
        "case 17",
        "Run at 2026-08-26T00:00:00.000Z — mysql@postgres.internal/postgres_prod",
        ["id", "First Name"],
        [
          [1, "beta"],
          [2, "alpha"],
        ],
      );

      api.applyColumnState({
        state: [{ colId: "First Name", sort: "asc", sortIndex: 0 }],
      });
      await flushGridEvents();

      const rq = requeries(received);
      expect(rq).toHaveLength(1);
      expect(rq[0]!.orderBy).toBe("`First Name` ASC");
    },
  );

  itIfBundle(
    "18. filter requery while a column is sorted keeps the ORDER BY; a pending filter debounce is superseded by the sort post",
    async () => {
      // (a) filter change AFTER a sort: the debounced filter requery must
      // carry the active grid sort, not the (empty) manual bar input.
      //
      // TASK-008: the fixed setTimeout(250) is gone. setFilterModel starts
      // exactly one 150 ms debounce (webview/main.ts scheduleFilterRequery);
      // the only observable completion signal is the post itself, so we wait
      // for the stream to settle (post landed + one full quiet window) —
      // bounded, with a loud named failure instead of a ghost miss.
      {
        const api = await mountStatement(
          "case 18a",
          driverHeader("postgres"),
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
          ],
        );

        api.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await flushGridEvents();
        expect(requeries(received)).toHaveLength(1);
        received.length = 0;

        api.setFilterModel({ name: { values: ["beta"] } });
        await waitForSettledStream("case 18a filter requery");

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe("name ASC");
        expect(rq[0]!.filters).toBeDefined();
      }

      // (b) sort lands INSIDE the 150 ms filter debounce: exactly one post —
      // the sort post already carries the live filter model, so the pending
      // timer must be cancelled, not fired after it (which would post a
      // newer, sort-less requery right behind the sorted one).
      //
      // A fresh remount gives (b) the exact precondition the old fresh
      // bundle gave it (sorted-less grid, no filter, empty collector); then
      // NOTE: no `await` between setFilterModel and applyColumnState — both
      // are synchronous AG Grid API dispatches, and yielding a macrotask
      // there opens a real window for the 150 ms debounce to fire before the
      // sort post on a slow runner. The bounded settle wait enforces the
      // exactly-one invariant over the FULL supersession window: a leaked
      // second post fails loudly instead of hiding behind a fixed sleep.
      {
        const api = await mountStatement(
          "case 18b",
          driverHeader("postgres"),
          ["id", "name"],
          [
            [1, "alpha"],
            [2, "beta"],
          ],
        );

        api.setFilterModel({ name: { values: ["beta"] } });
        api.applyColumnState({
          state: [{ colId: "name", sort: "asc", sortIndex: 0 }],
        });
        await waitForSettledStream("case 18b superseded debounce");

        const rq = requeries(received);
        expect(rq).toHaveLength(1);
        expect(rq[0]!.orderBy).toBe("name ASC");
        expect(rq[0]!.filters).toBeDefined();
      }
    },
  );
});
