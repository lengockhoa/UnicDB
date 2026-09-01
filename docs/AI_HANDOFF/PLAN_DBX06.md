# PLAN_DBX06 — Reviewed PostgreSQL Rename Workflow, Expansion

Cycle: DBX-06 · Base: `main` @ `70020a5` (v1.32.0) · Planning only

## §1 Intent

User directive: **continuous autonomous execution through the remaining portfolio; DBX-06 was selected as the next dependency-satisfied row.**

DBX-06’s original safe-rename workflow shipped in v1.23.0 (`75c6fa8`) and is the correct baseline, but it does not satisfy the expanded portfolio contract for catalog coverage and a typed reviewable step list. The current implementation reports dependent views, referencing FKs, advisory routines, and collisions, but it has no trigger/index usage rows and its `RenamePlan` exposes only `statements: string[]` rather than steps. This cycle extends that reviewed flow without replacing its approved history.

Success: PostgreSQL table and column rename preview reports applicable views, FKs, triggers, indexes, routines, and collisions using bound catalog queries; `buildRenamePlan` returns a pinned, reviewable step list alongside its executable SQL; and the existing preview/explicit-confirmation flow renders those steps and executes only executable rename steps. The commands remain fail-closed behind DBX-08’s declared `tableDdl` capability and report any partial execution failure concretely.

**Current-anchor correction:** `src/extension.ts:1231-1368` is stale and contains AIX-07 trace/console commands. The actual registration seam is `src/extension.ts:34` (import) and `src/extension.ts:218` (`registerTableCommands({ mgr, tree, treeView, context })`); rename handlers are `src/ui/tableCommands.ts:469-534`.

## §2 Scope

### In scope

- Extend the established pure rename catalog contract in `src/core/ddl/renameAnalysis.ts` and `src/core/ddl/renameCatalog.ts` with typed trigger/index rows and source-target-aware catalog SQL that works for table and column analysis.
- Extend `RenameUsageApi` and `PostgresAdapter.renameUsage` with bound methods for those rows, preserving the current `$n` parameter pathway.
- Add an additive typed plan-step surface to `RenamePlan`; retain `statements` as the execution compatibility surface while the UI moves to the new step list.
- Render the additional dependency rows and plan-step labels in the existing safe DOM rename webview; require explicit approval before executing the executable steps.
- Add focused pure, adapter, host, bundle, and table-command capability/partial-failure regression coverage.

### Out of scope

- Rewriting views, trigger functions, routines, FK definitions, or index definitions. PostgreSQL owns dependency validity for the atomic relation/column rename; this feature reports impacted objects and does not attempt unsafe text rewrites.
- Renaming indexes merely because a table name changes; index names are user-owned and changing them is not universally safe.
- New MySQL/MariaDB/SQL Server support, bulk rename, transactions/rollback automation, or modifications to approved `TASK-DBX06-001` through `TASK-DBX06-004` files.
- Editing `src/core/ddl/pgCatalog.ts` or `src/core/dangerousStatement.ts`: both are verified pure-module precedents, but `renameCatalog.ts` is the existing DBX-06 extension seam.

**Same-wave file exclusion:** TASK-DBX06-005 exclusively owns rename core/adapter source and its core/adapter tests. TASK-DBX06-006 exclusively owns rename UI/command/webview source and UI tests. TASK-DBX06-006 depends on 005 because it consumes the new `RenameUsageApi` and `RenamePlan.steps` interfaces; no same-wave paths overlap.

## §3 Approach

