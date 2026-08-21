# TASK-006 — QueryRunner (batch/cancel) + Results Panel webview (grid)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (test #11, #12; design §4, §5)

## Goal

Phần lõi UI: (1) `queryRunner` chạy danh sách statements tuần tự qua DbAdapter, gom kết quả từng statement, hỗ trợ load-more batch 500 + cancel, dừng tại statement lỗi; (2) Results Panel webview tái sử dụng: tabs mỗi statement, grid virtual scroll (~30 rows render), footer "N rows [Load 500 more] ⏱", Messages tab, nút Cancel, copy tab-separated.

## Target Files

- `src/core/queryRunner.ts`:
  - `export interface StatementResult { index: number; sql: string; status: 'running'|'done'|'error'|'cancelled'; result?: QueryResult; batched?: BatchedQuery; error?: string; durationMs: number }`
  - `export class QueryRunner { constructor(adapterProvider: () => Promise<DbAdapter>); run(statements: ParsedStatement[], onUpdate: (r: StatementResult[]) => void): Promise<StatementResult[]>; loadMore(index: number): Promise<StatementResult[]>; cancel(): Promise<void> }`
  - Logic: chạy tuần tự; statement N lỗi → đánh dấu `error`, KHÔNG chạy N+1; results trước giữ nguyên; Load more chỉ áp cho statement có `batched`.
- `src/core/resultBatcher.ts` — helper thuần: `export function appendBatch(current: any[][], batch: any[][]): any[][]` và `export function batchStats(total: number, loaded: number, batchSize: number): { canLoadMore: boolean; label: string }` — để unit test không cần DOM.
- `src/ui/resultsPanel.ts` — class `ResultsPanel`:
  - `show(): void` (webview panel bên dưới editor — `vscode.ViewColumn.Beside` hoặcActiveColumn, tái sử dụng panel cũ nếu còn mở)
  - `render(results: StatementResult[], header: string): void` — postMessage sang webview
  - `setBusy(busy: boolean): void` ; nhận message từ webview: `{type:'loadMore', index}` / `{type:'cancel'}` / `{type:'copy', text}`
- `webview/main.ts` — nhận state, render tabs + grid + Messages; listener postMessage.
- `webview/grid.ts` — virtual scroll table: chỉ render rows trong viewport (windowing ~30 rows), sticky header, NULL xám, số căn phải, copy selection tab-separated.
- `webview/styles.css` — dùng CSS variables của VS Code theme (`--vscode-*`) cho dark/light.
- `src/core/__tests__/queryRunner.test.ts`, `src/core/__tests__/resultBatcher.test.ts` — unit với mock DbAdapter.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | Chạy tuần tự nhiều statement | 2 statements → 2 StatementResult done đúng thứ tự, onUpdate gọi ≥2 lần | mock adapter trả rows |
| 2 | edge | Statement 2 lỗi → dừng chuỗi | results[1].status='error' có message; statements[2] KHÔNG chạy (mock spy đếm call = 2) | mock throw ở stmt 2 |
| 3 | unit | LoadMore append đúng thứ tự | appendBatch([[1],[2]], [[3]]) → [[1],[2],[3]]; batchStats(1200, 500, 500) → canLoadMore=true, label "500 of 1200" | mảng fake 1.200 rows |
| 4 | edge | Cancel giữa query | cancel() → adapter cancel được gọi, statement đang chạy → 'cancelled', statements sau không chạy | mock batched treo promise |
| 5 | edge | Statement không trả result (INSERT) | status done, result.rowCount đúng commandTag (`INSERT 0 5`) | mock adapter |
| 6 | unit | ResultsPanel serialize an toàn | results chứa NULL/Date/BigInt → JSON.stringify không throw (custom replacer) | object có Date, null, bigint |

## Test Files

- `src/core/__tests__/queryRunner.test.ts`
- `src/core/__tests__/resultBatcher.test.ts`

(Virtual scroll DOM: manual checklist trong `docs/testing-checklist.md` — không unit test DOM.)

## Verification Commands

```bash
npx tsc --noEmit
npm test -- src/core/__tests__/queryRunner.test.ts src/core/__tests__/resultBatcher.test.ts
npm run compile
```

## Acceptance Criteria

- [ ] 6 test trên PASS; webview bundle build sạch (`dist/webview.js`).
- [ ] Panel tái sử dụng: chạy query mới không mở panel thứ 2.
- [ ] Grid: tabs/statement, Load 500 more, Messages tab, Cancel, copy tab-separated — theo manual checklist.
- [ ] Không regression: `npm test` PASS.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 (`ParsedStatement`), TASK-003 (`QueryResult`, `BatchedQuery`, `DbAdapter`), TASK-005 (`ConnectionManager.getAdapter()`)

## Interfaces

- Consumes: `ParsedStatement` (statementParser), `DbAdapter`/`QueryResult`/`BatchedQuery` (adapters/types), `ConnectionManager.getAdapter(): Promise<DbAdapter>`.
- Produces (TASK-007 consume):
  - `class QueryRunner` như trên (constructor nhận adapterProvider — TASK-007 truyền `() => mgr.getAdapter()`).
  - `class ResultsPanel { show(): void; render(results: StatementResult[], header: string): void; setBusy(b: boolean): void }` + `dispose()`.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
