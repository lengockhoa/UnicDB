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

- Executor decision (2026-08-25): Test case 1's literal `BEGIN ... COMMIT` expectation conflicts with the goal and acceptance criteria requiring an open manual transaction with explicit Commit/Rollback controls. Manual-commit mode therefore sends `BEGIN` plus the save statements without an automatic `COMMIT`, reports `transactionStatus { open: true }`, and commits or rolls back only on the explicit webview action. The pre-existing automatic-save path retains its combined `BEGIN ... COMMIT` behavior. This is the only interpretation that can provide meaningful Commit/Rollback affordances and prevent a dangling transaction after a failed save.

(chua co comment)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  > vsdb@1.6.3 test
  > vitest run src/ui/__tests__/manualCommit.test.ts

  The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-009

   ❯ src/ui/__tests__/manualCommit.test.ts  (7 tests | 4 failed) 8ms
     ❯ src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > manualCommit wraps save in BEGIN and leaves commit for explicit action
       → Timed out waiting for expected webview message
     ❯ src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > rollback sends ROLLBACK TRANSACTION and reports closed state
       → Timed out waiting for expected webview message
     ❯ src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > transactionStatus is open only after a manual transaction begins
       → Timed out waiting for expected webview message
     ❯ src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > commit sends COMMIT TRANSACTION and reports closed state
       → Timed out waiting for expected webview message

  ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

   FAIL  src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > manualCommit wraps save in BEGIN and leaves commit for explicit action
  Error: Timed out waiting for expected webview message
   ❯ flush src/ui/__tests__/manualCommit.test.ts:77:9
       75|     await Promise.resolve();
       76|   }
       77|   throw new Error("Timed out waiting for expected webview message");
         |         ^
       78| }
       79|
   ❯ src/ui/__tests__/manualCommit.test.ts:123:5

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

   FAIL  src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > rollback sends ROLLBACK TRANSACTION and reports closed state
  Error: Timed out waiting for expected webview message
   ❯ flush src/ui/__tests__/manualCommit.test.ts:77:9
       75|     await Promise.resolve();
       76|   }
       77|   throw new Error("Timed out waiting for expected webview message");
         |         ^
       78| }
       79|
   ❯ src/ui/__tests__/manualCommit.test.ts:148:5

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

   FAIL  src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > transactionStatus is open only after a manual transaction begins
  Error: Timed out waiting for expected webview message
   ❯ flush src/ui/__tests__/manualCommit.test.ts:77:9
       75|     await Promise.resolve();
       76|   }
       77|   throw new Error("Timed out waiting for expected webview message");
         |         ^
       78| }
       79|
   ❯ src/ui/__tests__/manualCommit.test.ts:164:5

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

   FAIL  src/ui/__tests__/manualCommit.test.ts > ResultsPanel manual-commit mode (TASK-009) > commit sends COMMIT TRANSACTION and reports closed state
  Error: Timed out waiting for expected webview message
   ❯ flush src/ui/__tests__/manualCommit.test.ts:77:9
       75|     await Promise.resolve();
       76|   }
       77|   throw new Error("Timed out waiting for expected webview message");
         |         ^
       78| }
       79|
   ❯ src/ui/__tests__/manualCommit.test.ts:194:5

  ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯

   Test Files  1 failed (1)
        Tests  4 failed | 3 passed (7)
     Start at  19:45:35
     Duration  266ms (transform 63ms, setup 1ms, collect 69ms, tests 8ms, environment 0ms, prepare 43ms)
Verification Output: |
  $ npm test src/ui/__tests__/manualCommit.test.ts

  > vsdb@1.6.3 test
  > vitest run src/ui/__tests__/manualCommit.test.ts

  The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-009

   ✓ src/ui/__tests__/manualCommit.test.ts  (7 tests) 5ms

   Test Files  1 passed (1)
        Tests  7 passed (7)
     Start at  19:53:54
     Duration  237ms (transform 70ms, setup 0ms, collect 70ms, tests 5ms, environment 0ms, prepare 43ms)

  $ npm run compile

  > vsdb@1.6.3 compile
  > node esbuild.js

    dist/newTableForm.js      20.2kb
    dist/newTableForm.js.map  39.3kb
  ⚡ Done in 9ms
    dist/connectionForm.js       7.4kb
    dist/connectionForm.js.map  12.8kb
  ⚡ Done in 9ms
    dist/aiSettingsForm.js      10.0kb
    dist/aiSettingsForm.js.map  19.2kb
  ⚡ Done in 10ms
    dist/schemaForm.js      3.0kb
    dist/schemaForm.js.map  6.7kb
  ⚡ Done in 11ms
    dist/aiChatPanel.js      14.3kb
    dist/aiChatPanel.js.map  32.6kb
  ⚡ Done in 12ms
    dist/webview.js        2.2mb ⚠️
    dist/webview.css      21.5kb
    dist/webview.js.map    4.0mb
    dist/webview.css.map  40.9kb
  ⚡ Done in 153ms
    dist/extension.js      4.8mb ⚠️
    dist/extension.js.map  8.0mb
  ⚡ Done in 157ms
  esbuild: build complete

  $ npm test

  > vsdb@1.6.3 test
  > vitest run

  The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-009

  ✓ 95 test files passed; 1 test file skipped.
  ✓ 1326 tests passed; 2 tests skipped; 0 tests failed.
  Note: expected stderr from ResultsPanel postMessage rejection tests was emitted:
  [vsdb] postMessage rejected: DataCloneError: BigInt
  [vsdb] postMessage sync throw: Boom sync

   Test Files  95 passed | 1 skipped (96)
        Tests  1326 passed | 2 skipped (1328)
     Start at  19:54:00
     Duration  11.60s (transform 3.46s, setup 4ms, collect 10.10s, tests 53.39s, environment 14.11s, prepare 6.09s)

  $ npm run typecheck

  > vsdb@1.6.3 typecheck
  > tsc --noEmit
Status: FAIL
Note: Implementation and all checks pass, but the task's hard file boundary forbids modifying src/extension.ts, the sole ResultsPanel SaveContext wiring site. Consequently `ConnectionConfig.manualCommit` is never supplied to ResultsPanel in production and the user-facing toggle is unreachable. A one-line getManualCommit: () => mgr.getActive()?.manualCommit === true addition to src/extension.ts is required for PASS; it was not made because it is outside the permitted Target Files.

## Orchestrator Resolution
The missing runtime seam was a planner Target Files omission, not an implementation failure. The orchestrator added `getManualCommit: () => mgr.getActive()?.manualCommit === true` to `src/extension.ts:94`, then reran `npm run compile`, targeted manual-commit tests (7/7), `npm run typecheck`, and the full suite (1326 passed / 2 skipped / 0 failed). The production path is now wired.
