# TASK-009 -- Manual-commit mode (adapter begin/commit/rollback + UI toggle)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.9

## Goal

Add a user-facing manual-commit mode where save operations are wrapped in explicit BEGIN/COMMIT/ROLLBACK transactions. When enabled, the user sees Commit/Rollback toolbar buttons and a transaction-state indicator in the status bar.

## Target Files

- `src/config/types.ts` (existing) -- add `manualCommit?: boolean` to `ConnectionConfig`
- `src/ui/resultsPanel.ts` (existing) -- wrap save SQL in transaction keywords when manualCommit is active; handle `commitTransaction` and `rollbackTransaction` messages
- `src/ui/messages.ts` (existing) -- add `CommitTransactionMessage`, `RollbackTransactionMessage` (webview-to-host), `TransactionStatusMessage` (host-to-webview)
- `webview/main.ts` (existing) -- add Commit/Rollback toolbar buttons visible only in manual-commit mode; handle `transactionStatus` message to update button state
- `webview/styles.css` (existing) -- Commit/Rollback button styles
- `src/ui/__tests__/manualCommit.test.ts` (new) -- unit tests

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `manualCommit wraps save in BEGIN/COMMIT` | SQL wrapped in `BEGIN TRANSACTION; ...; COMMIT TRANSACTION;` | Connection with manualCommit=true |
| 2 | unit | `manualCommit off produces bare SQL` | No transaction wrapping | Connection with manualCommit=false (default) |
| 3 | unit | `rollback sends ROLLBACK TRANSACTION` | `ROLLBACK TRANSACTION` SQL sent to adapter | Rollback button clicked |
| 4 | unit | `transactionStatus message shows open state` | Webview receives `{type:"transactionStatus", open:true}` | Transaction opened |
| 5 | edge | `Commit button hidden when manualCommit is off` | Button not in DOM | Default connection config |
| 6 | edge | `Rollback on failed statement sends ROLLBACK before error` | `ROLLBACK TRANSACTION` sent, then error response | Statement fails mid-transaction |
| 7 | edge | `transactionStatus open:false after commit` | Webview receives `{type:"transactionStatus", open:false}` | Commit completed |

## Test Files

- `src/ui/__tests__/manualCommit.test.ts` (new)

## Verification Commands

```bash
npm test src/ui/__tests__/manualCommit.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] `manualCommit` field exists on ConnectionConfig (defaults to false)
- [ ] When manualCommit=true, save operations wrapped in BEGIN/COMMIT
- [ ] Commit button visible only when manualCommit is active and transaction is open
- [ ] Rollback button visible only when manualCommit is active and transaction is open
- [ ] Clicking Commit sends `commitTransaction` message; host commits and clears state
- [ ] Clicking Rollback sends `rollbackTransaction` message; host rolls back
- [ ] Status bar shows transaction-open indicator when manual-commit is active
- [ ] Existing save behavior (manualCommit=false) unchanged
- [ ] All existing tests still pass
- [ ] `npm run typecheck` clean

## Dependencies

- TASK-007 (same-file collision on webview/main.ts, webview/styles.css, src/ui/resultsPanel.ts, src/ui/messages.ts -- TASK-009 depends on TASK-007 to avoid same-wave collision)

## Interfaces

- Consumes: `ConnectionConfig` from `src/config/types.ts` (existing), `transactionKeywords()` from `src/ui/resultsPanel.ts` (existing, private -- may need to export or move), `SaveContext` interface from `src/ui/resultsPanel.ts` (existing)
- Produces: `CommitTransactionMessage`, `RollbackTransactionMessage`, `TransactionStatusMessage` in messages.ts; Commit/Rollback buttons in webview toolbar; `manualCommit?: boolean` in ConnectionConfig

---

## Discussion

(chua co comment)
