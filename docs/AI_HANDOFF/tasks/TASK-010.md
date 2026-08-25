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
