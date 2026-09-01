# TASK-ARP03-001 — Pure retained-result budget helper

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3, §4 (ARP-03.1)

## Goal

Add a pure, constant-free helper to `src/core/resultBatcher.ts` that bounds an append to a deterministic
retained-row prefix without mutating its inputs. It is the single source of truth for the truncation
semantics (prefix retention and the `limited` flag at and past the boundary) that TASK-ARP03-002
wires into `QueryRunner.loadMoreImpl`.

RED cases (all fail on base `main @ f17cc6f` — the symbol does not exist yet):
1. Under-budget append keeps all rows, `limited === false`.
2. Exact boundary is NOT limited.
3. Oversized next batch retains a deterministic prefix and never mutates `current` or `batch`.
4. `maxRows` `0`/negative/`NaN` → empty rows, no throw.
5. Empty inputs and already-at-cap inputs behave deterministically.

Deliverable: `appendBatchBounded(current, batch, maxRows)` returning `{ rows, limited }`, exported from
`resultBatcher.ts`, with its own unit tests. The cap constant does NOT live here — the helper stays
constant-free so it is testable across any boundary. (No `retained` field — it is always `rows.length`
and consumed only by tests, so it was cut at review; the runner derives `rowCount` from `rows.length`.)

## Target Files

- `src/core/resultBatcher.ts` — only. Existing `appendBatch`, `batchStats`, `mergeBatchIntoResult`
  are left UNTOUCHED (still used / kept for API stability); the new export is purely additive.
- `src/core/__tests__/resultBatcher.test.ts` — ADD the new cases; keep all existing blocks intact
  (3a-3h appendBatch + batchStats).

## Test Cases (REQUIRED — TDD)

RED-first: write cases below FIRST, run them, paste the RED output (expected: module does not export
`appendBatchBounded` / type-error), then implement.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | under-budget append keeps all rows | `appendBatchBounded([[a],[b]],[[c],[d]],100)` → `rows` length 4 in order `a,b,c,d`; `limited === false` | row refs `a,b,c,d` (objects to prove no reordering / no new cell copies beyond refs) |
| 2 | edge: boundary | exact cap is not limited | `current` 3 rows + `batch` 2 rows, `maxRows = 5` → `rows` length 5; `limited === false` | 3-row current, 2-row batch |
| 3 | edge: oversized | oversized next batch retains deterministic prefix; inputs unmutated | `current` 3 + `batch` 5, `maxRows = 5` → `rows` length 5 = first 3 of `current` + first 2 of `batch`; `limited === true`; after the call `current` and `batch` are `toEqual` their original values (deep, no in-place splice) | 3-row current, 5-row batch |
| 4 | edge: zero/negative/NaN cap | degenerate `maxRows` never throws | `maxRows = 0` (and `-1`, `NaN`) → `rows === []`; `limited === true` when any input row exists, `false` when both inputs empty | empty + 2-row inputs |
| 5 | edge: empty inputs | empty + empty / empty + batch | `current=[]`,`batch=[]` → `rows=[]`,`limited=false`; `current=[]`,`batch=2 rows` → `rows=batch`,`limited=false` | — |
| 6 | edge: current already at cap | cap crossed purely by existing rows | `current` length 5, `batch` 3, `maxRows = 5` → `rows` = first 5 of `current` only (batch contributes nothing); `limited === true` | 5-row current, 3-row batch |

## Test Files

- `src/core/__tests__/resultBatcher.test.ts` — ADD cases 1-6 in a new `describe("appendBatchBounded", ...)`
  block. Follow the existing test style (imports from `src/core/resultBatcher`, no mock needed — pure function).

## Verification Commands

