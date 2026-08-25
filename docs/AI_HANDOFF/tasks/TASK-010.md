# TASK-010 — Schema tree: one row-count query per schema, no connection opened at activation

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.9 (D2, D3) — §7 Global Constraints applies by reference

## Goal

- **D2** — expanding a tables node fires one `estimateTableRows` per table
  (`src/ui/schemaTree.ts:486-494`). With the Postgres pool at `max: 1` (`postgres.ts:83`) a
  300-table schema means 300 **serialized** queries; MySQL is worse because its per-table
  `information_schema.TABLES` form forces statistics collection. Switch to TASK-005's
  `estimateTableRowsBatch` — one grouped query per schema — while keeping the existing
  fire-and-forget / cache / in-flight-dedup behavior.
- **D3** — every connection node is created `Expanded` (`schemaTree.ts:214`), so on activation
  VS Code expands each saved connection, opening a socket and running `listSchemas` against
  **every** configured database, including ones the user never touches. Create them `Collapsed`.

## Target Files

- `src/ui/schemaTree.ts`
- `src/ui/__tests__/schemaTree.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | expand a 3-table schema | `estimateTableRowsBatch` called **once** with `("public", ["a","b","c"])`; each node description updated |
| Happy | collapsed connections | connection nodes report `TreeItemCollapsibleState.Collapsed`; expanding one still lists schemas |
| Edge (empty) | schema with 0 tables | no estimate query issued at all |
| Edge (cache) | expand, collapse, re-expand within TTL | zero additional estimate queries |
| Edge (partial failure) | batch omits one table (dropped mid-flight) | present tables get counts; the missing one renders without a count and no error is surfaced |
| Edge (rejection) | `estimateTableRowsBatch` rejects | tree still renders every table node; failure is swallowed as today (fire-and-forget) |
| R (D2) | 300-table schema | today 300 queries; after fix 1 (assert call count on a spy adapter) |
| R (D3) | activation with 3 saved connections | today 3 × `listSchemas`; after fix **0** |

## Test Files

- `src/ui/__tests__/schemaTree.test.ts` (extend — spy adapter counting `estimateTableRowsBatch`
  and `listSchemas` calls; assert `collapsibleState`)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ui/__tests__/schemaTree.test.ts
npm test -- src/ui/__tests__/tableCommands.test.ts
npm test -- src/core/__tests__/connectionManager.test.ts
```

## Acceptance Criteria

- [ ] All 8 cases pass; both regression cases confirmed failing on `main` first (call-count
      assertions, output in the report).
- [ ] `schemaTree.ts` contains no per-table `estimateTableRows` loop; the single-table method may
      still exist on the adapter but is not called from the expand path.
- [ ] Row-count fetching stays non-blocking (tree renders before counts arrive) and keeps its
      existing cache TTL + in-flight dedup.
- [ ] Connection nodes are `Collapsed`; the click-to-activate `command` on the node is unchanged
      (switching the active connection must still work from a collapsed node).
- [ ] No behavior change to filtering (`matchesFilter`) or the "No matches" node.
- [ ] `npm run typecheck` clean; no file outside Target Files touched.

## Dependencies

- TASK-005 (`DbAdapter.estimateTableRowsBatch` must exist to compile)

## Interfaces

- Consumes:

```ts
// TASK-005 — src/adapters/types.ts
estimateTableRowsBatch(
  schema: string,
  tables: readonly string[],
): Promise<Map<string, number | null>>;   // dropped/missing tables are OMITTED from the map
```

- Produces: `(none)` — UI behavior only.

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

D3 is a two-line change with a large blast radius: users with several saved connections currently
pay a connection attempt (and any password prompt / TLS handshake / timeout) for every database at
activation. Verify manually that a collapsed connection still switches the active connection on
click — `schemaTree.ts:216-219` attaches `vsdb.selectConnectionFromTree` to the node itself, so it
should be unaffected, but a regression there would be user-visible immediately.

