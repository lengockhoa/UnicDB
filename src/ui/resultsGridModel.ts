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
