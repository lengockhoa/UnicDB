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
