# TASK-DBX06-006 — Expanded rename preview and confirmed execution

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX06.md` §3

## Goal

Consume TASK-DBX06-005’s expanded catalog report and typed plan steps in the existing RenameForm preview. Preserve DBX-08 table-DDL admission, DOM-safe rendering, explicit approval, and concrete partial-failure/cancellation reporting while executing only the reviewed executable SQL statements.

## Target Files

- `src/core/ddl/renameRunner.ts` — add the ordered executable-step runner and its named applied/failed-step outcome while retaining the existing statement runner.
- `src/ui/renameForm.ts` — request all six usage methods, retain analyzed steps, and post report/steps/statement preview through the existing typed webview protocol.
- `src/ui/renameFormMessages.ts` — extend the analysis message contract with typed plan steps and named step outcomes.
- `webview/renameFormMain.ts` — DOM-render trigger/index rows and typed step labels using `textContent`/`createElement`; do not add HTML sinks.
- `src/core/ddl/__tests__/renameRunner.test.ts` — cover ordered multi-step failure naming and no execution after the failed step.
- `src/ui/__tests__/renameFormHost.test.ts` — cover six lookups, steps, and no execution when analysis fails.
- `src/ui/__tests__/renameFormBundle.test.ts` — cover rendered expanded report/steps, approval state, untrusted text safety, and compiled-bundle sink regression.
- `src/ui/__tests__/tableCommands.test.ts` — preserve the existing exact capability denial behavior for rename commands and no-side-effect admission failure.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy / host | valid analysis calls all six lookups and previews steps | `RenameForm.analyzeName("customers")` invokes views, FKs, routines, collision, triggers, and indexes; table-mode trigger/index calls pass `""` as their third argument; its result has the exact quoted rename statement, typed trigger/index report rows, and one executable rename step plus review steps. | Fake `RenameUsageApi` with empty collision and one trigger/index fixture. |
| 2 | happy / bundle | clean expanded analysis is visibly reviewable | Compiled bundle renders `Trigger: trg_audit`, `Index: users_email_idx`, the exact `Rename table: ALTER TABLE "public"."users" RENAME TO "customers";` label, and enables `#UnicDB-rename-approve`. | Built `dist/renameForm.js`; init then clean expanded analysis message. |
| 3 | edge / capability | denied tableDdl stops rename before all side effects | `UnicDB.renameTable` against `capabilities.tableDdl: false` displays exactly `UnicDB: Rename Table is not supported by this connection's database.`, creates no panel, and performs no `renameUsage`, `listTableDetail`, or `runQuery` call. | Existing tableCommands fake adapter/manager with `tableDdl: false`. |
| 4 | edge / unsafe output | dependency labels are text, not markup | A trigger/index name `<img src=x onerror=1>` appears in the analysis text but creates no `img` element; compiled source contains neither `.innerHTML =` nor `insertAdjacentHTML`. | Expanded analysis message with hostile display names. |
| 5 | regression / partial failure | ordered execution names every applied step and the failure | Given executable steps `Rename table: ALTER TABLE "public"."users" RENAME TO "customers";` then `Rename column: ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";`, host `runQuery` succeeds on the first and rejects the second with `relation locked`; `done` contains `applied: [{ index: 0, label: "Rename table", sql: "ALTER TABLE \"public\".\"users\" RENAME TO \"customers\";" }]` and `failed: { index: 1, label: "Rename column", sql: "ALTER TABLE \"public\".\"customers\" RENAME COLUMN \"name\" TO \"full_name\";", error: "relation locked" }`; no later step is issued. | Multi-operation plan fixture with a third executable step that must not run. |
| 6 | regression / explicit confirmation | bad analysis cannot execute stale SQL | A collision/error analysis clears stored statements/steps; a subsequent `approve` message invokes no `runQuery`. | Analyze valid once, then analyze collision before approve. |

## Test Files

