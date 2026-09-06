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

## Executor Report

STATUS: PARTIAL
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Applied the three prescribed edits exactly as specified. Each edit removed its original failure but exposed a second-layer failure that the prescribed fix does not address — net change in suite-wide failures = 0 (still 14 failed). typecheck and compile pass cleanly. Full `npm test` confirms 14 failed | 3527 passed | 2 skipped. The orchestrator's hypothesis about what each edit would fix was correct for the symptom listed in §Goal but incomplete: the underlying test logic depends on additional infrastructure (panel creation in mock; sanity check CHANGELOG diff in BASE_REF~1..BASE_REF) that the prescribed one-line edits do not provide.
TEST_PLAN_FOLLOWED: task §Test Cases (inline — followed exactly as specified by orchestrator)
FILES_CHANGED:
  - src/ui/__tests__/manualCommit.test.ts: added `commands: { executeCommand: vi.fn() }` to the vi.mock("vscode", …) block (one line, line ~72 area)
  - src/adapters/__tests__/bq04SurfaceGuard.test.ts: BASE_REF changed `6f3fcc0` → `1ca64fa` (line 40)
  - src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts: BASE_REF changed `6f3fcc0` → `1ca64fa` (line 39)
TESTS_ADDED: none
VERIFICATION:
  command: npm test src/ui/__tests__/manualCommit.test.ts
  result: 12 failed (12) — original "No commands export" error gone; replaced by TypeError: Cannot read properties of null (reading 'webview') from makeRefreshPanel at line 291 (lastPanel.current is null because the new production code path calls executeCommand("UnicDB-results.focus") instead of createWebviewPanel, and the mocked executeCommand is a plain vi.fn() that never instantiates a panel)
  output_excerpt: |
    TypeError: Cannot read properties of null (reading 'webview')
     ❯ makeRefreshPanel src/ui/__tests__/manualCommit.test.ts:291:90
        291|     return { panel, transaction, runSql, runSqlCalls, adopt, webview: …
           |                                                                                          ^
     ❯ src/ui/__tests__/manualCommit.test.ts:363:58
     Test Files  1 failed (1)
          Tests  12 failed (12)
  command: npm test src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 1 failed | 7 passed (8) — original `package.json dependency manifest unchanged` test PASSES (the BASE_REF advance did fix it); NEW failure is the sanity-check at line 545 expecting non-empty diff in `BASE_REF~1..BASE_REF -- CHANGELOG.md`, but `1ed33ae..1ca64fa` (BASE_REF=1ca64fa) contains NO CHANGELOG.md edits — only RUN.md + TASK-RP-003.md + package.json + the new manifest test file
  output_excerpt: |
    AssertionError: expected 0 to be greater than 0
     ❯ src/adapters/__tests__/bq04SurfaceGuard.test.ts:545:31
     Test Files  1 failed (1)
          Tests  1 failed | 7 passed (8)
  command: npm test src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts
  result: 1 failed | 4 passed (5) — same shape as bq04: dependency-manifest test PASSES, sanity-check FAILS at line 174. The test's own comment says "BQ-FOLLOWUP wave 1 (5119ebd) touched CHANGELOG.md — guaranteed non-empty" but with BASE_REF=1ca64fa the range 1ed33ae..1ca64fa has no CHANGELOG.md edits. The comment is now stale.
  output_excerpt: |
    AssertionError: expected 0 to be greater than 0
     ❯ src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts:174:31
     Test Files  1 failed (1)
          Tests  1 failed | 4 passed (5)
  command: npm run typecheck
  result: PASS (tsc --noEmit, exit 0, no output)
  command: npm run compile
  result: PASS (esbuild build complete: dist/extension.js + dist/webview.js)
  command: npm test
  result: 8 test files failed | 236 passed | 1 skipped (245) ; 14 tests failed | 3527 passed | 2 skipped (3543) — same 14 failures as the pre-edit baseline; the 3 prescribed edits shift failure modes but do not reduce the count
ISSUES:
  - The prescribed manualCommit fix (add commands: { executeCommand: vi.fn() }) is necessary but insufficient. After RP-001, ResultsPanel.show() calls `vscode.commands.executeCommand("UnicDB-results.focus")` and never calls `vscode.window.createWebviewPanel`. The mock must instantiate the FakeWebviewPanel and assign `lastPanel.current = panel` inside the executeCommand handler when called with `"UnicDB-results.focus"`. Minimal extension: change the mock to `commands: { executeCommand: vi.fn(async (cmd: string) => { if (cmd === "UnicDB-results.focus") { const p = new FakeWebviewPanel(); lastPanel.current = p; } }) }`. Orchestrator instruction said "Three narrow edits only" + "DO NOT touch any file other than the three listed" so I did NOT apply this extension.
  - The prescribed BASE_REF=1ca64fa is incompatible with the existing sanity-check at the bottom of each guard. The sanity check asserts `git diff ${BASE_REF}~1..${BASE_REF} -- CHANGELOG.md` is non-empty. 1ca64fa's parent (1ed33ae = wave 1) modified no CHANGELOG.md content. The original BASE_REF `6f3fcc0` worked because that commit IS the R5 release commit (release(PUBLISH-02): rename extension vsdb → UnicDB) and its parent commit legitimately bumped CHANGELOG. There is NO commit between 1ed33ae and HEAD (2f865b1) that bumps CHANGELOG.md: 1ed33ae (TASK-RP-001/002 guide), 1ca64fa (TASK-RP-003 manifest), 405af76 (TASK-RP-004 test file), 2f865b1 (TASK-RP-005 plan file). Wave-1+2+3+fix-round produced no R5 commit. The only ways to make the sanity check pass with the current wave state are (a) change the sanity check's diff path to something that has been modified (e.g. `package.json`), or (b) revert the BASE_REF advance and accept that the dependency-manifest test re-fails. Neither is within the prescribed 3 narrow edits.
  - bqFollowup's sanity-check comment ("BQ-FOLLOWUP wave 1 (5119ebd) touched CHANGELOG.md — guaranteed non-empty") was already stale before this task landed — 5119ebd is not in the linear history at all (it must be from an earlier BQ-FOLLOWUP cycle that was rebased away). With BASE_REF=1ca64fa the comment is doubly misleading.
HANDOFF_TO_REVIEWER: no — status is PARTIAL not DONE; per Handoff rules reviewer only triggers on DONE. The orchestrator should inspect this report and either (a) widen the scope of TASK-RP-005 to include the minimal mock extension + sanity-check path fix, or (b) author a follow-up task that performs those two additional edits. Both options are small and live entirely within the three already-listed target files.
NEXT: orchestrator should widen the scope of this task (or open a follow-up fix-round) to apply: (1) executeCommand mock instantiation in src/ui/__tests__/manualCommit.test.ts (~3 lines around line 72), (2) sanity-check path change in src/adapters/__tests__/bq04SurfaceGuard.test.ts (line ~540 — change CHANGELOG.md to package.json, or similar path with confirmed edits in 1ed33ae..1ca64fa), (3) same path change in src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts (line ~169) + comment update. All three changes are within the same three target files.

## Executor Report (widened fix)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Applied all 6 edits — the 3 original edits plus the 3 follow-on edits specified by the orchestrator. Original 14 regressions are gone; full `npm test` is green (3541 passed, 2 skipped, 0 failed). The 5 "test file failed" entries in the vitest summary are pre-existing worktree-infrastructure errors (missing `node_modules/.bin/esbuild` symlink — `errno: -2 ENOENT`); they are NOT test failures and match the orchestrator's prior §Discussion note about RP-004 worktree run. They do not appear on the main worktree.
TEST_PLAN_FOLLOWED: task §Test Cases (cases 1–3 verified directly; case 4 via full `npm test`)
FILES_CHANGED:
  - src/ui/__tests__/manualCommit.test.ts: (a) added `options: { ... } = {}` to FakeWebviewPanel (so resolveWebviewView's `view.webview.options = { enableScripts, localResourceRoots }` assignment type-checks), (b) added `lastPanelProvider` module-scoped tracking + `__test_setPanel` helper exported via the vi.mock surface, (c) changed `commands.executeCommand` mock to instantiate FakeWebviewPanel AND invoke `lastPanelProvider.current.resolveWebviewView(view, {}, {})` when called with `"UnicDB-results.focus"`, (d) added `lastPanelProvider.current = panel` calls inside `makePanel` and `makeRefreshPanel` so the mock can find the panel after construction.
  - src/adapters/__tests__/bq04SurfaceGuard.test.ts: (e) sanity-check diff path changed `"CHANGELOG.md"` → `"package.json"`; assertion message + log label updated accordingly. (BASE_REF=1ca64fa edit retained from round 1.)
  - src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts: (f) sanity-check diff path changed `"CHANGELOG.md"` → `"package.json"`; stale comment about "BQ-FOLLOWUP wave 1 (5119ebd)" replaced with a true statement ("Wave-2 (TASK-RP-003) modified package.json — guaranteed non-empty"); log label updated. (BASE_REF=1ca64fa edit retained from round 1.)
TESTS_ADDED: none
VERIFICATION:
  command: npm test src/ui/__tests__/manualCommit.test.ts
  result: 12 passed (12)
  output_excerpt: |
    ✓ src/ui/__tests__/manualCommit.test.ts  (12 tests) 7ms
    Test Files  1 passed (1)
         Tests  12 passed (12)
  command: npm test src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 8 passed (8)
  output_excerpt: |
    ✓ src/adapters/__tests__/bq04SurfaceGuard.test.ts  (8 tests) 50ms
    [bq04-guard] sanity diff vs 1ca64fa~1..1ca64fa on package.json: 59 non-empty lines (proves execSync is live)
    Test Files  1 passed (1)
         Tests  8 passed (8)
  command: npm test src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts
  result: 5 passed (5)
  output_excerpt: |
    ✓ src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts  (5 tests) 49ms
    [bqf-guard] sanity diff vs 1ca64fa~1..1ca64fa on package.json: 59 non-empty lines
    Test Files  1 passed (1)
         Tests  5 passed (5)
  command: npm run typecheck
  result: PASS (tsc --noEmit, exit 0, no output)
  command: npm run compile
  result: PASS (esbuild build complete: dist/extension.js + dist/webview.js)
  command: npm test
  result: 5 test files failed | 239 passed | 1 skipped (245) ; 3541 tests passed | 2 skipped (3543) — 0 failed tests. The 5 "failed files" all share the same root cause: `spawnSync .../node_modules/.bin/esbuild ENOENT` (worktree-infrastructure issue: missing esbuild symlink). They throw at module-load time so vitest counts the whole file as failed, but no individual test within them runs/fails. This matches the orchestrator's prior §Discussion note: "The 5 aiChat*Webview failures observed during RP-004's worktree run were worktree-specific (missing `node_modules/.bin/esbuild` symlink); they do NOT appear in the main worktree. No action needed."
ISSUES:
  - The orchestrator's round-2 edit for manualCommit (instantiate FakeWebviewPanel inside the executeCommand mock) was necessary but not sufficient. After panel instantiation, the test still needs `panel.resolveWebviewView(view, …)` to fire so `ResultsPanel.view` is non-null (otherwise `render()`'s `if (this.view) postMessage(…)` skips and every `flush()` times out). I extended the mock with a `lastPanelProvider` tracking variable + `__test_setPanel` helper, and added `lastPanelProvider.current = panel` inside `makePanel` and `makeRefreshPanel`. This is still strictly within `src/ui/__tests__/manualCommit.test.ts` and respects the orchestrator's "do not touch other files" constraint.
  - `FakeWebviewPanel` did not have an `options` property; `resolveWebviewView` assigns `view.webview.options = { enableScripts, localResourceRoots }`, which would have failed at runtime against the bare FakeWebview. Added `options: { enableScripts?: boolean; localResourceRoots?: unknown[] } = {}` to the class. Minimal, type-safe, doesn't break any existing assertion.
  - The 5 module-load-time failures in `npm test` are worktree-only (missing esbuild symlink in `.worktrees/task-rp-005/node_modules/.bin/`). They do not appear in the main worktree. The orchestrator flagged this exact issue in §Discussion and confirmed "No action needed."
HANDOFF_TO_REVIEWER: yes — full cycle gate is now green; task is ready for Phase 4 review.
NEXT: ready for review.
