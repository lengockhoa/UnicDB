# TASK-005 — Extension wiring: menus, commands, utilities, refresh + reveal

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
Wire the designer into the extension: package.json contributes (6 commands + menus), extension.ts registrations with driver/category guards, DDL execution + tree refresh + reveal + notifications, and the 4 utility commands (Copy CREATE DDL, Generate Sample Data, Analyze, Vacuum) + sample-INSERT generator.

## Target Files
- `package.json` (modify) · `src/extension.ts` (modify) · `src/ui/schemaTree.ts` (modify: add `findTableNode` + `revealTableNode` near qualifiedName) · `src/core/ddl/sampleData.ts` (new) · `src/core/__tests__/sampleData.test.ts` (new) · `src/ui/__tests__/tableCommands.test.ts` (new) · `src/extension.test.ts` (modify) · `src/ui/__tests__/schemaTree.test.ts` (modify)

## Spec
**package.json** — activationEvents onCommand for each; commands (category VSDB): `vsdb.newTable` "New Table…", `vsdb.modifyTable` "Modify Table…", `vsdb.copyCreateDdl` "Copy CREATE DDL", `vsdb.generateSampleData` "Generate Sample Data…", `vsdb.analyzeTable` "Analyze Table", `vsdb.vacuumTable` "Vacuum Table". `menus["view/item/context"]` (group "vsdb"): newTable when `view == vsdb.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)`; other 5 when `view == vsdb.schemaTree && viewItem == table`.
**extension.ts** — register 6 commands (comments 15..20). `resolveTableNode(arg) → {conn, schema, table} | null` (dual-dispatch `(arg as any).meta`, pattern extension.ts:155-172): table node → meta.connection+schema+objectName; category node → require `meta.category === "tables"`, table ""; schema node → schema, table "". Target schema is ALWAYS the node's own `node.meta.schema` (schema node → its own schema; category node → parent; table node → containing) — never search_path, never active connection default. Guards BEFORE any dialog/adapter work: no meta → silent return; driver !== "postgres" → `showInformationMessage("<Title>: PostgreSQL connections only")` (per-command title); non-tables category → `showInformationMessage("New Table: open the Tables category or a table node")` + return.
- **vsdb.newTable** — `new NewTableForm({mode:"create", schema, loadSpec: async () => ({name:"table_name",schema,columns:defaultColumnSpecs("table_name"),keys:[]}), runDdl})`; runDdl: `await mgr.getAdapterFor(conn)` → `adapter.runQuery(sql)` (never QueryRunner); success → `tree.refresh()` + `revealTableNode(treeView, conn, schema, spec.name)` + `showInformationMessage("Created ${schema}.${name}")`; error → `showErrorMessage("New Table failed: " + msg)` (dialog stays open — TASK-004).
- **vsdb.modifyTable** — table nodes only; loadSpec runs both INTROSPECT SQLs via adapter.runQuery → `rowsToSpec`; runDdl executes diff statements joined `\n` → refresh + reveal + "Modified ${schema}.${table}".
- **revealTableNode** (`schemaTree.ts`): `revealTableNode(treeView, conn, schema, table): Promise<void>` + `SchemaTreeProvider.findTableNode(conn, schema, table): Promise<VsdbNode | null>` (reuse caches/getCategoryChildren path; null when absent) → `treeView.reveal(node, {select:true, expand:false})` catch-ignore.
- **vsdb.copyCreateDdl** — introspect → `generateCreateTable(spec)` → `vscode.env.clipboard.writeText` + status bar `VSDB: DDL copied` 2s (pattern 628-631).
- **vsdb.generateSampleData** — `showInputBox({prompt:"Number of rows", value:"10"})`; undefined → abort; NaN/negative → Information "Enter a positive number"; clamp `max(0,min(1000,n))`; introspect → `generateSampleInserts` → `openTextDocument({language:"sql", content})` + `showTextDocument`.
- **vsdb.analyzeTable / vacuumTable** — `runQuery('ANALYZE ' + qualified)` / `runQuery('VACUUM ANALYZE ' + qualified)`, qualified = `quoteIdent(schema)+"."+quoteIdent(table)`; success → "<schema>.<table> analyzed"/"vacuumed".
**src/core/ddl/sampleData.ts** (pure): `generateSampleInserts(spec, n): string` — n≤0 → ""; `INSERT INTO "schema"."table" ("a","b") VALUES\n (...),\n (...);\n` (one statement, multi-row VALUES, 4-space indent). Values by lowercased type prefix: int/serial/bigint/smallint → per-column counter 1..n; numeric/decimal/money → `(i+1).5`; float/double/real → `(i+1).25`; varchar/char/text → `'row-<i+1> c<j>'` (j = column index); boolean → alternating true/false; date → `'2026-01-<dd>'` (dd=(i%28)+1 zero-pad 2); timestamp(tz) → `'2026-01-<dd> 10:00:00'`; uuid → `'00000000-0000-0000-4000-0000000000<zero-pad(i+1,3)>'`; json(b) → `'{}'`; default → `'v<j>-<i>'`. Column order = spec order; keys ignored; i from 0.