- `src/core/ddl/__tests__/renameRunner.test.ts` — ordered executable-step failure naming and stop-at-first-failure behavior.
- `src/ui/__tests__/renameFormHost.test.ts` — six-lookup analysis, stale-plan clearing, and named-step execution outcome contract.
- `src/ui/__tests__/renameFormBundle.test.ts` — compiled DOM rendering and text-only safety.
- `src/ui/__tests__/tableCommands.test.ts` — exact `tableDdl` capability denial/no side-effects for rename commands.

## Verification Commands

```bash
npm run compile
npx vitest run src/core/ddl/__tests__/renameRunner.test.ts src/ui/__tests__/renameFormHost.test.ts src/ui/__tests__/renameFormBundle.test.ts src/ui/__tests__/tableCommands.test.ts
npm run typecheck
npm run compile
```

`package.json` has no lint script. `npm run typecheck` is the required static check; the first compile is required because the bundle test reads `dist/renameForm.js`.

## Acceptance Criteria

- [ ] RenameForm calls all six bound usage APIs after valid-name validation, passing `""` as the trigger/index column argument for table mode and the current old column name for column mode, and includes trigger/index rows plus `RenamePlan.steps` in its analysis result/protocol.
- [ ] The preview displays every human-readable exact executable rename step and non-executable dependency-review step; the user must explicitly approve after a clean analysis.
- [ ] Approval executes only analyzed executable steps, never dependency review steps; collision/error analysis clears prior executable state.
- [ ] The `tableDdl` false path retains the exact DBX-08 message and has no UI, catalog, introspection, or SQL side effect.
- [ ] DOM rendering remains text-only and safely displays hostile dependency labels.
- [ ] Partial failure/cancellation remain concrete: the report names every applied executable step and the failed one, and does not issue a statement after the failure/cancellation boundary.
- [ ] All listed focused tests, `npm run typecheck`, and `npm run compile` pass.

## Dependencies

- TASK-DBX06-005

## Interfaces

- Consumes: TASK-DBX06-005’s `RenamePlan.steps: RenamePlanStep[]`, ordered executable-step SQL, `RenameCatalogRows` trigger/index fields, `TRIGGERS_SQL(): string` / `INDEXES_SQL(): string` via the adapter seam, and `RenameUsageApi` methods `triggers(schema: string, table: string, column: string)` / `indexes(schema: string, table: string, column: string)` (`""` table mode; old column name column mode); existing `runRenameStatements(statements: string[], execute: (sql: string) => Promise<void>, onProgress: (index: number, total: number, statement: string) => void, isCancelled: () => boolean): Promise<RunOutcome>`; existing `hasAdapterCapability(adapter, "tableDdl")` admission in `guardPostgres`.
- Produces: expanded `RenameFormAnalysis` protocol including typed steps; a DOM-only reviewed preview; additive `runRenameSteps(steps: ReadonlyArray<RenamePlanStep>, execute: (sql: string) => Promise<void>, onProgress: (step: { index: number; label: string; sql: string }, total: number) => void, isCancelled: () => boolean): Promise<{ applied: Array<{ index: number; label: string; sql: string }> } | { applied: Array<{ index: number; label: string; sql: string }>; failed: { index: number; label: string; sql: string; error: string } } | { applied: Array<{ index: number; label: string; sql: string }>; cancelledAfter: number; remaining: number }>`; preserved explicit approve/cancel behavior and named-step `done` outcomes.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Do not create a second command or bypass `guardPostgres`; extend the existing form and command path. The core plan’s review steps remain non-executable, while one or more ordered `rename` steps are executable DDL. Run only those executable steps and preserve their labels through progress and outcome reporting. Keep approval bound to the last clean analysis and clear it on every error result so an older clean plan cannot be approved after a failed analysis.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT: |
  npx vitest run src/core/ddl/__tests__/renameRunner.test.ts:
    ❯ runRenameSteps (DBX06-006 — typed plan step runner) > executes only executable steps in declared order with typed progress
      → runRenameSteps is not a function
    ❯ runRenameSteps (DBX06-006 — typed plan step runner) > multi-step failure names every applied step and the failed step, no later run
      → runRenameSteps is not a function
    ❯ runRenameSteps (DBX06-006 — typed plan step runner) > cancel between steps reports applied + cancelledAfter + remaining
      → runRenameSteps is not a function
    Tests  3 failed | 3 passed (6)

  npx vitest run src/ui/__tests__/renameFormHost.test.ts:
    ❯ RenameForm (DBX06-006 …) > valid name calls all six lookups … result includes typed steps …
      → TypeError: Cannot read properties of undefined (reading 'map')   (r.steps is undefined)
    ❯ RenameForm (DBX06-006 …) > collision analysis clears stored steps …
      → AssertionError: expected undefined to deeply equal []             (bad.steps is undefined)
    Tests  2 failed | 4 passed (6)

  Bundle/tableCommands RED covered by the same contract (analysis without `steps`
  field and unnamed done outcomes) — bundle tests were gated on `npm run compile`,
  so their RED is the compile-time contract above; the compiled-bundle expectations
  (Trigger:/Index:/typed labels/sink regression) failed against the pre-change
  webview which rendered neither triggers nor indexes nor step labels.
