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
// NOTE: no ag-grid stylesheet imports — the JS Theming API (themeQuartz
// below) generates its own CSS at runtime. Importing ag-grid.css alongside
// triggers AG Grid error #106 (Theming API + Legacy Themes conflict) and the
// grid refuses to render. Only our own overrides are imported.
import "./styles.css";
import {
  createGrid,
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type BodyScrollEvent,
  type FilterChangedEvent,
  type CellValueChangedEvent,
  type CellStyle,
} from "ag-grid-community";
import type { GridApi } from "ag-grid-community";
import {
  inferColumns,
  createResultsGridModel,
  selectionToText,
  footerText,
  formatCell,
  EditState,
  parseTsvPaste,
  applyPasteToDirty,
  serializeExport,
  composeRequery,
  type ColumnSpec,
  type ResultsGridModel,
  type ExportFormat,
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
interface SaveResultMsg {
  type: "saveResult";
  index: number;
  ok: boolean;
  errors?: string[];
  /** Soft refusal (mysql/mssql no-PK) — `ok` will be true so the dirty
   *  map clears; `reason` is the banner copy. */
  refused?: boolean;
  reason?: string;
}

type HostMsg = StateMsg | BusyMsg | SaveResultMsg;


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
type RequeryMsg = {
  type: "requery";
  index: number;
  where: string;
  orderBy: string;
};
type SaveEditsMsg = {
  type: "saveEdits";
  index: number;
  edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
  tableName: string | null;
  pkColumns: string[];
};
type WebviewMsg =
  | LoadMoreMsg
  | CancelMsg
  | CopyMsg
  | ExportFileMsg
  | SaveEditsMsg
  | RequeryMsg
  | ReadyMsg;


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
/** Local edit state — pure-logic dirty map. Cleared on tab switch / new query.
 *  TASK-503 will read `editState.snapshot()` to build the save payload. */
let editState = new EditState();
/** When true, data cells display the raw value (CSV preview mode). Flipped
 *  by the CSV toggle toolbar button. */
let csvMode = false;
/** Locally-added rows beyond the server's row count. Add Row appends
 *  a fresh row and assigns it a stable __rowId past the source array.
 *  Reset on tab switch / new query (each renderGrid already calls
 *  editState.clear() in the reset branch). */
let newRowCount = 0;
/** Highest __rowId ever allocated (server-truth OR local) for the
 *  current statement. Bumped on Add Row AND on append-delta — keeps
 *  local-id and server-id spaces disjoint so a streamed append can
 *  never produce a __rowId that collides with a locally-added row
 *  (R2 finding #2). Reset alongside newRowCount on tab switch /
 *  new query. */
let highestAllocatedId = -1;
/** Maps __rowId → source-array index in r.result.rows. Populated by
 *  rowsToObjects for every row it materializes and read by onUndoClick
 *  to resolve the server-truth original cell for a dirty edit. Necessary
 *  because the high-water-mark id scheme (R2 #2) decouples __rowId from
 *  the source-array index — after Add Row + stream, a streamed row's
 *  __rowId is past the source-array length, so the old
 *  `r.result.rows[popped.rowId]` lookup returned the wrong row. The map
 *  is cleared in the two reset branches (first-render / tab switch and
 *  statementReset / columnsChanged / isReset) BEFORE rowsToObjects
 *  repopulates; append-delta must NOT clear it because streaming appends
 *  extend the same r.result.rows — the existing entries for ids 0..N-1
 *  remain valid, and rowsToObjects adds entries for ids N..M-1 (R3
 *  finding #1). */
const serverIndexByRowId = new Map<number, number>();
/** Last ColumnSpecs seen for the active statement. Used by handlers
 *  (onUndoClick, onAddRowClick, onCsvToggleClick, onGridPaste) that
 *  need a stable column ordering for colIndex ↔ field mapping. The
 *  handler closure captures this at renderGrid time. */
let currentSpecs: readonly ColumnSpec[] = [];
/**
 * Type-narrowed accessor for the stable row identity that AG Grid's
 * getRowId/restore-style flows rely on. AG Grid calls our getRowId
 * with `r.data`; we set `__rowId` on every row in rowsToObjects so the
 * identity is stable across sort, filter, and column reorder.
 */
function readRowId(
  data: Record<string, unknown> | undefined,
): number | undefined {
  if (!data || !("__rowId" in data)) return undefined;
  const v = data["__rowId"];
  return typeof v === "number" ? v : undefined;
}
/** True when the event target is a text input — floating-filter inputs
 *  and similar. The capture-phase paste listener must NOT treat such
 *  pastes as grid edits (they are the user's local typing). */
function isFilterInput(t: EventTarget | null): boolean {
  if (!t) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

/** onCellValueChanged handler (TASK-501). Records cell edits into the
 *  local EditState, keyed by STABLE row identity (`__rowId`) and
 *  stable colIndex (resolved against the immutable `currentSpecs`).
 *  Promoted to module level so the simulateCellEdit test hook can
 *  invoke the same handler the grid uses, with synthetic event
 *  payloads. This is the wiring real UI edits follow. */
function onCellValueChangedHandler(e: CellValueChangedEvent): void {
  const col = e.colDef as { field?: string } | undefined;
  if (!col || typeof col.field !== "string") return;
  const colIndex = currentSpecs.findIndex((s) => s.field === col.field);
  if (colIndex < 0) return;
  const rowId = readRowId(e.node?.data);
  if (rowId === undefined) return;
  editState.markDirty(rowId, colIndex, e.newValue, e.oldValue);
  updateFooterNow();
}

/** Test seam for integration tests: simulate a user cell edit by
 *  invoking the same onCellValueChanged handler the grid uses, with a
 *  synthetic event payload. Resolves the row via the grid's stable
 *  __rowId and the colDef via currentSpecs. */
function simulateCellEdit(
  rowId: number,
  colField: string,
  newValue: unknown,
  oldValue: unknown,
): void {
  if (!gridApi) return;
  const node = gridApi.getRowNode(String(rowId));
  if (!node) return;
  // Find the column def by field. currentSpecs is the stable ordering
  // (column drag-reorder would shift getColumnDefs but not currentSpecs).
  const spec = currentSpecs.find((s) => s.field === colField);
  if (!spec) return;
  // AG Grid mutates node.data[colDef.field] = newValue BEFORE firing
  // onCellValueChanged — the registered handler runs against the
  // already-mutated cell. The test seam mirrors that so undo/refresh
  // assertions read the value the user actually sees on screen.
  node.data[spec.field] = newValue;
  // Build the minimum event shape the handler reads. We mark `api`
  // for typing but the handler does not call it.
  const fakeEvent = {
    api: gridApi,
    node: { data: node.data },
    colDef: { field: spec.field },
    newValue,
    oldValue,
  } as unknown as CellValueChangedEvent;
  onCellValueChangedHandler(fakeEvent);
}
interface PersistentDom {
  header: HTMLDivElement;
  toolbar: HTMLDivElement;
  cancelBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  addRowBtn: HTMLButtonElement;
  deleteRowBtn: HTMLButtonElement;
  undoBtn: HTMLButtonElement;
  csvToggleBtn: HTMLButtonElement;
  exportFormat: HTMLSelectElement;
  exportHeader: HTMLInputElement;
  exportCopyBtn: HTMLButtonElement;
  exportFileBtn: HTMLButtonElement;
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
  /** Persistent banner above the footer — shows save errors / no_pk warnings.
   *  Created once, hidden by default; populated on saveResult with errors. */
  saveBanner: HTMLDivElement;
  /** TASK-504 — WHERE input on the requery bar. */
  requeryWhere: HTMLInputElement;
  /** TASK-504 — ORDER BY input on the requery bar. */
  requeryOrderBy: HTMLInputElement;
  /** TASK-504 — Re-Run button that posts the requery message. */
  requeryRunBtn: HTMLButtonElement;
  /** TASK-504 — Clear button that resets both inputs. */
  requeryClearBtn: HTMLButtonElement;
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
  startIndex = 0,
  sourceIndexStart: number = startIndex,
): Record<string, unknown>[] {
  // Each row gets a `__rowId` = the source-array index. AG Grid's
  // `getRowId` reads from this so edits and undo remain stable across
  // sort / filter / column reorder (display rowIndex would shift but the
  // __rowId stays anchored to the original server row).
  //
  // We also record the mapping __rowId → source-array index in
  // r.result.rows. onUndoClick reads it to restore the original cell
  // value. The mapping is necessary because the high-water-mark id
  // scheme decouples __rowId from source-index after Add Row + stream
  // (R3 finding #1): for first-render / reset, source-index === __rowId
  // so the default keeps the call sites unchanged; the append-delta
  // caller passes an explicit `sourceIndexStart` so a streamed row at
  // __rowId 4 still maps to r.result.rows[3] (its true source-array
  // position), not [4].
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const obj: Record<string, unknown> = { __rowId: startIndex + i };
    specs.forEach((s, j) => {
      obj[s.field] = rows[i][j];
    });
    serverIndexByRowId.set(startIndex + i, sourceIndexStart + i);
    out.push(obj);
  }
  return out;
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

  // TASK-501: edit / paste / undo toolbar. Add Row / Delete Row operate on
  // local edit state only — TASK-503 will read the snapshot and post the
  // save payload. Refresh is a local-only reset of the dirty map.
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "Refresh";
  refreshBtn.className = "vsdb-btn";
  refreshBtn.title = "Discard dirty edits and refresh the local grid view";
  refreshBtn.addEventListener("click", () => onRefreshClick());
  toolbar.appendChild(refreshBtn);

  const addRowBtn = document.createElement("button");
  addRowBtn.textContent = "Add Row";
  addRowBtn.className = "vsdb-btn";
  addRowBtn.title = "Append a blank row to the result (TASK-503 will save)";
  addRowBtn.addEventListener("click", () => onAddRowClick());
  toolbar.appendChild(addRowBtn);

  const deleteRowBtn = document.createElement("button");
  deleteRowBtn.textContent = "Delete Row";
  deleteRowBtn.className = "vsdb-btn";
  deleteRowBtn.title = "Mark the currently focused row as deleted (TASK-503 will save)";
  deleteRowBtn.addEventListener("click", () => onDeleteRowClick());
  toolbar.appendChild(deleteRowBtn);

  const undoBtn = document.createElement("button");
  undoBtn.textContent = "Undo";
  undoBtn.className = "vsdb-btn";
  undoBtn.title = "Undo the last cell edit";
  undoBtn.addEventListener("click", () => onUndoClick());
  toolbar.appendChild(undoBtn);
  // TASK-503 — Commit button (and Cmd/Ctrl+Enter keyboard shortcut).
  // Posts a single saveEdits batch with every dirty cell. No-op when the
  // dirty map is empty — we don't post a no-op message and don't disable
  // the button (the user can still trigger one; the handler short-circuits).
  const commitBtn = document.createElement("button");
  commitBtn.textContent = "Commit";
  commitBtn.className = "vsdb-btn vsdb-commit";
  commitBtn.title = "Save all dirty edits to the database (Cmd/Ctrl+Enter)";
  commitBtn.addEventListener("click", () => onCommitClick());
  toolbar.appendChild(commitBtn);


  const csvToggleBtn = document.createElement("button");
  csvToggleBtn.textContent = "CSV";
  csvToggleBtn.className = "vsdb-btn";
  csvToggleBtn.title = "Toggle CSV preview (raw values vs formatted)";
  csvToggleBtn.addEventListener("click", () => onCsvToggleClick());
  toolbar.appendChild(csvToggleBtn);

  // TASK-502 — export toolbar. The format <select> + Header checkbox + Copy
  // and Export-to-file buttons live between the CSV toggle and the search
  // input so they sit next to the other transform actions. The Header
  // checkbox is disabled for SQL modes whose structure is fixed.
  const exportFormat = document.createElement("select");
  exportFormat.className = "vsdb-export-format vsdb-btn";
  for (const fmt of [
    "tsv",
    "csv",
    "xml",
    "json",
    "sql-inserts",
    "sql-inserts-multirow",
    "sql-updates",
    "sql-where",
  ] as const) {
    const opt = document.createElement("option");
    opt.value = fmt;
    opt.textContent = fmt;
    exportFormat.appendChild(opt);
  }
  exportFormat.value = "tsv";
  exportFormat.title = "Export format";
  toolbar.appendChild(exportFormat);

  const exportHeader = document.createElement("input");
  exportHeader.type = "checkbox";
  exportHeader.className = "vsdb-export-header";
  exportHeader.title = "Include header row (TSV/CSV/XML/JSON only)";
  toolbar.appendChild(exportHeader);

  const exportCopyBtn = document.createElement("button");
  exportCopyBtn.textContent = "Copy";
  exportCopyBtn.className = "vsdb-btn vsdb-export-copy";
  exportCopyBtn.title = "Copy serialized export to clipboard";
  exportCopyBtn.addEventListener("click", () => onExportCopyClick());
  toolbar.appendChild(exportCopyBtn);

  const exportFileBtn = document.createElement("button");
  exportFileBtn.textContent = "Export to file";
  exportFileBtn.className = "vsdb-btn vsdb-export-file";
  exportFileBtn.title = "Save serialized export to a file";
  exportFileBtn.addEventListener("click", () => onExportFileClick());
  toolbar.appendChild(exportFileBtn);

  // Toggle Header checkbox enable/disable based on format — SQL modes have
  // a fixed structure (INSERT column list, UPDATE SET list, WHERE groups)
  // so a header checkbox has no meaning and is forced off.
  //
  // Fix R1 minor: remember the user's last non-SQL header preference so
  // toggling CSV→sql-inserts→CSV does not silently reset it to off.
  let headerPrefNonSql = false;
  const updateExportHeaderState = (): void => {
    const v = exportFormat.value;
    const isSql = v.startsWith("sql-");
    if (isSql) {
      headerPrefNonSql = exportHeader.checked;
      exportHeader.checked = false;
    } else {
      exportHeader.checked = headerPrefNonSql;
    }
    exportHeader.disabled = isSql;
  };
  exportHeader.addEventListener("change", () => {
    if (!exportHeader.disabled) headerPrefNonSql = exportHeader.checked;
  });
  exportFormat.addEventListener("change", updateExportHeaderState);
  updateExportHeaderState();
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
    true, // capture — see comment above
  );
  // TASK-503 — Cmd/Ctrl+Enter keyboard shortcut. AG Grid does not surface
  // its own shortcut for this — we wire it ourselves. The shortcut only
  // commits when the dirty map is non-empty (no-op otherwise, see
  // onCommitClick).
  // TASK-503 Fix R1 — Cmd/Ctrl+Enter keyboard shortcut. AG Grid does not
  // surface its own shortcut for this — we wire it ourselves. The shortcut
  // only commits when the dirty map is non-empty (no-op otherwise, see
  // onCommitClick). When focus is in an editable text input (filter box,
  // quick-search, etc.) we MUST NOT capture the keystroke — that would
  // swallow the user's local typing and trigger a save unexpectedly.
  gridWrap.addEventListener(
    "keydown",
    (ev) => {
      if (isFilterInput(ev.target)) return;
      if (
        (ev.ctrlKey || ev.metaKey) &&
        ev.key === "Enter" &&
        !ev.shiftKey
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        onCommitClick();
      }
    },
    true,
  );
  // TASK-501: paste handler — TSV payload from the OS clipboard. AG Grid's
  // own paste module requires Enterprise; we listen on gridWrap so the
  // event is caught whether dispatched directly on the wrap (test) or
  // bubbled from an inner cell. Capture phase so we run before AG Grid's
  // default paste handling.
  gridWrap.addEventListener(
    "paste",
    (ev) => onGridPaste(ev as ClipboardEvent),
    true,
  );

  const gridHost = document.createElement("div");
  // Theme class is managed by the JS Theming API (themeQuartz) — no legacy
  // `ag-theme-quartz` class (that is the legacy-CSS system, error #106 pair).
  gridHost.className = "vsdb-ag-host";
  gridHost.style.flex = "1";
  gridHost.style.width = "100%";
  gridHost.style.minHeight = "0";
  gridWrap.appendChild(gridHost);

  const gridFooter = document.createElement("div");
  gridFooter.className = "vsdb-grid-footer";
  gridWrap.appendChild(gridFooter);
  // TASK-503 — Persistent banner above the footer. Hidden by default;
  // populated on saveResult (ok:false → show; ok:true → hide). Sits
  // inside gridWrap so it scrolls with the grid panel.
  const saveBanner = document.createElement("div");
  saveBanner.className = "vsdb-save-banner vsdb-hidden";
  saveBanner.setAttribute("hidden", "");
  saveBanner.setAttribute("role", "alert");

  // TASK-504 — WHERE/ORDER BY "Re-Run" bar. Sits inside the persistent
  // gridWrap (above the footer) so it scrolls with the grid and survives
  // every re-render alongside the grid host. The bar is NEVER recreated
  // — only its inputs' values are read on click. A "Clear" button resets
  // both inputs.
  const requeryBar = document.createElement("div");
  requeryBar.className = "vsdb-requery-bar";
  requeryBar.setAttribute("data-vsdb-requery-bar", "");
  const requeryWhereLabel = document.createElement("label");
  requeryWhereLabel.className = "vsdb-requery-label";
  requeryWhereLabel.textContent = "WHERE";
  requeryBar.appendChild(requeryWhereLabel);
  const requeryWhere = document.createElement("input");
  requeryWhere.type = "text";
  requeryWhere.placeholder = "e.g. id > 10";
  requeryWhere.className = "vsdb-requery-input vsdb-requery-where";
  requeryBar.appendChild(requeryWhere);
  const requeryOrderLabel = document.createElement("label");
  requeryOrderLabel.className = "vsdb-requery-label";
  requeryOrderLabel.textContent = "ORDER BY";
  requeryBar.appendChild(requeryOrderLabel);
  const requeryOrderBy = document.createElement("input");
  requeryOrderBy.type = "text";
  requeryOrderBy.placeholder = "e.g. created_at DESC";
  requeryOrderBy.className = "vsdb-requery-input vsdb-requery-order";
  requeryBar.appendChild(requeryOrderBy);
  const requeryRunBtn = document.createElement("button");
  requeryRunBtn.textContent = "Re-Run";
  requeryRunBtn.className = "vsdb-btn vsdb-requery-run";
  requeryRunBtn.title = "Re-run the active statement with the WHERE / ORDER BY filter";
  requeryRunBtn.addEventListener("click", () => onRequeryClick());
  requeryBar.appendChild(requeryRunBtn);
  const requeryClearBtn = document.createElement("button");
  requeryClearBtn.textContent = "Clear";
  requeryClearBtn.className = "vsdb-btn vsdb-requery-clear";
  requeryClearBtn.title = "Clear the WHERE and ORDER BY inputs";
  requeryClearBtn.addEventListener("click", () => {
    requeryWhere.value = "";
    requeryOrderBy.value = "";
  });
  requeryBar.appendChild(requeryClearBtn);
  gridWrap.appendChild(requeryBar);
  gridWrap.appendChild(saveBanner);



  return {
    header,
    toolbar,
    cancelBtn,
    refreshBtn,
    addRowBtn,
    deleteRowBtn,
    undoBtn,
    csvToggleBtn,
    exportFormat,
    exportHeader,
    exportCopyBtn,
    exportFileBtn,
    searchInput,
    tabs,
    panel,
    gridHost,
    gridFooter,
    gridWrap,
    requeryWhere,
    requeryOrderBy,
    requeryRunBtn,
    requeryClearBtn,
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
  const saveBanner = dom.saveBanner;
  // Clear any non-grid children from the wrap (e.g. transient error/ok
  // placeholder divs from a previous error/ok-message render). Keep gridHost
  // + footer intact.
  for (const child of Array.from(container.children)) {
    if (child === gridHost || child === footer || child === saveBanner) continue;
    if ((child as HTMLElement).classList?.contains("vsdb-requery-bar")) continue;
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

  // Compute columns from the result. specs is the stable identifier for
  // column ordering — handlers (onUndoClick/onAddRowClick/onGridPaste)
  // resolve colIndex via currentSpecs, not getColumnDefs (which a
  // column drag-reorder would shift).
  const specs: ColumnSpec[] = inferColumns(r.result.columns, r.result.rows);
  currentSpecs = specs;

  // Build AG Grid column defs from specs. Each column gets an Excel-like
  // column filter: text/number filter + AND/OR (up to 2 conditions) and a
  // debounced input. Floating filter
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
      // TASK-501: cells are editable (cellValueChanged → editState.markDirty).
      // valueFormatter is rebuilt when csvMode flips (toggleCsv) so the user
      editable: true,
      valueFormatter: (p: { value: unknown }) => formatDataCell(p.value),
      cellStyle: (isNumber
        ? { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" }
        : {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }) as CellStyle,

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
    // Fresh grid (new statement OR tab switch) → drop any stale dirty edits
    // and any locally-added rows. Without this, switching from a 5-col
    // result to a 2-col result leaves dirty entries keyed to old columns/
    // rows, so the next undo would read the wrong cells and TASK-503's
    // snapshot() would carry phantom edits into a save payload for the
    // wrong statement.
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
    editState.clear();
    newRowCount = 0;
    highestAllocatedId = -1;
    colFilterActive = false;
    // Clear the server-id → source-index map BEFORE rowsToObjects
    // repopulates. Stale entries from a prior statement would let undo
    // read the wrong row's value after a tab switch (R3 finding #1).
    serverIndexByRowId.clear();
    gridApi = createGrid(gridHost, {
      // VS Code theme follow (TASK-401 fix round 2): AG v36 paints the grid
      // via the JS Theming API (inline sheet + element-level vars), NOT via
      // the quartz stylesheet — CSS overrides on .ag-theme-quartz lose the
      // cascade to element-level vars. Bind theme params to VS Code vars.
      theme: themeQuartz.withParams({
        backgroundColor: "var(--vscode-editor-background, #1e1e1e)",
        foregroundColor: "var(--vscode-foreground, #cccccc)",
        accentColor: "var(--vscode-focusBorder, #007fd4)",
        borderColor: "var(--vscode-panel-border, #3c3c3c)",
      }),
      rowData: rowsToObjects(r.result.rows, specs),
      columnDefs: colDefs,
      // Stable row identity — `__rowId` is set by rowsToObjects to the
      // source-array index. With getRowId wired here, AG Grid's node.id
      // is the original row identity regardless of sort/filter/column
      // reorder. TASK-503's save payload and the bundle's undo handler
      // both rely on this.
      getRowId: (params) => String(params.data.__rowId),
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
      // TASK-501: record cell edits into the local EditState. Edits are
      // keyed by STABLE row identity (`__rowId`) so sort/filter/column
      // reorder cannot misaddress a cell. colIndex is resolved against
      // the immutable `currentSpecs` (NOT getColumnDefs — column
      // drag-reorder would shift getColumnDefs order, breaking colIndex
      // mapping to the raw row array index).
      onCellValueChanged: onCellValueChangedHandler,
      onModelUpdated: () => updateFooterNow(),
      onBodyScroll: (e: BodyScrollEvent) => onBodyScroll(e, activeTab, model),
    });
    (gridHost as unknown as { __vsdbApi: GridApi }).__vsdbApi = gridApi;
    statementRows.set(activeTab, r.result.rows.slice());
    lastColumnCount = specs.length;
    // Seed the high-water mark to the last server row's id. Locally-added
    // rows must always get ids ABOVE this — append-delta uses
    // `Math.max(previousRows.length, highestAllocatedId + 1)` to keep
    // the two id spaces disjoint.
    highestAllocatedId = r.result.rows.length - 1;
  } else if (statementReset || columnsChanged || syncResult.isReset) {
    // New data for the same statement (e.g. statementReset on terminal
    // status, or columnsChanged). Drop stale dirty edits and any rows
    // the user added locally — they no longer make sense for a fresh
    // result set; the user must re-add via the Add Row button.
    editState.clear();
    newRowCount = 0;
    highestAllocatedId = -1;
    // Clear the server-id → source-index map BEFORE rowsToObjects
    // repopulates (same reason as the first-render branch — stale
    // entries from the previous state would let undo read the wrong
    // row after a same-statement refresh, R3 finding #1).
    serverIndexByRowId.clear();
    if (columnsChanged) {
      // Column set changed → previous column filter is no longer valid.
      // Clear the filter model (AG Grid keeps filters for surviving columns
      // across a columnDefs swap) and re-poll the live grid state instead of
      // trusting a local bool — a stale false here re-opens the loadMore
      gridApi!.setFilterModel(null);
      gridApi!.setGridOption("columnDefs", colDefs);
      colFilterActive = gridApi!.isColumnFilterPresent();
      lastColumnCount = specs.length;
    }
    gridApi!.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    statementRows.set(activeTab, r.result.rows.slice());
    // Re-seed the high-water mark after the rowData swap. New server rows
    // may have arrived (the user clicked Refresh), so the mark moves with
    // r.result.rows.length. Locally-added rows were cleared above so this
    // is safe.
    highestAllocatedId = r.result.rows.length - 1;
  } else if (rowsGrew && syncResult.appendDelta.length > 0) {
    // Append delta — only new server rows get added (no clobber). Each
    // appended row needs a __rowId so the grid's stable-identity layer
    // can resolve it for edits/undo just like the original rows.
    //
    // `startIndex` MUST respect the high-water mark — locally-added rows
    // already use ids >= r.result.rows.length, so a streaming append
    // starting from `previousRows.length` would collide. We start past
    // the highest id we have ever allocated (R2 finding #2).
    //
    // `sourceIndexStart` is `previousRows.length` — the delta slice
    // starts at this position in r.result.rows. We pass it explicitly
    // so rowsToObjects records __rowId → r.result.rows index mappings
    // for the appended rows even when the high-water mark has bumped
    // startIndex past previousRows.length (R3 finding #1).
    const startIndex = Math.max(previousRows.length, highestAllocatedId + 1);
    const newRowObjects = rowsToObjects(
      syncResult.appendDelta,
      specs,
      startIndex,
      previousRows.length,
    );
    const addIndex = previousRows.length;
    gridApi!.applyTransaction({ add: newRowObjects, addIndex });
    for (const obj of newRowObjects) {
      const id = obj.__rowId;
      if (typeof id === "number" && id > highestAllocatedId) {
        highestAllocatedId = id;
      }
    }
    statementRows.set(activeTab, r.result.rows.slice());
  }
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
// ---- TASK-501: edit / paste / toolbar wiring ------------------------------

/** Format a data cell value. csvMode off → formatted (formatCell, the
 *  default display); csvMode on → raw (toString, so a Date renders as the
 *  Date object's toString rather than an ISO string). */
function formatDataCell(v: unknown): string {
  if (csvMode) {
    if (v === null || v === undefined) return "";
    return String(v);
  }
  return formatCell(v);
}

/** Dispatch a paste payload from the OS clipboard. The browser's
 *  ClipboardEvent carries text on `clipboardData.getData("text/plain")` for
 *  plain-text paste. We parse TSV, clip to grid bounds, and mark each
 *  in-bounds cell dirty. AG Grid doesn't fire its own cellValueChanged for
 *  programmatic pastes — we apply the rowData change and call
 *  `refreshClientSideRowModel()` so the grid reflects the new values.
 *
 * Column mapping uses `currentSpecs` (the immutable spec ordering captured
 * at renderGrid time), NOT `gridApi.getColumnDefs()` — a column drag-reorder
 * would shift the live getColumnDefs order and break colIndex ↔ field
 * mapping for any handler that wrote through it (R2 finding #1).
 */
function onGridPaste(ev: ClipboardEvent): void {
  // Paste into a filter input is the user's local typing — do not treat
  // it as a grid edit. The capture-phase wrapper checks ev.target first
  // so the event still bubbles to native input handling below.
  if (isFilterInput(ev.target)) return;
  const text = ev.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  if (!gridApi) return;
  ev.preventDefault();
  ev.stopPropagation();
  const parsed = parseTsvPaste(text);
  if (parsed.length === 0) return;
  // Anchor at the focused cell; fall back to (0,0). We use the row's
  // STABLE identity (__rowId) — display rowIndex would shift with sort/
  // filter and would misaddress the same row on every re-render.
  const focused = gridApi.getFocusedCell();
  const anchorDisplayIndex = focused?.rowIndex ?? 0;
  // Resolve the focused column's STABLE index via currentSpecs — not via
  // live getColumnDefs. Column drag-reorder shifts getColumnDefs order
  // but currentSpecs still represents the original spec ordering, so
  // anchorCol always maps to the right underlying column.
  const focusedColField = focused?.column?.getColId?.();
  const anchorCol = focusedColField
    ? Math.max(0, currentSpecs.findIndex((s) => s.field === focusedColField))
    : 0;
  if (anchorCol < 0) return;
  const colCount = currentSpecs.length;
  // Resolve paste targets by DISPLAY SEQUENCE from the anchor (Excel
  // semantics) instead of dense `anchorRowId + r` arithmetic. After Add
  // Row + stream the id namespace has holes and bumps so the dense
  // formula misaddressed cells AND wrote into local blank rows whose
  // pending-insert marker would be silently overwritten (R3 finding
  // #2). We stop at the bottom edge (no node) AND skip locally-added
  // rows — they have no entry in serverIndexByRowId (no server-truth
  // source). Pasting past a local row would corrupt the marker that
  // TASK-503 reads to generate INSERT statements.
  const targetRowIds: number[] = [];
  const targetNodes: Array<{ id: number; data: Record<string, unknown> }> = [];
  for (let r = 0; r < parsed.length; r++) {
    const node = gridApi.getDisplayedRowAtIndex(anchorDisplayIndex + r);
    if (!node?.data) break; // bottom edge
    const id = readRowId(node.data);
    if (id === undefined) continue;
    if (serverIndexByRowId.get(id) === undefined) break; // local row — stop
    targetRowIds.push(id);
    targetNodes.push({ id, data: node.data });
  }
  applyPasteToDirty(
    editState,
    0,
    anchorCol,
    parsed,
    colCount,
    targetRowIds.length,
    targetRowIds,
  );
  // Apply the paste to the live grid by mapping each parsed cell onto
  // the precomputed nodes — same order as the applyPasteToDirty call
  // above. Column field lookup uses currentSpecs (stable ordering) —
  // NOT live getColumnDefs.
  for (let r = 0; r < targetNodes.length; r++) {
    const ref = targetNodes[r];
    const row = parsed[r];
    for (let c = 0; c < row.length; c++) {
      const targetCol = anchorCol + c;
      if (targetCol < 0 || targetCol >= colCount) continue;
      const spec = currentSpecs[targetCol];
      if (!spec) continue;
      ref.data[spec.field] = row[c];
    }
  }
  gridApi.refreshCells({ force: true });
  updateFooterNow();
}
/** Refresh button: visual noop reset of dirty state + re-post the current
 *  state to the host so the host's "saved" snapshot matches. */
function onRefreshClick(): void {
  editState.clear();
  // No-op for the host today — TASK-503 will define the host message; for
  // now this just clears the local dirty map (which is the user-visible
  // "reset" semantics).
  updateFooterNow();
}
/** Add Row: append a real blank row to the grid. The row gets a stable
 *  __rowId past every id we have ever allocated (server OR local) — the
 *  high-water mark `highestAllocatedId` is bumped below and re-read by
 *  append-delta on the next streaming grow so the two id spaces never
 *  collide (R2 finding #2). */
function onAddRowClick(): void {
  if (!gridApi) return;
  // Allocate past every id the grid has ever seen — server-truth AND
  // locally-added. baseRows + newRowCount was the old formula and
  // collided with append-delta during streaming (probe: 3 rows + Add
  // Row + grow to 5 server rows produced duplicate id 3).
  const newRowId = highestAllocatedId + 1;
  highestAllocatedId = newRowId;
  const cols = gridApi.getColumnDefs() as Array<{ field?: string }> | undefined;
  // Blank row object: every spec column is "", with __rowId set so
  // the grid's stable identity layer can resolve it for edits/undo.
  const blank: Record<string, unknown> = { __rowId: newRowId };
  for (const col of cols ?? []) {
    if (col.field && col.field !== "__rowId") blank[col.field] = "";
  }
  gridApi.applyTransaction({ add: [blank] });
  newRowCount++;
  // Mark this row pending insert in EditState. The marker is a small
  // array of blank values (one per column) so TASK-503 can see "this
  // is a new row, generate an INSERT for it" without parsing magic
  // strings — the snapshot entry also includes colIndex 0 .. colCount-1
  // as blank cells the user will fill via cellValueChanged.
  editState.markDirty(
    newRowId,
    0,
    { __vsdb_new_row__: true, __rowId: newRowId, values: blank },
    undefined,
  );
  updateFooterNow();
}

/** Delete Row: mark the currently focused row as deleted in local edit
 *  state. TASK-503 will translate the snapshot into a DELETE statement.
 *  Uses the row's STABLE id (node.data.__rowId) so display-order changes
 *  cannot misaddress the deletion. */
function onDeleteRowClick(): void {
  if (!gridApi) return;
  const focused = gridApi.getFocusedCell();
  const focusedNode = focused?.rowIndex !== undefined
    ? gridApi.getDisplayedRowAtIndex(focused.rowIndex) ?? null
    : null;
  const rowId = readRowId(focusedNode?.data);
  if (rowId === undefined) return;
  editState.markDirty(rowId, 0, { __vsdb_deleted__: true, __rowId: rowId }, undefined);
  updateFooterNow();
}

/** Undo: pop the last dirty cell from EditState and revert its grid cell.
 *  Resolves the field via currentSpecs (stable column ordering — column
 *  drag-reorder would shift getColumnDefs order) and the row via the
 *  grid's __rowId (stable row identity — sort/filter would shift
 *  displayed row index). */
function onUndoClick(): void {
  if (!gridApi) return;
  const popped = editState.undo();
  if (!popped) return;
  const spec = currentSpecs[popped.colIndex];
  if (!spec) return;
  const node = gridApi.getRowNode(String(popped.rowId));
  if (!node?.data) return;
  // Resolve the server-truth source row via the stable __rowId → source-
  // index map. After Add Row + stream, a streamed row's __rowId is past
  // the source-array length, so the old `r.result.rows[popped.rowId]`
  // returned the wrong row's value. The map is populated in
  // rowsToObjects and cleared in the two reset branches (R3 finding #1).
  // Locally-added rows have no entry → si is undefined → no revert.
  const r = results[activeTab];
  const si = serverIndexByRowId.get(popped.rowId);
  const serverRow = si !== undefined ? r?.result?.rows?.[si] : undefined;
  // Distinguish NULL from MISSING — `serverRow` exists iff the row is
  // server-truth. A NULL cell value is a LEGITIMATE old value that must
  // be restored as null on undo (the most common SQL edge case: a cell
  // is null on disk, the user edits to "EDITED", then undoes — the
  // grid cell must return to null, not stay "EDITED" or become "").
  // The buggy `serverOld ?? node.data[spec.field] ?? ""` conflated
  // null with absent because `null ?? anything` returns anything (R2
  // finding #3).
  if (serverRow !== undefined) {
    node.data[spec.field] = serverRow[popped.colIndex];
  }
  // Locally-added rows have no server-row twin; leave the cell as-is —
  // the user added the row, there is no "original" to revert to.
  gridApi.refreshCells({ force: true });
  updateFooterNow();
}

/** TASK-503 — Commit: post a single saveEdits batch with every dirty cell.
 *
 *  - No-op (no postMessage) when dirtyCount === 0 — the keyboard shortcut
 *    and the button stay silent when there is nothing to save.
 *  - Batched: edits for many rows / many cells ship in ONE postMessage
 *    so the host can wrap them in a single transaction.
 *  - The host reads `tableName` + `pkColumns` from the statement's parsed
 *    metadata (the extension sets these in the state payload). Without
 *    metadata (tableName=null, pkColumns=[]) the host falls back to
 *    no-PK semantics — for postgres it fetches ctids, for mysql/mssql
 *    it returns `{ok:false, reason:'no_pk'}` which we render in the banner.
 *  - The banner is hidden on entry (success carries no banner copy).
 */
function onCommitClick(): void {
  if (editState.dirtyCount === 0) return;
  const edits = editState.snapshot();
  // tableName / pkColumns are derived on the host from the SELECT metadata
  // parsed out of the original SQL (extension.ts has the parsed statement).
  // Until that's wired through the state message we send empty hints —
  // the host then falls back to its own parser / listColumns lookup.
  postToHost({
    type: "saveEdits",
    index: activeTab,
    edits,
    tableName: null,
    pkColumns: [],
  });
  // While the host is processing, hide any previous banner. Re-shown if
  // the host returns an error.
  if (dom?.saveBanner) {
    dom.saveBanner.classList.add("vsdb-hidden");
    dom.saveBanner.setAttribute("hidden", "");
    dom.saveBanner.textContent = "";
  }
}

/** TASK-504 — Re-Run click: post a requery to the host with the current
 *  WHERE / ORDER BY values. The host composes the SQL via composeRequery
 *  and runs it through the QueryRunner, then posts a fresh state message
 *  that re-renders the grid. */
function onRequeryClick(): void {
  if (!dom) return;
  const where = dom.requeryWhere.value;
  const orderBy = dom.requeryOrderBy.value;
  postToHost({ type: "requery", index: activeTab, where, orderBy });
}

/** CSV toggle: flip csvMode and rebuild the valueFormatter on every visible
 *  data column so the user sees raw values vs formatted. */
function onCsvToggleClick(): void {
  csvMode = !csvMode;
  if (!gridApi) return;
  const cols = gridApi.getColumnDefs() as
    | Array<{ field?: string; valueFormatter?: unknown }>
    | undefined;
  if (!cols) return;
  const next = cols.map((c) => ({
    ...c,
    valueFormatter: (p: { value: unknown }) => formatDataCell(p.value),
  }));
  gridApi.setGridOption("columnDefs", next);
}

/** TASK-502 — read the current export settings from the toolbar and the
 * active statement result. Returns null if no statement is rendered. */
function readExportInput():
  | {
      format: ExportFormat;
      includeHeader: boolean;
      columns: string[];
      rows: unknown[][];
      pkColumns: string[];
      tableName: string;
      selectedRows: unknown[][];
    }
  | null {
  if (!dom) return null;
  const select = dom.exportFormat;
  const headerCb = dom.exportHeader;
  const format = select.value as ExportFormat;
  const includeHeader = headerCb.checked;
  const r = currentStatement;
  if (!r || !r.result) return null;
  // sql-where uses the grid's selection (rendered model + AG Grid selection);
  // other formats always use the statement rows (full result set).
  const selected: unknown[][] = [];
  if (format === "sql-where" && gridApi) {
    const selNodes = gridApi.getSelectedRows() as Array<Record<string, unknown>>;
    if (selNodes.length > 0) {
      for (const obj of selNodes) {
        const row: unknown[] = [];
        for (const s of currentSpecs) {
          row.push(obj[s.field]);
        }
        selected.push(row);
      }
    }
  }
  return {
    format,
    includeHeader,
    columns: r.result.columns,
    rows: r.result.rows,
    pkColumns: [],
    tableName: "results",
    selectedRows: selected,
  };
}

function onExportCopyClick(): void {
  const input = readExportInput();
  if (!input) return;
  // Fix R1: serializeExport is contracted to never throw (R1 makes
  // serializeSqlUpdates degrade safely on empty PK), but defensive
  // logging is cheap and protects against future regression.
  try {
    const text = serializeExport(
      input.format,
      input.columns,
      input.rows,
      {
        includeHeader: input.includeHeader,
        tableName: input.tableName,
        pkColumns: input.pkColumns,
        selectedRows: input.selectedRows,
      },
    );
    postToHost({ type: "copy", text });
  } catch (err) {
    console.error("vsdb export copy failed:", err);
  }
}
function onExportFileClick(): void {
  const input = readExportInput();
  if (!input) return;
  // Same defensive contract as onExportCopyClick — see comment there.
  try {
    const text = serializeExport(
      input.format,
      input.columns,
      input.rows,
      {
        includeHeader: input.includeHeader,
        tableName: input.tableName,
        pkColumns: input.pkColumns,
        selectedRows: input.selectedRows,
      },
    );
    postToHost({ type: "exportFile", format: input.format, text });
  } catch (err) {
    console.error("vsdb export file failed:", err);
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

/** TASK-503 — handle `saveResult` ack from the host.
 *
 *  - ok:true (default)         → clear editState, hide banner.
 *  - ok:true && refused:true   → clear editState, show `reason` banner
 *                                 (mysql/mssql no-PK; nothing to retry)
 *  - ok:false                  → KEEP editState (user retries), show errors
 *                                 in the banner.
 */
function handleSaveResult(msg: SaveResultMsg): void {
  const banner = dom?.saveBanner;
  if (msg.ok) {
    editState.clear();
    if (banner) {
      banner.classList.add("vsdb-hidden");
      banner.setAttribute("hidden", "");
      banner.textContent = "";
    }
    if (msg.refused && msg.reason && banner) {
      banner.classList.remove("vsdb-hidden");
      banner.removeAttribute("hidden");
      banner.textContent = msg.reason;
    }
  } else {
    const errs = msg.errors ?? ["Unknown save error"];
    if (banner) {
      banner.textContent = errs.join(" · ");
      banner.classList.remove("vsdb-hidden");
      banner.removeAttribute("hidden");
    }
    // edit state preserved; user can retry after fixing.
  }
  updateFooterNow();
}

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
  } else if (msg.type === "saveResult") {
    handleSaveResult(msg);
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
  get editState(): EditState {
    return editState;
  },
  addRow: onAddRowClick,
  deleteRow: onDeleteRowClick,
  refresh: onRefreshClick,
  toggleCsv: onCsvToggleClick,
  undo: onUndoClick,
  commit: onCommitClick,
  simulateCellEdit,
};