## Test Cases (REQUIRED — TDD)
`sampleData.test.ts` (pure):
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | multi-row INSERT | cols (id integer, name varchar) n=3 → `INSERT INTO "public"."t" ("id","name") VALUES\n (1, 'row-1 c1'),\n (2, 'row-2 c1'),\n (3, 'row-3 c1');\n` |
| 2 | unit | type variety | (flag boolean, amt numeric, d date, u uuid) n=2 → row1 `(true, 1.5, '2026-01-01', '00000000-0000-0000-4000-0000000000001')`, row2 `(false, 2.5, '2026-01-02', '…002')` |
| 3 | edge (boundary) | n=0/-5 | → `""` |
| 4 | edge (boundary) | large n | n=1000 no throw; 1000 value rows |
`tableCommands.test.ts` (mock vscode + fake adapter; prefer exported `registerTableCommands(deps)` called by activate):
| 5 | unit | newTable happy | schema node → NewTableForm mode create; runDdl(CREATE…) → adapter.runQuery same SQL; tree.refresh + revealTableNode(conn,schema,name) + "Created public.users" |
| 6 | unit | modifyTable happy | table node → mode modify; loadSpec = 2 runQuery introspections → rowsToSpec fixture; runDdl diff joined → refresh+reveal+"Modified public.t" |
| 7 | edge (wrong input) | mysql guard | driver "mysql" → "Modify Table: PostgreSQL connections only"; 0 runQuery; no panel |
| 8 | edge (wrong input) | Views category no-op | meta.category "views" → Information mentioning Tables; no NewTableForm |
| 9 | unit | copyCreateDdl | clipboard.writeText === generateCreateTable(rowsToSpec(fixture)); status message set |
| 10 | unit | generateSampleData doc | InputBox "3" → openTextDocument {language:"sql", content: 3-row INSERT}; showTextDocument called |
| 11 | edge (validation) | InputBox bad | "abc" → Information "Enter a positive number", no doc; undefined → nothing |
| 12 | unit | analyze/vacuum SQL | runQuery `ANALYZE "public"."t"` / `VACUUM ANALYZE "public"."t"`; notifications |
| 13 | edge (failure) | DDL failure | runQuery rejects → showErrorMessage "New Table failed: <msg>"; tree.refresh NOT called |
`extension.test.ts` (existing smoke describe): 6 commands in registeredCommands; package.json activationEvents contain the 6 entries. `schemaTree.test.ts` (add describe): findTableNode returns table node from fake adapter listing (contextValue "table", meta.objectName); null when absent; revealTableNode calls treeView.reveal({select:true, expand:false}).

## Test Files
- `src/core/__tests__/sampleData.test.ts` · `src/ui/__tests__/tableCommands.test.ts` · `src/extension.test.ts` (modify) · `src/ui/__tests__/schemaTree.test.ts` (modify)

## Verification Commands
```bash
npm run compile && npx vitest run src/extension.test.ts src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/schemaTree.test.ts src/core/__tests__/sampleData.test.ts && npx tsc --noEmit
```
(Test selection: extension.ts → tests-map `src/extension.test.ts`; schemaTree.ts → `src/ui/__tests__/schemaTree.test.ts`; new files → own tests. No lint script.)

