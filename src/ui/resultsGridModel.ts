// src/ui/resultsGridModel.ts
// Pure-logic adapter model for the results grid.
//
// Tách từ webview/grid.ts + webview/main.ts + src/ui/resultsPanel.ts:
//   - Column inference (number / string / boolean) từ row sample.
//   - LoadMore state machine với in-flight gate (dedup cùng chu kỳ request→sync).
//   - Sync appendDelta: rows.length tăng → delta từ index cũ; bằng → no-op;
//     reset() trước sync / rows.length giảm → isReset=true.
//   - EOF detection: rowCount === rows.length → hasMore=false, total pinned.
//   - cancelMore: khóa vĩnh viễn gate.
//   - reset: clear state, mở gate lại, sync kế tiếp trả isReset=true.
//   - selectionToText, shouldResetGrid, footerText, formatCell (verbatim từ
//     webview/grid.ts formatCell).
//
// KHÔNG import "vscode" / "ag-grid-community". AG Grid api (getDisplayedRowCount
// etc.) chỉ là structural typing — call site truyền grid api wrapper thật vào.
//
// Consumers: src/ui/resultsPanel.ts (TASK-203 sẽ delete webview/grid.ts).
//
// IMPORTANT: formatCell copied VERBATIM từ webview/grid.ts — TASK-203 xóa grid.ts.
// KHÔNG sửa behavior formatCell.

export type ColumnKind = "number" | "string" | "boolean";

export interface ColumnSpec {
  field: string;
  headerName: string;
  kind: ColumnKind;
  alignRight?: boolean;
}

// ---- local StatementResult mirror -----------------------------------------
// Mirror từ src/core/queryRunner.ts để module này không import webview/.
// tsconfig include chỉ src/**, nên webview types không khả dụng; adapter host
// (resultsPanel.ts) phải đảm bảo shape StatementResult khớp.

export type StatementStatus = "running" | "done" | "error" | "cancelled";

export interface QueryResultLike {
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  commandTag?: string;
  durationMs?: number;
}

export interface StatementResult {
  index: number;
  sql: string;
  status: StatementStatus;
  result?: QueryResultLike;
  error?: string;
  durationMs: number;
}

// ---- inferColumns ----------------------------------------------------------

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Suy luận column kind từ tên cột + sample rows.
 * - Toàn number / bigint-sanitized string (chuỗi số, vd Postgres BigInt qua
 *   sanitizer) → "number", alignRight.
 * - Toàn boolean → "boolean".
 * - Còn lại (string, date-as-string, null-only) → "string".
 *
 * Sample tối đa 1000 phần tử đầu (không tốn thêm khi rows ngắn).
 */
export function inferColumns(columns: string[], rows: unknown[][]): ColumnSpec[] {
  const SAMPLE = Math.min(rows.length, 1000);
  return columns.map((name) => {
    const colIdx = columns.indexOf(name);
    let allNumber = true;
    let allBoolean = true;
    let sawAny = false;
    for (let i = 0; i < SAMPLE; i++) {
      const v = rows[i]?.[colIdx];
      if (v === null || v === undefined) continue;
      sawAny = true;
      let isNum = typeof v === "number";
      if (!isNum && typeof v === "string" && NUMERIC_STRING.test(v)) isNum = true;
      if (!isNum) allNumber = false;
      if (typeof v !== "boolean") allBoolean = false;
      if (!allNumber && !allBoolean) break;
    }
    let kind: ColumnKind;
    let alignRight: boolean | undefined;
    if (sawAny && allNumber) {
      kind = "number";
      alignRight = true;
    } else if (sawAny && allBoolean) {
      kind = "boolean";
    } else {
      kind = "string";
    }
    const spec: ColumnSpec = { field: name, headerName: name, kind };
    if (alignRight) spec.alignRight = true;
    return spec;
  });
}

// ---- loadMore state machine -----------------------------------------------

export interface GridModelCallbacks {
  onNeedMore?: () => void;
}

export interface GridModelState {
  /** Số rows hiện đã load (model-side). */
  getLoaded(): number;
  /** Còn batch tiếp theo hay không (display state). */
  hasMore(): boolean;
  /** Total rows biết được (null khi chưa biết). */
  getTotal(): number | null;
}

