// src/ui/__tests__/webviewExport.test.ts
// TASK-502 — bundle-eval integration test for the export UI toolbar
// (format select + Header checkbox + To Clipboard + Export to file buttons).
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches state
// messages and asserts the toolbar wiring.
//
// Mirrors the bundle pattern from src/ui/__tests__/webviewFilters.test.ts.
// If dist/webview.js is missing, all tests are skipped with an explanatory
// message — `npm run compile` must run first.
// @vitest-environment jsdom
import type { GridApi } from "ag-grid-community";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// AG Grid's StateService debounces state dispatches with setTimeout(0). When
// the suite grows, those timers can fire after the jsdom environment is torn
// down ("window is not defined" unhandled error → non-zero exit). Drain them
// while the environment is still alive.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
});

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

interface UnicDBGlobals {
  gridApi?: GridApi;
}

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
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

  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;

  const received: Array<Record<string, unknown>> = [];
  const api: UnicDBApi = {
    postMessage: (msg) => {
      received.push(msg as Record<string, unknown>);
    },
  };
  (globalThis as unknown as { acquireVsCodeApi: () => UnicDBApi }).acquireVsCodeApi =
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

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts export toolbar (TASK-502)", () => {
  itIfBundle(
    "1. toolbar renders a format <select> with 8 options",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
      const opts = Array.from(select!.options).map((o) => o.value);
      expect(opts).toEqual([
        "tsv",
        "csv",
        "xml",
        "json",
        "sql-inserts",
        "sql-inserts-multirow",
        "sql-updates",
        "sql-where",
      ]);
    },
  );

  itIfBundle(
    "2. Header checkbox enabled for tsv/csv/xml/json, disabled for SQL modes",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      const headerCb = root.querySelector(
        ".UnicDB-export-header",
      ) as HTMLInputElement | null;
      expect(select).toBeTruthy();
      expect(headerCb).toBeTruthy();

      // Default TSV → enabled, unchecked.
      expect(headerCb!.disabled).toBe(false);

      // Switch to CSV → still enabled.
      select!.value = "csv";
      select!.dispatchEvent(new Event("change"));
      expect(headerCb!.disabled).toBe(false);

      // Switch to JSON → still enabled.
      select!.value = "json";
      select!.dispatchEvent(new Event("change"));
      expect(headerCb!.disabled).toBe(false);

      // Switch to XML → still enabled.
      select!.value = "xml";
      select!.dispatchEvent(new Event("change"));
      expect(headerCb!.disabled).toBe(false);

      // SQL modes → disabled + unchecked.
      for (const sqlFmt of [
        "sql-inserts",
        "sql-inserts-multirow",
        "sql-updates",
        "sql-where",
      ]) {
        select!.value = sqlFmt;
        select!.dispatchEvent(new Event("change"));
        expect(headerCb!.disabled, sqlFmt).toBe(true);
        expect(headerCb!.checked, sqlFmt).toBe(false);
      }
    },
  );

  itIfBundle(
    "3. Copy button posts `{type:'copy', text}` with TSV (default), Header off → no header line",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const copyBtn = root.querySelector(
        ".UnicDB-export-copy",
      ) as HTMLButtonElement | null;
      expect(copyBtn).toBeTruthy();
      copyBtn!.click();

      const copyMsg = received.filter((m) => m.type === "copy");
      expect(copyMsg.length).toBe(1);
      const t = (copyMsg[0] as { text: string }).text;
      // Header off (default) → first line is "1\talpha" (no "id\tname" line).
      expect(t.split("\n")[0]).toBe("1\talpha");
      expect(t).not.toContain("id\tname");
      void root;
    },
  );

  itIfBundle(
    "4. Copy button with Header checked → header line is included",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const headerCb = root.querySelector(
        ".UnicDB-export-header",
      ) as HTMLInputElement | null;
      headerCb!.checked = true;
      headerCb!.dispatchEvent(new Event("change"));

      const copyBtn = root.querySelector(
        ".UnicDB-export-copy",
      ) as HTMLButtonElement | null;
      copyBtn!.click();

      const copyMsg = received.filter((m) => m.type === "copy");
      expect(copyMsg.length).toBe(1);
      const t = (copyMsg[0] as { text: string }).text;
      expect(t.split("\n")[0]).toBe("id\tname");
      expect(t).toContain("1\talpha");
      void root;
    },
  );

  itIfBundle(
    "5. Export-to-file button posts `{type:'exportFile', format, text}`",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      select!.value = "csv";
      select!.dispatchEvent(new Event("change"));

      const exportBtn = root.querySelector(
        ".UnicDB-export-file",
      ) as HTMLButtonElement | null;
      expect(exportBtn).toBeTruthy();
      exportBtn!.click();

      const exportMsgs = received.filter((m) => m.type === "exportFile");
      expect(exportMsgs.length).toBe(1);
      const m = exportMsgs[0] as { format: string; text: string };
      expect(m.format).toBe("csv");
      // CSV header off (default) → first line is "1,alpha".
      expect(m.text.split("\n")[0]).toBe("1,alpha");
      void root;
    },
  );

  itIfBundle(
    "6. sql-where export includes selected rows via WHERE clause",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      // Select row 0 + row 2 via the grid API (AG Grid auto-selects when
      // rowSelection.checkboxes is true).
      const api = (window as unknown as { __UnicDB?: { gridApi?: GridApi } })
        .__UnicDB?.gridApi;
      expect(api).toBeTruthy();
      api!.forEachNode((node) => {
        if (node.data && (node.data.__rowId === 0 || node.data.__rowId === 2)) {
          node.setSelected(true);
        }
      });

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      select!.value = "sql-where";
      select!.dispatchEvent(new Event("change"));

      const exportBtn = root.querySelector(
        ".UnicDB-export-file",
      ) as HTMLButtonElement | null;
      exportBtn!.click();

      const exportMsgs = received.filter((m) => m.type === "exportFile");
      expect(exportMsgs.length).toBe(1);
      const m = exportMsgs[0] as { format: string; text: string };
      expect(m.format).toBe("sql-where");
      expect(m.text).toContain("WHERE");
      // No PK columns on the test table → fallback to all-cols AND.
      // TASK-004 P2-6 fix: bare identifiers pass through unquoted (valid on
      // every dialect), only reserved/spaced names are quoted. Header has no
      // driver token → dialect unknown → postgres default.
      expect(m.text).toBe(
        "WHERE (id=1 AND name='alpha') OR (id=3 AND name='gamma')",
      );
    },
  );

  itIfBundle(
    "6b. header driver token selects dialect for SQL export quoting (mysql → backticks)",
    () => {
      const { root, received } = loadBundle();
      // Header carries the mysql driver token the way the host composes it —
      // detectDialectFromHeader parses `— <driver>@<host>`.
      dispatchState({
        type: "state",
        header: "test.sql — mysql@localhost",
        busy: false,
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t",
            status: "done",
            result: {
              columns: ["id", "order"],
              rows: [[1, "x"]],
              rowCount: 1,
              durationMs: 1,
            },
            durationMs: 1,
          },
        ],
      });

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      // sql-where with no PK → all columns become the key, so quoting shows
      // in the WHERE clause (sql-updates would hit the empty-SET skip path).
      select!.value = "sql-where";
      select!.dispatchEvent(new Event("change"));

      const exportBtn = root.querySelector(
        ".UnicDB-export-file",
      ) as HTMLButtonElement | null;
      exportBtn!.click();

      const exportMsgs = received.filter((m) => m.type === "exportFile");
      expect(exportMsgs.length).toBe(1);
      const m = exportMsgs[0] as { text: string };
      // Reserved word `order` → backtick-quoted under mysql, bare `id` stays.
      expect(m.text).toBe("WHERE (id=1 AND `order`='x')");
    },
  );

  itIfBundle(
    "R1.7 (R2-corrected). sql-updates click with no PK metadata does NOT throw — posts exportFile with skip-comment output",
    () => {
      const { root, received } = loadBundle();
      dispatchState(threeRowsState());
      void received;

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      select!.value = "sql-updates";
      select!.dispatchEvent(new Event("change"));

      const exportBtn = root.querySelector(
        ".UnicDB-export-file",
      ) as HTMLButtonElement | null;
      // Until TASK-503 wires PK metadata, the webview has no PK source.
      // R1: the click handler must NOT throw.
      // R2: the emitted SQL must be parseable — pre-R2 emitted
      // `UPDATE t WHERE (…)` (no SET), which sqlite rejects. The
      // correct output is a SQL skip-comment per row instead.
      expect(() => exportBtn!.click()).not.toThrow();

      const exportMsgs = received.filter((m) => m.type === "exportFile");
      expect(exportMsgs.length).toBe(1);
      const m = exportMsgs[0] as { format: string; text: string };
      expect(m.format).toBe("sql-updates");
      // No malformed UPDATE t WHERE … — every row is skipped.
      expect(m.text).not.toMatch(/UPDATE\s+t/);
      expect(m.text).toContain("row 1 skipped: no non-key columns to update");
      void root;
    },
  );

  // TASK-001 — INVERTED contract from TASK-006. The browse path no longer
  // wraps the SELECT to append `ctid`, so the column can only reach the
  // export when it is a real user column. The serializer's `hiddenColumns`
  // mechanism is no longer triggered for `ctid` automatically; the column
  // is exported like any other string column.
  itIfBundle(
    "TASK-001. ctid column appears in TSV export (an ordinary user column)",
    () => {
      const { root, received } = loadBundle();
      // Plain fixture SQL — no host wrap.
      dispatchState({
        type: "state",
        header: "Browse public.notes at 2024-01-01T00:00:00.000Z",
        busy: false,
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
      });
      void received;

      const select = root.querySelector(
        ".UnicDB-export-format",
      ) as HTMLSelectElement | null;
      select!.value = "tsv";
      select!.dispatchEvent(new Event("change"));
      // Header is unchecked by default — toggle it on for the header assertion.
      const headerCb = root.querySelector(
        ".UnicDB-export-header",
      ) as HTMLInputElement | null;
      headerCb!.checked = true;
      headerCb!.dispatchEvent(new Event("change"));

      const exportBtn = root.querySelector(
        ".UnicDB-export-file",
      ) as HTMLButtonElement | null;
      exportBtn!.click();

      const exportMsgs = received.filter((m) => m.type === "exportFile");
      expect(exportMsgs.length).toBe(1);
      const m = exportMsgs[0] as { format: string; text: string };
      expect(m.format).toBe("tsv");
      const lines = m.text.split("\n");
      // Header has all three columns including ctid.
      expect(lines[0]).toBe("name\tcreated_at\tctid");
      // Data rows have 3 cells each, including the ctid value.
      expect(lines[1]).toBe("alice\t2024-01-01T00:00:00.000Z\t(0,1)");
      expect(lines[2]).toBe("bob\t2024-02-02T00:00:00.000Z\t(0,2)");
      // ctid values appear in the output (it is a user column on this fixture).
      expect(m.text).toMatch(/\bctid\b/);
      expect(m.text).toContain("(0,1)");
      expect(m.text).toContain("(0,2)");
    },
  );

  // TASK-007 (cycle Y) — readExportInput's return annotation declares the
  // already-computed and already-consumed `hiddenColumns` field. esbuild
  // strips type annotations, so pin the SOURCE of webview/main.ts — a
  // type-level contract tsconfig.json (which excludes webview/) cannot see.
  it("TASK-007. readExportInput return annotation declares hiddenColumns", () => {
    const src = readFileSync(resolve(process.cwd(), "webview", "main.ts"), "utf8");
    const fnStart = src.indexOf("function readExportInput():");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const signature = src.slice(fnStart, fnStart + 700);
    expect(signature).toMatch(/hiddenColumns:\s*string\[\]/);
  });
});
