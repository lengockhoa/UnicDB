// src/ui/__tests__/webviewToolbar.test.ts
// TASK-603 — bundle-eval integration test for the icon toolbar + 2-row
// layout + requery-bar iconification.
//
// Loads dist/webview.js (built via `npm run compile`) into jsdom, stubs
// acquireVsCodeApi + ResizeObserver + matchMedia, then dispatches a state
// message and asserts:
//   1. Every toolbar `.UnicDB-btn` renders an inline SVG icon with
//      `stroke="currentColor"`, an empty text body, a non-empty `title`,
//      and a non-empty `aria-label` (presentation only — handlers intact).
//   2. The toolbar is split into exactly 2 `.UnicDB-toolbar-row` rows
//      (TASK-COLLAPSE-002 — split results toolbar into 2 rows, WHERE first
//      on row 2, Search last). Row 1 ends with `.UnicDB-export-format`,
//      row 2 starts at WHERE.
//   3. styles.css pins the toolbar to a column with two `.UnicDB-toolbar-row`
//      wrappers (each `flex-wrap: nowrap` + `overflow: hidden`) so a third
//      row can never appear (TASK-COLLAPSE-002 — 2-row column contract).
//   4. Requery-bar `Re-Run` and `Clear` buttons are iconified; clicking
//      them still posts the right messages / empties the inputs.
//
// Mirrors the bundle pattern from src/ui/__tests__/webviewExport.test.ts.
// If dist/webview.js is missing, all tests are skipped — `npm run compile`
// must run first.
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
const stylesPath = resolve(process.cwd(), "webview", "styles.css");
const stylesSrc = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : null;

interface UnicDBApi {
  postMessage: (msg: unknown) => void;
}

interface UnicDBDebugSurface {
  simulateCellEdit?: (
    rowId: number,
    colField: string,
    newValue: unknown,
    oldValue: unknown,
  ) => void;
}

