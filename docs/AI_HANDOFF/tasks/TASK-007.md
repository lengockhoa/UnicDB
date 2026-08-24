# TASK-007 — Fix unqualified + keyword table names in executed SQL (`FROM order`)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature F, Round-1 revised)

## Goal

`SELECT * FROM order;` must succeed when table `order` exists in schema `public`: a pure
pre-execution transform rewrites an unqualified reserved-keyword identifier to
`"public"."order"` — ONLY when it is a reserved keyword AND resolves to an actual table in
public. Applied at the `runStatements` submit path in extension.ts (covers editor Cmd+Enter and
CodeLens runStatement) plus the browse flow.

## Target Files

- `src/core/keywordQualify.ts` **(new)** — pure transform `qualifyKeywordTables(sql, listTables)`
  + exported `isPgReservedKeyword(word)`. No vscode/db imports.
- `src/extension.ts` (modify) — apply the transform inside `runStatements` (verified ~L450, the
  single submit path wired from editor `vsdb.runQuery` L433 and CodeLens `vsdb.runStatement`
  L447) before `runner.run`; async adaptation allowed (runStatements is already async).
- `src/ui/browseCommands.ts` (modify) — apply transform to the generated browse SQL before
  running (cheap, consistent).
- `src/core/__tests__/keywordQualify.test.ts` **(new)** — pure transform tests.
- `src/extension.test.ts` (modify) — runStatement-path test (the reported bug lives here).
- `src/ui/__tests__/browseCommands.test.ts` (modify) — browse wiring test.

NOTE for executor: investigate FIRST (per plan): run a literal `SELECT * FROM order;` against a
scratch public schema via the adapter to confirm which layer fails. Planner-verified:
`splitStatements` is literal-aware and splits on `;` only — `FROM order` does NOT break the
splitter; the failure is Postgres rejecting the unquoted reserved keyword. If investigation
shows the server already accepts it, stop and record findings in Discussion instead of forcing
the transform.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression happy | unqualified keyword table | `SELECT * FROM order;` + listTables `["order"]` → `SELECT * FROM "public"."order";` (changed: true); still ONE statement | transform call |
| 2 | regression (editor path) | runStatement with keyword table | invoking `vsdb.runStatement` with `SELECT * FROM order;` → `runner.run` receives sql containing `"public"."order"` — RED before fix | extension.test.ts harness |
| 3 | edge | already-qualified untouched | `SELECT * FROM prd.order` and `SELECT * FROM public."order"` → unchanged | listTables stub |
| 4 | edge | quoted untouched | `SELECT * FROM "order"` → unchanged | listTables stub |
| 5 | edge (non-table keyword usage) | ORDER BY / keyword-as-keyword | `SELECT 1 FROM t ORDER BY x` → unchanged | listTables stub |
| 6 | edge (CTE) | CTE named like keyword | `WITH order AS (SELECT 1) SELECT * FROM order` → CTE reference NOT rewritten (shadows table) | listTables stub |
| 7 | edge | non-keyword unqualified table | `FROM users` (users ∈ public, not a keyword) → unchanged (search_path semantics preserved) | listTables stub |
| 8 | edge (keyword non-table) | `user` is reserved but no `user` table | unchanged (listTables membership required) | listTables stub |
| 9 | edge (search_path collision) | `order` exists in public AND sales | rewrite still `"public"."order"` — keyword-unqualified NEVER resolves today (pg rejects unquoted reserved word before name lookup), so this cannot silently retarget a working query; non-keyword `users` in both schemas → untouched | listTables stub |
| 10 | unit | keyword list | `isPgReservedKeyword("order"/"user"/"select"/"table")=true`; `"name"/"orders"/"users"=false` | direct calls |
| 11 | wiring | browse path applies transform | browse `public/order` table → `runner.run` receives transformed sql | browseCommands harness |

## Test Files

- `src/core/__tests__/keywordQualify.test.ts` **(new)** — cases 1, 3-10.
- `src/extension.test.ts` (modify — tests-map selection for `src/extension.ts`) — case 2.
- `src/ui/__tests__/browseCommands.test.ts` (modify) — case 11.

## Verification Commands

```bash
npx vitest run src/core/__tests__/keywordQualify.test.ts src/ui/__tests__/browseCommands.test.ts src/extension.test.ts && npm run typecheck
```

(tests-map step 1 selections for the touched sources; new file → its own test. No lint — N/A.)

## Acceptance Criteria

- [ ] Investigation findings recorded in Discussion BEFORE implementing (server-vs-parser).
- [ ] All 11 cases PASS (cases 1-2 RED against current code).
- [ ] `npm run typecheck` clean; no changes to `splitStatements`/`sqlToRun` semantics.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-003 — owns `src/extension.ts` + `src/extension.test.ts` through wave 3 (create-schema
  registration); this task edits both afterward (wave 4).
- TASK-001 — creates `src/ui/browseCommands.ts` + its test (wave 1); this task edits both.

## Interfaces

- Consumes: `splitStatements(sql): ParsedStatement[]` (src/core/statementParser.ts — iterate
  statements; offsets preserved or SQL re-split), `DbAdapter.listTables(schema: string):
  Promise<Array<{ name: string; schema: string }>>`, `QueryRunner.run(statements, onUpdate)`,
  `runStatements(mgr, runner, panel, statements)` in src/extension.ts (L450).
- Produces: `qualifyKeywordTables(sql: string, listTables: (schema: string) => Promise<string[]>):
  Promise<{ sql: string; changed: boolean }>` and `isPgReservedKeyword(word: string): boolean`
  exported from `src/core/keywordQualify.ts` (pure; reserved list = documented Postgres
  reserved-words set, e.g. order/user/select/table/group/where/…).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Round-1 review findings applied: (1) choke point is `runStatements` in src/extension.ts — NOT
tableCommands (which only runs DDL via adapter.runQuery directly); TASK-007 owns extension.ts +
extension.test.ts and must test the runStatement path. (2) Rewrite rule is keyword-ONLY:
unquoted AND unqualified AND follows FROM/INTO/UPDATE/JOIN AND isPgReservedKeyword(name) AND
name ∈ listTables("public") → emit `"public".<name>`; everything else untouched (blanket
public-prefixing would retarget queries under `search_path = sales, public`). Search_path
collision is safe precisely because an unquoted reserved keyword never parses today — there is
no working behavior to preserve. CTE names shadow tables.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
