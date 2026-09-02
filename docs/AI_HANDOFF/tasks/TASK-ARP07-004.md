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

## Reviewer Verdict

<!-- Phase 4 reviewer appends below. -->