export interface SyncOptions {
  /** Caller biết total rows (vd: Postgres rowCount từ cursor). */
  total?: number | null;
  /** Caller biết số rows đã load TRƯỚC sync (vd: 0 cho initial, 500 sau loadMore). */
  loadedBefore?: number;
  /** Caller biết rowCount server-side (vd: rowCount từ QueryResult). */
  rowCount?: number | null;
}

export interface SyncResult {
  /** Phần rows MỚI từ index loadedBefore đến rows.length. */
  appendDelta: unknown[][];
  /** True khi sync KHÔNG phải continuation của statement cũ (reset path). */
  isReset: boolean;
}

export interface ResultsGridModel {
  requestWindow(displayedLastRow: number, viewportRows: number): void;
  sync(
    rows: unknown[][] | undefined,
    index: number,
    hasMore: boolean,
    opts?: SyncOptions,
  ): SyncResult;
  reset(): void;
  cancelMore(): void;
  getState(): GridModelState;
}

/**
 * Tạo model quản lý loadMore gate + appendDelta cho 1 statement result.
 *
 * Gate logic:
 *   - `requestWindow` fires `onNeedMore` khi viewport bottom chạm/vượt `loaded`.
 *   - Mỗi chu kỳ request→sync chỉ fire 1 lần (dedup qua `pendingNeedMore`).
 *   - `cancelMore()` khóa vĩnh viễn.
 *   - `reset()` clear state, gate "mở" lại nhờ `loaded=0` → requestWindow đầu
 *     tiên luôn satisfy điều kiện `displayedLast+viewport >= 0`.
 */
export function createResultsGridModel(cb: GridModelCallbacks = {}): ResultsGridModel {
  let currentIndex = -1;
  let loaded = 0;
  let hasMoreFlag = false;
  let total: number | null = null;
  let pendingNeedMore = false;
  let cancelled = false;
  /** Set bởi reset(); sync kế tiếp phải trả isReset=true để adapter rebuild. */
  let expectingReset = false;

  function fireNeedMore() {
    if (cancelled) return;
    if (pendingNeedMore) return;
    pendingNeedMore = true;
    cb.onNeedMore?.();
  }

  return {
    requestWindow(displayedLastRow: number, viewportRows: number) {
      if (cancelled) return;
      // hasMoreFlag là display state; gate đã được dedup qua pendingNeedMore.
      // loaded=0 sau reset → điều kiện luôn đúng cho lần gọi đầu.
      if (displayedLastRow + viewportRows >= loaded) {
        fireNeedMore();
      }
    },
    sync(rows, index, hasMore, opts = {}) {
      const incoming = rows ?? [];
      const loadedBefore = opts.loadedBefore ?? loaded;
      const incomingLen = incoming.length;

      // Reset path khi:
      // - reset() vừa được gọi (model bị clear, sync kế tiếp coi như statement mới).
      // - rows.length giảm so với loadedBefore (server reset / rebuild).
      const shrunk = incomingLen < loadedBefore;
      const isReset = expectingReset || shrunk;

      if (isReset) {
        currentIndex = index;
        loaded = incomingLen;
        hasMoreFlag = hasMore && (opts.rowCount == null || incomingLen < opts.rowCount);
        total = opts.total ?? null;
        pendingNeedMore = false;
        expectingReset = false;
        return { appendDelta: incoming.slice(), isReset: true };
      }

      // Continuation: append từ loadedBefore → incomingLen.
      const appendDelta = incomingLen > loadedBefore ? incoming.slice(loadedBefore) : [];
      currentIndex = index;
      loaded = incomingLen;
      // EOF detection: rowCount chính xác và rows.length đã đạt tới.
      if (opts.rowCount != null && incomingLen >= opts.rowCount) {
        hasMoreFlag = false;
        total = opts.rowCount;
      } else {
        hasMoreFlag = hasMore;
        total = opts.total ?? total ?? null;
      }
      // sync mới → gate mở.
      pendingNeedMore = false;
      return { appendDelta, isReset: false };
    },
    reset() {
      currentIndex = -1;
      loaded = 0;
      // hasMoreFlag giữ false (display state); loaded=0 khiến requestWindow đầu
      // tiên thỏa điều kiện gate → coi như gate "mở lại".
      hasMoreFlag = false;
      total = null;
      pendingNeedMore = false;
      cancelled = false;
      expectingReset = true;
    },
    cancelMore() {
      cancelled = true;
      pendingNeedMore = false;
    },
    getState() {
      return {
        getLoaded: () => loaded,
        hasMore: () => hasMoreFlag,
        getTotal: () => total,
      };
    },
  };
}

