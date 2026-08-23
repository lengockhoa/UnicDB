# PLAN — Cycle I (2026-08-23): DataGrip-style table designer for PostgreSQL

## §1 Intent

Users currently cannot create or modify tables from VSDB's Schema Explorer — every DDL change
means switching to another tool. Success for this cycle (PostgreSQL only):

1. Right-click a **schema** node, a **Tables category** node, or a **table** node → **"New Table…"**
   opens a DataGrip-style designer dialog (left panel COLUMNS/KEYS lists with +,−,↑,↓; right
   edit form; bottom live SQL Preview; Cancel / **OK — Execute**). OK runs the DDL, refreshes
   the tree, reveals the new table, shows a success notification.
2. Right-click a **table** node → **"Modify Table…"** opens the same dialog in modify mode
   ("Modify — <schema>.<table>"), preloaded with live introspected structure; edits produce an
   ordered ALTER script (rename detected, not guessed via drop+add); OK — Execute applies it
   and refreshes the tree.
3. Table-node utility menu: **Copy CREATE DDL** (full CREATE TABLE + constraints → clipboard),
   **Generate Sample Data…** (N type-aware INSERTs into an untitled SQL document),
   **Analyze Table**, **Vacuum Table**.

Mandatory defaults on every NEW table (user request, verbatim semantics): column
`id_<table_name>` varchar with a uuid-expression DEFAULT that tracks the table name, and
`created_at` varchar with DEFAULT `TO_CHAR(date_trunc('second', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD HH24:MI:SS')::character varying`. Both are ordinary editable rows —
the only automatic behaviors are initial injection (create mode) and the id name tracking the
table name. Exact expressions in TASK-001.

