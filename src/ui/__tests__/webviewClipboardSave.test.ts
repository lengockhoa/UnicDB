// src/ui/__tests__/webviewClipboardSave.test.ts
//
// TASK-CLIP-004 — bundle-level save pin for paste-origin dirty edits.
//
// Loads dist/webview.js into jsdom, seeds edits through the CLIP-003
// debugClipboard.simulatePaste seam, and verifies Cmd/Ctrl+Enter plus the
// commit button persist one saveEdits batch with the expected acknowledgement
// and dirty-highlight behavior.
//
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

interface EditStateHandle {
  dirtyCount: number;
}

interface ClipboardDebug {
  simulatePaste?: (text: string) => void;
}

interface UnicDBDebug {
  gridApi?: GridApi | null;
  editState?: EditStateHandle;
  commit?: () => void;
  debugClipboard?: ClipboardDebug;
}

function UnicDBApi(): UnicDBDebug | null {
  return (window as unknown as { __UnicDB?: UnicDBDebug }).__UnicDB ?? null;
}

function getEditState(): EditStateHandle | null {
  return UnicDBApi()?.editState ?? null;
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

type ReceivedMessage = { type?: string; [key: string]: unknown };

function loadBundle(): {
  received: ReceivedMessage[];
  root: HTMLDivElement;
} {
  if (!bundleSrc) {
    throw new Error(
      "dist/webview.js missing — run `npm run compile` before this test",
    );
  }

  document.body.innerHTML = '<div id="UnicDB-root" class="UnicDB-webview"></div>';
  const root = document.getElementById("UnicDB-root") as HTMLDivElement;
  const received: ReceivedMessage[] = [];
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi =
    () => ({
      postMessage: (msg: unknown) => {
        if (msg && typeof msg === "object") {
          received.push(msg as ReceivedMessage);
        }
      },
    });

  (0, eval)(bundleSrc);
  return { received, root };
}

function dispatchState(): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
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
      },
    }),
  );
}

function dispatchHost(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function seedPaste(): void {
  const api = UnicDBApi();
  expect(api?.gridApi).toBeTruthy();
  api!.gridApi!.setFocusedCell(0, "id");
  expect(api?.debugClipboard?.simulatePaste).toBeTruthy();
  api!.debugClipboard!.simulatePaste!("11\ta");
}

function saveMessages(received: ReceivedMessage[]): ReceivedMessage[] {
  return received.filter((message) => message.type === "saveEdits");
}

function dispatchCommitShortcut(
  host: HTMLElement,
  options: { ctrlKey?: boolean; metaKey?: boolean },
): void {
  host.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: options.ctrlKey ?? false,
      metaKey: options.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle (TASK-CLIP-004 save persistence)", () => {
  itIfBundle("paste 2 cells then Cmd+Enter posts exactly one saveEdits", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();
    expect(getEditState()!.dirtyCount).toBe(2);

    received.length = 0;
    const host = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    dispatchCommitShortcut(host, { metaKey: true });
    await flush();

    const saves = saveMessages(received);
    expect(saves).toHaveLength(1);
    const payload = saves[0] as {
      index: number;
      edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
      tableName: string | null;
      pkColumns: string[];
      serverIndexByRowId: Record<string, number>;
    };
    expect(payload.index).toBe(0);
    expect(payload.edits).toHaveLength(2);
    expect(payload.tableName).toBeNull();
    expect(payload.pkColumns).toEqual([]);
    expect(payload.serverIndexByRowId).toMatchObject({ "0": 0, "1": 1 });
    const valuesByKey: Record<string, unknown> = {};
    for (const edit of payload.edits) {
      valuesByKey[`${edit.rowId}:${edit.colIndex}`] = edit.value;
    }
    expect(valuesByKey).toMatchObject({ "0:0": "11", "0:1": "a" });
  });

  itIfBundle("Ctrl+Enter (ctrlKey variant) posts identically", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();

    received.length = 0;
    const host = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    dispatchCommitShortcut(host, { ctrlKey: true });
    await flush();

    const saves = saveMessages(received);
    expect(saves).toHaveLength(1);
    expect((saves[0].index as number)).toBe(0);
    expect((saves[0].edits as Array<unknown>)).toHaveLength(2);
    expect(saves[0].tableName).toBeNull();
    expect(saves[0].pkColumns).toEqual([]);
    expect(saves[0].serverIndexByRowId).toMatchObject({ "0": 0, "1": 1 });
  });

  itIfBundle("commit ✓ button persists pasted edits identically", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();

    received.length = 0;
    expect(typeof UnicDBApi()?.commit).toBe("function");
    UnicDBApi()!.commit!();
    await flush();

    const saves = saveMessages(received);
    expect(saves).toHaveLength(1);
    expect((saves[0].edits as Array<unknown>)).toHaveLength(2);
  });

  itIfBundle("Cmd+Enter with zero dirty posts nothing", async () => {
    const { received } = loadBundle();
    dispatchState();
    await flush();
    expect(getEditState()!.dirtyCount).toBe(0);

    received.length = 0;
    const host = document.querySelector(".UnicDB-grid-host") as HTMLElement;
    dispatchCommitShortcut(host, { metaKey: true });
    await flush();

    expect(saveMessages(received)).toHaveLength(0);
  });

  itIfBundle("refused saveResult shows banner reason and clears dirty", async () => {
    const { root } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();
    expect(getEditState()!.dirtyCount).toBe(2);

    UnicDBApi()!.commit!();
    await flush();
    dispatchHost({
      type: "saveResult",
      index: 0,
      ok: true,
      refused: true,
      reason: "no PK",
    });
    await flush();

    expect(getEditState()!.dirtyCount).toBe(0);
    const banner = root.querySelector(".UnicDB-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("no PK");
    expect(banner!.classList.contains("UnicDB-hidden")).toBe(false);
  });

  itIfBundle("failed save shows errors and preserves dirty edits for retry", async () => {
    const { root } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();
    const dirtyBefore = getEditState()!.dirtyCount;

    UnicDBApi()!.commit!();
    await flush();
    dispatchHost({ type: "saveResult", index: 0, ok: false, errors: ["boom"] });
    await flush();

    expect(getEditState()!.dirtyCount).toBe(dirtyBefore);
    const banner = root.querySelector(".UnicDB-save-banner");
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain("boom");
    expect(banner!.classList.contains("UnicDB-hidden")).toBe(false);
  });

  itIfBundle("saveResult ok:true clears paste-origin highlights", async () => {
    const { root } = loadBundle();
    dispatchState();
    await flush();
    seedPaste();
    await flush();
    expect(getEditState()!.dirtyCount).toBe(2);

    const gridHost = root.querySelector(".UnicDB-grid-host") as HTMLElement;
    expect(gridHost).toBeTruthy();
    expect(gridHost.querySelectorAll(".UnicDB-cell-dirty").length).toBeGreaterThan(0);

    UnicDBApi()!.commit!();
    await flush();
    dispatchHost({ type: "saveResult", index: 0, ok: true });
    await flush();

    expect(getEditState()!.dirtyCount).toBe(0);
    expect(gridHost.querySelectorAll(".UnicDB-cell-dirty")).toHaveLength(0);
  });
});
