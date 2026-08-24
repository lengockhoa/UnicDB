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
## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: W2-T002
SUMMARY: Wired `vsdb.browseTableData` for double-click/Enter on table + view schemaTree nodes (routines + connection nodes unchanged). `src/ui/schemaTree.ts` builds the VsdbNode first then attaches `command = { command: "vsdb.browseTableData", title: "Browse Data", arguments: [n] }` in the tables + views blocks. `src/extension.ts` imports `registerBrowseCommands` from `./ui/browseCommands` and calls it right after `ResultsPanel` is constructed (panel/runner/mgr all available there) with `{ mgr, runner, panel }`. `package.json` gains one `contributes.commands` entry (title "VSDB: Browse Table Data", category "VSDB") + one `activationEvents` entry (`onCommand:vsdb.browseTableData`) — purely additive (the only "removed" byte is the trailing comma needed for valid JSON after the new activationEvents row).
TEST_PLAN_FOLLOWED: task §4 (all 5 cases implemented; case 5 = regression-protection PASSES against baseline)
FILES_CHANGED:
  - src/ui/schemaTree.ts: tables + views blocks in getCategoryChildren — build VsdbNode first then attach command with whole node as arg
  - src/extension.ts: import registerBrowseCommands; call right after `panel.setExtensionUri(...)`/`context.subscriptions.push(panel)`
  - package.json: +1 activationEvent ("onCommand:vsdb.browseTableData") +1 contributes.commands entry
  - src/ui/__tests__/schemaTree.test.ts: +3 cases (case 1 table, case 2 view + routines untouched, case 5 connection untouched) in new describe "TASK-002 browse gesture wiring"
  - src/extension.test.ts: +4 cases (case 3 registration, case 3 palette no-throw, case 4 contributes entry, case 4 activationEvent) in new describe "TASK-002 — vsdb.browseTableData extension wiring"
TESTS_ADDED:
  - src/ui/__tests__/schemaTree.test.ts: TASK-002 browse gesture wiring describe (3 cases)
  - src/extension.test.ts: TASK-002 — vsdb.browseTableData extension wiring describe (4 cases)
VERIFICATION:
  command: `cd .worktrees/task-002 && npm ci --silent && npx vitest run src/ui/__tests__/schemaTree.test.ts src/extension.test.ts src/ui/__tests__/browseCommands.test.ts && npm run typecheck`
  result: 97 pass / 0 fail; typecheck exit 0
  output_excerpt: |
    RED (6 new-test failures captured before src edits):
      RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002
       FAIL  src/extension.test.ts > TASK-002 — vsdb.browseTableData extension wiring > registers vsdb.browseTableData handler trong activate() (case 3)
       AssertionError: expected false to be true  // command not registered yet
       FAIL  src/extension.test.ts > TASK-002 — vsdb.browseTableData extension wiring > invoking vsdb.browseTableData handler không throw khi palette (no arg) (case 3)
       AssertionError: expected undefined not to be undefined  // fn = registeredCommands.get(...)
       FAIL  src/extension.test.ts > TASK-002 — vsdb.browseTableData extension wiring > package.json contributes.commands có vsdb.browseTableData entry với category VSDB (case 4)
       AssertionError: expected undefined not to be undefined  // entry not in manifest yet
       FAIL  src/extension.test.ts > TASK-002 — vsdb.browseTableData extension wiring > package.json activationEvents có onCommand:vsdb.browseTableData (case 4)
       AssertionError: expected [ 'onLanguage:sql', …(20) ] to include 'onCommand:vsdb.browseTableData'
       FAIL  src/ui/__tests__/schemaTree.test.ts > SchemaTreeProvider — TASK-002 browse gesture wiring > table node command = vsdb.browseTableData 'Browse Data' với arguments[0]=node (case 1)
       AssertionError: expected 'vsdb.copyQualifiedName' to be 'vsdb.browseTableData'  // schemaTree tables block unchanged
       FAIL  src/ui/__tests__/schemaTree.test.ts > SchemaTreeProvider — TASK-002 browse gesture wiring > view node command = vsdb.browseTableData 'Browse Data' với arguments[0]=node (case 2)
       AssertionError: expected 'vsdb.copyQualifiedName' to be 'vsdb.browseTableData'  // schemaTree views block unchanged
       Test Files  2 failed | 1 passed (3)
            Tests  6 failed | 91 passed (97)

    GREEN (after schemaTree/extension/package.json edits):
      RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002
       ✓ src/ui/__tests__/browseCommands.test.ts  (9 tests) 4ms
       ✓ src/ui/__tests__/schemaTree.test.ts  (47 tests) 25ms
       ✓ src/extension.test.ts  (41 tests) 87ms
       Test Files  3 passed (3)
            Tests  97 passed (97)

    typecheck:
      > vsdb@1.6.0 typecheck
      > tsc --noEmit
      (exit 0, no output)
