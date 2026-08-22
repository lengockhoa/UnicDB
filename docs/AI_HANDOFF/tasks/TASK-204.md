# TASK-204 — Host setBusy quanh loadMore + nuốt cancel error

Status: ready
Owner: -
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Fix bug Cancel-disable: host bọc `setBusy(true/false)` quanh `runner.loadMore()` trong ResultsPanel.handleMessage để nút Cancel enabled trong lúc batch đang fetch qua mạng; cancel-during-loadMore không toast lỗi.

## Target Files

- `src/ui/resultsPanel.ts` — case "loadMore" trong handleMessage
- `src/ui/__tests__/resultsPanel.test.ts` — thêm test mới (giữ toàn bộ test cũ)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | happy | busy:true trước khi loadMore resolve | runner.loadMore trả deferred promise; click flow: panel nhận msg loadMore → FakeWebview.postMessage đã được gọi với `{type:"busy",busy:true}` TRƯỚC khi resolve; sau resolve → nhận state mới + `{type:"busy",busy:false}` |
| 2 | happy | state sau loadMore chứa updated results | resolve với results mới → postMessage cuối có type "state" với đúng results đó (sanitize vẫn chạy) |
| 3 | edge | cancel-during-loadMore KHÔNG toast | loadMore reject `Error("Statement 0 cancelled")` (runner.cancel() đã được gọi) → `showErrorMessage` KHÔNG được gọi; busy:false vẫn được gửi (finally) |
| 4 | edge | cancel-during-loadMore fetchBatch reject | loadMore reject `Error("another query is in progress")` — runner stub `isCancelled()` trả true → KHÔNG toast (nhận diện qua isCancelled flag thay vì chỉ text) |
| 5 | edge | lỗi thật VẪN toast | loadMore reject `Error("connection refused")`, runner `isCancelled()` false → `showErrorMessage` gọi với `Load more failed: connection refused` |
| 6 | regression | suite cũ nguyên vẹn | toàn bộ test cũ trong file (sanitize BigInt, postMessage rejection, ready flow) vẫn pass không sửa |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` (sửa + thêm — pattern FakeWebviewPanel + vi.mock vscode sẵn trong file)

## Verification Commands

```bash
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsPanel.test.ts
```

## Acceptance Criteria

- [ ] Cancel button (disabled = !busy) enabled đúng trong lúc loadMore đang fetch — verify qua busy:true message trước resolve
- [ ] `finally` đảm bảo busy:false kể cả reject (không kẹt disable vĩnh viễn)
- [ ] Cancel-during-loadMore: im lặng (no toast) khi `runner.isCancelled()` true HOẶC message khớp /cancel/i; vẫn re-post state cuối (để webview clear in-flight flag)
- [ ] Lỗi thật khác vẫn toast như cũ
- [ ] 6 test trên pass; full suite `npx vitest run` pass (wave boundary)

## Dependencies

none

## Interfaces

Consumes: `runner.loadMore(index): Promise<StatementResult[]>`, `runner.isCancelled(): boolean` (đã tồn tại trong src/core/queryRunner.ts — KHÔNG sửa queryRunner), `runner.cancel(): Promise<void>`.
Produces: none (internal behavior change).

## Discussion

### 2026-08-22 · planner · unic-smart
 KHÔNG đụng `src/core/queryRunner.ts`: cancel-during-loadMore đã reachable — loadMoreImpl set `this.currentBatched = batched` (queryRunner.ts:276) trước fetchBatch nên `runner.cancel()` gọi từ webview đã hủy được cursor đang chờ. Bug duy nhất là UX: host không báo busy. Fix gọn trong 1 case của handleMessage.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec204
RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-204

 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt trong safe range → number
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt vượt MAX_SAFE_INTEGER → string
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > Date → ISO string
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > null / undefined giữ nguyên
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt trong nested object → recurse
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt in array cell
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > Circular reference → '[Circular]' (không throw)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage được gọi với rows đã sanitize (không còn BigInt)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage rejection được surface (không void)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage sync throw cũng được surface
 × src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > busy:true postMessage TRƯỚC khi loadMore resolve
   → timeout waiting for postMessage predicate
 × src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > state cuối chứa updated results từ loadMore (sanitize vẫn chạy)
   → timeout waiting for postMessage predicate
 × src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > cancel-during-loadMore (cancelled message) KHÔNG toast — swallow error
   → timeout waiting for postMessage predicate
 × src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > cancel-during-loadMore (fetchBatch reject) detect qua isCancelled()
   → timeout waiting for postMessage predicate
 × src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > lỗi thật VẪN toast 'Load more failed: ...'
   → timeout waiting for postMessage predicate

 Test Files  1 failed (1)
      Tests  5 failed | 10 passed (15)
```

Verification Output:
```
$ npx tsc --noEmit
EXIT=0 (no output)

$ npx vitest run src/ui/__tests__/resultsPanel.test.ts
stderr | src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage rejection được surface (không void)
[vsdb] postMessage rejected: DataCloneError: BigInt

stderr | src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage sync throw cũng được surface
[vsdb] postMessage sync throw: Boom sync

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-204

 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt trong safe range → number
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt vượt MAX_SAFE_INTEGER → string
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > Date → ISO string
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > null / undefined giữ nguyên
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt trong nested object → recurse
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > BigInt in array cell
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — sanitizeStatementResult (IMPORTANT #5) > Circular reference → '[Circular]' (không throw)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage được gọi với rows đã sanitize (không còn BigInt)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage rejection được surface (không void)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — postMessage surface (IMPORTANT #5) > postMessage sync throw cũng được surface
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > busy:true postMessage TRƯỚC khi loadMore resolve
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > state cuối chứa updated results từ loadMore (sanitize vẫn chạy)
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > cancel-during-loadMore (cancelled message) KHÔNG toast — swallow error
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > cancel-during-loadMore (fetchBatch reject) detect qua isCancelled()
 ✓ src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — handleMessage loadMore (TASK-204) > lỗi thật VẪN toast 'Load more failed: ...'

 Test Files  1 passed (1)
      Tests  15 passed (15)

$ npx vitest run  (wave boundary)
 Test Files  15 passed (15)
      Tests  168 passed (168)
```

Status: PASS
Note: 5 new tests added to resultsPanel.test.ts; only src/ui/resultsPanel.ts + src/ui/__tests__/resultsPanel.test.ts modified. setBusy(true) before await runner.loadMore(), setBusy(false) in finally. Cancel-during-loadMore (isCancelled() true OR /cancel/i message match) swallows toast and re-posts last state; real errors still toast as before. FakeWebview gained a `dispatch` test seam for sending webview messages; pre-existing tests still green. queryRunner.ts and messages.ts untouched. Files left as-is in worktree (no git add/commit/push).