// ---- selectionToText -------------------------------------------------------

/**
 * Tab-separated text cho clipboard.
 * - Cells cách nhau bằng `\t`.
 * - Rows cách nhau bằng `\n`.
 * - null / undefined → chuỗi rỗng.
 */
export function selectionToText(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null || cell === undefined) return "";
          return String(cell);
        })
        .join("\t"),
    )
    .join("\n");
}

// ---- shouldResetGrid -------------------------------------------------------

/**
 * True khi bất kỳ statement nào đang "running" → grid cần rebuild khi results
 * chuyển từ running → terminal.
 */
export function shouldResetGrid(results: StatementResult[]): boolean {
  for (const r of results) {
    if (r.status === "running") return true;
  }
  return false;
}

// ---- footerText ------------------------------------------------------------

/**
 * Footer text cho results grid.
 * - Filtered (số hiển thị < loaded): "X of Y".
 * - Có total: "loaded of total".
 * - Batched chưa biết total: "loaded rows — load more to continue".
 * - Còn lại: "loaded rows".
 */
export function footerText(
  loaded: number,
  total: number | null,
  hasMore: boolean,
  displayed: number,
  filtered: boolean,
): string {
  if (filtered && displayed !== loaded) {
    return `${displayed} of ${loaded}`;
  }
  if (total != null) {
    return `${loaded} of ${total}`;
  }
  if (hasMore) {
    return `${loaded} rows — load more to continue`;
  }
  return `${loaded} rows`;
}

// ---- formatCell (VERBATIM từ webview/grid.ts) -----------------------------

/**
 * Format 1 cell value thành string hiển thị / copy.
 * - BigInt → string.
 * - Date → ISO.
 * - Object → JSON.
 *
 * COPIED VERBATIM từ webview/grid.ts — TASK-203 sẽ xóa webview/grid.ts.
 */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ---- Export serializers (TASK-502) ----------------------------------------
//
// Pure functions — no DOM, no vscode. The webview bundle imports these and
// posts the rendered text to the host (Copy → existing `copy` message;
// Export to file → new `exportFile` message that the host writes to disk).
//
// Output is deterministic (row order matches input order) and uses the
// canonical cell string from formatCell so what the user sees on screen is
// what they export.

