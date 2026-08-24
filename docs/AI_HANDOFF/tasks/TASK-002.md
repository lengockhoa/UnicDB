# TASK-002 — Wire browse gesture: schemaTree node commands + extension + package.json

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3

## Goal

Switch table and view tree nodes to `TreeItem.command = vsdb.browseTableData` (double-click/Enter
gesture; chevron still single-click-expands), register the command in `activate()` via
`registerBrowseCommands`, and declare it in `package.json` (contributes.commands +
activationEvents, additive edit preserving the uncommitted AI-Settings content).

## Target Files

- `src/ui/schemaTree.ts` — tables block (≈L390-408) and views block (≈L411-427) in
  `getCategoryChildren`: `command.command` `"vsdb.copyQualifiedName"` → `"vsdb.browseTableData"`,
  `title` → `"Browse Data"`, `arguments` → `[node]` where node is the object being built (include
  its `meta`; build meta into a local const first so `arguments` can reference it). Routines keep
  `copyQualifiedName`.
- `src/extension.ts` — import `registerBrowseCommands` from `./ui/browseCommands`; call it right
  after `registerTableCommands(...)` with `{ mgr, runner, panel }` (panel/runner are constructed
  later in activate — place the call after `panel` is created, next to the other command
  registrations; push returned disposable if any, or void-return like registerTableCommands).
- `package.json` — `contributes.commands` += `{ "command": "vsdb.browseTableData", "title":
  "VSDB: Browse Table Data", "category": "VSDB" }`; `activationEvents` += `"onCommand:
  vsdb.browseTableData"`. ADDITIVE ONLY — the file carries unrelated uncommitted edits.
- `src/ui/__tests__/schemaTree.test.ts` — update table/view command assertions to the new command
  (this is the RED spec for the behavior change).
- `src/extension.test.ts` — add registration assertion.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression-of-change happy | table node command | `getChildren(category tables)` node: `command.command === "vsdb.browseTableData"`, `command.title === "Browse Data"`, `command.arguments[0].meta.schema/objectName/connection` populated, node still `collapsible: Collapsed` | adapter.listTables returns 1 table |
| 2 | regression-of-change happy | view node command | same assertions for views; routines node still `"vsdb.copyQualifiedName"` | adapter.listViews/listRoutines stubs |
| 3 | edge wiring | extension registration | after `activate(ctx)`: `registeredCommands.has("vsdb.browseTableData")` and invoking it does not throw | extension.test.ts harness |
| 4 | edge manifest | package.json | JSON parses; activationEvents contains `onCommand:vsdb.browseTableData`; contributes.commands contains the entry with category VSDB | read package.json from disk in test |
| 5 | edge boundary | connection nodes untouched | root connection node still `vsdb.selectConnectionFromTree` with `[id]` args | schemaTree harness |

Cases 1–2 are the behavior-change spec: they FAIL against current code (still copyQualifiedName) —
run RED before editing schemaTree.ts.

## Test Files

- `src/ui/__tests__/schemaTree.test.ts` (modify — command assertions; file already mocks adapter
  + vscode; `.cache/index/tests-map.json` maps `src/ui/schemaTree.ts` → this file)
- `src/extension.test.ts` (modify — one new registration test; tests-map maps `src/extension.ts`
  → this file)
- Manifest assertions live in `src/extension.test.ts` (reads package.json via `node:fs`; if a
  dedicated manifest test convention is preferred, keep it in extension.test.ts — no new file).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaTree.test.ts src/extension.test.ts src/ui/__tests__/browseCommands.test.ts && npm run typecheck
```

(browseCommands.test.ts included because the wiring consumes TASK-001's exports; this is the
scoped selection per RULES.md steps 1; no lint script exists — N/A.)

## Acceptance Criteria

- [ ] Cases 1–2 shown RED (failing output pasted) before the schemaTree edit, GREEN after.
- [ ] All scoped vitest files green; `npm run typecheck` clean.
- [ ] package.json diff is purely additive (no removed lines).
- [ ] Routines/connection/category nodes' commands unchanged.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — consumes `registerBrowseCommands`/`vsdb.browseTableData` it produces.

## Interfaces

- Consumes: `registerBrowseCommands(deps: { mgr: ConnectionManager; runner: QueryRunner; panel: ResultsPanel }): void` and command id `vsdb.browseTableData(node?: { meta?: { connection?: ConnectionConfig; schema?: string; objectName?: string } })` from TASK-001 (`src/ui/browseCommands.ts`). `VsdbNode.command?: { command: string; title: string; arguments?: unknown[] }` (src/ui/schemaTree.ts).
- Produces: (none) — end of chain.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Node self-reference note: in `getCategoryChildren` the node object literal is being built inline
inside `tables.map(...)` — construct `meta` first (local const) and pass `arguments: [{ ...node
fields..., meta }]` or build the node in a local variable then attach `command` referencing it;
simplest correct shape: `const n: VsdbNode = { ...fields, meta }; n.command = { command:
"vsdb.browseTableData", title: "Browse Data", arguments: [n] }; return n;`. Passing the whole node
(not just meta) matches how `resolveTableNode` in tableCommands.ts already reads `.meta` from the
raw argument and keeps the argument forward-compatible.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