function UnicDBSimulateCellEdit(): UnicDBDebugSurface["simulateCellEdit"] | undefined {
  if (typeof window === "undefined") return undefined;
  const g = (window as unknown as { __UnicDB?: UnicDBDebugSurface }).__UnicDB;
  return g?.simulateCellEdit;
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

/** Read a button by its toolbar class, fail fast if missing. */
function button(
  root: HTMLElement,
  cls: string,
): HTMLButtonElement {
  const el = root.querySelector(
    `.UnicDB-toolbar .${cls}`,
  ) as HTMLButtonElement | null;
  if (!el) {
    throw new Error(`toolbar button .${cls} not found`);
  }
  return el;
}


/** Dispatch a bubbling click on a button. Bypasses the `disabled` flag so
 *  the test exercises the handler-attachment contract (presentation only,
 *  no behavior change) independently of the button's enabled state. */
function clickButton(b: HTMLButtonElement): void {
  b.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}


// Toolbar row children we expect to find in order. Used to assert
// query│edit│export grouping on row 1 and WHERE-first/Search-last on
// row 2 (TASK-COLLAPSE-002 — "Chia đôi cho tôi menu này. Từ Where là
// đưa xuống dòng dưới. TÔi cần 2 dòng"). The toolbar is a column of
// two `.UnicDB-toolbar-row` wrappers; each row is a nowrap flex line.
// Row 1 owns the icon buttons + `.UnicDB-export-format` <select>. Row 2
// owns the WHERE / ORDER BY inputs, Re-Run + Clear icon buttons, the
// header checkbox, Copy, Export-to-file, the schema chip, and the Search
// input as the LAST child. The toolbar `.UnicDB-btn` census is 12
// (descendant selector crosses row wrappers). The full row order pins
// live in the resolvers below.
const EXPECTED_ORDER_ROW1 = [
  "UnicDB-btn-danger", // Cancel (query group)
  "UnicDB-btn", // Refresh (query)
  "UnicDB-toolbar-sep", // query│edit divider
  "UnicDB-btn", // Add Row
  "UnicDB-btn", // Delete Row
  "UnicDB-btn", // Undo
  "UnicDB-btn", // Redo
  "UnicDB-commit", // Commit
  "UnicDB-btn", // CSV toggle
  "UnicDB-toolbar-sep", // edit│export divider
  "UnicDB-export-format", // row 1 ends here
];

const EXPECTED_ORDER_ROW2 = [
  "UnicDB-requery-where", // TASK-COLLAPSE-002: WHERE first on row 2 (split starts here)
  "UnicDB-requery-order",
  "UnicDB-btn", // TASK-RES-001: Re-Run icon button (toolbar slot)
  "UnicDB-btn", // TASK-RES-001: Clear icon button (toolbar slot)
  "UnicDB-export-header",
  "UnicDB-export-copy",
  "UnicDB-export-file",
  "UnicDB-schema-chip", // ACTIVE-SCHEMA chip (row 2)
  "UnicDB-search-input", // row 2 ends here (last child)
];

// ---- tests ----------------------------------------------------------------

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts icon toolbar + 2-row layout (TASK-603 / TASK-COLLAPSE-002)", () => {
  itIfBundle(
    "1. every toolbar .UnicDB-btn has an inline svg icon, currentColor stroke, non-empty aria-label, empty text",
    () => {
      const { root } = loadBundle();
      dispatchState(threeRowsState());
      const btns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
      ).filter(
        (el): el is HTMLButtonElement => el.tagName === "BUTTON",
      ) as HTMLButtonElement[];
      // TASK-RES-001: Re-Run + Clear icon buttons joined the toolbar row,
      // so the toolbar icon-button census rises from 10 to 12. Every
      // button keeps the svg / currentColor / title / aria-label /
      // empty-text contract that makeIconButton delivers.
      expect(btns.length).toBe(12);

      for (const b of btns) {
        const svg = b.querySelector("svg");
        expect(svg, `button .${b.className} missing <svg>`).toBeTruthy();
        // currentColor for stroke or fill (Export-to-file uses fill on rect).
        const stroke = svg!.getAttribute("stroke");
        const fill = svg!.getAttribute("fill");
        const usesCurrent =
          (stroke !== null && stroke.includes("currentColor")) ||
          (fill !== null && fill.includes("currentColor"));
        expect(usesCurrent, `button .${b.className} svg lacks currentColor`).toBe(true);
        expect(
          b.textContent?.trim(),
          `button .${b.className} must have no visible text`,
        ).toBe("");
        // TASK-RES-003 REWRITTEN: the `+ title` clause was dropped because
        // wave-2 deletes btn.title from makeIconButton — the native
        // tooltip is replaced by the instant data-tooltip pseudo (see the
        // new TASK-RES-003 describe block below). The svg + currentColor +
        // aria-label + empty-text pins remain.
        expect(
          b.getAttribute("aria-label"),
          `button .${b.className} missing aria-label`,
        ).not.toBe("");
        // viewBox must be 0 0 16 16 (icon-only sizing).
        expect(svg!.getAttribute("viewBox")).toBe("0 0 16 16");
        // svg must be aria-hidden so screen readers fall back to title/aria-label.
        expect(svg!.getAttribute("aria-hidden")).toBe("true");
      }
    },
  );

  itIfBundle(
    "2. icon buttons still post the right messages (Cancel, Commit, Copy, Export to file, CSV toggle)",
    async () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());
      await new Promise<void>((r) => setTimeout(r, 0));

      // Cancel — should post {type:'cancel'}.
      clickButton(button(root, "UnicDB-btn-danger"));
      expect(received.some((m) => m.type === "cancel")).toBe(true);
      received.length = 0;

      // CSV toggle — flips the formatter locally (no message posted).
      const allBtns = Array.from(
        root.querySelectorAll(".UnicDB-toolbar .UnicDB-btn"),
      ).filter((el): el is HTMLButtonElement => el.tagName === "BUTTON");
      const csv = allBtns.find((b) =>
        (b.title || b.getAttribute("aria-label") || "").toLowerCase().includes("csv"),
      );
      expect(csv, "CSV toggle button not found").toBeTruthy();
      clickButton(csv!);
      // The CSV toggle does not post a message; it flips the formatter
      // locally. Click must at minimum not throw and leave the button in
      // the DOM.
      expect(csv!.isConnected).toBe(true);
      received.length = 0;

      // Commit — no dirty edits → no-op. With one dirty edit it posts a
      // saveEdits batch. We use the bundle's exposed simulateCellEdit
      // hook (same surface as webviewSaveEdits.test.ts).
      const sim = UnicDBSimulateCellEdit();
      expect(sim).toBeTruthy();
      sim!(0, "name", "x", "alpha");
      await new Promise<void>((r) => setTimeout(r, 0));
      clickButton(button(root, "UnicDB-commit"));
      await new Promise<void>((r) => setTimeout(r, 0));
      const saveMsgs = received.filter((m) => m.type === "saveEdits");
      expect(saveMsgs.length, "commit icon did not post saveEdits").toBe(1);
      received.length = 0;

      clickButton(button(root, "UnicDB-export-copy"));

      const copyMsgs = received.filter((m) => m.type === "copy");
      expect(copyMsgs.length, "copy icon did not post copy").toBe(1);
      clickButton(button(root, "UnicDB-export-file"));

      // Export to file.

      const expMsgs = received.filter((m) => m.type === "exportFile");
      expect(expMsgs.length, "export icon did not post exportFile").toBe(1);
    },
  );

  itIfBundle(
    "3. 2-row split: toolbar has exactly 2 .UnicDB-toolbar-row children; row1 ends at export-format, row2 starts at WHERE, ends at search",
    () => {
      const { root } = loadBundle();
      dispatchState(threeRowsState());

      const toolbar = root.querySelector(".UnicDB-toolbar") as HTMLDivElement;
      expect(toolbar).toBeTruthy();

      // TASK-COLLAPSE-002 — the toolbar is a column of EXACTLY 2 rows.
      const rows = Array.from(toolbar.children) as HTMLElement[];
      expect(rows.length, "toolbar must have exactly 2 .UnicDB-toolbar-row children").toBe(2);
      expect(rows[0]!.classList.contains("UnicDB-toolbar-row")).toBe(true);
      expect(rows[1]!.classList.contains("UnicDB-toolbar-row")).toBe(true);

      const row1 = rows[0]!;
      const row2 = rows[1]!;

      // Order: walk the children and assert the sequence of class
      // predicates. Buttons that share .UnicDB-btn are matched in the
      // expected position; the seq uses the predicate string.
      const walk = (children: HTMLElement[]): string[] =>
        children.map((c) => {
          if (c.classList.contains("UnicDB-btn-danger")) return "UnicDB-btn-danger";
          if (c.classList.contains("UnicDB-commit")) return "UnicDB-commit";
          if (c.classList.contains("UnicDB-export-format")) return "UnicDB-export-format";
          if (c.classList.contains("UnicDB-requery-where")) return "UnicDB-requery-where";
          if (c.classList.contains("UnicDB-requery-order")) return "UnicDB-requery-order";
          if (c.classList.contains("UnicDB-export-header")) return "UnicDB-export-header";
          if (c.classList.contains("UnicDB-export-copy")) return "UnicDB-export-copy";
          if (c.classList.contains("UnicDB-export-file")) return "UnicDB-export-file";
          if (c.classList.contains("UnicDB-schema-chip")) return "UnicDB-schema-chip";
          if (c.classList.contains("UnicDB-search-input")) return "UnicDB-search-input";
          if (c.classList.contains("UnicDB-toolbar-sep")) return "UnicDB-toolbar-sep";
          if (c.classList.contains("UnicDB-btn")) return "UnicDB-btn";
          return c.className;
        });

      expect(walk(Array.from(row1.children) as HTMLElement[])).toEqual(EXPECTED_ORDER_ROW1);
      expect(walk(Array.from(row2.children) as HTMLElement[])).toEqual(EXPECTED_ORDER_ROW2);

      // Both seps live in ROW 1 (query│edit + edit│export dividers).
      const seps = (Array.from(row1.children) as HTMLElement[]).filter(
        (c) => c.classList.contains("UnicDB-toolbar-sep"),
      );
      expect(seps.length, "expected exactly 2 .UnicDB-toolbar-sep dividers, both in row 1").toBe(2);

      // Search is the LAST child of row 2.
      const last = row2.lastElementChild as HTMLElement | null;
      expect(
        last?.classList.contains("UnicDB-search-input"),
        "search input must be the last row-2 child",
      ).toBe(true);
    },
  );

  itIfBundle(
    "4. styles.css pins .UnicDB-toolbar to a 2-row column (TASK-COLLAPSE-002): flex-direction:column, row wrapper pins flex-wrap:nowrap, requery inputs use flex:1 1 100%",
    () => {
      if (!stylesSrc) {
        throw new Error("webview/styles.css missing");
      }
      // TASK-COLLAPSE-002 — the toolbar is a column of two nowrap rows,
      // so the BLOCK rule must declare `flex-direction: column` and must
      // NOT carry the old single-row `flex-wrap: nowrap`.
      const toolbarBlockRe = /\.UnicDB-toolbar\s*\{([^}]*)\}/;
      const toolbarBlock = toolbarBlockRe.exec(stylesSrc);
      expect(toolbarBlock, "could not locate .UnicDB-toolbar { ... } block").toBeTruthy();
      const toolbarBody = toolbarBlock![1]!;
      expect(
        /flex-direction\s*:\s*column/i.test(toolbarBody),
        `.UnicDB-toolbar { ... } must declare flex-direction:column; body was: ${toolbarBody.trim()}`,
      ).toBe(true);
      expect(
        /flex-wrap\s*:\s*nowrap/i.test(toolbarBody),
        `.UnicDB-toolbar { ... } must NOT carry flex-wrap:nowrap (TASK-COLLAPSE-002 splits into 2 rows); body was: ${toolbarBody.trim()}`,
      ).toBe(false);

      // Each row wrapper pins `flex-wrap: nowrap` + `overflow: hidden`
      // so a third row can never appear and narrow widths clip inside
      // the row instead of growing a scrollbar.
      const rowBlockRe = /\.UnicDB-toolbar-row\s*\{([^}]*)\}/;
      const rowBlock = rowBlockRe.exec(stylesSrc);
      expect(rowBlock, "could not locate .UnicDB-toolbar-row { ... } block").toBeTruthy();
      const rowBody = rowBlock![1]!;
      expect(
        /flex-wrap\s*:\s*nowrap/i.test(rowBody),
        `.UnicDB-toolbar-row { ... } must pin flex-wrap:nowrap; body was: ${rowBody.trim()}`,
      ).toBe(true);
      expect(
        /overflow\s*:\s*hidden/i.test(rowBody),
        `.UnicDB-toolbar-row { ... } must clip overflow:hidden; body was: ${rowBody.trim()}`,
      ).toBe(true);

      // The requery inputs now SHARE the leftover space inside the
      // nowrap row-2 wrapper with `flex: 1 1 100%` + `min-width: 0`
      // (the old px-based `flex: 1 1 140px` is the FORBIDDEN shape).
      const whereRe = /\.UnicDB-requery-input\.UnicDB-requery-where\s*\{[^}]*flex:\s*1\s+1\s+100\s*%/;
      const orderRe = /\.UnicDB-requery-input\.UnicDB-requery-order\s*\{[^}]*flex:\s*1\s+1\s+100\s*%/;
      expect(
        whereRe.test(stylesSrc),
        "styles.css must give .UnicDB-requery-where flex: 1 1 100% (TASK-COLLAPSE-002 row-2 sizing)",
      ).toBe(true);
      expect(
        orderRe.test(stylesSrc),
        "styles.css must give .UnicDB-requery-order flex: 1 1 100% (TASK-COLLAPSE-002 row-2 sizing)",
      ).toBe(true);
      const whereNoPx = /\.UnicDB-requery-input\.UnicDB-requery-where\s*\{[^}]*flex:\s*1\s+1\s+140px/;
      const orderNoPx = /\.UnicDB-requery-input\.UnicDB-requery-order\s*\{[^}]*flex:\s*1\s+1\s+140px/;
      expect(
        whereNoPx.test(stylesSrc),
        "styles.css must NOT use the old single-row flex: 1 1 140px on .UnicDB-requery-where",
      ).toBe(false);
      expect(
        orderNoPx.test(stylesSrc),
        "styles.css must NOT use the old single-row flex: 1 1 140px on .UnicDB-requery-order",
      ).toBe(false);

      // Buttons must size SVGs at 16×16 to keep the compact 24–26px height.
      expect(
        /\.UnicDB-btn[^}]*\.UnicDB-btn\s+svg|\.UnicDB-btn\s+svg/.test(stylesSrc),
        "styles.css must define a .UnicDB-btn svg sizing rule",
      ).toBe(true);
    },
  );

  itIfBundle(
    "5. requery-bar Re-Run + Clear are icon buttons; click posts {type:'requery', where, orderBy} and Clear empties inputs",
    () => {
      const { received, root } = loadBundle();
      dispatchState(threeRowsState());

      const runBtn = root.querySelector(
        ".UnicDB-requery-run",
      ) as HTMLButtonElement | null;
      const clearBtn = root.querySelector(
        ".UnicDB-requery-clear",
      ) as HTMLButtonElement | null;
      expect(runBtn).toBeTruthy();
      expect(clearBtn).toBeTruthy();

      // Iconified: empty text, has svg, has data-tooltip + aria-label (TASK-RES-003
// drops the native `title` attribute — the data-tooltip pseudo-tooltip is
// the only source).
      for (const b of [runBtn!, clearBtn!]) {
        expect(b.textContent?.trim()).toBe("");
        expect(b.querySelector("svg")).toBeTruthy();
        expect(b.getAttribute("data-tooltip")).not.toBeNull();
        expect(b.getAttribute("data-tooltip")).not.toBe("");
        expect(b.getAttribute("aria-label")).not.toBe("");
      }

      // Re-Run with values.
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
      clickButton(runBtn!);
      const requeryMsgs = received.filter((m) => m.type === "requery");
      expect(requeryMsgs).toHaveLength(1);
      expect(requeryMsgs[0]).toEqual({
        type: "requery",
        index: 0,
        where: "id > 1",
        orderBy: "id DESC",
      });

      // Clear empties both inputs.
      clickButton(clearBtn!);
      expect(whereInput!.value).toBe("");
      expect(orderInput!.value).toBe("");
    },
  );
});

