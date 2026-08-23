# TASK-006 — PG integration tests (VSDB_IT=1) + docs

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §4,§5,§7

## Goal
Prove the DDL stack against live PostgreSQL (create → introspect round-trip → alter → verify), then document the feature set in CODE_MAP.md + README.md. Closing task of the cycle.

## Target Files
- `src/adapters/__tests__/ddl.integration.test.ts` (new) · `CODE_MAP.md` (modify) · `README.md` (modify)

## Spec
Integration file — pattern `postgres.integration.test.ts`: `const IT = process.env.VSDB_IT === "1"`; env VSDB_PG_HOST (127.0.0.1), VSDB_PG_PORT (5433), VSDB_PG_USER/PASS/DB (vsdb/vsdb/vsdb); `describe.skipIf(!IT)`; `PostgresAdapter` direct (no ConnectionManager). Each test owns a throwaway table (`vsdb_it_ddl_<seq>` unique suffix), DROPped in afterAll — independent, re-runnable. PG is orchestrator-managed at 127.0.0.1:5433; executor does NOT touch docker; connect failure → critical_block, never convert to unit tests.
Tests (one `it` each):
1. **create + introspect round-trip** — create referenced table first, then spec via `defaultColumnSpecs("vsdb_it_ddl_c")` + extra column + keys (pk id, unique, fk, check) → `generateCreateTable` → runQuery → both INTROSPECT SQLs → `rowsToSpec` → assert: column count/order; id default contains `uuid_in(overlay(`; created_at default contains `TO_CHAR(date_trunc('second', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')`; nullability round-trips; primaryKey/unique/foreignKey/check present with expected column membership.
2. **alter round-trip** — from (1)'s table: diffTable(before=introspected, after=edited: rename col via originalName, add column, drop unique key, SET NOT NULL another) → runQuery(statements.join("\n")) → re-introspect → renamed col present NEW name (old absent); added col present with type; unique key gone; nullable false.
3. **multi-statement single call** — 2-statement script (CREATE + ALTER) in ONE runQuery resolves (documents single-script assumption).
4. **regenerated CREATE executes** — `generateCreateTable(introspected spec)` runs cleanly on a fresh table name (guards Copy CREATE DDL).
5. **sample INSERTs executable** — `generateSampleInserts(spec, 5)` → runQuery → `SELECT count(*)` returns 5.
6. **duplicate create rejects** — same name twice → rejects, message contains "already exists" (documents TASK-004 error path).
**Docs** — CODE_MAP.md: one-line entries (match existing style — read it first) for the 7 new files: `src/core/ddl/{createTable,alterTable,pgIntrospect,sampleData}.ts`, `src/ui/{newTableForm,newTableFormMessages}.ts`, `webview/newTableFormMain.ts`. README.md: "Table Designer (PostgreSQL)" subsection under features — New Table…, Modify Table…, Copy CREATE DDL, Generate Sample Data…, Analyze/Vacuum + PostgreSQL-only note. English; minimal, consistent tone.

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected | Pre-state |
|---|------|----------|----------|-----------|
| 1 | integration | create + introspect round-trip | defaults fragments verbatim, nullability, 4 key kinds (Spec 1) | fresh tables |
| 2 | integration | alter round-trip | rename/add/drop-key/NOT NULL verified by re-introspection | table from (1) |
| 3 | integration | multi-statement single runQuery | 2-stmt script resolves, no error | scratch table |
| 4 | integration | regenerated CREATE executes | clean execute on fresh name | introspected spec |
| 5 | integration | sample INSERTs count | count(*) === 5 | 3-col spec |
| 6 | edge (failure) | duplicate create rejects | rejects with "already exists" | same name twice |
(Happy #1/#2 + different-kind edges: failure #6, boundary/multi-statement #3. All gated by VSDB_IT=1; file skips otherwise.)

## Test Files
- `src/adapters/__tests__/ddl.integration.test.ts`

## Verification Commands
```bash
npm run compile && VSDB_IT=1 VSDB_PG_HOST=127.0.0.1 VSDB_PG_PORT=5433 npx vitest run -c vitest.integration.config.ts src/adapters/__tests__/ddl.integration.test.ts && npx vitest run src/__tests__/releaseHygiene.test.ts && npx tsc --noEmit
```
(`vitest.integration.config.ts` verified to include `src/adapters/__tests__/*.integration.test.ts`; releaseHygiene guards docs/dist additions. No lint script.)

## Acceptance Criteria
- [ ] Integration PASS with VSDB_IT=1 vs 127.0.0.1:5433 (paste fresh output).
- [ ] 6 tests independent (own tables, cleaned in afterAll).
- [ ] CODE_MAP rows for 7 new files; README subsection added.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001, TASK-002, TASK-003 (generators + introspection) · TASK-005 (sampleData)

## Interfaces
- Consumes: TASK-001/002/003/005 exports (imports only).
- Produces: (none) — verification + docs.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Executor: never start/stop docker; connect failure = critical_block with the raw error.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
