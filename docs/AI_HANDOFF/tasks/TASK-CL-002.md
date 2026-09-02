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

### 2026-09-02 · planner · unic-smart
DI over a new global: `invalidateAfterSchemaDdl` is already a module-private closure — the cheapest correct move is to pass it down through the two EXISTING injection seams (`RegisterDeps`, `AiChatPanelOptions`), both of which extension.ts already constructs. The panel callback intentionally omits the dialect parameter: `DbAdapter` exposes no driver field and the panel only holds `AdapterFactory`, so the panel cannot know the dialect — extension's closure derives it from `mgr.getActive()?.driver` exactly as `runStatements` does at :1982. Per-statement firing (not per-batch) is deliberate: it correctly excludes the failed tail of a partial plan-apply, and `invalidate()` is idempotent. Reviewer: if you prefer once-per-batch for form DDL, the test shapes flip trivially, but per-statement is the more precise contract.
