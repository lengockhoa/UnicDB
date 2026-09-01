# TASK-ARP01-003 — Interface regression: prove no optional-API bypass (may close as not-needed)

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP01.md` §3, §4 (ARP-01.3)

## Goal

After ARP-01.1 (classifier) and ARP-01.2 (transaction guard) land, verify that the
optional execution API — `DbAdapter.beginTransaction?()` (`src/adapters/types.ts:123`) and
`DbTransaction.runQuery()` (`:92`) — has no bypass path, and that no interface signature
changed. This is a verification task with an explicit **decision gate**: if the evidence
shows `src/adapters/types.ts` AND `src/adapters/__tests__/adapterQueryShape.test.ts` are
byte-identical to base, close as **not-needed** with the evidence documented. A code change
is only produced if the evidence reveals a real gap.

## Target Files

- `src/adapters/types.ts` — ONLY if a helper type change is strictly required by the
  evidence. Expected: NO change.
- `src/adapters/__tests__/adapterQueryShape.test.ts` — ONLY if a fixture change is genuinely
  needed to prove the no-bypass property. Expected: NO change.
- If neither changes, this task produces NO code diff — only the evidence record below.

## Test Cases (REQUIRED — TDD)

RED-first applies only if a change is produced (a failing test written before it). If the
decision gate closes as not-needed, the verification cases below are run as evidence and
documented as GREEN (type-level, already covered by `npm run typecheck`).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy (type) | `DbTransaction` interface shape unchanged | a typed fixture consuming `runQuery(sql: string, values?: unknown[])` / `commit()` / `rollback()` compiles — i.e. no member was added/renamed/dropped | compile-time only (`npm run typecheck`) |
| 2 | edge (type) | guarded adapter still satisfies `DbAdapter` | an object exposing `runQuery` + optional `beginTransaction?(): Promise<DbTransaction>` typechecks as `DbAdapter` (proves the wrap didn't change the shape) | compile-time only |
| 3 | edge (runtime) | no optional-API bypass on a guarded adapter | the ONLY way to obtain a transaction on a guarded adapter is `beginTransaction()`, and that path is wrapped (already proven at runtime by TASK-ARP01-002 case 2). IF you judge a fixture-level proof necessary, add it to `adapterQueryShape.test.ts` | runtime; only if change produced |
| 4 | decision | close-as-not-needed gate | `git diff a948b3f -- src/adapters/types.ts` AND `git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts` both EMPTY → close with documented rationale | git diff on base a948b3f |

## Test Files

- `src/adapters/__tests__/adapterQueryShape.test.ts` — only if case 3 requires a fixture
  change. Otherwise untouched (still run it as a regression).

## Verification Commands

```bash
git diff a948b3f -- src/adapters/types.ts
git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts
npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
npm run typecheck
npm run compile
```

(Selection: `types.ts` resolves to ZERO tests in `.cache/index/tests-map.json`, so per RULES
the task pins its own test file — `adapterQueryShape.test.ts` — directly. The repo has no
`test:release-core`/lint script; the focused vitest run + typecheck + compile are the gates.)

## Acceptance Criteria

- [ ] Decision recorded: either **closed as not-needed** (both diffs empty) OR a fixture
      change with a RED-first proof. Record which, with the exact diff output in the
      Executor Report.
- [ ] If closed as not-needed: the evidence checklist above is satisfied and pasted; no code
      change produced.
- [ ] If a change WAS produced: it is owned by this task only, no same-wave file collision
      (wave 2 — ARP-01.1/02 already done), RED-first proof pasted, and `types.ts`/
      `adapterQueryShape.test.ts` changes are the ONLY diff.
- [ ] `npm run typecheck` + `npm run compile` exit 0 (interface consumers — resultsPanel,
      queryRunner, importExecute, all adapters — still compile against the unchanged shapes).
- [ ] Security-review evidence recorded: every optional execution API on `DbAdapter`/
      `DbTransaction` reviewed for bypass (roadmap acceptance item), noting the transaction
      boundary is the one that TASK-ARP01-002 now guards at the `guardAdapter` seam.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `TASK-ARP01-001`, `TASK-ARP01-002` (wave 2 — runs only after both wave-1 tasks are done;
  the no-bypass claim depends on the transaction guard being present).

## Interfaces

- Consumes (read-only verification):
  - `DbAdapter.beginTransaction?(): Promise<DbTransaction>` — `src/adapters/types.ts:123`.
  - `DbTransaction.runQuery(sql: string, values?: unknown[]): Promise<RunResult>` —
    `src/adapters/types.ts:92`.
  - `ReadOnlyViolation` — `src/core/readOnlyIntent.ts:12`.
  - `ConnectionManager.getAdapterFor(cfg: ConnectionConfig): Promise<DbAdapter>` —
    `src/core/connectionManager.ts:343` (returns the guarded adapter).
- Produces: nothing (expected) — or a documented type helper/fixture consumed only by
  `adapterQueryShape.test.ts`.

## Discussion

(no comments yet)

---

## Executor Report

```
STATUS:
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY:
DECISION: closed-as-not-needed | change-produced   (pick one)
EVIDENCE:
  command: git diff a948b3f -- src/adapters/types.ts
  result: <paste — expect empty>
  command: git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts
  result: <paste — expect empty>
RED_FIRST: <only if a change was produced>
FILES_CHANGED:
TESTS_ADDED:
VERIFICATION:
  command: npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
  result:
  command: npm run typecheck
  result:
  command: npm run compile
  result:
ISSUES:
HANDOFF_TO_REVIEWER:
NEXT:
```

## Reviewer Verdict

REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERDICT:
VERIFICATION_RERUN:
TEST_PLAN_COVERAGE:
FINDINGS:
NOTES:
