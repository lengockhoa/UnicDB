# TASK-004 — vsdb.exportAllStructures: copy the whole-DB DDL to the clipboard

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D4/§1 outcome-3, §4 T4

## Goal

Command `vsdb.exportAllStructures` (context menu on connection/schema node + command palette): introspect the whole DB (user schemas, tables, views) → `buildDatabaseStructure` → clipboard. This is the UI surface of "Export Structure to reference the whole context" — the user copies the whole-DB DDL to share with any external AI / workflow.

## Target Files

- `src/ui/tableCommands.ts` — add the `vsdb.exportAllStructures` command registration (same pattern as `vsdb.exportStructure` lines 540-581 + guardPostgres).
- `package.json` — contributed command + menus (schema tree view/context, palette).
- `src/extension.test.ts` — assert the command is registered (using the existing smoke-test pattern).
- `src/ui/__tests__/tableCommands.test.ts` — append describe "vsdb.exportAllStructures" (#1, #2, #3).

## Spec

```ts
// src/ui/tableCommands.ts — ADD (after the vsdb.exportStructure block, before the closing `}` of registerTableCommands):
context.subscriptions.push(
  vscode.commands.registerCommand(
    "vsdb.exportAllStructures",
    async (arg?: unknown) => {
      // Node: a connection or a schema node (resolveConnectionNode pattern is
      // already in this file for vsdb.analyzeTable/copyQualifiedName — reuse it;
      // palette invocation with no arg → fall back to mgr.getActive().
      // guardPostgres mirrors exportStructure (PG-only DDL).
      const guarded = /* connection | schema node resolve */;
      if (!guarded) return;
      try {
        const adapter = await /* adapter cho connection */;
        const schemas = await adapter.listSchemas(false);
        // If the node is a schema → just that schema; if it's a connection → every user schema.
        const tables = [], views = [], columns = {};
        // (per-schema listTables/listViews/listColumns — same collection logic as
        //  TASK-002's buildMessages; per-object throw → skip + count as skipped)
        const text = buildDatabaseStructure({ schemas, tables, views, columns });
        await vscode.env.clipboard.writeText(text);
        void vscode.window.setStatusBarMessage(
          `VSDB: database structure copied (${tables.length + views.length} objects)`,
          2000,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Export All Structures failed: ${msg}`,
        );
      }
    },
  ),
);

