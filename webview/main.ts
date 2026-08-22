// webview/main.ts
// Webview entry — nhận state từ extension host, render tabs + AG Grid + Messages.
//
// Message protocol: see src/ui/messages.ts (mirror of types).
//
// TASK-203: thay VirtualGrid bằng AG Grid Community (client-side row model +
// applyTransaction append). Pure-logic model đã dới sang src/ui/resultsGridModel.ts.
//
// TASK-402: per-column filter nâng cấp Excel-like (text/number filter + AND/OR
// tối đa 2 điều kiện), `colFilterActive` gate chặn loadMore vòng lặp khi cột
// filter active, Fix #3 bỏ colDef `__select__` (tránh 2 checkbox/dòng) — dùng
// `rowSelection.selectionColumnDef` v36 tự render selection column.
//
// Render lifecycle (TASK-203 R4.5 fix round 1):
//   - Persistent DOM containers (header, toolbar, tabs strip, panel area) are
//     created ONCE on first render. Subsequent renders only update text/state
//     and swap the panel content (grid / messages / empty).
//   - The AG Grid host element is persistent. The grid instance is created once
//     on the first grid-render and re-used across re-renders via
//     setGridOption("rowData" | "columnDefs") + applyTransaction (append).
//   - Tab clicks clear only the active panel slot, never the grid host.
//   - The panel slot is wiped (innerHTML="") ONLY when leaving the grid (e.g.
//     switching to Messages) — the grid host is detached and re-attached as a
//     single child of the panel rather than destroyed, so the AG Grid instance
//     stays in the live DOM.
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "./styles.css";
import {
  createGrid,
  AllCommunityModule,
  ModuleRegistry,
  type BodyScrollEvent,
  type FilterChangedEvent,
} from "ag-grid-community";
import type { GridApi } from "ag-grid-community";
import {
  inferColumns,
  createResultsGridModel,
  selectionToText,
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
  | null;

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
/** Last column count seen for the active statement (used to detect
 *  column-set changes for the same statement, not row count — row count is
 *  handled by append delta). */
let lastColumnCount = -1;
/** AG Grid instance (one per webview lifecycle — re-used across re-renders). */
let gridApi: GridApi | null = null;
/** Per-statement loadMore gate model. Keyed by statement index. */
const models = new Map<number, ResultsGridModel>();
/** Rows currently shown in AG Grid per statement (mirrors AG Grid internals
 *  for the "append delta" calculation). Keyed by statement index. */
const statementRows = new Map<number, unknown[][]>();
/** Tracks if a loadMore was dispatched and is awaiting host reply. */
let loadMoreInFlight = false;
/** True when the quick-search box has text in it. */
let quickFilterActive = false;
/** True when a column filter (header / floating filter) is active. Updated
 *  by `onFilterChanged` reading `api.isColumnFilterPresent()`. Reset on
 *  grid recreate and on columnDefs swap. */
let colFilterActive = false;

// ---- Persistent DOM (created once on first render) -------------------------

interface PersistentDom {
  header: HTMLDivElement;
  toolbar: HTMLDivElement;
  cancelBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  tabs: HTMLDivElement;
  /** Slot where the active panel renders. The grid host and messages live
   *  here. Cleared and re-populated on tab switch / state change, but the
   *  grid host (once created) is preserved as a single child. */
  panel: HTMLDivElement;
  /** Persistent AG Grid host element. Created once. The AG Grid instance
   *  mounts onto this element and stays attached across re-renders. */
  gridHost: HTMLDivElement;
  /** Persistent grid footer. */
  gridFooter: HTMLDivElement;
  /** Wraps gridHost + gridFooter in a `.vsdb-grid-host` flex column. */
  gridWrap: HTMLDivElement;
}
let dom: PersistentDom | null = null;
let firstRender = true;

// Currently displayed footer/statement (for quick-filter live updates).
function setCurrentStatement(r: StatementResult | null): void {
  currentStatement = r;
  if (dom) currentFooter = dom.gridFooter;
}
let currentFooter: HTMLElement | null = null;
let currentStatement: StatementResult | null = null;

function rowsToObjects(
  rows: unknown[][],
  specs: readonly ColumnSpec[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    specs.forEach((s, i) => {
      obj[s.field] = row[i];
    });
    return obj;
  });
}

