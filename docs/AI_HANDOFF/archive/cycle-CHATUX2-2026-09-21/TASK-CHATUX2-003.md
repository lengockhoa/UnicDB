# TASK-CHATUX2-003 — Tree-style step visualization (data-tree marking)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 · Spec: `docs/AI_HANDOFF/SPEC.md` FR-005

## Goal

Mark maximal runs of consecutive tool/reasoning transcript items with
`data-tree` boundary attributes so the CSS rail (TASK-001) renders them
as one continuous Claude Code–style vertical tree; reasoning items join
the tree dimmed.

## Spec references

- SPEC.md §5 FR-005, §8.5, §8.7, §10 (edge cases)

## Target Files

- `webview/aiChat/transcript.ts` — in `render()` after the reconcile loop
  (~700), walk `desired`: for each maximal run of consecutive
  `tool`/`reasoning` items set `data-tree` on the record root — `"first"`
  (run head, len>1), `"last"` (run tail, len>1), `"first last"` (len 1);
  remove the attribute on middle items and all non-step items.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | consecutive tool run → `data-tree` boundaries | 3 consecutive tool items → `first` / (no attr) / `last`; singleton tool → `first last` | transcript renderer + tool items |
| 2 | unit | text item splits the run | tool,text,tool → both tools get `first last` (two runs of 1) | mixed renderOrder |
| 3 | edge | reasoning inside a run joins the tree | tool,reasoning,tool → reasoning root carries `data-tree` per position (middle → no attr; head → `first`; tail → `last`) | items: tool, reasoning, tool |
| 4 | edge | empty transcript / all-non-step items | no `data-tree` attributes anywhere; render is a no-op | empty renderOrder / user+text only |
| 5 | edge | items leaving the viewport lose `data-tree` | after renderOrder shrinks, removed/reshuffled items carry no stale attribute | render → re-render with fewer items |

## Test Files

- `webview/aiChat/__tests__/transcript.test.ts` — all cases (extend; tool timeline block ~508).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/transcript.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `data-tree` values are exactly `"first"`, `"last"`, `"first last"` — never other strings.
- [ ] Runs containing reasoning items mark boundaries identically to tool-only runs.
- [ ] `npm run typecheck` clean; no regression in related suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — the tree rail/stub/dim CSS lands in TASK-001 (same wave); the
  attributes are inert without it and the task's tests are DOM-level.

## Interfaces

- Consumes: existing `ChatTranscriptItem.kind` (`"tool"`, `"reasoning"`).
- Produces: `data-tree` attribute contract (`"first"`, `"last"`,
  `"first last"`) on `item-tool`/`item-reasoning` roots — styled by
  TASK-001's `[data-tree~="first"]::before` / `[data-tree~="last"]::before`
  rules.

---

## Discussion

### 2026-09-21 · planner · devin/swe-2
Split from the original 4-file overlap+tree task (validator:
maxTargetFiles=3). This task is DOM-attribute only; ALL CSS (rail,
branch stub, reasoning dim) is TASK-001's styles.css, and the
activity-timeline removal is TASK-004's. Tests must assert attributes,
not computed style (jsdom has no layout).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Progress

- 2026-09-21T23:16:00+07:00 · milestone: data-tree step-run marking · last-green: `npx vitest run webview/aiChat/__tests__/transcript.test.ts` (41 pass), `npm run typecheck`, `npm run compile` · files: webview/aiChat/transcript.ts, webview/aiChat/__tests__/transcript.test.ts · drift: none

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecC3 (feature-implementer)
SUMMARY: render() now walks `desired` after the reconcile loop and marks each
  maximal run of consecutive tool/reasoning items with data-tree boundary
  attributes ("first" / "last" / "first last"); middle items, non-step items,
  and node-less step items carry no attribute. Recomputed every render, so
  grown/shrunk runs never leave stale marks.
TEST_PLAN_FOLLOWED: task §Test Cases — all 5 cases implemented (case 3 split
  into head/middle/tail positions; case 5 split into grown-run stale-attr and
  viewport-shrink variants)
FILES_CHANGED:
  - webview/aiChat/transcript.ts: added syncTreeMarkers(desired, entities)
    called after the reconcile loop in render()
  - webview/aiChat/__tests__/transcript.test.ts: added "TASK-CHATUX2-003
    data-tree step runs" describe block (8 tests)
TESTS_ADDED:
  - webview/aiChat/__tests__/transcript.test.ts: case 1 (3-tool run
    first/none/last), case 1b (singleton "first last"), case 2 (text splits
    run), case 3a/3b/3c (reasoning middle/head/tail), case 4 (empty +
    non-step), case 5a (grown run drops stale "last"), case 5b (viewport
    shrink detaches + survivors recompute)
RED_OUTPUT: |
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 1: a run of 3 consecutive tools marks first / (none) / last
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 1b: a singleton tool run marks 'first last'
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 2: a text item splits the run — both tools become 'first last'
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 3a: reasoning in the middle of a run joins the tree unmarked
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 3b: reasoning at the head of a run carries 'first'
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 3c: reasoning at the tail of a run carries 'last'
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 4: empty transcript and non-step items carry no data-tree
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 5a: a 'last' item that becomes the middle of a grown run loses the attribute
  FAIL transcript — TASK-CHATUX2-003 data-tree step runs > case 5b: items leaving the viewport are detached; survivors recompute
  Tests 8 failed | 33 passed (41)
VERIFICATION:
  command: npx vitest run webview/aiChat/__tests__/transcript.test.ts
  result: 41 pass / 0 fail
  output_excerpt: |
    ✓ webview/aiChat/__tests__/transcript.test.ts (41 tests) 197ms
    Test Files 1 passed (1)
    Tests 41 passed (41)
  command: npm run typecheck && npm run compile
  result: exit 0
  output_excerpt: |
    > UnicDB@1.54.3 typecheck
    > tsc --noEmit
    (clean)
    ⚡ Done in 31ms
    dist/webview.js 2.3mb ⚠️
    dist/webview.css 41.6kb
ISSUES: none — node-less step items (empty streaming reasoning) are treated
  as invisible run members: they neither break the run nor take a mark
  (spec §10 stub-collapse intent preserved).
HANDOFF_TO_REVIEWER: yes — STATUS DONE; per handoff flow the reviewer picks
  up pending_review tasks in a separate session.
NEXT: ready for review
```

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run webview/aiChat/__tests__/transcript.test.ts
  result: 41 pass / 0 fail
  command: npm run typecheck && npm run compile
  result: exit 0 / exit 0
TEST_PLAN_COVERAGE: all-followed — 5 cases implemented as 8 tests (case 3 split head/middle/tail, case 5 split grown-run/viewport-shrink); RED_OUTPUT shows real failing-test output
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: syncTreeMarkers recomputes boundaries every render — stale attrs cleared on grown runs, shrunk viewports, and non-step transitions; node-less streaming reasoning correctly neither breaks nor marks a run. data-tree values restricted to the "first"/"last"/"first last" contract.
