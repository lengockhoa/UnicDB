# TASK-009 — AI Chat toolbar icon in schema tree view/title

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature H)

## Goal

Add `vsdb.aiChat` to the schema-tree view/title navigation menu directly after
`vsdb.openAiSettings`, and update the scaffold toolbar-order assertion. The command, icon
(`$(comment-discussion)`), and activation event already exist — this is menu placement only.

## Target Files

- `package.json` (modify) — inside `menus.view/title`, insert after the `vsdb.openAiSettings`
  entry (~L293-297): `{ "command": "vsdb.aiChat", "when": "view == vsdb.schemaTree", "group":
  "navigation" }`. ADDITIVE — no other edits (file carries unrelated uncommitted content).
- `src/scaffold.test.ts` (modify) — toolbar-order block (~L124-139): insert
  `expect(viewTitle[4].command).toBe("vsdb.aiChat");` and shift the clearFilter assertion to
  index 5. Update the comment line describing the order.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (behavior change) | toolbar order | view/title order: refreshSchema, addConnection, filterSchemaTree, openAiSettings, **aiChat**, clearSchemaTreeFilter — RED before the menu insert (index 4 is clearFilter today) | read package.json in scaffold.test.ts |
| 2 | regression | all entries navigation group | every view/title entry still `group === "navigation"` (existing assertion stays green) | existing check |
| 3 | edge (manifest integrity) | command + icon + activation exist | `contributes.commands` contains vsdb.aiChat with `$(comment-discussion)`-style icon; activationEvents contains `onCommand:vsdb.aiChat` (pre-existing — guards against accidental removal) | fs read |

## Test Files

- `src/scaffold.test.ts` (modify — the manifest test that already asserts view/title order;
  tests-map maps package.json scaffold concerns here via the existing block).

## Verification Commands

```bash
npx vitest run src/scaffold.test.ts && npm run typecheck
```

(scaffold.test.ts is the repo's manifest-order test; no dedicated package.json entry exists in
tests-map — this file is the selection by convention. No lint script exists — N/A.)

## Acceptance Criteria

- [ ] Case 1 shown RED (current order assertion fails after updating the test first) then GREEN.
- [ ] All cases PASS; `npm run typecheck` clean.
- [ ] package.json diff is exactly the one menu entry (+ nothing else removed).
- [ ] Manual-equivalent smoke deferred to P3 (icon click opens the existing AI Chat panel —
      command unchanged).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — owns `package.json` in wave 2 (browse command entries); this task edits it after
  (wave 4). No other shared files.

## Interfaces

- Consumes: existing command `vsdb.aiChat` (registered in src/extension.ts, opens the cached
  AiChatPanel), existing manifest structure `contributes.menus["view/title"]` with
  `group: "navigation"`.
- Produces: (none) — manifest-only placement; TASK-008 sequences its package.json edit after
  this task.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Zero-code task by design: the command existed since TASK-004 of an earlier cycle (AI Settings
toolbar work left uncommitted in the tree — do NOT revert it; this task only adds one menu
line + one assertion line). TDD still applies: update the order assertion first, watch it fail
against the un-edited manifest, then insert the menu entry.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: W4-T009

SUMMARY: Inserted `vsdb.aiChat` entry into `menus.view/title` after `vsdb.openAiSettings` and
updated the toolbar-order assertion in `src/scaffold.test.ts` (added `viewTitle[4] === "vsdb.aiChat"`,
shifted `clearSchemaTreeFilter` to index 5, updated descriptive comment). No other edits.

TEST_PLAN_FOLLOWED: task §4 — TDD with toolbar order assertion updated first (RED), then
manifest edit (GREEN).

FILES_CHANGED:
  - package.json: +5 lines (one new menu entry: vsdb.aiChat, when: view==vsdb.schemaTree,
    group: navigation, inserted after vsdb.openAiSettings)
  - src/scaffold.test.ts: +3/-3 lines (toolbar-order block L131-139: index 4 now aiChat,
    index 5 now clearSchemaTreeFilter; comment updated to mention TASK-009)

TESTS_ADDED:
  - src/scaffold.test.ts: existing `package.json manifest hợp lệ` test extended with new
    `expect(viewTitle[4].command).toBe("vsdb.aiChat");` and shifted `viewTitle[5]` assertion.

VERIFICATION:
  command: npx vitest run src/scaffold.test.ts && npm run typecheck
  result: typecheck PASS (0 errors); vitest FAILS pre-existing on L126
  output_excerpt: |
    > vsdb@1.6.0 typecheck
    > tsc --noEmit
    (clean)

    FAIL  src/scaffold.test.ts > scaffold > package.json manifest hợp lệ — đủ commands (≥ 10), keybindings, views, configuration
    TypeError: .toMatch() expects to receive a string, but got undefined
      ❯ src/scaffold.test.ts:126:63
        125|     for (const cmd of pkg.contributes.commands) {
        126|       expect(cmd.icon, `command ${cmd.command} phải có icon`).toMatch(/^\$\(/);

  RED captured (pre-menu-insert state, via standalone order-extract script):
    [0] vsdb.refreshSchema
    [1] vsdb.addConnection
    [2] vsdb.filterSchemaTree
    [3] vsdb.openAiSettings
    [4] vsdb.clearSchemaTreeFilter   ← was at index 4 (RED — test expects aiChat)
  GREEN captured (post-menu-insert state):
    [0] vsdb.refreshSchema
    [1] vsdb.addConnection
    [2] vsdb.filterSchemaTree
    [3] vsdb.openAiSettings
    [4] vsdb.aiChat                   ← matches new assertion (GREEN)
    [5] vsdb.clearSchemaTreeFilter    ← matches shifted assertion (GREEN)

ISSUES:
  - Pre-existing failure on L126: `vsdb.browseTableData` is registered without an icon (introduced
    by TASK-002 in commit 5add346). This causes the manifest test to throw BEFORE reaching the
    toolbar-order assertions at L134-139. The failure is unrelated to TASK-009 and the spec
    explicitly forbids touching it ("package.json diff is exactly the one menu entry"). RED/GREEN
    for the toolbar order was therefore demonstrated via direct manifest inspection (output above),
    not via the vitest pass/fail signal. The icon fix belongs to a follow-up task (TASK-002 follow-up
    or new TASK). Verified via `node -e` extractor that the new menu order matches the updated
    assertions exactly.
  - Test file does NOT have an icon for `vsdb.browseTableData` (TASK-002 regression). The toolbar
    assertions are correct; the L126 throw pre-dates this task and persists post-fix.

HANDOFF_TO_REVIEWER: yes — package.json manifest edit + test assertion change is small,
    self-contained, and the only two files touched. Reviewer should re-confirm menu placement,
    group, when-clause, and the test assertion order.

NEXT: ready for review (W4-T009 → Rev-W4-T009).
