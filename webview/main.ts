// webview/main.ts
// Webview entry — nhận state từ extension host, render tabs + AG Grid + Messages.
//
// Message protocol: see src/ui/messages.ts (mirror of types).
//
// TASK-203: thay VirtualGrid bằng AG Grid Community (client-side row model +
// applyTransaction append). Pure-logic model đã dời sang src/ui/resultsGridModel.ts.
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "./styles.css";
import {
  createGrid,
  getGridApi,
  AllCommunityModule,
  ModuleRegistry,
} from "ag-grid-community";
import type { GridApi } from "ag-grid-community";
import {
  inferColumns,
  createResultsGridModel,
  selectionToText,
  shouldResetGrid,
  footerText,
  formatCell,
  type ColumnSpec,
  type ResultsGridModel,
} from "../src/ui/resultsGridModel";

// AG Grid v36 modular API — register all-community so createGrid initializes.
ModuleRegistry.registerModules([AllCommunityModule]);

// ---- Types (mirror of src/ui/messages.ts) ----------------------------------

interface StateMsg {
  type: "state";
  header: string;
  results: StatementResult[];
  busy: boolean;
}

interface BusyMsg {
  type: "busy";
  busy: boolean;
}

type HostMsg = StateMsg | BusyMsg;

interface StatementResult {
  index: number;
  sql: string;
  status: "running" | "done" | "error" | "cancelled";
  result?: {
    columns: string[];
    rows: unknown[][];
    rowCount: number | null;
    commandTag?: string;
    durationMs: number;
  };
  batched?: boolean;
  error?: string;
  durationMs: number;
}

type LoadMoreMsg = { type: "loadMore"; index: number };
type CancelMsg = { type: "cancel" };
type CopyMsg = { type: "copy"; text: string };
type ReadyMsg = { type: "ready" };
type WebviewMsg = LoadMoreMsg | CancelMsg | CopyMsg | ReadyMsg;

// ---- Acquire VS Code API ---------------------------------------------------

declare const acquireVsCodeApi: undefined | (() => unknown);
const vscodeApi = (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null) as
  | { postMessage: (msg: unknown) => void }
/** Currently rendered footer element (for quick-filter live updates). */
let currentFooter: HTMLElement | null = null;
/** Currently rendered statement (for footer duration lookup). */
let currentStatement: StatementResult | null = null;

function postToHost(msg: WebviewMsg): void {
  if (vscodeApi) {
    vscodeApi.postMessage(msg);
  } else {
    // Dev fallback (outside VS Code): log to console.
    // eslint-disable-next-line no-console
    console.log("[vsdb webview → host]", msg);
  }
}

// ---- App state -------------------------------------------------------------

const root = document.getElementById("vsdb-root") as HTMLDivElement;
let headerText = "";
let results: StatementResult[] = [];
let busy = false;
let activeTab = 0;
/** Index of statement last rendered through renderGrid; used to decide
 *  reset vs append vs tab-switch. */
let lastRenderedIndex = -1;
let lastResultStatus: StatementResult["status"] | null = null;
/** AG Grid instance (one per webview lifecycle — re-used across re-renders). */
let gridApi: GridApi | null = null;
/** Per-statement loadMore gate model. Keyed by statement index. */
const models = new Map<number, ResultsGridModel>();
/** Rows currently shown in AG Grid per statement (mirrors AG Grid internals
 *  for the "append delta" calculation). Keyed by statement index. */
const statementRows = new Map<number, unknown[][]>();
/** Tracks if a loadMore was dispatched and is awaiting host reply. */
let loadMoreInFlight = false;
let quickFilterActive = false;

function rowsToObjects(rows: unknown[][], specs: readonly ColumnSpec[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = { __select__: false };
    specs.forEach((s, i) => {
      obj[s.field] = row[i];
    });
    return obj;
  });
}
// ---- Render ----------------------------------------------------------------