Verification Output: |
  npm run compile                          → esbuild: build complete (10 bundles incl. dist/renameForm.js)
  npx vitest run <4 focused test files>    → Test Files 4 passed (4); Tests 65 passed (65)
    - src/core/ddl/__tests__/renameRunner.test.ts   6 pass (ordered exec, named applied/failed, cancel boundary)
    - src/ui/__tests__/renameFormHost.test.ts       9 pass (six lookups, "" column arg, typed steps in protocol,
                                                      named applied step on clean run, named failed step on
                                                      column-mode rejection, stale-plan clearing after collision)
    - src/ui/__tests__/tableCommands.test.ts       44 pass (existing DBX-08 gates + new UnicDB.renameTable
                                                      tableDdl:false exact-message/no-side-effect case)
    - src/ui/__tests__/renameFormBundle.test.ts     6 pass (Trigger:/Index: rows, "Rename table: <SQL>" label,
                                                      approve enablement, hostile <img> label stays text, no
                                                      .innerHTML=/insertAdjacentHTML in bundle, named-step done)
  npm run typecheck                        → tsc --noEmit clean
  npm run compile (second run)             → esbuild: build complete
  Extra sweep: src/core/ddl/__tests__/ + aiChatPanel.test.ts + aiChatPanelPlan*.test.ts
  → 7 files, 89 tests, all pass (aiChatPanel still uses unchanged runRenameStatements).
Status: PASS
Note: runRenameSteps reports step labels from operation.kind ("Rename table"/"Rename column");
      done message shape is named-step (applied[] + failed/cancelledAfter), legacy runRenameStatements
      kept untouched for aiChatPanel.


---

## Reviewer Verdict

VERDICT: approved
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
  command: npm run compile && npx vitest run src/core/ddl/__tests__/renameRunner.test.ts src/ui/__tests__/renameFormHost.test.ts src/ui/__tests__/renameFormBundle.test.ts src/ui/__tests__/tableCommands.test.ts && npm run typecheck
  result: 4 files passed, 65 tests passed; tsc --noEmit clean; esbuild build complete
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical: none
  important: none
  minor:
    - file: webview/renameFormMain.ts:64 — `humanLabelForStep` duplicates the host-side `renameStepLabel` (src/core/ddl/renameRunner.ts) for executable-step labels; webview cannot import core, so this is acceptable, but a shared label map would prevent future drift between preview and progress/done wording.
    - file: src/ui/renameForm.ts:301 — the catch-path `done.failed` fallback uses the placeholder label "rename" instead of a human label ("Rename table"/"Rename column"); this path only fires when runRenameSteps itself throws (adapter resolution failure), not a step failure, and is not covered by the task's pinning tests.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Executor self-reported unic-code vs reviewer unic-smart — models differ, contract satisfied. Legacy `runRenameStatements` consumer aiChatPanel.ts remains untouched (verified by grep; unchanged path). tableDdl:false denial retains the exact DBX-08 literal and shows zero side effects per tableCommands.test.ts.