## Acceptance Criteria
- [ ] All §Test Cases PASS. package.json valid; 6 commands+menus+activationEvents.
- [ ] Guards precede dialog/adapter work. DDL via `mgr.getAdapterFor(conn).runQuery`.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 · TASK-002 · TASK-004 (TASK-003 via host, not direct)

## Interfaces
- Consumes: `NewTableForm`+`NewTableFormOptions` (T4); `generateCreateTable`, `defaultColumnSpecs`, `quoteIdent` (T1); INTROSPECT SQLs + `rowsToSpec` (T2).
- Produces: `generateSampleInserts(spec,n):string`; `revealTableNode(treeView,conn,schema,table):Promise<void>` + `SchemaTreeProvider.findTableNode(conn,schema,table):Promise<VsdbNode|null>`; commands `vsdb.newTable|modifyTable|copyCreateDdl|generateSampleData|analyzeTable|vacuumTable`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
If testing via full `activate()` gets heavy, export `registerTableCommands(deps)` from extension.ts; activate() calls it; tableCommands.test.ts drives it with fakes. activate() wiring stays covered by the existing smoke describe.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T005
SUMMARY: Implemented TASK-005 extension wiring — 6 commands (newTable/modifyTable/copyCreateDdl/generateSampleData/analyzeTable/vacuumTable) + menus + activationEvents in package.json; src/ui/tableCommands.ts (registerTableCommands) wired into extension.ts activate(); SchemaTreeProvider extended with findTableNode + module-scoped revealTableNode; src/core/ddl/sampleData.ts pure generator (16 unit tests passing).
TEST_PLAN_FOLLOWED: task §4 (Test Cases #1-13) — written first (RED: module-not-found), then GREEN after impl.
FILES_CHANGED:
  - package.json: +6 commands, +6 activationEvents, +6 view/item/context menus
  - src/extension.ts: import registerSchemaTreeProvider + registerTableCommands; wire after tree creation
  - src/ui/schemaTree.ts: +SchemaTreeProvider.findTableNode; +module-scoped registerSchemaTreeProvider/clearSchemaTreeProvider; +revealTableNode
  - src/ui/tableCommands.ts: NEW — registerTableCommands(deps) with 6 command handlers, guards (postgres-only, category check, no-meta silent), introspectTable helper, alwaysQuote for analyze/vacuum
  - src/core/ddl/sampleData.ts: NEW — generateSampleInserts(spec, n) pure generator (type-aware: int/numeric/float/varchar/boolean/date/timestamp/uuid/jsonb/default)
  - src/core/__tests__/sampleData.test.ts: NEW — 16 unit tests
  - src/ui/__tests__/tableCommands.test.ts: NEW — 9 unit tests (#5,#6,#7,#8,#9,#10,#11,#12,#13)
  - src/ui/__tests__/schemaTree.test.ts: +5 tests in TASK-005 describe block (findTableNode x2, revealTableNode x3)
  - src/extension.test.ts: +TASK-005 describe block (6 commands, 6 activationEvents)

TESTS_ADDED:
  - src/core/__tests__/sampleData.test.ts: 16 tests (multi-row INSERT, type variety, n=0/-5/1000, per-type dispatch, column-order)
  - src/ui/__tests__/tableCommands.test.ts: 9 tests (newTable/modifyTable happy, mysql guard, views category guard, DDL failure, copyCreateDdl, generateSampleData InputBox 3/abc, analyze+vacuum SQL)
  - src/ui/__tests__/schemaTree.test.ts: 5 tests (findTableNode hit/miss, revealTableNode reveal/throw/absent)
  - src/extension.test.ts: 3 tests (17 commands, 6 new commands, 6 activationEvents)

VERIFICATION:
  command: npm run compile && npx vitest run src/extension.test.ts src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/schemaTree.test.ts src/core/__tests__/sampleData.test.ts && npx tsc --noEmit
  result: 91 passed / 0 fail; exit code 0
  output_excerpt: |
    ⚡ Done in 119ms
    esbuild: build complete
    ✓ src/core/__tests__/sampleData.test.ts  (16 tests) 4ms
    ✓ src/ui/__tests__/schemaTree.test.ts  (39 tests) 26ms
    ✓ src/ui/__tests__/tableCommands.test.ts  (9 tests) 5ms
    ✓ src/extension.test.ts  (27 tests) 61ms
    Test Files  4 passed (4)
         Tests  91 passed (91)
    tsc --noEmit: clean (no output)

RED_OUTPUT (excerpt):
    FAIL  src/core/__tests__/sampleData.test.ts
      Error: Failed to load url ../ddl/sampleData
    FAIL  src/ui/__tests__/tableCommands.test.ts
      Error: Failed to load url ../../core/ddl/sampleData (registered through tableCommands)
    FAIL  src/ui/__tests__/schemaTree.test.ts > TASK-005 findTableNode + revealTableNode
      TypeError: revealTableNode is not a function / findTableNode is not a function
    FAIL  src/extension.test.ts > TASK-005 — extension wiring smoke
      AssertionError: expected false to be true (commands/activationEvents missing)

ISSUES: None
HANDOFF_TO_REVIEWER: yes — fresh 91/91 PASS in this turn
NEXT: ready for review (file-based handoff per cycle conventions)

## Reviewer Verdict

VERDICT: CRITICAL
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/extension.test.ts src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/schemaTree.test.ts src/core/__tests__/sampleData.test.ts && npx tsc --noEmit
  result: 91 pass / 0 fail; compile + tsc clean (exit 0)
TEST_PLAN_COVERAGE: all-followed (13/13 test cases present; RED_OUTPUT has real failing output)
FINDINGS:
  critical:
    - file: src/ui/tableCommands.ts:145-147 — introspectTable sends $1/$2-placeholder SQL through runQuery(sql), which binds no params. Verified against live PG (127.0.0.1:5433): `there is no parameter $1`. Also this SQL is a single ";"-free SELECT, so PostgresAdapter.runQuery (src/adapters/postgres.ts:157-161) routes it to the batched-cursor path returning `{results: [], batched}` — `results[0]?.rows` is [] even if params were bound. modifyTable, copyCreateDdl, generateSampleData all fail in production. DbAdapter has no public param path (query() private, postgres.ts:333). Fix: add a parameterized introspect path (e.g. adapter method taking params, or bind schema/table via pool.query like TASK-006's test does at ddl.integration.test.ts:102-107) and make the fake adapter's runQuery honor the real RunResult contract.
  important:
    - file: src/ui/schemaTree.ts:704 — revealTableNode calls treeView.reveal but SchemaTreeProvider implements no getParent(); vscode d.ts: "This method should be implemented in order to access TreeView.reveal API" — reveal throws and is silently swallowed by the catch, so refresh+reveal never reveals in the real extension. Fix: implement getParent() on SchemaTreeProvider (connection→null, schema→connection, category→schema, table→category, column→table).
    - file: src/ui/tableCommands.ts:180 — newTable menu is offered on viewItem == table (package.json when-clause) but table nodes carry meta.category === "columns" (schemaTree.ts:398), so the guard rejects them with the misleading "open the Tables category" message. Fix: accept category "columns" (table node) in addition to "tables".
    - file: src/ui/tableCommands.ts:203-215 — copyCreateDdl: rowsToSpec sets BOTH column.isPrimaryKey and a primaryKey KeySpec; generateCreateTable renders both → `multiple primary keys for table ... are not allowed` on re-execution (verified live on PG; TASK-006 test works around the same issue at ddl.integration.test.ts:446-449). Fix: strip inline isPrimaryKey when a primaryKey KeySpec exists before generateCreateTable.
  minor:
    - file: src/ui/tableCommands.ts:204,206,208,212,217,253,255,257 — leftover DEBUG console.log statements in production runDdl paths; remove.
    - file: src/ui/tableCommands.ts:209 — created-table name recovered by regexing the SQL string; pass spec.name through runDdl instead (form already knows it).
NEXT_STATUS_FOR_INDEX: critical_block
NOTES: Unit suite (91/91) passes but the fake adapter masks two production-only failures (unbound $1/$2 + cursor-path result shape); recommend one live-PG smoke of modifyTable/copyCreateDdl after fix. Guard order, schema-via-node.meta, quoting/injection safety (alwaysQuote, generated literals), menus/activationEvents/IDs all verified correct.
