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
