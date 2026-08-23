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