1. **Bound catalog analysis, not SQL text construction.** Keep SQL template functions pure in `renameCatalog.ts`, in the same no-vscode/no-pg style as `pgCatalog.ts`. Existing `DEPENDENT_VIEWS_SQL`, `TABLE_FKS_SQL`, `ROUTINES_SQL`, and `NAME_COLLISION_SQL` remain parameterized. The new `TRIGGERS_SQL(): string` and `INDEXES_SQL(): string` have one pinned three-value contract: `$1` is schema, `$2` is table, and `$3` is the column name for column analysis or the exact empty string (`""`) for table analysis. `RenameUsageApi.triggers(schema, table, column)` and `.indexes(schema, table, column)` therefore always bind `[schema, table, column]`; all table-mode calls bind `["public", "users", ""]`. The exact templates are:

   ```sql
   -- TRIGGERS_SQL
   SELECT t.tgname AS name, t.tgtype
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
      AND ($3 = '' OR EXISTS (
             SELECT 1 FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum
            WHERE a.attname = $3
           ) OR COALESCE(pg_catalog.pg_get_expr(t.tgqual, t.tgrelid), '') ~* ('\m' || $3 || '\M'))
    ORDER BY t.tgname

   -- INDEXES_SQL
   SELECT idx.relname AS name, i.indisprimary AS is_primary, i.indisunique AS is_unique,
          COALESCE(ARRAY(
            SELECT a.attname FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.attnum > 0 ORDER BY k.ord
          ), ARRAY[]::name[]) AS columns
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
     JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
    WHERE n.nspname = $1 AND tbl.relname = $2
      AND ($3 = '' OR EXISTS (
             SELECT 1 FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            WHERE k.attnum > 0 AND a.attname = $3
           ) OR COALESCE(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') ~* ('\m' || $3 || '\M')
             OR COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '') ~* ('\m' || $3 || '\M'))
    ORDER BY idx.relname
   ```

   In column mode, triggers are included only for a direct `tgattr`/ordinal-column match or a word-boundary match in `tgqual` (the trigger `WHEN` predicate); indexes are included only for a direct `indkey`/ordinal-column match, a word-boundary match in `indexprs`, or one in `indpred`. Table mode returns every attached trigger/index through `$3 = ''`. Function bodies are explicitly excluded: neither `pg_proc.prosrc` nor `pg_get_functiondef` is consulted by these two templates; the existing routine report remains advisory and is not column dependency analysis.
2. **Typed, additive data contract.** Extend `RenameCatalogRows`/`RenameReport` with `triggers: Array<{ name: string; event: string; timing: string }>` and `indexes: Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }>`. Extend `RenameUsageApi` with exact signatures `triggers(schema: string, table: string, column: string): Promise<Array<{ name: string; event: string; timing: string }>>` and `indexes(schema: string, table: string, column: string): Promise<Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }>>`. `PostgresAdapter.renameUsage` maps its `this.query<T>(sql, params)` snake-case rows to these camel-case API types.
3. **Reviewable ordered plan steps while preserving atomic DDL per rename.** Add `RenamePlanStep` with `kind: "rename" | "review"`, `label: string`, `sql?: string`, and `executable: boolean`; add `steps: RenamePlanStep[]` to `RenamePlan`. Add `RenameOperation { kind: RenameKind; schema: string; table: string; oldName: string; newName: string }` and optional `operations?: RenameOperation[]` to `RenamePlanRequest`; absent `operations` preserves the current single-request operation. The builder emits executable rename steps in `operations` order and derives `statements` as precisely those executable SQL strings in the same order. Thus a supported dependent plan may be `[Rename table: ALTER TABLE "public"."users" RENAME TO "customers";, Rename column: ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";]`; each statement remains atomic, but the approved plan can contain multiple ordered renames. Add one non-executable review step per reported dependency type. The pinned review literal is `Review <type>: PostgreSQL keeps this dependency valid; no automatic rewrite will run.`. Collision and same-name errors produce `steps: []` and `statements: []`; retain the existing exact collision literal `Name collision — target already exists: <collisions>.`.
4. **Preview/confirmation integration.** `RenameForm.analyzeName(newName: string)` requests all six usage lookups concurrently after `validateNewName`, passing `oldName` as `$3` for column mode and `""` as `$3` for table mode, then builds the expanded plan. The host posts the new `steps`; the DOM-only bundle renders rows and makes every executable step visible. Approval passes the ordered executable steps to an additive `runRenameSteps(...)` runner. It stops at the first execution failure and reports `{ applied: Array<{ index, label, sql }>, failed: { index, label, sql, error } }`, so every applied step and the failed step is named; no later step is issued. The existing single-statement runner behavior remains compatible. `vsdb.renameTable` / `vsdb.renameColumn` continue to enter through `guardPostgres`, whose real capability predicate is `hasAdapterCapability(adapter, "tableDdl")`.

