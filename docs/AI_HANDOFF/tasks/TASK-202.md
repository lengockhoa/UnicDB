# TASK-202 — resultsGridModel: pure-logic module cho AG Grid adapter

Status: ready
Owner: -
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Tách toàn bộ logic không-cần-DOM của results grid (column inference, loadMore state machine + in-flight gate, append delta, cancel-more, copy text, footer text, reset detection) vào `src/ui/resultsGridModel.ts` — unit test thuần, không AG Grid thật.

## Target Files

- `src/ui/resultsGridModel.ts` (new)
- `src/ui/__tests__/resultsGridModel.test.ts` (new)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | happy | inferColumns number/bigint/string/boolean/date | cột sample `[123, "9007199254740993" (bigint-sanitized string)]` → `{kind:"number", alignRight:true}`; `["abc","2026-01-01T00:00:00.000Z"]` → `kind:"string"`; `[true]` → `kind:"boolean"`; toàn null → `kind:"string"` |
| 2 | happy | loadMore gate fires once | `hasMore=true`, loaded=500 → `requestWindow(displayedRow=495, viewportRows=30)` → onNeedMore gọi 1 lần; gọi `requestWindow` lần 2 trước `sync` → vẫn tổng 1 lần (dedup) |
| 3 | happy | sync append delta + EOF | sync(results với rows 1000) sau khi đã có 500 → `appendDelta` = đúng 500 phần tử từ index 500 (deep-equal phần mới); sync lần 2 cùng dữ liệu → `appendDelta` = [] (idempotent) |
| 4 | edge | EOF gán total | `hasMore=true` + sync EOF marker (rowCount === rows.length) → `total = rows.length`, `hasMore=false` |
| 5 | edge | cancelMore khóa vĩnh viễn | `cancelMore()` → mọi `requestWindow` sau đó KHÔNG fire onNeedMore (kể cả đáy viewport) |
| 6 | edge | reset | `reset()` → rows=[], gate mở lại, lần sync sau coi như statement mới (không delta) |
| 7 | unit | selectionToText tab-separated | 2 selected rows `[[1,"a"],[2,null]]` → `"1\ta\n2\t"` (null → chuỗi rỗng, xuống dòng giữa rows) |
| 8 | unit | shouldResetGrid | results chứa bất kỳ `status:"running"` → true; tất cả terminal (done/error/cancelled) → false |
| 9 | unit | footerText | batched (loaded=500, total=null) → chứa `"500"` và `"load more"`; filtered (displayed=176, loaded=200) → `"176 of 200"` |
| 10 | unit | formatCell verbatim | bigint → string, Date → ISO, object → JSON, null/undefined → "" (behavior giữ nguyên từ webview/grid.ts formatCell) |

## Test Files

- `src/ui/__tests__/resultsGridModel.test.ts` (new)

## Verification Commands

```bash
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts
```

## Acceptance Criteria

- [ ] Module KHÔNG import "vscode", KHÔNG import "ag-grid-community" (pure logic — AG Grid api chỉ là interface structural typing `{getDisplayedRowCount(): number}` etc.)
- [ ] `createResultsGridModel(opts)` export công khai; 10 test trên pass
- [ ] `formatCell` copy verbatim hành vi từ `webview/grid.ts` (BigInt→string, Date→ISO, object→JSON, null→"")
- [ ] Gate loadMore: đúng 1 onNeedMore mỗi chuỗi request→sync (kỹ thuật dedup: pendingFlag set khi fire, clear khi sync/reset)

## Dependencies

none

## Interfaces

