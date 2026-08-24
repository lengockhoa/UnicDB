# TASK-008 — Postman Payload: copy JS object literal for table/view/routine

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature G)

## Goal

Right-click a table/view/routine node → "Postman Payload" → clipboard receives a JS object
literal `{ schema, table: <name>, <col>: this.workingObj.<col>, … }` (key stays `table` for all
three kinds), built from DB introspection, always syntactically valid JS.

## Target Files

- `src/ui/postmanPayload.ts` **(new)** — pure `buildPostmanPayload(schema, name, columns):
  string` + `jsKey(name): string` helper (plain identifier → bare; else double-quoted;
  reference becomes `this.workingObj["<key>"]`).
- `src/ui/tableCommands.ts` (modify) — register `vsdb.postmanPayload` inside
  `registerTableCommands` (`COMMAND_TITLE.postmanPayload = "Postman Payload"`): resolve node
  (accept `viewItem` table|view|routine via meta.category/objectName — routines carry no
  `category`, table nodes carry `category: "columns"`), guard postgres, fetch columns: table/
  view → `adapter.listColumns(name, schema)`; routine → new `adapter.listRoutineParams(schema,
  name)`; clipboard write + status-bar confirmation (copyQualifiedName pattern).
- `src/adapters/types.ts` (modify) — add to `DbAdapter`: `listRoutineParams(schema: string,
  routine: string): Promise<Array<{ name: string | null; dataType: string }>>` (name null for
  unnamed args; empty array for no-arg routines).
- `src/adapters/postgres.ts` (modify) — implement via parameterized pg_catalog query
  (`proargnames`/`proallargtypes` join `pg_type`, same $1/$2 bind pattern as `listColumns`
  L256); mysql.ts/mssql.ts need no edit — the interface addition is satisfied by their existing
  `NotImplementedError` fallback only if they implement the contract via a shared base; if they
  declare the interface directly, add the throwing stub there too (check; keep stub 3 lines).
- `package.json` (modify) — `contributes.commands` += `vsdb.postmanPayload` ("VSDB: Postman
  Payload", category VSDB, icon `$(copy)`); `activationEvents` += entry; `menus.view/item/
  context` += entry when `view == vsdb.schemaTree && (viewItem == table || viewItem == view ||
  viewItem == routine)`. ADDITIVE.
- `src/ui/__tests__/postmanPayload.test.ts` **(new)** — pure builder tests.
- `src/ui/__tests__/tableCommands.test.ts` (modify) — command tests.
- `src/adapters/__tests__/postgres.test.ts` (modify) — `listRoutineParams` query test.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit happy | table payload | exact literal: `{\n  schema: "public",\n  table: "users",\n  id: this.workingObj.id,\n  name: this.workingObj.name,\n}` (2-space indent, trailing comma) | 2 columns |
| 2 | happy | view payload | same shape; columns from `listColumns` mock (views introspect via information_schema); key stays `table` | view node, mock returns cols |
| 3 | happy | routine payload | columns from `listRoutineParams` mock (pg proargnames) | routine node, mock returns params |
| 4 | edge (boundary) | 0 columns | payload `{ schema, table }` only — still written to clipboard, no error | empty column list |
| 5 | edge (malformed identifiers) | `weird-col`, `1abc`, `default` | keys double-quoted (`"weird-col":`), references `this.workingObj["weird-col"]` — emitted JS parses (assert via `new Function` or regex) | weird names |
| 6 | edge (driver guard) | mysql/mssql node | info "Postman Payload: PostgreSQL connections only"; no clipboard write | non-pg conn |
| 7 | edge (routine no args) | `listRoutineParams` → [] | payload `{ schema, table }`; no crash | empty params |
| 8 | unit | `jsKey` | `id`→`id`; `weird-col`→`"weird-col"`; `class`→`"class"` (JS reserved); `1abc`→`"1abc"` | direct calls |
| 9 | wiring | menu + registration | context-menu entry on table/view/viewItem routine; `registeredCommands.has("vsdb.postmanPayload")` | extension.test harness or tableCommands harness + package.json fs read |

## Test Files

- `src/ui/__tests__/postmanPayload.test.ts` **(new)** — cases 1, 4, 5, 8.
- `src/ui/__tests__/tableCommands.test.ts` (modify — tests-map selection for
  `src/ui/tableCommands.ts`) — cases 2, 3, 6, 7, 9.
- `src/adapters/__tests__/postgres.test.ts` (modify — tests-map selection for
  `src/adapters/postgres.ts`) — `listRoutineParams` returns mapped param rows; parameterized
  bind asserted.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/postmanPayload.test.ts src/ui/__tests__/tableCommands.test.ts src/adapters/__tests__/postgres.test.ts && npm run typecheck
```

(tests-map step 1 selections; new file → its own test. No lint script exists — N/A.)

## Acceptance Criteria

- [ ] RED first: tests fail against missing builder/command (real failing output pasted).
- [ ] All 9 cases PASS; `npm run typecheck` clean (including the adapter interface addition).
- [ ] Emitted payload is parseable JS in every case (case 5 asserts it).
- [ ] package.json diff purely additive; adapters change is additive + NotImplementedError stubs.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-006 — both edit `src/ui/tableCommands.ts` + `src/ui/__tests__/tableCommands.test.ts`;
  TASK-006 owns them first (wave 4).
- TASK-009 — both edit `package.json` (post-002); TASK-009 owns it first (wave 4). This task
  follows in wave 5.

## Interfaces

- Consumes: `resolveTableNode`-style node meta (`{ connection, schema, objectName, category? }`),
  `guardPostgres` pattern + `COMMAND_TITLE` map (src/ui/tableCommands.ts),
  `DbAdapter.listColumns(table: string, schema?: string): Promise<ColumnInfo[]>`
  (src/adapters/types.ts L97 — works for views), `vscode.env.clipboard.writeText`,
  `vscode.window.setStatusBarMessage`.
- Produces: `buildPostmanPayload(schema: string, name: string, columns: string[]): string` and
  `jsKey(name: string): string` exported from `src/ui/postmanPayload.ts`; adapter contract
  addition `listRoutineParams(schema: string, routine: string): Promise<Array<{ name: string |
  null; dataType: string }>>` on `DbAdapter` (src/adapters/types.ts) implemented in
  PostgresAdapter; command id `vsdb.postmanPayload(node?: { meta?: … })`.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Column-source decision (documented per plan §3-G): tables AND views both use `listColumns` —
the postgres implementation reads information_schema/pg_catalog keyed by (schema, table), which
covers view output columns; there is no separate view-introspection method on the adapter and
adding one would duplicate listColumns. Routines get the NEW `listRoutineParams` (pg_catalog
`proargnames`/`proallargtypes`) because RoutineInfo (types.ts L40) carries only name/kind/
schema. Payload always uses key `table` (user requirement) regardless of node kind.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