**Trade-offs and rejected alternatives:** Querying `pg_get_triggerdef`/`pg_get_indexdef` then parsing SQL is rejected: catalog fields provide a typed, testable report and avoid unbounded SQL parsing. Automatic text rewriting is rejected because dependencies can contain user SQL and a partial rewrite is worse than a visible advisory. Driver identity is rejected as an admission mechanism: DBX-08 declares capability as the source of truth. A breaking replacement of `RenamePlan.statements` is rejected because the current runner/UI use it; steps are additive and then consumed by the preview.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy / pure | expanded table plan | `buildRenamePlan` returns the exact quoted table rename statement plus review steps for populated view/FK/trigger/index/routine rows; only its rename step has `executable: true`. |
| happy / adapter | three-value trigger/index usage mapping | `PostgresAdapter.renameUsage.triggers("public", "users", "")` and `.indexes("public", "users", "")` bind exactly `["public", "users", ""]`; column mode binds exactly `["public", "users", "full_name"]`; both map row fields to the exact camel-case API records. |
| happy / host | expanded preview analysis | a valid table rename calls all six `RenameUsageApi` methods with `""` as the trigger/index third argument, posts trigger/index report rows and ordered plan steps, and enables approval only for a zero-error plan. |
| edge / injection validation | malformed candidate name | `us"; DROP TABLE x; --` returns the existing `plain identifier` error before `getAdapterFor` or any catalog lookup. |
| edge / membership | column dependency inclusion rules | direct `tgattr`/`indkey` ordinal matches, `tgqual` trigger predicates, index expressions (`indexprs`), and partial-index predicates (`indpred`) that word-boundary-match `full_name` are included; a trigger function body mentioning it is excluded. |
| edge / collision | target relation exists | `customers (table)` returns `steps: []`, `statements: []`, and `Name collision — target already exists: customers (table).`. |
| edge / capability | tableDdl denied | `tableDdl: false` shows exactly `VSDB: Rename Table is not supported by this connection's database.` with no panel, lookup, or DDL side effect. |
| regression / partial failure | ordered runner stops after failed executable step | a two-operation plan executes `Rename table: ALTER TABLE "public"."users" RENAME TO "customers";`, then fails on `Rename column: ALTER TABLE "public"."customers" RENAME COLUMN "name" TO "full_name";` with `relation locked`; the outcome names the first in `applied` and the second in `failed`, and no later SQL executes. |
| regression / UI safety | compiled bundle renders untrusted dependency names safely | a trigger/index name such as `<img>` appears as text and bundle source has no `.innerHTML =` or `insertAdjacentHTML`. |

## §5 Verification

`package.json` defines `test`, `test:integration`, `typecheck`, and `compile`; it has **no lint script**. Executors run these real commands after their focused test cycle:

```bash
npx vitest run src/core/ddl/__tests__/renameAnalysis.test.ts src/core/ddl/__tests__/renameCatalog.test.ts src/adapters/__tests__/postgresCatalog.test.ts
npm run typecheck
npm run compile

npx vitest run src/core/ddl/__tests__/renameRunner.test.ts src/ui/__tests__/renameFormHost.test.ts src/ui/__tests__/renameFormBundle.test.ts src/ui/__tests__/tableCommands.test.ts
npm run typecheck
npm run compile
```

Cycle boundary:

```bash
npm test
npm run typecheck
npm run compile
```

`npm run test:integration` is not a default gate because it needs external services; use it only with a provisioned PostgreSQL fixture and record its result. There is no `test:release-core` script.

## §6 Acceptance

