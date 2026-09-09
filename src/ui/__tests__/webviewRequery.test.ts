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

  // TASK-RES-001 — Enter key on the WHERE input posts a requery exactly once
  // per keydown. debounce-free; host requerySeq guard drops stale runs.
  itIfBundle("5. Enter keydown on WHERE input → exactly one requery post", () => {
    const { received, root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();
    whereInput!.value = "id > 1";
    orderInput!.value = "id DESC";
    whereInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "id > 1",
      orderBy: "id DESC",
    });
  });

  // TASK-RES-001 — Enter key on the ORDER BY input (both boxes filled) posts
  // exactly one requery carrying both values.
  itIfBundle("6. Enter keydown on ORDER BY input → exactly one requery post (both values)", () => {
    const { received, root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();
    whereInput!.value = "id > 1";
    orderInput!.value = "id DESC";
    orderInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(1);
    expect(requeryMsgs[0]).toEqual({
      type: "requery",
      index: 0,
      where: "id > 1",
      orderBy: "id DESC",
    });
  });

  // TASK-RES-001 / TASK-COLLAPSE-002 — toolbar placement (P0 slot). The
  // requery inputs live as direct children of row 2 in the exact slot after
  // the row-1 export format <select> and before the export header checkbox.
  // The old `data-UnicDB-requery-bar` wrapper element is gone.
  itIfBundle("7. Toolbar placement (P0 slot): inputs between export-format and export-header; no requery-bar wrapper", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLElement | null;
    const exportFormat = root.querySelector(
      ".UnicDB-export-format",
    ) as HTMLElement | null;
    const exportHeader = root.querySelector(
      ".UnicDB-export-header",
    ) as HTMLElement | null;
    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLElement | null;
    const orderInput = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLElement | null;
    expect(toolbar).toBeTruthy();
    expect(exportFormat).toBeTruthy();
    expect(exportHeader).toBeTruthy();
    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();

    // Both inputs are direct children of row 2; row 1 still owns the
    // export-format select and the split begins exactly at WHERE.
    const row2 = toolbar!.querySelector(
      ".UnicDB-toolbar-row:nth-child(2)",
    ) as HTMLElement | null;
    expect(row2).toBeTruthy();
    expect(whereInput!.parentElement).toBe(row2);
    expect(orderInput!.parentElement).toBe(row2);
    expect(row2!.firstElementChild).toBe(whereInput);

    // Sibling order: exportFormat < requeryWhere < requeryOrderBy < exportHeader
    const cmp = (a: Element, b: Element): number => {
      const rel = a.compareDocumentPosition(b);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    expect(cmp(exportFormat!, whereInput!)).toBe(-1);
    expect(cmp(whereInput!, orderInput!)).toBe(-1);
    expect(cmp(orderInput!, exportHeader!)).toBe(-1);

    // Old `requery-bar` wrapper element is gone.
    expect(document.querySelector("[data-UnicDB-requery-bar]")).toBeNull();
    expect(document.querySelector(".UnicDB-requery-bar")).toBeNull();
  });

  // TASK-RES-001 — placeholders and aria-labels are the new fragment-style
  // contract (U+2026 ellipsis + non-empty aria-label).
  itIfBundle("8. New placeholders ('WHERE …' / 'ORDER BY …') + non-empty aria-label", () => {
    const { root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    const orderInput = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLInputElement | null;
    expect(whereInput).toBeTruthy();
    expect(orderInput).toBeTruthy();
    expect(whereInput!.placeholder).toBe("WHERE …");
    expect(orderInput!.placeholder).toBe("ORDER BY …");
    expect(whereInput!.getAttribute("aria-label")).not.toBe("");
    expect(orderInput!.getAttribute("aria-label")).not.toBe("");
  });

  // TASK-RES-001 — non-Enter keys MUST NOT post a requery. Tested with two
  // representative key kinds (a printable letter, Escape).
  itIfBundle("9. Non-Enter keys ('a', 'Escape') on WHERE input → zero requery posts", () => {
    const { received, root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    expect(whereInput).toBeTruthy();
    whereInput!.value = "id > 1";
    whereInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    whereInput!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(0);
  });

  // TASK-RES-001 — Enter during IME composition MUST NOT post a requery.
  // isComposing flag is set while an IME is converting the keystroke.
  itIfBundle("10. Enter during IME composition (isComposing:true) on WHERE input → zero requery posts", () => {
    const { received, root } = loadBundle();
    dispatchState(selectState());

    const whereInput = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLInputElement | null;
    expect(whereInput).toBeTruthy();
    whereInput!.value = "id > 1";
    whereInput!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    const requeryMsgs = received.filter((m) => m.type === "requery");
    expect(requeryMsgs).toHaveLength(0);
  });

  // TASK-RES-001 — REWRITTEN document-order test. The old layout pinned
  // `requery bar < grid host` and asserted the empty-state invisibility of
  // the bar (it lived inside gridWrap which is detached pre-state). The
  // new layout puts the requery inputs in the persistent toolbar, so the
  // inputs exist in the DOM in the EMPTY state and the toolbar sits
  // BEFORE the grid host in document order.
  itIfBundle("11. Document order rewritten for new layout: toolbar < grid-host; requery inputs present in DOM in empty state", () => {
    const { root } = loadBundle();

    // Empty state: no state dispatched. Toolbar still owns the requery
    // inputs because the toolbar is persistent.
    const toolbarEmpty = root.querySelector(".UnicDB-toolbar") as HTMLElement | null;
    const whereInputEmpty = root.querySelector(
      ".UnicDB-requery-where",
    ) as HTMLElement | null;
    const orderInputEmpty = root.querySelector(
      ".UnicDB-requery-order",
    ) as HTMLElement | null;
    expect(toolbarEmpty).toBeTruthy();
    expect(whereInputEmpty).toBeTruthy();
    expect(orderInputEmpty).toBeTruthy();
    // No old requery-bar wrapper exists in the empty state.
    expect(document.querySelector("[data-UnicDB-requery-bar]")).toBeNull();

    // Now dispatch state — toolbar precedes grid host in document order.
    dispatchState(selectState());
    const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLElement | null;
    const gridHost = root.querySelector(".UnicDB-ag-host") as HTMLElement | null;
    expect(toolbar).toBeTruthy();
    expect(gridHost).toBeTruthy();

    const cmp = (a: Element, b: Element): number => {
      const rel = a.compareDocumentPosition(b);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    };
    expect(cmp(toolbar!, gridHost!)).toBe(-1);
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

// TASK-RES-003 — toolbar hover polish: drop native `title` so the custom
// `data-tooltip` pseudo-tooltip is the only tooltip source; ensure the
// hover block does NOT transition any layout-triggering property.
const stylesPath = resolve(process.cwd(), "webview", "styles.css");
const stylesSrc = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : null;

describeIfBundle("webview/main.ts toolbar hover polish (TASK-RES-003)", () => {
  itIfBundle(
    "1. makeIconButton does NOT set btn.title; data-tooltip + aria-label still present and equal",
    () => {
      const { root } = loadBundle();
      dispatchState(selectState());
      const btns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
      ).filter(
        (el): el is HTMLButtonElement => el.tagName === "BUTTON",
      ) as HTMLButtonElement[];
      expect(btns.length, "expected 12 toolbar buttons (10 + Re-Run + Clear)").toBe(12);

      for (const b of btns) {
        // The native `title` attribute is gone — the custom data-tooltip
        // pseudo-tooltip is the only source.
        expect(
          b.hasAttribute("title"),
          `button .${b.className} should not have native title attribute`,
        ).toBe(false);
        // data-tooltip and aria-label carry the tooltip text.
        const dataTooltip = b.getAttribute("data-tooltip");
        const ariaLabel = b.getAttribute("aria-label");
        expect(dataTooltip, `button .${b.className} missing data-tooltip`).toBeTruthy();
        expect(dataTooltip).not.toBe("");
        expect(ariaLabel, `button .${b.className} missing aria-label`).toBeTruthy();
        expect(ariaLabel).not.toBe("");
        // They must carry the SAME tooltip text (callers continue to pass
        // one string, used for both the pseudo-tooltip and aria-label).
        expect(dataTooltip).toBe(ariaLabel);
      }
    },
  );

  itIfBundle(
    "2. .UnicDB-btn:hover:not(:disabled) declares NO layout-triggering property (jsdom cannot layout)",
    () => {
      if (!stylesSrc) {
        throw new Error("webview/styles.css missing");
      }
      // P2.5 reviewer rewrite: jsdom does not layout, so getBoundingClientRect()
      // equality before/after hover is unreliable. Assert property-level
      // absence of layout-triggering properties instead. The hover block
      // may ONLY change composited/non-layout properties (background-color,
      // box-shadow, etc.).
      const re = /\.UnicDB-btn:hover:not\(:disabled\)\s*\{([^}]*)\}/;
      const m = re.exec(stylesSrc);
      expect(
        m,
        "could not locate .UnicDB-btn:hover:not(:disabled) block in styles.css",
      ).toBeTruthy();
      const body = m![1];
      const forbidden = [
        "width",
        "height",
        "padding",
        "margin",
        "border",
        "top",
        "left",
        "right",
        "bottom",
      ];
      for (const prop of forbidden) {
        // Match `prop:` (not substrings); word-boundary keeps "top" out of "stop-color".
        const propRe = new RegExp(
          `(?:^|[;\\s{])${prop}\\s*:`,
          "m",
        );
        expect(
          propRe.test(body),
          `.UnicDB-btn:hover:not(:disabled) must NOT declare layout-triggering property "${prop}"; body was: ${body.trim()}`,
        ).toBe(false);
      }
      // The hover block must STILL declare background-color (the visual
      // hover swap).
      expect(
        /background-color\s*:/.test(body),
        ".UnicDB-btn:hover:not(:disabled) must still declare background-color",
      ).toBe(true);
    },
  );

  // TASK-RES-003 regression — every toolbar button still carries the same
  // text in both `data-tooltip` and `aria-label` (the only tooltip surface
  // is now the custom pseudo-element + the a11y label).
  itIfBundle(
    "6. every toolbar button still carries data-tooltip === aria-label (no native title drift)",
    () => {
      const { root } = loadBundle();
      dispatchState(selectState());
      const btns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
      ).filter(
        (el): el is HTMLButtonElement => el.tagName === "BUTTON",
      ) as HTMLButtonElement[];
      expect(btns.length).toBeGreaterThan(0);
      for (const b of btns) {
        expect(b.getAttribute("data-tooltip")).toBe(b.getAttribute("aria-label"));
        expect(b.getAttribute("data-tooltip")?.length ?? 0).toBeGreaterThan(0);
      }
    },
  );
});