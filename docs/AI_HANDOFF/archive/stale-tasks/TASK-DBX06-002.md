# TASK-DBX06-002 — catalog usage SQL + plan builder

Cycle: DBX-06 · Wave 4 · Priority: P1
Status: done (reviewer APPROVED — see verdict block in TASK-DBX06-001.md)
Depends on: DBX06-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/core/ddl/renameCatalog.ts` — SQL builders + pure plan builder
(no vscode):

1. Parameterized SQL builders (all take bound params, use ONLY pg_catalog —
   same style as pgIntrospect.ts, no identifier interpolation into WHERE):
   - `DEPENDENT_VIEWS_SQL` — views + materialized views in schema $1 whose
     rewritten rule depends on table $2 (pg_depend → pg_rewrite → pg_class).
     Returns columns: name, kind ('view'|'materialized view').
   - `TABLE_FKS_SQL` — constraints referencing table $2 in schema $1:
     constraint name + the referencing (from) table name.
   - `ROUTINES_SQL` — routines in schema $1 whose prosrc mentions $2
     (advisory, bound parameter); returns name.
   - `NAME_COLLISION_SQL` — schema $1, candidate $2: union over pg_class
     relkinds r/v/m/S/i where relname=$2, returns name + kind label.
2. `buildRenamePlan(opts: {kind: "table"|"column"; schema; table;
   oldName; newName; rows: RenameCatalogRows}): RenamePlan` where
   RenamePlan = `{statements: string[]; report; errors: string[]}`.
   - Invalid state (empty names, newName===oldName) → errors, no statements.
   - Collisions present → error listing them, no statements.
   - kind table → `ALTER TABLE sch.tbl RENAME TO "new";` (alwaysQuote).
   - kind column → `ALTER TABLE sch.tbl RENAME COLUMN "old" TO "new";`
   - Statements are exactly ONE statement (renames are atomic server-side);
     the usage report rides alongside for review.

## Acceptance

- [ ] Tests: SQL builders contain `$1`/`$2` placeholders and no
      identifier-concatenation into WHERE; plan builders for table/column;
      collision → error + empty statements; same-name → error; alwaysQuote
      escaping call.
- [ ] `npx vitest run src/core/ddl/__tests__/renameCatalog.test.ts` green.

## Executor

**RED**: `Failed to load url ../renameCatalog ... Does the file exist?` —
Tests no tests.

**GREEN**: `npx vitest run src/core/ddl/__tests__/renameCatalog.test.ts
src/core/ddl/__tests__/renameAnalysis.test.ts` → Tests 14 passed (14).

Notes:
- 4 SQL builders parameterized ($1 schema, $2 table/candidate), pg_catalog
  only, zero information_schema, zero regclass-in-WHERE.
- DEPENDENT_VIEWS_SQL: pg_depend→pg_rewrite→pg_class join, excludes the
  table itself.
- TABLE_FKS_SQL: contype='f' with confrelid=target, excludes self-FK.
- ROUTINES_SQL: prosrc ILIKE advisory mention.
- NAME_COLLISION_SQL: relkind r/v/m/S/i in target schema.
- buildRenamePlan: ONE atomic statement; collision/same-name → errors +
  empty statements.

## Reviewer

(verdict appended by reviewer)