If `estimateTableRowsBatch` turns out to be slow for a very large schema, keep it non-blocking
rather than reintroducing per-table calls — one slow query is still strictly better than N
serialized ones on a `max: 1` pool.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-5
EXECUTOR_SUBAGENT: -

### RED_OUTPUT (actual failing output, captured before implementation)

```
❯ src/ui/__tests__/schemaTree.test.ts  (61 tests | 7 failed) 32ms
  ❯ SchemaTreeProvider — DataGrip-style root behavior > connection node collapsible=Collapsed (TASK-010/D3 — không mở socket ở activation)
    → expected 2 to be 1 // Object.is equality
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > expand a 3-table schema → estimateTableRowsBatch called ONCE with (schema, tables); descriptions updated (happy)
    → expected "spy" to be called 1 times, but got 0 times
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > connection nodes Collapsed; expanding one still lists schemas normally (happy, D3)
    → expected 2 to be 1 // Object.is equality
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > expand, collapse, re-expand within TTL → zero additional estimateTableRowsBatch calls (edge, cache)
    → expected "spy" to be called 1 times, but got 0 times
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > batch omits one table (dropped mid-flight) → present tables get counts, missing renders without count, no error node (edge, partial failure)
    → expected 'public' to be '99' // Object.is equality
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > 300-table schema → estimateTableRowsBatch called exactly ONCE (regression D2 — today 300 calls)
    → expected "spy" to be called 1 times, but got 0 times
  ❯ SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections > activation with 3 saved connections → 0 listSchemas calls (regression D3 — today 3× listSchemas)
    → expected "spy" to not be called at all, but actually been called 1 times

 Test Files  1 failed (1)
      Tests  7 failed | 54 passed (61)
```

Notes on the 2 cases that did NOT fail in isolation pre-fix (both are edge cases whose *assertions* were
already true on `main`, since baseline swallows adapter errors and never fetches for empty lists — RED
was confirmed for both regression cases (D2/D3, the two mandated ones) and for the happy-path call-count
assertions, which is where the actual defect lives):
- "schema with 0 tables → no estimateTableRowsBatch call" — trivially true pre-fix too (baseline's loop
  over an empty `children` array never runs, so `estimateTableRows`/`estimateTableRowsBatch` were never
  called either way). Kept as a regression guard for the new code path.
