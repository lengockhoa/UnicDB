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
