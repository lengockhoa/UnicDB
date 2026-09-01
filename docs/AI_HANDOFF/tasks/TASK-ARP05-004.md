# TASK-ARP05-004 — Host message normalization (conditional gate)

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§4 (ARP-05.4)

## Goal

Normalize the connect-failure host message in `src/core/connectionManager.ts` — actionable and non-secret —
**only if** the ARP-05.0 ADR measurement shows the current error UX is the gap (e.g. MySQL's infinite-queue
wait surfaces as a bare generic pool timeout with no actionable hint). If the measurement shows the current
rethrow is already actionable, close as **not-needed** with `git diff` evidence (mirrors TASK-ARP04-004).

## Target Files

- `src/core/connectionManager.ts` — **only if a host-message gap is found** (see the §2 gate). Default
  expectation: no change (closed not-needed).
- `src/core/__tests__/connectionManager.test.ts` — **only if a change is produced**.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | decision | host-message gate | if the wave-1 ADR measurement shows the connect-failure UX already actionable → close as not-needed with `git diff 65b9c4f -- src/core/connectionManager.ts` evidence (empty diff) | — |
| 2 | edge: content (only if gap) | connect failure surfaces an actionable message | the surfaced failure keeps host/port/driver + the actionable hint (e.g. "connection in use / pool exhausted"); the hint text is present — not a bare generic timeout with no diagnostic | a probe `testConnection` that rejects with a host/port error; assert the surfaced message contains the actionable hint + host/port |
| 3 | edge: secret-redaction (only if gap) | no secret/credential leak in the surfaced message | a driver error that embeds the password/DSN (e.g. a `mysql.ts` pool error containing the credential) is stripped before surfacing; the message contains NO password/DSN fragment | a probe `testConnection` that rejects with a secret-bearing message; assert the surfaced message has no credential |
| 4 | regression (only if gap) | `testConnection` rethrow preserved | `connectionManager.ts:395-402` still throws the candidate error after closing the probe adapter; no swallowed error | probe adapter rejecting; assert the rethrow |

## Test Files

- `src/core/__tests__/connectionManager.test.ts` — only if a change was produced (cases 2–4).

## Verification Commands

```bash
git diff 65b9c4f -- src/core/connectionManager.ts      # gate evidence (empty if closed not-needed)
npx vitest run src/core/__tests__/connectionManager.test.ts   # only if a change was produced
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] The gate decision is recorded in the Executor Report: **closed-as-not-needed** (both diffs empty) OR a
  host-message normalization shipped with RED-first proof.
- [ ] If a change shipped: the gap-found path ships ≥2 edge cases of different kinds — case 2 (actionable
  message content present) and case 3 (no secret/credential leak in the surfaced message) — plus the
  `testConnection` rethrow regression (case 4); all three pass.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP05-000 — the ADR's measured error-UX evidence decides this task's gate.
- TASK-ARP05-001, TASK-ARP05-002, TASK-ARP05-003 — the wave-1 driver measurements feed the ADR that decides the gate.

## Interfaces

- Consumes: the ADR's "host message" conclusion; the driver error shapes surfaced by
  `adapter.testConnection()`. Grounding: `src/core/connectionManager.ts` — `addConnection` (:162-190,
  probe `testConnection` at :171), `editConnection` (:196-255, probe at :235), `getAdapter` (:359-402,
  rethrow at :395-402). The task reads only; any change stays inside `connectionManager.ts` + its test.
- Produces: (none) — this is the terminal task of the cycle. If a change ships, it is a message-normalization
  helper internal to `connectionManager.ts`.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code (orchestrator direct — conditional gate, verify-only closure; no worktree/agent needed)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
RED_OUTPUT: N/A — closed not-needed per task §Test Cases case 1 (gate branch); cases 2–4 are "only if gap" and no gap was found.
Verification Output:

Gate evidence (per task §Verification Commands):
1. `git diff 65b9c4f -- src/core/connectionManager.ts` → EMPTY (exit 0, no hunks, `--stat` empty). Production rethrow path unchanged by the whole cycle.
2. ADR §7 measured evidence (docs/decisions/0002-cross-driver-resilience-contract.md, `## Probe: MySQL`): the connect/queue failure surface that motivated ARP-05.4 was already made actionable by TASK-ARP05-002's bounded acquire — the late checkout rejects with `MySqlAdapter: acquire timed out after ${POOL_ACQUIRE_TIMEOUT_MS}ms (pool slot held by another query/stream/transaction)` (src/adapters/mysql.ts:688): driver+diagnosis+actionable hint, within the §5 SLO-1 10-second budget, no bare generic timeout.
3. Secret-redaction concern (task case 3, checked even though no change ships): the surfaced message is a template literal with only the bound and a fixed diagnosis string — no credential/DSN fragment can appear. The rethrow at connectionManager.ts:395-402 surfaces the driver error verbatim after closing the probe adapter (case 4 regression: unchanged, empty diff is the proof).
4. `npm run typecheck` → exit 0; `npm run compile` → build complete (run at the wave-1 boundary on the exact tree being reviewed).

Status: PASS
Note: Gate closed **not-needed** (task case 1 branch). The measured error UX is already actionable post-ARP05-002; a connectionManager.ts normalization would be a no-op wrapper. No test file, no production file touched.

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: git diff 85bf5cb..HEAD -- src/core/connectionManager.ts (gate) && npm run typecheck && npm run compile
  result: connectionManager.ts diff empty (0 lines); src/core/__tests__/connectionManager.test.ts diff empty; typecheck exit 0; compile exit 0
TEST_PLAN_COVERAGE: all-followed — case 1 (decision/gate branch, closed not-needed) exercised with evidence; cases 2-4 are "only if gap" and correctly not triggered.
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NOTES: Closed-not-needed is evidence-based and independently confirmed: (1) empty connectionManager.ts diff in range; (2) ADR ## Probe: MySQL records the post-002 actionable surface at src/adapters/mysql.ts:688 (`MySqlAdapter: acquire timed out after ${POOL_ACQUIRE_TIMEOUT_MS}ms (pool slot held by another query/stream/transaction)` — driver+diagnosis+actionable hint, within the 10s SLO budget, no bare generic timeout); (3) secret-redaction: the message template binds only the numeric bound + fixed string, no credential/DSN fragment; (4) rethrow at connectionManager.ts:395-402 preserved by the empty diff. Executor model unic-code != reviewer unic-smart — isolation OK.
