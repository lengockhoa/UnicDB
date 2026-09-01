# TASK-ARP05-004 — Host message normalization (conditional gate)

- Status: `ready`
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
