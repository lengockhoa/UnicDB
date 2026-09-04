# TASK-UX2-003 — queryRunner.runFailed + statusBar.setErrorBadge (host side)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Add a public `runFailed(reason: string): void` method on `QueryRunner` that emits
ONE synthetic StatementResult so the Results panel renders the same shape for
connection-failure as for a failed statement. The `extension.ts` `runStatements`
outer catch (TASK-UX2-004) will call this instead of dropping a toast.

Also change `createStatusBar` to return a wrapper object that exposes
`setErrorBadge(reason: string | null)` for the red error-state on the active
connection chip. This is a breaking change for one production caller and two
test mocks — see Acceptance Criteria for the migration list.

## Target Files

- `src/core/queryRunner.ts` — add `runFailed(reason: string): void` and the
  `RunnerBusy` error class. Pure addition; no existing method body touched.
- `src/core/__tests__/queryRunner.test.ts` — extend with the 5 new test cases
  from PLAN §4.
- `src/ui/statusBar.ts` — change `createStatusBar` to return a wrapper object
  `{ item: vscode.StatusBarItem; setErrorBadge(reason: string | null): void;
  dispose(): void }` instead of a bare `StatusBarItem`. Add `setErrorBadge`
  method that flips text to red `$(error) <name>` with `vsdb: error: <reason>`
  tooltip; clears on `null`.
- `src/ui/__tests__/statusBar.test.ts` — extend with the 2 new wrapper-shape
  cases from PLAN §4.
- `src/extension.ts:420` — update the one caller to use the new return shape
  (`.item` for the existing dispose, `.dispose()` for cleanup, optional
  `.setErrorBadge(...)` call).
- `src/scaffold.test.ts:16` and `src/extension.test.ts:97` — update the two
  test mocks for the same wrapper shape.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `runner.runFailed("ECONNREFUSED")` synchronously appends one StatementResult `{index:0, sql:"(connection)", status:"error", error:"ECONNREFUSED", durationMs:0}` and fires `onUpdate` | match | fresh runner |
