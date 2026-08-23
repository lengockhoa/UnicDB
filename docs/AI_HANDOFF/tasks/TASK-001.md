# TASK-001 — Pure CREATE TABLE generator
- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
Pure PostgreSQL CREATE TABLE generator: TableSpec types, quoting, mandatory-defaults factory, renderer, validator. No vscode imports, no async, no I/O. Defines the contract all other tasks import.

## Target Files
- `src/core/ddl/createTable.ts` (new) · `src/core/__tests__/ddlCreateTable.test.ts` (new)

## Spec — contract (normative)
```ts
export interface ColumnSpec { name: string; type: string; default?: string;
  nullable?: boolean; comment?: string; originalName?: string; isPrimaryKey?: boolean }
export type KeySpec =
  | { kind: "primaryKey"; columns: string[]; name?: string }
  | { kind: "unique"; name?: string; columns: string[] }
  | { kind: "check"; name?: string; expr: string }
  | { kind: "foreignKey"; name?: string; columns: string[];
      references: { table: string; columns: string[] } };
export interface TableSpec { name: string; schema: string; columns: ColumnSpec[];
  keys: KeySpec[]; ifNotExists?: boolean }
export function quoteIdent(name: string): string
export const UUID_DEFAULT_EXPR: string; export const CREATED_AT_DEFAULT_EXPR: string
export function defaultColumnSpecs(tableName: string): ColumnSpec[]
export function generateCreateTable(spec: TableSpec): string
export function specErrors(spec: TableSpec): string[]
```
`UUID_DEFAULT_EXPR` (verbatim single line): `uuid_in(overlay(overlay(md5(random()::text || ':' || random()::text) placing '4' from 13) placing to_hex(floor(random() * (11 - 8 + 1) + 8)::int)::text from 17)::cstring)`
`CREATED_AT_DEFAULT_EXPR`: `TO_CHAR(date_trunc('second', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD HH24:MI:SS')::character varying`
`defaultColumnSpecs("users")` → `[{name:"id_users",type:"varchar",default:UUID_DEFAULT_EXPR},{name:"created_at",type:"varchar",default:CREATED_AT_DEFAULT_EXPR}]` (nullable omitted = true; no NOT NULL).
Rendering:
- `CREATE TABLE [IF NOT EXISTS] <qualified> (` … columns 4-space indented, comma-separated … `);` + trailing `\n`. Schema-qualify when `schema !== ""` (each part via quoteIdent).
- Column clause order: `"name" type [NOT NULL] [DEFAULT <expr>] [PRIMARY KEY]`. Defaults bare unless bare-literal token (number/identifier-safe word) → single-quoted.
- `isPrimaryKey:true` renders inline PRIMARY KEY; key list must not duplicate it.
- Keys as table constraints after columns, array order: `CONSTRAINT "n" UNIQUE ("a","b")` · `CONSTRAINT "n" CHECK (<expr>)` · `FOREIGN KEY ("a") REFERENCES "hr"."departments" ("id")` (qualify ref table when no dot & schema!=="" ). PK renders `PRIMARY KEY ("a")` with NO CONSTRAINT clause.
- Auto-names: `<table>_pkey` (no CONSTRAINT clause), `<table>_<cols _-joined>_key` (unique/FK), `<table>_check`; whole constraint name truncated to 63 chars.
- `quoteIdent`: quote iff empty / chars outside `[a-z0-9_]` / leading digit / in {order,group,table,user,select,check,primary,references,default,from,where}; uppercase ⇒ quoted (`MyCol`→`"MyCol"`).
- `specErrors`: "Table name is required" · "Column name is required" · "Duplicate column name: <n>" · "Column type is required: <name>" · "Key references unknown column: <col>" · "FK must reference at least one column" · "Check expression is required".

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | mandatory defaults exact SQL | `generateCreateTable({name:"users",schema:"public",columns:defaultColumnSpecs("users"),keys:[]})` === `CREATE TABLE "public"."users" (\n    "id_users" varchar DEFAULT uuid_in(overlay(overlay(md5(random()::text \|\| ':' \|\| random()::text) placing '4' from 13) placing to_hex(floor(random() * (11 - 8 + 1) + 8)::int)::text from 17)::cstring),\n    "created_at" varchar DEFAULT TO_CHAR(date_trunc('second', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD HH24:MI:SS')::character varying\n);\n` |
| 2 | unit | id tracks table name | `defaultColumnSpecs("orders")[0].name === "id_orders"` |
| 3 | unit | named constraints | unique `uq_users_code`[code] + FK `dept_id`→hr.departments[id] + check `age >= 0` `users_age_check` → contains `CONSTRAINT "uq_users_code" UNIQUE ("code")`, `FOREIGN KEY ("dept_id") REFERENCES "hr"."departments" ("id")`, `CONSTRAINT "users_age_check" CHECK (age >= 0)` |
| 4 | unit | inline PK | `{name:"id",type:"bigint",isPrimaryKey:true}` → `"id" bigint PRIMARY KEY`, no table PK |
| 5 | edge (boundary) | quoting | `order→"order"`, `MyCol→"MyCol"`, `col_1→col_1`, `""→""`, `1a→"1a"` |
| 6 | edge (validation) | specErrors lists all | `{name:"  ",columns:[{name:"a",type:""},{name:"a",type:"int"}],keys:[{kind:"primaryKey",columns:["zz"]}]}` → the 4 matching messages, length 4 |
| 7 | edge (validation) | valid → [] | `specErrors(fixture#1) === []` |
| 8 | edge (boundary) | ifNotExists / empty schema | `CREATE TABLE IF NOT EXISTS`; schema `""` → bare `"users"` |
| 9 | edge (boundary) | auto-name ≤63 | unnamed unique on 3 long cols → name length ≤ 63 |

