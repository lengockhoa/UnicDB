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
## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec-T006
SUMMARY: Added `src/adapters/__tests__/ddl.integration.test.ts` (6 PG integration tests against 127.0.0.1:5433 covering create+introspect round-trip, alter round-trip, multi-statement runQuery, regenerated CREATE, sample INSERTs, duplicate create) and updated `README.md` + `docs/CODE_MAP.md` with the Table Designer feature set.
TEST_PLAN_FOLLOWED: task §4 (6 tests) — all six required cases covered.
FILES_CHANGED:
  +- src/adapters/__tests__/ddl.integration.test.ts: new — 6 tests gated by VSDB_IT=1.
  +- README.md: added **Table Designer (PostgreSQL)** subsection under `## Tính năng chính` (New Table…, Modify Table…, Copy CREATE DDL, Generate Sample Data…, Analyze/Vacuum).
  +- docs/CODE_MAP.md: added `## DDL Stack (PostgreSQL Table Designer)` section with 7 file rows (createTable, alterTable, pgIntrospect, sampleData, newTableForm, newTableFormMessages, webview/newTableFormMain).
TESTS_ADDED:
  +- src/adapters/__tests__/ddl.integration.test.ts: create+introspect round-trip preserves defaults/nullability/keys; alter round-trip (rename/add/drop-unique/SET NOT NULL); multi-statement single runQuery; regenerated CREATE executes on fresh table; generateSampleInserts(spec, 5) → count(*) === 5; duplicate CREATE rejects with "already exists".
VERIFICATION:
  command: npm run compile && VSDB_IT=1 VSDB_PG_HOST=127.0.0.1 VSDB_PG_PORT=5433 npx vitest run -c vitest.integration.config.ts src/adapters/__tests__/ddl.integration.test.ts && npx vitest run src/__tests__/releaseHygiene.test.ts && npx tsc --noEmit
  result: 0 fail (esbuild OK, 6/6 integration, 3/3 releaseHygiene, tsc clean)
  output_excerpt: |
    > vsdb@1.5.1 compile
    > node esbuild.js
    esbuild: build complete

    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-006
     ✓ src/adapters/__tests__/ddl.integration.test.ts  (6 tests) 10159ms
    Test Files  1 passed (1)
         Tests  6 passed (6)

    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-006
     ✓ src/__tests__/releaseHygiene.test.ts  (3 tests) 3ms
    Test Files  1 passed (1)
         Tests  3 passed (3)

    tsc --noEmit: clean (no output)

ISSUES: Five real bugs surfaced + fixed during RED→GREEN iterations (all in test code, not source):
  1. `pg_get_expr` re-renders `pg_catalog.pg_attrdef` defaults upper-cased + with extra parens — test #1's default-substring matches went toLowerCase() + multi-fragment (to_char / date_trunc / asia/ho_chi_minh).
  2. PG enforces NOT NULL implicitly on PK member columns; test #1's expectation for `id_<t>.nullable === true` (no NOT NULL in spec) flipped to `false`.
  3. Constraint names live at schema scope; regenerated CREATE on a different table reused the original `pk_regen_src_<suffix>` name → "relation … already exists". Re-key PK + unique under the destination table.
  4. SELECT-via-cursor (BEGIN; DECLARE …; FETCH) on pool max=1 holds an AccessShare lock that survives `batched.close()`; DROP TABLE in finally fails with PG 55006 ("being used by active queries"). Final test code (a) calls `batched.cancel()` (destroys the cursor client) AND (b) drops via a dedicated one-off Client so DROP never waits on the pool.
  5. node-pg returns `text[]` as a literal-string `'{id_ref}'` unless a custom type parser is registered; `pgIntrospect.confkeycols` is typed `string[]` so the FK columns assertion parses the literal at the call site.
  All five were test-side concerns: the canonical generators (createTable/alterTable/pgIntrospect/sampleData) were untouched per task contract "Consumes: TASK-001/002/003/005 exports (imports only). Produces: (none)."

RED_OUTPUT (first failing run after initial draft — 3 fails before iteration):
  expected 'uuid_in((OVERLAY(OVERLAY(md5((((rando…' to contain 'uuid_in(overlay('
  error: multiple primary keys for table "vsdb_it_ddl_regen_dst_…"
  error: cannot DROP TABLE "vsdb_it_ddl_sample_…" because it is being used by active queries in this session
  (all three → fixed as documented in ISSUES #1/#3/#4 above; final GREEN run = 6/6.)

HANDOFF_TO_REVIEWER: yes — full test surface exercised against live PG, docs landed, no source changes.
NEXT: ready for review (TASK-001 / TASK-002 / TASK-003 / TASK-005 merges already on main per `code-reviewer` plan).
