// src/ui/__tests__/webviewRetry.test.ts
//
// TASK-005 — A19 failed-row retry affordance (webview side).
//
// Bundle-eval tests (jsdom + dist/webview.js via `npm run compile`) for the
// "Retry failed rows" button in the save banner and the retryFailedRows
// message construction. Host-side handleRetryFailedRows coverage lives in
// resultsPanelRetry.test.ts (node env — vi.mock("vscode") does not resolve
// under jsdom).
//
//   R1. retry button appears when saveResult has rowErrors
//   R2. retry button hidden when saveResult has no rowErrors
//   R3. clicking retry posts retryFailedRows message
//   R4. retry message contains only failed row IDs (3 successes, 2 failures)
//   R5. retry with 0 failed rows → no message posted (no-op)
//   R6. retry edits come from editState for failed rows only (mixed
//       clean/dirty)
//
// If dist/webview.js is missing, all tests here are skipped.
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
  clear: () => void;
  dirtyCount: number;
  snapshot: () => Array<{ rowId: number; colIndex: number; value: unknown }>;
}

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBDebug {
  gridApi?: GridApi;
  editState?: EditStateHandle;
  commit?: () => void;
  retry?: () => void;
  simulateCellEdit?: (
    rowId: number,
    rowField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
}

function UnicDBApi(): UnicDBDebug | null {
  if (typeof window === "undefined") return null;
  const maybe = (window as unknown as { __UnicDB?: UnicDBDebug }).__UnicDB;
  return maybe ?? null;
}

function getEditState(): EditStateHandle | null {
  return UnicDBApi()?.editState ?? null;
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

function dispatchMsg(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function stateWith(rows: unknown[][]): Record<string, unknown> {
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
  return stateWith([
    [1, "alpha"],
    [2, "beta"],
    [3, "gamma"],
  ]);
}

function fiveRowsState(): Record<string, unknown> {
  return stateWith([
    [1, "a"],
    [2, "b"],
    [3, "c"],
    [4, "d"],
    [5, "e"],
  ]);
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Dirty rows 0..n-1 (name column) and run a commit so a saveEdits batch is
 *  posted — mirrors the real partial-failure pre-state. */
async function dirtyAndCommit(
  names: string[],
  originals: string[],
): Promise<void> {
  const sim = UnicDBApi()?.simulateCellEdit;
  expect(sim).toBeTruthy();
  for (let i = 0; i < names.length; i++) {
    sim!(i, "name", names[i], originals[i]);
  }
  await flushGridEvents();
  UnicDBApi()!.commit!();
  await flushGridEvents();
}

function findRetryButton(): HTMLButtonElement | null {
  return document.querySelector(
    ".UnicDB-save-banner .UnicDB-save-retry",
  ) as HTMLButtonElement | null;
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle — TASK-005 retry affordance", () => {
  itIfBundle("R1. retry button appears when saveResult has rowErrors", async () => {
    const { received } = loadBundle();
    void received;
    dispatchMsg(threeRowsState());
    await flushGridEvents();

    await dirtyAndCommit(
      ["new-a", "new-b", "new-c"],
      ["alpha", "beta", "gamma"],
    );
    expect(getEditState()!.dirtyCount).toBe(3);

    // Partial failure: rows 0 and 2 failed, row 1 succeeded.
    dispatchMsg({
      type: "saveResult",
      index: 0,
      ok: true,
      rowErrors: [
        { rowId: 0, error: "boom" },
        { rowId: 2, error: "kaput" },
      ],
    });
    await flushGridEvents();

    const banner = document.querySelector(
      ".UnicDB-save-banner",
    ) as HTMLElement | null;
    expect(banner).toBeTruthy();
    // Banner is VISIBLE (no hidden class, no hidden attribute).
    expect(banner!.classList.contains("UnicDB-hidden")).toBe(false);
    expect(banner!.getAttribute("hidden")).toBe(null);
    // Retry button exists inside the banner DOM.
    const btn = findRetryButton();
    expect(btn).toBeTruthy();
    expect(btn instanceof HTMLButtonElement).toBe(true);
    expect(btn!.getAttribute("aria-label")).toContain("Retry");
  });

  itIfBundle("R2. retry button hidden when saveResult has no rowErrors", async () => {
    loadBundle();
    dispatchMsg(threeRowsState());
    await flushGridEvents();

    await dirtyAndCommit(["new-a"], ["alpha"]);

    // Full success — no rowErrors key at all.
    dispatchMsg({ type: "saveResult", index: 0, ok: true });
    await flushGridEvents();

    expect(getEditState()!.dirtyCount).toBe(0);
    // No retry button in the banner DOM (banner itself hidden).
    expect(findRetryButton()).toBeNull();
    const banner = document.querySelector(
      ".UnicDB-save-banner",
    ) as HTMLElement | null;
    expect(banner).toBeTruthy();
    const hidden =
      banner!.classList.contains("UnicDB-hidden") ||
      banner!.getAttribute("hidden") !== null;
    expect(hidden).toBe(true);
  });

  itIfBundle("R3. clicking retry posts retryFailedRows message", async () => {
    const { received } = loadBundle();
    dispatchMsg(threeRowsState());
    await flushGridEvents();

    await dirtyAndCommit(
      ["new-a", "new-b", "new-c"],
      ["alpha", "beta", "gamma"],
    );
    dispatchMsg({
      type: "saveResult",
      index: 0,
      ok: true,
      rowErrors: [
        { rowId: 0, error: "boom" },
        { rowId: 2, error: "kaput" },
      ],
    });
    await flushGridEvents();
    // Successful row 1's edits were cleared; failed rows 0 + 2 stay dirty.
    expect(getEditState()!.dirtyCount).toBe(2);

    received.length = 0;
    const btn = findRetryButton();
    expect(btn).toBeTruthy();
    btn!.click();
    await flushGridEvents();

    const retries = received.filter((m) => m.type === "retryFailedRows");
    expect(retries).toHaveLength(1);
    const payload = retries[0] as {
      index: number;
      rowIds: number[];
      edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      serverIndexByRowId?: Record<string, number>;
    };
    expect(payload.index).toBe(0);
    expect(payload.rowIds).toHaveLength(2);
    expect(payload.rowIds).toContain(0);
    expect(payload.rowIds).toContain(2);
    // Edits carry only failed rows' values (snapshot-driven).
    expect(payload.edits.length).toBeGreaterThanOrEqual(2);
    const vals = payload.edits.map((e) => e.value);
    expect(vals).toContain("new-a");
    expect(vals).toContain("new-c");
    expect(vals).not.toContain("new-b");
    for (const e of payload.edits) {
      expect(payload.rowIds).toContain(e.rowId);
    }
    // Addressing map rides along (same contract as saveEdits).
    expect(payload.serverIndexByRowId).toBeTruthy();
  });

  itIfBundle(
    "R4. retry message contains only failed row IDs (3 successes, 2 failures)",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(fiveRowsState());
      await flushGridEvents();

      await dirtyAndCommit(
        ["n0", "n1", "n2", "n3", "n4"],
        ["a", "b", "c", "d", "e"],
      );
      expect(getEditState()!.dirtyCount).toBe(5);

      // 3 succeed (0, 2, 4), 2 fail (1, 3).
      dispatchMsg({
        type: "saveResult",
        index: 0,
        ok: true,
        rowErrors: [
          { rowId: 1, error: "e1" },
          { rowId: 3, error: "e3" },
        ],
      });
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(2);

      received.length = 0;
      const btn = findRetryButton();
      expect(btn).toBeTruthy();
      btn!.click();
      await flushGridEvents();

      const retries = received.filter((m) => m.type === "retryFailedRows");
      expect(retries).toHaveLength(1);
      const payload = retries[0] as {
        rowIds: number[];
        edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      };
      // rowIds length matches rowErrors length (2), and no succeeded row id.
      expect(payload.rowIds).toHaveLength(2);
      expect([...payload.rowIds].sort((a, b) => a - b)).toEqual([1, 3]);
      for (const e of payload.edits) {
        expect([1, 3]).toContain(e.rowId);
      }
    },
  );

  itIfBundle("R5. retry with 0 failed rows → no message posted (no-op)", async () => {
    const { received } = loadBundle();
    dispatchMsg(threeRowsState());
    await flushGridEvents();

    await dirtyAndCommit(["new-a"], ["alpha"]);
    // rowErrors EMPTY array → not a partial failure; full-success path.
    dispatchMsg({
      type: "saveResult",
      index: 0,
      ok: true,
      rowErrors: [],
    });
    await flushGridEvents();
    expect(findRetryButton()).toBeNull();

    // Also the all-failed ack (ok:false, no rowErrors) must not arm retry:
    // dirty state survives but there is no per-row subset record.
    await dirtyAndCommit(["new-a"], ["alpha"]);
    dispatchMsg({
      type: "saveResult",
      index: 0,
      ok: false,
      errors: ["everything failed"],
    });
    await flushGridEvents();
    expect(getEditState()!.dirtyCount).toBe(1);
    expect(findRetryButton()).toBeNull();

    // Invoke the retry handler directly (the button never rendered) —
    // with 0 failed rows it MUST be a no-op: nothing posted.
    expect(typeof UnicDBApi()?.retry).toBe("function");
    received.length = 0;
    UnicDBApi()!.retry!();
    await flushGridEvents();
    expect(
      received.filter((m) => m.type === "retryFailedRows"),
    ).toHaveLength(0);
    // Commit is NOT triggered either (no saveEdits side-effect).
    expect(received.filter((m) => m.type === "saveEdits")).toHaveLength(0);
  });

  itIfBundle(
    "R6. retry edits come from editState for failed rows only (mixed clean/dirty)",
    async () => {
      const { received } = loadBundle();
      dispatchMsg(threeRowsState());
      await flushGridEvents();

      await dirtyAndCommit(
        ["new-a", "new-b", "new-c"],
        ["alpha", "beta", "gamma"],
      );
      // Only row 1 failed; rows 0 + 2 committed and are now CLEAN.
      dispatchMsg({
        type: "saveResult",
        index: 0,
        ok: true,
        rowErrors: [{ rowId: 1, error: "boom" }],
      });
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(1);

      // User then edits a CLEAN row (row 0) — it becomes dirty again but is
      // NOT part of the failed set.
      const sim = UnicDBApi()?.simulateCellEdit;
      sim!(0, "name", "post-failure-edit", "alpha");
      await flushGridEvents();
      expect(getEditState()!.dirtyCount).toBe(2);

      received.length = 0;
      const btn = findRetryButton();
      expect(btn).toBeTruthy();
      btn!.click();
      await flushGridEvents();

      const retries = received.filter((m) => m.type === "retryFailedRows");
      expect(retries).toHaveLength(1);
      const payload = retries[0] as {
        rowIds: number[];
        edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      };
      // Snapshot filtered to errored rowIds ONLY — row 0's fresh edit is
      // not swept into the retry batch.
      expect(payload.rowIds).toEqual([1]);
      expect(payload.edits.length).toBeGreaterThanOrEqual(1);
      for (const e of payload.edits) {
        expect(e.rowId).toBe(1);
      }
      const vals = payload.edits.map((e) => e.value);
      expect(vals).toContain("new-b");
      expect(vals).not.toContain("post-failure-edit");
    },
  );
});