// package.json contributes.commands + menus:
//   { "command": "vsdb.exportAllStructures", "title": "VSDB: Export All Structures (Copy DDL)", "category": "VSDB" }
//   menus.view/item: schema tree — when the node is connection/schema (matches the
//   same condition the exportStructure/analyzeTable commands already use).
//   Do NOT add a keybinding (palette + context menu are enough).
```

Note: the introspection collection inside this command is a parallel implementation of TASK-002's buildMessages collection. The executor writes a small internal helper inside tableCommands.ts (do NOT export it, do NOT import from aiChatPanel.ts — to avoid coupling the UI file). If duplication looks significant, record it in the Discussion for the next cycle to consider extracting — do NOT extract a shared module inside this task (keep scope small).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | PG connection node → clipboard contains full DDL | clipboard text starts with `-- Database structure (1 schemas, 2 tables, 0 views)`, contains `CREATE TABLE public.users`; statusbar message `database structure copied (2 objects)` | mock vscode env + existing adapter pattern in tableCommands.test.ts (guardPostgres passes; listSchemas/listTables/listViews/listColumns mocked) |
| 2 | edge | non-PG (mysql) connection node | guardPostgres blocks: an error message is shown (matches the existing guard-message pattern), clipboard is NOT written | node driver mysql |
| 3 | edge | empty DB (0 user schemas → 0 objects) | clipboard = the one-line header `(0 schemas, 0 tables, 0 views)`; status `copied (0 objects)`; no throw | listSchemas → [] |
| 4 | regression | command is registered in activate | extension.test.ts asserts that `vsdb.exportAllStructures` is in registeredCommands | existing smoke-test pattern |
| 5 | edge | 1 object listColumns throws → skipped, remaining copied | clipboard contains the remaining table; NO error message (silent skip, mirroring the exportStructure per-object path — or the statusbar correctly counts the actual objects) | listColumns rejects one table |
| 6 | edge | no active connection (mgr.getActive() null / adapter factory throws) (review #5) | showErrorMessage `Export All Structures failed: ...` (or an info message instructing the user to connect — whichever path the actual code takes), NO crash / unhandled rejection, clipboard NOT written | active=null or factory rejects |

## Test Files
- `src/ui/__tests__/tableCommands.test.ts` — #1, #2, #3, #5, #6.
- `src/extension.test.ts` — #4 (append to the existing commands-assertion block).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] All tests in §Test Cases PASS.
- [ ] The command is available in the palette + context menu on connection/schema nodes (package.json contributes the correct schema).
- [ ] Clipboard contains the whole-DB DDL (multi-schema) — same builder as TASK-001.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (consumes `buildDatabaseStructure`).

## Interfaces

- Consumes: `buildDatabaseStructure(db: DatabaseStructureInput): string`, `DatabaseStructureInput` (TASK-001 produces); `guardPostgres`, the node resolver + `RegisterDeps`/`mgr` pattern already in tableCommands.ts; DbAdapter `listSchemas(false)/listTables(schema)/listViews(schema)/listColumns(table,schema)`.
- Produces: VS Code command `vsdb.exportAllStructures(arg?: connection-or-schema node)` — the registered id MUST match package.json contributes (locked by extension.test.ts).

---

## Discussion

(no comment yet)

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW Executor Report.
-->
---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec-T4
SUMMARY: Implemented `vsdb.exportAllStructures` — connection/schema node or palette (no arg → `mgr.getActive()`), PG-only with mysql/mssql info guard, introspects all user schemas (or single schema if schema node) → `buildDatabaseStructure` → clipboard. Per-object `listColumns` throw → silent skip. Status bar reports successfully-rendered objects. Tests added in `src/ui/__tests__/tableCommands.test.ts` (#1, #2, #3, #5, #6, #6b, #7) + `src/extension.test.ts` (#4 wiring smoke).
TEST_PLAN_FOLLOWED: task §Test Cases (TDD inline plan)
FILES_CHANGED:
  - package.json: contributed command `vsdb.exportAllStructures` (title "VSDB: Export All Structures (Copy DDL)", icon $(output)), `onCommand:vsdb.exportAllStructures` activationEvent, view/item/context menu entry covering `viewItem == connection || viewItem == schema`.
  - src/ui/tableCommands.ts: imported `buildDatabaseStructure` + `ExportColumn` from `./exportStructure`; added `vsdb.exportAllStructures` registration inside `registerTableCommands` (after `vsdb.exportStructure` block, before closing `}`).
  - src/ui/__tests__/tableCommands.test.ts: appended `describe("tableCommands — TASK-004 vsdb.exportAllStructures", …)` with 7 cases (#1, #2, #3, #5, #6, #6b, #7).
  - src/extension.test.ts: appended `describe("TASK-004 — vsdb.exportAllStructures wiring", …)` with 4 cases (registration, contributes.commands, activationEvents, view/item/context menu).
TESTS_ADDED:
  - src/ui/__tests__/tableCommands.test.ts: #1 happy 2-table PG node → clipboard starts "-- Database structure (1 schemas, 2 tables, 0 views)" + statusbar "database structure copied (2 objects)"; #2 mysql node → "Export All Structures: PostgreSQL connections only" info + no clipboard write; #3 empty DB (listSchemas → []) → header line only + 0 objects + no error; #5 listColumns throw on one table → that object skipped, surviving table rendered, no error message (header counts rendered objects); #6 mgr.getActive() null (palette invoke) → error message, no clipboard write, no unhandled rejection; #6b getAdapterFor rejects → "Export All Structures failed: …" error, no clipboard write, no unhandled rejection; #7 wiring smoke → registeredCommands has the id + package.json menu entry covers connection + schema.
  - src/extension.test.ts: #4 wiring smoke (4 cases) — activate() registers the command, contributes.commands declares it, activationEvents has onCommand entry, view/item/context menu entry has connection + schema viewItem.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
  result: 87 passed | 1 failed | 88 total (1 fail is pre-existing TASK-003 dist/schemaForm.js bundle presence check; reproduced on baseline `git stash` without my changes — not caused by TASK-004)
  output_excerpt: |
    ✓ src/ui/__tests__/tableCommands.test.ts  (35 tests) 11ms
    ✓ src/extension.test.ts  (53 tests | 49 skipped) when filtered to "TASK-004 — vsdb.exportAllStructures wiring" — 4 passed
    ✗ src/extension.test.ts > TASK-003 — vsdb.createSchema extension wiring > npm run compile emits dist/schemaForm.js
      (pre-existing, unrelated to TASK-004; dist/ not built in worktree)
  command: npx tsc --noEmit
  result: clean (no output, exit 0)
  RED-output (captured before impl, npx vitest with same selectors): 12 failed (7 in tableCommands.test.ts, 5 in extension.test.ts) — confirmed each new test fails for the right reason (command not yet registered + menu entry not yet declared).
ISSUES: Pre-existing `dist/schemaForm.js` failure on extension.test.ts TASK-003 case is unrelated to TASK-004. Verified by stashing my changes and re-running — same failure. No regression introduced by this change.
HANDOFF_TO_REVIEWER: yes — wiring smoke matches task spec, command registered, package.json entries match test #4 lock-in.
NEXT: ready for review (Reviewer Verdict append below).

---
## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts && npx tsc --noEmit
  result: 88 pass / 0 fail (vitest) + tsc clean
TEST_PLAN_COVERAGE: partial — test #4 (wiring) fully covered; tests #1-3, #5-6 covered; schema-node path (targetSchema filter at tableCommands.ts:609) has no dedicated test
FINDINGS:
  critical: none
  important:
    - src/ui/tableCommands.ts:609 — `targetSchema` filter path (schema node invocation) is implemented but has no test. The `meta.schema` branch that narrows `allSchemas` to a single schema is untested. Add a test passing a node with `meta: { connection: cfg, schema: "public" }` and verify clipboard contains only that schema's objects.
  minor:
    - src/ui/__tests__/tableCommands.test.ts: — test #2 guard message uses `showInformationMessage` (info), not `showErrorMessage` as the task spec says "error message shown". Implementation is actually correct per spec's "PG-only info guard" intent; the table row label is misleading. No code change needed.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Solid implementation — schema filter, per-object skip, status bar count all work correctly. Only gap is missing schema-node test for the targetSchema path. Non-blocking for handoff.