// ---- Render ----------------------------------------------------------------

function render(): void {
  if (firstRender) {
    root.innerHTML = "";
    dom = buildPersistentDom();
    root.appendChild(dom.header);
    root.appendChild(dom.toolbar);
    root.appendChild(dom.tabs);
    root.appendChild(dom.panel);
    firstRender = false;
  }
  if (!dom) return;

  // Header text update.
  dom.header.textContent = headerText || "VSDB Results";

  // Cancel button state.
  dom.cancelBtn.disabled = !busy;

  // Tabs — rebuild only the buttons (cheap; tabs length changes with results).
  rebuildTabs(dom.tabs);

  // Panel content — re-render based on active tab.
  renderActivePanel();
}

function buildPersistentDom(): PersistentDom {
  const header = document.createElement("div");
  header.className = "vsdb-header";

  const toolbar = document.createElement("div");
  toolbar.className = "vsdb-toolbar";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "vsdb-btn vsdb-btn-danger";
  cancelBtn.addEventListener("click", () => postToHost({ type: "cancel" }));
  toolbar.appendChild(cancelBtn);

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
      try {
        gridApi.onFilterChanged();
      } catch {
        /* older API */
      }
      updateFooterNow();
    }
  });
  toolbar.appendChild(searchInput);

  const tabs = document.createElement("div");
  tabs.className = "vsdb-tabs";

  const panel = document.createElement("div");
  panel.className = "vsdb-panel";

  // Persistent grid wrapper + AG Grid host + footer. The AG Grid mounts on
  // gridHost and is NEVER detached once created. The wrapper survives every
  // re-render so the grid DOM stays live.
  const gridWrap = document.createElement("div");
  gridWrap.className = "vsdb-grid-host";
  gridWrap.style.display = "none"; // hidden until first grid render
  // Listen on the outer container so Ctrl/Cmd+C is caught whether the event
  // is dispatched on the container itself (test) or bubbled from inner AG Grid
  // cells (real interaction). useCapture=true ensures we see the event before
  // AG Grid / browser default handling swallows it.
  gridWrap.addEventListener(
    "keydown",
    (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
        copySelectionToHost();
      }
    },
    true,
  );

  const gridHost = document.createElement("div");
  gridHost.className = "ag-theme-quartz";
  gridHost.style.flex = "1";
  gridHost.style.width = "100%";
  gridHost.style.minHeight = "0";
  gridWrap.appendChild(gridHost);

  const gridFooter = document.createElement("div");
  gridFooter.className = "vsdb-grid-footer";
  gridWrap.appendChild(gridFooter);


  return {
    header,
    toolbar,
    cancelBtn,
    searchInput,
    tabs,
    panel,
    gridHost,
    gridFooter,
    gridWrap,
  };
}

function tabBadge(r: StatementResult): string {
  if (r.status === "done") return "✓";
  if (r.status === "error") return "✗";
  if (r.status === "cancelled") return "⌀";
  return "…";
}

