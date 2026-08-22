// src/ui/__tests__/webviewSaveEdits.test.ts
//
// TASK-503 — bundle-eval tests for saveEdits (Cmd/Ctrl+Enter + Commit button).
//
// Loads dist/webview.js into jsdom (built via `npm run compile`), stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, dispatches a state message,
// then exercises:
//
//  - 1) commit button presence + postToHost emits exactly ONE saveEdits
//       message even with multiple dirty cells across rows (batched payload).
//  - 2) no-op when dirtyCount === 0 (no saveEdits message posted at all).
//  - 3) saveResult ack with ok:true → editState cleared + banner hidden.
//  - 4) saveResult ack with ok:false → banner shows errors, editState KEPT.
//
// If dist/webview.js is missing, all tests are skipped.
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
  undo: () => { rowId: number; colIndex: number } | null;
  clear: () => void;
  dirtyCount: number;
  snapshot: () => Array<{ rowId: number; colIndex: number; value: unknown }>;
}

interface VsdbApi {
  postMessage: (msg: unknown) => void;
}

interface VsdbDebug {
  gridApi?: GridApi;
  editState?: EditStateHandle;
  commit?: () => void;
  addRow?: () => void;
  deleteRow?: () => void;
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

/** Dispatch a host→webview message (e.g. saveResult ack). */
function dispatchHost(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

async function flushGridEvents(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-503)", () => {
  itIfBundle("T1. commit with multiple dirty edits posts EXACTLY ONE saveEdits batch", async () => {
    const { received } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const editState = getEditState();
    expect(editState).toBeTruthy();
    expect(editState!.dirtyCount).toBe(0);

    const sim = vsdbApi()?.simulateCellEdit;
    expect(sim).toBeTruthy();
    // Two rows × two cells. Single onCellValueChanged per edit = same code
    // path the real user edits follow.
    sim!(0, "name", "new-alpha", "alpha");
    sim!(0, "id", 11, 1);
    sim!(1, "name", "new-beta", "beta");
    sim!(2, "id", 33, 3);
    await flushGridEvents();

    expect(editState!.dirtyCount).toBe(4);

    received.length = 0;
    // Invoke commit through the bundle's exposed handler (same call site as
    // Cmd+Enter and the Commit button).
    expect(typeof vsdbApi()?.commit).toBe("function");
    vsdbApi()!.commit!();
    await flushGridEvents();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs).toHaveLength(1);
    const payload = saveMsgs[0] as {
      type: string;
      index: number;
      edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      tableName: string | null;
      pkColumns: string[];
    };
    expect(payload.index).toBe(0);
    expect(payload.edits).toHaveLength(4);
    // Batched payload preserves entries for each dirty cell — caller can
    // group by rowId on the host side.
    const byKey: Record<string, unknown> = {};
    for (const e of payload.edits) byKey[`${e.rowId}:${e.colIndex}`] = e.value;
    expect(byKey["0:0"]).toBe(11);
    expect(byKey["0:1"]).toBe("new-alpha");
    expect(byKey["1:1"]).toBe("new-beta");
    expect(byKey["2:0"]).toBe(33);
    // Required contract fields.
    expect(Array.isArray(payload.pkColumns)).toBe(true);
  });

  itIfBundle("T2. commit with NO dirty edits is a no-op (no saveEdits posted)", async () => {
    const { received } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    expect(getEditState()!.dirtyCount).toBe(0);
    received.length = 0;
    vsdbApi()!.commit!();
    await flushGridEvents();

    const saveMsgs = received.filter((m) => m.type === "saveEdits");
    expect(saveMsgs).toHaveLength(0);
  });

  itIfBundle("T3. saveResult ack (ok:true) → editState cleared, banner hidden", async () => {
    const { root, received } = loadBundle();
    void root;
    dispatchState(threeRowsState());
    await flushGridEvents();

    const sim = vsdbApi()?.simulateCellEdit;
    sim!(0, "name", "x", "alpha");
    sim!(1, "name", "y", "beta");
    await flushGridEvents();
    expect(getEditState()!.dirtyCount).toBe(2);

    // Trigger commit so a saveEdits message is posted (otherwise the host
    // has no payload to ack — the bundle listens for saveResult ALL the
    // time, so an unattached ack is harmless but the dirty state should
    // still be cleared on success).
    received.length = 0;
    vsdbApi()!.commit!();
    await flushGridEvents();
    expect(
      received.filter((m) => m.type === "saveEdits").length,
    ).toBeGreaterThanOrEqual(1);

    // Host returns success.
    dispatchHost({ type: "saveResult", index: 0, ok: true });
    await flushGridEvents();

    expect(getEditState()!.dirtyCount).toBe(0);
    // Banner is removed (or at minimum has the hidden class).
    const banner = document.querySelector(".vsdb-save-banner");
    if (banner) {
      expect(
        banner.classList.contains("vsdb-hidden") ||
          banner.classList.contains("vsdb-save-banner-hidden") ||
          banner.getAttribute("hidden") !== null,
      ).toBe(true);
    }
  });

  itIfBundle("T4. saveResult ack (ok:false, with errors) → banner shows errors, editState KEPT", async () => {
    const { received } = loadBundle();
    dispatchState(threeRowsState());
    await flushGridEvents();

    const sim = vsdbApi()?.simulateCellEdit;
    sim!(0, "name", "x", "alpha");
    await flushGridEvents();
    expect(getEditState()!.dirtyCount).toBe(1);

    received.length = 0;
    vsdbApi()!.commit!();
    await flushGridEvents();

    dispatchHost({
      type: "saveResult",
      index: 0,
      ok: false,
      errors: ["ERROR: column \"x\" does not exist"],
    });
    await flushGridEvents();

    // Edit state preserved so user can retry.
    expect(getEditState()!.dirtyCount).toBe(1);

    // Banner visible with the error text.
    const banner = document.querySelector(".vsdb-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("ERROR");
    // Visible (no hidden class).
    const hidden =
      banner!.classList.contains("vsdb-hidden") ||
      banner!.classList.contains("vsdb-save-banner-hidden") ||
      banner!.getAttribute("hidden") !== null;
    expect(hidden).toBe(false);
  });
});
