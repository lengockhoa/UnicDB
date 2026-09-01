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
STATUS: PASS
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: N/A — verification-gate task (close-as-not-needed evidence below). Per task
  §Test Cases, RED-first applies only if a change is produced; none was.
DECISION: closed-as-not-needed
SUMMARY: No code change. Decision gate satisfied: both task-owned files are byte-identical
  to base a948b3f, and the compile/runtime evidence shows no optional-API bypass exists.

EVIDENCE (decision gate — task case 4):
  command: git diff a948b3f -- src/adapters/types.ts
  result: EMPTY (exit 0, no output)
  command: git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts
  result: EMPTY (exit 0, no output)
  (Diffstat a948b3f..HEAD touches neither file — wave 1 changed only src/core/* and docs.)

EVIDENCE (no-bypass audit — task cases 1-3 + security-review acceptance item):
  - Optional execution APIs on DbAdapter (src/adapters/types.ts), reviewed one by one:
      runQuery (required)      → wrapped by guardAdapter under readOnly
                                 (src/core/connectionManager.ts:654-667, isMutationSql gate).
      beginTransaction? (:123) → wrapped at :674-687: each call re-wraps tx.runQuery through
                                 the SAME isMutationSql gate before the driver sees the SQL;
                                 commit/rollback pass through by design (boundary semantics —
                                 no SQL channel). Runtime proof already in wave 1:
                                 connectionManager.test.ts "ConnectionManager ARP-01
                                 transaction guard" cases 1-7 (mutation throws
                                 ReadOnlyViolation BEFORE driver; per-call freshness;
                                 values passthrough; no-tx adapters gain nothing).
      cancelActiveQuery?       → not a SQL execution channel (destroys the in-flight
                                 statement; never issues user SQL). No bypass.
      renameUsage?/catalog?    → introspection/read-only lookups; no user-SQL channel.
      admin?                   → buildGrantSql/buildRevokeSql are string builders only;
                                 execution of admin SQL routes through the guarded
                                 adapter.runQuery behind confirmDangerousStatements
                                 (src/extension.ts:864-875). No bypass.
      capabilities?            → declarative matrix; hasAdapterCapability is fail-closed.
    BatchedQuery (returned by runQuery) exposes fetchBatch/cancel/close — no SQL channel.
  - Acquisition-path audit: resolveAdapter() is called WITHOUT guardAdapter only at
    src/core/connectionManager.ts:159 and :214 (add/edit test-connect probes) — both
    adapters only ever call testConnection() and are closed in finally; no execution API
    is reachable there. Every consumer-facing path (getAdapter :543, getAdapterFor :343,
    getAdapterWithPassword :399) returns guardAdapter(...)-wrapped adapters (:361/:399).
  - Type-level fixtures (task cases 1 & 2, compile-time): a throwaway strict-tsc fixture
    consuming the exact DbTransaction members and a guarded surface
    { runQuery; beginTransaction?: () => Promise<DbTransaction> } satisfies DbAdapter
    compiled with exit 0 (positive), and the same fixture with a corrupted member
    signature failed with TS2322 (negative control — proof not vacuous). Fixture was
    throwaway and deleted; owned files remain byte-identical (git status clean).
  - Runtime fixture proof (task case 3): judged NOT necessary as a new fixture — the
    property is already pinned at runtime by wave-1 connectionManager.test.ts cases 1-7
    plus the existing beginTransaction routing coverage in adapterQueryShape.test.ts
    ("metadata-vs-window" regression) which exercise the real guarded adapter surface.

FILES_CHANGED: none (closed as not-needed)
TESTS_ADDED: none
VERIFICATION:
  command: npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts
  result: exit 0 — Test Files 1 passed, Tests 53 passed (53)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit, clean)
  command: npm run compile
  result: exit 0 (esbuild: build complete)
  command: npm test
  result: exit 1 — Test Files 1 failed | 214 passed | 1 skipped; Tests 1 failed |
          2962 passed | 2 skipped. The single failure is
          src/__tests__/releaseHygiene.test.ts "lock root version khớp package.json"
          (package-lock.json root 1.35.0 vs package.json 1.36.0). Verified PRE-EXISTING
          at base: git show a948b3f:package-lock.json → version 1.35.0, and
          git diff a948b3f..HEAD -- package.json package-lock.json is EMPTY. Not caused
          by wave 1 or this task; package-lock.json is not a task-owned file so it was
          left untouched per constraints. (First npm test run before compile showed 12
          consolePanelBundle failures — all "dist/consolePanel.js missing — run
          npm run compile before this test", i.e. ordering-only; gone after compile.)

ISSUES: pre-existing releaseHygiene lockfile-version drift (repo state, outside task
  scope) — recommend a tiny follow-up task to sync package-lock.json root version to
  1.36.0 so the full wave-2 regression net is green.
HANDOFF_TO_REVIEWER: yes — all task Verification Commands pass; decision gate + evidence
  recorded; reviewer (unic-smart) to confirm APPROVED / APPROVED-WITH-MINOR per acceptance.
NEXT: ready for review; follow-up: lockfile version sync (non-blocking).
```

## Reviewer Verdict

REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERDICT:
VERIFICATION_RERUN:
TEST_PLAN_COVERAGE:
FINDINGS:
NOTES:
