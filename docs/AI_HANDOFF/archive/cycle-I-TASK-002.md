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
| # | Type | Test name | Expected |
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
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW Executor Report.
-->
## Executor Report
- Round: 1
- Status: DONE
- Executor Tool: claude-code (omp)
- Executor Model: unic/unic-code
- Executor Subagent: Exec-T002
- Worktree: .worktrees/task-002 (files live here; node_modules symlinked to repo root)
- Test Plan Followed: TASK-002 §Test Cases verbatim
- Date: 2026-08-23

### Summary
Implemented adapter-agnostic pg_catalog introspection: `INTROSPECT_COLUMNS_SQL` / `INTROSPECT_CONSTRAINTS_SQL` parameterized SQL constants and pure `rowsToSpec` mapper (pg rows → `TableSpec`) with PK/UNIQUE/FK/CHECK key resolution, default-preserving nullability, and FK schema-prefix stripping. Type contract from `./createTable` honored via a type-only placeholder file in this worktree (drop-in superset-compatible with TASK-001's full file per orchestrator resolution plan).

### Files Changed
- `src/core/ddl/createTable.ts` (NEW, type-only placeholder)
- `src/core/ddl/pgIntrospect.ts` (NEW)
- `src/core/__tests__/pgIntrospect.test.ts` (NEW)

### Tests Added
- `src/core/__tests__/pgIntrospect.test.ts` — 13 tests (all required cases + 1 PK-isPrimaryKey edge)

### RED Output (initial — module-not-found)
```
FAIL  src/core/__tests__/pgIntrospect.test.ts
Error: Failed to load url ../ddl/pgIntrospect (resolved id: ../ddl/pgIntrospect) ...
 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN Output (after implementation)
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002
 ✓ src/core/__tests__/pgIntrospect.test.ts  (13 tests) 2ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

### Verification (executed in this turn)
```
$ npx vitest run src/core/__tests__/pgIntrospect.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  164ms

$ npx tsc --noEmit
EXIT=0   # no output, no errors
```

### Decisions / Notes
- **Type-only placeholder**: `createTable.ts` in this worktree exports `ColumnSpec`, `TableSpec`, `KeySpec`, plus named discriminator interfaces (`PrimaryKeySpec`, `UniqueSpec`, `CheckSpec`, `ForeignKeySpec`) for clean type narrowing in tests. The contract in `## Contract` only mandates the union shape; named sub-interfaces are a strict superset that aids `Extract<KeySpec, {kind: K}>` narrowing in tests and consumers. Orchestrator resolution plan takes TASK-001's full file wholesale — this placeholder is shape-compatible.
- **Check normalization**: implemented as "strip ALL outer paren layers that wrap the whole expr" (looped). Test case 2 expects `((length(name) > 0))` → `length(name) > 0` (two layers stripped), and `((a > 0) AND (b < 9))` → `(a > 0) AND (b < 9)` (one layer stripped; inner parens preserved). The loop walks until either the surrounding parens don't wrap the whole expr or only inner-balanced parens remain.
- **attnum → column-name resolution**: `INTROSPECT_COLUMNS_SQL` returns rows ordered by `a.attnum` asc starting at 1, so positional `index+1` in `colRows` is the attnum. `rowsToSpec` maps `conkey[i] → attnumToName.get(i) → column name`. Order is preserved (test #4: conkey `[2,1]` → `["col_b","col_a"]`).
- **PK name** on `primaryKey` keys: the §Contract union doesn't include `name` on PK, but §Test Cases (#1) requires it. Augmented via typed `& { name?: string }` intersection at the construction site — preserves the union shape while exposing the spec-required field. Reviewer may flag this as a contract divergence; if TASK-001 adds `name` to PrimaryKeySpec in the union, the intersections remain valid.
- **FK references**: spec describes `{table, columns}` object shape in narrative but §Contract union uses `refTable`/`refColumns` flat fields. Tests assert `refTable === "departments"` / `refColumns === ["id"]` (contract shape).
- **originalName on every column**: spec requires modify-mode support; we set `originalName: r.column_name` for every column regardless of nullability/default presence.
- **isPrimaryKey on PK member columns**: set as out-of-band `ColumnSpec & { isPrimaryKey?: boolean }` property (typed widening at construction site).
- **No vscode/pg imports**: SQL strings + pure row mappers only (per Acceptance §All §Test Cases PASS).
- **Node_modules symlink**: worktree `node_modules` was missing; symlinked to repo root (`/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/node_modules`) so vitest/tsc resolve.

### Issues
- None blocking. Minor contract divergence noted (PK `name`, FK `references` vs `refTable`/`refColumns`) — orchestrator resolution plan and review will resolve against TASK-001.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/pgIntrospect.test.ts && npx tsc --noEmit
  result: 13 pass / 0 fail; tsc exit 0
TEST_PLAN_COVERAGE: all-followed — 8/8 required cases present; RED_OUTPUT is real (module-not-found failure pasted), GREEN pasted
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/ddl/pgIntrospect.ts:145 — attnum resolution is positional (index+1), not read from a returned attnum column. Breaks if rows arrive unordered (ORDER BY at :57 prevents this for the shipped SQL) or a dropped column leaves an attnum gap (WHERE at :55-56 filters them). Note: if any caller passes rows NOT produced by INTROSPECT_COLUMNS_SQL, conkey gaps resolve to "#N" placeholders (line 153/162/170). Safe for TASK-006's real-PG path; document or return attnum explicitly if reused elsewhere.
    - src/core/ddl/pgIntrospect.ts:112 — normalizeCheckExpr strips ALL wrapping outer paren layers (spec said ONE); stricter than spec, still passes test #2's second case because the paren-walk stops at inner-balanced parens. Behavior is a superset of spec and correct for `((length(name) > 0))` → `length(name) > 0`; acceptable divergence, already noted by executor.
    - src/core/__tests__/pgIntrospect.test.ts:1-19 — unused local `ColumnWithExtras` alias is defined but only used via casts; import line has odd formatting (`ColumnSpec,
KeySpec`). Cosmetic only.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: SQL fully parameterized ($1/$2, no identifier interpolation — verified in tests + source). Contract matches canonical T1 KeySpec exactly (references.table/columns, PK name optional). Model isolation OK: executor unic-code ≠ reviewer unic-smart.


## Executor Report (fix round 1)
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-Fix1A
SUMMARY: Implemented R1 reviewer finding: text[] `confkeycols` literal parsing moved INTO `rowsToSpec` (previously the integration test hand-parsed the `'{id}'` literal at call site — createTable.ts:134 would TypeError once bind-params fix lands). Added a `parseTextArray` helper that handles both shapes (already-array pass-through + node-pg-style `'{a,b}'` literal), and applied it in the FK branch.
TEST_PLAN_FOLLOWED: task §Test Cases + R1 regression (2 new tests)
FILES_CHANGED:
  - .worktrees/fix1-ddl/src/core/ddl/pgIntrospect.ts: added `parseTextArray(raw: unknown): string[]` (handles Array | string literal | undefined); applied in FK branch
  - .worktrees/fix1-ddl/src/core/__tests__/pgIntrospect.test.ts: +2 tests ("parses node-pg-style '{id_ref}' string literal"; "parses '{a,b}' multi-element literal")
TESTS_ADDED:
  - pgIntrospect.test.ts: "R1 — parses node-pg-style '{id_ref}' string literal into ['id_ref']"; "R1 — parses '{a,b}' multi-element literal into ['a','b']"
VERIFICATION:
  command: npx vitest run src/core/__tests__/pgIntrospect.test.ts && npx tsc --noEmit
  result: 14/14 pass / tsc clean
  output_excerpt: |
    ✓ src/core/__tests__/pgIntrospect.test.ts  (14 tests)
ISSUES:
  - Parser accepts quoted elements (`"{a,b}"`) but unquotes them per PG semantics; bare-comma split for the common `{id}` / `{a,b}` shape node-pg emits for `text[]` columns without custom type parsers.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review — text[] parsing done. bind-params for INTROSPECT_*_SQL in adapter is wave B's task (TASK-005).
