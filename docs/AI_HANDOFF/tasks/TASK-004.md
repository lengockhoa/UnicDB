# TASK-004 — omp audit: code quality, coverage gaps, error paths, performance (READ-ONLY)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1 (P0.2), §2, §4 (audit row)

## Goal

Review the seven `src/ai/omp/` modules and produce a findings report appended to THIS task file — code quality, test-coverage gaps, error paths, performance. Findings are the deliverable; they queue next cycle's work. NO production code changes.

## Target Files

- `docs/AI_HANDOFF/tasks/TASK-004.md` — the report is appended under `## Audit Report` below.
- READ-ONLY inputs: `src/ai/omp/detect.ts`, `acp.ts`, `acpProcess.ts`, `hostMcp.ts`, `mcpBridge.ts`, `ompChatEngine.ts`, `mcpExtensionRegistry.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| N/A | — | audit-only task, no production code | See justification | — |

Justification: this task intentionally ships zero code, so there is no test cycle. The verifiable deliverable is the report, gated by the acceptance checklist below (report completeness + `git diff --stat src/ai/omp` empty + suite still green).

## Test Files

- (none — no code produced; existing suites must stay green untouched)

## Verification Commands

```bash
git diff --stat -- src/ai/omp   # must print NOTHING — TASK-004 is read-only against src/ai/omp
# (broader `-- src/ai src/ui` diffs are wave-unsafe: wave-mates TASK-001/013 edit tracked files there)
npx vitest run src/ai/omp/__tests__/detect.test.ts src/ai/omp/__tests__/acpProcess.test.ts
npm run typecheck
```

No lint script exists in this project — lint is N/A; typecheck is the static gate.

## Acceptance Criteria

- [ ] `## Audit Report` section exists in this file with one subsection per audited module (all 7).
- [ ] ≥ 1 finding per module; every finding has: file:line, severity (`critical | important | minor`), category (`quality | coverage | error-path | performance`), and a concrete next-cycle action.
- [ ] At least 2 findings are test-coverage gaps naming the exact missing test file/case.
- [ ] At least 1 finding proposes a concrete refactor candidate (e.g. "extract shared AgentChatEngine interface from ompChatEngine") — the natural home for the duplication this cycle's mirroring creates.
- [ ] `src/ai/omp/` untouched: `git diff --stat -- src/ai/omp` prints nothing (paste proof in Executor Report). Entries under other `src/ai`/`src/ui` paths in the shared-tree diff belong to wave-mates (TASK-001/013) and are NOT this task's responsibility.

## Dependencies

- (none) — runs parallel with wave 1; findings may reference TASK-005..011 designs.

## Interfaces

- Consumes: (none — read-only)
- Produces: `## Audit Report` in this file — TASK-014 appends a follow-up note marking which findings this cycle already addressed; next cycle's planner consumes the queue.

---

## Discussion

### 2026-09-07 · planner · unic-smart
Deliberately read-only per user P0.2 ("NO rewrite this cycle"). If you find a critical_block-severity issue, do NOT fix it — record it with severity `critical` and a next-cycle action, and flag it in your Executor Report summary.

## Audit Report

(appended by executor in Phase 3)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
