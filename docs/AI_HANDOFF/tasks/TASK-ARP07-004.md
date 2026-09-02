# TASK-ARP07-004 — Execution wiring: successful-DDL invalidation via host seam

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1, §2, §4, §5, §6

## Goal

Wire successful-DDL invalidation into the shared `runStatements` path: only statements that actually
completed (`status === "done"`) are fed to the ARP-07.1 classifier; if any has schema impact, a host seam
invalidates SchemaCache + AI schema cache and refreshes the tree in one place. Failed/cancelled/
rejected-confirmation runs and post-teardown (`deactivating`) continuations never invalidate — composing
with the ARP-02 ownsRun/deactivate sentinel.

## Target Files

- `src/extension.ts` — add a module-level seam `let invalidateAfterSchemaDdl: ((completed: readonly string[], dialect?: SqlDialect) => void) | null = null;` (near the other module-scope singletons, `extension.ts:93-103`); assign it in `activate` after `schemaCache`/`acSchemaCache` are constructed (`extension.ts:317,696`), closing over both plus `state?.tree`; call it from the `runStatements` success path inside the existing `if (!deactivating) { panel.render(...) }` block (`extension.ts:1754-1756`).
- `src/extension.test.ts` — wiring tests below (mock `./ui/schemaCache` and `./ai/schemaContextCache`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | successful `CREATE TABLE t (id int)` through the shared run path | `schemaCache.invalidate`, `acSchemaCache.invalidate`, `tree.refresh` each called exactly once | mock `./ui/schemaCache` (`SchemaCache` with `invalidate: vi.fn()`) and `./ai/schemaContextCache` (`createSchemaContextCache: vi.fn(() => ({ resolve: vi.fn(async () => emptyCtx), invalidate: vi.fn() }))`); activate fresh; drive the run (see Discussion) |
| 2 | happy | mixed batch `SELECT 1; CREATE TABLE t(id int)` (both `done`) | seam fires (the completed CREATE changed schema) | as #1, multi-statement input |
| 3 | edge (failed DDL) | the CREATE statement itself errors (adapter.runQuery throws) → runner marks it `error`, remainder `cancelled` | seam NOT called | adapter mock throws on the CREATE; assert no invalidate call |
| 4 | edge (rejected confirmation) | `confirmDangerousStatements` resolves false | early return before `runner.run` — seam NOT called | mock `./ui/confirmDangerous` `confirmDangerousStatements → false` |
| 5 | edge (cancelled run) | cancelled before any statement completes → no invalidation | seam NOT called | runner results all `cancelled` |
| 6 | edge (deactivating) | `deactivating === true` at success time | seam NOT called — no post-teardown write (ARP-02) | set the teardown sentinel before the run settles |
| 7 | edge (DML-only) | successful `INSERT` / `UPDATE` / `TRUNCATE` | seam NOT called (classifier false) | adapter mock succeeds; assert no invalidate |
| 8 | happy (non-DDL) | successful `SELECT` run | caches untouched (invalidate NOT called) | as #1 with SELECT input |
| 9 | edge (seam payload) | a `done` StatementResult must carry the original statement text on `StatementResult.sql` (`queryRunner.ts:49-52`) → the seam receives that exact text, never undefined | captured `completed[0] === "CREATE TABLE t (id int)"` | mocked result record uses the REAL field names `.status` / `.sql`, not a stand-in |

## Test Files

- `src/extension.test.ts` — new describe block following the existing pattern (full `vi.mock("vscode")`, `activateFresh` with `vi.resetModules()`, dynamic import; see the harness at `src/extension.test.ts:7-70, 597-789`).

## Verification Commands

```bash
npm test src/extension.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] Seam fires ONLY for completed (`status === "done"`) schema-impacting statements; failed/cancelled/rejected-confirmation/deactivating never fire.
- [ ] `runStatements` signature UNCHANGED (the seam is a module-level callback, not a parameter) — the three existing callers (`extension.ts:1597,1656,1670`) are untouched.
- [ ] ARP-02 behavior preserved: `ownsRun` snapshot, `finally` busy gate, and the `!deactivating` gate are byte-identical in behavior; the seam call is inside the existing `!deactivating` block.
- [ ] No change to `runDdl` (`tableCommands.ts`), plan-apply (`aiChatPanel.ts`), schemaCache, schemaContextCache, or AI policy — those surfaces are out of scope this cycle (PLAN.md §2 / Known gaps).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP07-001 (imports `completedSchemaImpact`)
- TASK-ARP07-002 (proves `SchemaCache.invalidate()` is race-safe for the DDL scenario)
- TASK-ARP07-003 (proves `acSchemaCache.invalidate()` reliably forces a fresh hydrate)

## Interfaces

- Consumes:
  - `completedSchemaImpact(completed: readonly string[], dialect?: SqlDialect): boolean` from `src/core/schemaImpact` (produced by TASK-ARP07-001).
  - `SchemaCache.invalidate(): void` (existing, `schemaCache.ts:288`).
  - `SchemaContextCache.invalidate(): void` (existing, `schemaContextCache.ts:217-219`).
  - `state?.tree.refresh()` — `SchemaTreeProvider.refresh()` (already used at `extension.ts:1863`).
  - `SqlDialect` from `src/core/statementParser` (`"postgres" | "mysql" | "mssql"`).
- Produces: module-level seam
  `invalidateAfterSchemaDdl(completed: readonly string[], dialect?: SqlDialect): void`
  (assigned in `activate`; called by `runStatements`). No exported public API change.

---

## Discussion

- Suggested seam shape (executor may refine, but keep the contract): in `activate` after the two caches exist,
  `invalidateAfterSchemaDdl = (completed, dialect) => { if (completedSchemaImpact(completed, dialect)) { schemaCache.invalidate(); acSchemaCache.invalidate(); state?.tree.refresh(); } };`
  In `runStatements`, inside the existing `if (!deactivating)` block after `panel.render(results, header, { appendBase })`:
  `invalidateAfterSchemaDdl?.(results.filter((r) => r.status === "done").map((r) => r.sql), active?.driver);`
  `runner.run()` resolves to `StatementResult[]` — the exported `StatementResult` interface (`queryRunner.ts:49-52`): `status: StatementStatus` (line 52) and the original statement text on `sql: string` (line 51). Pin these two field names in the mocked result records (test #9); the seam receives the real SQL, never undefined.
- Test-drive approach: drive the shared run path via the editor `vsdb.runQuery` command (open a mock SQL editor document) or the console run callback, with `QueryRunner` mocked/real-but-adapter-mocked. The essential assertions are on the two `invalidate` spies and the tree refresh; prefer the lightest harness that reaches `runStatements`' success path.
- `active?.driver` is captured at the top of `runStatements` (`extension.ts:1711`) — reuse it for the classifier dialect.

---

## Executor Report

<!-- Phase 3 executor appends below. -->

### RED (TDD step 1) — actual failing output

Command: `npx vitest run src/extension.test.ts -t "TASK-ARP07-004"`

```
 FAIL  src/extension.test.ts > TASK-ARP07-004 — successful-DDL cache invalidation seam > #1 happy: successful CREATE TABLE through shared run path → seam fires (invalidate ×2, tree.refresh)
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/extension.test.ts:3380:28
    3378|     await driveRunStatement(ext, "CREATE TABLE t (id int)");
    3380|     expect(schemaCacheSpy).toHaveBeenCalledTimes(1);

 FAIL  src/extension.test.ts > TASK-ARP07-004 — successful-DDL cache invalidation seam > #2 happy: mixed batch (SELECT done + CREATE done) — seam fires on the CREATE
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/extension.test.ts:3393:28
    3391|     await driveRunStatement(ext, "SELECT 1; CREATE TABLE t (id int);");
    3393|     expect(schemaCacheSpy).toHaveBeenCalledTimes(1);

 FAIL  src/extension.test.ts > TASK-ARP07-004 — successful-DDL cache invalidation seam > #9 edge: seam payload — completed list receives the REAL statement text from StatementResult.sql (never undefined)
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ src/extension.test.ts:3519:28
    3517|     await driveRunStatement(ext, originalSql);
    3519|     expect(schemaCacheSpy).toHaveBeenCalledTimes(1);

 Test Files  1 failed (1)
      Tests  3 failed | 6 passed | 88 skipped (97)
```

RED analysis: the 3 happy-path tests (#1, #2, #9) fail because the seam does
not exist yet — `runStatements` never invalidates the caches. The 6
negative-path tests (#3-#8) are GREEN-on-base by design (asserting the seam
does NOT fire; there is nothing to fire before implementation). Test #9
additionally pins the `.status` / `.sql` field names from `queryRunner.ts:49-52`
in its mocked `StatementResult` records.

### Implementation (GREEN)

`src/extension.ts`:
1. Import `completedSchemaImpact` from `./core/schemaImpact` (wave-1 API).
2. Module-level seam `invalidateAfterSchemaDdl: ((completed: readonly string[], dialect?: SqlDialect) => void) | null = null` next to the other singletons.
3. Assigned in `activate()` right after the `acSchemaCache` `onDidChangeActive` block: guards on `completedSchemaImpact(completed, dialect)`, then `schemaCache.invalidate()` + `acSchemaCache.invalidate()` + `state?.tree.refresh()` (lazy `state?.` read so a deactivate between run-start and seam-fire cannot resurrect the tree).
4. Called from `runStatements` INSIDE the existing `if (!deactivating) { panel.render(...) }` success block, feeding only `results.filter(r => r.status === "done").map(r => r.sql)` with `active?.driver` (captured at the top of `runStatements`). `runStatements` signature UNCHANGED — all three callers untouched. ARP-02 `ownsRun` snapshot / finally busy gate / `!deactivating` gate byte-identical in behavior.
5. `deactivate()` nulls the seam alongside the caches it closes over.

Tests: new describe block `TASK-ARP07-004 — successful-DDL cache invalidation seam` in `src/extension.test.ts` (9 tests, one per §Test Cases row). Harness: `vi.resetModules()` + `vi.doMock("./ui/schemaCache")` / `vi.doMock("./ai/schemaContextCache")` scoped to the block, dynamic re-import; `QueryRunner.prototype.run` mocked to return controlled `StatementResult[]` records built with the REAL field names `.status` / `.sql` (queryRunner.ts:49-52); `SchemaTreeProvider.prototype.refresh` spied; driven through the real `vsdb.runStatement` command so `confirmDangerousStatements`, `runStatements`, and the seam all execute for real.

### Verification Output (GREEN)

Command: `npm test src/extension.test.ts` (worktree)

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-arp07-004

 ✓ src/extension.test.ts  (97 tests) 719ms

 Test Files  1 passed (1)
      Tests  97 passed (97)
   Start at  09:00:18
   Duration  1.48s
```

Command: `npm run typecheck` (worktree)

```
> vsdb@1.42.0 typecheck
> tsc --noEmit
EXIT=0
```

Full suite cross-check: `npm test` → `Test Files 218 passed | 1 skipped (219)`, `Tests 3120 passed | 2 skipped (3122)`. No regressions.

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: Claude:feature-implementer
- RED_OUTPUT: see "RED (TDD step 1)" section above — 3 failed (#1, #2, #9: `expected "spy" to be called 1 times, but got 0 times`), 6 passed (negative paths GREEN-on-base by design), full command `npx vitest run src/extension.test.ts -t "TASK-ARP07-004"`.
- Verification Output: see "Verification Output (GREEN)" section above — `npm test src/extension.test.ts` 97/97 pass; `npm run typecheck` exit 0; full `npm test` 3120 passed / 2 skipped.
- Status: PASS
- Note: none.

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->
