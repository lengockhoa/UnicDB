# TASK-STOPERR-001 — Statement doc-offset support + stop-on-error regression pin

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 items 1+5

## Goal

Give `splitStatements` a `baseOffset` option so statements parsed from an extracted
selection piece carry real document offsets; pin (regression-test) the already-correct
stop-on-first-error loop in `QueryRunner.executeAll`.

## Target Files

- `src/core/statementParser.ts` — add `baseOffset?: number` to `splitStatements` opts
  (default 0); emit `start`/`end` = `baseOffset +` relative offset for every push site
  (`;` boundary ~line 597-602 & 666-670, `GO` boundary ~590-601, line-boundary ~711-724,
  EOF tail ~756-764). `text` stays `sql.substring(relStart, relEnd)` — document the new
  invariant in the docstring at ~line 476.
- `src/core/queryRunner.ts` — NO functional change expected; `executeAll` already stops
  at first error (catch at ~537-565 marks error, cancels rest, returns). Only add/adjust
  comments if the executor finds drift.
- `src/core/__tests__/statementParser.test.ts` — new tests.
- QueryRunner test file (find existing suite, e.g. `src/core/__tests__/queryRunner*.test.ts`)
  — new regression tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `splitStatements` with `baseOffset: 20` on `"SELECT 1; SELECT 2"` | stmts have start/end = 20+relative | baseOffset opt |
| 2 | edge | `baseOffset` omitted / 0 | byte-identical start/end vs today | `"SELECT 1; SELECT 2"` |
| 3 | edge | `baseOffset` + EOF-tail statement (no `;`) | tail stmt end = baseOffset + len | `"SELECT 1"` + baseOffset |
| 4 | regression | 3-stmt run, stmt 2 adapter rejects → statuses `[done, error, cancelled]`, adapter `runQuery` called exactly 2× | RED only if regression exists; locks behavior | fake adapter rejecting 2nd call |
| 5 | edge | stmt 1 of 3 errors → stmts 2,3 `cancelled`, adapter called 1× | — | fake adapter rejecting 1st call |

## Test Files

- `src/core/__tests__/statementParser.test.ts`
- existing queryRunner test file under `src/core/__tests__/` (locate via `grep -l QueryRunner src/core/__tests__/`)

## Verification Commands

```bash
npx vitest run src/core/__tests__/statementParser.test.ts
npx vitest run src/core/__tests__           # runner + parser suites
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; `baseOffset` is additive and default-0 identical.
- [ ] No regression in `src/core/__tests__` suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: `splitStatements(sql, dialect?, opts?: { lineBoundaries?: boolean; baseOffset?: number })`
  — statements' `start`/`end` in document space when `baseOffset` = piece's document offset.
  Consumed by TASK-STOPERR-003 (`runQueryFromEditor` per-piece split + error marking).

---

## Discussion

### 2026-09-18 · planner · claude-opus-4-8
Root cause for defect B verified: `executeAll` already stops on first error and marks the
rest `cancelled` (queryRunner.ts:537-565). The user-facing defect is INVISIBILITY, not
execution order — hence this task only regression-pins; the UX fix lands in 003.
Do NOT change `text` slicing — only `start`/`end` shift by `baseOffset`.

(no further comments yet)

---

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-opus-4-8
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — splitStatements baseOffset (TASK-STOPERR-001) > #1 — baseOffset: 20 shifts every start/end by 20, text unchanged
AssertionError: expected { Object (text, start, ...) } to match object { start: 20, end: 28 }
- Expected  + Received
  Object { - "end": 28, - "start": 20, + "end": 8, + "start": 0 }
 FAIL  ... > #3 — baseOffset + EOF-tail statement (no `;`): tail end = baseOffset + len
 FAIL  ... > #4 — baseOffset applies at every push site (`;`, line-boundary, GO, EOF tail)
AssertionError: expected { Object (text, start, ...) } to match object { start: 100, end: 101 }
- Expected  + Received
  Object { - "end": 101, - "start": 100, + "end": 1, + "start": 0 }
 Test Files  1 failed (1)
      Tests  3 failed | 95 passed (98)
```
(Runner regression pins #4/#5 passed immediately — expected: task states "RED only if regression exists"; they pin already-correct behavior.)

Verification Output:
```
$ npx vitest run src/core/__tests__/statementParser.test.ts
 Test Files  1 passed (1)
      Tests  98 passed (98)

$ npx vitest run src/core/__tests__
 Test Files  23 passed (23)
      Tests  524 passed (524)

$ npm run typecheck
> UnicDB@1.54.1 typecheck
> tsc --noEmit
(exit 0, no errors)
```
Status: PASS
Note: Two of my initial test expectations were arithmetic slips (GO push site `candidateEnd` = kwStart includes the "\n" before GO; SELECT 2 after "GO\n" starts at 12 not 11). Fixed expectations to match parser's documented range semantics; no source change needed. `queryRunner.ts` untouched — no drift found; `executeAll` already stops at first error.

---

## Reviewer Verdict
VERDICT: approved
REVIEWER_MODEL: claude-sonnet-4-5
EXECUTOR_MODEL: claude-opus-4-8
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: src/core/statementParser.ts:524 — `baseOffset` không được validate (âm / không nguyên sẽ tạo offset ngoài document-space); chỉ là phòng vệ, không chặn.
NEXT_STATUS_FOR_INDEX: done
