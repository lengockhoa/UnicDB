// src/ui/__tests__/webviewResultLimit.test.ts
// TASK-ARP03-004 — jsdom bundle test for webview/main.ts resultLimited UX.
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom and asserts
// that a `resultLimited` statement renders a DISTINCT accessible truncation
// state (footer copy that REPLACES footerText's "N of N" output) and that the
// Load More gate is closed for limited statements even when rowCount is null.
// Distinctness pins: EOF / empty / cancelled keep their existing presentation.
//
// IMPORTANT: This test MUST run after `npm run compile` so that dist/webview.js
// exists — see TASK-ARP03-004 §Verification Commands. If missing, the test is
// skipped with an explanatory message (mirrors webviewBundle.test.ts).
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

// ---- bundle loading (webviewBundle.test.ts convention) ---------------------

const distPath = resolve(process.cwd(), "dist", "webview.js");
const bundleSrc = existsSync(distPath) ? readFileSync(distPath, "utf8") : null;

interface VsdbApi {
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
  const w = window as unknown as { __vsdb?: { gridApi?: GridApi } };
  return w.__vsdb?.gridApi ?? null;
}

function checkLoadMoreForHost(): void {
  const fn = (window as unknown as { __vsdbCheckLoadMoreForHost?: () => void })
    .__vsdbCheckLoadMoreForHost;
  if (typeof fn === "function") fn();
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

function limitedResult(overrides: {
  rowCount: number | null;
  resultLimited?: boolean;
}): Record<string, unknown> {
  return {
    index: 0,
    sql: "SELECT * FROM big LIMIT 100000",
    status: "done",
    batched: true,
    result: {
      columns: ["id", "name"],
      rows: buildRows(20, ["id", "name"]),
      rowCount: overrides.rowCount,
      durationMs: 5,
    },
    resultLimited: overrides.resultLimited ?? true,
    durationMs: 5,
  };
}

// ---- tests ----------------------------------------------------------------

// describeIfBundle gates the whole suite when dist/webview.js is missing, so
// plain `it` is used per-case (no dead itIfBundle constant — reviewer R1 minor).
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview resultLimited UX (TASK-ARP03-004)", () => {
  it("1. limited state shows truncation copy that REPLACES footerText (precedence)", () => {
    const { root } = loadBundle();
    dispatchState(selectState({ results: [limitedResult({ rowCount: 20 })] }));

    const footer = root.querySelector(".vsdb-grid-footer");
    expect(footer).toBeTruthy();
    const text = footer!.textContent ?? "";
    // Truncation copy must WIN over footerText's "20 of 20" total branch:
    // updateFooter short-circuits on r.resultLimited BEFORE footerText(...).
    expect(text).toMatch(/truncated/i);
    expect(text).not.toMatch(/\d+ of \d+/);
    // Not an error presentation — truncation is its own state.
    expect(root.querySelector(".vsdb-error")).toBeNull();
  });

  it("2. limited statement never posts loadMore (rowCount: null — gate closed by flag)", () => {
    const { received } = loadBundle();
    dispatchState(selectState({ results: [limitedResult({ rowCount: null })] }));

    const api = getGridApi();
    expect(api).toBeTruthy();

    // rowCount: null → resultsGridModel's EOF branch cannot close hasMore;
    // ONLY resultLimited may close the gate in this shape.
    checkLoadMoreForHost();
    checkLoadMoreForHost();

    const loadMores = received.filter((m) => m.type === "loadMore");
    expect(loadMores).toHaveLength(0);
  });

  it("3. distinct from EOF — non-batched done statement keeps plain footerText copy", () => {
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
              rows: buildRows(20, ["id", "name"]),
              rowCount: 20,
              durationMs: 5,
            },
            durationMs: 5,
          },
        ],
      }),
    );
    const footer = root.querySelector(".vsdb-grid-footer");
    expect(footer).toBeTruthy();
    const text = footer!.textContent ?? "";
    // Plain footerText output ("20 of 20" total branch) — NOT the truncation marker.
    expect(text).toMatch(/\d+ of \d+/);
    expect(text).not.toMatch(/truncated/i);
  });

  it("4. distinct from empty — empty results keep the .vsdb-empty placeholder", () => {
    const { root } = loadBundle();
    dispatchState(selectState({ results: [] }));

    const empty = root.querySelector(".vsdb-empty");
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toBe("No results yet.");
    expect(root.textContent ?? "").not.toMatch(/truncated/i);
  });

  it("5. distinct from cancel — cancelled has NO footer, NO tab badge + cancelled msg card", () => {
    const { root } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM t",
            status: "cancelled",
            durationMs: 3,
          },
        ],
      }),
    );

    // Truncation marker appears nowhere.
    expect(root.textContent ?? "").not.toMatch(/truncated/i);

    // TASK-UX2-002 — tabBadge returns "" for non-error statuses; cancelled
    // has no badge but still carries the .vsdb-tab-cancelled CSS class.
    const tab = root.querySelector(".vsdb-tab.vsdb-tab-cancelled");
    expect(tab).toBeTruthy();
    expect(tab!.textContent ?? "").not.toMatch(/[⌀✗⚠]/);

    // ...and the cancelled message card on the Messages tab.
    const tabs = root.querySelectorAll(".vsdb-tab");
    expect(tabs.length).toBe(2);
    (tabs[tabs.length - 1] as HTMLButtonElement).click();
    const card = root.querySelector(".vsdb-msg-card.vsdb-msg-cancelled");
    expect(card).toBeTruthy();
    expect(card!.textContent ?? "").toContain("Statement 1 — CANCELLED");
  });

  it("6. non-limited streaming still load-mores (gate regression pin)", () => {
    const { received } = loadBundle();
    dispatchState(
      selectState({
        results: [
          {
            index: 0,
            sql: "SELECT * FROM big",
            status: "done",
            batched: true,
            resultLimited: false,
            result: {
              columns: ["id"],
              rows: buildRows(20, ["id"]),
              rowCount: null,
              durationMs: 5,
            },
            durationMs: 5,
          },
        ],
      }),
    );

    const api = getGridApi();
    expect(api).toBeTruthy();

    checkLoadMoreForHost();

    const lm = received.find((m) => m.type === "loadMore") as
      | { index: number }
      | undefined;
    expect(lm).toBeTruthy();
    expect(lm!.index).toBe(0);
  });
});
