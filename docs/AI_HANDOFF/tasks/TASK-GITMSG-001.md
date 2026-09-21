# TASK-GITMSG-001 — Commit-gen core: single-flight gate, cancel channel, stage progress

- Status: `ready`
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