// TASK-RES-003 — toolbar button hover transition. The instant
// background-color flash on .UnicDB-btn:hover must be eased with a short
// `transition` that touches ONLY composited/non-layout properties
// (background-color, box-shadow) — never `transition: all`, never a
// layout-triggering property (width/height/padding/margin/top/left/etc).
// The instant data-tooltip pseudo-element block stays untouched.
describeIfBundle(
  "webview/styles.css toolbar button hover transition (TASK-RES-003)",
  () => {
    itIfBundle(
      "3. .UnicDB-btn { ... } block carries a transition rule (no instant hover swap)",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The transition must live inside the .UnicDB-btn { ... } block.
        // We match the FIRST .UnicDB-btn block (the base one, lines 41-71)
        // and assert it contains `transition:`. Using non-greedy match on
        // the body prevents the regex from spanning across multiple blocks.
        const re = /\.UnicDB-btn\s*\{([^}]*)\}/;
        const m = re.exec(stylesSrc);
        expect(
          m,
          "could not locate .UnicDB-btn { ... } block in styles.css",
        ).toBeTruthy();
        const body = m![1];
        expect(
          /transition\s*:/i.test(body),
          `.UnicDB-btn { ... } must declare a transition; body was: ${body.trim()}`,
        ).toBe(true);
      },
    );

    itIfBundle(
      "4. the .UnicDB-btn transition lists ONLY background-color and/or box-shadow — no layout-triggering properties",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // Strip CSS comments first so the regex doesn't accidentally match
        // a literal "transition: all" inside a comment block.
        const cssNoComments = stylesSrc.replace(/\/\*[\s\S]*?\*\//g, "");
        const blockRe = /\.UnicDB-btn\s*\{([^}]*)\}/;
        const blockMatch = blockRe.exec(cssNoComments);
        expect(blockMatch).toBeTruthy();
        const body = blockMatch![1];
        // Find the `transition: <value>;` declaration.
        const trRe = /transition\s*:\s*([^;]+);/i;
        const trMatch = trRe.exec(body);
        expect(
          trMatch,
          `.UnicDB-btn { ... } must declare a transition; body was: ${body.trim()}`,
        ).toBeTruthy();
        const value = trMatch![1].trim();
        // The plan FORBIDS `transition: all` — it would re-introduce
        // layout jitter on width/height/padding etc. The accepted shape is
        // exactly: `background-color <time> <ease>[, box-shadow <time> <ease>]`.
        expect(
          /\ball\b/i.test(value),
          `transition must not be 'all'; value was: ${value}`,
        ).toBe(false);
        // Layout-triggering properties are forbidden in the transition
        // value. Word-boundary checks so "top" does not match "stop-color".
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
          "font-size",
          "line-height",
          "transform",
        ];
        for (const prop of forbidden) {
          const propRe = new RegExp(`(?:^|[,\\s])${prop}\\b`, "i");
          expect(
            propRe.test(value),
            `transition value must not list layout-triggering property "${prop}"; value was: ${value}`,
          ).toBe(false);
        }
        // The accepted properties are background-color and/or box-shadow.
        const allowedRe = /^(?:background-color|box-shadow)(\s+\S+(\s+\S+)?)?(\s*,\s*(background-color|box-shadow)(\s+\S+(\s+\S+)?)?)*$/i;
        expect(
          allowedRe.test(value),
          `transition value must list ONLY background-color and/or box-shadow; value was: ${value}`,
        ).toBe(true);
      },
    );

    itIfBundle(
      "5. .UnicDB-btn[data-tooltip] pseudo keeps z-index: 1000 (so the tooltip floats above the toolbar)",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The data-tooltip block MUST keep z-index: 1000. We match the
        // whole block (lines 78-115) to confirm it's structurally intact.
        const re = /\.UnicDB-btn\[data-tooltip\][^{]*\{[^}]*z-index\s*:\s*1000/;
        expect(
          re.test(stylesSrc),
          "styles.css must keep z-index: 1000 on the data-tooltip block",
        ).toBe(true);
      },
    );

    itIfBundle(
      "7. .UnicDB-btn[data-tooltip]:not(:disabled):hover::after still defines the instant tooltip pseudo-element",
      () => {
        if (!stylesSrc) {
          throw new Error("webview/styles.css missing");
        }
        // The pseudo-element block is regex-pinned: same selector AND it
        // must contain `content: attr(data-tooltip)`. TASK-RES-003 must
        // NOT touch this block.
        const selRe =
          /\.UnicDB-btn\[data-tooltip\]:not\(:disabled\):hover::after\s*\{([^}]*)\}/;
        const m = selRe.exec(stylesSrc);
        expect(
          m,
          "could not locate .UnicDB-btn[data-tooltip]:not(:disabled):hover::after block",
        ).toBeTruthy();
        const body = m![1];
        expect(
          /content\s*:\s*attr\(\s*data-tooltip\s*\)/.test(body),
          `pseudo-element block must contain 'content: attr(data-tooltip)'; body was: ${body.trim()}`,
        ).toBe(true);
      },
    );
  },
);