| 2 | unit | `runFailed` while a real `run()` is in flight throws `RunnerBusy` | throws | mid-run |
| 3 | edge | `runFailed` after a cancelled run appends a new synthetic row (does not crash on the cancelled-flag state) | append OK | cancelled then failed |
| 4 | edge | calling `runFailed` twice accumulates two synthetic rows | 2 rows | after first runFailed |
| 5 | regression | regular `run([stmt])` after `runFailed` works (does not leak the synthetic row into the new run's state) | unaffected | mixed |
| 6 | unit | `createStatusBar(mgr).setErrorBadge("X")` then `.setErrorBadge(null)` — item text is red `$(error)` then back to plain | match | mock mgr |
| 7 | unit | `createStatusBar(mgr).item` returns the underlying `vscode.StatusBarItem` for existing dispose call sites; `createStatusBar(mgr).dispose()` is the canonical cleanup | match | mock mgr |

## Test Files

- `src/core/__tests__/queryRunner.test.ts` (extend, 5 cases).
- `src/ui/__tests__/statusBar.test.ts` (extend, 2 cases).

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test src/core/__tests__/queryRunner.test.ts
npm test src/ui/__tests__/statusBar.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (7/7 across 2 files).
- [ ] `runFailed` does NOT allocate inside the run loop (no allocation in
      `executeAll` / `loadMoreImpl`).
- [ ] `runFailed` reuses the existing `onUpdate` callback contract (no separate
      emit).
- [ ] No existing `queryRunner.test.ts` case breaks.
- [ ] `runFailed` is idempotent: a second call before the panel has rendered
      the first does not crash (just appends).
- [ ] **`createStatusBar` return-type change migration**:
  - `src/extension.ts:420` updated to use `.item` (where the bare item was
    used) and `.dispose()` (where the cleanup was needed).
  - `src/scaffold.test.ts:16` mock updated to the wrapper shape.
  - `src/extension.test.ts:97` mock updated to the wrapper shape.
  - All three call sites pass `npm test` and `npm run typecheck`.
- [ ] `setErrorBadge` flips the active connection chip to red `$(error) <name>`
      with `vsdb: error: <reason>` tooltip; `.setErrorBadge(null)` clears.
- [ ] No regression in `statusBar.test.ts` or `scaffold.test.ts` or
      `extension.test.ts`.

## Dependencies

- TASK-UX2-001 (the render primitive must accept the synthetic row's
  `kind: undefined + status: "error"` shape before the panel can render it).

## Interfaces

- Consumes: (none — pure addition to `QueryRunner` and additive wrapper for
  `createStatusBar`)
- Produces:
  - `QueryRunner.runFailed(reason: string): void` — new public method.
  - `RunnerBusy` error class (exported from `queryRunner.ts`).
  - `createStatusBar(mgr)` now returns
    `{ item: vscode.StatusBarItem; setErrorBadge(reason: string | null): void;
    dispose(): void }` — breaking change.

---

## Executor Report

EXECUTOR_MODEL: unic-code
EXECUTOR_TOOL: claude-code
EXECUTOR_SUBAGENT: -

### RED output — `vitest run src/core/__tests__/queryRunner.test.ts`

5/75 tests failed (5 new TASK-UX2-003 cases), all RED for the expected reasons:

```
 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — runFailed (TASK-UX2-003) > case 1 — runFailed appends one synthetic StatementResult and fires onUpdate
TypeError: runner.runFailed is not a function
 ❯ src/core/__tests__/queryRunner.test.ts:2096:12
    2096|     runner.runFailed("ECONNREFUSED");

 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — runFailed (TASK-UX2-003) > case 2 — runFailed while a real run() is in flight throws RunnerBusy
AssertionError: expected 'TypeError' to be 'RunnerBusy' // Object.is equality
 ❯ src/core/__tests__/queryRunner.test.ts:2133:76

 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — runFailed (TASK-UX2-003) > case 3 — runFailed after a cancelled run appends a new synthetic row
AssertionError: expected [Function] to not throw an error but 'TypeError: runner.runFailed is not a …' was thrown

 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — runFailed (TASK-UX2-003) > case 4 — calling runFailed twice accumulates two synthetic rows
TypeError: runner.runFailed is not a function

 FAIL  src/core/__tests__/queryRunner.test.ts > QueryRunner — runFailed (TASK-UX2-003) > case 5 — regression: regular run() after runFailed is unaffected
TypeError: runner.runFailed is not a function

 Test Files  1 failed (1)
      Tests  5 failed | 70 passed (75)
```

### RED output — `vitest run src/ui/__tests__/statusBar.test.ts`

2/7 tests failed (2 new TASK-UX2-003 cases):

```
 FAIL  src/ui/__tests__/statusBar.test.ts > createStatusBar > case 6 — setErrorBadge flips text to $(error) then back to plain on null
TypeError: Cannot read properties of undefined (reading 'text')
 ❯ src/ui/__tests__/statusBar.test.ts:326:25
    326|     expect(wrapper.item.text).toBe("$(database) Local [postgres]");

 FAIL  src/ui/__tests__/statusBar.test.ts > createStatusBar > case 7 — wrapper exposes item (underlying StatusBarItem) + dispose for existing call sites
AssertionError: expected undefined not to be undefined
 ❯ src/ui/__tests__/statusBar.test.ts:357:26
    357|     expect(wrapper.item).toBeDefined();

 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
```

### GREEN output (post-implementation)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003

 ✓ src/ui/__tests__/statusBar.test.ts  (7 tests) 20ms
 ✓ src/core/__tests__/queryRunner.test.ts  (75 tests) 248ms
 ✓ src/scaffold.test.ts  (7 tests) 520ms
 ✓ src/extension.test.ts  (151 tests) 1335ms

 Test Files  4 passed (4)
      Tests  240 passed (240)
```

### Verification

- `npm run typecheck` (i.e. `tsc --noEmit`): exit 0, no output (clean).
- `npm run compile` (esbuild): builds dist/extension.js, dist/schemaForm.js etc. The webviewConfig build (dist/webview.js) fails with `Could not resolve "./tabTitle"` — this is **pre-existing** and tied to TASK-UX2-002's `webview/main.ts` import, not to TASK-UX2-003. Out of scope here.
- `npm test` (vitest run, full suite): 3546 tests collected. 1 pre-existing environmental failure (`agGridSmoke.test.ts` reads `dist/webview.css`, missing because the webview bundle above failed) — unrelated to TASK-UX2-003. All 7 new TASK-UX2-003 tests pass.

### Files changed

- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003/src/core/queryRunner.ts` — exported `RunnerBusy` error class; added `lastOnUpdate` field; cached `onUpdate` on `run()` entry; added public `runFailed(reason: string): void` method that throws `RunnerBusy` while a real run is in flight, otherwise appends `{index, sql:"(connection)", status:"error", error:reason, durationMs:0}` and fires the cached onUpdate.
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003/src/ui/statusBar.ts` — exported `StatusBarWrapper` interface; `createStatusBar` now returns `{item, setErrorBadge, dispose}` instead of a bare `vscode.StatusBarItem`; `setErrorBadge(reason)` flips the chip to red `$(error) <name> [driver]` with tooltip `vsdb: error: <reason>`, `setErrorBadge(null)` restores via shared render.
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003/src/extension.ts` — imported `StatusBarWrapper`; updated interface field type at line 254 (`statusBar: StatusBarWrapper`); `context.subscriptions.push(statusBar)` at line 421 still works because the wrapper has `.dispose()` (Disposable-compatible).
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003/src/core/__tests__/queryRunner.test.ts` — added `RunnerBusy` import; added `describe("QueryRunner — runFailed (TASK-UX2-003)")` block with 5 cases (cases 1-5).
- `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/UX2-003/src/ui/__tests__/statusBar.test.ts` — updated existing tests to access the wrapper via `.item` (5 tests use `item.item.text`/`.command`/`.hide`/`.show`); added cases 6 and 7 for `setErrorBadge` and wrapper shape.

### Notes

- The existing statusBar test variable name `item` was retained (it now points to the wrapper); assertions were rewritten to access `.item.text` etc. This preserves diff size vs renaming the variable.
- `lastOnUpdate` is intentionally NOT cleared in the `run()` finally block — the host's outer catch fires AFTER `run()` settles (with the connection failure that aborted it), so `lastOnUpdate` must still be set when the host calls `runner.runFailed(reason)`. A subsequent `run()` overwrites it on entry.
- `npm test` baseline: this worktree differs from the 3530|2 baseline cited in PLAN §5 (3546|1 here). The single failure is unrelated to this task: `agGridSmoke.test.ts` requires `dist/webview.css`, which is missing because the webview esbuild config cannot resolve `./tabTitle` (introduced by TASK-UX2-002, separate wave).
- Did not run `git add` / `git commit` / `git push` per task instruction.

---

## Discussion

(no comments yet)

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npm test src/core/__tests__/queryRunner.test.ts && npm test src/ui/__tests__/statusBar.test.ts && npm test src/scaffold.test.ts src/extension.test.ts && npm test
  result: typecheck exit 0; compile exit 0; queryRunner 75/75 pass; statusBar 7/7 pass; scaffold+extension 158/158 pass; full suite 3555 pass / 0 fail (1 skipped, 234 files)
TEST_PLAN_COVERAGE: all-followed — 7/7 plan cases implemented with real assertions (5 queryRunner + 2 statusBar); RED_OUTPUT contains genuine pre-impl failures (TypeError/AssertionError with file:line); edge cases 3 (cancelled-then-failed) and 4 (double-append) present; case 2 pins RunnerBusy by constructor name, not just any throw.
FINDINGS:
  critical:
    - (none)
  important:
    - (none)
  minor:
    - src/ui/statusBar.ts:147 — file ends without a trailing newline ("\ No newline at end of file"); add one to keep editors/linters quiet.
    - Task file acceptance checkboxes left unticked although every criterion is now verifiably met — tick them or note completion in RUN.md.
    - Plan's migration list is partly inapplicable: scaffold.test.ts:16 and extension.test.ts:97 mock `vscode.window.createStatusBarItem` (one layer below the new wrapper), so they correctly needed no change. `lastOnUpdate` surviving run() finally is correctly reasoned (host outer catch fires post-settle) — no leak risk: next run() overwrites it on entry.
NOTES: Executor's reported compile/agGridSmoke failures were a transient worktree state (tabTitle.ts landed in the same wave-2 commit b18e681); both are green at HEAD. runFailed makes no allocation in executeAll/loadMoreImpl — only a single field assignment at run() entry, outside the loop. Wrapper's dispose() is Disposable-compatible so context.subscriptions.push(statusBar) at src/extension.ts:422 stays correct.
NEXT_STATUS_FOR_INDEX: approved_minor

### Re-pass confirmation (2026-09-04)

A second independent `unic-smart` reviewer re-passed UX2-003 (agent aebc510e59ba2d2e2) and found the on-disk verdict already in place from the first pass. Re-verification independent of the executor:

- Model isolation: executor `unic-code` ≠ reviewer `unic-smart` ✓
- `npm run typecheck` exit 0; `npm run compile` exit 0 (clean at HEAD, the executor's reported `tabTitle` webview failure no longer reproduces — UX2-002 sibling landed in same range)
- `npm test src/core/__tests__/queryRunner.test.ts src/ui/__tests__/statusBar.test.ts` — 82/82 pass
- `npm test src/extension.test.ts src/scaffold.test.ts` — 158/158 pass
- Diff cross-check vs all 7 spec rows: synthetic row shape exact, `RunnerBusy` pinned by constructor name in case 2, `lastOnUpdate` cached at `src/core/queryRunner.ts:281` on `run()` entry and deliberately not cleared in finally (`src/core/queryRunner.ts:326-340`) — correct because host catch at `src/extension.ts:2635` fires post-settle. Wrapper migration at `src/extension.ts:421-422` (Disposable-compatible); both mocks stub below the wrapper so no change needed. No allocation in the run loop.

Re-confirmation verdict: **APPROVED-WITH-MINOR** (no new findings). INDEX row `approved_minor` stands.
