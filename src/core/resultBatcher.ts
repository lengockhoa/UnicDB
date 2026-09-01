// src/core/resultBatcher.ts
// Pure helpers for batch bookkeeping — TASK-006.
//
// `appendBatch` ghép rows mới vào mảng hiện tại mà KHÔNG mutate input.
// `batchStats` tính label "X of Y" và cờ canLoadMore dựa trên loaded/total.
//
// Đây là pure functions — không phụ thuộc vscode, không có DOM, dễ unit test.
import type { QueryResult } from "../adapters/types";

/**
 * Ghép `batch` vào `current`, trả về mảng mới. KHÔNG mutate input.
 * - Cả 2 đều `any[][]` (theo `QueryResult.rows`).
 * - Nếu cả 2 rỗng → trả `[]`.
 */
export function appendBatch(current: any[][], batch: any[][]): any[][] {
  if (current.length === 0 && batch.length === 0) return [];
  const out = new Array<any[]>(current.length + batch.length);
  for (let i = 0; i < current.length; i++) out[i] = current[i];
  for (let i = 0; i < batch.length; i++) out[current.length + i] = batch[i];
  return out;
}

/**
 * Tính số liệu batch.
 * - `total`: tổng rows ước lượng (Number hoặc null nếu driver không biết).
 * - `loaded`: số rows đã load về.
 * - `batchSize`: kích thước mỗi batch (chỉ dùng cho label nếu cần).
 *
 * Trả về:
 * - `canLoadMore`: true nếu `loaded < total` (và `total` không null).
 * - `label`: chuỗi "loaded of total" hiển thị ở footer.
 */
export function batchStats(
  total: number | null,
  loaded: number,
  _batchSize: number,
): { canLoadMore: boolean; label: string } {
  if (total === null) {
    // Không biết tổng → chỉ hiển thị loaded.
    return { canLoadMore: true, label: `${loaded} rows` };
  }
  const canLoadMore = loaded < total;
  return { canLoadMore, label: `${loaded} of ${total}` };
}

/**
 * Tạo QueryResult mới với rows = appendBatch(query.rows, batch) và rowCount = new total.
 * Giữ nguyên columns, commandTag, durationMs.
 */
export function mergeBatchIntoResult(
  query: QueryResult,
  batch: any[][],
  totalRowCount?: number,
): QueryResult {
  return {
    ...query,
    rows: appendBatch(query.rows ?? [], batch),
    rowCount:
      totalRowCount !== undefined ? totalRowCount : (query.rowCount ?? 0) + batch.length,
  };
}

/**
 * Ghép `batch` vào `current` nhưng giới hạn tổng số rows giữ lại ở `maxRows`
 * (TASK-ARP03-001 — pure retained-result budget helper).
 *
 * - `rows`: prefix deterministic của `current.concat(batch)`, dài ≤ `maxRows`
 *   (ưu tiên giữ rows của `current` trước, sau đó mới tới đầu `batch`).
 * - `limited`: `true` iff `current.length + batch.length > maxRows` (đã bị cắt).
 * - KHÔNG mutate input; trả đúng 1 mảng mới — không build mảng concat trung gian.
 * - Cap degenerate (`0`, âm, `NaN`) → `rows` rỗng, không throw.
 * - Constant-free by design: `RETAINED_ROW_CAP` do caller (TASK-ARP03-002) truyền vào.
 */
export function appendBatchBounded(
  current: any[][],
  batch: any[][],
  maxRows: number,
): { rows: any[][]; limited: boolean } {
  // NaN > 0 → false, âm/0 → 0: mọi cap degenerate đều rơi về 0, không throw.
  const cap = maxRows > 0 ? Math.floor(maxRows) : 0;
  const total = current.length + batch.length;
  const limited = total > cap;
  const keep = Math.min(total, cap);
  const rows = new Array<any[]>(keep);
  for (let i = 0; i < keep; i++) {
    rows[i] = i < current.length ? current[i] : batch[i - current.length];
  }
  return { rows, limited };
}
