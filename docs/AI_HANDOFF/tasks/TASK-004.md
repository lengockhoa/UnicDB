# TASK-004 — Table designer webview + host (create + modify)

- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §3,§7

## Goal
DataGrip-style designer dialog: webview (left COLUMNS (n)/KEYS (n) lists with +,−,↑,↓; right edit form; bottom live SQL Preview; Cancel / OK — Execute) + host class, in create AND modify modes. Preview computed HOST-side via TASK-001/003 pure fns; OK executes the last previewed SQL via callback (extension wiring is TASK-005).

## Target Files
- `src/ui/newTableFormMessages.ts` (new) · `src/ui/newTableForm.ts` (new) · `webview/newTableFormMain.ts` (new) · `esbuild.js` (modify: add entry `["webview/newTableFormMain.ts"]` → `dist/newTableForm.js`, copy connectionFormConfig block options) · `src/ui/__tests__/newTableForm.test.ts` (new) · `src/ui/__tests__/newTableFormBundle.test.ts` (new)

## Spec
**Messages** (`newTableFormMessages.ts`, mirror connectionFormMessages.ts): `NewTableFormInit {type:"init"; mode:"create"|"modify"; schema; originalTableName?; spec: TableSpec; loadError?}` · `NewTableFormReady` · `NewTableFormSpecChanged {type:"specChanged"; spec; tableChanged?}` · `NewTableFormCancel` · `NewTableFormSubmit {type:"submit"; spec}` (webview union = those 4); host: `NewTableFormPreview {type:"preview"; sql; errors}`.
**Host** (`newTableForm.ts`): `NewTableFormOptions {extensionUri; mode; schema; originalTableName?; loadSpec(): Promise<TableSpec>; runDdl(sql): Promise<void>}` · `class NewTableForm { constructor(options); show(): void; dispose(): void }`.
- Panel `"vsdb.newTableForm"`, title `New Table` | `Modify — ${schema}.${table}`, CSP + script `dist/newTableForm.js` (mirror ConnectionForm.buildHtml 176-203), reveal on re-show (37-39), dispose pattern (69-74).
- `ready` → modify: `await loadSpec()` (catch → init with `loadError` + empty spec); create: init `{name:"table_name",schema,columns:defaultColumnSpecs("table_name"),keys:[]}`.
- `specChanged` → SYNCHRONOUS preview (pure fns only): create → `specErrors` + `generateCreateTable` (skip generator when errors → sql ""); modify → `diffTable` vs loaded original (sql = statements.join("\n")). Post `{type:"preview",sql,errors}`; keep `lastPreviewSql` — `submit` runs `runDdl(lastPreviewSql)`; success → dispose; reject → do NOT dispose, post preview `{sql:"", errors:[err.message]}` (dialog stays open).
- `cancel` → dispose. Escape (webview keydown) → cancel message.
**Webview** (`webview/newTableFormMain.ts`, vanilla DOM like connectionFormMain.ts):
- Left: sections `COLUMNS (n)` / `KEYS (n)` (live counts), items name(+type), toolbar +,−,↑,↓. Right: selected-item form — Column: Name, Type, Default, Nullable, Primary Key; Key: kind select (PRIMARY KEY/UNIQUE/FOREIGN KEY/CHECK), name, columns (comma text), FK table + ref columns, CHECK expr; none selected → "Select a column or key from the left panel to edit."
- Top: table name input + read-only schema label. Bottom: `<pre id="sql-preview">` + errors list; Cancel + `OK — Execute` (disabled when errors>0, or modify with empty sql).
- Every spec mutation posts `specChanged`; `preview` message fills `<pre>` + errors + OK state.
- Defaults & id tracking: create starts from `defaultColumnSpecs` (user may edit/delete like any row). Webview-local `syncIdColumn(spec, previousTableName): {spec; tracking}` — while first column name === `id_${previousTableName}`, table-name edits rename it to `id_${newName}`; a manual id-column rename (≠ auto value) stops tracking forever.
- Modify: loaded columns keep `originalName` through edits; new columns have none.

## Test Cases (REQUIRED — TDD)
Host tests (`newTableForm.test.ts` — mock vscode, capture panel + onDidReceiveMessage; pattern connectionForm.test.ts):
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | create init + preview exact | `ready` → init `{mode:"create",schema:"public",spec:{name:"table_name",…columns [id_table_name, created_at]}}`; `specChanged` name `users` → preview.sql === TASK-001 #1 exact string, errors [] |
| 2 | unit | modify loadSpec + diff preview | loadSpec resolves fixture; specChanged with renamed col → preview.sql === diffTable stmts joined `\n` |
| 3 | unit | submit → runDdl(lastPreviewSql) + dispose | runDdl called ONCE with previewed sql; panel disposed |
| 4 | edge (failure) | runDdl rejects → stays open | not disposed; posted errors contain "relation exists" |
| 5 | edge (validation) | invalid spec | specChanged dup cols → errors len 2, sql ""; submit → runDdl NOT called |
| 6 | edge (wrong input) | cancel | disposed, runDdl 0 calls |
| 7 | edge (failure) | loadSpec rejects | init carries loadError message; empty spec; later specChanged still answers |
Bundle tests (`newTableFormBundle.test.ts`, jsdom, AFTER `npm run compile`; pattern webviewBundle.test.ts):
| 8 | unit | DOM zones + counts | init(create) → `COLUMNS (2)`, `KEYS (0)`, placeholder, `<pre id="sql-preview">`, OK enabled |
| 9 | unit | live preview + id tracking | table name → `orders` → posted spec.columns[0].name === "id_orders"; preview `<pre>` contains `CREATE TABLE "public"."orders"` |
| 10 | edge (validation) | OK disabled on error | duplicate column names → OK disabled, errors visible |
| 11 | edge (wrong input) | Escape → cancel | keydown Escape → posted `{type:"cancel"}` |
| 12 | edge (boundary) | tracking breaks | id col manually renamed `pk`, then table → `x` → col stays `pk` |

## Test Files
- `src/ui/__tests__/newTableForm.test.ts` · `src/ui/__tests__/newTableFormBundle.test.ts`

## Verification Commands
```bash
npm run compile && npx vitest run src/ui/__tests__/newTableForm.test.ts src/ui/__tests__/newTableFormBundle.test.ts && npx tsc --noEmit
```
(compile FIRST — bundle test loads dist/newTableForm.js. No lint script in this repo.)

## Acceptance Criteria
- [ ] All §Test Cases PASS (bundle after compile). `dist/newTableForm.js` emitted.
- [ ] Host preview uses ONLY TASK-001/003 fns (no local SQL building). CSP mirrors ConnectionForm.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (`generateCreateTable`,`specErrors`,`defaultColumnSpecs`,`TableSpec`) · TASK-002 (`rowsToSpec` via loadSpec contract) · TASK-003 (`diffTable`)

## Interfaces
- Consumes: TASK-001 fns; `diffTable`; TableSpec from rowsToSpec.
- Produces: `class NewTableForm` (`constructor(options: NewTableFormOptions)`, `show()`, `dispose()`), `NewTableFormOptions`, message types — TASK-005 constructs both modes.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
`lastPreviewSql` is the single source passed to runDdl — OK executes EXACTLY what preview showed.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
