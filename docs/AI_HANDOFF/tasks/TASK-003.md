# TASK-003 — Create New Schema: webview form + vsdb.createSchema + reveal

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature B)

## Goal

Right-click a connection (or schema) node → "Create New Schema" opens a NewTableForm-style popup
(Name field up top, live `CREATE SCHEMA "name";` preview below); OK runs the DDL via
`adapter.runQuery`, refreshes the tree, reveals the new schema node, and toasts success.

## Target Files

- `src/ui/schemaForm.ts` **(new)** — host webview wrapper (`SchemaForm`), NewTableForm subset:
  panel id `vsdb.schemaForm`, CSP strict, typed messages, reveal-on-reshow, dispose pattern.
- `webview/schemaFormMain.ts` **(new)** — webview entry: Name `<input id="schemaName">` up top,
  `<pre id="sql-preview">` below, OK/Cancel buttons, Escape → cancel, live preview on input.
- `esbuild.js` — add `schemaFormConfig` block (`entryPoints: ["webview/schemaFormMain.ts"]`,
  `outfile: "dist/schemaForm.js"`, copying the `newTableFormConfig` shape at ~L51) + register it
  in the watch/build context calls. ADDITIVE.
- `src/ui/tableCommands.ts` — register `vsdb.createSchema` inside `registerTableCommands`:
  resolve target conn (node arg `meta.connection` → that conn; else `mgr.getActive()`; none →
  info message), `guardPostgres` shape (`COMMAND_TITLE.createSchema = "Create Schema"`), open
  `SchemaForm` with `listSchemaNames` + `runDdl`, on-OK: `tree.refresh()` →
  `revealSchemaNode(treeView, conn, name)` → info message; on error: `showErrorMessage("Create
  Schema failed: <msg>")`, no refresh (guard contract per file header).
- `src/ui/schemaTree.ts` — add `SchemaTreeProvider.findSchemaNode(conn: ConnectionConfig,
  schema: string): Promise<VsdbNode | null>` (mirror `findTableNode` at ~L639: `getAdapterFor`
  → `adapter.listSchemas(false)` → find by name → return the node shape
  `getSchemaNodesForConnection` emits, `contextValue: "schema"`, meta `{connection, schema}`)
  + module fn `revealSchemaNode(treeView, conn, schema)` next to `revealTableNode` (uses
  `_activeProvider`, swallows reveal throw).
- `package.json` — `contributes.commands` += `vsdb.createSchema` ("VSDB: Create New Schema",
  category VSDB); `activationEvents` += `onCommand:vsdb.createSchema`; `menus.view/item/context`
  += entry when `view == vsdb.schemaTree && (viewItem == connection || viewItem == schema)`.
  ADDITIVE ONLY (file carries unrelated uncommitted edits).
- `src/ui/__tests__/schemaForm.test.ts` **(new)** — host-side form tests (NewTableForm test
  harness pattern).
- `src/ui/__tests__/tableCommands.test.ts` (modify) — command guard/flow tests.
- `src/ui/__tests__/schemaTree.test.ts` (modify) — findSchemaNode/revealSchemaNode tests.
- `src/extension.test.ts` (modify) — registration + manifest assertions.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit happy | live preview | typing `my_schema` posts state whose preview SQL is `CREATE SCHEMA "my_schema";`; empty name → preview `—` + error listed + OK disabled | harness instance, input event |
| 2 | unit happy | OK → runDdl + refresh + reveal + toast | `runDdl('CREATE SCHEMA "x";', "x")` awaited → `tree.refresh` called → `revealSchemaNode` path called → info message `VSDB: schema "x" created` | valid name |
| 3 | edge (invalid identifier) | `9bad`, `a-b`, `""`, 64-char | each lists an error, OK stays disabled, `runDdl` NOT called | per-fixture typing |
| 4 | edge (duplicate) | `listSchemaNames()` already contains `Users` (case-insensitive vs `users`) | error `Schema "users" already exists`, OK disabled | preloaded names |
| 5 | edge (driver guard) | node `meta.connection.driver === "mysql"` (and mssql) | info `Create Schema: PostgreSQL connections only`; form never constructed | connection-node arg |
| 6 | edge (no connection) | palette invocation, `mgr.getActive()` → null | info message; no form | empty active |
| 7 | edge (error path) | `runDdl` rejects (`permission denied`) | `showErrorMessage` `Create Schema failed: permission denied`; no `tree.refresh`/reveal | rejecting adapter |
| 8 | unit | `findSchemaNode` | adapter.listSchemas → node `{label, contextValue:"schema", meta:{connection, schema}}`; adapter throw or miss → null | mock provider |
| 9 | wiring | registration + menu + bundle | `registeredCommands.has("vsdb.createSchema")` after activate; package.json menu when-clause + activationEvent present; `npm run compile` emits `dist/schemaForm.js` | extension.test.ts harness + fs read of package.json |