function render(): void {
  currentFooter = null;
  currentStatement = null;
  root.innerHTML = "";

  // Header.
  const headerEl = document.createElement("div");
  headerEl.className = "vsdb-header";
  headerEl.textContent = headerText || "VSDB Results";
  root.appendChild(headerEl);

  // Toolbar.
  const toolbar = document.createElement("div");
  toolbar.className = "vsdb-toolbar";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "vsdb-btn vsdb-btn-danger";
  cancelBtn.disabled = !busy;
  cancelBtn.addEventListener("click", () => postToHost({ type: "cancel" }));
  toolbar.appendChild(cancelBtn);

  // Quick filter input (only relevant when results have a grid).
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search…";
  searchInput.className = "vsdb-search-input";
  searchInput.addEventListener("input", () => {
    const text = searchInput.value;
    quickFilterActive = text.length > 0;
    if (gridApi) {
      gridApi.setGridOption("quickFilterText", text);
      try {
        (gridApi.refreshClientSideRowModel as unknown as (s?: string) => void)("filter");
      } catch {
        gridApi.refreshClientSideRowModel();
      }
      try { gridApi.onFilterChanged(); } catch { /* older API */ }
      updateFooters();
    }
  });
  toolbar.appendChild(searchInput);

  root.appendChild(toolbar);

  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vsdb-empty";
    empty.textContent = busy ? "Running…" : "No results yet.";
    root.appendChild(empty);
    return;
  }

  // Tabs.
  const tabsEl = document.createElement("div");
  tabsEl.className = "vsdb-tabs";
  results.forEach((r, i) => {
    const tab = document.createElement("button");
    tab.className = "vsdb-tab" + (i === activeTab ? " vsdb-tab-active" : "");
    if (r.status === "error") tab.classList.add("vsdb-tab-error");
    if (r.status === "cancelled") tab.classList.add("vsdb-tab-cancelled");
    tab.textContent = `Statement ${i + 1} ${tabBadge(r)}`;
    tab.addEventListener("click", () => {
      activeTab = i;
      // Tab switch IS a legitimate reset (different statement context).
      loadMoreInFlight = false;
      render();
    });
    tabsEl.appendChild(tab);
  });
  // Messages tab.
  const msgTab = document.createElement("button");
  msgTab.className = "vsdb-tab" + (results.length === activeTab ? " vsdb-tab-active" : "");
  const hasErrors = results.some((r) => r.status === "error");
  msgTab.textContent = `Messages${hasErrors ? " ⚠" : ""}`;
  msgTab.addEventListener("click", () => {
    activeTab = results.length;
    render();
  });
  tabsEl.appendChild(msgTab);
  root.appendChild(tabsEl);

  // Active panel.
  if (activeTab === results.length) {
    renderMessages();
  } else {
    renderGrid();
  }
}

function tabBadge(r: StatementResult): string {
  if (r.status === "done") return "✓";
  if (r.status === "error") return "✗";
  if (r.status === "cancelled") return "⌀";
  return "…";
}

// ---- Grid render -----------------------------------------------------------