/**
 * Quote-escape for SQL string literals.
 *
 * PORTABILITY (Fix R1): only single-quote is doubled. Backslash and the
 * C-style control escapes (`\n`, `\r`, `\t`) are NOT applied — PostgreSQL
 * (default standard_conforming_strings=on) and SQL Server treat backslash
 * literally, so pre-fix escaping silently corrupted data on those DBs
 * (a value `a\b` exported as `'a\\b'` and inserted `a\\b` instead of
 * `a\b`). MySQL interprets backslash escapes, but a non-escaped
 * portable literal is also valid there. Newlines / tabs / CRs are
 * embedded raw inside the quoted string — portable across PG, MSSQL,
 * MySQL. The .sql file is round-trippable without backslash-mangling.
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (Number.isNaN(v) || !Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'`;
  const s = String(v);
  // Only single-quote doubling — no backslash / control-char escapes.
  return `'${s.replace(/'/g, "''")}'`;
}

/** CSV escape per RFC4180: if the cell contains `,`, `"`, `\r`, or `\n`,
 * wrap in `"…"` and double every internal `"`. Otherwise return as-is. */
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = formatCell(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** XML escape for element text content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type ExportFormat =
  | "tsv"
  | "csv"
  | "xml"
  | "json"
  | "sql-inserts"
  | "sql-inserts-multirow"
  | "sql-updates"
  | "sql-where";

export interface SerializeOptions {
  includeHeader: boolean;
  tableName: string;
  pkColumns: string[];
  /** When set, sql-where uses these rows instead of `rows`. Other formats
   * ignore this — they always operate on the full dataset. */
  selectedRows?: unknown[][];
}

function headerLine(
  columns: string[],
  cells: (v: unknown) => string,
  joiner: string,
  includeHeader: boolean,
): string[] {
  return includeHeader ? [columns.map(cells).join(joiner)] : [];
}

function dataLines(
  rows: unknown[][],
  cells: (v: unknown) => string,
  joiner: string,
): string[] {
  return rows.map((row) => row.map(cells).join(joiner));
}

/** Serialize to TSV — tab-separated with optional header. Uses formatCell
 * so bigint/Date/null render the same on screen as in the export. */
export function serializeTsv(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  const out = [
    ...headerLine(columns, formatCell, "\t", opts.includeHeader),
    ...dataLines(rows, formatCell, "\t"),
  ];
  return out.join("\n");
}

/** Serialize to CSV — RFC4180 with optional header. */
export function serializeCsv(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  const out = [
    ...headerLine(columns, csvEscape, ",", opts.includeHeader),
    ...dataLines(rows, csvEscape, ","),
  ];
  return out.join("\n");
}

/** Serialize to XML — root `<rows>` with one `<row>` per record.
 *
 * Fix R1: column names live in a `name` attribute on a `<col>` wrapper,
 * never as a raw element tag. The source column names from
 * `SELECT ... AS "..."` can contain spaces, start with a digit, or use
 * other characters that are NOT valid in an XML Name — interpolating
 * them as raw tags yields malformed XML. The `name` attribute is the
 * only place a raw string is rendered, and its content is XML-escaped
 * like the cell value. */
export function serializeXml(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  const decl = '<?xml version="1.0" encoding="UTF-8"?>';
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c, j) => `<col name="${xmlEscape(c)}">${xmlEscape(formatCell(row[j] ?? null))}</col>`)
        .join("");
      return `<row>${cells}</row>`;
    })
    .join("");
  void opts; // opts unused for XML — included for API symmetry
  return `${decl}\n<rows>${body}</rows>`;
}

/** Serialize to JSON — `{ columns, rows }`. null preserved as null. */
export function serializeJson(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  void opts; // unused — included for API symmetry
  return JSON.stringify({ columns, rows });
}

/** Serialize to INSERT statements. `multirow=true` emits ONE INSERT with
 * comma-separated tuples; otherwise one INSERT per row. */
export function serializeSqlInserts(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions & { multirow?: boolean },
): string {
  if (rows.length === 0) return "";
  const colList = columns.join(", ");
  if (opts.multirow) {
    const tuples = rows.map((row) => `(${row.map(sqlLiteral).join(", ")})`);
    return `INSERT INTO ${opts.tableName} (${colList}) VALUES ${tuples.join(", ")};`;
  }
  return rows
    .map((row) => {
      const vals = row.map(sqlLiteral).join(", ");
      return `INSERT INTO ${opts.tableName} (${colList}) VALUES (${vals});`;
    })
    .join("\n");
}

/** Serialize to UPDATE statements — SET on non-PK columns, WHERE on PK.
 *
 * Fix R1: when `pkColumns` is empty, do NOT throw. The webview's
 * Copy / Export-to-file click handlers used to die silently in this
 * case because there is no PK metadata source until TASK-503 lands.
 * Instead, degrade to the documented fallback: treat ALL columns as
 * the key (same semantics as `serializeWhereClause` with empty PK).
 * That gives an UPDATE that targets a single row by its full row
 * fingerprint — safe and round-trippable. When every column is a PK
 * (PK list covers the whole schema), the SET list is empty; the
 * implementation emits `WHERE (all cols)` and skips SET, instead of
 * throwing. */