- "estimateTableRowsBatch rejects → tree still renders every table node" — trivially true pre-fix too
  (baseline's fire-and-forget `.catch()` already swallowed adapter failures for `estimateTableRows`).
  Kept as a regression guard for the new batch code path since the failure-swallowing logic was rewritten.

### Implementation

- `src/ui/schemaTree.ts`:
  - `getRoot()` connection nodes: `TreeItemCollapsibleState.Expanded` → `Collapsed` (D3). Click-to-activate
    `command` unchanged.
  - `getParent()`'s synthesized connection-node literal (used for `TreeView.reveal`) updated to `Collapsed`
    too, for consistency (not directly asserted by a test, but avoids a stale literal).
  - `getCategoryChildren()`: replaced the per-table `for` loop calling `fetchRowCount(tNode, ...)` (one
    `adapter.estimateTableRows` call per table) with a single guarded call to a new
    `fetchRowCountsBatch(tableNodes, conn, schema)` — guard `tableNodes.length > 0` before calling (empty
    schema issues zero queries, per-adapter-level TASK-005 guard is now backed by a UI-level guard too).
  - Replaced private method `fetchRowCount` (singular, per-table) with `fetchRowCountsBatch` (plural):
    - Splits `tableNodes` into already-cached (`rowCountCache`, TTL 60s, per `connId|schema|table` key —
      unchanged cache shape) vs pending; cached entries get their description set synchronously with no
      network call.
    - If nothing is pending (all cache hits) → returns without calling the adapter at all (0 additional
      queries on re-expand within TTL).
    - In-flight dedup via a new per-`(connId, schema)` key in the existing `rowCountFetching` Set (was
      per-table before; now per-schema since the call itself is per-schema).
    - Calls `adapter.estimateTableRowsBatch(schema, pendingNames)` once; `Map` entries `undefined`
      (omitted/dropped mid-flight) or `null` leave the table's description at its schema fallback,
      unchanged; only entries with a real count populate `rowCountCache` and update `tNode.description`.
    - Rejection → `.catch()` clears the in-flight flag and swallows the error (fire-and-forget, unchanged
      contract).
    - `schemaTree.ts` no longer calls `adapter.estimateTableRows` anywhere; the single-table method still
      exists on `DbAdapter` (unchanged, per TASK-005) but is not referenced from the expand path.

- `src/ui/__tests__/schemaTree.test.ts` (own file, extended):
  - `makeFakeAdapter()`: added `estimateTableRowsBatchImpl` option + `estimateTableRowsBatch` mock
    (mirrors real adapter contract — defaults to resolving an empty `Map`).
  - Updated pre-existing "connection node collapsible=Expanded" test → renamed/updated to assert
    `Collapsed` (this test directly encoded the D3 defect and had to change with the fix).
  - Updated pre-existing TASK-302 row-count-badge test (`getCategoryChildren tables → ... description =
    '176'`) from `estimateTableRowsImpl` (per-table) to `estimateTableRowsBatchImpl` (batch), asserting
    `estimateTableRowsBatch` called once with `("app", ["users","orders"])` instead of the old per-table
    `estimateTableRows` assertion — this test's original assertion (`estimateTableRows` called) is no
    longer true post-fix by design (TASK-010 acceptance criteria: no per-table loop from the expand path).
  - Added new describe block `SchemaTreeProvider — TASK-010 D2 batch row-count + D3 collapsed connections`
    with the 8 cases from §Test Cases (happy×2, edge×4, regression×2).

### Verification Output

```
$ npm run typecheck
> vsdb@1.6.3 typecheck
> tsc --noEmit
(clean, no output)

$ npm test -- src/ui/__tests__/schemaTree.test.ts
 ✓ src/ui/__tests__/schemaTree.test.ts  (61 tests) 26ms
 Test Files  1 passed (1)
      Tests  61 passed (61)

$ npm test -- src/ui/__tests__/tableCommands.test.ts
 ✓ src/ui/__tests__/tableCommands.test.ts  (35 tests) 11ms
 Test Files  1 passed (1)
      Tests  35 passed (35)

$ npm test -- src/core/__tests__/connectionManager.test.ts
 ✓ src/core/__tests__/connectionManager.test.ts  (9 tests) 4ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

Full suite (after `npm run compile`, per worktree instructions):

```
$ npm test
 Test Files  84 passed | 1 skipped (85)
      Tests  1166 passed | 2 skipped (1168)
```

Baseline (wave 1, commit `0c2b2eb`): 1158 passed, 2 skipped, 84 files. New total: 1166 passed (+8, exactly
the 8 new TASK-010 test cases), 2 skipped (unchanged), 84 test files with tests passed + 1 skipped file
(unchanged file count). No regressions.

### Status

DONE

### Note

- Did not touch `src/extension.ts` or any file outside `src/ui/schemaTree.ts` /
  `src/ui/__tests__/schemaTree.test.ts`, per SCOPE. No activation-wiring change was needed for this task —
  D3 is purely a `collapsibleState` change on the tree node, not an activation-time eager-connect call, so
  there was nothing to flag for `extension.ts`.
- 2 of the 8 §Test Cases rows were not individually RED pre-fix (see RED_OUTPUT notes above) because their
  assertions were already true under the old per-table implementation; both mandated regression rows
  (D2 300-table call count, D3 activation call count) and both call-count-asserting happy-path rows WERE
  confirmed RED. All 8 are now GREEN post-fix and guard the new code path going forward.
- `dist/` was absent in the fresh worktree; ran `npm run compile` once before `npm test` per worktree
  instructions, otherwise 2 unrelated bundle tests fail with ENOENT (as warned).