Non-postgres nodes: commands appear in the menu but the handler shows an Information message
"New Table: PostgreSQL connections only" (per node's driver) and does nothing. Menu
`when`-clauses only see `viewItem`, so `viewItem == category` also matches Views/Routines —
handlers no-op politely for non-tables categories.

## §2 Scope

**In scope (this cycle, PostgreSQL only)**
- Pure DDL layer under `src/core/ddl/`: TableSpec types, quoting, CREATE TABLE generator with
  the two mandatory default columns, ALTER diff engine (before/after TableSpec → ordered
  ALTER statements), CREATE-DDL generator from live introspection, sample-INSERT generator.
- pg_catalog introspection (column defaults + PK/UNIQUE/FK/CHECK constraints → TableSpec) as
  pure SQL-string + row-mapping functions, adapter-agnostic.
- One webview dialog engine (create + modify modes), bundled as its own esbuild entry.
- Tree command wiring: package.json contributes (commands + view/item/context menus on
  `schema`, `category`, `table` nodes), extension.ts registrations, driver guards, tree
  refresh + reveal after execute, success notifications.
- Unit tests (vitest, host + pure) and PG integration tests (VSDB_IT=1).
- Docs: CODE_MAP.md + README.md rows (closing task).

**Out of scope**
- MySQL/MSSQL table designer (guards show Information message).
- Editable SQL preview (read-only preview; stretch recorded in backlog).
- "Add to AI Prompt" (needs AI-assist spec).
- "Edit table order" (tree-level reorder; ↑/↓ inside Modify covers ordering).
- "Postman Payload" (possible later sample-data cycle).
- Table comments, partitioning, exclusion constraints, index editor beyond keys listed above.

**Backlog (queued cycles)**
- Cycle J queued: AI core (config+provider+agent foundation) — full spec at `docs/AI_HANDOFF/queue/AI-CORE-spec.md`.
- Editable SQL preview; MySQL/MSSQL designer; Postman payload.

**File-wave constraint:** tasks in the same wave share NO target file (verified §7 table).

## §3 Approach

**Architecture — mirror ConnectionForm exactly (established repo pattern):**
- Host panel class (owns webview + message loop) in `src/ui/`, typed message protocol, plain
  DOM webview entry under `webview/` bundled by esbuild to `dist/newTableForm.js`, strict CSP,
  `retainContextWhenHidden`, single instance. No framework — same vanilla DOM style as
  `webview/connectionFormMain.ts`.
- **Preview computed host-side** (in the message handler) using the SAME pure generators the
  executor will call — the preview pane can never drift from what OK executes. The webview is
  dumb state; every change event sends the spec up, host replies `{type:"preview", sql}`.
  Trade-off: one message round-trip per keystroke; acceptable (form-scale payloads, single
  user) and it guarantees preview == executed SQL. Alternative (generator duplicated in the
  webview bundle) rejected: drift risk. Alternative (generator imported into the webview
  bundle too) rejected: duplicated generator instance + bundle size for zero benefit.

**Pure DDL core, adapter-agnostic:** `src/core/ddl/createTable.ts` (types + quoting +
`defaultColumnSpecs(tableName)` + `generateCreateTable(spec)` + `specErrors(spec)`),
`src/core/ddl/alterTable.ts` (rename-aware diff → ordered ALTERs), `src/core/ddl/pgIntrospect.ts`
(introspection SQL constants + `rowsToSpec` → TableSpec), `src/core/ddl/sampleData.ts`
(`generateSampleInserts(spec, n)`). **Copy CREATE DDL needs NO new generator** (planner
decision, per reviewer alternative): it reuses `generateCreateTable` over the introspected
TableSpec — proven executable by TASK-006 test #4; a separate `createDdl.ts` would duplicate
that renderer, so it is dropped. §2's "CREATE-DDL generator" line is satisfied by this reuse.
The dialog imports `defaultColumnSpecs` only in create mode; modify mode gets its spec from
introspection. Layout: DataGrip-style left lists (COLUMNS (n) / KEYS (n)) + right form + bottom
preview; OK — Execute primary, Cancel secondary, Escape closes. Editable preview = stretch, out
of scope.

**id rename tracking:** webview owns `idAutoTracking` state — true while the id column name is
exactly `id_<currentTableName>` (the auto-generated value); editing table name renames the
column in lockstep; any manual edit of the id column name turns tracking off. Pure function
`syncIdColumn(spec, previousTableName)` tested at T4.

**Modify-mode rename detection:** UI carries per-column `originalName` (introspected name);
the diff engine pairs `after` columns to `before` columns BY `originalName` when present, so a
rename yields `ALTER TABLE … RENAME COLUMN`, never DROP+ADD. Diff ordering: RENAME first, then
ADD, DROP, type/default/nullability ALTERs, key adds/drops, table RENAME last.

**Introspection:** two SQL constants (columns+defaults, constraints via `pg_get_constraintdef`)
+ a pure mapper from fake-able pg row objects → TableSpec. Handlers run them through
`adapter.runQuery`. Column type/default/nullability edits map to ALTER COLUMN SET DATA TYPE /
SET DEFAULT / DROP DEFAULT / SET NOT NULL / DROP NOT NULL; keys map to ADD/DROP CONSTRAINT.
Table rename → ALTER TABLE … RENAME TO. Keys are compared by (name | kind+columns) identity.
**Column reorder (↑/↓) emits NO ALTER** — pairing is by name/originalName, not position, so a
reorder-only edit yields an empty script (a positional diff would DROP+ADD = data loss).

**Target-schema resolution:** always the tree node's own `node.meta.schema` — schema node →
its own schema; category node → its parent schema; table node → the table's containing
schema. Never search_path, never the active connection's default schema.

**DDL execution:** `ConnectionManager.getAdapterFor(node.meta.connection)` →
`adapter.runQuery(script)` directly (NOT QueryRunner — no cursor/batching/parsing overhead for
DDL; runQuery's non-SELECT path runs it as a single simple query). Constraint names must be
≤63 chars (PK/UNIQUE/FK/CHECK) — name generator truncates. `CREATE TABLE` then constraint
ADDs run as ONE script string (multiple statements, sequential in one call).

**Non-postgres guard (planner decision):** menus declared for `schema` + `category` +
`table` contextValues; when-clauses can't see driver or category kind, so every handler
resolves `node.meta.connection.driver` first: non-postgres → `showInformationMessage("New
Table: PostgreSQL connections only")` (each command uses its own title in that message);
tables-category-only checks (schema node → its Tables category; category node →
`meta.category === "tables"`) → brief Information message + return. Registered but guarded,
per the simpler alternative — one behavior, testable, no hidden menu state.

**Utility commands (host-side, no webview):** Copy CREATE DDL — introspect → generate →
`vscode.env.clipboard.writeText` (same surface as copyQualifiedName). Generate Sample Data —
InputBox N (default 10, cancel = abort) → introspect → generate INSERTs →
`vscode.workspace.openTextDocument({language:"sql", content})` + `showTextDocument` (untitled
editor; the existing generateSelect inserts into the ACTIVE editor when one exists — for
sample data an untitled doc is deliberate: output is a fresh artifact, not an insertion into
user code; recorded here as the planner choice). Analyze/Vacuum — `ANALYZE <schema>.<table>`
/ `VACUUM ANALYZE <schema>.<table>` via `runQuery` + success notification; both are
maintenance statements (no result set).

**Alternatives rejected:** QuickPick-based table creation (no live preview, no column grid);
QuickPick-driven ALTER (same); VS Code native InputBox sequence (7-box UX was already replaced
by ConnectionForm for exactly this reason); MySQL/MSSQL DDL generators this cycle (3× surface
for zero user value now).

## §4 Test Plan

Per-task tables live in each TASK file (same coverage, file-scoped). Cycle-level:

| Type | Test Name | Expected |
|---|---|---|
| happy | generateCreateTable renders mandatory defaults | Exact SQL string (TASK-001 #1/#2) |
| happy | create flow OK → DDL executed + tree refresh + reveal | runQuery called with preview SQL; tree.refresh; reveal(<table node>); info notification |
| happy | modify flow: rename column + add column + drop key | Ordered `RENAME COLUMN`, `ADD COLUMN`, `DROP CONSTRAINT` (TASK-003 #1) |
| happy | modify flow: table rename | `ALTER TABLE … RENAME TO new` last |
| happy | Copy CREATE DDL / Generate Sample Data / Analyze / Vacuum | clipboard content / untitled sql doc / runQuery script exact |
| edge (validation) | empty table name / duplicate column names / unknown FK target column | `specErrors` lists them; OK disabled; DDL never runs |
| edge (boundary) | column name needing quoting (`order`, mixed case) | `"order"` quoted; FK/refs quoted consistently |
| edge (rename detection) | column renamed + type changed in one edit | RENAME then SET DATA TYPE, no DROP+ADD |
| edge (reorder-only) | modify-mode ↑/↓ reorder, nothing else changed | empty ALTER script (name-pairing; no DROP+ADD) |
| edge (wrong input) | Cancel / Escape in dialog | dialog closes, runQuery never called |
| edge (wrong input) | mysql node right-click | "New Table: PostgreSQL connections only", no runQuery |
| edge (boundary) | Sample Data N=0 / N=1000000 | N=0 → 0 inserts (empty doc); N clamped to 1000 |
| edge (rename detection) | column renamed + type changed in one edit | RENAME then SET DATA TYPE, no DROP+ADD |
| integration (VSDB_IT=1) | create table on live PG → introspect round-trip | introspected spec round-trips defaults/nullability/keys |
| integration (VSDB_IT=1) | alter round-trip: create → modify → verify | new column present, renamed column gone-old-present-new, dropped key absent |

Test selection rule (docs/AI_HANDOFF/RULES.md): target file under `src/` → tests from
`.cache/index/tests-map.json`; new files with no entry → the task's own new test files are the
selection (floor satisfied); never the full suite per task. Wave-boundary full `npx vitest run`
is the regression net (run by orchestrator/implement command).

## §5 Verification Commands

All scripts verified in package.json `scripts`: `compile`, `typecheck`, `test`, `test:integration`.
No `lint` script exists in this repo (stated explicitly, not omitted silently).

- T1: `npx vitest run src/core/__tests__/ddlCreateTable.test.ts && npx tsc --noEmit`
- T2: `npx vitest run src/core/__tests__/pgIntrospect.test.ts && npx tsc --noEmit`
- T3: `npx vitest run src/core/__tests__/ddlAlterTable.test.ts && npx tsc --noEmit`
- T4: `npm run compile && npx vitest run src/ui/__tests__/newTableForm.test.ts src/ui/__tests__/newTableFormBundle.test.ts && npx tsc --noEmit`
- T5: `npm run compile && npx vitest run src/extension.test.ts src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/schemaTree.test.ts && npx tsc --noEmit`
- T6: `npm run compile && VSDB_IT=1 VSDB_PG_HOST=127.0.0.1 VSDB_PG_PORT=5433 npx vitest run -c vitest.integration.config.ts src/adapters/__tests__/ddl.integration.test.ts && npx vitest run src/__tests__/releaseHygiene.test.ts && npx tsc --noEmit`

## §6 Acceptance

1. New Table dialog from schema/Tables-category/table nodes (postgres) creates a table with
   mandatory `id_<table>` + `created_at` defaults; preview matched executed SQL. — T1, T4, T5
2. id column name tracks table-name edits until manually overridden. — T4
3. Keys (PK/UNIQUE/FK/CHECK) editable; generated DDL valid PostgreSQL. — T1, T4, T6
4. Modify Table loads live structure, produces ordered rename-aware ALTERs, executes, refreshes. — T2, T3, T4, T5, T6
5. Copy CREATE DDL / Generate Sample Data / Analyze / Vacuum work on table nodes. — T5
6. Non-postgres drivers → "New Table: PostgreSQL connections only"; Views/Routines category →
   polite no-op; Escape/Cancel close without executing. — T4, T5
7. `npm run compile`, `npx tsc --noEmit`, listed vitest runs all PASS; integration green under
   VSDB_IT=1. — all
8. CODE_MAP.md + README.md document the feature. — T6

## §7 Global Constraints (inherited by every TASK file by reference)

- TypeScript strict; VS Code engine ^1.75.0; no new npm dependencies.
- UI strings English; code comments minimal (short Vietnamese header comments acceptable,
  matching existing files).
- Identifier quoting: only when needed (non-lowercase, empty, reserved word, non `[a-z_][a-z0-9_]*`).
- NEVER put `search_path`-dependent names in DDL — always schema-qualify from `node.meta.schema`.
- Executor MUST NOT start/stop docker; PG assumed running at 127.0.0.1:5433 (vsdb/vsdb/vsdb).
- Exact default expressions in TASK-001 are normative; tests assert them verbatim.
- 1 commit per wave; no push from executors.
- No same-wave shared target files (table below is authoritative):

| Wave | Tasks | Disjoint target files |
|---|---|---|
| 1 | T1,T2,T3 | T1: `src/core/ddl/createTable.ts`+test; T2: `src/core/ddl/pgIntrospect.ts`+test; T3: `src/core/ddl/alterTable.ts`+test — disjoint |
| 2 | T4 | `src/ui/newTableForm.ts`, `src/ui/newTableFormMessages.ts`, `webview/newTableFormMain.ts`, `esbuild.js`, `src/ui/__tests__/newTableForm*.test.ts` |
| 3 | T5 | `package.json`, `src/extension.ts`, `src/ui/schemaTree.ts`, `src/core/ddl/sampleData.ts`+test, `src/ui/__tests__/tableCommands.test.ts`, `src/extension.test.ts`, `src/ui/__tests__/schemaTree.test.ts` |
| 4 | T6 | `src/adapters/__tests__/ddl.integration.test.ts`, `CODE_MAP.md`, `README.md` |

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: rebalanced tree wiring into a single TASK-005 (autoSerializeFileConflicts handles package.json/extension.ts/order within one task, so wave 3 stays one reviewer gate); added specErrors + OK-disabled rule to make "preview exact" observable; added N clamp + N=0 edge to sample data; added constraint-name 63-char rule; verified all verification commands against package.json scripts; confirmed `src/core/__tests__/` exists and vitest picks up `src/**/*.test.ts` by default.
Known gaps: (1) live-UI screenshot verification is not automatable in CI — covered instead by bundle test asserting rendered DOM structure + preview text; (2) introspected default expressions are compared after pg-normalization (see TASK-002 #6), so modified-vs-original equality is best-effort for exotic hand-written defaults — acceptable: preview always shows the literal truth; (3) multi-statement CREATE script relies on pg simple-query protocol semantics (verified in T6 integration); if a future adapter splits statements differently the single-script assumption is documented in TASK-001 §Approach note.

## Plan Review Log

### Round 1 — 2026-08-23 · unic/unic-smart (fresh context)
Status: Issues Found

COMPLETENESS:
  - [important] §3 + §7 — `src/core/ddl/createDdl.ts` (`generateCreateDdl`, required by Copy CREATE DDL; §2 lists "CREATE-DDL generator from live introspection" as in-scope) is named in §3 but owned by no wave; the §7 table is declared authoritative. Fix: add `src/core/ddl/createDdl.ts` + `src/core/__tests__/ddlCreateDdl.test.ts` to the Wave 3 / T5 row and append that test file to T5's §5 verification command (alternative: delete `createDdl.ts` from §3 and state Copy CREATE DDL reuses `generateCreateTable` from createTable.ts).

CONSISTENCY:
  - none beyond the createDdl.ts ownership gap above.

CLARITY:
  - [minor] §3 — target-schema resolution per node kind is implicit. Fix: one sentence in §3 (carried into TASK-005): schema node → its own schema, category node → parent schema, table node → containing schema (all via `node.meta.schema`).
  - [minor] §3/§4 — modify-mode column reorder (↑/↓) has no PostgreSQL equivalent; name-pairing is stated but "reorder-only emits no ALTER" is not, and §4 lacks that edge (a positional diff would emit DROP+ADD = data loss). Fix: add the sentence to the alterTable description + a §4 edge row "reorder-only → empty ALTER script".
  - [minor] §4 — no cycle-level Cancel/Escape test although §6.6 asserts it. Fix: add §4 edge row "Cancel/Escape → dialog closes, runQuery never called".

SCOPE:
  - none (one subsystem cluster: DDL core + one dialog + tree wiring; matches user intent).

YAGNI:
  - none (guards, specErrors, N-clamp, 63-char constraint names all serve stated intent).

NOTES: One important fix (file ownership) plus three one-line clarifications; no structural rework. Edge-case floor (≥2) exceeded in §4; lint absence explicitly stated. Reviewer model family == planner model family — this gate is fresh-context isolation per orchestrator instruction.

### Round 2 — 2026-08-23 · unic/unic-smart
Status: Approved

COMPLETENESS:
  - none — Round 1 [important] resolved: createDdl.ts dropped; §3 reuses generateCreateTable over the introspected TableSpec and explicitly reconciles §2's "CREATE-DDL generator" line; no orphan file remains in §3/§7.
CONSISTENCY:
  - none — §7 wave table matches the §3 file set (createTable/alterTable/pgIntrospect/sampleData); §4 edges now back §6.6 (Cancel/Escape, mysql guard).
CLARITY:
  - [minor, non-blocking] §4 — "column renamed + type changed in one edit" edge row appears twice verbatim; drop one.
  - [minor, non-blocking] §3 — syncIdColumn(spec, previousTableName) names no home file; pin it to src/ui/newTableForm.ts (T4) as §3 pins every other artifact.
SCOPE:
  - none
YAGNI:
  - none — dropping createDdl.ts shrinks surface; no new unrequested features.
NOTES: All four Round 1 findings verified resolved in current text (schema-resolution paragraph §3; reorder-emits-no-ALTER §3 + §4 edge row; Cancel/Escape §4 edge row). Minors are cosmetic, no executor action required. Reviewer model == planner model family; fresh-context gate per orchestrator instruction (as Round 1).
PLAN_REVIEW: Approved by unic/unic-smart (Round 2, 2 minor non-blocking notes: §4 duplicate edge row may be dropped; §3 syncIdColumn pinned to src/ui/newTableForm.ts — apply when convenient, not blocking)
