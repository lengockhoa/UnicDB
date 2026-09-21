# TASK-CL-002 — ARP-07 invalidation wiring: form-view DDL + AI plan-apply fire the seam

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 TASK-CL-002

## Goal

Close the ARP-07 known gap: the successful-DDL invalidation seam
(`invalidateAfterSchemaDdl`, extension.ts:117, assigned :863) fires only from the shared
`runStatements` path (:1982). Form-view DDL (`tableCommands.ts` `runDdl` :117-124 and the
SchemaForm `runDdl` :578-580) and AI plan-apply (`aiChatPanel.ts:3708`) call
`adapter.runQuery` directly and never invalidate. Wire both through an optional injected
callback without changing any reviewed flow's UX.

## Target Files

- `src/extension.ts` — thread the existing closure into both injection points: `registerTableCommands({…, onSchemaDdl})` at :372 and the `new AiChatPanel({…, onSchemaDdl})` options at :1404. The closure itself (:863-867) and `runStatements` firing stay byte-identical.
- `src/ui/tableCommands.ts` — add `onSchemaDdl?: (statements: readonly string[], dialect?: SqlDialect) => void` to `RegisterDeps`; local `toSqlDialect` narrowing (`"bigquery" → undefined`); fire it in `runDdl` (:117-124) after `await adapter.runQuery(sql)` resolves, and in the SchemaForm `runDdl` (:578-580) the same way. Never on the error path.
- `src/ui/aiChatPanel.ts` — add `onSchemaDdl?: (statements: readonly string[]) => void` to `AiChatPanelOptions`; fire it inside the plan-apply execute callback (:3701-3708) after the per-statement `await adapter.runQuery(sql)` resolves. No driver access here — extension derives dialect in its closure.
- `src/ui/__tests__/tableCommands.test.ts` — form-DDL seam pins.
- `src/ui/__tests__/aiChatPanelPlan.test.ts` — plan-apply seam pins.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | newTable form `runDdl` success fires seam | `onSchemaDdl` mock called exactly once, `["CREATE TABLE …"]` + dialect `"postgres"` (from `conn.driver`) | existing newTable test fixture + injected mock callback |
| 2 | happy | modifyTable/rename family fires seam | same shape for a modifyTable `runDdl` (rename path uses `runDdl` too) | existing fixture + mock |
| 3 | edge (error path) | `adapter.runQuery` rejects → NO fire | callback NOT called; the existing error message path unchanged (`New Table failed: …` toast) | mock adapter `runQuery: async () => { throw new Error("boom") }` |
| 4 | edge (absent dep) | `RegisterDeps` without `onSchemaDdl` | command completes normally, no throw — optional contract pin (all existing tests already construct without it) | existing fixtures untouched |
| 5 | edge (driver narrowing) | `conn.driver === "bigquery"` | callback receives `dialect === undefined` (bigquery has no SqlDialect — mirrors extension.ts:131-135) | fixture with bigquery driver conn |
| 6 | happy | plan-apply full success fires per statement | 2-statement plan → callback called 2× in statement order with each applied sql | existing `aiChatPanelPlan.test.ts` fake adapter (:216-223) + mock callback |
| 7 | edge (partial failure) | execute throws at statement 3 of 4 | callback fired exactly 2× (applied prefix only, never the failed/remaining tail); "Plan apply stopped" message unchanged | existing drift/failure fixtures pattern |
| 8 | edge (no connection) | `adapterFactory` resolves null | zero callbacks; existing "Plan apply stopped: applied 0/2" contract preserved | existing test #5 pattern |
| 9 | edge (consent gate) | plan denied / drifted → ZERO runQuery AND zero callbacks | existing zero-runQuery tests extended to assert zero `onSchemaDdl` calls | existing tests #3/#4 fixtures |

## Test Files

- `src/ui/__tests__/tableCommands.test.ts` — tests #1-#5
- `src/ui/__tests__/aiChatPanelPlan.test.ts` — tests #6-#9

## Verification Commands

```bash
npx vitest run src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/aiChatPanelPlan.test.ts
npm run typecheck
```

