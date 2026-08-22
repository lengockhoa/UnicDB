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
    const row = parsed[r];
    for (let c = 0; c < row.length; c++) {
      const targetCol = anchorCol + c;
      if (targetCol < 0 || targetCol >= colCount) continue;
      state.markDirty(targetRow, targetCol, row[c], undefined);
    }
  }
}
