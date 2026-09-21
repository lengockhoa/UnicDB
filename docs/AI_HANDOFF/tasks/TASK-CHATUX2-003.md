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
