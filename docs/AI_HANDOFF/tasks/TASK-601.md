# TASK-601 — Set-filter pure logic (entries + pass + model mapping)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A

## Goal

Pure-logic helpers for the Excel-style set filter: value grouping (case-insensitive,
`(Blanks)` sentinel), counts, sorted entry list, membership predicate, and model
display-string ↔ selected-key mapping. No DOM, no ag-grid imports — consumable by
TASK-602's custom filter component and independently unit-testable.

## Target Files

- `src/ui/resultsGridModel.ts` — append `SetFilterEntry` type + `buildSetFilterEntries` + `setFilterPass` + `selectedKeysFromModel` (new section `---- Set filter (TASK-601) ----`; keep the file's no-vscode/no-ag-grid discipline)
- `src/ui/__tests__/resultsGridModelSetFilter.test.ts` — (new) pure unit tests

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | groups + counts + first-seen casing + ascending case-insensitive sort, `(Blanks)` last | `buildSetFilterEntries(['BUMD','bumd','BUMN',null])` → `[{key:'bumd',display:'BUMD',count:2},{key:'bumn',display:'BUMN',count:1},{key:'(blanks)',display:'(Blanks)',count:1}]` in exactly that order | values as listed |
| 2 | edge | blank variants merge: `null`, `undefined`, `''` → ONE `(Blanks)` entry with combined count | `buildSetFilterEntries([null,undefined,'','x'])` → 2 entries; `(blanks)` count 3, display `'(Blanks)'`, pinned after `'x'` | mixed blanks |
| 3 | edge | case-variant membership + inactive boundary: `setFilterPass('BUMD', Set{'bumd'})===true`; `setFilterPass(null, Set{'(blanks)'})===true`; `setFilterPass(null, Set{'bumd'})===false`; `setFilterPass('x', null)===true` (null = filter inactive, everything passes) | all four booleans exact | selectedKeys `Set<string> \| null` |
| 4 | edge | model round-trip mapping: `selectedKeysFromModel(entries, ['BUMD'])` → `Set{'bumd'}`; `selectedKeysFromModel(entries, null)` → `null` (inactive); unknown display string in model → ignored (not in result set) | exact Set contents / null | entries from #1 fixture |
| 5 | unit | number values group by string form: `buildSetFilterEntries([1, 1, 2.5])` → `[{key:'1',display:'1',count:2},{key:'2.5',display:'2.5',count:1}]` | exact entries (number columns use the same checkbox list) | numeric values |

## Test Files

- `src/ui/__tests__/resultsGridModelSetFilter.test.ts` — contains all tests above (pure node tests, no jsdom, no dist build needed).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsGridModelSetFilter.test.ts
npm run typecheck
```

Note: this repo has NO lint script (`package.json` scripts: compile/watch/test/test:integration/typecheck/package/vscode:prepublish) — typecheck is the static gate.

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED first, then GREEN).
- [ ] No new imports in `src/ui/resultsGridModel.ts` (still no vscode/ag-grid).
- [ ] `npm run typecheck` exit 0.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — standalone pure functions)
- Produces (TASK-602 imports these from `../src/ui/resultsGridModel`):
  - `interface SetFilterEntry { key: string; display: string; count: number }`
  - `buildSetFilterEntries(values: unknown[]): SetFilterEntry[]` — key = `String(v).toLowerCase()` (blanks → `"(Blanks)"` key `"(blanks)"`), display = first-seen casing, ascending case-insensitive, `(Blanks)` last
  - `setFilterPass(value: unknown, selectedKeys: Set<string> | null): boolean` — normalized-key membership; `null` → `true`
  - `selectedKeysFromModel(entries: SetFilterEntry[], values: string[] | null | undefined): Set<string> | null` — display→key; nullish → `null`
  - Blank key sentinel constant: key `"(blanks)"`, display `"(Blanks)"` (export as `SET_FILTER_BLANKS` if useful for TASK-602)

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
Counts derive from the values array the caller passes (TASK-602 passes LOADED rows via
`api.forEachNode`) — batched-result undercount is an accepted, documented difference; do
not try to reach server truth here.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec601
SUMMARY: Implemented `SetFilterEntry` type + `buildSetFilterEntries` + `setFilterPass` + `selectedKeysFromModel` (+ `SET_FILTER_BLANKS_KEY/DISPLAY` sentinels) in `src/ui/resultsGridModel.ts` as a new section, all pure logic with no DOM/ag-grid/vscode imports. Added `src/ui/__tests__/resultsGridModelSetFilter.test.ts` covering all 5 required test cases (groups/counts/sort/blanks-merge, blank-variant membership + inactive boundary, model round-trip, number grouping) — 11 assertions total.
TEST_PLAN_FOLLOWED: task §Test Cases (all 5 cases + supporting cases for blank variant membership and empty-after-unknown)
FILES_CHANGED:
  - src/ui/resultsGridModel.ts: appended "---- Set filter (TASK-601) ----" section with SetFilterEntry interface, SET_FILTER_BLANKS_KEY/DISPLAY constants, and three exported functions (buildSetFilterEntries, setFilterPass, selectedKeysFromModel).
  - src/ui/__tests__/resultsGridModelSetFilter.test.ts: NEW — 11 vitest assertions in 3 describe blocks.
TESTS_ADDED:
  - src/ui/__tests__/resultsGridModelSetFilter.test.ts: buildSetFilterEntries (3 tests: case-insensitive grouping+first-seen-casing+blanks-last, blank-variant merge, number grouping); setFilterPass (4 tests: case-insensitive match, blanks key match for null/undefined/'', non-match returns false, null selectedKeys → all pass); selectedKeysFromModel (4 tests: known display→key, null/undefined→null, ignores unknown, all-unknown→empty Set).
VERIFICATION:
  command: npx vitest run src/ui/__tests__/resultsGridModelSetFilter.test.ts
  result: 11 pass / 0 fail / exit 0
  output_excerpt: |
    RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-601
     ✓ src/ui/__tests__/resultsGridModelSetFilter.test.ts  (11 tests) 2ms
     Test Files  1 passed (1)
          Tests  11 passed (11)
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > vsdb@1.4.1 typecheck
    > tsc --noEmit
ISSUES: none
HANDOFF_TO_REVIEWER: yes — full task scope implemented per §Test Cases + §Interfaces; pure logic, no DOM, ready for code-reviewer subagent.
NEXT: ready for review

### RED Output (pre-implementation, before edits)

```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-601
filter:  src/ui/__tests__/resultsGridModelSetFilter.test.ts
 Test Files  1 failed (1)
      Tests  11 failed (11)
   Duration  206ms

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > buildSetFilterEntries — groups + counts + sort > groups case-insensitively, first-seen casing for display, (Blanks) last
TypeError: buildSetFilterEntries is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:25:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > buildSetFilterEntries — groups + counts + sort > merges null, undefined, and '' into a single (Blanks) entry
TypeError: buildSetFilterEntries is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:36:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > buildSetFilterEntries — groups + counts + sort > groups number values by their string form
TypeError: buildSetFilterEntries is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:46:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > setFilterPass — membership predicate > matches case-insensitively against the selected key
TypeError: setFilterPass is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:54:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > setFilterPass — membership predicate > matches (blanks) key for null/undefined/empty values
TypeError: setFilterPass is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:58:5

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > setFilterPass — membership predicate > returns false when selected key does not match
TypeError: setFilterPass is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:65:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > setFilterPass — membership predicate > returns true for null selected (filter inactive → pass all)
TypeError: setFilterPass is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:71:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > selectedKeysFromModel — display→key round-trip > maps a known display string to its normalized key
TypeError: selectedKeysFromModel is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:74:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > selectedKeysFromModel — display→key round-trip > returns null for null/undefined input (inactive filter)
TypeError: selectedKeysFromModel is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:74:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > selectedKeysFromModel — display→key round-trip > ignores display strings not present in entries
TypeError: selectedKeysFromModel is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:79:12

FAIL  src/ui/__tests__/resultsGridModelSetFilter.test.ts > selectedKeysFromModel — display→key round-trip > returns empty Set when every display string is unknown
TypeError: selectedKeysFromModel is not a function
 ❯ src/ui/__tests__/resultsGridModelSetFilter.test.ts:85:12
```

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/resultsGridModelSetFilter.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck
  result: compile OK; 34 pass / 0 fail (4 files: resultsGridModelSetFilter 11, webviewBundle 8, webviewSetFilter 8, webviewFilters 7); typecheck exit 0
TEST_PLAN_COVERAGE: all-followed — all 5 required cases implemented with real assertions; RED_OUTPUT shows genuine pre-implementation failures (11 × "not a function" stack traces), not a bare claim
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ui/resultsGridModel.ts:946 — buildSetFilterEntries sort is strictly ASCII codepoint compare (`a < b`), not locale-aware collation; Excel sorts e.g. "é" via locale rules. TASK-601 spec only required ascending case-insensitive, so this matches spec; flagging only if TASK-602 users report non-ASCII column values out of order. No action required now.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Key normalization round-trip verified: buildSetFilterEntries (display = first-seen casing) → selectedKeysFromModel (display→key Map, unknowns dropped) → setFilterPass (same blank/null/'' → "(blanks)" normalization) is internally consistent across all three functions. Append-only diff; no vscode/ag-grid/DOM imports introduced.