- [ ] Table and column analysis reports typed views, FKs, triggers, indexes, routines, and collisions through bound catalog queries; trigger/index lookups always bind schema/table/column as `$1`/`$2`/`$3`, with `""` in table mode, and never interpolate a target value into a filter. (TASK-DBX06-005)
- [ ] Column trigger/index inclusion is pinned to `tgattr`/`indkey` direct positions plus word-boundary matches in `tgqual`/`indexprs`/`indpred`; function bodies are excluded. (TASK-DBX06-005)
- [ ] `RenameUsageApi` and `PostgresAdapter.renameUsage` expose and map typed trigger/index methods without altering support in other adapters. (TASK-DBX06-005)
- [ ] A valid plan provides one or more exact quoted executable rename steps in declared order and clearly labeled non-executable dependency-review steps; collision/same-name plans have no executable SQL. (TASK-DBX06-005)
- [ ] Rename preview renders expanded analysis and step labels with DOM text APIs, maintains explicit confirmation, and executes only the reviewed executable SQL. (TASK-DBX06-006)
- [ ] The capability denial literal remains exact and prevents every form/catalog/SQL side effect. (TASK-DBX06-006)
- [ ] Cancellation and partial failure name every applied executable step and the failed one; no later statement executes after failure. (TASK-DBX06-006)
- [ ] Each task passes its focused Vitest selection plus `npm run typecheck` and `npm run compile`; the cycle boundary passes `npm test`, typecheck, and compile. (TASK-DBX06-005–006)

## §7 Global Constraints

- Keep `engines.vscode` at `^1.75.0`; add no dependency, package contribution, or new command.
- PostgreSQL is the only supported rename implementation; `hasAdapterCapability(adapter, "tableDdl")` is the only admission check.
- Preserve current approved `TASK-DBX06-001`–`004` files, reports, and verdicts; only new 005/006 tasks may change source.
- Keep `renameCatalog.ts`, `renameAnalysis.ts`, and their mappers pure: no vscode, pg, fs, child-process, or network import.
- Bind all catalog target values through `$n` params; preserve `quoteIdent`/`alwaysQuote` semantics and reject invalid new names before adapter access.
- Preserve explicit preview/approval and report-only dependency behavior; never auto-rewrite definitions, mass-rename objects, or execute non-executable review steps.
- Preserve the pinned errors and completion outcomes; do not log credentials, query rows, or SQL parameter values.
- Follow TDD RED→GREEN, the existing Vitest test layouts, and no same-wave target-file overlap.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: discovered that DBX-06 v1.23.0 already delivered the original rename path, then narrowed this cycle to the still-missing expanded trigger/index and typed-plan-step contract rather than recreating approved work; corrected the stale extension anchor; separated adapter/core ownership from UI ownership into two non-overlapping waves; after Round 1, pinned the always-three-value trigger/index binding contract, ordered multi-rename execution/failure identity, and exact column dependency inclusion/exclusion fields.
Known gaps: live PostgreSQL integration is not a default gate because this repository’s integration services are external. Deterministic SQL-template, adapter-mock, host, bundle, capability, and runner tests cover the contract; record a provisioned integration result if an executor changes query semantics.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Plan Review Log

### Round 1 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  1. `PLAN_DBX06.md:35-36` requires both new SQL templates to contain `$1`, `$2`, and `$3`, but `TASK-DBX06-005.md:25-28` requires the table-mode adapter calls to pass only `['public', 'users']`. PostgreSQL requires a bound value for every referenced placeholder, so table analysis would fail with a bind-parameter-count error. Require table mode to bind a third `null` value (and make the SQL handle/cast it), or specify distinct two- and three-parameter templates and update the test contract.
CONSISTENCY:
  2. `PLAN_DBX06.md:37-38` specifies exactly one executable rename step and that review steps never execute, while `PLAN_DBX06.md:53` and `TASK-DBX06-006.md:28` require an integrated partial-failure sequence where `A;` succeeds before executable `B;` fails. The described rename workflow cannot have that state. Either remove/reframe the two-statement case as a pre-existing `runRenameStatements` unit regression and include its test in verification, or define which additional executable rename steps exist and how their applied step identities are reported.
CLARITY:
  3. `PLAN_DBX06.md:35` leaves column-level trigger/index membership as “where catalog metadata can determine one,” without defining the matching catalog fields or fallback. An executor can reasonably include only `pg_trigger.tgattr`/`pg_index.indkey` direct-column records, all relation triggers/indexes, or attempt expression/predicate/body parsing, yielding different previews. Pin the exact inclusion rules for direct, expression, partial-predicate, and trigger-function-body references, and test those cases.
SCOPE:
  - none
YAGNI:
  - none