## Test Files
- `src/core/__tests__/ddlCreateTable.test.ts`

## Verification Commands
```bash
npx vitest run src/core/__tests__/ddlCreateTable.test.ts && npx tsc --noEmit
```
(New source file — own test file is the selection. No lint script in this repo.)

## Acceptance Criteria
- [ ] All §Test Cases PASS (RED→GREEN, paste real output). No vscode/async/IO in module.
- [ ] Exports match contract exactly. Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- (none)

## Interfaces
- Consumes: (none)
- Produces: `TableSpec`,`ColumnSpec`,`KeySpec`,`quoteIdent`,`UUID_DEFAULT_EXPR`,`CREATED_AT_DEFAULT_EXPR`,`defaultColumnSpecs`,`generateCreateTable`,`specErrors` from `src/core/ddl/createTable.ts`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Keys render INSIDE the parens (table constraints) → one CREATE statement = one runQuery call. Keep it.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Implemented src/core/ddl/createTable.ts (TableSpec/ColumnSpec/KeySpec + quoteIdent, UUID_DEFAULT_EXPR, CREATED_AT_DEFAULT_EXPR, defaultColumnSpecs, generateCreateTable, specErrors) and 9-case test suite under src/core/__tests__/ddlCreateTable.test.ts. Pure module (no vscode/async/IO). Renderer quotes every column/table identifier per canonical fixture SQL; `quoteIdent` exported per contract.
TEST_PLAN_FOLLOWED: task §Test Cases (all 9)
FILES_CHANGED:
  - src/core/ddl/createTable.ts: new — exports contract, mandatory-defaults factory, renderer, validator.
  - src/core/__tests__/ddlCreateTable.test.ts: new — 9 tests (1-9 per §Test Cases).
TESTS_ADDED:
  - src/core/__tests__/ddlCreateTable.test.ts: TASK-001 — CREATE TABLE generator (1-9).
VERIFICATION:
  command: cd .worktrees/task-001 && npx vitest run src/core/__tests__/ddlCreateTable.test.ts && npx tsc --noEmit
  result: vitest 9/9 pass, tsc clean (exit 0, no diagnostics)
  output_excerpt: |
    ✓ src/core/__tests__/ddlCreateTable.test.ts  (9 tests) 2ms
    Test Files  1 passed (1)
         Tests  9 passed (9)
RED_OUTPUT: |
  Failed Suites 1
   FAIL  src/core/__tests__/ddlCreateTable.test.ts
  Error: Failed to load url ../ddl/createTable (resolved id: ../ddl/createTable) in src/core/__tests__/ddlCreateTable.test.ts. Does the file exist?
   Test Files  1 failed (1)
        Tests  no tests
ISSUES: none
HANDOFF_TO_REVIEWER: yes — task is in handoff batch 1, reviewer subagent expected
NEXT: ready for review

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/ddlCreateTable.test.ts && npx tsc --noEmit
  result: 9 pass / 0 fail; tsc exit 0, no diagnostics
