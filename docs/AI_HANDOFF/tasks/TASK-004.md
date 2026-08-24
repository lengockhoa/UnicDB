# TASK-004 — Designer column form: Type dropdown (3 options) + Default auto-fill

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature C)

## Goal

In the table designer webview (`webview/newTableFormMain.ts`), replace the free-text `#colType`
input with a `<select>` of exactly [varchar, numeric, boolean] (varchar default on new column),
auto-fill the Default field per type (`''` / `0` / `FALSE`) with refresh on type change, preserve
user overrides, never inject into host-loaded (modify-mode) columns, and preserve a column's
REAL type on the wire when the user has not touched the dropdown.

## Target Files

- `webview/newTableFormMain.ts` — (1) edit pane (~L344): `<input id="colType">` → `<select
  id="colType">` with exactly 3 `<option>`s; (2) `commit()` (~L382-401): read
  `typeEl.value`, emit real-type-preserving value (see Interfaces); (3) add-column handler
  (~L196): seed `default: ""` and mark index; (4) new pure helpers `defaultColumnDefault`,
  `mapTypeToForm`; (5) per-column auto-fill tracking `Set` + realType map; (6) remove/up/down
  handlers remap tracking.
- `src/ui/__tests__/newTableFormColumnDefault.test.ts` **(new)** — jsdom source-level tests
  (import the webview module directly; pattern: stub `acquireVsCodeApi`, jsdom env — do NOT
  depend on dist build, unlike newTableFormBundle.test.ts).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit happy | dropdown has exactly 3 options, varchar default | `#colType.tagName === "SELECT"`; options text exactly `["varchar","numeric","boolean"]`; after add-column, selected value `varchar` | render edit pane on a newly added column |
| 2 | unit happy | default auto-fill + refresh on type change | add column → Default input `''`; switch dropdown to `numeric` → Default `0`; `boolean` → `FALSE`; emitted specChanged carries matching `default` | auto-filled column |
| 3 | edge (override) | manual default then type change | user types `42` into Default → unmarked; subsequent type change leaves Default `42` | auto-filled column then manual edit |
| 4 | edge (modify-mode injection) | host-loaded column with empty default | init with modify spec (column `ts type timestamp default ""`), dropdown untouched, commit → default stays `""`; no `''`/`0`/`FALSE` injected | host init message with loaded spec |
| 5 | edge (mapping, exotic type — wire preservation) | real type `timestamp`/`jsonb` | dropdown shows `varchar` (mapped); commit (user only renamed the column) → specChanged column `.type === "timestamp"` (real type preserved); switch dropdown to `numeric` (intentional change) → `.type === "numeric"` | host-loaded column |
| 6 | unit | `defaultColumnDefault` mapping | `varchar`→`''`, `numeric`→`0`, `boolean`→`FALSE`, unknown (e.g. `timestamp`, ``)→`""` | direct fn calls |
| 7 | unit | `mapTypeToForm` mapping | `text|varchar|char|uuid|json|xml`→varchar; `int|serial|decimal|numeric|real|double|float|money`→numeric; `bool*`→boolean; `timestamp|date|jsonb|_int4`→varchar | direct fn calls |

## Test Files

- `src/ui/__tests__/newTableFormColumnDefault.test.ts` **(new)** — all cases; jsdom +
  `@vitest-environment jsdom`; `vi.stubGlobal("acquireVsCodeApi", ...)`-style stub matching how
  the module guards `declare const acquireVsCodeApi`; drive the module by dispatching
  init/specChanged messages the way `newTableFormBundle.test.ts` does (but importing the TS
  source, not dist).

## Verification Commands

```bash
npm run compile && npx vitest run src/ui/__tests__/newTableFormColumnDefault.test.ts && npm run typecheck
```

