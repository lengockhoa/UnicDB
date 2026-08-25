// src/ui/__tests__/webviewPerTableTabs.test.ts
//
// TASK-007 — per-table result tabs (webview side).
//
// Bundle-eval tests (jsdom + dist/webview.js via `npm run compile`) for
// `rebuildTabs()` label rendering: tab title comes from `r.label`
// (schema-tree browse → "schema.table"), falls back to "Statement N" when
// the label is absent/empty, truncates at 40 chars + "...", and never
// parses label text as HTML (textContent assignment only).
//
//   1. tab shows label when r.label is set
//   2. tab falls back to "Statement N" when no label
//   3. long label truncated at 40 chars with ellipsis
//   4. multiple tables open separate tabs (+ tab switching still works)
//   5. empty label string falls back to Statement N
//   6. label with special characters renders correctly (no XSS)
//
// Tests 2 and 5 guard the pre-existing fallback and pass both before and
// after the change; 1, 3, 4, 6 are the RED drivers.
//
// If dist/webview.js is missing, all tests here are skipped.
// @vitest-environment jsdom
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

interface VsdbApi {
  postMessage: (msg: unknown) => void;
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

function loadBundle(): { received: Array<Record<string, unknown>>; root: HTMLDivElement } {
  if (!bundleSrc) {
    throw new Error("dist/webview.js missing — run `npm run compile` before this test");
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

function dispatchMsg(msg: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

/** Build one done SELECT StatementResult. `label` omitted when undefined. */
function selectResult(
  index: number,
  label: string | undefined,
  table: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    index,
    sql: `SELECT * FROM ${table}`,
    status: "done",
    result: {
      columns: ["id", "name"],
      rows: [
        [index + 1, `row-${index}`],
      ],
      rowCount: 1,
      durationMs: 1,
    },
    durationMs: 1,
  };
  if (label !== undefined) base.label = label;
  return base;
}

function state(results: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: "state", header: "Browse public.users at 2026-01-01T00:00:00Z", busy: false, results };
}

/** Statement tab #i (index 0-based; the trailing Messages tab is NOT one). */
function statementTab(i: number): HTMLButtonElement {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".vsdb-tabs .vsdb-tab");
  // Statement tabs are rendered first; the last .vsdb-tab is Messages.
  const stmtTabs = Array.from(tabs).slice(0, tabs.length - 1);
  return stmtTabs[i];
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

const itIfBundle = it.runIf(bundleSrc !== null);
const describeIfBundle = describe.runIf(bundleSrc !== null);

describeIfBundle("webview/main.ts bundle — TASK-007 per-table tab labels", () => {
  itIfBundle("1. tab shows label when r.label is set", async () => {
    loadBundle();
    dispatchMsg(state([selectResult(0, "public.users", "users")]));
    await flush();

    const tab = statementTab(0);
    expect(tab).toBeTruthy();
    // Tab button text matches the label (badge may trail it).
    expect(tab.textContent!.startsWith("public.users")).toBe(true);
    expect(tab.textContent).toContain("public.users");
  });

  itIfBundle("2. tab falls back to \"Statement N\" when no label", async () => {
    loadBundle();
    dispatchMsg(state([selectResult(0, undefined, "users")]));
    await flush();

    const tab = statementTab(0);
    expect(tab.textContent!.startsWith("Statement 1")).toBe(true);
  });

  itIfBundle("3. long label truncated at 40 chars with ellipsis", async () => {
    loadBundle();
    const longLabel = "public." + "x".repeat(43); // 50 chars
    expect(longLabel.length).toBe(50);
    dispatchMsg(state([selectResult(0, longLabel, "users")]));
    await flush();

    const tab = statementTab(0);
    const expected = longLabel.slice(0, 40) + "..."; // 40 chars + "..."
    expect(expected.length).toBe(43);
    expect(tab.textContent!.startsWith(expected)).toBe(true);
    // Full 50-char label never rendered.
    expect(tab.textContent).not.toContain(longLabel);
  });

  itIfBundle("4. multiple tables open separate tabs (+ switching works)", async () => {
    loadBundle();
    dispatchMsg(
      state([
        selectResult(0, "public.users", "users"),
        selectResult(1, "sales.orders", "orders"),
      ]),
    );
    await flush();

    const tabs = document.querySelectorAll<HTMLButtonElement>(".vsdb-tabs .vsdb-tab");
    // Two statement tabs + Messages tab.
    expect(tabs.length).toBe(3);

    const t0 = statementTab(0);
    const t1 = statementTab(1);
    expect(t0.textContent!.startsWith("public.users")).toBe(true);
    expect(t1.textContent!.startsWith("sales.orders")).toBe(true);

    // Tab switching still works with labeled tabs: click tab 2 → it becomes
    // active, tab 1 loses the active class. NOTE: rebuildTabs() recreates the
    // buttons on every render, so re-query AFTER the click — the pre-click
    // t0/t1 references are detached nodes by then.
    expect(t0.classList.contains("vsdb-tab-active")).toBe(true);
    expect(t1.classList.contains("vsdb-tab-active")).toBe(false);
    t1.click();
    await flush();
    const t0After = statementTab(0);
    const t1After = statementTab(1);
    expect(t1After.classList.contains("vsdb-tab-active")).toBe(true);
    expect(t0After.classList.contains("vsdb-tab-active")).toBe(false);
    // Labeled text survived the switch re-render.
    expect(t1After.textContent!.startsWith("sales.orders")).toBe(true);
    expect(t0After.textContent!.startsWith("public.users")).toBe(true);
  });

  itIfBundle("5. empty label string falls back to Statement N", async () => {
    loadBundle();
    dispatchMsg(state([selectResult(0, "", "users")]));
    await flush();

    const tab = statementTab(0);
    expect(tab.textContent!.startsWith("Statement 1")).toBe(true);
  });

  itIfBundle("6. label with special characters renders correctly (no XSS)", async () => {
    loadBundle();
    const evil = "<script>alert(1)</script>";
    dispatchMsg(state([selectResult(0, evil, "users")]));
    await flush();

    const tab = statementTab(0);
    // The label renders as literal TEXT (escaped), never parsed as markup.
    expect(tab.textContent).toContain(evil);
    expect(tab.querySelector("script")).toBeNull();
    // Nothing anywhere in the document became a live script element.
    expect(document.body.querySelectorAll("script").length).toBe(0);
  });
});
