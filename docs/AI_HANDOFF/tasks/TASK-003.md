# TASK-003 — Pure ALTER diff engine

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
Rename-aware diff: `{before, after}` TableSpecs → ordered PostgreSQL ALTER statements. Renames DETECTED via `ColumnSpec.originalName` / key identity — never drop+add. Pure: no vscode, no I/O, no Date/random.

## Target Files
- `src/core/ddl/alterTable.ts` (new) · `src/core/__tests__/ddlAlterTable.test.ts` (new)

## Spec
```ts
export interface AlterPlan { statements: string[]; errors: string[] }
export function diffTable(before: TableSpec, after: TableSpec): AlterPlan
export function normalizeDefaultExpr(expr: string): string
```
Uses `quoteIdent`, `specErrors` from `./createTable`. Table ref `quoteIdent(before.schema)+"."+quoteIdent(before.name)`; `after.schema !== before.schema` → errors "Schema change is not supported".
**Pairing:** after-column C pairs before-column B iff `C.originalName === B.name` (non-empty); else C is NEW; unpaired before-columns DROPPED. Introspected before-columns always carry originalName (TASK-002); the dialog (TASK-004) must preserve it through edits; new columns in modify mode have NO originalName → ADD.
**Order (exact):** (Column reorder via ↑/↓ emits NO statement — pairing is by name/originalName, never position.)
1. `ALTER TABLE <t> RENAME COLUMN <old> TO <new>;` per rename (input order)
2. `ALTER TABLE <t> ADD COLUMN <def>;` per new column (TASK-001 clause order/quoting)
3. `ALTER TABLE <t> DROP COLUMN <name>;` per dropped column
4. Per paired column with changes (stable order): `SET DATA TYPE <type>;` (compare trim+collapse-ws) → `SET DEFAULT <expr>;` / `DROP DEFAULT;` (compare via normalizeDefaultExpr: trim, strip ONE outer paren layer if wrapping, collapse whitespace) → `SET NOT NULL;` / `DROP NOT NULL;`
5. Keys: `DROP CONSTRAINT <name>;` for before-keys absent in after (unnamed before-key impossible from introspection — skip); `ADD CONSTRAINT …` for after-keys new (rendered like TASK-001). Identity: name match when both named; else kind + columns.join(",") (+ references for FK, normalized expr for check).
6. `ALTER TABLE <t> RENAME TO <newname>;` LAST (only when name changed).
No changes → `{statements:[], errors:[]}` (OK disabled — TASK-004).

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | rename+add+drop-key ordered | before users(id,name,pk users_pkey); after id→user_id (originalName id), +email varchar, keys [] → EXACTLY `['ALTER TABLE "public"."users" RENAME COLUMN "id" TO "user_id";','ALTER TABLE "public"."users" ADD COLUMN "email" varchar;','ALTER TABLE "public"."users" DROP CONSTRAINT "users_pkey";']` |
| 2 | unit | type+default+nullability | before a int nullable; after a (originalName a) `varchar(10)` NOT NULL default `'x'` → 4 stmts: SET DATA TYPE varchar(10) → SET DEFAULT 'x' → SET NOT NULL |
| 3 | unit | default removed | → `ALTER COLUMN "a" DROP DEFAULT;` |
| 4 | unit | table rename last | after.name clients → `['ALTER TABLE "public"."users" RENAME TO "clients";']` |
| 5 | edge (boundary) | identical → empty | same spec before/after → `{statements:[],errors:[]}` |
| 5b | edge (reorder-only) | ↑/↓ reorder only → empty | after = same columns in swapped order (originalName intact) → `{statements:[], errors:[]}` — NO DROP/ADD emitted |
| 6 | edge (rename detection) | rename+type ≠ drop+add | a→b (originalName a) + int→bigint → 2 stmts RENAME then SET DATA TYPE; NO DROP/ADD COLUMN |
| 7 | edge (validation) | invalid after blocks | empty name + dup cols → errors contain both; statements `[]` |
| 8 | edge (wrong input) | schema change refused | before public / after hr → "Schema change is not supported", `[]` |
| 9 | unit | key identity unnamed | before unique named `u1`[code]; after unnamed unique[code] → zero key stmts |
| 10 | edge (boundary) | normalizeDefaultExpr | `(now())`≡`now()`, `'x'`≡`('x')`, `a+b`≡`a + b` (no SET DEFAULT for pairs) |

## Test Files
- `src/core/__tests__/ddlAlterTable.test.ts`

## Verification Commands
```bash
npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit
```
(New source file — own test file. No lint script in this repo.)

## Acceptance Criteria
- [ ] All §Test Cases PASS. Pure module (no vscode/IO/Date/random).
- [ ] Rename NEVER emits DROP+ADD (#6). Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (`TableSpec`, `quoteIdent`, `specErrors`).

## Interfaces
- Consumes: `TableSpec`,`ColumnSpec`,`KeySpec`,`quoteIdent`,`specErrors` from `./createTable`.
- Produces: `AlterPlan`, `diffTable(before, after): AlterPlan`, `normalizeDefaultExpr(expr): string`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
Constraint DROP uses introspected conname (always present in pg). Order renames→adds→drops→column alters→key drops satisfies PG dependency order for common cases (key explicitly dropped regardless of its column's fate).

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