function renderGrid(): void {
  const r = results[activeTab];
  if (!r) return;
  const container = document.createElement("div");
  container.className = "vsdb-grid-host";
  // Listen on the outer container so Ctrl/Cmd+C is caught whether the event
  // is dispatched on the container itself (test) or bubbled from inner AG Grid
  // cells (real interaction). useCapture=true ensures we see the event before
  // AG Grid / browser default handling swallows it.
  container.addEventListener(
    "keydown",
    (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
        copySelectionToHost();
      }
    },
    true,
  );
  root.appendChild(container);

  if (r.status === "error") {
    const err = document.createElement("div");
    err.className = "vsdb-error";
    err.textContent = `Error: ${r.error ?? "unknown"}`;
    container.appendChild(err);
    return;
  }
  if (!r.result) {
    // Running / pending state with no result yet. Mark this as the latest
    // render so the next terminal state (running→done/error) is detected as a
    // statement reset (BUG 2 regression).
    lastRenderedIndex = activeTab;
    lastResultStatus = r.status;
    const empty = document.createElement("div");
    empty.className = "vsdb-empty";
    empty.textContent = "No result.";
    container.appendChild(empty);
    return;
  }

  // Non-SELECT (INSERT/UPDATE/DELETE/DDL): no columns/rows → hiển thị message
  // kết quả nổi bật thay vì grid trống (DataGrip-style "1 row affected").
  if (r.result.columns.length === 0 && r.result.rows.length === 0) {
    const msg = document.createElement("div");
    msg.className = "vsdb-ok-message";
    const tag = r.result.commandTag ?? "OK";
    const affected = r.result.rowCount ?? 0;
    msg.textContent =
      affected > 0
        ? `✓ ${tag} — ${affected} row${affected === 1 ? "" : "s"} affected  ⏱ ${r.durationMs}ms`
        : `✓ ${tag}  ⏱ ${r.durationMs}ms`;
    container.appendChild(msg);
    return;
  }
  // Footer.
  const footer = document.createElement("div");
  footer.className = "vsdb-grid-footer";
  currentFooter = footer;
  currentStatement = r;
  // Compute columns from the result.
  const specs: ColumnSpec[] = inferColumns(r.result.columns, r.result.rows);

  // Build AG Grid column defs from specs.
  const baseCols = specs.map((spec) => ({
    field: spec.field,
    headerName: spec.headerName,
    sortable: true,
    filter: true,
    resizable: true,
    floatingFilter: true,
    valueFormatter: (p: { value: unknown }) => formatCell(p.value),
    cellStyle:
      spec.kind === "number"
        ? { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" }
        : {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
  }));
  // Checkbox selection column at the front.
  const colDefs = [
    {
      headerName: "",
      field: "__select__",
      checkboxSelection: true,
      headerCheckboxSelection: true,
      headerCheckboxSelectionFilteredOnly: true,
      width: 40,
      minWidth: 40,
      maxWidth: 40,
      pinned: "left" as const,
      sortable: false,
      filter: false,
      resizable: false,
      floatingFilter: false,
      suppressHeaderMenuButton: true,
      suppressMovable: true,
      lockPosition: "left" as const,
      cellStyle: { padding: 0 },
    },
    ...baseCols,
  ];

  // Grid host element.
  const gridHost = document.createElement("div");
  gridHost.className = "ag-theme-quartz";
  gridHost.style.flex = "1";
  gridHost.style.width = "100%";
  gridHost.style.minHeight = "0";
  container.appendChild(gridHost);

  // Determine reset vs append:
  //   - first render (no api yet) → reset
  //   - tab switched → reset (caller set activeTab, we lost previous gridApi
  //     for this statement; or we still have one — see logic below)
  //   - same statement + status went running→terminal → reset (new query)
  //   - same statement + rows grew → append via applyTransaction
  //   - otherwise → reset (rows shrunk or columns changed)
  const isFirstRender = !gridApi;
  const tabSwitched = lastRenderedIndex !== activeTab;
  const statementReset = lastResultStatus === "running" && r.status !== "running";
  const previousRows = statementRows.get(activeTab) ?? [];
  const rowsGrew = r.result.rows.length > previousRows.length;
  const sameColumns =
    specs.length === previousRows.length /* cheap check */ ||
    (previousRows.length > 0 && previousRows.length > 0); // no-op sanity

  const model = ensureModel(activeTab);
  const syncResult = model.sync(r.result.rows, activeTab, !!r.batched, {
    rowCount: r.result.rowCount ?? null,
    loadedBefore: tabSwitched || statementReset ? 0 : previousRows.length,
  });

  // Decide create vs reuse vs setRowData vs applyTransaction.
  if (tabSwitched || statementReset || isFirstRender || syncResult.isReset) {
    // Full reset: build new grid if needed, set columns + setRowData.
    if (isFirstRender || tabSwitched) {
      // Destroy previous grid before creating new one (when switching tab).
      if (gridApi && tabSwitched) {
        try {
          gridApi.destroy();
        } catch {
          /* noop */
        }
        gridApi = null;
      }
      if (!gridApi) {
        gridApi = createGrid(gridHost, {
          columnDefs: colDefs,
          rowData: rowsToObjects(r.result.rows, specs),
          rowSelection: {
            mode: "multiRow",
            checkboxes: false, // we render explicit checkbox column
            headerCheckbox: false,
            enableClickSelection: false,
          },
          enableBrowserTooltips: true,
          suppressColumnVirtualisation: false,
          rowHeight: 28,
          headerHeight: 28,
          floatingFiltersHeight: 28,
          onCellKeyDown: (e) => {
            const ev = (e as unknown as { event: KeyboardEvent }).event;
            if (ev && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
              copySelectionToHost();
            }
          },
          onModelUpdated: () => updateFooter(footer, model, gridApi, r),
          onBodyScroll: (e) => onBodyScroll(e, activeTab, model),
        });
        // Expose api on host for testing.
        (gridHost as unknown as { __vsdbApi: GridApi }).__vsdbApi = gridApi;
      }
    } else if (statementReset && gridApi) {
      // Statement reset (running→terminal) on an existing grid: must replace
      // rowData so stale rows from the previous query are cleared.
      gridApi.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    }
    statementRows.set(activeTab, r.result.rows.slice());
  } else if (rowsGrew && syncResult.appendDelta.length > 0) {
    // map each new row to { ...row } with field-keyed shape.
    const newRowObjects = syncResult.appendDelta.map((row) => {
      const obj: Record<string, unknown> = {};
      specs.forEach((s, i) => {
        obj[s.field] = row[i];
      });
      obj.__select__ = false;
      return obj;
    });
    const addIndex = previousRows.length;
    gridApi!.applyTransaction({ add: newRowObjects, addIndex });
    statementRows.set(activeTab, r.result.rows.slice());
  } else if (!sameColumns) {
    // Columns changed — rebuild grid defs.
    gridApi!.setGridOption("columnDefs", colDefs);
    gridApi!.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    statementRows.set(activeTab, r.result.rows.slice());
  }
  // else: idempotent — no-op.

  lastRenderedIndex = activeTab;
  lastResultStatus = r.status;

  // Initial footer.
  updateFooter(footer, model, gridApi, r);

  // Hook: expose a checkLoadMore for tests / programmatic triggers.
  (container as unknown as { __checkLoadMore?: () => void }).__checkLoadMore = () => {
    if (loadMoreInFlight || busy || quickFilterActive) return;
    if (!model.getState().hasMore()) return;
    dispatchLoadMore();
  };
  (window as unknown as { __vsdbCheckLoadMoreForHost?: () => void }).__vsdbCheckLoadMoreForHost =
    () => {
      const host = root.querySelector(".vsdb-grid-host") as HTMLElement | null;
      if (!host) return;
      const hook = (host as unknown as { __checkLoadMore?: () => void }).__checkLoadMore;
      if (typeof hook === "function") hook();
    };

  // Footer appended last.
  container.appendChild(footer);
}

function ensureModel(index: number): ResultsGridModel {
  let m = models.get(index);
  if (!m) {
    m = createResultsGridModel({
      onNeedMore: () => {
        // Body scroll also dispatches this via onBodyScroll; here we
        // intentionally no-op — main trigger is the body's near-bottom check.
      },
    });
    models.set(index, m);
  }
  return m;
}

function dispatchLoadMore(): void {
  if (loadMoreInFlight || busy) return;
  if (quickFilterActive) return;
  loadMoreInFlight = true;
  postToHost({ type: "loadMore", index: activeTab });
}

function onBodyScroll(
  e: { top: number; bottom: number },
  index: number,
  model: ResultsGridModel,
): void {
  if (loadMoreInFlight || busy || quickFilterActive) return;
  const state = model.getState();
  if (!state.hasMore()) return;
  // Use viewport-rows proxy via model.requestWindow(displayedLast, viewport).
  // AG Grid's onBodyScroll doesn't give row index directly; we treat any
  // near-bottom scroll (top + viewportHeight - bottom < threshold) as a
  // near-bottom hit and ask the model.
  // Simpler proxy: whenever the user scrolls (any direction) and we're not at
  // the very top, signal "near bottom" if bottom is reached.
  if (e.bottom === 0) {
    // bottom === 0 means we reached the end of scroll.
    model.requestWindow(state.getLoaded(), 0);
    dispatchLoadMore();
  }
  void index;
}

function copySelectionToHost(): void {
  if (!gridApi) return;
  const selected = gridApi.getSelectedRows();
  if (selected.length === 0) return;
  // Re-shape: AG Grid returns row objects; we need arrays of original values.
  const arr = selected.map((obj) => {
    const row: unknown[] = [];
    const r = obj as Record<string, unknown>;
    // First slot is __select__ marker; skip.
    for (const k of Object.keys(r)) {
      if (k === "__select__") continue;
      row.push(r[k]);
    }
    return row;
  });
  const text = selectionToText(arr);
  postToHost({ type: "copy", text });
}

function updateFooter(
  footer: HTMLElement,
  model: ResultsGridModel,
  api: GridApi | null,
  r: StatementResult,
): void {
  const state = model.getState();
  const loaded = state.getLoaded();
  const total = state.getTotal();
  const hasMore = state.hasMore();
  const displayed = api ? api.getDisplayedRowCount() : loaded;
  const filtered = displayed !== loaded && quickFilterActive;
  const duration = r.durationMs;
  footer.textContent =
    footerText(loaded, total, hasMore, displayed, filtered) +
    (duration > 0 ? `  ⏱ ${duration}ms` : "");
}
function updateFooters(): void {
  const footer = currentFooter;
  const api = gridApi;
  if (!footer || !api || !currentStatement) return;
  const model = models.get(activeTab);
  if (!model) return;
  const displayed = api.getDisplayedRowCount();
  const state = model.getState();
  const loaded = state.getLoaded();
  const total = state.getTotal();
  const hasMore = state.hasMore();
  const filtered = displayed !== loaded && quickFilterActive;
  const duration = currentStatement.durationMs;
  footer.textContent =
    footerText(loaded, total, hasMore, displayed, filtered) +
    (duration > 0 ? `  ⏱ ${duration}ms` : "");
}

// ---- Messages tab ----------------------------------------------------------

function renderMessages(): void {
  const wrap = document.createElement("div");
  wrap.className = "vsdb-messages";
  results.forEach((r, i) => {
    const card = document.createElement("div");
    card.className = "vsdb-msg-card";
    if (r.status === "error") card.classList.add("vsdb-msg-error");
    if (r.status === "cancelled") card.classList.add("vsdb-msg-cancelled");

    const title = document.createElement("div");
    title.className = "vsdb-msg-title";
    title.textContent = `Statement ${i + 1} — ${r.status.toUpperCase()}`;
    card.appendChild(title);

    const sql = document.createElement("pre");
    sql.className = "vsdb-msg-sql";
    sql.textContent = r.sql;
    card.appendChild(sql);

    const meta = document.createElement("div");
    meta.className = "vsdb-msg-meta";
    meta.textContent = `Duration: ${r.durationMs}ms`;
    if (r.result?.commandTag) meta.textContent += ` — ${r.result.commandTag}`;
    if (r.result?.rowCount !== undefined && r.result?.rowCount !== null) {
      meta.textContent += ` — ${r.result.rowCount} row(s)`;
    }
    card.appendChild(meta);

    if (r.error) {
      const err = document.createElement("div");
      err.className = "vsdb-msg-error-text";
      err.textContent = r.error;
      card.appendChild(err);
    }
    wrap.appendChild(card);
  });
  root.appendChild(wrap);
}

// ---- Message handling ------------------------------------------------------

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostMsg;
  if (msg.type === "state") {
    headerText = msg.header;
    results = msg.results || [];
    busy = msg.busy;
    // Host returned from loadMore → clear in-flight flag.
    loadMoreInFlight = false;
    if (activeTab >= results.length) activeTab = Math.max(0, results.length - 1);
    render();
  } else if (msg.type === "busy") {
    busy = msg.busy;
    if (!busy) loadMoreInFlight = false;
    render();
  }
});

// Tell host we're ready.
postToHost({ type: "ready" });

// Initial render.
render();

// Expose for debugging + tests.
(window as unknown as { __vsdb: unknown }).__vsdb = {
  render,
  postToHost,
  formatCell,
  get gridApi(): GridApi | null {
    return gridApi;
  },
  get checkLoadMore(): () => void {
    return () => {
      const host = root.querySelector(".vsdb-grid-host") as HTMLElement | null;
      if (!host) return;
      const hook = (host as unknown as { __checkLoadMore?: () => void }).__checkLoadMore;
      if (typeof hook === "function") hook();
    };
  },
};

// Also keep getGridApi (the AG Grid official accessor) bound.
void getGridApi;
