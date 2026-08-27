# TASK-001 — ORDER BY parser + dialect clause builder + paging tiebreaker + `(Blanks)` opt-in

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 / §3.2 / §3.3

## Goal

Make `src/ui/queryComposer.ts` able to express a real ORDER BY: parse a multi-term
`orderBy` string into typed terms (accepting a bare identifier **or** an already-quoted one,
rejecting everything else), render those terms per dialect (`NULLS FIRST/LAST` native on
postgres, **rejected** on mysql/mssql — no emulation), append every supplied PK tiebreaker in
its declared order for paging, and let `(Blanks)` also match `''` for **string-typed** columns.
Pure logic only — no
call-site changes (TASK-004 wires it).

## Target Files

- `src/ui/queryComposer.ts` — add `OrderByTerm`, `ParseOrderByResult`, `parseOrderBy`,
  `buildOrderByClause`, `buildPagedQueryTerms`, and a `FilterWhereOptions` argument on
  `buildFilterWhere`. **Do not** modify existing exported behaviour with default arguments.

### Accepted identifier charset (from `PLAN.md` §3.1 — binds this task)

A term's column part is accepted in exactly **two** forms:

1. **Bare** — `/^[A-Za-z_][A-Za-z0-9_$]*$/` (same charset as today's `SIMPLE_ORDER_BY_RE`, so
   cycle V's accepted inputs are a strict subset).
2. **Already quoted in the active dialect's style**: `"First Name"` for postgres (`""` escape),
   `` `First Name` `` for mysql (doubled-backtick escape), `[First Name]` for mssql (`]]` escape).
   Strip only the active style and **un-double** its escapes → `term.column === "First Name"`, an
   *unquoted logical name*. `buildOrderByClause` re-quotes it with
   `quoteIdent(term.column, dialect)`, so quoted input is canonicalized, never passed through.
   When `dialect` is omitted, all three styles are accepted for pure-builder use.

A quote style mismatched to a supplied live dialect is **not supported** and is not unquoted. It
may proceed as an ordinary bare token only if the entire token matches the bare regex; quote,
backtick and bracket delimiters do not, so e.g. backticks under postgres receive the same
standard `{ ok:false, error }` as any malformed identifier. Everything else is rejected: raw
names with spaces / dots / quote characters / non-ASCII letters, function calls, parentheses,
ordinals, `*`. **A raw unquoted identifier never reaches SQL unquoted** — the sole route in is
`quoteIdent`. (TASK-003 quotes a non-bare AG Grid `colId` before sending it.)
- `src/ui/__tests__/queryComposer.test.ts` — append new `describe` blocks. Keep all existing
  blocks untouched and green.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `parseOrderBy` single bare identifier | `{ ok: true, terms: [{ column: "name", direction: "ASC" }] }` | `"name"` |
| 2 | unit (happy) | `parseOrderBy` multi-term with directions | `{ ok: true, terms: [{column:"a",direction:"ASC"},{column:"b",direction:"DESC"}] }` | `"a, b DESC"` |
| 3 | unit (happy) | `buildOrderByClause` quotes per dialect | postgres `"a" ASC, "b" DESC` · mysql `` `a` ASC, `b` DESC `` · mssql `[a] ASC, [b] DESC` | terms from case 2 |
| 4 | edge (malformed input) | function call is rejected | `{ ok: false }` and `error` matches `/plain column/i` | `"lower(name)"` |
| 5 | edge (malformed input) | parenthesised / dotted / ordinal rejected | all three return `ok: false` with a non-empty `error` | `"(a)"`, `"t.a"`, `"1"` |
| 6 | edge (boundary) | empty and whitespace-only input | `{ ok: true, terms: [] }` for both — NOT an error | `""`, `"   "` |
| 7 | edge (malformed input) | empty term between commas rejected | `{ ok: false }` | `"a, "` and `"a,,b"` |
| 8 | edge (injection) | quote-escape payload is not an identifier | `{ ok: false }` — never a term whose `column` contains `"` | `'name"; DROP TABLE t--'` |
| 9 | edge (dialect capability) | `NULLS` is native on postgres only | `parseOrderBy("a NULLS LAST", "postgres")` → `terms[0].nulls === "LAST"`; `buildOrderByClause(terms,"postgres")` → `"a" ASC NULLS LAST`. Same for `NULLS FIRST` → `"a" ASC NULLS FIRST` | `"a NULLS LAST"`, `"a NULLS FIRST"` |
| 10 | edge (dialect capability) | `NULLS` is REJECTED on mysql/mssql, never emulated | `parseOrderBy("a NULLS LAST","mysql")` and `(…, "mssql")` both → `{ ok:false }` with `error` matching `/NULLS/i`; the returned string contains no `CASE` and no `IS NULL` | same input, mysql + mssql |
| 10b | unit (happy) | active-dialect quoted identifier is canonicalized | postgres `"First Name"`, mysql `` `First Name` ``, and mssql `[First Name]` each parse with the matching live dialect to `column === "First Name"`; doubled delimiter escapes are un-doubled; omitted dialect accepts all three styles | one matching input per dialect + omitted-dialect variants |
| 10c | edge (dialect mismatch) | mismatched quote style is rejected | postgres + `` `First Name` `` / `[First Name]`, mysql + `"First Name"`, and mssql + `"First Name"` all return `{ ok:false }` with the standard non-empty user-visible error; raw `First Name DESC` is also `{ ok:false }` | mismatched live dialects + raw spaced input |
| 10d | edge (injection) | quoted identifier is re-quoted, not passed through | `buildOrderByClause(parseOrderBy('"a"" OR 1=1--"', "postgres").terms, "postgres")` → `"a"" OR 1=1--" ASC` (payload remains inside one identifier) | postgres |
| 11 | unit (happy) | composite-PK tiebreaker appends in declared order | `… ORDER BY "name" ASC, "tenant_id" ASC, "id" ASC LIMIT 500 OFFSET 0` | terms `[{name,ASC}]`, tiebreakers `["tenant_id","id"]` |
| 12 | edge (duplicate) | an existing PK component is not doubled | `ORDER BY "tenant_id" DESC, "id" ASC`; `"tenant_id"` appears once and keeps user direction | terms `[{tenant_id,DESC}]`, tiebreakers `["tenant_id","id"]` |
| 13 | edge (boundary) | `tiebreakers: []` is byte-identical to `buildPagedQuery` | `expect(buildPagedQueryTerms(...)).toBe(buildPagedQuery(...))` for postgres AND mssql (incl. the `ORDER BY (SELECT NULL)` mssql placeholder) | same sql/where/offset/limit, no terms |
| 14 | edge (type safety) | string-typed column gets the empty-string arm | `("n" IS NULL OR "n" = '' OR "n" IN ('a'))` | `{n:{values:["(Blanks)","a"]}}`, `{ columnTypes: { n: "varchar" } }` |
| 15 | regression (back-compat) | options absent ⇒ today's output | `("n" IS NULL OR "n" IN ('a'))` — identical to the existing case-3 assertion | same model, no options arg |
| 16 | edge (type safety) | non-string type keeps bare `IS NULL` | `"num" IS NULL` with no `= ''`, for `int4`, `numeric`, `timestamptz`, `bool`, `date` | `{num:{values:["(Blanks)"]}}`, `{ columnTypes: { num: <each> } }` |
| 17 | edge (boundary) | unknown / missing / empty type defaults to NULL-only | `"n" IS NULL` with no `= ''` for all three of: `columnTypes` omitted, `columnTypes: {}`, `columnTypes: { n: "" }` | `{n:{values:["(Blanks)"]}}` |
| 18 | edge (dialect capability) | string-type detection covers all three dialects' families | `= ''` arm present for `char`, `varchar`, `character varying`, `text`, `TINYTEXT`, `MEDIUMTEXT`, `LONGTEXT`, `nvarchar(50)`, `NCHAR`, `enum('a','b')`, `set('x')`, `citext`, `cstring` (case-insensitive); absent for false-positive probes `context_id` and `textbook_code` | one assertion per accepted/rejected type name |

## Test Files

- `src/ui/__tests__/queryComposer.test.ts` — all cases above appended as new `describe` blocks.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/queryComposer.test.ts
npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts
```

(The last command is the blast-radius check: `resultsPanel.ts` imports this module and those two
files assert on composed SQL. They must stay green — this task changes no call site.)

## Acceptance Criteria

- [ ] Every case in §Test Cases passes.
- [ ] `npm run typecheck` clean.
- [ ] All pre-existing `queryComposer.test.ts` blocks still pass unmodified — including the
      **source-text** assertions at lines 161-182 (`getTableSortQuery(` appears exactly once;
      no `quoteIdent(<...>"mssql")`; no `replace(/]/g`). Read them before editing.
- [ ] `buildFilterWhere` called with one argument-pair (no options) is byte-identical to today.
- [ ] The accepted identifier charset is exactly the two forms in §Target Files: only the active
      dialect's quote style is stripped when a dialect is supplied; mismatched quote styles and a
      raw name with a space, dot, quote char or non-ASCII letter are REJECTED, and no code path
      emits an identifier that did not go through `quoteIdent`.
- [ ] `src/ui/queryComposer.ts` contains **no** `CASE WHEN` and no `IS NULL`-based NULLS
      emulation — `grep -n "CASE WHEN" src/ui/queryComposer.ts` returns nothing.
- [ ] `emptyIsBlank` does not appear anywhere: the option is `columnTypes`, and no function in
      this file inspects a *row value* to decide the `(Blanks)` shape.
- [ ] `buildPagedQuery` and `composeSortQuery` keep their current signatures and behaviour.
- [ ] No new import in `src/ui/queryComposer.ts` beyond what is already there
      (`./resultsGridModel`, `../core/saveStatements`, `../adapters/mssql`).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `quoteIdent(name: string, dialect: Dialect): string` from `../core/saveStatements`;
  `sqlLiteral(v: unknown): string` and `SET_FILTER_BLANKS_DISPLAY` from `./resultsGridModel`.
- Produces (TASK-004 consumes these exact signatures — do not rename):

```ts
export interface OrderByTerm {
  column: string;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}
export type ParseOrderByResult =
  | { ok: true; terms: OrderByTerm[] }
  | { ok: false; error: string };

/** `dialect` is optional so a caller with no live connection can still parse.
 *  When it is "mysql" or "mssql", a term carrying `nulls` is REJECTED
 *  (those dialects have no NULLS syntax and this cycle does not emulate it).
 *  When omitted, `nulls` is parsed and kept — the caller decides. */
export function parseOrderBy(orderBy: string, dialect?: Dialect): ParseOrderByResult;
/** postgres renders `NULLS FIRST|LAST` natively. mysql/mssql must never
 *  receive a term with `nulls` — parseOrderBy(…, dialect) rejects it first. */
export function buildOrderByClause(terms: OrderByTerm[], dialect: Dialect): string;
export function buildPagedQueryTerms(
  sql: string,
  where: string,
  terms: OrderByTerm[],
  offset: number,
  limit: number,
  dialect: Dialect,
  tiebreakers: string[],
): string;
export interface FilterWhereOptions {
  /** column name → declared DB type (`ColumnInfo.dataType`, e.g. "varchar",
   *  "int4", "nvarchar(50)"). A column whose type is a string type gets the
   *  `OR col = ''` arm on its `(Blanks)` predicate. Absent / unknown / empty
   *  type ⇒ false ⇒ bare `IS NULL` (cycle-V behaviour). Never derived from
   *  row values — see PLAN.md §3.3. */
  columnTypes?: Record<string, string>;
}
export function buildFilterWhere(
  filters: ColumnFilterModel,
  dialect: Dialect,
  options?: FilterWhereOptions,
): string;
```

---

## Discussion

### 2026-08-26 · planner · bao-opus

→ @executor Four things that will cost you a round if you skip them:

1. **The source-text trap.** `src/ui/__tests__/queryComposer.test.ts:161` reads
   `queryComposer.ts` as text and asserts `source.match(/getTableSortQuery\(/g)` has length 1
   and `source` does NOT match `/quoteIdent\([^)]*"mssql"\)/`. Always call
   `quoteIdent(term.column, dialect)` with the *variable* — never write the literal `"mssql"`
   inside a `quoteIdent(...)` call. Branch on `dialect === "mssql"` outside the call. (The mssql
   `CASE` branch that made this acute is gone — see note 5.)
2. **Cases 11-13 define the full-PK contract.** The builder accepts an ordered array, appends
   every missing component `ASC`, and never lowercases identifiers for dedupe. Case 13 asserts
   with `toBe` against a live `buildPagedQuery`, not a hand-copied string. Cover mssql explicitly:
   it injects `ORDER BY (SELECT NULL)` when there is no ORDER BY, and
   `buildPagedQueryTerms` with empty terms + empty tiebreakers must reproduce that exactly.
3. **`parseOrderBy("")` is `{ ok: true, terms: [] }`, not an error.** Empty is the normal state
   of the requery bar; TASK-004 relies on "no terms" meaning "no ORDER BY clause".
4. **Tiebreaker dedupe is case-sensitive by identifier, not by lowercased text.** Postgres
   folds unquoted identifiers to lowercase but we always emit them quoted, so `"Id"` and `"id"`
   are genuinely different columns. Compare exactly; do not `toLowerCase()`.

5. **NULLS is parse-and-render-or-reject — do NOT emulate** (round-1 review cut the emulation as
   YAGNI: nothing in the product emits `NULLS`, only hand-typing into the requery bar reaches it).
   Postgres renders it natively. For mysql/mssql, `parseOrderBy(orderBy, dialect)` returns
   `{ ok: false, error }` naming the clause, and TASK-004 surfaces that through the *same* single
   error channel it uses for `lower(name)`. Do not write a `CASE WHEN` or an `IS NULL DESC`
   sort key anywhere in this file.
6. **Un-double only the active dialect's escapes, and do not re-escape twice.** `"a""b"` under
   postgres parses to `column: 'a"b'`; `quoteIdent('a"b', "postgres")` then re-emits `"a""b"`.
   With a live dialect, another dialect's delimiters are malformed input, not an alternate quote
   style (cases 10b-10d).
7. **`columnTypes` matching is normalized but family-bounded.** Trim + lowercase first; accept
   char/varchar/nchar/nvarchar prefixes, `character varying`, exact/suffix text-family names
   (`text`, `tinytext`, `mediumtext`, `longtext`, `ntext`), enum/set prefixes, and exact citext /
   cstring. `LONGTEXT` must be true while `context_id` and `textbook_code` remain false (case 18).
   `int4`, `numeric`, `timestamptz`, `bool`, `date` are false (case 16). Unknown ⇒ false.

Ambiguity resolved without asking: `parseOrderBy`'s `dialect` parameter is **optional**. With it
omitted the parser is dialect-agnostic and keeps a `nulls` term; TASK-004 always passes the live
dialect, so the rejection fires in production. This keeps the pure builder testable without a
dialect and keeps one function rather than a `parseOrderBy` / `parseOrderByFor` pair.

(no other comments)

---

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: bao-sonnet (Claude Sonnet 4.5 via UNIC gateway, code tier)
- EXECUTOR_SUBAGENT: feature-implementer
- RED_OUTPUT:
  ```
  Test Files  1 failed (1)
       Tests  18 failed | 24 passed (42)
  TypeError: parseOrderBy is not a function
  ```
- Verification Output:
  ```
  # npx vitest run src/ui/__tests__/queryComposer.test.ts
   Test Files  1 passed (1)
       Tests  42 passed (42)
  # npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts
   Test Files  2 passed (2)
       Tests  27 passed (27)
  # npm run typecheck
  > tsc --noEmit   (clean, exit 0)
  ```
- Status: PASS
- Note: |
  `npm test` (full suite) NOT run — worktree has no own node_modules (symlinked
  `../../node_modules` from the parent repo); orchestrator runs the full suite
  at the wave boundary on the merged tree. Implementation notes:
  1. `unquoteIdent`'s style union uses `"pg" | "backtick" | "bracket"` (NOT
     dialect names) so the pre-existing source-text assertion
     `/quoteIdent\([^)]*"mssql"\)/` (line ~169) keeps passing — the literal
     `"mssql"` must never appear inside a `quoteIdent(...)` call-adjacent match.
  2. The `= ''` arm OR-joins as a separate `parts` entry (same join as `IS
     NULL` and `IN`), yielding `("n" IS NULL OR "n" = '' OR "n" IN ('a'))` —
     one paren set, no nested parens.
  3. `splitTermKeywords` finds the first whitespace outside quotes/brackets as
     the identifier/keyword split point; keywords are then matched by a strict
     `/^(ASC|DESC)?\s*(?:(NULLS)\s+(FIRST|LAST))?$/i` regex.
  4. `buildPagedQueryTerms` delegates to `buildPagedQuery` (which owns the
     mssql `ORDER BY (SELECT NULL)` placeholder and OFFSET/FETCH shapes), so
     case 13's byte-identity holds by construction.
  5. `isStringColumnType`: prefixes char/varchar/nchar/nvarchar/character
     varying/character/enum/set, exact text/tinytext/mediumtext/longtext/
     ntext/citext/cstring; trim+lowercase first; unknown ⇒ false.

---
## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus (configured reviewer alias: unic-smart)
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck; npx vitest run src/ui/__tests__/queryComposer.test.ts; npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts
  result: typecheck clean; 69 pass / 0 fail
TEST_PLAN_COVERAGE: partial — no quoted-identifier comma case; string-family false-positive probes miss near-prefix unknown types
FINDINGS:
  critical:
    - none
  important:
    - file: src/ui/queryComposer.ts:298 — `split(",")` also splits commas inside valid quoted identifiers, so `parseOrderBy('"last, first"', "postgres")` rejects an accepted identifier; split only on top-level commas outside active/recognized identifier delimiters.
    - file: src/ui/queryComposer.ts:100 — the second unbounded prefix regex classifies unknown types such as `charset`, `enumeration`, or `setting` as strings, adding `col = ''` despite the unknown-type ⇒ false contract; remove the unbounded match and keep family-boundary/modifier matching, with regression assertions.
  minor:
    - none
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Model isolation passed (bao-opus vs bao-sonnet); configured `unic-smart` reviewer tier is satisfied. Fresh targeted and blast-radius verification passed, but the two parser/type-classification edge failures require fixes.

## Executor Report (fix round 1)

- EXECUTOR_MODEL: bao-sonnet (Claude Sonnet 4.5 via UNIC gateway, code tier)
- RED_OUTPUT:
  ```
  Test Files  1 failed (1)
       Tests  4 failed | 43 passed (47)
  parseOrderBy quoted-comma cases + charset/enumeration/setting ⇒ expected "c" IS NULL, got = '' arm
  ```
- Verification Output:
  ```
  # npx vitest run src/ui/__tests__/queryComposer.test.ts
   Test Files  1 passed (1)  Tests  47 passed (47)
  # npm run typecheck
  > tsc --noEmit   (clean, exit 0)
  # npx vitest run src/ui/__tests__/resultsPanelServerFilter.test.ts src/ui/__tests__/resultsPanelRequery.test.ts
   Test Files  2 passed (2)  Tests  27 passed (27)
  ```
- Status: PASS
- Note: |
  Both IMPORTANT findings fixed. (1) `splitTopLevel` replaces `split(",")` in
  `parseOrderBy` — copies quoted sections (`"…"`, `` `…` ``, `[…]`) verbatim
  honoring doubled escapes, splits only on top-level commas; unterminated quotes
  are passed through and rejected by the existing term parser. (2)
  `isStringColumnType` now matches exact family tokens with an optional `(`-size
  suffix (`character varying|character|char|varchar|nchar|nvarchar|enum|set`),
  the anchored `/^(tiny|medium|long)?text$/` rule + `ntext`, and exact
  `citext`/`cstring`; `charset`/`enumeration`/`setting` and unknown types stay
  false. 5 regression tests added (3 comma-in-quoted-identifier, 2
  type-classification). No CRITICAL findings existed; no minor findings touched.

## Reviewer Verdict (fix round 1)

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus (configured reviewer alias: unic-smart)
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN: PASS
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Fix-round RED evidence is concrete (4 failed / 43 passed). Fresh typecheck and targeted suite passed; quote-aware comma splitting handles doubled escapes, and string-family matching is bounded as required.