export function serializeSqlUpdates(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  if (rows.length === 0) return "";
  const pkCols = opts.pkColumns.length > 0 ? opts.pkColumns : columns;
  const pkSet = new Set(pkCols);
  const setCols = columns.filter((c) => !pkSet.has(c));
  return rows
    .map((row) => {
      const setClause = setCols
        .map((c) => {
          const i = columns.indexOf(c);
          return `${c}=${sqlLiteral(row[i])}`;
        })
        .join(", ");
      // Wrap WHERE in parens only on the empty-PK fallback (SET is empty
      // too) so the SQL is still visually unambiguous. With a real PK
      // the SET clause distinguishes the UPDATE so plain `WHERE col=val`
      // reads cleaner.
      const whereClause = pkCols
        .map((c) => {
          const i = columns.indexOf(c);
          return `${c}=${sqlLiteral(row[i])}`;
        })
        .join(" AND ");
      const setPart = setClause ? ` SET ${setClause}` : "";
      const wherePart = setClause
        ? ` WHERE ${whereClause}`
        : ` WHERE (${whereClause})`;
      return `UPDATE ${opts.tableName}${setPart}${wherePart};`;
    })
    .join("\n");
}

/** Serialize to a WHERE clause fragment — per-row AND groups joined with
 * OR. When no PK is supplied, falls back to all columns AND'd per row
 * (documented inline in the toolbar tooltip). When `selectedRows` is
 * undefined or empty, falls back to all rows. Returns "" if there are
 * no rows. */
export function serializeWhereClause(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  const useRows =
    opts.selectedRows && opts.selectedRows.length > 0 ? opts.selectedRows : rows;
  if (useRows.length === 0) return "";
  const keyCols = opts.pkColumns.length > 0 ? opts.pkColumns : columns;
  const groups = useRows.map((row) => {
    const parts = keyCols.map((c) => {
      const i = columns.indexOf(c);
      return `${c}=${sqlLiteral(row[i])}`;
    });
    return `(${parts.join(" AND ")})`;
  });
  return `WHERE ${groups.join(" OR ")}`;
}

/** Dispatch entry point — used by the webview export menu and the host
 * message handler. */
export function serializeExport(
  format: ExportFormat,
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  switch (format) {
    case "tsv":
      return serializeTsv(columns, rows, opts);
    case "csv":
      return serializeCsv(columns, rows, opts);
    case "xml":
      return serializeXml(columns, rows, opts);
    case "json":
      return serializeJson(columns, rows, opts);
    case "sql-inserts":
      return serializeSqlInserts(columns, rows, opts);
    case "sql-inserts-multirow":
      return serializeSqlInserts(columns, rows, { ...opts, multirow: true });
    case "sql-updates":
      return serializeSqlUpdates(columns, rows, opts);
    case "sql-where":
      return serializeWhereClause(columns, rows, opts);
  }
}


// ---- EditState + TSV paste (TASK-501) --------------------------------------
//
// Pure-logic edit model — no DOM / ag-grid imports. Consumed by webview/main.ts
// (cell edits, paste handler) and (later) by TASK-503 to build the save payload
// via snapshot(). markDirty coalesces consecutive edits to the same cell into a
// single undo step (the original oldValue stays at the bottom of the stack).

export interface EditSnapshotEntry {
  rowId: number;
  colIndex: number;
  value: unknown;
}

interface DirtyEntry {
  rowId: number;
  colIndex: number;
  /** Most recent user-entered value. */
  value: unknown;
}

export class EditState {
  private readonly dirty = new Map<string, DirtyEntry>();

  /** Total number of dirty cells. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * Record an edit to a single cell. Consecutive edits to the same cell
   * coalesce: only the original oldValue is kept on the undo stack, so a
   * single `undo()` restores back to the pre-edit value. (The undo stack
   * lives in the webview: it re-fetches the original cell from the
   * server rows on undo, so EditState does not need to store oldValue
   * itself.)
   */
  markDirty(rowId: number, colIndex: number, newValue: unknown, _oldValue: unknown): void {
    const key = `${rowId}:${colIndex}`;
    const existing = this.dirty.get(key);
    if (existing) {
      // Coalesce: same cell edited again — update value in place, no new
      // dirty entry, no new undo step.
      existing.value = newValue;
      return;
    }
    this.dirty.set(key, {
      rowId,
      colIndex,
      value: newValue,
    });
  }