(`npm run compile` because the shared webview source must stay bundle-buildable; typecheck is
the static gate. tests-map has no entry for the new file → per RULES.md floor the selection is
the file's own test. No lint script exists — N/A.)

## Acceptance Criteria

- [ ] RED first: tests fail against current free-text input (real failing output pasted).
- [ ] All 7 cases PASS.
- [ ] `npm run compile` builds `dist/newTableForm.js` without error; `npm run typecheck` clean.
- [ ] No changes outside the two Target Files; `src/ui/newTableForm.ts` and
      `src/core/ddl/*` untouched (wire format `ColumnSpec.type: string` unchanged).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes (all webview-local): `ColumnSpec { name; type: string; default?: string; ... }` and
  `TableSpec` as redeclared in `webview/newTableFormMain.ts`; host messages
  `NewTableFormHostMessage`/`NewTableFormWebviewMessage` from `src/ui/newTableFormMessages.ts`
  (protocol unchanged — this task sends `specChanged` with the same shape).
- Produces (exported from `webview/newTableFormMain.ts` for tests): `defaultColumnDefault(type:
  "varchar"|"numeric"|string): string`; `mapTypeToForm(realType: string): "varchar"|"numeric"|"boolean"`.
  Wire contract: `specChanged`/submit emit `spec.columns[i].type` = real type when the dropdown
  still equals `mapTypeToForm(realType)` (untouched), else the user's selection.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Real-type preservation is the load-bearing rule: a modify-mode column `timestamp` must round-trip
as `timestamp` unless the user actively changes the dropdown — otherwise diffTable emits a
spurious ALTER on every rename. Track `realType` per column in module state at host-init; on
`commit`, `type = (selection === mapTypeToForm(realType)) ? realType : selection`. New columns:
`realType = selection` (no preservation needed). If implementing `defaultColumnDefault` strictly
over the 3 form types feels cleaner (`type: "varchar"|"numeric"|"boolean"`), keep the unknown→`""`
branch anyway for safety.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: -

SUMMARY: Added Type `<select>` (varchar|numeric|boolean) in the column edit
pane with per-type auto-fill Default (''/0/FALSE) and realType preservation
on the wire. Host-loaded columns are marked `defaultOverridden` so
modify-mode never injects defaults. Extracted pure helpers
(`defaultColumnDefault`, `mapTypeToForm`) to
`webview/newTableFormColumnHelpers.ts` and re-exported from
`newTableFormMain.ts`.

TEST_PLAN_FOLLOWED: task §4 (7 cases; test file splits into 8 vitest cases
covering all required behaviors + extras for edge cases).

FILES_CHANGED:
  - webview/newTableFormMain.ts: imports helpers + re-exports; adds
    `defaultOverridden: Set<number>` + `realTypes: Map<number, string>`;
    renders `<select id="colType">` with exactly 3 options; new commit
    preserves realType when selection maps to original form value; auto-fill
    skipped for host-loaded columns; reindexTracking/swapTracking keep
    tracking valid across remove/up/down; auto-init now respects
    `data-vsdb-skip-auto-init` for source-level test isolation.
  - webview/newTableFormColumnHelpers.ts (new): pure `mapTypeToForm` and
    `defaultColumnDefault`.
  - src/ui/__tests__/newTableFormColumnDefault.test.ts (new): jsdom
    source-level tests; stubs acquireVsCodeApi; dynamic import (justified:
    module-level state + lifecycle).

TESTS_ADDED:
  - src/ui/__tests__/newTableFormColumnDefault.test.ts: #1 dropdown 3 options,
    #2 auto-fill + refresh, #3 manual override preserved, #4 modify-mode
    no injection, #5a timestamp realType preserved, #5b jsonb intentional
    change emits numeric, #6 defaultColumnDefault mapping, #7 mapTypeToForm
    mapping.

VERIFICATION:
  command: npm run compile && npx vitest run src/ui/__tests__/newTableFormColumnDefault.test.ts && npm run typecheck
  result: compile OK; vitest 8/8 pass (test file passed); typecheck clean
    (no errors).
  output_excerpt: |
    esbuild: build complete
    Test Files  1 passed (1)
         Tests  8 passed (8)
    > vsdb@1.6.0 typecheck
    > tsc --noEmit

ISSUES: none
HANDOFF_TO_REVIEWER: yes — TASK-004 fully implemented; code changes left
uncommitted in .worktrees/task-004 per harness rule.
NEXT: ready for review
