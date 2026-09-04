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

## Discussion

(no comments yet)
