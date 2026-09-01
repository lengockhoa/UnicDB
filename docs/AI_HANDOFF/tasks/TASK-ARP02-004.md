# TASK-ARP02-004 — Host integration: post-RLX-02 deactivate/command ordering (may close as not-needed)

- Status: `pending_review`
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
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

DECISION: gap-fix produced (NOT closed-as-not-needed).

The decision gate found TWO real host gaps that Wave 1 (panel-internal session epoch,
TASK-ARP02-002) cannot close, because the offending calls are extension code calling INTO
ResultsPanel, not panel continuations:

  Gap #2 — runStatements finally-busy leak (src/extension.ts ~:1726-1759 now):
  the shared QueryRunner rejects a second concurrent run() with
  "QueryRunner is already running"; the overlapping invocation's
  `finally { panel.setBusy(false) }` still fired WHILE the first run was in
  flight — clearing the live session's busy state (and, after a mid-run
  dispose+recreate, the newest panel would read not-busy while a query is
  still running).

  Gap #1 — deactivate() ordering (src/extension.ts ~:1023-1035 now):
  deactivate() disposed module disposables but nothing bounded an in-flight
  runStatements: a late completion still called panel.render(...) after
  teardown started (2 escaping renders proven in RED), which can even
  resurrect the webview via ResultsPanel.show() into a disposed context.

RED_OUTPUT (npx vitest run src/extension.test.ts -t "TASK-ARP02-004", before implementation):
    ❯ src/extension.test.ts  (88 tests | 2 failed | 85 skipped) 101ms
   ❯ Gap #2 — overlapping runQuery: the stale invocation's finally must NOT clear the live run's busy state
     → expected [ [ false ] ] to have a length of +0 but got 1
   ❯ Gap #1 — deactivate() during an in-flight run: late completion must not render into the disposed panel
     → expected 2 to be +0 // Object.is equality
    Test Files  1 failed (1)
         Tests  2 failed | 1 passed | 85 skipped (88)
Both failures are for the EXPECTED reasons (a setBusy(false) escaping mid-run; two
renders escaping past deactivate). Case #4 (RLX-02 regression lock) is GREEN by design —
it is an invariant lock, not a bug repro, so its immediate GREEN is correct, not suspicious.

IMPLEMENTATION (src/extension.ts only, +3 gates, no flow change):
  1. `const ownsRun = !runner.isRunning();` snapshotted synchronously right
     before `panel.setBusy(true)` — no await between snapshot and runner.run(),
     so it cannot go stale before run() validates internally. Only the
     invocation that found the runner idle (and therefore owns this run) may
     clear busy in its finally: `if (ownsRun && !deactivating) panel.setBusy(false)`.
  2. Module-level `let deactivating = false;` sentinel — set synchronously at
     deactivate() entry, reset at activate() entry (reload ⇒ new session, same
     discipline as `disposables`).
  3. `runStatements` panel writes (both renders + the finally busy-clear) are
     gated on `!deactivating`, so a run settling after teardown started never
     renders into (or resurrects) a disposed panel.

  Test-plan note: cases 2 and 3 from §Test Cases were implemented as overlap
  and deactivate tests against the real QueryRunner/ResultsPanel via a
  deferred-adapter seam (only ConnectionManager.getAdapter is stubbed — the
  REAL QueryRunner, REAL runStatements, REAL ResultsPanel execute).

VERIFICATION OUTPUT (all run fresh in this turn, in the worktree):
  git diff 367cb80 -- src/extension.ts      → NON-EMPTY (gap-fix diff above), exit 0
  git diff 367cb80 -- src/extension.test.ts → NON-EMPTY (266 added test lines), exit 0
  npx vitest run src/extension.test.ts      → Tests 88 passed (88), exit 0
  npm test                                  → Tests 2983 passed | 2 skipped (2985),
                                              215 files passed | 1 skipped, exit 0
                                              (baseline 2974 + 3 new = 2977 floor; 2983 ✓)
  npm run typecheck                         → exit 0
  npm run compile                           → exit 0

  Regression #4 (RLX-02 await semantics): byte-compared the vsdb.cancelQuery
  block (extension.ts:486-496) against `git show 367cb80:src/extension.ts` —
  byte-identical ("RLX02_BLOCK_BYTE_IDENTICAL"), plus locked by a live test
  proving runner.cancel() is awaited BEFORE panel.setBusy(false).

ISSUES:
  - One pre-existing, environmental failure observed mid-run before `npm run
    compile` had ever run in this fresh worktree: "npm run compile emits
    dist/schemaForm.js" reads dist/ at module-init. Resolved by running the
    task's own compile gate; final full-suite run is 100% green.
  - Out-of-scope observation (NOT changed, different file owner):
    src/ui/browseCommands.ts:181-193 has the same unguarded
    finally { panel.setBusy(false) } shape around the shared runner. It is
    outside this task's Target Files; flagged for a future wave.

HANDOFF_TO_REVIEWER: yes — reviewer verdict pending (unic-smart must differ
from executor unic-code). Set status pending_review in INDEX.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```

## Reviewer Report

REVIEWER_MODEL: unic-smart
ROUND: 1
VERDICT: APPROVED-WITH-MINOR

Findings:
- minor (residual host gap, pre-existing, out of this task's file ownership — recorded for follow-up): `src/ui/browseCommands.ts:169-177` still has the exact unguarded shape this task removed from runStatements — `panel.setBusy(true); await runner.run(...); } catch { toast } finally { panel.setBusy(false); }`. When a browse command overlaps a live runStatements (same shared runner/panel singleton), the browse `finally` still clears the live run's busy (and its `panel.render` at :172 is not gated on the `deactivating` sentinel). The ownsRun fix is correct within extension.ts scope; the same ownership gate (`if (ownsRun) panel.setBusy(false)` + `if (!deactivating) render`) should be applied there in a follow-up wave. Executor already flagged this — not a regression, not blocking this task.
- minor (test-plan wording nuance): §4 case 2 describes "mid-run dispose+recreate", but the actual extension-level host gap is the overlap of two invocations on the shared singleton runner (dispose+recreate is the panel epoch's domain, ARP-02.2). The implemented Gap #2 test targets the real manifestation and proves the intended invariant (stale finally never clears the live run's busy) — acceptable adaptation, RED-first output is real.
- Otherwise none.

NOTES: Model isolation passes (executor unic-code != reviewer unic-smart; config `handoff.reviewer.model` = unic-smart). Verification re-run in worktree: `npx vitest run src/extension.test.ts` 88/88 PASS; `npm run typecheck` exit 0; `npm run compile` exit 0; full `npm test` 2983 passed | 2 skipped (baseline ≥2963). RLX-02 `vsdb.cancelQuery` block byte-identical to base (verified via diff). ownsRun snapshot has no await between snapshot and `runner.run()` so it cannot go stale; busy cannot get stuck true via any runStatements overlap (the owning invocation always runs its finally); no path where ownsRun reports live but the run is stale. deactivating sentinel resets at activate() entry, gates only panel writes (render/setBusy), does NOT suppress DB work or error notifications (catch still toasts), and a stale continuation across a re-activation still closes over the OLD disposed panel object so it cannot render into a recreated panel. Gap #2/#1 tests are deterministic (parked adapter + microtask/macrotask flush), not flaky.
NEXT_STATUS_FOR_INDEX: approved_minor