NOTES: The extension registration seam is current at `src/extension.ts:34,218`; the capability literal and fail-closed guard match `src/ui/tableCommands.ts:126-146`. `package.json` supplies real test/typecheck/compile scripts and no lint script; task target paths do not overlap within Wave 1.

### Round 1 Revision — 2026-09-01 · planner · unic-smart
Status: Resubmitted

1. Reconciled `RenameUsageApi` to an always-three-value contract. `TRIGGERS_SQL` and `INDEXES_SQL` both use `$1 = schema`, `$2 = table`, `$3 = column || ""`; table mode binds exactly `["public", "users", ""]`, and column mode binds exactly `["public", "users", "full_name"]`.
2. Replaced the single-executable-step restriction with ordered `RenameOperation[]` support. The additive runner executes executable rename steps in order, stops on the first error, and returns named records for every applied step plus the failed step; the two-statement `users` → `customers` then `customers.name` → `full_name` case is now implementable.
3. Pinned column membership: include direct `tgattr`/`indkey` ordinal references and word-boundary references in `tgqual`, `indexprs`, and `indpred`; exclude function/trigger-function bodies (`pg_proc.prosrc` and `pg_get_functiondef` are not queried). Tests in TASK-DBX06-005 cover every inclusion class and the body exclusion.

## Planner Self-Audit — Round 1 Revision
Checklist: 12/12 pass
Fixed during audit: reconciled the three reviewed conflicts in the plan/task contracts and added `renameRunner.test.ts` to the UI/execution focused verification selection for the new ordered-runner behavior.
Known gaps: live PostgreSQL integration remains non-default because its services are external; the pinned SQL-template, adapter mock, pure builder/runner, host, and bundle tests deterministically cover these contract changes.

### Round 2 — 2026-09-01 · unic-smart
Status: Approved

COMPLETENESS:
  - none — all three Round-1 findings verified fixed and internally consistent: the always-three-value bind contract (`$1` schema, `$2` table, `$3` column or `""`) is identical across §3.1 pinned SQL, §4 Test Plan, §6, TASK-DBX06-005 Interfaces/Test 2, and TASK-DBX06-006 Consumes/Test 1, with TASK-005's pinned filter text matching §3.1 templates verbatim.
CONSISTENCY:
  - cosmetic — PLAN_DBX06.md:32 prose ("005 exclusively owns rename core ... and its core tests") reads as if 006's `src/core/ddl/renameRunner.ts` + `renameRunner.test.ts` violate it; the authoritative Target Files lists are disjoint and 006 declares a dependency on 005, so there is no actual same-wave overlap. Optionally reword to "rename analysis/catalog core".
  - cosmetic — rename-step label presentation differs between TASK-DBX06-006 Test 2 (rendered `Rename table: ALTER ...;`) and Test 5 (`label: "Rename table"`, `sql: "ALTER ...;"`); Test 5 pins its own fixture outcome deterministically, so both are satisfiable by rendering `label + ": " + sql` in the bundle. No contract conflict.
CLARITY:
  - minor, non-blocking — the pinned SQL selects `tgtype` (smallint bitmask) but the API record promises `event: string; timing: string`, and no tgtype→event/timing decoding is pinned (PLAN §3.2; TASK-005 Test 2 says only "snake-case fixture fields"). Data is display-only/advisory and the executor's TDD fixture pins whatever decoding is chosen; orchestrator may apply the pg_trigger bit decoding (1 ROW, 2 BEFORE, 64 INSTEAD; 4/8/16/32 = INSERT/DELETE/UPDATE/TRUNCATE) directly if cross-executor label identity is wanted.
SCOPE:
  - none
YAGNI:
  - none

NOTES: Final pass clean: Task Gate fields complete on both tasks; 005/006 sequential waves with disjoint files; capability-denial and collision literals pinned identically; `test`/`test:integration`/`typecheck`/`compile` all real in package.json and both tasks state the no-lint reason with typecheck required; §6 verifiable. Only residual note: cancellation reporting (`cancelledAfter` variant of `runRenameSteps`) has no dedicated test row, but the retained `isCancelled` runner contract and §6 item 7 cover it.