function rebuildTabs(tabsEl: HTMLDivElement): void {
  tabsEl.innerHTML = "";
  results.forEach((r, i) => {
    const tab = document.createElement("button");
    tab.className = "vsdb-tab" + (i === activeTab ? " vsdb-tab-active" : "");
    if (r.status === "error") tab.classList.add("vsdb-tab-error");
    if (r.status === "cancelled") tab.classList.add("vsdb-tab-cancelled");
    tab.textContent = `Statement ${i + 1} ${tabBadge(r)}`;
    tab.addEventListener("click", () => {
      if (activeTab === i) return;
      activeTab = i;
      // Tab switch IS a legitimate reset (different statement context).
      loadMoreInFlight = false;
      // Wipe transient state (the panel will be re-populated), but keep the
      // grid host wrapper alive in the panel so the AG Grid stays mounted.
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
    if (activeTab === results.length) return;
    activeTab = results.length;
    render();
  });
  tabsEl.appendChild(msgTab);
}

function renderActivePanel(): void {
  if (!dom) return;
  const panel = dom.panel;

  if (results.length === 0) {
    // Empty state — wipe panel and show placeholder.
    teardownGridWrap();
    panel.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "vsdb-empty";
    empty.textContent = busy ? "Running…" : "No results yet.";
    panel.appendChild(empty);
    return;
  }

  if (activeTab === results.length) {
    // Messages tab — wipe panel, render messages.
    teardownGridWrap();
    panel.innerHTML = "";
    renderMessagesInto(panel);
    return;
  }

  // Statement grid tab — wipe panel and re-mount the persistent grid wrap.
  // The grid wrap keeps its AG Grid child mounted on gridHost; re-attaching
  // the wrap to the panel restores the grid GUI to the live DOM.
  panel.innerHTML = "";
  panel.appendChild(dom.gridWrap);
  dom.gridWrap.style.display = "flex";
  renderGrid();
}

/** Hide the grid wrap when the user navigates away (to Messages or empty
 *  state). The AG Grid instance is preserved on gridHost; we just don't
 *  show the wrap. */
function teardownGridWrap(): void {
  if (!dom) return;
  dom.gridWrap.style.display = "none";
  setCurrentStatement(null);
}

function renderGrid(): void {
  if (!dom) return;
  const r = results[activeTab];
  if (!r) return;
  // Reference the persistent elements (do NOT create new ones).
  const container = dom.gridWrap;
  const gridHost = dom.gridHost;
  const footer = dom.gridFooter;
  // Clear any non-grid children from the wrap (e.g. transient error/ok
  // placeholder divs from a previous error/ok-message render). Keep gridHost
  // + footer intact.
  for (const child of Array.from(container.children)) {
    if (child === gridHost || child === footer) continue;
    container.removeChild(child);
  }

  if (r.status === "error") {
    // Error placeholder lives next to the grid host, not in place of it.
    const err = document.createElement("div");
    err.className = "vsdb-error";
    err.textContent = `Error: ${r.error ?? "unknown"}`;
    container.insertBefore(err, gridHost);
    setCurrentStatement(null);
    return;
  }
  if (!r.result) {
    // Running / pending state with no result yet.
    lastRenderedIndex = activeTab;
    lastResultStatus = r.status;
    setCurrentStatement(null);
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
    container.insertBefore(msg, gridHost);
    setCurrentStatement(r);
    return;
  }

  setCurrentStatement(r);

  // Compute columns from the result.
  const specs: ColumnSpec[] = inferColumns(r.result.columns, r.result.rows);

  // Build AG Grid column defs from specs. Each column gets an Excel-like
  // column filter: text filter for string/boolean, number filter for numbers,
  // with up to 2 conditions (AND/OR) and a debounced input. Floating filter
  // row stays enabled so users can type in place.
  const baseCols = specs.map((spec) => {
    const isNumber = spec.kind === "number";
    return {
      field: spec.field,
      headerName: spec.headerName,
      sortable: true,
      filter: isNumber ? "agNumberColumnFilter" : "agTextColumnFilter",
      filterParams: isNumber
        ? {
            filterOptions: [
              "equals",
              "notEqual",
              "lessThan",
              "lessThanOrEqual",
              "greaterThan",
              "greaterThanOrEqual",
              "inRange",
              "blank",
              "notBlank",
            ],
            defaultOption: "equals",
            maxNumConditions: 2,
            debounceMs: 200,
          }
        : {
            filterOptions: [
              "contains",
              "notContains",
              "equals",
              "notEqual",
              "startsWith",
              "endsWith",
              "blank",
              "notBlank",
            ],
            defaultOption: "contains",
            maxNumConditions: 2,
            debounceMs: 200,
            caseSensitive: false,
          },
      resizable: true,
      floatingFilter: true,
      valueFormatter: (p: { value: unknown }) => formatCell(p.value),
      cellStyle: isNumber
        ? { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" }
        : {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
    };
  });
  // AG Grid v36 auto-creates a selection column from rowSelection. We do NOT
  // pre-pend a custom `__select__` column — doing so produced a second
  // checkbox per row (Fix #3). Visual customisation of the auto-generated
  // selection column lives in `rowSelection.selectionColumnDef` below.
  const colDefs = baseCols;

  // Determine reset vs append:
  //   - first render (no api yet) → reset (create grid)
  //   - tab switched → reset (destroy + recreate on same gridHost, since
  //     columns may differ)
  //   - same statement + status went running→terminal → reset
  //   - same statement + rows grew → append via applyTransaction
  //   - same statement + columns changed → reset (columnDefs swap)
  //   - otherwise → idempotent no-op
  const isFirstRender = !gridApi;
  const tabSwitched = lastRenderedIndex !== activeTab;
  const statementReset = lastResultStatus === "running" && r.status !== "running";
  const previousRows = statementRows.get(activeTab) ?? [];
  const rowsGrew = r.result.rows.length > previousRows.length;
  const columnsChanged = specs.length !== lastColumnCount;

  const model = ensureModel(activeTab);
  const syncResult = model.sync(r.result.rows, activeTab, !!r.batched, {
    rowCount: r.result.rowCount ?? null,
    loadedBefore: tabSwitched || statementReset ? 0 : previousRows.length,
  });

  if (isFirstRender || tabSwitched) {
    if (gridApi) {
      // Tab switch: destroy old grid and recreate on the same persistent
      // host with new columns. Destroying ensures the new grid sees fresh
      // columnDefs (column defs are immutable after construction in v32+).
      try {
        gridApi.destroy();
      } catch {
        /* noop */
      }
      gridApi = null;
    }
    // Fresh grid → any previous column filter no longer applies.
    colFilterActive = false;
    gridApi = createGrid(gridHost, {
      columnDefs: colDefs,
      rowData: rowsToObjects(r.result.rows, specs),
      rowSelection: {
        mode: "multiRow",
        // v36 selection column is auto-created when checkboxes/headerCheckbox
        // are true. We configure its visual layout via selectionColumnDef
        // below — do NOT pre-pend a `__select__` colDef (Fix #3: that
        // produced a second checkbox per row).
        checkboxes: true,
        headerCheckbox: true,
        // Header checkbox selects only filtered rows, not the whole dataset.
        selectAll: "filtered",
        enableClickSelection: false,
        selectionColumnDef: {
          pinned: "left",
          width: 40,
          resizable: false,
          sortable: false,
          filter: false,
          suppressHeaderMenuButton: true,
          suppressMovable: true,
          lockPosition: "left",
          cellStyle: { padding: 0 },
        },
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
      // Keep `colFilterActive` in sync with grid state. Re-poll
      // `isColumnFilterPresent()` instead of trusting a stale bool — the
      // event source can be 'api' (programmatic setFilterModel) or 'ui'
      // (header / floating filter) and we want the gate to be accurate in
      // both cases. (See TASK-402 plan reviewer note.)
      onFilterChanged: (e: FilterChangedEvent) => {
        colFilterActive = e.api.isColumnFilterPresent();
        updateFooterNow();
      },
      onModelUpdated: () => updateFooterNow(),
      onBodyScroll: (e: BodyScrollEvent) => onBodyScroll(e, activeTab, model),
    });
    (gridHost as unknown as { __vsdbApi: GridApi }).__vsdbApi = gridApi;
    statementRows.set(activeTab, r.result.rows.slice());
    lastColumnCount = specs.length;
  } else if (statementReset || columnsChanged || syncResult.isReset) {
    // Replace rowData (and column defs if changed) on the existing grid.
    if (columnsChanged) {
      // Column set changed → previous column filter is no longer valid.
      colFilterActive = false;
      gridApi!.setGridOption("columnDefs", colDefs);
      lastColumnCount = specs.length;
    }
    gridApi!.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    statementRows.set(activeTab, r.result.rows.slice());
  } else if (rowsGrew && syncResult.appendDelta.length > 0) {
    const newRowObjects = syncResult.appendDelta.map((row) => {
      const obj: Record<string, unknown> = {};
      specs.forEach((s, i) => {
        obj[s.field] = row[i];
      });
      return obj;
    });
    const addIndex = previousRows.length;
    gridApi!.applyTransaction({ add: newRowObjects, addIndex });
    statementRows.set(activeTab, r.result.rows.slice());
  }
  // else: idempotent — no-op.

  lastRenderedIndex = activeTab;
  lastResultStatus = r.status;

  // Initial footer text.
  updateFooterNow();

  // Expose the checkLoadMore hook on the grid host (so tests / external code
  // can trigger a loadMore programmatically).
  (container as unknown as { __checkLoadMore?: () => void }).__checkLoadMore = () => {
    if (loadMoreInFlight || busy || quickFilterActive || colFilterActive) return;
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
  if (colFilterActive) return;
  loadMoreInFlight = true;
  postToHost({ type: "loadMore", index: activeTab });
}

/**
 * AG Grid BodyScrollEvent — fires on every body scroll.
 *
 * IMPORTANT: AG Grid BodyScrollEvent has `direction`, `left`, `top` — NOT a
 * `bottom` field. We gate on direction === "vertical" and use the API to
 * detect near-bottom via the last-displayed-row index.
 */
function onBodyScroll(
  e: BodyScrollEvent,
  _index: number,
  model: ResultsGridModel,
): void {
  if (loadMoreInFlight || busy || quickFilterActive || colFilterActive) return;
  if (e.direction !== "vertical") return;
  const api = gridApi;
  if (!api) return;
  const state = model.getState();
  if (!state.hasMore()) return;
  const lastDisplayed = api.getLastDisplayedRowIndex();
  const total = api.getDisplayedRowCount();
  // Trigger when within 5 rows of the bottom (viewport buffer).
  if (lastDisplayed >= 0 && total > 0 && lastDisplayed >= total - 5) {
    model.requestWindow(state.getLoaded(), 0);
    dispatchLoadMore();
  }
}

function copySelectionToHost(): void {
  if (!gridApi) return;
  const selected = gridApi.getSelectedRows();
  if (selected.length === 0) return;
  // Re-shape: AG Grid returns row objects; we need arrays of original values.
  // There is no `__select__` synthetic field anymore (TASK-402 Fix #3) — just
  // pass through the known spec field names.
  const specsForCopy: readonly ColumnSpec[] = currentStatement?.result
    ? inferColumns(
        currentStatement.result.columns,
        currentStatement.result.rows.slice(0, 1),
      )
    : [];
  const arr = selected.map((obj) => {
    const row: unknown[] = [];
    const r = obj as Record<string, unknown>;
    if (specsForCopy.length === 0) {
      for (const k of Object.keys(r)) {
        row.push(r[k]);
      }
    } else {
      for (const s of specsForCopy) {
        row.push(r[s.field]);
      }
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
  // Either the quick search box or a column filter counts as "filtered"
  // for footer display purposes.
  const filtered = displayed !== loaded && (quickFilterActive || colFilterActive);
  const duration = r.durationMs;
  footer.textContent =
    footerText(loaded, total, hasMore, displayed, filtered) +
    (duration > 0 ? `  ⏱ ${duration}ms` : "");
}

function updateFooterNow(): void {
  if (!dom) return;
  const footer = dom.gridFooter;
  const api = gridApi;
  const r = currentStatement;
  if (!r) {
    footer.textContent = "";
    return;
  }
  const model = models.get(activeTab);
  if (!model) {
    footer.textContent = "";
    return;
  }
  updateFooter(footer, model, api, r);
}

// ---- Messages tab ----------------------------------------------------------

function renderMessagesInto(panel: HTMLDivElement): void {
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
  panel.appendChild(wrap);
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
