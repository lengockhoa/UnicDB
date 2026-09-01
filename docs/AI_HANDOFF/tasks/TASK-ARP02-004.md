# TASK-ARP02-004 — Host integration: post-RLX-02 deactivate/command ordering (may close as not-needed)

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP02.md` §3, §4 (ARP-02.4)

## Goal

After Wave 1 (TASK-ARP02-001/002/003) closes the runner/panel/manager ownership gaps, audit the
extension-host lifecycle surfaces and fix ONLY what Wave 1 left open. This is a verification task with an
explicit **decision gate** (mirrors TASK-ARP01-003): if Wave 1 leaves no host gap, close as **not-needed**
with evidence; a code change is produced only if a real gap remains.

Expected host surfaces to audit (source-verified on `main @ 367cb80`):
- `runStatements` (`src/extension.ts:1689-1727`) — `panel.setBusy(true)` `:1713`, awaits
  `runner.run(...)`, then `finally { panel.setBusy(false) }` `:1725`. If the panel was disposed mid-run and
  a new run recreated it, the old finally clears the NEW run's busy — a host-side busy leak the panel
  epoch (TASK-ARP02-002) does NOT close (it is extension code calling `panel.setBusy`).
- `deactivate()` (`src/extension.ts:1012-1040`) — disposes panels/resources without awaiting in-flight
  runner work; confirm no unhandled rejection path on reload.
- RLX-02 command await semantics — `runner.cancel()` awaited before `panel.setBusy(false)`
  (`src/extension.ts:476-486`). MUST remain untouched (regression).

## Target Files

- `src/extension.ts` — ONLY if the gate finds a host gap. Expected: NO change (see gate).
- `src/extension.test.ts` — ONLY if a change is produced. Expected: NO change.
- If neither changes, this task produces NO code diff — only the evidence record.

## Test Cases (REQUIRED — TDD)

RED-first applies only if a change is produced (a failing test written before it). If the decision gate
closes as not-needed, the verification cases below are run as evidence and documented as GREEN.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | decision | host-gap gate | if Wave 1 closes with no host gap → close as not-needed; record `git diff 367cb80 -- src/extension.ts` (EMPTY) as evidence | run after 001+002+003 |
| 2 | edge (only if gap) | `runStatements` finally `setBusy(false)` after mid-run dispose+recreate | the old run's finally must NOT clear the NEW run's busy (either guarded via the panel epoch or ordered correctly) | panel + runner stubs; dispose mid-`runner.run`, start new run, settle old |
| 3 | edge (only if gap) | `deactivate()` ordering: panels disposed after in-flight runner work settles | no unhandled promise rejection; each panel disposed exactly once | activation fixture, deferred runner work |
| 4 | regression | RLX-02 command await semantics preserved | `runner.cancel()` is awaited BEFORE `panel.setBusy(false)` in the cancel command path (`extension.ts:476-486`) | existing command test / fixture |

## Test Files

- `src/extension.test.ts` — ONLY if a change is produced (cases 2/3). Expected: NO change.

## Verification Commands

```bash
git diff 367cb80 -- src/extension.ts
git diff 367cb80 -- src/extension.test.ts
npx vitest run src/extension.test.ts     # only if a change was produced
npm run typecheck
npm run compile
```

(Selection per RULES: `extension.ts` → `.cache/index/tests-map.json` =
`[src/extension.test.ts, src/__tests__/extensionAutocomplete.test.ts,
src/__tests__/extensionConfigExport.test.ts, src/ai/omp/__tests__/mcpExtensionRegistry.test.ts]`. The
pinned test target is `src/extension.test.ts`. No lint script; typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] Decision recorded: either **closed as not-needed** (both diffs empty) OR a host-gap fix with a
      RED-first proof. Record which, with the exact diff output in the Executor Report.
- [ ] If closed as not-needed: the evidence checklist is satisfied and pasted; no code change produced.
- [ ] If a change WAS produced: it is owned by this task only (wave 2 — no same-wave collision);
      RED-first proof pasted; `extension.ts`/`extension.test.ts` are the ONLY diff.
- [ ] RLX-02 command await semantics (`extension.ts:476-486`) byte-identical to base — regression case 4
      documented as GREEN.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `TASK-ARP02-001`, `TASK-ARP02-002`, `TASK-ARP02-003` (wave 2 — runs only after all three wave-1 tasks are
  done; the host-gap determination depends on what the panel epoch and runner ownership already closed).

## Interfaces

- Consumes (read-only for the gate):
  - `ResultsPanel.setBusy(busy: boolean)` — `src/ui/resultsPanel.ts:391-396`.
  - `ResultsPanel.dispose()` — `:401-412`; `ResultsPanel` session epoch (if TASK-ARP02-002 landed one).
  - `QueryRunner.cancel()` / `run()` / `isRunning()` — `src/core/queryRunner.ts`.
  - `ConnectionManager.getAdapter()` — `src/core/connectionManager.ts:543`.
- Produces: nothing (expected) — or a host-lifecycle fix consumed only by `src/extension.ts` and its test.

## Discussion

- Wave 1 is EXPECTED to reveal the `runStatements` finally-busy gap (it is extension code, deliberately
  outside TASK-ARP02-002's file ownership). If TASK-ARP02-002's epoch fully covers every continuation and
  the executor judges the busy leak closed at the panel, that is a legitimate closed-as-not-needed outcome
  — but the reasoning must be explicit and evidence-backed (git diffs + a test assertion in the existing
  suite or a documented manual check).
- Do not reimplement RLX-02 adapters/seam, add server kill SQL, or use pool close as cancellation
  (roadmap Out). The RLX-02 command path stays as shipped.
- (no comments yet)

---

## Executor Report

```
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT (if a change was
 produced) / DECISION (closed-as-not-needed evidence OR gap-fix summary) / VERIFICATION output /
 ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
