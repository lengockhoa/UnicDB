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
  type CellDoubleClickedEvent,
  type CellStyle,
  type ColumnState,
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
  buildSetFilterEntries,
  setFilterPass,
  selectedKeysFromModel,
  SET_FILTER_BLANKS_KEY,
  SET_FILTER_BLANKS_DISPLAY,
  isBlankFilterValue,
  type SetFilterEntry,
  type ColumnSpec,
  type ResultsGridModel,
  type ExportFormat,
} from "../src/ui/resultsGridModel";
import { UndoStack } from "../src/ui/undoStack";
import { highlightSql } from "./sqlHighlight";

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
interface TransactionStatusMsg {
  type: "transactionStatus";
  open: boolean;
}

interface SaveResultMsg {
  type: "saveResult";
  index: number;
  ok: boolean;
  errors?: string[];
  /** Non-fatal per-row warnings from the host's save operation. */
  warnings?: string[];
  /** Soft refusal (mysql/mssql no-PK) — `ok` will be true so the dirty
   *  map clears; `reason` is the banner copy. */
  refused?: boolean;
  reason?: string;
  /** TASK-007 — per-row error report. When the host runs each generated
   *  UPDATE/INSERT/DELETE statement and at least one fails, it pairs the
   *  failing row's stable id with the driver error string so the webview
   *  can KEEP that row's edits dirty (for retry) while clearing the
   *  successful rows. Older hosts (pre-T7) don't send this — webview
   *  then falls back to "N rows failed" general banner. */
  rowErrors?: Array<{ rowId: number; error: string }>;
}

type HostMsg = StateMsg | BusyMsg | SaveResultMsg | TransactionStatusMsg;


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
  /** TASK-007 — per-table tab label (e.g. "public.users" from a schema-tree
   *  browse). Absent/empty → "Statement N" fallback. */
  label?: string;
}
/** TASK-005 — structural mirror of the host's ColumnFilterModel
 *  (src/ui/queryComposer.ts), defined locally so the webview program never
 *  pulls queryComposer/saveStatements across tsconfig.webview rootDir
 *  (per-file tsc error counts must stay byte-identical to the baseline).
 *  `values` = display text; `typed[i]` = raw value behind `values[i]`,
 *  ignored by the host unless typed.length === values.length. */
type ServerFilterModel = {
  [field: string]: { values: string[]; typed?: unknown[] };
};
type RequeryMsg = {
  type: "requery";
  index: number;
  where: string;
  orderBy: string;
  /** TASK-005 — server-side set-filter model (display values + optional
   *  typed raw values). Omitted when no column filter is active. */
  filters?: ServerFilterModel;
  /** 0-based row offset for a paged server-side requery ("Load More"). */
  offset?: number;
  /** Page size; omitted ⇒ host adapter default batch. */
  limit?: number;
  /** true ⇒ append the fresh page onto existing rows. */
  append?: boolean;
};
type SaveEditsMsg = {
  type: "saveEdits";
  index: number;
  edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
  tableName: string | null;
  pkColumns: string[];
  /** cycle T / TASK-002 (A12): __rowId → index into the host's
   *  result.rows. Keys are stringified numbers (JSON). Absent ⇒ host
   *  falls back to rowId. */
  serverIndexByRowId?: Record<string, number>;
};
type RetryFailedRowsMsg = {
  /** TASK-005 / A19 — "Retry failed rows" click after a partial save
   *  failure. Carries ONLY the failed rows' still-dirty edits; the host
   *  rebuilds a save batch from just those rows. */
  type: "retryFailedRows";
  index: number;
  rowIds: number[];
  edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
  serverIndexByRowId?: Record<string, number>;
};
type WebviewMsg =
  | LoadMoreMsg
  | CancelMsg
  | CopyMsg
  | ExportFileMsg
  | SaveEditsMsg
  | RetryFailedRowsMsg
  | RequeryMsg
  | RequestDistinctValuesMsg
  | ReadyMsg;

// ---- TASK-003: distinct-value round trip (host → webview mirror) ----------

/** Host reply carrying a column's DISTINCT values. Additive: an older bundle
 *  ignores the unknown `type`. Mirrored structurally here — a `../src/...`
 *  import would add a third TS6059 rootDir error to the per-file tsc gate. */
interface DistinctValuesMsg {
  type: "distinctValues";
  /** Statement index the values belong to. */
  index: number;
  /** Field name. */
  column: string;
  /** Raw DB values, may contain null. */
  values: unknown[];
  /** true ⇒ more values exist than were returned. */
  truncated: boolean;
  /** present ⇒ values is empty, keep the loaded-row fallback. */
  error?: string;
}

/** Webview → host: ask for a column's DISTINCT values (TASK-004 handles). */
type RequestDistinctValuesMsg = {
  type: "requestDistinctValues";
  index: number;
  column: string;
};

// ---- Row-marker sentinels (cycle T / TASK-002) -----------------------------
// Add Row / Delete Row use a dedicated marker colIndex so they never collide
// with a real cell edit's colIndex 0 in EditState's `${rowId}:${colIndex}`
// dirty map. Declared locally here (not imported from
// src/core/saveStatements.ts) this wave — see task Interfaces section.
const MARKER_COL_INSERT = -1;
const MARKER_COL_DELETE = -2;
/** Sentinel used to fill untouched cells in a new-row marker's `values`
 *  array. A plain object literal (not `undefined` — arrays serialize it to
 *  `null` on the wire — nor a magic string that could collide with real
 *  data). */
const DEFAULT_CELL = { __vsdb_default__: true } as const;


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
/** TASK-005 — debounce timer for the server-side filter requery. Rapid
 *  filter changes collapse into one post (the debounce window). */
let filterRequeryTimer: ReturnType<typeof setTimeout> | null = null;
const FILTER_REQUERY_DEBOUNCE_MS = 150;
/** TASK-003 — DISTINCT-value cache, keyed by `(statement index, column)`.
 *  Holds the raw DB values the host returned so (a) the set filter can list
 *  values beyond the loaded window and (b) buildServerFilterModel can attach
 *  `typed[]` for values no loaded row carries. Cleared whenever `render()`
 *  replaces the statement (a cached list from the previous statement at the
 *  same index is wrong data, not stale-but-harmless). */
const distinctByColumn = new Map<string, unknown[]>();
/** TASK-003 — identity token of the statement the cache was filled for.
 *  `distinctValues` replies carrying a token other than the current one are
 *  dropped (stale in-flight reply for a replaced statement). */
let distinctStatementToken = 0;
/** TASK-003 — bumped on every state message whose active statement identity
 *  changed; names the cache generation. */
let statementGeneration = 0;
/** TASK-003 — true while applying HOST-driven column state (sort restore).
 *  onSortChanged fires for programmatic applyColumnState too; without this
 *  guard a host state restore would post a requery → re-render → restore →
 *  post loop. Set immediately before applyColumnState, cleared in finally. */
let suppressSortRequery = false;
/** TASK-003 — last statement identity string the DISTINCT cache was filled
 *  for; a change on a state message invalidates the cache. */
let lastStatementIdentity = "none";
/** Local edit state — pure-logic dirty map. Cleared on tab switch / new query.
 *  TASK-503 will read `editState.snapshot()` to build the save payload. */
let editState = new EditState();
/** TASK-008 — Unified Excel-like undo/redo stack. Mirrors editState but
 *  spans cell-edits, add-row and delete-row through one LIFO branch.
 *  Cleared after a successful saveResult commit (DB has already
 *  written; undo past that is out of scope) and on tab switch / new
 *  query alongside editState.clear(). */
let undoStack = new UndoStack();
/** TASK-005 / A19 — last partial-save failure record: which statement and
 *  which rowIds failed. Drives the "Retry failed rows" button in the save
 *  banner; set when a saveResult ack carries rowErrors (per-row partial
 *  failure) and cleared on any ack WITHOUT rowErrors (full success,
 *  refusal, or all-failed — those have no per-row subset, and the Commit
 *  button already retries everything). Also implicitly disarmed when the
 *  failed rows' edits are gone: onRetryFailedRowsClick no-ops on an empty
 *  filtered snapshot. */
