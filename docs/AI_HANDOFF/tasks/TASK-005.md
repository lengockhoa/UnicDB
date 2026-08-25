# TASK-005 -- A19 failed-row retry affordance

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.5

## Goal

Add a "Retry failed rows" button in the save banner when a partial save failure occurs (some rows succeed, some fail). Clicking it resends only the failed rows' edits through the existing save pipeline.

## Target Files

- `src/ui/messages.ts` (existing, 127 lines) -- add `retryFailedRows` message type to WebviewMessage union
- `src/ui/resultsPanel.ts` (existing, 1054 lines) -- add `handleRetryFailedRows` method that receives row IDs + edits and runs them through the save pipeline
- `webview/main.ts` (existing) -- add retry button rendering in save banner, collect errored rows' edits on click, post `retryFailedRows` message

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | bundle | `retry button appears when saveResult has rowErrors` | Button element exists in banner DOM | saveResult with rowErrors |
| 2 | bundle | `retry button hidden when saveResult has no rowErrors` | Button not present | saveResult.ok=true, no rowErrors |
| 3 | bundle | `clicking retry posts retryFailedRows message` | postToHost called with correct payload | Button clicked |
| 4 | unit | `retry message contains only failed row IDs` | message.rowIds length matches rowErrors length | 3 successes, 2 failures |
| 5 | edge | `retry with 0 failed rows` | No message posted (no-op) | rowErrors empty array |
| 6 | edge | `retry edits come from editState for failed rows only` | Snapshot contains entries only for errored rowIds | editState with mixed clean/dirty |

## Test Files

- `src/ui/__tests__/webviewRetry.test.ts` (new) -- tests for retry message construction and button rendering

## Verification Commands

```bash
npm test src/ui/__tests__/webviewRetry.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] "Retry failed rows" button appears in save banner when `rowErrors` is present
- [ ] Button is hidden when there are no row errors
- [ ] Clicking retry collects only the failed rows' dirty edits from editState
- [ ] `retryFailedRows` message is posted with correct `rowIds` and `edits`
- [ ] Host `handleRetryFailedRows` runs edits through the same save pipeline
- [ ] After retry, successful rows clear dirty state; failed rows stay dirty
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: `SaveResultMessage.rowErrors` (existing), `EditState.snapshot()` (existing), `EditState.isCellDirty()` (existing)
- Produces: `retryFailedRows` message type in messages.ts; `handleRetryFailedRows` method in resultsPanel.ts; retry button in webview banner

---

## Discussion

(chua co comment)
