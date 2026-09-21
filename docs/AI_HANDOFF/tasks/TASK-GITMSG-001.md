# TASK-GITMSG-001 — Commit-gen core: single-flight gate, cancel channel, stage progress

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-001, FR-002, FR-003, FR-004 (§5); API §8.1–§8.3; edge cases §10

## Goal

Land the pure/testable half of the commit-gen UX fix: a single-flight gate
module, the `report`/`isCancelled` ports + frozen stage strings +
`COMMIT_GEN_TIMEOUT_MS` on `runGenerateCommitMessage`, and the
`ProviderRequest.signal` cancel channel through `complete()`. Host wiring
(extension.ts, omp driver) is TASK-GITMSG-002.

## Target Files

- `src/ai/commitGenGate.ts` — NEW: `createCommitGenGate()` (SPEC §8.1).
- `src/ai/commitGenCommand.ts` — add `COMMIT_GEN_TIMEOUT_MS`,
  `TOAST_GENERATION_IN_PROGRESS`, `PROGRESS_*` consts; `CommitGenDeps`
  gains `report?`/`isCancelled?`; `OmpOneShot` gains `cancel?()`;
  `runGenerateCommitMessage` reports stages + returns silently on cancel.
- `src/ai/provider.ts` — `ProviderRequest` gains `signal?: AbortSignal`;
  `complete()` links it to its internal AbortController (abort propagates;
  pre-aborted rejects before fetch).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | gate acquire→release→acquire | first acquire returns a function; after calling it, a second acquire succeeds | fresh `createCommitGenGate()` |
| 2 | edge (re-entrancy) | acquire while held | returns `null`; calling the release twice does not throw and the slot frees exactly once | gate with one outstanding acquire |
| 3 | unit (happy) | stage reporting order | `deps.report` receives `PROGRESS_COLLECTING_DIFF` → `PROGRESS_CONTACTING_MODEL` → `PROGRESS_VALIDATING` in order on the builtin happy path | fake deps, builtin engine, valid message |
| 4 | edge (cancel) | `isCancelled()` true after diff | `runGenerateCommitMessage` returns without calling `builtinComplete`, `setInputBox`, or any toast | fake deps with `isCancelled: () => true` |
| 5 | regression | `builtinComplete` receives `req.signal` | the fake port observes `req.signal` is an `AbortSignal` (fails today — field absent) | fake deps capturing the request |
| 6 | edge (boundary) | pre-aborted signal into `complete()` | rejects (AbortError→ProviderError) and `fetch` is never called | `createProviderClient` with fake `fetch` spy, `req.signal` already aborted |
| 7 | edge (concurrent) | external abort mid-flight | an in-flight `complete()` rejects when `req.signal` aborts; internal timeout timer cleared | fake `fetch` that never resolves + `AbortController` |
| 8 | unit (happy) | `COMMIT_GEN_TIMEOUT_MS` export | `=== 120_000`, exported from `src/ai/commitGenCommand.ts` | import the module |
| 9 | edge (timing) | cancel mid-retry | `isCancelled` true at the post-outcome checkpoint after a guard retry → silent return: no `setInputBox`, no toast | fake deps: first `builtinComplete` outcome fails the guard → retry; `isCancelled` flips true inside the retry call |

## Test Files

- `src/ai/__tests__/commitGenGate.test.ts` — NEW, cases 1–2.
- `src/ai/__tests__/commitGenCommand.test.ts` — extend, cases 3–5, 8–9.
- `src/ai/__tests__/provider.test.ts` — extend, cases 6–7.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/commitGenGate.test.ts src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/provider.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for #5–#7).
- [ ] `createCommitGenGate` exported from `src/ai/commitGenGate.ts`; no `vscode` import in any touched file.
- [ ] `COMMIT_GEN_TIMEOUT_MS === 120_000`; all `PROGRESS_*`/`TOAST_GENERATION_IN_PROGRESS` consts exported.
- [ ] `ProviderRequest.signal` consumed by `complete()`; existing timeout behavior unchanged when `signal` absent.
- [ ] No regression in `src/ai/__tests__/` suites.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - `createCommitGenGate(): { acquire(): (() => void) | null }` — `src/ai/commitGenGate.ts`
  - `COMMIT_GEN_TIMEOUT_MS: 120_000`, `TOAST_GENERATION_IN_PROGRESS`, `PROGRESS_COLLECTING_DIFF | PROGRESS_CONTACTING_MODEL | PROGRESS_VALIDATING | PROGRESS_RETRYING` — `src/ai/commitGenCommand.ts`
  - `CommitGenDeps.report?(message: string): void`, `CommitGenDeps.isCancelled?(): boolean`, `OmpOneShot.cancel?(): void` — `src/ai/commitGenCommand.ts`
  - `ProviderRequest.signal?: AbortSignal` — `src/ai/provider.ts`

---

## Discussion

### 2026-09-21 · planner · unic-smart
Cancel UX: silent close (no toast, no injection) — SPEC §14 Q4. The
`PROGRESS_RETRYING` stage fires inside the `generateWithGuard` call closure
on the second attempt only; keep the report call adjacent to the retry
branch, not inside `generateWithGuard` (its signature is frozen).

