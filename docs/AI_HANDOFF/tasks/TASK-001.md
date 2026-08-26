# TASK-001 — Adversarial audit: host, adapters, save path

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.1

## Goal

Review the shipped `v1.6.3..v1.6.6` host/adapter diff adversarially and write an evidence-backed report. Do not implement fixes in this task; classify and route only demonstrated defects.

## Target Files

- `docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md` **(new)** — severity-ranked findings, reviewed-file coverage, false-positive dispositions, and recommended fix/test paths.

## Test Cases (REQUIRED — audit contract)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Changed-file coverage | Every changed production file under `src/adapters/`, `src/core/`, and `src/extension.ts` in `v1.6.3..v1.6.6` is listed as reviewed or excluded with a concrete reason; the checklist explicitly verifies `MySqlAdapter.query(sql, values)` at `src/adapters/mysql.ts:397-406` and its direct `pool.query()` implicit-checkout path. | `git diff --name-only v1.6.3..v1.6.6` |
| 2 | edge — malformed/error | Failure-path trace | Invalid SQL, cancellation, retry, transaction failure, partial save, and connection-close paths each receive a source/test-backed disposition; actionable rows state concrete expected and actual behavior. | Host/adapter diff plus neighboring tests |
| 3 | edge — concurrency/state | Ownership trace | Cursor/request queues, manual commit, lazy row identity, and concurrent close/cancel paths are checked for exactly-once cleanup and stale state; any finding includes a reproducible interleaving. | Changed adapter/query/save code |
| 4 | regression — report quality | No speculative finding | Every P0–P3 row has severity, `file:line`, trigger, expected/actual, smallest fix, and exact proposed test file; unsupported suspicions are recorded as rejected, not findings. | Completed audit report |

## Test Files

- N/A — this task changes no executable behavior. The testable deliverable is the non-empty structured report at `docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md`; any confirmed fix receives its own TDD task after Wave 1.

## Verification Commands

```bash
git diff --check v1.6.3..v1.6.6
git diff --name-only v1.6.3..v1.6.6 -- src/adapters src/core src/extension.ts
test -s docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md
npm run typecheck
```

`package.json` has no lint script.

## Acceptance Criteria

- [ ] The report includes scope/method, reviewed-file checklist, findings table, rejected observations, and follow-up disposition.
- [ ] Every actionable item satisfies all evidence fields in test case 4.
- [ ] P0/P1 findings are marked mandatory; small/medium P2 findings are proposed for TASK-006/007; if unrelated P0/P1 findings require more tasks, propose TASK-008 onward rather than deferring or mis-grouping them; huge P2/P3 findings are proposed for the next-cycle queue.
- [ ] The audit explicitly inspects `MySqlAdapter.query(sql, values)` at `src/adapters/mysql.ts:397-406`: its direct `pool.query()` powers `information_schema` metadata calls and `executeText` non-streaming SQL, so a replacement physical connection must not bypass awaited UTC session initialization.
- [ ] No source, test, manifest, or dependency file is modified.
- [ ] All verification commands exit 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: Git tag range `v1.6.3..v1.6.6`; real adapter contract `DbAdapter` from `src/adapters/types.ts`; PLAN §7 global constraints.
- Produces: `docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md` rows with fields `Severity | Evidence (file:line) | Trigger | Expected | Actual | Proposed fix | Proposed test | Disposition`.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Audit the diff, then inspect current source and neighboring tests for the changed path. An observation without a reproducible wrong outcome is not a fix task.

---
