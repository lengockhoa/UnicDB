# TASK-002 — pg_catalog introspection → TableSpec

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
Adapter-agnostic pg_catalog introspection: SQL constants (run via any adapter's `runQuery`) + PURE mapper `rowsToSpec` (pg rows → TableSpec with defaults/nullability/types and PK/UNIQUE/FK/CHECK). Unit tests feed fake rows — no database.

## Target Files
- `src/core/ddl/pgIntrospect.ts` (new) · `src/core/__tests__/pgIntrospect.test.ts` (new)

## Spec
```ts
export const INTROSPECT_COLUMNS_SQL = (schema: string, table: string) => string
export const INTROSPECT_CONSTRAINTS_SQL = (schema: string, table: string) => string
export interface PgColumnRow { column_name: string; format_type: string;
  is_nullable: "YES"|"NO"; column_default: string | null }
export interface PgConstraintRow { conname: string; contype: "p"|"u"|"f"|"c";
  conkey: number[]; confrelidname: string | null; confkeycols: string[] | null; consrc: string }
export function rowsToSpec(schema: string, table: string, colRows: PgColumnRow[],
  conRows: PgConstraintRow[]): TableSpec
```
Types from `./createTable` (TASK-001).
- **INTROSPECT_COLUMNS_SQL**: `$1`=schema `$2`=table; `a.attname AS column_name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS format_type, <attnotnull mapped to "YES"/"NO" in SQL> AS is_nullable, pg_get_expr(ad.adbin,ad.adrelid) AS column_default`; `pg_attribute a` join `pg_class c`/`pg_namespace n` LEFT JOIN `pg_attrdef ad`; `n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped` ORDER BY `a.attnum`. (Style: mirror postgres.ts listColumns 262-276.)
- **INTROSPECT_CONSTRAINTS_SQL**: one row per `pg_constraint`: `conname, contype, conkey (int[]), confrelid::regclass::text AS confrelidname, referenced column NAMES via lateral pg_attribute join AS confkeycols, pg_get_constraintdef(oid, true) AS consrc`; on conrelid, `n.nspname=$1 AND c.relname=$2`; ORDER BY `contype, conname`. Exact SQL shape executor's choice within these requirements (unit tests assert the MAPPER; SQL correctness proven by TASK-006).
- **rowsToSpec**: colRows order → columns `{name, type: format_type, nullable: is_nullable==="YES", default: column_default ?? undefined, originalName: name}` (every column carries originalName — modify mode depends on it). `"p"` → `{kind:"primaryKey",columns:<conkey order>,name:conname}` AND member columns `isPrimaryKey:true`. `"u"` → unique(conname, conkey order). `"f"` → `{kind:"foreignKey",name,columns,references:{table:<confrelidname minus schema — split last '.', keep object part>,columns:confkeycols}}`. `"c"` → `{kind:"check",name,expr:<consrc minus leading "CHECK " and ONE outer paren layer only if it wraps the whole expr>}`. Unknown contype → skip silently.

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | full round-trip 4 key kinds | fixture users (id bigint NOT NULL default `nextval('users_id_seq'::regclass)`, name varchar, age int) + p/u/f/c → columns exact (name/type/nullable/default, originalName===name); keys: primaryKey `users_pkey`["id"], unique `uq_users_name`["name"], foreignKey `fk_users_dept`["dept_id"]→{table:"departments",columns:["id"]}, check `users_age_check` `age > 0`; id isPrimaryKey true |
| 2 | unit | check normalization | `CHECK ((length(name) > 0))` → `length(name) > 0`; `CHECK ((a > 0) AND (b < 9))` → `(a > 0) AND (b < 9)` (no strip — inner parens) |
| 3 | unit | null default absent | `column_default:null` → `"default" in col === false` |
| 4 | unit | conkey ordering | conkey `[2,1]` → key columns `["col_b","col_a"]` (attnum order, NOT sorted) |
| 5 | unit | FK schema prefix stripped | `confrelidname:"hr.departments"` → `references.table === "departments"` |
| 6 | edge (empty) | no constraints / no columns | conRows `[]` → `keys:[]` cols mapped; both empty → `{columns:[],keys:[]}` (caller = not-found) |
| 7 | edge (wrong input) | unknown contype skipped | `contype:"x"` → ignored, no throw |
| 8 | edge (validation) | SQL parameterized | both fns contain `$1`,`$2`; `!INTROSPECT_COLUMNS_SQL("a;b","t").includes("a;b")` |

## Test Files
- `src/core/__tests__/pgIntrospect.test.ts`

## Verification Commands
```bash
npx vitest run src/core/__tests__/pgIntrospect.test.ts && npx tsc --noEmit
```
(New source file — own test file. No lint script in this repo.)

## Acceptance Criteria
- [ ] All §Test Cases PASS. No vscode/pg imports (SQL strings + pure mapper only).
- [ ] Keys resolve by conkey attnum order (#4). Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (TableSpec/ColumnSpec/KeySpec types only).

## Interfaces
- Consumes: type imports from `src/core/ddl/createTable.ts`.
- Produces: `INTROSPECT_COLUMNS_SQL`, `INTROSPECT_CONSTRAINTS_SQL`, `PgColumnRow`, `PgConstraintRow`, `rowsToSpec`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Default-expression equality downstream is NORMALIZED (TASK-003 `normalizeDefaultExpr`): strip outer parens + collapse whitespace — pg rewrites `'now'::text` forms; exotic defaults may show a spurious SET DEFAULT in preview (acceptable — preview shows literal truth).

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