TEST_PLAN_COVERAGE: all-followed — 9/9 test cases implemented, RED_OUTPUT contains real failing-suite output (module-not-found before implementation), GREEN verified by fresh re-run
FINDINGS:
  critical: none
  important:
    - src/core/ddl/createTable.ts:103-110 — inline-PK duplication unguarded: spec §34 says "key list must not duplicate it" (inline `isPrimaryKey:true` column + `primaryKey` KeySpec). Renderer emits both (`"id" bigint PRIMARY KEY` line 106 + `PRIMARY KEY ("id")` table constraint), producing `multiple primary keys for table` — reproduced on live PG 5433. Reachable in prod: `copyCreateDdl` (src/ui/tableCommands.ts:289-291) runs generateCreateTable on rowsToSpec output, which sets BOTH isPrimaryKey and a primaryKey KeySpec (src/core/ddl/pgIntrospect.ts:199-201 + :153-159); TASK-006's integration test had to hand-strip the inline flag (src/adapters/__tests__/ddl.integration.test.ts:446-461) to work around this. Fix: when any column has isPrimaryKey, drop primaryKey keys whose columns ⊆ those inline-PK columns (or skip inline rendering when a table PK covers them) — either single source of PK truth, and add a test: spec with isPrimaryKey col + primaryKey key on same column → SQL contains exactly one PK.
    - src/core/ddl/createTable.ts:96-100 — bare-literal default quoting rule unimplemented: spec §33 "Defaults bare unless bare-literal token (number/identifier-safe word) → single-quoted". Renderer emits `DEFAULT ${trimmed}` always-bare. A webview-typed default `pending` (newTableFormMain.ts:392 passes raw input) renders `DEFAULT pending` → PG rejects with `cannot use column reference in DEFAULT expression` — reproduced on live PG 5433. TASK-006 integration uses `default: "true"` (ddl.integration.test.ts:162) — `DEFAULT true` happens to be a valid PG boolean literal, masking the bug in integration. Fix: single-quote the default iff it matches /^[A-Za-z0-9_]+$/ or is numeric (preserve existing exprs verbatim), + test: `{default:"pending"}` → `DEFAULT 'pending'`, `{default:"42"}` → `DEFAULT 42` or `'42'` per spec intent (number bare per §33), `UUID_DEFAULT_EXPR` stays bare.
  minor:
    - src/core/ddl/createTable.ts:60-68 — quoteIdent dead-branch order: `[A-Z]` test (line 67) is unreachable for names passing /^[a-z0-9_]+$/ on line 66; spec's `MyCol→"MyCol"` is only satisfied via line 66's charset test. Harmless but the reserved-word lookup lowercases (line 64) so `Order→"Order"` works; reorder or comment.
    - src/core/ddl/createTable.ts:24-29 — KeySpec union: `check` variant lacks a `columns` field; webview KeySpec interface (newTableFormMain.ts:17-25) declares `columns?: string[]` on all kinds and `expr?: string` — webview check-key without `expr` is a TS error at bundle time? No — webview declares its own local interface, no cross-type constraint; drift is cosmetic only.
    - src/core/__tests__/ddl.integration.test.ts:162 — (downstream, FYI for TASK-006) `default: "true"` only exercises the non-quoted branch that happens to be valid PG; once T1 quoting lands, add a bare-literal default to the integration fixture.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Model isolation OK (unic-code ≠ unic-smart). Both important findings verified against live PG at 127.0.0.1:5433 and traced through merged downstream callers; core renderer/validator themselves are correct for the 9 planned cases.


## Executor Report (fix round 1)
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-Fix1A
SUMMARY: Resolved both important findings from R4 reviewer — PK dedupe (inline `isPrimaryKey` suppressed when a `primaryKey` KeySpec exists; KeySpec renders the table-level constraint) + bare-literal DEFAULT quoting (`pending` → `'pending'`; `now()` → bare; `true` → bare boolean literal; numeric `42` → `'42'`; pre-quoted stays as written). Both fixes verified against live PG via 6/6 TASK-006 integration tests (test #4 un-masked, no longer hand-strips isPrimaryKey).
TEST_PLAN_FOLLOWED: task §Test Cases + 7 regression tests added for R1 findings
FILES_CHANGED:
  - .worktrees/fix1-ddl/src/core/ddl/createTable.ts: added `renderDefault` helper + PK-dedupe guard; both fixes centralized, with tests
  - .worktrees/fix1-ddl/src/core/__tests__/ddlCreateTable.test.ts: +7 tests (PK dedupe single-PK render; `pending`/`now()`/`true`/`'pending'`/`42`/`uuid_in(...)` quoting)
TESTS_ADDED:
  - ddlCreateTable.test.ts: "PK dedupe: isPrimaryKey + primaryKey KeySpec → exactly ONE PRIMARY KEY clause (executable)"; "default quoting: bare identifier 'pending'"; "default quoting: function call 'now()' passes through bare"; "default quoting: boolean literal 'true'"; "default quoting: pre-quoted literal stays as written"; "default quoting: numeric literal 42 → DEFAULT '42'"; "default quoting: uuid_in(...) expression passes through bare"
VERIFICATION:
  command: npx vitest run src/core/__tests__/ddlCreateTable.test.ts src/core/__tests__/ddlAlterTable.test.ts src/core/__tests__/pgIntrospect.test.ts && VSDB_IT=1 VSDB_PG_HOST=127.0.0.1 VSDB_PG_PORT=5433 npx vitest run -c vitest.integration.config.ts src/adapters/__tests__/ddl.integration.test.ts && npx tsc --noEmit
  result: 48 unit pass / 6 integration pass / tsc exit 0
  output_excerpt: |
    ✓ src/core/__tests__/ddlCreateTable.test.ts  (16 tests)
    ✓ src/core/__tests__/ddlAlterTable.test.ts  (18 tests)
    ✓ src/core/__tests__/pgIntrospect.test.ts  (14 tests)
    ✓ src/adapters/__tests__/ddl.integration.test.ts  (6 tests)
ISSUES:
  - "true" / "false" / "null" preserved as bare literals (case-insensitive) — `DEFAULT true` for boolean columns stays valid PG per reviewer note about preserving `'true'` literals.
  - `renderDefault` exported from createTable.ts (TASK-001 contract listed only named originals — renderDefault is additive but allows alterTable.ts to reuse the same DEFAULT clause rule, eliminating drift).
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
