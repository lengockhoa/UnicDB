# TASK-UX1-011 — Auto-refresh schema tree after any query (R13)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 4), §3 (UX1-011)

## Goal

After any successful run, the left-pane schema tree must reflect the new state ("thêm
bảng, thêm view, hay update lại bảng … phải reload lại menu bên trái"). Extend the
existing post-run seam: DDL → full refresh (exact `vsdb.refreshSchema` semantics), DML →
cheap tree-only refresh, SELECT-only → no-op, with a 200ms trailing debounce that
coalesces back-to-back runs and is cleared on deactivate.

## Target Files

- `src/core/schemaImpact.ts` — new PURE export `shouldRefreshAfter(completed: readonly
  string[], dialect?: SqlDialect): "full" | "tree" | "none"` (next to
  `completedSchemaImpact`, :129). DDL list (CREATE/ALTER/DROP ... TABLE/VIEW/INDEX/
  FUNCTION/SCHEMA/TYPE, COMMENT ON, etc. — reuse/extend the existing DDL keyword set) →
  `"full"`; no DDL but ≥1 DML (INSERT/UPDATE/DELETE/TRUNCATE/MERGE) → `"tree"`; else
  `"none"`.
- `src/extension.ts` — replace `invalidateAfterSchemaDdl`'s body (:881) to dispatch on
  `shouldRefreshAfter`: `"full"` → `schemaCache.invalidate() + acSchemaCache.invalidate()
  + sqlSemanticTokens.refresh() + tree.refresh()` (identical to the `vsdb.refreshSchema`
  command body, :673 — do NOT re-execute the command, avoid double-invalidate);
  `"tree"` → `tree.refresh()` only; `"none"` → no-op — all behind a shared 200ms trailing
  debounce (module-level timer; flush + clear in `deactivate()`, :1299 region).
  Do NOT touch the `vsdb.refreshSchema` command registration itself.
- `src/core/__tests__/schemaImpact.test.ts` — pure classifier tests.
- `src/extension.test.ts` — debounce + wiring tests in this task's describe block.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | CREATE TABLE run triggers full refresh exactly once | run with `["CREATE TABLE t(...)"]` completing → schemaCache + acSchemaCache invalidated, sqlSemanticTokens refreshed, tree.refresh called once | activate with stubbed manager/runner; feed runStatements-equivalent `completed` array through the seam |
| 2 | happy | DML-only run refreshes the tree only | `["INSERT INTO t ..."]` → tree.refresh called; schemaCache/acSchemaCache/sqlSemanticTokens untouched | same harness |
| 3 | edge A — SELECT-only no-op | `["SELECT 1"]` → zero refresh calls of any kind | classifier `"none"`; no tree churn | same harness |
| 4 | edge A — empty completed list | run where every statement failed → `[]` | `"none"`; no refresh (failures must not churn the tree) | pure call with `[]` |
| 5 | edge B — boundary classification | mixed truth table | `["COMMENT ON TABLE t IS 'x'"]` → full; `["TRUNCATE t"]` → tree; `["EXPLAIN SELECT 1"]` → none; `["/* c */ CREATE VIEW v ..."]` → full | pure `shouldRefreshAfter` calls |
| 6 | edge B — failure does not refresh | statement `status: "error"` excluded from `completed` | runStatements already filters `status === "done"` (:2283) — regression test asserts a failed CREATE TABLE triggers nothing | harness with a failed first statement |
| 7 | edge C — debounce coalesces | 3 runs within 200ms → exactly 1 refresh | fire the seam 3× rapidly with DDL → after 250ms, exactly one full-refresh invocation (vi.useFakeTimers) | fake timers |
| 8 | edge C — deactivate clears timer | deactivate with pending debounce → no refresh afterwards | fire seam, call deactivate, advance timers → zero refresh calls; no throw | fake timers + deactivate |
| 9 | regression | existing DDL invalidation tests keep passing | TASK-CL-002's invalidation suite stays green (full-refresh semantics superset of old behaviour) | existing suite |

## Test Files

- `src/core/__tests__/schemaImpact.test.ts` — cases 3, 4, 5 (pure).
- `src/extension.test.ts` — cases 1, 2, 6, 7, 8, 9 (wiring + debounce).

## Verification Commands

```bash
npx vitest run src/core/__tests__/schemaImpact.test.ts src/extension.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Cases 1–9 pass; case 7 proves the debounce (not 3 refreshes for 3 runs).
- [ ] Full-refresh semantics byte-match the `vsdb.refreshSchema` command body (case 1
      asserts all four invalidation calls, no more).
- [ ] User asked for refresh "sau khi chạy bất cứ câu query gì" — the SELECT no-op (case
      3) is a deliberate perf choice recorded here; reviewer may veto toward
      always-refresh but the classifier makes that a one-word change.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-002, TASK-UX1-007 (extension.ts + extension.test.ts exclusivity: this task is
  the LAST writer on the extension.ts lane, ordered `UX1-002 → UX1-007 → UX1-011`. The
  second edge on UX1-007 is mandatory — with only the UX1-002 edge, a DAG runner could
  schedule UX1-007 and this task concurrently on the same files and lose describe blocks;
  P2.5 round 1 flagged exactly that gap, now closed.)

## Interfaces

- Consumes: `invalidateAfterSchemaDdl` closure (extension.ts:121,881 — the only post-run
  refresh seam); `completedSchemaImpact` DDL keyword set (schemaImpact.ts:129) to extend;
  `completed` array already filtered to `status === "done"` (extension.ts:2283);
  `deactivate()` (extension.ts:1299 region).
- Produces: `shouldRefreshAfter(completed, dialect?): "full" | "tree" | "none"` pure
  export — UX1-010's `StatementResult.kind` may later refactor the call site to pass
  kinds directly, but this task's classifier is text-based so the two tasks stay
  independent.

---

## Discussion

### 2026-09-04 · planner · unic-smart
The infrastructure partially exists: TASK-CL-002's `invalidateAfterSchemaDdl` already
classifies DDL and refreshes; the gaps are (1) DML-only runs never refresh the tree and
(2) `sqlSemanticTokens` invalidation only happens on manual refresh, not post-DDL. This
task closes both inside the existing seam instead of adding a parallel refresh path, and
adds the debounce the multi-statement case needs. "tree" for DML: `ALTER TABLE ... UPDATE`
wording aside, plain DML doesn't change structure — but the user explicitly asked for a
reload after updates ("hay update lại bảng"), and `tree.refresh()` is cheap (cache-backed),
so DML gets tree-only refresh rather than full invalidation. Case 3 documents the one
deliberate deviation from the user's literal "bất cứ câu query gì" for read-only SELECTs.