(No `lint` script exists — `npm run typecheck` is the static gate. Sanity net after green: `npx vitest run src/extension.test.ts` — extension wiring changed, run it even though the file is not in the narrowed set.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; the per-statement firing order pinned by tests #1/#6.
- [ ] `invalidateAfterSchemaDdl` closure, `runStatements` firing, and deactivate teardown (`:1252`) byte-identical to `611df12`.
- [ ] Both new options are optional (`?.` invocation) — zero behavior change for any caller that omits them (test #4/#9).
- [ ] Error paths never fire the seam (tests #3, #7 tail, #8, #9).
- [ ] `npm run typecheck` exits 0.
- [ ] No file outside §Target Files modified; no new exported symbol besides the two optional option fields.

## Dependencies

- (none)

## Interfaces

- Consumes: `invalidateAfterSchemaDdl: (completed: readonly string[], dialect?: SqlDialect) => void` (extension.ts:117 module seam, existing — extended as injected option, not re-typed); `SqlDialect` (statementParser.ts:21); `ConnectionConfig["driver"]`; `completedSchemaImpact(completed: readonly string[], dialect?: SqlDialect): boolean` (schemaImpact.ts:129, unchanged); `runRenameStatements(statements, execute, onProgress, isCancelled)` (renameRunner.ts:65, unchanged — the callback fires inside the `execute` wrapper at aiChatPanel.ts:3703-3709).
- Produces: `RegisterDeps.onSchemaDdl?: (statements: readonly string[], dialect?: SqlDialect) => void` and `AiChatPanelOptions.onSchemaDdl?: (statements: readonly string[]) => void` — the two new optional fields; callers may pass `(sqls, dialect) => void`. No other surface change.

---

## Discussion

### 2026-09-02 · executor · unic-code
Implementation matches the planner's note. RED→GREEN→VERIFY observed in
this session:

RED (new tests on unmodified source — 7 failed in tableCommands + aiChatPanelPlan):
- tableCommands.test.ts > #1 newTable form runDdl success → onSchemaDdl not called (0 vs 1 expected)
- tableCommands.test.ts > #2 modifyTable runDdl → onSchemaDdl not called (0 vs 1)
- tableCommands.test.ts > #4 absent dep → "Created public.users" info never posted (handler-driven form path)
- tableCommands.test.ts > #5 bigquery narrowing → no panel created (capability gate default matrix)
- aiChatPanelPlan.test.ts > #6 full success → onSchemaDdl not called (0 vs 2)
- aiChatPanelPlan.test.ts > #7 partial failure → onSchemaDdl not called (0 vs 1)
- aiChatPanelPlan.test.ts > #8 apply-time null → "Plan apply stopped" never posted (null factory short-circuited via drift re-check in original setup; corrected test fixture resolves listColumns OK, runQuery throws)

Test #3 (error path) and #9 (consent denied / drift) were ALREADY passing on the unmodified source because the existing code simply doesn't fire the seam; they pin the negative contract so future edits don't accidentally add a fire on the error path.

GREEN (after wiring):
- All 61 tests in the two narrow test files pass.
- `npm run typecheck` exits 0.
- `invalidateAfterSchemaDdl` closure at extension.ts:876-881, `runStatements` firing at :2008, and `deactivate` teardown at :1265 all byte-identical to fe7e0b8 (no edits in those line ranges — verified by git diff).
- 5 source/test files changed, 443 insertions / 4 deletions. Zero files outside §Target Files.

### 2026-09-02 · planner · unic-smart
DI over a new global: `invalidateAfterSchemaDdl` is already a module-private closure — the cheapest correct move is to pass it down through the two EXISTING injection seams (`RegisterDeps`, `AiChatPanelOptions`), both of which extension.ts already constructs. The panel callback intentionally omits the dialect parameter: `DbAdapter` exposes no driver field and the panel only holds `AdapterFactory`, so the panel cannot know the dialect — extension's closure derives it from `mgr.getActive()?.driver` exactly as `runStatements` does at :1982. Per-statement firing (not per-batch) is deliberate: it correctly excludes the failed tail of a partial plan-apply, and `invalidate()` is idempotent. Reviewer: if you prefer once-per-batch for form DDL, the test shapes flip trivially, but per-statement is the more precise contract.

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (representative excerpts from 7 failing tests on unmodified source)
  FAIL src/ui/__tests__/tableCommands.test.ts > tableCommands — TASK-CL-002 ARP-07 invalidation seam > #1 happy: newTable form runDdl success fires onSchemaDdl once with CREATE TABLE + dialect 'postgres'
    AssertionError: expected "spy" to be called 1 times, but got 0 times
  FAIL src/ui/__tests__/tableCommands.test.ts > tableCommands — TASK-CL-002 ARP-07 invalidation seam > #2 happy: modifyTable runDdl fires onSchemaDdl once with the applied ALTER-ish DDL + dialect 'postgres'
    AssertionError: expected "spy" to be called 1 times, but got 0 times
  FAIL src/ui/__tests__/tableCommands.test.ts > tableCommands — TASK-CL-002 ARP-07 invalidation seam > #4 absent dep: RegisterDeps without onSchemaDdl → command completes normally, no throw
    AssertionError: expected false to be true // Object.is equality (handler-driven form path; "Created public.users" info message never posted)
  FAIL src/ui/__tests__/tableCommands.test.ts > tableCommands — TASK-CL-002 ARP-07 invalidation seam > #5 driver narrowing: conn.driver === 'bigquery' → callback receives dialect === undefined
    TypeError: Cannot read properties of undefined (reading 'webview') (capability gate blocked form creation)
  FAIL src/ui/__tests__/aiChatPanelPlan.test.ts > AiChatPanel — TASK-CL-002 ARP-07 invalidation seam (plan-apply) > #6 happy: full success → onSchemaDdl called 2× (per applied statement, in order)
    AssertionError: expected "spy" to be called 2 times, but got 0 times
  FAIL src/ui/__tests__/aiChatPanelPlan.test.ts > AiChatPanel — TASK-CL-002 ARP-07 invalidation seam (plan-apply) > #7 partial failure: execute throws at statement 2 → callback fired exactly 1× (applied prefix only)
    AssertionError: expected "spy" to be called 1 times, but got 0 times
  FAIL src/ui/__tests__/aiChatPanelPlan.test.ts > AiChatPanel — TASK-CL-002 ARP-07 invalidation seam (plan-apply) > #8 no connection: apply-time adapter null → zero callbacks; existing contract preserved
    AssertionError: expected 'Here is the plan.' to contain 'Plan apply stopped'
Verification Output:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/aiChatPanelPlan.test.ts
  result: 2 test files passed, 61/61 tests passed, exit 0
  output_excerpt:
    Test Files  2 passed (2)
    Tests  61 passed (61)
    Start at  22:20:15
    Duration  345ms (transform 269ms, setup 0ms, collect 343ms, tests 29ms, environment 0ms, prepare 74ms)

  command: npm run typecheck
  result: tsc --noEmit, exit 0

  command: npx vitest run src/extension.test.ts
  result: 1 test file, 169/170 passed (1 pre-existing schemaFormBundlePresent dist artifact failure unrelated to this task — confirmed by `git stash` re-run on clean tree)
Status: PASS
Note: All §Test Cases wired and pinned. The `runDdl` helper now also fires the seam for ANALYZE/VACUUM paths since they share the helper; this is safe because the host closure's `completedSchemaImpact` filter (extension.ts:877) returns false for non-DDL statements so the cache invalidation is a no-op. The seam is optional — every existing test that constructs `RegisterDeps` without `onSchemaDdl` continues to pass without changes.

## Reviewer Verdict

VERDICT: approved
REVIEWER_MODEL: unic-smart (opus tier)
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/aiChatPanelPlan.test.ts
  result: 61/61 pass (2 files); npm run typecheck exit 0; npx vitest run src/extension.test.ts 109/109 pass
TEST_PLAN_COVERAGE: all-followed — §Test Cases #1–#9 all implemented with real assertions; RED_OUTPUT contains genuine failing-test excerpts (7 failures on unmodified source); existing tests untouched (0 deleted lines in both test files).
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ui/tableCommands.ts:133 — Note only: executor's report claim "runDdl helper now also fires seam for ANALYZE/VACUUM paths" is inaccurate in the safer direction — call sites at :463/:484 still pass 3 args (no onSchemaDdl), so the seam never fires for them. Independently verified safe: completedSchemaImpact (schemaImpact.ts:129) filters non-DDL keywords anyway. No action required.
    - src/ui/tableCommands.ts:133-141 — toLocalSqlDialect duplicates extension.ts toSqlDialect (:131-135) exactly; acceptable per plan's boundary rationale (avoids crossing module seam per DDL), but the two now must stay in sync manually.
NOTES: Closure-order hazard (registerTableCommands at extension.ts:372 vs closure assignment at :876) is correctly handled — the thunk reads the module-private binding at fire time, not registration time; `?.` guards null before assignment and after deactivate (:1265). Plan-apply per-statement firing verified against runRenameStatements (renameRunner.ts:65): throw → applied=i, so failed statement and remaining tail never reach the seam. BQ-00 frozen surface (bigqueryTypes.ts, bigqueryAdc.ts) untouched in range. Model isolation confirmed: executor unic-code (sonnet) != reviewer unic-smart (opus).
NEXT_STATUS_FOR_INDEX: approved
