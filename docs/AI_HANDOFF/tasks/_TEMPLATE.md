# TASK-XXX — <short title>

<!--
Template for every task. The planner copies this file when splitting PLAN.md into individual tasks.
This file MUST keep its structure: Goal + Test Cases + Test Files + Verification + Acceptance + Interfaces.
Every AI (planner / executor / reviewer) reads and writes into THIS file. No exchange outside the file.
-->

- Status: `ready`  <!-- ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | blocked | done -->
- Owner: `-`       <!-- tool currently holding the task -->
- Reviewer: `-`    <!-- reviewer model name, set in Phase 4 -->
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §<section>

## Goal

<!-- 1-2 sentences describing what this slice does. -->

## Target Files

- `<path/to/source.js>` — <what changes>

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `<describe behavior>` | `<concrete expected>` | `<input>` |
| 2 | edge | `<null/empty/boundary>` | `<expected>` | `<input>` |
| 3 | regression (if bug fix) | `<reproduces bug>` | RED before fix, GREEN after | `<repro input>` |

## Test Files

- `<tests/path/to/file.test.js>` — contains the tests listed above.

## Verification Commands

```bash
npm test tests/path/to/file.test.js
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] No regression in related suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.
- [ ] Docs/CHANGELOG updated if user-facing.

## Dependencies

- (none) <!-- or TASK-xxx must complete first -->

## Interfaces

<!--
The executor usually ONLY sees this task file, not other tasks. This block is how it learns the
exact names/types that other tasks expect — preventing the kind of bug where "TASK-3 calls
clearLayers() but TASK-7 calls clearFullLayers()". Record real signatures (function/endpoint/type),
not placeholders.
-->

- Consumes: `<what this task uses from earlier tasks — exact function/endpoint signatures, types>` <!-- or (none) -->
- Produces: `<what later tasks rely on from this task — exact function/endpoint signatures, types>` <!-- or (none) -->

---

## Discussion

<!--
AIs talk to each other HERE, not via any other tool.
Format for each comment:

### <date> · <role: planner|executor|reviewer> · <tool/model>
<content — question, note, suggestion, push back to a previous phase>

Reply at one heading level lower (####). Mark "-> @planner" / "-> @executor" / "-> @reviewer" when there is a specific recipient.
-->

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
