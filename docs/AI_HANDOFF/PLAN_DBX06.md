# PLAN_DBX06 — Safe Rename Refactor

Cycle: DBX-06 (wave 4) · Base: main @ 38ff2ea (v1.22.0) · Release target: v1.23.0
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

## Roadmap row

> **DBX-06 Safe Rename Refactor** — Rename PostgreSQL tables/columns with
> catalog usage analysis and a reviewable ALTER/update plan.
> Approach: DDL/catalog/refactor service and preview UI; depends DBX-02 and
> DBX-03. **No unreviewed bulk rewrite.**
> Edge cases: quoted names, dependent views/FKs/routines, name collision,
> cancellation/partial failure.

## Current state (evidence)

- `src/core/ddl/alterTable.ts` — pure ALTER TABLE diff engine: column renames
  render `ALTER TABLE … RENAME COLUMN`, table renames `ALTER TABLE … RENAME
  TO`; `alwaysQuote` handles quoting ("" doubling is the quoting contract).
  `NewTableForm` modify-mode already drives it with a preview + single
  `runDdl` confirm, but rename is one op among many — no catalog usage
  analysis, no collision check, no dependent-object report.
- `src/core/ddl/pgIntrospect.ts` — parameterized pg_catalog introspection
  ($1/$2) precedent for usage-analysis SQL.
- `runQuery(sql, values?)` supports parameterized reads (Postgres) — usage
  analysis must use bound parameters, never string interpolation.

## Goal

A dedicated `vsdb.renameTable` / `vsdb.renameColumn` flow: the user enters
a new name, the tool runs a **catalog usage analysis** (dependencies the
server does NOT rename on your behalf made visible: views referencing the
table/column, FK constraints referencing the table, routines whose body
mentions the table — advisory, plus table/column name collisions in the
target schema), renders a **reviewable plan** (ALTER … RENAME statements +
the usage report), and executes only on explicit confirm. Cancellation is
honored per-statement; a partial failure reports exactly which statement
failed and what already applied.

## Non-goals

- No automatic rewriting of view/routine definitions (report-only — the
  server updates references; we surface what exists so the user can review).
- No bulk multi-table rename.
- No MySQL/MSSQL (PostgreSQL-first; guardPostgres like modifyTable).

## Tasks (TDD, each RED→GREEN)

### TASK-DBX06-001 — `renameAnalysis` pure module
`src/core/ddl/renameAnalysis.ts` (PURE): `validateNewName(newName)` —
plain-identifier regex + forbidden-keyword substring (same contract as
dbAwareTools.badIdentifier) → error string | null;
`analyzeUsage(catalog: RenameCatalogRows): RenameReport` — pure reducer
turning catalog query rows into {views: [{name, kind}], fks: [{constraint,
references}], routines: [{name}], collisions: string[]}.

### TASK-DBX06-002 — catalog usage SQL + plan builder
`src/core/ddl/renameCatalog.ts`:
- SQL builders (parameterized $1/$2/$3, pg_catalog only):
  `DEPENDENT_VIEWS_SQL` (pg_depend/pg_rewrite for views+matviews relying on
  the table), `TABLE_FKS_SQL` (constraints referencing the table),
  `ROUTINES_SQL` (pg_proc whose prosrc mentions the table — advisory),
  `NAME_COLLISION_SQL` (target-name existence across tables/views/
  materialized views/sequences/indexes in the schema).
- `buildRenamePlan(kind, schema, table, oldName, newName, rows)` — pure;
  collision → errors + empty statements; renders ALTER … RENAME via
  alwaysQuote; quotes handled for odd identifiers ("" doubling tests).

### TASK-DBX06-003 — rename UI (preview + confirm + progress)
`src/ui/renameForm.ts` (DOM-API webview, CSP-safe, mirrors NewTableForm
scaffold): input + analysis summary + plan statements + Approve/Cancel.
Approve → run statements sequentially with per-statement progress posts;
Cancel mid-run stops before the NEXT statement and reports applied/remaining.
Register `vsdb.renameTable` + `vsdb.renameColumn` (table + column nodes,
guardPostgres) in tableCommands.ts + package.json menus.

### TASK-DBX06-004 — scaffold + CHANGELOG/README
`dbx06Scaffold.test.ts`: rename modules pure (no vscode), SQL builders
parameterized (no string-concat of names into WHERE), exports present,
package.json declares the 2 commands. CHANGELOG 1.23.0 + link; README
bullet.

## Verification per task

`npx vitest run <target test>`; cycle: `npm test`, `npm run typecheck`,
`npm run compile`.

## Risk / review focus

- SQL injection via identifiers into catalog queries (MUST be $n-bound).
- Collision check completeness (tables/views/sequences/indexes).
- Partial-failure reporting on multi-statement apply.