## Progress

- 2026-09-21T21:23:11+0700 · milestone: red→green — gate + progress/cancel ports + provider signal · last-green: `npx vitest run src/ai/__tests__/commitGenGate.test.ts src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/provider.test.ts` (74 pass) + `npm run typecheck` (0 errors) + `npx vitest run src/ai/__tests__/` (395 pass, 1 skipped — no regression) · files: src/ai/commitGenGate.ts, src/ai/commitGenCommand.ts, src/ai/provider.ts, src/ai/__tests__/commitGenGate.test.ts, src/ai/__tests__/commitGenCommand.test.ts, src/ai/__tests__/provider.test.ts · drift: none

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecG1
SUMMARY: Landed the pure/testable half of the commit-gen UX fix: new
  single-flight gate module (createCommitGenGate), frozen stage/timeout
  strings + report/isCancelled/signal ports on CommitGenDeps, cancel?() on
  OmpOneShot, stage reporting + silent cancel checkpoints in
  runGenerateCommitMessage, and ProviderRequest.signal linked into
  complete()'s AbortController (pre-aborted rejects before fetch; caller
  abort ≠ timeout).
TEST_PLAN_FOLLOWED: task §Test Cases — all 9 cases implemented (cases 1–2 in
  commitGenGate.test.ts; cases 3–5, 8–9 + a PROGRESS_RETRYING pin in
  commitGenCommand.test.ts; cases 6–7 in provider.test.ts)
FILES_CHANGED:
  - src/ai/commitGenGate.ts: NEW — createCommitGenGate() single-flight slot,
    idempotent release (SPEC §8.1)
  - src/ai/commitGenCommand.ts: COMMIT_GEN_TIMEOUT_MS=120_000,
    TOAST_GENERATION_IN_PROGRESS, PROGRESS_* consts; CommitGenDeps gains
    report?/isCancelled?/signal?; OmpOneShot gains cancel?();
    runGenerateCommitMessage reports stages, checks isCancelled post-diff
    and post-outcome, passes signal on builtinComplete requests, reports
    PROGRESS_RETRYING on the corrective attempt only
  - src/ai/provider.ts: ProviderRequest gains signal?: AbortSignal;
    complete() links it to the internal AbortController, rejects
    pre-aborted before fetch, maps caller abort to non-timeout ProviderError
  - src/ai/__tests__/commitGenGate.test.ts: NEW — cases 1–2
  - src/ai/__tests__/commitGenCommand.test.ts: +6 tests — cases 3–5, 8–9,
    PROGRESS_RETRYING order pin
  - src/ai/__tests__/provider.test.ts: +2 tests — cases 6–7
TESTS_ADDED:
  - src/ai/__tests__/commitGenGate.test.ts: acquire→release→acquire;
    acquire-while-held + idempotent release
  - src/ai/__tests__/commitGenCommand.test.ts: stage order; isCancelled
    post-diff silent return; req.signal is AbortSignal;
    COMMIT_GEN_TIMEOUT_MS===120_000; cancel mid-retry silent return;
    PROGRESS_RETRYING only on retry
  - src/ai/__tests__/provider.test.ts: pre-aborted signal rejects before
    fetch; external abort mid-flight rejects + timer cleared
RED_OUTPUT: |
  FAIL src/ai/__tests__/commitGenGate.test.ts — Failed to load url
    ../commitGenGate (module did not exist)
  FAIL commitGenCommand.test.ts — 6 failed: stage order, isCancelled silent
    return, req.signal AbortSignal, COMMIT_GEN_TIMEOUT_MS export,
    cancel mid-retry, PROGRESS_RETRYING (exports/ports absent)
  FAIL provider.test.ts — 2 failed: "expected Error: should have thrown to
    be an instance of ProviderError" (pre-aborted); mid-flight abort test
    timed out (signal not linked)
VERIFICATION:
  command: npx vitest run src/ai/__tests__/commitGenGate.test.ts src/ai/__tests__/commitGenCommand.test.ts src/ai/__tests__/provider.test.ts
  result: 74 pass / 0 fail
  output_excerpt: |
    ✓ src/ai/__tests__/commitGenGate.test.ts  (2 tests) 2ms
    ✓ src/ai/__tests__/provider.test.ts  (46 tests) 14ms
    ✓ src/ai/__tests__/commitGenCommand.test.ts  (26 tests) 9ms
    Test Files 3 passed (3)
    Tests 74 passed (74)
  command: npm run typecheck
  result: exit 0 — 0 errors
  command: npx vitest run src/ai/__tests__/
  result: 395 pass / 0 fail / 1 skipped (live smoke) — no regression
ISSUES: none — CommitGenDeps gained an optional `signal?: AbortSignal` port
  beyond the frozen §8.2 list; required so GITMSG-002 can wire the progress
  token's AbortController into builtinComplete (FR-003). Optional, so the
  frozen shape is preserved.
HANDOFF_TO_REVIEWER: yes — handoff mode; task status set to done, ready for
  reviewer pickup per pipeline.
NEXT: ready for review — TASK-GITMSG-002 consumes these exports for host
  wiring (extension.ts gate + withProgress token + omp driver cancel).
```
