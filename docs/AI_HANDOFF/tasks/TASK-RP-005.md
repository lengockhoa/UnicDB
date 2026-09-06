# TASK-RP-005 — Fix wave 1+2 regressions blocking the cycle gate

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4 (Test Plan) — "test thật kỹ" requires the full suite green.

## Goal

Wave 1 (RP-001) refactored `ResultsPanel.show()` to call `vscode.commands.executeCommand("UnicDB-results.focus")` instead of `createWebviewPanel(...)`. Wave 2 (RP-003) added a `viewsContainers.panel` + activationEvent to `package.json`. Both changes were verified against a NARROW test set in their own tasks; the full-suite gate (RP-004) caught 14 regressions that need fixing before the cycle can close:

1. **`src/ui/__tests__/manualCommit.test.ts`** — 12 tests fail with `No "commands" export is defined on the "vscode" mock`. Fix: add `commands: { executeCommand: vi.fn() }` to the `vi.mock("vscode", ...)` block.
2. **`src/adapters/__tests__/bq04SurfaceGuard.test.ts`** — frozen-surface guard detects `package.json` changes (activation event + `viewsContainers.panel` addition). Fix: advance `BASE_REF` from `6f3fcc0` to a commit that includes RP-003's manifest changes (suggest `1ca64fa` — the wave-2 commit, the parent of `405af76` which is the wave-3-partial commit).
3. **`src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts`** — same root cause. Fix: advance `BASE_REF` to the same target.

After this task the full `npm test` suite must be green.

## Target Files

- `src/ui/__tests__/manualCommit.test.ts` — add `commands: { executeCommand: vi.fn() }` to the vscode mock (line ~54 area). Import `vi` from `vitest` if not already imported.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — change `BASE_REF` constant (line ~40) from `"6f3fcc0"` to `"1ca64fa"` (the wave-2 commit that introduced the accepted package.json changes).
- `src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts` — same `BASE_REF` update.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug fix) | `manualCommit mock exposes vscode.commands` | `npm test src/ui/__tests__/manualCommit.test.ts` exits 0 with all tests passing (RED today: 12 tests fail with "No commands export") | mock at line ~54 |
| 2 | regression (bug fix) | `bq04 frozen-surface guard accepts the new manifest base` | `npm test src/adapters/__tests__/bq04SurfaceGuard.test.ts` exits 0; the `package.json dependency manifest unchanged` test passes with the new BASE_REF | BASE_REF at line ~40 |
| 3 | regression (bug fix) | `bqFollowup frozen-surface guard accepts the new manifest base` | `npm test src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts` exits 0; the `package.json dependency manifest unchanged` test passes with the new BASE_REF | BASE_REF at line ~40 |
| 4 | regression (suite gate) | full `npm test` exits 0 with 0 failed tests | `npm test` reports `Test Files 0 failed` and `Tests 0 failed` (excluding any pre-existing flaky/perf flakes outside this scope) | full repo state |

## Test Files

No new test files. This task fixes mocks + guard base constants so existing tests pass.

## Verification Commands

```bash
npm test src/ui/__tests__/manualCommit.test.ts
npm test src/adapters/__tests__/bq04SurfaceGuard.test.ts
npm test src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (cases 1–3 RED against current main; case 4 follows).
- [ ] Full `npm test` reports 0 failed test files and 0 failed tests (modulo any unrelated pre-existing flakes).
- [ ] Diff limited to the three files listed in Target Files (plus the task file itself).
- [ ] `npm run typecheck && npm run compile` pass.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-RP-001 must be merged (provides the new `show()` that calls `executeCommand`).
- TASK-RP-003 must be merged (provides the new package.json state).

## Interfaces

- Consumes: `ResultsPanel.show()`'s call to `vscode.commands.executeCommand("UnicDB-results.focus")` from TASK-RP-001.
- Produces: green full-suite gate; nothing downstream.

---

## Discussion

### 2026-09-06 · orchestrator · main session
- The 14 failures split cleanly into 3 root causes:
  - 12 manualCommit: missing `commands` mock in the test's vi.mock block. RP-001's narrow verification did not include manualCommit because the test is a sibling suite, not in RP-001's direct list. The fix is one-line per mock.
  - 2 bq04/bqf surface guards: by design they detect any package.json diff vs BASE_REF `6f3fcc0`. RP-003's manifest edits are exactly the kind of change they detect. Advancing BASE_REF to `1ca64fa` (wave-2 commit) re-aligns the guard with the new frozen surface.
- The 5 aiChat*Webview failures observed during RP-004's worktree run were worktree-specific (missing `node_modules/.bin/esbuild` symlink); they do NOT appear in the main worktree. No action needed.
- saveStatementsParser perf test passed in isolation; it is parallel-run noise, not a real regression.
- BASE_REF choice: `1ca64fa` is the wave-2 commit and the parent of `405af76` (RP-004 partial commit). RP-004 partial commit only adds a test file; advancing to `1ca64fa` covers the manifest edits while excluding the test-only commit.
- This task touches three files only — a tight fix-round scope. No new task files; this IS the fix round.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