## Test Files

- `src/ui/__tests__/schemaForm.test.ts` **(new)** — cases 1-4, 7 (form level).
- `src/ui/__tests__/tableCommands.test.ts` (modify) — cases 5-6 (+ case 2 wiring through
  registerTableCommands; tests-map selection for `src/ui/tableCommands.ts`).
- `src/ui/__tests__/schemaTree.test.ts` (modify) — case 8 (tests-map selection for
  `src/ui/schemaTree.ts`).
- `src/extension.test.ts` (modify) — case 9 (tests-map selection for `src/extension.ts`).

## Verification Commands

```bash
npm run compile && npx vitest run src/ui/__tests__/schemaForm.test.ts src/ui/__tests__/tableCommands.test.ts src/extension.test.ts src/ui/__tests__/schemaTree.test.ts && npm run typecheck
```

(`npm run compile` required: task ships the new webview entry + esbuild config. tests-map
selection per RULES.md step 1 for the modified source files; new file → its own test. No lint
script exists — N/A.)

## Acceptance Criteria

- [ ] RED first: new tests fail against missing form/command (real failing output pasted).
- [ ] All 9 cases PASS; scoped vitest files green; `npm run typecheck` clean.
- [ ] `dist/schemaForm.js` builds; esbuild.js/package.json diffs purely additive.
- [ ] Escape closes form without DDL; reveal no-ops safely when the node is not found.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — it owns `src/ui/schemaTree.ts`, `src/extension.ts`, `package.json`,
  `src/ui/__tests__/schemaTree.test.ts`, `src/extension.test.ts` in wave 2; this task edits all
  five afterward (wave 3).

## Interfaces

- Consumes: `SchemaTreeProvider` + `_activeProvider`/`revealTableNode` pattern
  (`src/ui/schemaTree.ts`), `registerTableCommands(deps: { mgr; tree; treeView; context })`
  (`src/ui/tableCommands.ts` — add the command inside it, same deps), `ConnectionManager`
  (`getActive`, `getAdapterFor`), `DbAdapter.listSchemas(includeSystem: boolean): Promise<
  SchemaInfo[]>` / `runQuery(sql: string)`, `alwaysQuote(name: string): string`
  (`src/core/ddl/alterTable.ts`).
- Produces: `SchemaForm` class in `src/ui/schemaForm.ts` — `constructor(options: {
  extensionUri: vscode.Uri; listSchemaNames: () => Promise<string[]>; runDdl: (sql: string,
  name: string) => Promise<void> })`, methods `show(): void` / `dispose(): void`; command id
  `vsdb.createSchema` invoked as `(node?: { meta?: { connection?: ConnectionConfig; schema?:
  string } })`; `SchemaTreeProvider.findSchemaNode(conn, schema): Promise<VsdbNode | null>` and
  `revealSchemaNode(treeView: vscode.TreeView<unknown>, conn: ConnectionConfig, schema:
  string): Promise<void>` exported from `src/ui/schemaTree.ts`.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
InputBox was rejected: the user's reference is the styled designer form with live SQL preview —
an InputBox cannot render `CREATE SCHEMA <name>;` preview. Validation lives HOST-side in
postPreview (name regex `/^[A-Za-z_][A-Za-z0-9_$]*$/` + length ≤ 63 + duplicate check),
OK-gating mirrors NewTableForm. The webview bundle is self-contained (redeclare interfaces
locally; do not import src/ into webview/). Message unions stay inline in
`src/ui/schemaForm.ts` — only two messages each way.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