```bash
npx vitest run src/core/__tests__/resultBatcher.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `resultBatcher.ts` → `.cache/index/tests-map.json` =
`[resultBatcher.test.ts]` — pinned target. No lint script exists; typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: cases fail on base `f17cc6f` BEFORE implementation (module has no export).
- [ ] Cases 1-6 all GREEN after implementation; cases 1-2 and 5 prove non-limitation, cases 3/6 prove
      deterministic prefix + `limited`, case 4 proves degenerate-cap safety.
- [ ] Inputs never mutated (case 3 asserts deep equality of both inputs after the call).
- [ ] Existing `resultBatcher.test.ts` blocks still green (appendBatch 3a-3d, batchStats 3e-3h untouched).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Only `src/core/resultBatcher.ts` (+ new export) and its test modified in this task.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1 — first task of the cycle; no shared files with any other task).

## Interfaces

- Consumes: none (pure function over `any[][]`).
- Produces:
  ```ts
  // src/core/resultBatcher.ts (new export — signature is the load-bearing contract for TASK-ARP03-002)
  export function appendBatchBounded(
    current: any[][],
    batch: any[][],
    maxRows: number
  ): { rows: any[][]; limited: boolean }
  ```
  Semantics: `rows` is the deterministic prefix of `current.concat(batch)` up to `maxRows`;
  `limited === true` iff `current.length + batch.length > maxRows` (i.e. the concatenation was truncated).
  Both inputs are never mutated. Constant-free by design. No `retained` field — TASK-ARP03-002 derives the
  retained count as `rows.length` and echoes it to `rowCount`.

## Discussion

- The copy/allocation trade-off is a review item: `rows` is one fresh array of length ≤ `maxRows`, cell
  references copied, inputs untouched. `current` may itself be large; the helper must NOT re-slice `current`
  into a second array when `current.length >= maxRows` — return the first `maxRows` refs without allocating
  an extra intermediate when avoidable (case 6).
- `limited` should report whether truncation actually happened, not merely whether a future append *could*
  truncate. The runner derives the retained count as `rows.length` and echoes it to `rowCount` — no
  separate `retained` field (it was cut at review: always `rows.length`, consumed only by tests).
- Do NOT place `RETAINED_ROW_CAP` here — TASK-ARP03-002 owns the constant and passes it as `maxRows`.
- (no comments yet)

---

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

IMPLEMENTATION SUMMARY:
Added pure export appendBatchBounded(current, batch, maxRows) → { rows, limited } to
src/core/resultBatcher.ts. Single fresh rows array of length min(total, cap) — no intermediate
concat, no re-slice of current; cell refs copied in current-then-batch order. limited === true
iff total > cap (cap = maxRows > 0 ? floor(maxRows) : 0, so 0/âmal/NaN all clamp to 0, no throw).
Constant-free per task spec: RETAINED_ROW_CAP is NOT placed here (TASK-ARP03-002 owns it and
passes it as maxRows). No retained field. Existing appendBatch / batchStats / mergeBatchIntoResult
untouched. RED-first: tests written before implementation, all 6 failed on base as expected.

RED_OUTPUT (npx vitest run src/core/__tests__/resultBatcher.test.ts, BEFORE implementation):
 FAIL  src/core/__tests__/resultBatcher.test.ts > appendBatchBounded > Test #5 — empty inputs behave deterministically
TypeError: appendBatchBounded is not a function
 ❯ src/core/__tests__/resultBatcher.test.ts:112:12
 FAIL  ... (same TypeError for all 6 new cases #1-#6)
 Test Files  1 failed (1)
      Tests  6 failed | 8 passed (14)   ← 8 existing blocks (3a-3h) stayed green in RED

VERIFICATION OUTPUT (tails, AFTER implementation, all inside the worktree):
1) npx vitest run src/core/__tests__/resultBatcher.test.ts
   ✓ src/core/__tests__/resultBatcher.test.ts  (14 tests) 3ms
   Test Files  1 passed (1)
        Tests  14 passed (14)          ← 6 new + 8 existing, all green
   Duration  190ms
2) npm run typecheck
   > tsc --noEmit                      ← exit 0, no output
3) npm run compile
   ⚡ Done in 128ms
   dist/extension.js      5.3mb ⚠️
   ⚡ Done in 154ms
   esbuild: build complete             ← exit 0

SCOPE: git status shows exactly 2 modified files — src/core/resultBatcher.ts,
src/core/__tests__/resultBatcher.test.ts. No queryRunner.ts / resultsPanel.ts / webview / INDEX
changes. No git add/commit/push executed.

ISSUES:
- Test case 5 was initially written as appendBatchBounded([], []) (2 args) — fixed during RED to
  pass the required 3rd arg (maxRows) per the load-bearing signature. Fixed pre-implementation;
  RED evidence above reflects the final test file.
- Interpretation note: Interfaces §"limited === true iff total > maxRows" is literally false for
  NaN, but REQUIRED Test Case #4 mandates limited===true with rows present for degenerate caps.
  Followed the test table: NaN clamps to cap=0 so limited = total > 0. Case 4 green.
- RETAINED_ROW_CAP intentionally absent from this file (orchestrator prompt mentioned it; the task
  file overrides: constant-free by design, owned by TASK-ARP03-002).

HANDOFF_TO_REVIEWER: yes
```


## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