  /**
   * Pop the last dirty cell (LIFO). Returns the cell that was popped (caller
   * uses this to revert the AG Grid cell back to oldValue) and removes the
   * dirty entry — the cell is no longer dirty once we restore oldValue.
   * Returns null when the undo stack is empty.
   */
  undo(): { rowId: number; colIndex: number } | null {
    // LIFO — pick the most-recently-marked cell. Iteration of Map preserves
    // insertion order so we take the last entry.
    if (this.dirty.size === 0) return null;
    let lastKey: string | null = null;
    for (const k of this.dirty.keys()) lastKey = k;
    if (lastKey === null) return null;
    const entry = this.dirty.get(lastKey)!;
    this.dirty.delete(lastKey);
    return { rowId: entry.rowId, colIndex: entry.colIndex };
  }

  /** Drop all dirty edits and undo state. Used on tab switch / new query. */
  clear(): void {
    this.dirty.clear();
  }

  /**
   * Current dirty cells as `{rowId, colIndex, value}` for save payload
   * (consumed by TASK-503). Order is not specified — caller should pair each
   * entry with the column spec via colIndex.
   */
  snapshot(): EditSnapshotEntry[] {
    const out: EditSnapshotEntry[] = [];
    for (const e of this.dirty.values()) {
      out.push({ rowId: e.rowId, colIndex: e.colIndex, value: e.value });
    }
    return out;
  }
}

/**
 * Parse TSV clipboard text into a 2-D string array.
 *
 * - Splits on `\n` (handles both `\n` and `\r\n`).
 * - Drops trailing empty rows produced by a trailing newline (Excel behavior).
 * - Pads each row to the maximum width with `""` so all rows share the same
 *   column count (downstream applyPasteToDirty can iterate uniformly).
 */
export function parseTsvPaste(text: string): string[][] {
  // Normalize CRLF / CR → LF so a single split handles all platforms.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  // Drop ALL trailing empty lines (a paste from Excel always ends with a
  // newline → produces one extra empty row; multiple trailing newlines
  // likewise produce empty rows that are not user data).
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  if (rawLines.length === 0) return [];

  let maxWidth = 0;
  const rows: string[][] = [];
  for (const line of rawLines) {
    const cells = line.split("\t");
    rows.push(cells);
    if (cells.length > maxWidth) maxWidth = cells.length;
  }
  if (maxWidth === 0) return rows;
  for (const row of rows) {
    while (row.length < maxWidth) row.push("");
  }
  return rows;
}

/**
 * Apply a parsed TSV paste onto an EditState at the given anchor cell,
 * clipping out-of-bounds rows/columns. Cells outside (rowCount, colCount)
 * are silently dropped — no throw.
 *
 * oldValue for markDirty is `undefined` because paste-from-clipboard does not
 * know the cell's pre-paste value; the webview main callsite supplies the
 * real oldValue from the AG Grid node data when wiring the paste handler.
 */
export function applyPasteToDirty(
  state: EditState,
  anchorRow: number,
  anchorCol: number,
  parsed: string[][],
  colCount: number,
  rowCount: number,
  targetRowIds?: number[],
): void {
  // When the caller has already resolved the target row ids (e.g. via
  // display-sequence iteration in the webview's paste handler), it may
  // pass `targetRowIds` so we skip the dense `anchorRow + r` arithmetic.
  // This matters when the id namespace is not dense — locally-added
  // rows and append-delta rows can leave "holes" or "bumps" in the
  // __rowId space, so the legacy formula would misaddress cells or
  // stamp over the local Add-Row marker (R3 finding #2). When
  // `targetRowIds` is absent, behavior is unchanged.
  const n = targetRowIds ? targetRowIds.length : rowCount;
  for (let r = 0; r < parsed.length; r++) {
    if (r >= n) break;
    const targetRow = targetRowIds ? targetRowIds[r] : anchorRow + r;
    if (targetRow < 0) continue;
    // Dense-path clip (TASK-502 R4 inherited): when targetRowIds is not
    // supplied, the computed `targetRow = anchorRow + r` may exceed the
    // grid's rowCount even though `r < n` (= rowCount). The old formula
    // silently stamped into non-existent rows. Drop the write instead.
    if (!targetRowIds && targetRow >= rowCount) continue;
    const row = parsed[r];
    for (let c = 0; c < row.length; c++) {
      const targetCol = anchorCol + c;
      if (targetCol < 0 || targetCol >= colCount) continue;
      state.markDirty(targetRow, targetCol, row[c], undefined);
    }
  }
}