let lastFailedRows: { index: number; rowIds: number[] } | null = null;
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
  // TASK-008 — push the cell-edit onto the unified undo stack. The stack
  // itself coalesces consecutive edits to the SAME (rowId, colIndex)
  // so one keystroke per character doesn't grow the stack unboundedly
  // (parity with EditState.markDirty's in-place coalesce).
  undoStack.push({
    kind: "cell-edit",
    rowId,
    colIndex,
    oldValue: e.oldValue,
    newValue: e.newValue,
  });
  // TASK-007: re-run cellClassRules for this cell so `vsdb-cell-dirty`
  // paints immediately. AG Grid only re-evaluates class rules when the
  // cell is refreshed (cellValueChanged alone doesn't trigger it).
  if (e.node && gridApi) {
    gridApi.refreshCells({ rowNodes: [e.node], force: true });
  }
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
  // for typing but the handler does not call it. Pass the REAL node so
  // TASK-007's `refreshCells({ rowNodes: [e.node], force: true })`
  // reaches AG Grid — a plain `{ data }` shim is silently ignored by
  // refreshCells (no `id`, no internal RowNode bookkeeping).
  const fakeEvent = {
    api: gridApi,
    node,
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
  /** TASK-008 — Redo: replay the most-recently-undone action. Mirrors
   *  undoBtn — sits next to it in the toolbar; disabled when redo
   *  branch is empty. */
  redoBtn: HTMLButtonElement;
  /** Hidden until the host reports a manual transaction is open. */
  transactionControls: HTMLSpanElement;
  commitTransactionBtn: HTMLButtonElement;
  rollbackTransactionBtn: HTMLButtonElement;
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
  /** Persistent grid wrap that contains requeryBar + gridHost + gridFooter
   *  + saveBanner (TASK-005 — requery bar moved above the grid host).
   *  Created once; re-attached to `panel` on every grid render. */
  gridWrap: HTMLDivElement;
  /** Persistent grid host that holds the AG Grid table. */
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
/** Host-owned transaction state; true only for an active manual window. */
let transactionOpen = false;

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
  // Keep legacy toolbars byte-for-byte structurally unchanged until manual
  // mode actually opens a transaction. Several consumers inspect toolbar
  // children, and hidden controls should not change their default layout.
  if (transactionOpen && !dom.transactionControls.parentElement) {
    dom.toolbar.insertBefore(dom.transactionControls, dom.csvToggleBtn);
  } else if (!transactionOpen && dom.transactionControls.parentElement) {
    dom.transactionControls.remove();
  }
  dom.commitTransactionBtn.disabled = busy;
  dom.rollbackTransactionBtn.disabled = busy;

  // Tabs — rebuild only the buttons (cheap; tabs length changes with results).
  rebuildTabs(dom.tabs);

  // Panel content — re-render based on active tab.
  renderActivePanel();
}
// TASK-603 — icon-button helper. Each toolbar/requery button is a 26px-tall
// square with an inline 16×16 SVG (stroke="currentColor") and a
// title+aria-label for screen readers. No visible text, no icon font.
function makeIconButton(
  className: string,
  title: string,
  svgPath: string,
  onClick: () => void,
  svgAttrs: string = "",
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `vsdb-btn ${className}`.trim();
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML =
    `<svg viewBox="0 0 16 16" width="16" height="16" ` +
    `xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" ` +
    `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false"` +
    (svgAttrs ? " " + svgAttrs : "") +
    `>${svgPath}</svg>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function makeToolbarSep(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "vsdb-toolbar-sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

// Per-button SVG paths. All paths fit the 0 0 16 16 viewBox; stroke or fill
// comes from the <svg> element (currentColor) so they adapt to the host
// button's color token. Each path keeps `currentColor` semantics.
const ICON_CANCEL =
  // stop (red X) — square with a centered X.
  '<rect x="3" y="3" width="10" height="10" rx="1" />' +
  '<path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" />';
const ICON_REFRESH =
  // circular arrow — arc with an arrowhead.
  '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />' +
  '<path d="M13.5 3.5 V6.5 H10.5" />';
const ICON_ADD_ROW =
  // plus above two row lines.
  '<path d="M8 3 V8 M5.5 5.5 H10.5" />' +
  '<path d="M3 11 H13" />' +
  '<path d="M3 13.5 H13" />';
const ICON_DELETE_ROW =
  // trash — lid + body + handle.
  '<path d="M3 5 H13" />' +
  '<path d="M5 5 V13 a1 1 0 0 0 1 1 h4 a1 1 0 0 0 1 -1 V5" />' +
  '<path d="M6 5 V3.5 a0.5 0.5 0 0 1 0.5 -0.5 h3 a0.5 0.5 0 0 1 0.5 0.5 V5" />' +
  '<path d="M6.8 7.5 V11.5" />' +
  '<path d="M9.2 7.5 V11.5" />';
const ICON_UNDO =
  // curved arrow left.
  '<path d="M3.5 8 H10 a3 3 0 0 1 0 6 H8" />' +
  '<path d="M3.5 5.5 L3.5 10.5 L6.5 8 Z" fill="currentColor" stroke="none" />';
const ICON_REDO =
  // curved arrow right — mirror of ICON_UNDO.
  '<path d="M12.5 8 H6 a3 3 0 0 0 0 6 H8" />' +
  '<path d="M12.5 5.5 L12.5 10.5 L9.5 8 Z" fill="currentColor" stroke="none" />';
const ICON_COMMIT =
  // check mark.
  '<path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />';
const ICON_ROLLBACK =
  // counter-clockwise return arrow.
  '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" />' +
  '<path d="M12.5 3.5 V6.5 H9.5" />';
const ICON_CSV =
  // small table grid.
  '<rect x="3" y="3" width="10" height="10" rx="1" />' +
  '<path d="M3 6.5 H13" />' +
  '<path d="M3 9.5 H13" />' +
  '<path d="M6 3 V13" />' +
  '<path d="M9.5 3 V13" />';
const ICON_COPY =
  // two overlapping rounded rects.
  '<rect x="4.5" y="4.5" width="8" height="8" rx="1" />' +
  '<path d="M3.5 11.5 V5 a1.5 1.5 0 0 1 1.5 -1.5 H11.5" />';
const ICON_EXPORT_FILE =
  // down arrow into a tray.
  '<path d="M8 3 V9.5" />' +
  '<path d="M5.5 7 L8 9.5 L10.5 7" />' +
  '<path d="M3 12 V13 a1 1 0 0 0 1 1 h8 a1 1 0 0 0 1 -1 V12" />';
const ICON_REQUERY =
  // play (right-pointing triangle).
  '<path d="M5 3.5 L12.5 8 L5 12.5 Z" fill="currentColor" stroke="none" />';
const ICON_CLEAR =
  // X (cross) — same shape family as Cancel but neutral.
  '<path d="M4.5 4.5 L11.5 11.5" />' +
  '<path d="M11.5 4.5 L4.5 11.5" />';

function buildPersistentDom(): PersistentDom {
  const header = document.createElement("div");
  header.className = "vsdb-header";

  const toolbar = document.createElement("div");
  toolbar.className = "vsdb-toolbar";

  // TASK-603 — all toolbar buttons are icon buttons (16×16 inline SVG,
  // currentColor stroke, title + aria-label, no visible text). Two
  // `.vsdb-toolbar-sep` dividers mark the query│edit│export groups. The
  // search input is the last child so flex-shrink keeps it compact while
  // the fixed-size icon buttons stay on a single non-wrapping row.

  // Query group
  const cancelBtn = makeIconButton(
    "vsdb-btn-danger",
    "Cancel",
    ICON_CANCEL,
    () => postToHost({ type: "cancel" }),
  );
  toolbar.appendChild(cancelBtn);

  const refreshBtn = makeIconButton(
    "",
    "Refresh — discard dirty edits and refresh the local grid view",
    ICON_REFRESH,
    () => onRefreshClick(),
  );
  toolbar.appendChild(refreshBtn);

  toolbar.appendChild(makeToolbarSep());

  // Edit group
  const addRowBtn = makeIconButton(
    "",
    "Add Row — append a blank row to the result (TASK-503 will save)",
    ICON_ADD_ROW,
    () => onAddRowClick(),
  );
  toolbar.appendChild(addRowBtn);

  const deleteRowBtn = makeIconButton(
    "",
    "Delete Row — mark the currently focused row as deleted (TASK-503 will save)",
    ICON_DELETE_ROW,
    () => onDeleteRowClick(),
  );
  toolbar.appendChild(deleteRowBtn);

  const undoBtn = makeIconButton(
    "",
    "Undo — undo the last cell edit",
    ICON_UNDO,
    () => onUndoClick(),
  );
  undoBtn.disabled = true;
  toolbar.appendChild(undoBtn);
  // TASK-008 — Redo button next to Undo (Excel toolbar order). Initially
  // disabled — `refreshUndoRedoButtons` keeps it in sync with the stack.
  const redoBtn = makeIconButton(
    "",
    "Redo — replay the most-recently-undone edit / row add / row delete",
    ICON_REDO,
    () => onRedoClick(),
  );
  redoBtn.disabled = true;
  toolbar.appendChild(redoBtn);

  // TASK-503 — Commit button (and Cmd/Ctrl+Enter keyboard shortcut).
  // Posts a single saveEdits batch with every dirty cell. No-op when the
  // dirty map is empty — we don't post a no-op message and don't disable
  // the button (the user can still trigger one; the handler short-circuits).
  const commitBtn = makeIconButton(
    "vsdb-commit",
    "Commit — save all dirty edits to the database (Cmd/Ctrl+Enter)",
    ICON_COMMIT,
    () => onCommitClick(),
  );
  toolbar.appendChild(commitBtn);

  // TASK-009 — controls are kept in an initially hidden wrapper so older
  // connections retain the exact toolbar structure until the host reports an
  // open manual transaction. This prevents commit/rollback actions from ever
  // being available outside that transaction window.
  const transactionControls = document.createElement("span");
  transactionControls.className = "vsdb-transaction-controls";
  const commitTransactionBtn = makeIconButton(
    "vsdb-transaction-commit",
    "Commit transaction",
    ICON_COMMIT,
    () => postToHost({ type: "commitTransaction" }),
  );
  const rollbackTransactionBtn = makeIconButton(
    "vsdb-transaction-rollback",
    "Rollback transaction",
    ICON_ROLLBACK,
    () => postToHost({ type: "rollbackTransaction" }),
  );
  transactionControls.append(commitTransactionBtn, rollbackTransactionBtn);

  const csvToggleBtn = makeIconButton(
    "",
    "CSV — toggle CSV preview (raw values vs formatted)",
    ICON_CSV,
    () => onCsvToggleClick(),
  );
  toolbar.appendChild(csvToggleBtn);

  toolbar.appendChild(makeToolbarSep());

  // Export group (format <select> + Header checkbox + Copy + Export-to-file)
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

  const exportCopyBtn = makeIconButton(
    "vsdb-export-copy",
    "Copy — copy serialized export to clipboard",
    ICON_COPY,
    () => onExportCopyClick(),
  );
  toolbar.appendChild(exportCopyBtn);

  const exportFileBtn = makeIconButton(
    "vsdb-export-file",
    "Export to file — save serialized export to a file",
    ICON_EXPORT_FILE,
    () => onExportFileClick(),
  );
  toolbar.appendChild(exportFileBtn);

  // searchInput is appended below (last child).

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
        // Preserve the event source so the server-side filter handler does
        // not mistake quick-search typing for a column-filter change.
        gridApi.onFilterChanged("quickFilter");
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
  // TASK-503 — Cmd/Ctrl+Enter commit shortcut. AG Grid surfaces no such
  // shortcut itself, so we wire it on the grid wrap. Fix R1: when focus is
  // in an editable text input (filter box, quick-search, etc.) we MUST NOT
  // capture the keystroke — that would swallow the user's local typing and
  // trigger a save unexpectedly. No-op when the dirty map is empty (see
  // onCommitClick).
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
  // TASK-008 — Cmd/Ctrl+Z (undo) + Cmd/Ctrl+Shift+Z (redo). Excel-style
  // shortcut; we listen on the grid wrap in capture phase so we run
  // before AG Grid's default browser handling. Skip when focus is in a
  // text input — the user is typing. Stop any active AG Grid edit first
  // so the new value lands in the cell BEFORE we undo (otherwise the
  // next edit could collide with the popped action).
  gridWrap.addEventListener(
    "keydown",
    (ev) => {
      if (isFilterInput(ev.target)) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (ev.key.toLowerCase() !== "z") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (gridApi && typeof gridApi.getEditingCell === "function" && gridApi.getEditingCell()) {
        gridApi.stopEditing();
      }
      if (ev.shiftKey) {
        onRedoClick();
      } else {
        onUndoClick();
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
  // TASK-504 / TASK-005 — WHERE/ORDER BY "Re-Run" bar. Sits inside the
  // persistent gridWrap ABOVE the grid host (directly under the top
  // toolbar/tabs, which are root-level siblings) so the filter inputs
  // live next to the toolbar instead of below the table. Scrolling
  // and re-render survival match the grid host. The bar is NEVER
  // recreated — only its inputs' values are read on click. A "Clear"
  // button resets both inputs.
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
  const requeryRunBtn = makeIconButton(
    "vsdb-requery-run",
    "Re-Run — re-run the active statement with the WHERE / ORDER BY filter",
    ICON_REQUERY,
    () => onRequeryClick(),
  );
  requeryBar.appendChild(requeryRunBtn);
  const requeryClearBtn = makeIconButton(
    "vsdb-requery-clear",
    "Clear — clear the WHERE and ORDER BY inputs",
    ICON_CLEAR,
    () => {
      requeryWhere.value = "";
      requeryOrderBy.value = "";
    },
  );
  requeryBar.appendChild(requeryClearBtn);
  gridWrap.appendChild(requeryBar);
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

  gridWrap.appendChild(saveBanner);



  return {
    header,
    toolbar,
    cancelBtn,
    refreshBtn,
    addRowBtn,
    deleteRowBtn,
    undoBtn,
    redoBtn,
    transactionControls,
    commitTransactionBtn,
    rollbackTransactionBtn,
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
    saveBanner,
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

/** TASK-007 — max characters of a per-table tab label before truncation. */
const TAB_LABEL_MAX = 40;

/** TASK-007 — per-statement tab title. Uses `r.label` (e.g. "public.users"
 *  set by the host when browsing table data via the schema tree) and falls
 *  back to the generic "Statement N" when the label is absent or empty.
 *  Labels longer than TAB_LABEL_MAX chars are truncated at exactly 40 chars
 *  + "..." so one long table name can't blow out the tab strip. The title
 *  is assigned via textContent (never innerHTML) so label text is always
 *  rendered as literal text — no XSS surface. */
function tabTitle(r: StatementResult, i: number): string {
  const label = typeof r.label === "string" ? r.label : "";
  if (label.length === 0) return `Statement ${i + 1}`;
  return label.length > TAB_LABEL_MAX
    ? label.slice(0, TAB_LABEL_MAX) + "..."
    : label;
}

function rebuildTabs(tabsEl: HTMLDivElement): void {
  tabsEl.innerHTML = "";
  results.forEach((r, i) => {
    const tab = document.createElement("button");
    tab.className = "vsdb-tab" + (i === activeTab ? " vsdb-tab-active" : "");
    if (r.status === "error") tab.classList.add("vsdb-tab-error");
    if (r.status === "cancelled") tab.classList.add("vsdb-tab-cancelled");
    tab.textContent = `${tabTitle(r, i)} ${tabBadge(r)}`;
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
  // Restore grid visibility after a previous teardownGridWrap() call set
  // `display: none`. The CSS class `.vsdb-grid-host` defines `display: flex`
  // — clearing the inline value lets the stylesheet govern again so the grid
  // is visible when the statement tab is active (fix for the 6ebe1a2
  // regression where the wrap stayed hidden on first real use).
  dom.gridWrap.style.display = "";
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

 // ---- TASK-602: SetFilterComponent ------------------------------------------
// Excel-style checkbox set-filter replacing the TASK-402 text/number filter.
// Implements AG Grid's IFilterComp interface for v36 Community: init,
// getGui, isFilterActive, doesFilterPass, getModel, setModel. Model
// shape: `{ values: string[] }` (display strings; "(Blanks)" literal for
// blanks) or `null` when inactive.
//
// Counts and entry lists are derived from the CURRENTLY LOADED rows via
// `buildSetFilterEntries` (TASK-601 helper) — see plan-review note about
// accepted under-count on partially-loaded batched results.
//
// Search input narrows the visible list; Select All toggles only visible
// entries (Excel parity). Live apply on every checkbox change — no Apply
// button. Footer-left status: "All" / "N of M"; footer-right Clear + Close.

/** Shape of the filter model produced + consumed by SetFilterComponent. */
interface SetFilterModel {
  values: string[];
}

/** AG Grid param shape this component reads (structural — see
 *  node_modules/ag-grid-community IFilterParams for full contract). */
interface SetFilterParams {
  getValue: (node: { data: unknown }) => unknown;
  api: GridApi;
  filterChangedCallback: () => void;
}

class SetFilterComponent {
  private params: SetFilterParams | null = null;
  private model: SetFilterModel | null = null;
  /** Current checkbox state, keyed by entry display. Always reflects every
   *  loaded value — even entries hidden by the search box keep their state
   *  (Select All toggles only the visible ones; the hidden ones survive). */
  private checked = new Set<string>();
  /** Last computed entries from `buildSetFilterEntries`. Recomputed on
   *  every `init` + after `setModel` to pick up the latest grid state. */
  private entries: SetFilterEntry[] = [];
  private searchText = "";

  private readonly root = document.createElement("div");
  private readonly searchInput = document.createElement("input");
  private readonly selectAllCheckbox = document.createElement("input");
  private readonly listEl = document.createElement("div");
  private readonly statusEl = document.createElement("span");
  private readonly clearBtn = document.createElement("button");
  private readonly closeBtn = document.createElement("button");

  constructor() {
    this.root.className = "vsdb-setfilter";
    this.searchInput.type = "search";
    this.searchInput.className = "vsdb-setfilter-search";
    this.searchInput.placeholder = "Search…";
    this.searchInput.addEventListener("input", () => this.onSearchChanged());
    this.selectAllCheckbox.type = "checkbox";
    this.selectAllCheckbox.className = "vsdb-setfilter-selectall";
    this.selectAllCheckbox.addEventListener("change", () =>
      this.onSelectAllChanged(),
    );
    this.listEl.className = "vsdb-setfilter-list";
    this.statusEl.className = "vsdb-setfilter-status";
    this.clearBtn.type = "button";
    this.clearBtn.className = "vsdb-setfilter-clear";
    this.clearBtn.textContent = "Clear";
    this.clearBtn.addEventListener("click", () => this.onClear());
    this.closeBtn.type = "button";
    this.closeBtn.className = "vsdb-setfilter-close";
    this.closeBtn.textContent = "Close";
    this.closeBtn.addEventListener("click", () => this.onClose());

    const searchRow = document.createElement("div");
    searchRow.className = "vsdb-setfilter-search-row";
    searchRow.appendChild(this.searchInput);

    const selectAllRow = document.createElement("div");
    selectAllRow.className = "vsdb-setfilter-selectall-row";
    const selectAllLabel = document.createElement("label");
    selectAllLabel.className = "vsdb-setfilter-selectall-label";
    selectAllLabel.appendChild(this.selectAllCheckbox);
    selectAllLabel.appendChild(document.createTextNode("Select All"));
    selectAllRow.appendChild(selectAllLabel);

    const footerRow = document.createElement("div");
    footerRow.className = "vsdb-setfilter-footer";
    footerRow.appendChild(this.statusEl);
    const footerRight = document.createElement("div");
    footerRight.className = "vsdb-setfilter-footer-right";
    footerRight.appendChild(this.clearBtn);
    footerRight.appendChild(this.closeBtn);
    footerRow.appendChild(footerRight);

    this.root.appendChild(searchRow);
    this.root.appendChild(selectAllRow);
    this.root.appendChild(this.listEl);
    this.root.appendChild(footerRow);
  }

  init(params: SetFilterParams): void {
    this.params = params;
    // TASK-003 — AG Grid v36 Community exposes no popup-open hook on
    // IFilterComp (init / afterGuiDetached only), so the DISTINCT request
    // fires from init: the component is created lazily on first popup open
    // (or first setFilterModel), which is the same instant the user first
    // sees the list. requestDistinctValues is cached per (index, column),
    // so re-opens never re-ask the host (task case 9).
    const colId = this.readColumnId();
    if (colId) requestDistinctValues(colId);
    this.recomputeEntries();
    this.applyCheckedFromModel();
    this.render();
    setFilterInstances.add(this);
  }

  /** TASK-003 — column this filter is mounted on, from the AG Grid params.
   *  Used both to key the DISTINCT request and to target refreshes. */
  private readColumnId(): string | null {
    const p = this.params as unknown as {
      column?: { getColId?: () => string };
      colDef?: { field?: string };
    } | null;
    if (p?.column && typeof p.column.getColId === "function") {
      return p.column.getColId();
    }
    return p?.colDef?.field ?? null;
  }

  /** TASK-003 — registry seam: distinct data for this column arrived. */
  getColumnId(): string | null {
    return this.readColumnId();
  }

  /** TASK-003 — re-derive entries (distinct cache first, loaded rows
   *  fallback) and re-render the list without touching the model. */
  refreshEntries(): void {
    this.recomputeEntries();
    this.render();
  }

  getGui(): HTMLElement {
    return this.root;
  }

  isFilterActive(): boolean {
    return this.model !== null;
  }

  doesFilterPass(params: {
    data: Record<string, unknown>;
    node: { data: Record<string, unknown> };
  }): boolean {
    if (this.model === null) return true;
    const value =
      params && params.data && Object.prototype.hasOwnProperty.call(params.data, "__rowId")
        ? this.readCellValue(params.data)
        : undefined;
    const keys = selectedKeysFromModel(this.entries, this.model.values);
    return setFilterPass(value, keys);
  }

  getModel(): SetFilterModel | null {
    return this.model;
  }

  setModel(model: SetFilterModel | null | undefined): void {
    if (model === null || model === undefined) {
      this.model = null;
    } else if (
      typeof model === "object" &&
      "values" in model &&
      Array.isArray((model as { values: unknown }).values)
    ) {
      this.model = { values: [...(model as { values: string[] }).values] };
    } else {
      // Defensive: unrecognised payload (AG Grid may pass `undefined` during
      // filter-wrapper initialisation or a column swap) → deactivate the
      // filter rather than crash on `.values`.
      this.model = null;
    }
    this.recomputeEntries();
    this.applyCheckedFromModel();
    this.render();
  }
  destroy(): void {
    setFilterInstances.delete(this);
    this.params = null;
  }

  /** Triggered by AG Grid when the filter's host element is removed from
   *  the screen (popup close). We do NOT clear `model` here — Excel keeps
   *  the user's selections across close/reopen. */
  afterGuiDetached(): void {
    /* no-op */
  }

  /** Recompute entries. TASK-003: prefers the host's DISTINCT values (typed,
   *  covers rows beyond the loaded window) and falls back to scanning loaded
   *  rows while no reply has arrived (or on host error). Called on init +
   *  setModel + refreshEntries. */
  private recomputeEntries(): void {
    if (!this.params) {
      this.entries = [];
      return;
    }
    const colId = this.readColumnId();
    const distinct = colId ? distinctByColumn.get(`${activeTab}::${colId}`) : undefined;
    if (distinct) {
      this.entries = buildSetFilterEntries(distinct);
      return;
    }
    const values: unknown[] = [];
    this.params.api.forEachNode((node) => {
      if (!node.data) return;
      values.push(this.readCellValue(node.data as Record<string, unknown>));
    });
    this.entries = buildSetFilterEntries(values);
  }

  private readCellValue(data: Record<string, unknown>): unknown {
    if (!this.params) return undefined;
    // Reuse the grid-provided getValue to honour colDef.valueGetter /
    // valueFormatter overrides if any are added later.
    return this.params.getValue({
      data,
    } as unknown as { data: unknown });
  }

  /** Sync the per-display checkbox Set to match `model.values`. Empty
   *  model = ALL selected (Excel's "no filter" state — visually all
   *  boxes are checked, model is null/inactive). */
  private applyCheckedFromModel(): void {
    this.checked.clear();
    if (this.model === null || this.model.values.length === 0) {
      // No filter active (Excel shows every box UNCHECKED; status reads
      // "All"). User opts in to specific values; commit() then emits the
      // active subset.
      return;
    }
    for (const v of this.model.values) this.checked.add(v);
  }

  /** Re-render the list + status from current `entries`, `checked`,
   *  `searchText`. Preserves checkbox state for hidden entries. */
  private render(): void {
    const needle = this.searchText.trim().toLowerCase();
    this.listEl.innerHTML = "";
    let visibleCount = 0;
    let checkedVisibleCount = 0;

    for (const entry of this.entries) {
      const row = document.createElement("label");
      row.className = "vsdb-setfilter-entry";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "vsdb-setfilter-entry-checkbox";
      cb.checked = this.checked.has(entry.display);
      cb.addEventListener("change", () =>
        this.onEntryChanged(entry.display, cb.checked),
      );
      const label = document.createElement("span");
      label.className = "vsdb-setfilter-label";
      label.textContent = entry.display;
      const count = document.createElement("span");
      count.className = "vsdb-setfilter-count";
      count.textContent = String(entry.count);
      // Right-align within a flex row — same effect as the CSS
      // `.vsdb-setfilter-count { margin-left: auto }` rule, applied
      // inline so jsdom-based tests can assert the computed value
      // (jsdom doesn't apply external stylesheets).
      count.style.marginLeft = "auto";
      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(count);
      const matches =
        needle === "" || entry.display.toLowerCase().includes(needle);
      if (!matches) {
        row.classList.add("vsdb-setfilter-entry-hidden");
      } else {
        visibleCount += 1;
        if (cb.checked) checkedVisibleCount += 1;
      }
      this.listEl.appendChild(row);
    }

    // Status: "All" when no filter active (model === null OR values empty),
    // "N of M" when a subset is checked (active filter), "None" when the
    // user has unchecked everything (filter is active but shows 0 rows).
    const total = this.entries.length;
    if (total === 0) {
      this.statusEl.textContent = "All";
    } else if (this.checked.size === 0) {
      this.statusEl.textContent = `${total} of ${total}`;
    } else if (this.checked.size === total) {
      this.statusEl.textContent = "All";
    } else {
      this.statusEl.textContent = `${this.checked.size} of ${total}`;
    }

    // Select All checkbox state: checked if every VISIBLE entry is
    // checked; indeterminate if some visible are checked; unchecked
    // otherwise. Hidden entries don't influence the master toggle.
    if (visibleCount === 0) {
      this.selectAllCheckbox.checked = false;
      this.selectAllCheckbox.indeterminate = false;
    } else if (checkedVisibleCount === visibleCount) {
      this.selectAllCheckbox.checked = true;
      this.selectAllCheckbox.indeterminate = false;
    } else if (checkedVisibleCount === 0) {
      this.selectAllCheckbox.checked = false;
      this.selectAllCheckbox.indeterminate = false;
    } else {
      this.selectAllCheckbox.checked = false;
      this.selectAllCheckbox.indeterminate = true;
    }
  }

  private onSearchChanged(): void {
    this.searchText = this.searchInput.value;
    this.render();
  }

  private onEntryChanged(display: string, checked: boolean): void {
    if (checked) this.checked.add(display);
    else this.checked.delete(display);
    this.commit();
    this.render();
  }

  private onSelectAllChanged(): void {
    const needle = this.searchText.trim().toLowerCase();
    const visibleDisplays: string[] = [];
    for (const entry of this.entries) {
      const matches =
        needle === "" || entry.display.toLowerCase().includes(needle);
      if (matches) visibleDisplays.push(entry.display);
    }
    if (this.selectAllCheckbox.checked) {
      for (const d of visibleDisplays) this.checked.add(d);
    } else {
      for (const d of visibleDisplays) this.checked.delete(d);
    }
    this.commit();
    this.render();
  }

  private onClear(): void {
    this.model = null;
    this.checked.clear();
    // Restore "all checked" visual state — Excel shows every box ticked
    // when the filter is inactive.
    for (const e of this.entries) this.checked.add(e.display);
    this.params?.filterChangedCallback();
    this.render();
  }

  private onClose(): void {
    // AG Grid Community hosts custom-filter panels inside the column-menu
    // popup. The Close button must dismiss that popup — without
    // `hidePopupMenu()` the popup stays visible in the live webview.
    this.params?.api.hidePopupMenu();
  }

  /** Push the current checkbox state into the model + notify the grid. */
  private commit(): void {
    const total = this.entries.length;
    if (this.checked.size === total && total > 0) {
      // Every value selected → filter is a no-op. Excel reports the
      // filter as inactive in this state, so the grid shows all rows.
      this.model = null;
    } else {
      this.model = { values: Array.from(this.checked) };
    }
    this.params?.filterChangedCallback();
  }
}


/** Date-aware cell equality — `Date` objects compare by identity via `===`
 *  in a naive check, so two distinct Date instances holding the same
 *  instant would spuriously read as "changed". */
function cellsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

/** True when `a` and `b` (same-length raw row arrays, positionally aligned
 *  with the same statement's columns) hold at least one differing cell. */
function rowsDiffer(a: readonly unknown[][], b: readonly unknown[][]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (ra.length !== rb.length) return true;
    for (let j = 0; j < ra.length; j++) {
      if (!cellsEqual(ra[j], rb[j])) return true;
    }
  }
  return false;
}

function renderGrid(): void {
  if (!dom) return;
  // TASK-004 — the value viewer overlay is transient: any state re-render
  // (tab switch, new query, busy toggle) closes it and unbinds its
  // document-level listeners (the child-cleanup below would remove the
  // element, but not the listeners).
  closeValueViewer();
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

  // TASK-602: per-column Excel-style checkbox set filter (custom AG Grid
  // component class, not the v32 `agTextColumnFilter`/`agNumberColumnFilter`
  // — those were the TASK-402 text/number inputs we replaced). The panel
  // itself lives inside the column-menu popup, so the floating-filter row
  // is no longer needed and stays disabled.
  const baseCols = specs.map((spec) => {
    // colIndex in currentSpecs is the source-array index. We close over
    // it for the cellClassRules predicate so each column knows which
    // colIndex to ask EditState about.
    const colIndex = specs.findIndex((s) => s.field === spec.field);
    return {
      field: spec.field,
      headerName: spec.headerName,
      sortable: true,
      filter: SetFilterComponent,
      resizable: true,
      floatingFilter: false,
      // Forward `spec.hidden` to AG Grid `hide`. Any column flagged via
      // `hiddenColumns` on the export side mirrors here so the grid hides
      // it visually; the column stays in `colDefs` so save/serialize paths
      // can still index into `row[field]` when needed.
      hide: spec.hidden === true,
      // TASK-501: cells are editable (cellValueChanged → editState.markDirty).
      // valueFormatter is rebuilt when csvMode flips (toggleCsv) so the user
      // sees raw vs formatted values.
      editable: true,
      valueFormatter: (p: { value: unknown }) => formatDataCell(p.value),
      // TASK-004 — null/undefined cells render an italic muted "(NULL)"
      // placeholder. valueFormatter alone cannot attach a CSS class, so
      // this cellRenderer wraps the formatted display: null/undefined →
      // `<span class="vsdb-null">(NULL)</span>`; every other value → a
      // plain text span. Text is set via textContent (never innerHTML),
      // so cell content can never inject markup. Only the DISPLAY
      // changes — the underlying row data (and everything editors,
      // copy/export read through getValue) keeps the real null.
      cellRenderer: (p: {
        value?: unknown;
        valueFormatted?: string | null;
      }) => {
        const el = document.createElement("span");
        if (p.value === null || p.value === undefined) {
          el.className = "vsdb-null";
          el.textContent = "(NULL)";
          return el;
        }
        el.textContent = p.valueFormatted ?? formatDataCell(p.value);
        return el;
      },
      // TASK-007: cellClassRules paints `vsdb-cell-dirty` on a cell whose
      // (rowId, colIndex) is in the local EditState. The rule re-evaluates
      // when AG Grid calls `api.refreshCells({ rowNodes, force: true })` —
      // we trigger that from onCellValueChangedHandler, onAddRowClick, and
      // onDeleteRowClick so the highlight follows the user's edits live.
      cellClassRules: {
        "vsdb-cell-dirty": (params: {
          data?: Record<string, unknown> | undefined;
        }): boolean => {
          const data = params.data;
          if (!data) return false;
          const id = readRowId(data);
          if (id === undefined) return false;
          return editState.isCellDirty(id, colIndex);
        },
      },
      cellStyle:
        spec.kind === "number"
          ? {
              textAlign: "right" as const,
              fontVariantNumeric: "tabular-nums",
            }
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
    undoStack.clear();
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
      // TASK-007: getRowClass returns the row-level edit class. The
      // callback runs once per row render — cheap (two Map scans inside
      // EditState). We use the string form (single class) so we can
      // combine the new-row and deleted markers; AG Grid appends the
      // returned string to the row element's class list. The actual
      // CSS rules live in styles.css (`vsdb-row-new`,
      // `vsdb-row-deleted`).
      getRowClass: (params: {
        data?: Record<string, unknown> | undefined;
      }): string => {
        const data = params.data;
        if (!data) return "";
        const id = readRowId(data);
        if (id === undefined) return "";
        const classes: string[] = [];
        if (editState.isRowNew(id)) classes.push("vsdb-row-new");
        if (editState.isRowDeleted(id)) classes.push("vsdb-row-deleted");
        return classes.join(" ");
      },
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
      // A16: Ctrl/Cmd+C is bound in exactly one place — the gridWrap
      // capture-phase `keydown` listener above. `onCellKeyDown` used to
      // ALSO call copySelectionToHost(), causing a real Ctrl+C on a
      // focused cell to double-fire (capture-phase ancestor listener +
      // this grid-option callback both firing for the same keystroke).
      //
      // Keep `colFilterActive` in sync with grid state. Re-poll
      // `isColumnFilterPresent()` instead of trusting a stale bool — the
      // event source can be 'api' (programmatic setFilterModel) or 'ui'
      // (header / floating filter) and we want the gate to be accurate in
      // both cases. (See TASK-402 plan reviewer note.)
      onFilterChanged: (e: FilterChangedEvent) => {
        colFilterActive = e.api.isColumnFilterPresent();
        updateFooterNow();
        // TASK-007 — quick-filter changes are client-side only. A column
        // filter source still schedules even after clearing the last filter
        // (the live flag is false by then, but the server must reset).
        const columnFilterSource =
          e.source === "api" ||
          e.source === "columnFilter" ||
          e.source === "advancedFilter";
        if (columnFilterSource) scheduleFilterRequery();
      },
      // TASK-003 — header-click sort goes to the DATABASE, not the client.
      // Fires for UI clicks AND programmatic applyColumnState; the
      // suppressSortRequery guard (set by the host-driven restore seam)
      // keeps the programmatic path from re-posting. Reuses
      // postFilterRequery's payload shape so sort + filter + paging compose
      // instead of racing — the orderBy string replaces the requery-bar
      // text for this post only.
      onSortChanged: () => {
        if (suppressSortRequery) return;
        if (!gridApi) return;
        // Fix round: a sort landing inside the 150ms filter debounce must
        // supersede the pending timer — this post already carries the live
        // filter model, and letting the timer fire afterwards would post a
        // newer, sort-less requery right behind it (which the host treats
        // as the current query).
        if (filterRequeryTimer !== null) {
          clearTimeout(filterRequeryTimer);
          filterRequeryTimer = null;
        }
        const orderBy = orderByFromColumnState(gridApi);
        postFilterRequeryWithOrder(orderBy);
      },
      // TASK-004 — double-click value viewer for read-only cells. Editable
      // cells keep AG Grid's default double-click-to-edit; the handler
      // defers one tick and only opens the overlay when NO editor started.
      onCellDoubleClicked: onCellDoubleClickedHandler,
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
    refreshUndoRedoButtons();
  } else if (statementReset || columnsChanged || syncResult.isReset) {
    // New data for the same statement (e.g. statementReset on terminal
    // status, or columnsChanged). Drop stale dirty edits and any rows
    // the user added locally — they no longer make sense for a fresh
    // result set; the user must re-add via the Add Row button.
    editState.clear();
    undoStack.clear();
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
    refreshUndoRedoButtons();
  } else if (rowsGrew && newRowCount > 0 && editState.dirtyCount === 0) {
    // Finding 4 (review fix round, cycle T) — a post-commit refresh
    // (Add Row → type values → commit) grows r.result.rows by exactly
    // the committed rows, but the LOCAL placeholder row(s) added via
    // onAddRowClick are still sitting in the grid (append-delta below
    // only ADDS the new server row, it never removes/reconciles the
    // local placeholder). Left alone this leaves a phantom blank row
    // and `newRowCount` is never decremented, so a later save keeps
    // treating that phantom as dirty/new.
    //
    // Distinguishing this from ordinary "Add Row while streaming more
    // rows in" (R2-B/R3-A — a legitimate append-delta growth where the
    // added row is still DIRTY/uncommitted) is the `dirtyCount === 0`
    // guard: handleSaveResult's ok:true path clears editState/undoStack
    // the moment a commit succeeds, so dirtyCount can only be 0 here if
    // the locally-added row(s) were already committed and are now
    // orphaned placeholders — not live in-progress inserts colliding
    // with streamed content. With nothing dirty left to preserve, do a
    // full rebuild (same pattern as the isReset branch above) instead
    // of an append-delta, so the phantom placeholder is dropped and
    // newRowCount/highestAllocatedId/serverIndexByRowId are re-seeded
    // from the authoritative server rows.
    editState.clear();
    undoStack.clear();
    newRowCount = 0;
    serverIndexByRowId.clear();
    gridApi!.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    statementRows.set(activeTab, r.result.rows.slice());
    highestAllocatedId = r.result.rows.length - 1;
    refreshUndoRedoButtons();
  } else if (rowsGrew && newRowCount > 0) {
    // Finding 4, fix round 2 (partial commit) — the branch above only
    // fires when editState.dirtyCount === 0 (every dirty entry cleared).
    // On a PARTIAL commit (TASK-007 #4), handleSaveResult keeps dirty
    // entries for ERRORED rows via clearExceptRowIds(erroredRowIds) so
    // the user can retry them — leaving dirtyCount > 0 even though some
    // OTHER locally-added row(s) already committed successfully. That
    // skipped the branch above entirely, so a successfully-committed
    // row's local placeholder object survived in the grid as a phantom
    // blank row while `newRowCount` was never decremented for it.
    //
    // A full rebuild (like the branch above) is NOT safe here — it would
    // silently discard the still-dirty errored rows' pending edits
    // (data loss). Instead, surgically remove ONLY the placeholder rows
    // that have ALREADY committed: a locally-added row has no entry in
    // `serverIndexByRowId` (see the "local row — stop" comment
    // elsewhere in this file), and once its new-row marker is gone from
    // editState (cleared because it succeeded), `isRowNew` reads false.
    // Errored placeholders (still `isRowNew === true`) are left
    // completely untouched, so their pending edits are never lost. The
    // newly-committed server row(s) are then merged in via the same
    // append-delta the branch below uses for ordinary streaming growth.
    const committedPlaceholders: Record<string, unknown>[] = [];
    gridApi!.forEachNode((node) => {
      if (!node.data) return;
      const id = readRowId(node.data);
      if (id === undefined) return;
      if (serverIndexByRowId.get(id) !== undefined) return; // real server row
      if (editState.isRowNew(id)) return; // still dirty/new — errored, keep for retry
      committedPlaceholders.push(node.data);
    });
    let changed = false;
    if (committedPlaceholders.length > 0) {
      gridApi!.applyTransaction({ remove: committedPlaceholders });
      newRowCount = Math.max(0, newRowCount - committedPlaceholders.length);
      changed = true;
    }
    if (syncResult.appendDelta.length > 0) {
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
      changed = true;
    }
    if (changed) {
      statementRows.set(activeTab, r.result.rows.slice());
      refreshUndoRedoButtons();
    }
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
  } else if (
    !rowsGrew &&
    r.result.rows.length === previousRows.length &&
    rowsDiffer(r.result.rows, previousRows)
  ) {
    // A5 — same statement, same row count, but the server-truth values
    // differ from what's currently displayed (e.g. the host echoes back
    // authoritative rows right after a successful commit, or a Refresh
    // re-fetch returns changed data for an unchanged row count). Swap
    // rowData wholesale so the grid shows the fresh values. This is NOT a
    // "reset" — dirty/undo/local-row state is left alone; by the time a
    // commit's echo arrives, saveResult ok:true has already cleared
    // editState/undoStack via its own handler.
    gridApi!.setGridOption("rowData", rowsToObjects(r.result.rows, specs));
    statementRows.set(activeTab, r.result.rows.slice());
  }
  lastRenderedIndex = activeTab;
  lastResultStatus = r.status;

  // Initial footer text.
  updateFooterNow();

  // Expose the checkLoadMore hook on the grid host (so tests / external code
  // can trigger a loadMore programmatically).
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

/** Sentinel for "no loaded row carries this display value". */
const RAW_NOT_FOUND = Symbol("raw-not-found");

/** Build the server-side filter model from the grid's current filter model.
 *  For each filtered column, each selected display value is mapped back to a
 *  loaded row's RAW cell value (same normalization `selectedKeysFromModel`
 *  uses — lowercased String(v); "(Blanks)" resolves to the raw null/"" of a
 *  loaded blank row). `typed` is attached ONLY when EVERY selected value
 *  resolves — a stale selection (row scrolled past / evicted) degrades to
 *  the display-string-only model so `buildFilterWhere` quotes everything
 *  rather than emit a length-mismatched array. Returns undefined when no
 *  column has a non-empty selection (the host then re-queries unfiltered). */
function buildServerFilterModel(): ServerFilterModel | undefined {
  const api = gridApi;
  if (!api) return undefined;
  const gridModel = api.getFilterModel() as Record<
    string,
    { values?: string[] } | null
  >;
  const r = currentStatement;
  const rows = r?.result?.rows ?? [];
  const specs = currentSpecs;
  const out: ServerFilterModel = {};
  let anyActive = false;
  for (const [field, m] of Object.entries(gridModel)) {
    const values = m?.values;
    if (!Array.isArray(values) || values.length === 0) continue;
    const specIndex = specs.findIndex((s) => s.field === field);
    // TASK-003 — prefer the host's DISTINCT cache: it holds typed values for
    // rows beyond the loaded window (gap 3). Loaded rows remain the fallback.
    const distinct = distinctByColumn.get(`${activeTab}::${field}`);
    const typed: unknown[] = [];
    let allResolved = true;
    for (const display of values) {
      const key =
        display === SET_FILTER_BLANKS_DISPLAY
          ? SET_FILTER_BLANKS_KEY
          : String(display).toLowerCase();
      let raw: unknown = RAW_NOT_FOUND;
      if (distinct) {
        for (const v of distinct) {
          const blank = isBlankFilterValue(v);
          const rowKey = blank ? SET_FILTER_BLANKS_KEY : String(v).toLowerCase();
          if (rowKey === key) {
            raw = v;
            break;
          }
        }
      }
      if (raw === RAW_NOT_FOUND && specIndex >= 0) {
        for (const row of rows) {
          const v = row[specIndex];
          const blank = isBlankFilterValue(v);
          const rowKey = blank ? SET_FILTER_BLANKS_KEY : String(v).toLowerCase();
          if (rowKey === key) {
            raw = v;
            break;
          }
        }
      }
      if (raw === RAW_NOT_FOUND) {
        allResolved = false;
        break;
      }
      typed.push(raw);
    }
    out[field] = allResolved ? { values, typed } : { values };
    anyActive = true;
  }
  return anyActive ? out : undefined;
}

/** TASK-003 — bare SQL identifier per the host's parseOrderBy grammar.
 *  Matching colIds pass through UNQUOTED (byte-identical to cycle V);
 *  anything else (spaces, non-ASCII, digits-first, dots…) is quoted per
 *  dialect before it enters the orderBy string — the host rejects raw
 *  non-bare identifiers outright, which would be a user-visible regression
 *  versus today's client-side sort. */
const BARE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** SQL dialect parsed from the state header's driver token. `unknown` is the
 *  pre-parse default; quoting falls back to postgres double-quoting (the
 *  host's null-dialect composition) on unknown/no-connection headers. */
type SqlDialect = "postgres" | "mysql" | "mssql" | "unknown";

/** Parse the driver out of the state header the host builds as
 *  `Run at <ISO> — <driver>@<host>/<db>` (or `… — no connection`).
 *  Fix round: parse ONLY the driver token (between the em dash and the
 *  `@`) with whole-token matching — substring-matching the entire header
 *  misfires on hosts/databases that name a rival engine
 *  (`mysql@postgres.internal/postgres_prod` must stay mysql). No explicit
 *  dialect field exists in the state message (its shape is frozen for
 *  TASK-004), so this strict token parse IS the dialect source; a header
 *  that does not match (`no connection`, `Browse …`, mangled) yields
 *  `unknown` and quoting falls back to postgres double-quoting. */
function detectDialectFromHeader(header: string): SqlDialect {
  const token = /—\s*([A-Za-z0-9_-]+)@/.exec(header)?.[1] ?? "";
  if (/^postgres$/i.test(token)) return "postgres";
  if (/^mysql$/i.test(token)) return "mysql";
  if (/^mssql$/i.test(token)) return "mssql";
  return "unknown";
}

/** Quote a colId for the dialect when it is not a bare identifier. Embedded
 *  quote characters are doubled: postgres `"First ""Name"""` · mysql
 *  `` `First Name` `` · mssql `[First Name]`. Unknown dialect → postgres. */
function quoteColIdIfNeeded(colId: string, dialect: SqlDialect): string {
  if (BARE_IDENTIFIER_RE.test(colId)) return colId;
  const d = dialect === "mysql" || dialect === "mssql" ? dialect : "postgres";
  if (d === "mysql") {
    return "`" + colId.replace(/`/g, "``") + "`";
  }
  if (d === "mssql") {
    return "[" + colId.replace(/]/g, "]]") + "]";
  }
  return '"' + colId.replace(/"/g, '""') + '"';
}

/** TASK-003 — build the orderBy string from the grid's column state:
 *  keep entries with a non-null `sort`, order by `sortIndex ?? 0` (NOT colId
 *  order — getColumnState returns column order, not sort priority), and map
 *  each to `` `${quoteColIdIfNeeded(colId)} ${sort.toUpperCase()}` `` joined
 *  with ", ". Empty string means "no ORDER BY". */
function orderByFromColumnState(api: GridApi): string {
  const dialect = detectDialectFromHeader(headerText);
  const terms = api
    .getColumnState()
    .filter((c) => c.sort !== null && c.sort !== undefined)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    .map((c) => {
      const spec = currentSpecs.find((s) => s.field === c.colId);
      const name = spec ? spec.headerName : c.colId;
      return `${quoteColIdIfNeeded(name, dialect)} ${(c.sort as string).toUpperCase()}`;
    });
  return terms.join(", ");
}

/** Post a server-side requery carrying the current grid filter model.
 *  `opts.offset` present ⇒ paged ("Load More"); omitted ⇒ fresh page 0.
 *  Fix round: when the grid has an active header sort, its orderBy takes
 *  precedence over the manual requery-bar input — a filter change or Load
 *  More requery used to post the (empty) bar value, silently dropping the
 *  user's column sort; the host then returned unsorted rows. The bar input
 *  still applies when no column is sorted. */
function postFilterRequery(opts: { offset?: number } = {}): void {
  if (!gridApi) return;
  const filters = buildServerFilterModel();
  const where = dom?.requeryWhere.value ?? "";
  const gridOrder = orderByFromColumnState(gridApi);
  const orderBy = gridOrder !== "" ? gridOrder : dom?.requeryOrderBy.value ?? "";
  postToHost({
    type: "requery",
    index: activeTab,
    where,
    orderBy,
    filters,
    ...(opts.offset !== undefined
      ? { offset: opts.offset, limit: 500, append: true }
      : {}),
  });
}

/** TASK-003 — sort variant of postFilterRequery: same payload shape, but the
 *  orderBy string comes from the grid's column state (which may be "" when
 *  the user cleared the sort) instead of the requery-bar input. `filters`
 *  still composes, `append` is never set — a sort is always a fresh page 0. */
function postFilterRequeryWithOrder(orderBy: string): void {
  if (!gridApi) return;
  const filters = buildServerFilterModel();
  const where = dom?.requeryWhere.value ?? "";
  postToHost({
    type: "requery",
    index: activeTab,
    where,
    orderBy,
    filters,
  });
}

/** TASK-003 — ask the host for a column's DISTINCT values. Skipped when the
 *  cache already holds an entry for `(activeTab, column)` (the popup may be
 *  re-opened without the data changing). */
function requestDistinctValues(column: string): void {
  const key = `${activeTab}::${column}`;
  if (distinctByColumn.has(key)) return;
  postToHost({ type: "requestDistinctValues", index: activeTab, column });
}

/** TASK-003 — handle a host distinctValues reply. Stores the values in the
 *  cache (keyed by the reply's index+column, generation-checked) and nudges
 *  any live SetFilterComponent so its list picks them up. Replies carrying
 *  `error` (or a stale generation) leave the loaded-row fallback in place. */
function handleDistinctValues(msg: DistinctValuesMsg): void {
  if (msg.error) return;
  if (msg.index !== activeTab) return;
  if (distinctStatementToken !== statementGeneration) return;
  distinctByColumn.set(`${msg.index}::${msg.column}`, msg.values ?? []);
  // Refresh any mounted set-filter GUI for this column so the new values
  // appear without a reopen. AG Grid exposes no per-filter registry; walk
  // the live DOM for our component roots and let each instance recompute.
  refreshSetFilterGuis(msg.column);
}

/** Notify mounted SetFilterComponent GUIs that distinct data arrived. The
 *  component registers itself here on init (see SetFilterComponent.init). */
const setFilterInstances = new Set<{
  getColumnId(): string | null;
  refreshEntries(): void;
}>();

function refreshSetFilterGuis(column: string): void {
  for (const inst of setFilterInstances) {
    if (inst.getColumnId() === column) inst.refreshEntries();
  }
}

/** Debounced wrapper — rapid filter changes collapse into one requery. */
function scheduleFilterRequery(): void {
  if (filterRequeryTimer !== null) {
    clearTimeout(filterRequeryTimer);
    filterRequeryTimer = null;
  }
  filterRequeryTimer = setTimeout(() => {
    filterRequeryTimer = null;
    postFilterRequery();
  }, FILTER_REQUERY_DEBOUNCE_MS);
}

function dispatchLoadMore(): void {
  if (loadMoreInFlight || busy) return;
  if (quickFilterActive) return;
  if (colFilterActive) {
    // A server-side filter is active: the current cursor is a finite page
    // that does NOT carry the filter. Load More re-runs the filtered query
    // for the next page (offset = rows already loaded) and appends. Bail on
    // offset 0 — appending page 0 onto itself would duplicate rows.
    const offset =
      statementRows.get(activeTab)?.length ??
      currentStatement?.result?.rows.length ??
      0;
    if (offset <= 0) return;
    // Deliberately NOT setting loadMoreInFlight here: the host posts a
    // busy:running state for the requery, and that `busy` gate (plus the
    // host-side requery staleness guard) dedupes concurrent triggers
    // without wedging the flag open when the filter is later cleared.
    postFilterRequery({ offset });
    return;
  }
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
  // TASK-005 — a column filter no longer gates scroll-based load-more;
  // dispatchLoadMore posts a paged requery when a server filter is active.
  if (loadMoreInFlight || busy || quickFilterActive) return;
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

// ---- TASK-004: null display + cell value viewer ----------------------------

/** Overlay element for the value viewer, or null when closed. */
let valueViewerEl: HTMLDivElement | null = null;
/** Escape-to-close listener bound while the viewer is open (removed on close). */
let valueViewerKeydown: ((ev: KeyboardEvent) => void) | null = null;
/** Outside-mousedown-to-close listener bound while the viewer is open. */
let valueViewerOutsideClick: ((ev: MouseEvent) => void) | null = null;

/** Close the value viewer overlay and unbind its document-level listeners. */
function closeValueViewer(): void {
  if (valueViewerKeydown) {
    document.removeEventListener("keydown", valueViewerKeydown, true);
    valueViewerKeydown = null;
  }
  if (valueViewerOutsideClick) {
    document.removeEventListener("mousedown", valueViewerOutsideClick, true);
    valueViewerOutsideClick = null;
  }
  valueViewerEl?.remove();
  valueViewerEl = null;
}

/** Open the value viewer overlay showing the FULL raw cell value. The grid
 *  itself ellipsizes long text (cellStyle white-space/overflow), so this is
 *  the "see everything" affordance. Content is set via textContent — never
 *  innerHTML — so cell values cannot inject markup. */
function openValueViewer(value: unknown, anchor?: HTMLElement | null): void {
  if (!dom) return;
  closeValueViewer();
  const overlay = document.createElement("div");
  overlay.className = "vsdb-value-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Cell value viewer");
  overlay.textContent =
    value === null || value === undefined ? "(NULL)" : formatCell(value);

  // Position near the double-clicked cell when a usable rect exists (jsdom
  // rects are all-zero — the CSS fallback anchor applies there instead).
  if (anchor && anchor.isConnected) {
    const rect = anchor.getBoundingClientRect();
    const hostRect = dom.gridWrap.getBoundingClientRect();
    if (rect.left !== 0 || rect.top !== 0) {
      overlay.style.left = `${Math.max(0, rect.left - hostRect.left)}px`;
      overlay.style.top = `${Math.max(0, rect.bottom - hostRect.top + 4)}px`;
      overlay.style.bottom = "auto";
    }
  }
  dom.gridWrap.appendChild(overlay);
  valueViewerEl = overlay;

  valueViewerKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") closeValueViewer();
  };
  document.addEventListener("keydown", valueViewerKeydown, true);
  // Any mousedown OUTSIDE the overlay closes it. The dblclick that opened
  // the viewer finishes dispatching before openValueViewer runs (it is
  // deferred a tick in onCellDoubleClickedHandler), so this listener can
  // never immediately close the overlay it just opened.
  valueViewerOutsideClick = (ev: MouseEvent): void => {
    if (
      valueViewerEl &&
      ev.target instanceof Node &&
      !valueViewerEl.contains(ev.target)
    ) {
      closeValueViewer();
    }
  };
  document.addEventListener("mousedown", valueViewerOutsideClick, true);
}

/** TASK-004 — cellDoubleClicked handler. Editable columns keep AG Grid's
 *  default double-click-to-edit (null cells included: the editor starts
 *  from the RAW value, so a null cell edits as empty). Columns with no
 *  editor (read-only) instead open the value viewer overlay with the full
 *  raw cell value.
 *
 * AG Grid starts the cell editor for editable columns on the SAME dblclick,
 * AFTER this callback — so the editability check is deferred one tick: if
 * an editor is active by then, the double-click was an edit and the viewer
 * stays closed; if not, the viewer opens. */
function onCellDoubleClickedHandler(e: CellDoubleClickedEvent): void {
  if (!gridApi) return;
  const colId = e.column ? e.column.getColId() : undefined;
  // Only data columns (mapped in currentSpecs) are candidates — the
  // auto-generated selection column has no value to view.
  if (!colId || currentSpecs.every((s) => s.field !== colId)) return;
  const raw = e.value;
  const target = (e.event as Event | undefined)?.target;
  const anchor = target instanceof HTMLElement ? target : null;
  setTimeout(() => {
    if (!gridApi) return;
    if (gridApi.getEditingCells().length > 0) return;
    openValueViewer(raw, anchor);
  }, 0);
}

/** Format a data cell value. csvMode off → formatted (formatCell, the
 *  default display); csvMode on → raw (toString, so a Date renders as the
 *  Date object's toString rather than an ISO string). TASK-004: null and
 *  undefined both display as the "(NULL)" placeholder text (the
 *  cellRenderer above wraps it in the styled `.vsdb-null` span) — the
 *  underlying data keeps the real null, this only changes display. */
function formatDataCell(v: unknown): string {
  if (v === null || v === undefined) return "(NULL)";
  if (csvMode) {
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
  // NOT live getColumnDefs. We also push a `cell-edit` action onto the
  // unified undo stack per pasted cell (TASK-008 R2 follow-up): the
  // paste path was leaving the undo stack empty, so clicking undo
  // after a paste was a no-op. Capture the server-truth oldValue from
  // the active result so a single undo restores the original cell,
  // matching the R2 finding #3 NULL-vs-MISSING distinction already
  // honored in applyUndoAction.
  const activeResult = results[activeTab];
  for (let r = 0; r < targetNodes.length; r++) {
    const ref = targetNodes[r];
    const row = parsed[r];
    for (let c = 0; c < row.length; c++) {
      const targetCol = anchorCol + c;
      if (targetCol < 0 || targetCol >= colCount) continue;
      const spec = currentSpecs[targetCol];
      if (!spec) continue;
      // Read the pre-paste value from server-truth (same source
      // applyUndoAction consults on undo). For locally-added rows this
      // is undefined — those rows are never targeted here because the
      // targetNodes loop above already broke on `serverIndexByRowId`
      // missing.
      const si = serverIndexByRowId.get(ref.id);
      const serverRow =
        si !== undefined ? activeResult?.result?.rows?.[si] : undefined;
      const oldValue = serverRow !== undefined ? serverRow[targetCol] : undefined;
      ref.data[spec.field] = row[c];
      undoStack.push({
        kind: "cell-edit",
        rowId: ref.id,
        colIndex: targetCol,
        oldValue,
        newValue: row[c],
      });
    }
  }
  gridApi.refreshCells({ force: true });
  updateFooterNow();
}
/** Refresh button (A13): discard any local edits and re-fetch the current
 *  statement from the host. When there are dirty edits we MUST confirm
 *  before discarding them — a stray click should never silently lose
 *  in-progress work. On decline: dirtyCount is left untouched and NOTHING
 *  is posted to the host. On accept (or when nothing is dirty): local edit
 *  state is cleared and a requery is posted so the host re-runs the
 *  statement and sends back fresh rows. */
function hideSaveBanner(): void {
  if (!dom?.saveBanner) return;
  dom.saveBanner.classList.add("vsdb-hidden");
  dom.saveBanner.setAttribute("hidden", "");
  dom.saveBanner.textContent = "";
}

function postRefreshRequery(): void {
  editState.clear();
  undoStack.clear();
  refreshUndoRedoButtons();
  if (!dom) return;
  const where = dom.requeryWhere.value;
  const orderBy = dom.requeryOrderBy.value;
  postToHost({ type: "requery", index: activeTab, where, orderBy });
}

function showRefreshConfirm(): void {
  const banner = dom?.saveBanner;
  if (!banner) return;
  banner.textContent = "";
  const text = document.createElement("span");
  text.className = "vsdb-save-banner-text";
  text.textContent = "Discard unsaved edits and refresh?";
  banner.appendChild(text);

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "vsdb-save-retry";
  discard.setAttribute("data-vsdb-refresh-discard", "");
  discard.textContent = "Discard";
  discard.addEventListener("click", () => {
    hideSaveBanner();
    postRefreshRequery();
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "vsdb-save-retry";
  cancel.setAttribute("data-vsdb-refresh-cancel", "");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => hideSaveBanner());

  banner.appendChild(discard);
  banner.appendChild(cancel);
  banner.classList.remove("vsdb-hidden");
  banner.removeAttribute("hidden");
}

function onRefreshClick(): void {
  if (editState.dirtyCount > 0) {
    showRefreshConfirm();
    return;
  }
  postRefreshRequery();
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
  // TASK-007: mark dirty FIRST so when AG Grid renders the new row,
  // getRowClass already sees isRowNew(newRowId)=true and appends the
  // `vsdb-row-new` class on first render — no second redraw needed.
  //
  // A6/A11: the marker lives at MARKER_COL_INSERT (not colIndex 0 — that
  // would collide with a real edit on column 0's dirty key). `values` is
  // an array of exactly `currentSpecs.length`, filled with the DEFAULT_CELL
  // sentinel for untouched cells — NOT a field-keyed Record and NOT "" —
  // so src/core/saveStatements.ts can build a correctly-shaped INSERT.
  editState.markDirty(
    newRowId,
    MARKER_COL_INSERT,
    {
      __vsdb_new_row__: true,
      __rowId: newRowId,
      values: currentSpecs.map(() => DEFAULT_CELL),
    },
    undefined,
  );
  // TASK-008 — record the add-row on the unified undo stack so undo can
  // remove the row, redo can re-add it, and the toolbar redoBtn stays in
  // sync with the user's history.
  undoStack.push({ kind: "add-row", rowId: newRowId });
  gridApi.applyTransaction({ add: [blank] });
  newRowCount++;
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
  // TASK-007: mark dirty BEFORE the redraw so getRowClass sees
  // isRowDeleted(rowId)=true when the row re-renders. refreshCells
  // TASK-008 — record the delete-row on the unified undo stack so undo
  // can clear the marker (and un-strike the row), redo can re-strike it,
  // and the toolbar redoBtn stays in sync with the user's history.
  undoStack.push({ kind: "delete-row", rowId });
  // alone re-evaluates cellClassRules (the cell-level highlight) but
  // does NOT re-run getRowClass — we need redrawRows for the row-level
  // class to re-evaluate.
  // A6/A11: marker lives at MARKER_COL_DELETE — never colIndex 0 (would
  // collide with a real cell edit's dirty key).
  editState.markDirty(
    rowId,
    MARKER_COL_DELETE,
    { __vsdb_deleted__: true, __rowId: rowId },
    undefined,
  );
  if (focusedNode) {
    const node = gridApi.getRowNode(String(rowId));
    if (node) gridApi.redrawRows({ rowNodes: [node] });
  }
  updateFooterNow();
}

/** TASK-008 — Apply the inverse of a single undo action to the grid +
 *  EditState. Shared by onUndoClick and onRedoClick. The `apply` flag
 *  picks the inverse-vs-forward direction (undo pops the action and
 *  applies its inverse; redo replays it as-is). */
function applyUndoAction(action: UndoAction, mode: "undo" | "redo"): void {
  if (!gridApi) return;
  if (action.kind === "cell-edit") {
    const spec = currentSpecs[action.colIndex];
    if (!spec) return;
    const node = gridApi.getRowNode(String(action.rowId));
    if (!node?.data) return;
    // Undo: revert to oldValue (server-truth or original blank). Redo:
    // re-apply newValue and mark dirty again. Either way, the dirty
    // highlight must follow: undo strips it (clearCell), redo paints
    // it (markDirty).
    if (mode === "undo") {
      const r = results[activeTab];
      const si = serverIndexByRowId.get(action.rowId);
      const serverRow = si !== undefined ? r?.result?.rows?.[si] : undefined;
      if (serverRow !== undefined) {
        // Distinguish NULL from MISSING — `null ?? anything` returns
        // anything, so we test `serverRow !== undefined` instead of
        // `serverOld ?? ...` (R2 finding #3 in TASK-501).
        node.data[spec.field] = serverRow[action.colIndex];
      }
      // Locally-added rows have no server-row twin; leave the cell as-is.
      editState.clearCell(action.rowId, action.colIndex);
    } else {
      node.data[spec.field] = action.newValue;
      editState.markDirty(
        action.rowId,
        action.colIndex,
        action.newValue,
        action.oldValue,
      );
    }
    gridApi.refreshCells({ rowNodes: [node], force: true });
  } else if (action.kind === "add-row") {
    // Undo: remove the row (applyTransaction remove). Redo: re-add it.
    // We track the locally-added row so a re-add is the same object.
    if (mode === "undo") {
      const node = gridApi.getRowNode(String(action.rowId));
      const data = node?.data;
      gridApi.applyTransaction({ remove: data ? [data] : [] });
      editState.clearCell(action.rowId, MARKER_COL_INSERT);
      // Finding 2 (review fix round, cycle T) — the insert marker is
      // gone, but ordinary cell edits typed into this same row
      // (onCellValueChangedHandler records those separately, keyed by
      // the same rowId) are NOT cleared by clearCell(MARKER_COL_INSERT)
      // alone. Left behind, they orphan-count towards dirtyCount and a
      // future save for a row that no longer exists. Clear every
      // column's edit for this rowId too.
      for (let i = 0; i < currentSpecs.length; i++) {
        editState.clearCell(action.rowId, i);
      }
      if (newRowCount > 0) newRowCount--;
    } else {
      const blank: Record<string, unknown> = { __rowId: action.rowId };
      const cols = gridApi.getColumnDefs() as
        | Array<{ field?: string }>
        | undefined;
      for (const col of cols ?? []) {
        if (col.field && col.field !== "__rowId") blank[col.field] = "";
      }
      editState.markDirty(
        action.rowId,
        MARKER_COL_INSERT,
        {
          __vsdb_new_row__: true,
          __rowId: action.rowId,
          values: currentSpecs.map(() => DEFAULT_CELL),
        },
        undefined,
      );
      gridApi.applyTransaction({ add: [blank] });
      newRowCount++;
    }
  } else {
    // delete-row. Undo: clear the delete marker (un-strike — cell
    // values themselves were never mutated, only the marker was added).
    // Redo: re-mark the row deleted.
    if (mode === "undo") {
      editState.clearCell(action.rowId, MARKER_COL_DELETE);
    } else {
      editState.markDirty(
        action.rowId,
        MARKER_COL_DELETE,
        { __vsdb_deleted__: true, __rowId: action.rowId },
        undefined,
      );
    }
    const node = gridApi.getRowNode(String(action.rowId));
    if (node) gridApi.redrawRows({ rowNodes: [node] });
  }
  updateFooterNow();
  refreshUndoRedoButtons();
}
/** TASK-008 — Undo: pop the top action from the unified stack and
 *  apply its inverse to the grid + EditState. */
function onUndoClick(): void {
  const action = undoStack.undo();
  if (!action) return;
  applyUndoAction(action, "undo");
}
/** TASK-008 — Redo: replay the most-recently-undone action. */
function onRedoClick(): void {
  const action = undoStack.redo();
  if (!action) return;
  applyUndoAction(action, "redo");
}
/** TASK-008 — Sync toolbar undo/redo button enabled state with the
 *  stack. Cheap O(1) — just reflects the two boolean getters. */
function refreshUndoRedoButtons(): void {
  if (!dom) return;
  dom.undoBtn.disabled = !undoStack.canUndo;
  dom.redoBtn.disabled = !undoStack.canRedo;
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
  //
  // A12: serverIndexByRowId lets the host resolve a dirty row's original
  // position in `result.rows` (needed for ctid/no-PK fallback lookups)
  // without re-deriving it. Built from the module-level map that
  // rowsToObjects maintains — JSON keys must be strings.
  const serverIndexByRowIdJson: Record<string, number> = {};
  for (const [rowId, idx] of serverIndexByRowId) {
    serverIndexByRowIdJson[String(rowId)] = idx;
  }
  postToHost({
    type: "saveEdits",
    index: activeTab,
    edits,
    tableName: null,
    pkColumns: [],
    serverIndexByRowId: serverIndexByRowIdJson,
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

/** TASK-005 / A19 — build the "Retry failed rows" button shown inside the
 *  save banner on a partial save failure. Plain text button (title +
 *  aria-label for screen readers); the click handler reads
 *  `lastFailedRows` at CLICK time, not construction time, so it always
 *  reflects the freshest failure record. */
function makeRetryButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "vsdb-save-retry";
  btn.setAttribute("data-vsdb-retry-failed", "");
  btn.title = "Retry failed rows — resend only the rows that failed";
  btn.setAttribute("aria-label", "Retry failed rows");
  btn.textContent = "Retry failed rows";
  btn.addEventListener("click", () => onRetryFailedRowsClick());
  return btn;
}

/** TASK-005 / A19 — Retry click: rebuild a save batch from ONLY the failed
 *  rows' still-dirty edits (successful rows were already cleared from
 *  editState by clearExceptRowIds on the partial-failure ack) and post
 *  `retryFailedRows`. No-op when there is no failure record or no dirty
 *  edit left for those rows — never posts an empty retry batch and never
 *  falls back to Commit (a fresh full save would re-send rows that
 *  already succeeded). */
function onRetryFailedRowsClick(): void {
  if (!lastFailedRows || lastFailedRows.rowIds.length === 0) return;
  const failed = new Set(lastFailedRows.rowIds);
  const failedEdits = editState.snapshot().filter((e) => failed.has(e.rowId));
  if (failedEdits.length === 0) return;
  // Same addressing map contract as onCommitClick (A12): lets the host
  // resolve each failed row's original position in result.rows. JSON keys
  // must be strings.
  const serverIndexByRowIdJson: Record<string, number> = {};
  for (const [rowId, idx] of serverIndexByRowId) {
    serverIndexByRowIdJson[String(rowId)] = idx;
  }
  postToHost({
    type: "retryFailedRows",
    index: lastFailedRows.index,
    rowIds: [...lastFailedRows.rowIds],
    edits: failedEdits,
    serverIndexByRowId: serverIndexByRowIdJson,
  });
  // While the host re-runs the subset, hide the banner (re-shown with
  // fresh rowErrors if rows fail again).
  if (dom?.saveBanner) {
    dom.saveBanner.classList.add("vsdb-hidden");
    dom.saveBanner.setAttribute("hidden", "");
    dom.saveBanner.textContent = "";
  }
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
      dialect: "postgres" | "mysql" | "mssql" | "unknown";
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
  // Derive hiddenColumns from the column specs so exports skip any
  // column the grid has visually hidden. The serializer already supports
  // `hiddenColumns`. Building it from specs keeps the export path in sync
  // with whatever the grid shows: any column with `spec.hidden` is
  // excluded from TSV/CSV/JSON/XML and from generated UPDATE/INSERT SET
  // clauses.
  //
  // A7: this list is matched against `r.result.columns` (the RAW column
  // name list from the wire, which can contain duplicates for a query
  // like `SELECT a.id, b.id`) — so it must use `headerName` (the
  // display/raw name), NOT `field` (TASK-003's deduped unique key like
  // "id__2", which would never appear in the raw columns array and so
  // would never match anything). This is the ONLY hiddenColumns/field
  // site converted this wave — see task Discussion.
  const hiddenColumns = currentSpecs
    .filter((s) => s.hidden === true)
    .map((s) => s.headerName);
  return {
    format,
    includeHeader,
    columns: r.result.columns,
    rows: r.result.rows,
    pkColumns: [],
    tableName: "results",
    selectedRows: selected,
    hiddenColumns,
    dialect: detectDialectFromHeader(headerText),
  };
}

function onExportCopyClick(): void {
  const input = readExportInput();
  if (!input) return;
  // Fix R1: serializeExport is contracted to never throw (R1 makes
  // serializeSqlUpdates degrade safely on empty PK), but defensive
  // logging is cheap and protects against future regression.
  // Forward hiddenColumns so any column the grid has visually hidden
  // stays out of the exported file.
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
        hiddenColumns: input.hiddenColumns,
        dialect: input.dialect,
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
  // Forward hiddenColumns (any column the grid has visually hidden).
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
        hiddenColumns: input.hiddenColumns,
        dialect: input.dialect,
      },
    );
    postToHost({ type: "exportFile", format: input.format, text });
  } catch (err) {
    console.error("vsdb export file failed:", err);
  }
}

function copySelectionToHost(): void {
  if (!gridApi) return;
  // Re-shape: AG Grid returns row objects; we need arrays of original values.
  // There is no `__select__` synthetic field anymore (TASK-402 Fix #3) — just
  // pass through the known spec field names.
  //
  // A16: use the live `currentSpecs` (source of truth for column order AND
  // the `hidden` flag) — NOT a freshly recomputed inferColumns() call. The
  // old code recomputed specs from currentStatement.result here, which
  // always produces `hidden: undefined` and would leak a hidden column's
  // values straight into the clipboard.
  let selected: Array<Record<string, unknown>> = gridApi.getSelectedRows() as Array<
    Record<string, unknown>
  >;
  if (selected.length === 0) {
    // No checkbox selection — fall back to the focused cell's row so a
    // plain Ctrl+C with just a cell focused (no explicit row selection)
    // still copies that row, matching spreadsheet-app expectations.
    const focused = gridApi.getFocusedCell();
    const node =
      focused?.rowIndex !== undefined
        ? gridApi.getDisplayedRowAtIndex(focused.rowIndex)
        : null;
    if (node?.data) selected = [node.data as Record<string, unknown>];
  }
  if (selected.length === 0) return;
  const visibleSpecs = currentSpecs.filter((s) => s.hidden !== true);
  const arr = selected.map((r) => {
    const row: unknown[] = [];
    if (visibleSpecs.length === 0) {
      for (const k of Object.keys(r)) {
        if (k === "__rowId") continue;
        row.push(r[k]);
      }
    } else {
      for (const s of visibleSpecs) {
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
    (transactionOpen ? "  Transaction open" : "") +
    (duration > 0 ? `  ⏱ ${duration}ms` : "");
}

function updateFooterNow(): void {
  if (!dom) return;
  refreshUndoRedoButtons();
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
    // TASK-003: colorize the SQL (dependency-free tokenizer → fragment of
    // <span>s). highlightSql never uses innerHTML, so hostile SQL stays text.
    sql.appendChild(highlightSql(r.sql));
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
    // TASK-007: per-row error handling. When rowErrors is present and
    // non-empty, the host reported which specific rows failed. We keep
    // those rows' edits dirty (so the user can retry) and clear the
    // successful rows. When rowErrors is absent or empty, full success
    // — clear everything (the original TASK-503 behaviour).
    if (msg.rowErrors && msg.rowErrors.length > 0) {
      const erroredRowIds = new Set(msg.rowErrors.map((e) => e.rowId));
      editState.clearExceptRowIds(erroredRowIds);
      // TASK-005 / A19 — arm the retry affordance: remember WHICH rows of
      // WHICH statement failed so the banner's "Retry failed rows" button
      // can rebuild a save batch from just those rows.
      lastFailedRows = { index: msg.index, rowIds: Array.from(erroredRowIds) };
      if (banner) {
        banner.textContent = "";
        const text = document.createElement("span");
        text.className = "vsdb-save-banner-text";
        const lines = msg.rowErrors.map(
          (e) => `row ${e.rowId}: ${e.error}`,
        );
        text.textContent =
          `${erroredRowIds.size} row${erroredRowIds.size === 1 ? "" : "s"} failed · ` +
          lines.join(" · ");
        banner.appendChild(text);
        banner.appendChild(makeRetryButton());
        banner.classList.remove("vsdb-hidden");
        banner.removeAttribute("hidden");
      }
      // Re-render cells so dirty highlights on errored rows remain
      // and highlights on cleared rows disappear.
      if (gridApi) {
        gridApi.refreshCells({ force: true });
      }
    } else {
      // TASK-008 — full commit success. Undo past a DB write is out of
      // scope (the DB has already committed), so we drop both branches
      // of the stack alongside the dirty-map clear. The partial-failure
      // branch above intentionally keeps the stack — the user retries
      // the errored rows.
      // TASK-005 / A19 — no per-row failure subset on this path; disarm
      // the retry affordance (the banner clear below removes the button).
      lastFailedRows = null;
      editState.clear();
      undoStack.clear();
      hideSaveBanner();
      if (msg.warnings && msg.warnings.length > 0 && banner) {
        banner.textContent = msg.warnings.join(" · ");
        banner.classList.remove("vsdb-hidden");
        banner.removeAttribute("hidden");
      }
      if (msg.refused && msg.reason && banner) {
        banner.classList.remove("vsdb-hidden");
        banner.removeAttribute("hidden");
        banner.textContent = msg.reason;
      }
      // Re-render cells so the now-empty EditState strips all dirty
      // highlights across the grid (new baseline).
      if (gridApi) {
        gridApi.refreshCells({ force: true });
      }
      // TASK-006 — post-commit grid refresh. The DB may hold values the
      // grid can't know (computed defaults like `now()`, triggers,
      // DEFAULT-filled columns). Dirty state is already cleared above, so
      // requery now with the CURRENT WHERE/ORDER BY from the requery bar;
      // the host re-runs the statement (closing the previous batched
      // cursor first — handleRequery's own guard) and echoes a fresh
      // state that re-renders the grid. Skipped on a soft refusal
      // (`refused`) — nothing was committed, so there is nothing new to
      // fetch. Partial failures (rowErrors) never reach this branch: the
      // errored rows stay dirty and an auto-requery could wipe rows the
      // user is about to retry.
      if (!msg.refused) {
        const where = dom?.requeryWhere.value ?? "";
        const orderBy = dom?.requeryOrderBy.value ?? "";
        postToHost({ type: "requery", index: msg.index, where, orderBy });
      }
    }
  } else {
    // ok:false path — host says "everything failed (or the build was
    // refused)". Keep editState; banner shows per-statement errors.
    // TASK-005 / A19 — no per-row subset here (the banner textContent
    // rewrite below removes any stale retry button); the Commit button
    // already retries the full dirty set.
    lastFailedRows = null;
    const errs = msg.errors ?? ["Unknown save error"];
    if (banner) {
      banner.textContent = errs.join(" · ");
      banner.classList.remove("vsdb-hidden");
      banner.removeAttribute("hidden");
    }
    // edit state preserved; user can retry after fixing.
  }
  refreshUndoRedoButtons();
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
    // TASK-003 — statement identity changed ⇒ the DISTINCT cache is wrong
    // data for the new statement (same index, different result). Bump the
    // generation: in-flight replies for the old statement are dropped by
    // handleDistinctValues' token check.
    const nextStatement = results[activeTab] ?? null;
    const identity = nextStatement
      ? `${nextStatement.index}|${nextStatement.sql}|${nextStatement.durationMs}`
      : "none";
    let statementIdentityChanged = false;
    if (identity !== lastStatementIdentity) {
      lastStatementIdentity = identity;
      statementGeneration++;
      distinctStatementToken = statementGeneration;
      distinctByColumn.clear();
      statementIdentityChanged = true;
    }
    render();
    // Fix round 2 (review finding): the mounted-filter refresh must run
    // AFTER render() swaps AG Grid to the replacement rows. Refreshing
    // before the swap made recomputeEntries' loaded-row fallback scan the
    // OLD statement's rows — if the fresh DISTINCT round trip then failed
    // or was slow, the dropdown kept old-statement entries indefinitely.
    // Sequenced here, the re-request fires after the rows update lands and
    // the list falls back to the NEW statement's loaded rows at worst.
    // The filter model is untouched — selections survive.
    if (statementIdentityChanged) {
      for (const inst of setFilterInstances) {
        const col = inst.getColumnId();
        if (col) requestDistinctValues(col);
        inst.refreshEntries();
      }
    }
  } else if (msg.type === "busy") {
    busy = msg.busy;
    if (!busy) loadMoreInFlight = false;
    render();
  } else if (msg.type === "saveResult") {
    handleSaveResult(msg);
  } else if (msg.type === "transactionStatus") {
    transactionOpen = msg.open;
    render();
    updateFooterNow();
  } else if (
    (msg as { type?: string }).type === "distinctValues"
  ) {
    // TASK-003 — host reply with the column's DISTINCT values. Mirrored
    // structurally (DistinctValuesMsg above), so no union widening of
    // HostMsg is needed for an additive message type.
    handleDistinctValues(msg as unknown as DistinctValuesMsg);
  }
});

// Tell host we're ready.
postToHost({ type: "ready" });

// Initial render.
render();

/** Test-only seam (cycle T / TASK-002). Lets tests inject ColumnSpecs
 *  shaped like TASK-003's dedup output (`field` unique even when
 *  `headerName` repeats, e.g. "id" / "id__2") or carrying a `hidden`
 *  flag — neither has a live production trigger in THIS worktree yet
 *  (TASK-003's inferColumns dedup lands in a parallel worktree this
 *  wave; no UI sets `hidden` today). Production code never calls this.
 *  Overrides `currentSpecs` AND pushes matching columnDefs
 *  (field/headerName/hide) onto the live grid so Add Row / copy paths
 *  that read `gridApi.getColumnDefs()` stay consistent with the
 *  injected specs. */
function debugSetSpecs(specs: readonly ColumnSpec[]): void {
  currentSpecs = specs;
  if (!gridApi) return;
  const next = specs.map((s) => ({
    field: s.field,
    headerName: s.headerName,
    hide: s.hidden === true,
    editable: true,
  }));
  gridApi.setGridOption("columnDefs", next);
}

// Expose for debugging + tests.
(window as unknown as { __vsdb: unknown }).__vsdb = {
  render,
  postToHost,
  getActiveTab: () => activeTab,
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
  get currentSpecs(): readonly ColumnSpec[] {
    return currentSpecs;
  },
  debugSetSpecs,
  /** TASK-003 — host-driven column-state restore (sort replay after a
   *  requery). Guarded by suppressSortRequery so onSortChanged, which AG
   *  Grid also fires for programmatic applies, does not re-post. Tests use
   *  this seam to drive the guard path directly (task case 6). */
  applyHostColumnState: (state: ColumnState[]) => {
    if (!gridApi) return;
    // AG Grid v36 dispatches sortChanged asynchronously (event queue), so
    // clearing in a finally would race the handler. Clear on the next macrotask;
    // a real user click can never land inside that window (it needs another
    // event-loop turn after the timeout).
    suppressSortRequery = true;
    try {
      gridApi.applyColumnState({ state, defaultState: { sort: null } });
    } finally {
      setTimeout(() => {
        suppressSortRequery = false;
      }, 0);
    }
  },
  /** TASK-008 — unified undo/redo stack handle for tests. */
  get undoStack(): UndoStack {
    return undoStack;
  },
  /** TASK-008 — live toolbar buttons (read current \`dom\`, which is set
   *  on first render — module init time it's null). */
  get undoBtn(): HTMLButtonElement | undefined {
    return dom?.undoBtn;
  },
  get redoBtn(): HTMLButtonElement | undefined {
    return dom?.redoBtn;
  },
  get transactionOpen(): boolean {
    return transactionOpen;
  },
  redo: onRedoClick,
  deleteRow: onDeleteRowClick,
  refresh: onRefreshClick,
  toggleCsv: onCsvToggleClick,
  undo: onUndoClick,
  commit: onCommitClick,
  simulateCellEdit,
  addRow: onAddRowClick,
  /** TASK-005 / A19 — retry-failed-rows handler for tests (the button
   *  only renders after a rowErrors ack; this seam exercises the guard
   *  paths directly). */
  retry: onRetryFailedRowsClick,
};

