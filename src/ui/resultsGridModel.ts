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

import { stripTrailingSemicolon } from "../core/text";

export type ColumnKind = "number" | "string" | "boolean";

export interface ColumnSpec {
  field: string;
  headerName: string;
  kind: ColumnKind;
  alignRight?: boolean;
  /** When true, the column is hidden in the grid (AG Grid `hide: true`)
   * AND excluded from exports. The grid sets this for any column the host
   * has flagged via `hiddenColumns`; users opt columns out without editing
   * the column-inference code. */
  hidden?: boolean;
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
  // `field` must be unique across the returned specs — AG Grid keys rows by
  // `field`, so two specs sharing one field collapse onto the same data
  // (both display/edit column 0's value for `SELECT a.id, b.id`). Track
  // fields already produced (both from generated suffixes AND any
  // pre-existing `name__N` in the input) so a de-dup suffix can never
  // collide with itself or with an already-unique original name.
  const usedFields = new Set<string>();
  return columns.map((name, colIdx) => {
    let allNumber = true;
    let allBoolean = true;
    let sawAny = false;
    // colIdx = loop index (position in `columns`/`rows[i]`) — NEVER
    // `columns.indexOf(name)`, which resolves duplicate names to the FIRST
    // match and misreads every subsequent same-named column's sample data.
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
    let field = name;
    if (usedFields.has(field)) {
      let n = 2;
      let candidate = `${name}__${n}`;
      while (usedFields.has(candidate)) {
        n++;
        candidate = `${name}__${n}`;
      }
      field = candidate;
    }
    usedFields.add(field);
    const spec: ColumnSpec = { field, headerName: name, kind };
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
 * COPIED VERBATIM từ webview/grid.ts — TASK-203 s� xóa webview/grid.ts.
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

/** Portable exporter-local identifier quoting. The exporter has no dialect
 * metadata, so use SQL-standard double quotes and double embedded quotes. */
function quoteExportIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** True for values that belong to the set-filter (Blanks) group. */
function isBlankFilterValue(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

/** Exported for the webview's typed resolver, which must share this classifier. */
export { isBlankFilterValue };

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

/** XML escape for BOTH element text content and attribute values.
 *
 * Pre-R2 only escaped `& < >` — the column name was interpolated into
 * a `"`-quoted attribute (`<col name="<xmlEscape(c)">`) and a column
 * like `a&b<c>"d"` rendered `name="a&amp;b&lt;c&gt;"d""`, terminating
 * the attribute at the second `"` and producing malformed XML. Fix R2
 * adds the `"` → `&quot;` escape (and apostrophe for completeness so
 * the escaper is reusable for both contexts). The order matters:
 * `&` MUST run first to avoid double-escaping the entities introduced
 * by the later replacements. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
  /** Column names to exclude from the rendered output. The webview
   * derives this from `spec.hidden` columns; any host-side column that the
   * user must not see goes here. Skip applies to all serializers
   * (TSV/CSV/JSON/XML/SQL) so the column is uniformly hidden. */
  hiddenColumns?: string[];
  /** TASK-001: column POSITIONS (0-based array indices) to exclude from the
   * rendered output. Takes precedence over `hiddenColumns` whenever present
   * (including when empty — empty hides nothing, names are then ignored).
   * Unlike name-based hiding, positional hiding distinguishes duplicate
   * column names (`SELECT a.id, b.id`): hiding one position leaves the other
   * visible. Out-of-range and non-integer indices are skipped. */
  hiddenIndices?: number[];
}

/** Build a Set<number> of indices to KEEP from `columns` — every column
 * NOT in `hiddenColumns`. Returns null when no columns are hidden so the
 * caller can fast-path the unfiltered case. */
function keepIndices(
  columns: string[],
  hiddenColumns?: string[],
): { indices: number[]; hidden: ReadonlySet<string> } | null {
  if (!hiddenColumns || hiddenColumns.length === 0) return null;
  const hidden = new Set(hiddenColumns);
  let any = false;
  const indices: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    if (hidden.has(columns[i])) {
      any = true;
      continue;
    }
    indices.push(i);
  }
  return any ? { indices, hidden } : null;
}

/** TASK-001: normalize `hiddenIndices` into a Set of VALID column positions.
 * Out-of-range and non-integer entries are dropped — `hiddenIndices=[0,99]`
 * on a 3-column schema hides only position 0. The caller decides what an
 * empty result means (for `resolveKeepIndices` it means "hide nothing"). */
function hiddenIndexSet(
  hiddenIndices: number[],
  columnCount: number,
): ReadonlySet<number> {
  const hidden = new Set<number>();
  for (const i of hiddenIndices) {
    if (Number.isInteger(i) && i >= 0 && i < columnCount) hidden.add(i);
  }
  return hidden;
}

/** TASK-001: resolve visible-column indices from `opts`. Positional
 * `hiddenIndices` wins whenever it is present (even when empty → no
 * filtering, names ignored); otherwise the name-based `keepIndices` path
 * runs exactly as before. Returns null when nothing is hidden so callers
 * can fast-path the unfiltered case. */
function resolveKeepIndices(
  columns: string[],
  opts: SerializeOptions,
): number[] | null {
  if (opts.hiddenIndices !== undefined) {
    const hidden = hiddenIndexSet(opts.hiddenIndices, columns.length);
    if (hidden.size === 0) return null;
    const indices: number[] = [];
    for (let i = 0; i < columns.length; i++) {
      if (!hidden.has(i)) indices.push(i);
    }
    return indices;
  }
  const keep = keepIndices(columns, opts.hiddenColumns);
  return keep ? keep.indices : null;
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
  const keep = resolveKeepIndices(columns, opts);
  if (keep) {
    const out: string[] = [];
    if (opts.includeHeader) {
      out.push(keep.map((i) => formatCell(columns[i])).join("\t"));
    }
    for (const row of rows) {
      out.push(keep.map((i) => formatCell(row[i] ?? null)).join("\t"));
    }
    return out.join("\n");
  }
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
  const keep = resolveKeepIndices(columns, opts);
  if (keep) {
    const out: string[] = [];
    if (opts.includeHeader) {
      out.push(keep.map((i) => csvEscape(columns[i])).join(","));
    }
    for (const row of rows) {
      out.push(keep.map((i) => csvEscape(row[i] ?? null)).join(","));
    }
    return out.join("\n");
  }
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
  const keep = resolveKeepIndices(columns, opts);
  const colIdx = keep ?? columns.map((_, i) => i);
  const body = rows
    .map((row) => {
      const cells = colIdx
        .map((i) => `<col name="${xmlEscape(columns[i])}">${xmlEscape(formatCell(row[i] ?? null))}</col>`)
        .join("");
      return `<row>${cells}</row>`;
    })
    .join("");
  return `${decl}\n<rows>${body}</rows>`;
}

/** Serialize to JSON — `{ columns, rows }`. null preserved as null. */
export function serializeJson(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  const keep = resolveKeepIndices(columns, opts);
  if (!keep) return JSON.stringify({ columns, rows });
  const cols = keep.map((i) => columns[i]);
  const rs = rows.map((row) => keep.map((i) => row[i] ?? null));
  return JSON.stringify({ columns: cols, rows: rs });
}

/** Serialize to INSERT statements. `multirow=true` emits ONE INSERT with
 * comma-separated tuples; otherwise one INSERT per row. */
export function serializeSqlInserts(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions & { multirow?: boolean },
): string {
  if (rows.length === 0) return "";
  const keep = resolveKeepIndices(columns, opts);
  const visibleCols = keep ? keep.map((i) => columns[i]) : columns;
  const colList = visibleCols.join(", ");
  if (opts.multirow) {
    const tuples = rows.map(
      (row) =>
        `(${
          keep
            ? keep.map((i) => sqlLiteral(row[i] ?? null)).join(", ")
            : row.map(sqlLiteral).join(", ")
        })`,
    );
    return `INSERT INTO ${opts.tableName} (${colList}) VALUES ${tuples.join(", ")};`;
  }
  return rows
    .map((row) => {
      const vals = keep
        ? keep.map((i) => sqlLiteral(row[i] ?? null)).join(", ")
        : row.map(sqlLiteral).join(", ");
      return `INSERT INTO ${opts.tableName} (${colList}) VALUES (${vals});`;
    })
    .join("\n");
}

/** Serialize to UPDATE statements — SET on non-PK columns, WHERE on PK.
 *
 * R2: when the SET list would be empty (empty PK + no non-key cols, or
 * PK covers the whole schema), the row is SKIPPED and a SQL comment
 * `-- row N skipped: no non-key columns to update` is emitted. The
 * pre-R2 implementation emitted `UPDATE t WHERE (…)` with no SET
 * clause — invalid SQL (sqlite parse error: near "WHERE"). The
 * contract is "never produce unexecutable SQL".
 */
export function serializeSqlUpdates(
  columns: string[],
  rows: unknown[][],
  opts: SerializeOptions,
): string {
  if (rows.length === 0) return "";
  // TASK-001: with positional hiddenIndices, name lookups must resolve to
  // a VISIBLE position — otherwise `SELECT a.id, b.id` with one id hidden
  // would read the hidden duplicate's value for SET/WHERE.
  const hiddenIdx =
    opts.hiddenIndices !== undefined
      ? hiddenIndexSet(opts.hiddenIndices, columns.length)
      : null;
  // Build a column→index Map ONCE — indexOf per column is O(n²) on
  // wide rows AND silently produces `col=NULL` when a PK column is
  // missing from the schema (indexOf −1 yields undefined → NULL). With
  // the Map an absent key is detectable; we still skip silently for
  // schema drift rather than throw, matching the rest of the file.
  const colIdx = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) {
    if (hiddenIdx && hiddenIdx.has(i)) continue;
    colIdx.set(columns[i], i);
  }
  // hidden columns must NOT appear in generated SQL — the user never
  // sees them in the grid, so exporting them would produce meaningless
  // SET/WHERE clauses on metadata that the user can't edit.
  const hidden = new Set(opts.hiddenColumns ?? []);
  const visibleCols = hiddenIdx
    ? columns.filter((_, i) => !hiddenIdx.has(i))
    : columns.filter((c) => !hidden.has(c));
  const pkCols = hiddenIdx
    ? // Positional: a PK name qualifies only if some visible position
      // carries it (colIdx holds visible positions only).
      (opts.pkColumns.length > 0 ? opts.pkColumns : visibleCols).filter((c) =>
        colIdx.has(c),
      )
    : (opts.pkColumns.length > 0 ? opts.pkColumns : visibleCols).filter(
        (c) => !hidden.has(c),
      );
  const pkSet = new Set(pkCols);
  const setCols = visibleCols.filter((c) => !pkSet.has(c));
  const out: string[] = [];
  rows.forEach((row, rowIdx) => {
    const setClause = setCols
      .map((c) => {
        const i = colIdx.get(c);
        if (i === undefined) return null;
        return `${quoteExportIdentifier(c)}=${sqlLiteral(row[i])}`;
      })
      .filter((s): s is string => s !== null)
      .join(", ");
    if (!setClause) {
      // R2: the reviewer flagged that `UPDATE t WHERE (…)` with no SET
      // clause is invalid SQL (sqlite parse error: near "WHERE").
      // Never produce unexecutable SQL — skip the row and emit a
      // SQL comment so the user can see why nothing was generated.
      out.push(`-- row ${rowIdx + 1} skipped: no non-key columns to update`);
      return;
    }
    const whereClause = pkCols
      .map((c) => {
        const i = colIdx.get(c);
        if (i === undefined) return null;
        return `${quoteExportIdentifier(c)}=${sqlLiteral(row[i])}`;
      })
      .filter((s): s is string => s !== null)
      .join(" AND ");
    // SET is non-empty here — plain `WHERE col=val` reads cleanly.
    out.push(`UPDATE ${opts.tableName} SET ${setClause} WHERE ${whereClause};`);
  });
  return out.join("\n");
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
  // TASK-001: positional hiddenIndices takes precedence; name lookups then
  // resolve against visible positions only (see serializeSqlUpdates).
  const hiddenIdx =
    opts.hiddenIndices !== undefined
      ? hiddenIndexSet(opts.hiddenIndices, columns.length)
      : null;
  // Same index Map rationale as serializeSqlUpdates — O(n²) → O(n) per
  // row, and a missing PK column no longer silently yields `col=NULL`.
  const colIdx = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) {
    if (hiddenIdx && hiddenIdx.has(i)) continue;
    colIdx.set(columns[i], i);
  }
  // Skip hidden columns so the exported `WHERE …` is built from
  // user-visible PK columns only — host metadata never matches.
  const hidden = new Set(opts.hiddenColumns ?? []);
  // Positional fallback (no PK): one term per VISIBLE position, so hiding
  // one duplicate of `a.id, b.id` yields a single id term, not two.
  const visibleCols = hiddenIdx
    ? columns.filter((_, i) => !hiddenIdx.has(i))
    : columns;
  const keyCols = hiddenIdx
    ? (opts.pkColumns.length > 0 ? opts.pkColumns : visibleCols).filter((c) =>
        colIdx.has(c),
      )
    : (opts.pkColumns.length > 0 ? opts.pkColumns : columns).filter(
        (c) => !hidden.has(c),
      );
  const groups = useRows.map((row) => {
    const parts = keyCols
      .map((c) => {
        const i = colIdx.get(c);
        if (i === undefined) return null;
        return `${quoteExportIdentifier(c)}=${sqlLiteral(row[i])}`;
      })
      .filter((s): s is string => s !== null);
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

/** True if `value` is a TASK-007 row marker emitted by Add Row / Delete Row.
 *  Markers are plain object literals (`{__vsdb_new_row__: true, ...}` /
 *  `{__vsdb_deleted__: true, ...}`) so a structural `__vsdb_*__` field
 *  discriminates from regular cell values (string / number / Date / etc.). */
function isRowMarker(
  value: unknown,
  kind: "new" | "deleted",
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return kind === "new"
    ? v.__vsdb_new_row__ === true
    : v.__vsdb_deleted__ === true;
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
  /** Drop the dirty entry for the given (rowId, colIndex). Used by the
   *  TASK-008 unified undo stack — when the stack pops a cell-edit and
   *  reverts the cell to oldValue, the dirty entry for THAT cell must
   *  disappear (so cellClassRules strips `vsdb-cell-dirty`). Does
   *  nothing when no entry exists for that key. */
  clearCell(rowId: number, colIndex: number): void {
    this.dirty.delete(`${rowId}:${colIndex}`);
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

  // ---- TASK-007: commit-flow row-level selectors -------------------------

  /** True if a dirty entry exists for the given (rowId, colIndex) cell.
   *  Used by AG Grid cellClassRules to apply the `vsdb-cell-dirty` class. */
  isCellDirty(rowId: number, colIndex: number): boolean {
    return this.dirty.has(`${rowId}:${colIndex}`);
  }

  /** True if any dirty entry for `rowId` carries the new-row marker
   *  (`{__vsdb_new_row__: true, ...}`) emitted by Add Row. Drives AG Grid
   *  getRowClass to apply `vsdb-row-new`. */
  isRowNew(rowId: number): boolean {
    for (const e of this.dirty.values()) {
      if (e.rowId !== rowId) continue;
      if (isRowMarker(e.value, "new")) return true;
    }
    return false;
  }

  /** True if any dirty entry for `rowId` carries the delete-row marker
   *  (`{__vsdb_deleted__: true, ...}`) emitted by Delete Row. Drives AG Grid
   *  getRowClass to apply `vsdb-row-deleted` (strikethrough + opacity). */
  isRowDeleted(rowId: number): boolean {
    for (const e of this.dirty.values()) {
      if (e.rowId !== rowId) continue;
      if (isRowMarker(e.value, "deleted")) return true;
    }
    return false;
  }

  /** Drop every dirty entry whose rowId is NOT in `keepRowIds`.
   *  Used by the partial-failure commit path (TASK-007 #4): keep
   *  errored rows' edits so the user can retry, clear the rest. */
  clearExceptRowIds(keepRowIds: ReadonlySet<number>): void {
    // Snapshot keys first: deleting during Map iteration is unsafe
    // (the spec leaves iteration order undefined after a delete and
    // adjacent entries can be skipped on the next step).
    const toDrop: string[] = [];
    for (const [key, entry] of this.dirty) {
      if (!keepRowIds.has(entry.rowId)) toDrop.push(key);
    }
    for (const k of toDrop) this.dirty.delete(k);
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

// ---- composeRequery (TASK-504) --------------------------------------------
//
// Pure-logic helper used by the webview's WHERE/ORDER BY "Re-Run" bar. The
// user types a filter and/or an ordering on top of the statement currently
// rendered in the grid; we wrap the original statement as a subquery and
// compose a new SQL the host runs through the QueryRunner.
//
// Shape:
//   SELECT * FROM (<stmt>) vsdb_sub WHERE <where> ORDER BY <orderBy>
//
// Behavior:
//   - Both empty         → return the original statement with a trailing
//                          `;` (+ surrounding whitespace) stripped. No
//                          wrap; the host runs the original SQL.
//   - where only         → emit the WHERE clause only (no ORDER BY).
//   - orderBy only       → emit the ORDER BY clause only (no WHERE).
//
// IMPORTANT (Fix Round 2): composeRequery uses `sql` VERBATIM and only
// strips a TRAILING `;` (+ whitespace). It does NOT split on `;` — naive
// split(";") corrupts statements containing `;` inside string literals
// (e.g. `SELECT 'a;b' AS x FROM t` → split chops the literal). The host
// path always passes a single statement (statementParser.splitStatements
// is literal-aware upstream — multi-statement handling is dead code).
//
// Injection policy:
//   The `where` and `orderBy` fragments are USER-INTENDED SQL — VSDB is a
//   SQL client; the user already runs arbitrary SQL via the editor. We do
//   not escape / quote these fragments. No validation pass; an invalid
//   fragment surfaces as a database error from the runner.
export function composeRequery(
  sql: string,
  where: string,
  orderBy: string,
): string {
  const w = where.trim();
  const o = orderBy.trim();
  // Empty input: pass through with trailing `;` stripped.
  if (!w && !o) {
    return stripTrailingSemicolon(sql);
  }
  // Otherwise wrap the statement verbatim (interior `;` inside literals
  // stays intact) — strip only a TRAILING `;` so the wrap doesn't nest a
  // stray terminator (defense-in-depth: callers run splitStatements
  // upstream, but this fn must be safe standalone).
  const inner = stripTrailingSemicolon(sql).trimEnd();
  const whereClause = w ? ` WHERE ${w}` : "";
  const orderClause = o ? ` ORDER BY ${o}` : "";
  return `SELECT * FROM (${inner}) vsdb_sub${whereClause}${orderClause}`;
}

// ---- Set filter (TASK-601) --------------------------------------------------
// Pure-logic helpers backing the Excel-style set-filter UI (consumed by
// TASK-602's custom filter component, and independently unit-testable). No
// DOM, no ag-grid, no vscode — these accept whatever the caller extracts
// from the grid and return data shapes ready to render or predicate against.
//
// Key normalization rules:
//   - null / undefined / "" all collapse to a single sentinel key "(blanks)"
//     with display "(Blanks)". The sentinel is always pinned LAST in the
//     sorted entry list regardless of alphabetical position.
//   - Everything else: key = String(v).toLowerCase(); display keeps the
//     casing of the FIRST occurrence in the input (so "BUMD" + "bumd" shows
//     as "BUMD" with count 2).
//
// Sort order: ascending case-insensitive (key-based), with the blanks
// sentinel always last. Counts come from the loaded rows the caller hands
// us — this is an accepted, documented under-count vs server truth.

export interface SetFilterEntry {
  key: string;
  display: string;
  count: number;
}

/** Sentinel key for the "(Blanks)" group. Exported so TASK-602 can pin it
 * in the UI without re-hardcoding the literal. */
export const SET_FILTER_BLANKS_KEY = "(blanks)";
export const SET_FILTER_BLANKS_DISPLAY = "(Blanks)";

/**
 * Build the sorted list of checkbox entries from a column's values.
 *
 * Grouping is case-insensitive (key = lowercased string form). The
 * `display` of each group keeps the casing of its FIRST occurrence so the
 * UI shows e.g. "BUMD" even when later rows are typed as "bumd".
 *
 * null, undefined, and "" all collapse into ONE (Blanks) entry with
 * combined count. Sort: ascending case-insensitive by key, with the
 * blanks sentinel pinned last.
 */
export function buildSetFilterEntries(values: unknown[]): SetFilterEntry[] {
  const order: string[] = [];
  const display = new Map<string, string>();
  const count = new Map<string, number>();

  for (const v of values) {
    const blank = isBlankFilterValue(v);
    const key = blank ? SET_FILTER_BLANKS_KEY : String(v).toLowerCase();
    if (!display.has(key)) {
      order.push(key);
      display.set(key, blank ? SET_FILTER_BLANKS_DISPLAY : String(v));
    }
    count.set(key, (count.get(key) ?? 0) + 1);
  }

  order.sort((a, b) => {
    if (a === SET_FILTER_BLANKS_KEY) return 1;
    if (b === SET_FILTER_BLANKS_KEY) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return order.map((k) => ({
    key: k,
    display: display.get(k)!,
    count: count.get(k)!,
  }));
}

/**
 * Membership predicate: does `value` belong to the `selectedKeys` group?
 * Uses the same normalization as `buildSetFilterEntries`. When
 * `selectedKeys` is null the filter is INACTIVE — everything passes.
 */
export function setFilterPass(
  value: unknown,
  selectedKeys: Set<string> | null,
): boolean {
  if (selectedKeys === null) return true;
  const blank = isBlankFilterValue(value);
  const key = blank ? SET_FILTER_BLANKS_KEY : String(value).toLowerCase();
  return selectedKeys.has(key);
}

/**
 * Round-trip helper: convert a set-filter model's display-string list back
 * to the normalized-key Set the predicate consumes. Unknown display
 * strings are silently dropped (they're stale model state, e.g. a removed
 * entry). `null` / `undefined` input means the filter is inactive and
 * returns `null` (matches `setFilterPass`'s inactive contract).
 */
export function selectedKeysFromModel(
  entries: SetFilterEntry[],
  values: string[] | null | undefined,
): Set<string> | null {
  if (values === null || values === undefined) return null;
  const byDisplay = new Map<string, string>();
  for (const e of entries) byDisplay.set(e.display, e.key);
  const out = new Set<string>();
  for (const v of values) {
    const key = byDisplay.get(v);
    if (key !== undefined) out.add(key);
  }
  return out;
}