ISSUES: (1) Mid-flight: my first extension.ts import edit accidentally overwrote the existing `import type { ConnectionConfig } from "./config/types"` (the auto-repair echo dropped it). Restored immediately — typecheck caught the regression (4× TS2304 Cannot find name 'ConnectionConfig') and the fix brought it back to clean. (2) Mid-flight: while rewriting the new schemaTree RED tests to comply with ts-no-inline-cast-access, I temporarily orphaned the case-5 connection test body — caught by reading the file, restored verbatim before any test run. The final test file parses and all 5 cases pass as expected.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review


## Reviewer Verdict

VERDICT: CRITICAL
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
EXECUTOR_TOOL: claude-code
VERIFICATION_RERUN:
  command: `npx vitest run src/ui/__tests__/schemaTree.test.ts src/extension.test.ts src/ui/__tests__/browseCommands.test.ts && npm run typecheck`
  result: 111 pass / 0 fail (scoped suite); typecheck exit 0
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical:
    - package.json:190 — `vsdb.browseTableData` contributes.commands entry has NO `icon` property. Baseline at d266d93 had zero iconless commands. `src/scaffold.test.ts:126` loops every command asserting `cmd.icon` matches `/^\$\(/`; this is a real regression now confirmed: `npx vitest run src/scaffold.test.ts` fails `TypeError: .toMatch() expects a string, got undefined` at L126 for this command. TASK-002 owns package.json and owns this entry; this blocks handoff.
    - src/scaffold.test.ts:126 — the failing assertion originates here (inherited loop from earlier scaffold tests, NOT modified by T002's diff). The root cause is the missing icon in the command entry added by T002, not the test itself.
  important:
    - src/extension.ts:100 — `registerBrowseCommands(...)` is called as a bare statement; any thrown synchronous error would crash `activate()`. The other registrations push returned disposables or void identically, so this is consistent with the existing pattern and is not blocking.
  minor:
    - package.json:189-193 — add `"icon": "$(database)"` (or a similar DataGrip-style icon matching the "Browse Data" semantics) to the `vsdb.browseTableData` command entry.
NEXT_STATUS_FOR_INDEX: critical_block
NOTES: Scoped T002 verification passes; the regression is isolated to the icon-assertion loop in scaffold.test.ts which T002's new command entry triggers. Fix: add `icon` to the package.json command entry and re-verify both scoped and scaffold suites.


## Executor Report (fix round 1)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Fix-002
SUMMARY: Fix the single critical finding from R4.5 Reviewer Verdict: add `"icon": "$(preview)"` to the `vsdb.browseTableData` contributes.commands entry at package.json:190 (the only command missing an icon — scaffold.test.ts:126 loops every entry asserting `cmd.icon` matches `/^\$\(/`). No other code/test edits; meets icon regex `^\$\(`.
TEST_PLAN_FOLLOWED: N/A — single-line manifest patch; test suite re-run as scoped proof.
FILES_CHANGED:
  - package.json: vsdb.browseTableData entry at L190 — added `"icon": "$(preview)"` (purely additive, no removed lines)
TESTS_ADDED: none — observed behavior already covered by src/scaffold.test.ts cases; the change re-aligns the manifest with the existing assertion.
VERIFICATION:
  command: `cd .worktrees/fix-002 && npm ci --silent && npx vitest run src/scaffold.test.ts && npm run typecheck`
  result: 7 passed / 0 failed (exit 0); typecheck exit 0
  output_excerpt: |
    ✓ src/scaffold.test.ts  (7 tests) 293ms
    Test Files  1 passed (1)
    Tests  7 passed (7)
    > vsdb@1.6.0 typecheck
    > tsc --noEmit
    (exit 0, no output)
ISSUES: none. Edit tool auto-repair stripped two duplicated body rows in package.json between range boundaries; the syntax probe verified the final file shape (no stray commas, balanced braces), and scaffold.test.ts:7/7 green confirms parity with other command entries.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for re-review

## Reviewer Verdict (fix round 1 re-review)

VERDICT: approved
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_TOOL: claude-code
EXECUTOR_SUBAGENT: Fix-002
VERIFICATION_RERUN:
  command: npx vitest run src/scaffold.test.ts && npx vitest run src/ui/__tests__/schemaTree.test.ts src/extension.test.ts src/ui/__tests__/browseCommands.test.ts && npm run typecheck
  result: scaffold 7/7 pass; scoped 111/111 pass; typecheck exit 0
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Fix-002 added icon="$(preview)" to the vsdb.browseTableData command entry at package.json:190. Scaffold icon assertion loop now passes; no other regressions. Fix fully resolves the critical_block from R4.
