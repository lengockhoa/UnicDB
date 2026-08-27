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
| # | Type | Test name | Expected |
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


---

## Executor Report
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T003
SUMMARY: Implemented pure ALTER TABLE diff engine (`diffTable`, `normalizeDefaultExpr`, `AlterPlan`) plus 14 unit tests. Rename-aware via `ColumnSpec.originalName`; reorder-only and identical specs emit zero statements; schema-change refused with `Schema change is not supported`. Pure module: no vscode, no I/O, no Date/random.
TEST_PLAN_FOLLOWED: task §Test Cases (10 cases → 14 test() bodies covering all)
FILES_CHANGED:
  - `.worktrees/task-003/src/core/ddl/createTable.ts` (new): placeholder type-only Contract exports (TASK-001 owns; flagged as placeholder for orchestrator drop-in)
  - `.worktrees/task-003/src/core/ddl/alterTable.ts` (new): pure diff engine — `diffTable`, `normalizeDefaultExpr`, `quoteIdent`, `specErrors`, helpers
  - `.worktrees/task-003/src/core/__tests__/ddlAlterTable.test.ts` (new): 14 vitest tests covering all §Test Cases
TESTS_ADDED:
  - `src/core/__tests__/ddlAlterTable.test.ts`: 14 tests across rename+add+drop-key ordered (#1), type+default+nullability (#2), default removed (#3), table rename last (#4), identical→empty (#5), reorder-only→empty (#5b), rename+type no DROP+ADD (#6), invalid after blocks (#7), schema change refused (#8), key identity unnamed (#9), normalizeDefaultExpr (#10 with 4 sub-cases)
VERIFICATION:
  command: `npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit`
  result: 14 pass / 0 fail (vitest), tsc no errors, both exit 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-003
     ✓ src/core/__tests__/ddlAlterTable.test.ts  (14 tests) 3ms
     Test Files  1 passed (1)
          Tests  14 passed (14)
    ---EXIT:0
    ===TSC===
    ---EXIT:0
ISSUES:
  - Placeholder createTable.ts adds `name?:string` to primaryKey variant so the spec's test #1 (which references `users_pkey` as named PK) type-checks. Practical — TASK-002's introspection also produces named PKs via conname. Final state depends on TASK-001's resolution.
  - `quoteIdent` always-quote rendering chosen to match TASK-001 test expectations (`"id"` everywhere); the "quote iff..." rule in TASK-001 spec is a necessary-but-not-sufficient description.
  - `normalizeDefaultExpr` strips ALL internal whitespace (not just collapses) to satisfy test #10's `a+b` ≡ `a + b` requirement while also handling the wrapping-paren + trim cases.
  - Helpers (`quoteIdent`, `specErrors`) intentionally duplicated inline in alterTable.ts so it compiles standalone against the placeholder. Orchestrator will drop-in TASK-001's createTable.ts and these helpers stay behavior-matching.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review — rename path verified, no DROP+ADD emitted for renames (#6 explicit assertion in test).
<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW Executor Report.
-->

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_TOOL: claude-code
EXECUTOR_SUBAGENT: Exec-T003
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit
  result: 14 pass / 0 fail; tsc exit 0
TEST_PLAN_COVERAGE: all-followed (10 cases → 14 tests, incl. ≥2 edge; renames, reorder-only, empty plan, schema refusal, normalizeDefaultExpr all asserted)
FINDINGS:
  critical: none
  important:
    - src/core/ddl/alterTable.ts:274-278 — ADD COLUMN renders only `"name" type` and silently drops the new column's DEFAULT and NOT NULL clauses. Spec item 2 requires TASK-001 clause order; canonical clause composition is `createTable.ts:89-96` (`"${name}" ${type}` + `NOT NULL` + `DEFAULT <trimmed>`). Reachable from the primary modify-mode flow: `webview/newTableFormMain.ts:386-395` always sets `default` + `nullable` on every edited/new column, so a new column with NOT NULL DEFAULT 'x' yields `ADD COLUMN "x" integer;` — data-shape divergence between preview and DB. Fix: compose the ADD COLUMN clause with `c.default !== undefined && c.default !== ""` → `DEFAULT ${c.default.trim()}` and `c.nullable === false` → `NOT NULL` (after the type, TASK-001 order), and add a unit test: modify-mode new column `{name:"x",type:"integer",nullable:false,default:"'z'"}` → exactly `ALTER TABLE "public"."t" ADD COLUMN "x" integer DEFAULT 'z' NOT NULL;`.
  minor:
    - src/core/ddl/alterTable.ts:216-225 — ADD CONSTRAINT FOREIGN KEY renders a schema-less `references.table` as bare `"tbl"`; canonical CREATE path (createTable.ts:128-133) qualifies it with `spec.schema`. Divergent REFERENCES rendering between CREATE and ALTER ADD for the same KeySpec.
    - src/core/ddl/alterTable.ts:21 — local `alwaysQuote` duplicates quoting logic and is now imported cross-module (src/ui/tableCommands.ts:28); consider re-homing beside canonical `quoteIdent` to prevent drift.
    - src/core/__tests__/ddlAlterTable.test.ts — no test covers new-column clause rendering (follows from the important finding; add with the fix).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Model isolation OK (executor unic-code ≠ reviewer unic-smart, matches handoff.reviewer.model). Merge to canonical createTable.ts contract verified clean (types + specErrors imported, placeholder gone). One important defect: ADD COLUMN drops NOT NULL/DEFAULT — fix is small and localized to the ADD loop.


## Executor Report (fix round 1)
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-Fix1A
SUMMARY: Resolved the one important finding (ADD COLUMN must include NOT NULL + DEFAULT per TASK-001 clause order) and the minor FK ADD CONSTRAINT schema-qualification parity finding. ADD COLUMN now emits `"name" type [NOT NULL] [DEFAULT <renderDefault>]` matching createTable.ts. FK ADD CONSTRAINT references now qualify a bare `references.table` with the source table's `schema`, matching createTable parity.
TEST_PLAN_FOLLOWED: task §Test Cases + R1 regressions (4 new tests)
FILES_CHANGED:
  - .worktrees/fix1-ddl/src/core/ddl/alterTable.ts: ADD COLUMN renders NOT NULL + DEFAULT (id via shared `renderDefault` from createTable.ts); new `renderReferenceTarget` helper + `renderAddConstraint` now takes the table's `schema` for FK REFERENCES parity with createTable.ts; inlined `nullableOf` (single-call site, no longer a tiny helper)
  - .worktrees/fix1-ddl/src/core/__tests__/ddlAlterTable.test.ts: +4 regression tests for ADD COLUMN clause composition and FK schema-qualification (both bare and already-qualified paths)
TESTS_ADDED:
  - ddlAlterTable.test.ts: "R1 — ADD COLUMN with NOT NULL + DEFAULT 'literal' in clause order"; "R1 — ADD COLUMN with DEFAULT 'now()' (function-call)"; "R1 — FK ADD CONSTRAINT references schema-qualification — bare references.table"; "R1 — FK ADD CONSTRAINT references schema-qualification — already-qualified"
VERIFICATION:
  command: npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit
  result: 18/18 pass / tsc clean
  output_excerpt: |
    ✓ src/core/__tests__/ddlAlterTable.test.ts  (18 tests)
ISSUES:
  - Minor cleanup: removed `nullableOf` wrapper (only call site, was `!!c.nullable` — inlined per project no-tiny-functions rule).
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

## Reviewer Verdict (re-review round 1)

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code (Exec-Fix1A)
EXECUTION_COMMITS: 58a56b8 (wave A — DDL stack), range 688839d..HEAD
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit
  result: 18 pass / 0 fail; tsc exit 0 (fresh re-run by reviewer)
ROUND1_FINDINGS_RESOLUTION:
  - important (ADD COLUMN missing NOT NULL/DEFAULT) — RESOLVED. alterTable.ts:298-306 now composes `"name" type [NOT NULL] [DEFAULT <renderDefault(...)>]`, importing the canonical `renderDefault` from createTable.ts:97 (single source of truth, no local re-implementation of literal quoting). Clause order matches generateCreateTable (createTable.ts:146-151). Two R1 regression tests cover bare-literal (`DEFAULT 'pending'`, with exact full-statement equality) and function-call (`DEFAULT now()` bare, quoted form explicitly rejected).
  - minor (FK ADD CONSTRAINT references qualification) — RESOLVED. renderAddConstraint (alterTable.ts:216-243) now takes `schema` (passed `before.schema` at the sole call site, alterTable.ts:371) and delegates to new `renderReferenceTarget` (alterTable.ts:196-210): already-qualified → per-part quoted, bare + non-empty schema → `"schema"."table"`, empty schema → bare quoted. Byte-identical semantics to createTable.ts:186-192. Two R1 regression tests cover both paths, including the no-double-prefix case.
REGRESSION_CHECK: none found. Rename path (#6), reorder-only (#5b), key identity (#9), normalizeDefaultExpr (#10) all still pass; schema-change refusal, invalid-after blocking, and table-rename-last ordering untouched by the diff. Diff is additive (35 insertions / 18 deletions) with `nullableOf` inlined (was `!!c.nullable` at one call site — equivalent semantics, `?? true` normalization applied consistently to both sides of the nullability compare).
FINDINGS:
  critical: none
  important: none
  minor:
    - src/core/ddl/alterTable.ts:196-210 — `renderReferenceTarget` duplicates createTable's inline FK target logic (createTable.ts:186-192) rather than sharing one helper; behaviorally identical today, slight future-drift risk. Non-blocking; a follow-up could hoist it into createTable.ts alongside `renderDefault` and re-export.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Both R1 findings resolved with test coverage; verification re-run clean. Model isolation OK (executor unic-code ≠ reviewer unic-smart per handoff.reviewer.model).