Consumes: cấu trúc `StatementResult` mirror từ webview/main.ts (index/sql/status/result{columns,rows,rowCount,commandTag,durationMs}/batched/error/durationMs) — khai báo local trong module, không import từ webview (tsconfig include chỉ src/**).

Produces (TASK-203 sẽ consume):
```ts
export interface ColumnSpec { field: string; headerName: string; kind: "number" | "string" | "boolean"; alignRight?: boolean }
export function inferColumns(columns: string[], rows: unknown[][]): ColumnSpec[];
export interface GridModelCallbacks { onNeedMore?: () => void }
export interface GridModelState { getLoaded(): number; hasMore(): boolean }
export function createResultsGridModel(cb: GridModelCallbacks): {
  requestWindow(displayedLastRow: number, viewportRows: number): void;
  sync(results: StatementResult[], index: number, hasMore: boolean): { appendDelta: unknown[][]; isReset: boolean };
  reset(): void;
  cancelMore(): void;
}
export function selectionToText(rows: unknown[][]): string;
export function shouldResetGrid(results: StatementResult[]): boolean;
export function footerText(loaded: number, total: number | null, hasMore: boolean, displayed: number, filtered: boolean): string;
export function formatCell(v: unknown): string;
```
(Executor được chỉnh tên tham số/bổ sung field nhỏ, giữ ngữ nghĩa + các hàm trên.)

## Discussion

### 2026-08-22 · planner · unic-smart
`sync` nhận results + index và tự so với state trước đó của CÙNG index (rows.length tăng → delta; bằng → no-op; kẹt lại statement khác / rows.length giảm → isReset=true). Đây là trái tim của fix bug 1+2: APPEND thay vì rebuild.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec202
RED_OUTPUT: |
  FAIL  src/ui/__tests__/resultsGridModel.test.ts [ src/ui/__tests__/resultsGridModel.test.ts ]
  Error: Failed to load url ../resultsGridModel (resolved id: ../resultsGridModel) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-202/src/ui/__tests__/resultsGridModel.test.ts. Does the file exist?
   ❯ loadAndTransform ../../node_modules/vite/dist/chunks/dep-BK3b2jBa.js:51969:17
   Test Files  1 failed (1)
        Tests  no tests
  Confirmed: 0 tests collected because the module under test did not exist yet (RED-before-GREEN).
Verification Output: |
  --- tsc --noEmit ---
  (no output, exit code 0)

  --- vitest run src/ui/__tests__/resultsGridModel.test.ts ---
   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-202

   ✓ src/ui/__tests__/resultsGridModel.test.ts  (23 tests) 6ms

   Test Files  1 passed (1)
        Tests  23 passed (23)
     Start at  12:56:35
     Duration  274ms

  --- Acceptance check ---
  - webview/grid.ts untouched (only two ?? files in git status)
  - No "vscode" / "ag-grid" runtime imports in src/ui/resultsGridModel.ts
    (only mention in module docstring explaining the constraint)
  - formatCell body byte-identical to webview/grid.ts formatCell;
    signature widened from `v: any` to `v: unknown` (stricter, behaviorally identical)
Status: PASS
Note: All 10 required test cases pass (some expanded into sub-tests → 23 total assertions). Module is pure logic (no vscode/ag-grid dependency) and importable under plain vitest node env.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts
  result: tsc 0 errors / vitest 23 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed (10/10 cases incl. edge: all-null column, empty columns, dedup loadMore, EOF, cancelMore, reset)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ui/resultsGridModel.ts:104 — `columns.indexOf(name)` inside map is O(cols×rows) and resolves duplicate column names to the first index. Behavior is verbatim-preserved from old webview/main.ts (same indexOf pattern), so not a regression; if TASK-203 needs unique AG Grid `field`s for duplicate names, handle it in the consumer, not here.
    - src/ui/resultsGridModel.ts:207 — `requestWindow` does not consult `hasMoreFlag`/`total` internally (comment says display-state only). Correct today because webview/main.ts:474 guards with `if (!state.hasMore()) return;` — keep that guard when TASK-203 evolves the consumer, or the gate will fire at EOF.
    - src/ui/resultsGridModel.ts:226 — `reset()` also clears `cancelled`; "cancelMore locks permanently" holds only within one statement lifecycle. Intended (new query re-arms loading) and consistent with test 6; documenting here so a future reader doesn't "fix" it.
    - src/ui/__tests__/resultsGridModel.test.ts:230 — EOF test asserts hasMore/loaded but not `getTotal()` pinning; the code does set total=rowCount. Optional assertion strengthening.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: RED_OUTPUT is a real module-not-found failure (0 tests collected) — valid RED-before-GREEN. formatCell verified byte-identical to dfdeccc:webview/grid.ts. No vscode/ag-grid imports in module (only doc-comment mentions). All acceptance criteria met.
