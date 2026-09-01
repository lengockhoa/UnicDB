# TASK-ARP05-001 — PostgreSQL pool isolation, failed-connect/close release, cancel recovery

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2–§4 (ARP-05.1)

## Goal

Pin the PostgreSQL adapter's finite-failure contract with unit tests: `PG_POOL_MAX = 4` isolates metadata
from pinned cursor/transaction work, failed `connect()` releases cleanly, `close()` with open cursors
resolves < 5s without hanging `pool.end()`, and `cancelActiveQuery` reaches the backend through a dedicated
client even when every pool slot is held. Production code changes only where a measurement proves a gap —
today the PG posture is deliberate (`postgres.ts:291-304`) and is expected to be pin-only.

## Target Files

- `src/adapters/postgres.ts` — **only if a probe proves a gap** (e.g. a pool-queue that wedges beyond the
  documented 10s, a `close()` path that hangs past the guards). Default expectation: no change (pin-only).
- `src/adapters/__tests__/postgres.test.ts` — **the owned test file**; add the ARP-05.1 cases below,
  reusing the existing pg-mock queue pattern (top-level `vi.mock("pg")` with module-scoped fake Pool/Client).
- `docs/decisions/0002-cross-driver-resilience-contract.md` — **append** the measured RED/GREEN probe results
  under a disjoint named section `## Probe: PostgreSQL` (per PLAN.md §3 wave-1 ADR-update protocol). Append-only,
  section-disjoint docs edit — the ADR is a docs file and this does not share a `src/` code file with any
  same-wave task. Paste the probe lines verbatim; do not modify wave-0 content or other tasks' sections.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (pin) | metadata does not queue behind a pinned cursor/transaction client | with a `pool.connect()` holding all `PG_POOL_MAX` slots, a metadata `pool.query` still runs on its own slot (no `connectionTimeoutMillis` fail) — pins pool isolation (`postgres.ts:291-314`) | fake `Pool` where `connect()` returns a held client; the 4th+ `connect()` succeeds on demand |
| 2 | edge: resource | `connect()` probe fails → no pool leak | `pool.connect()`/`query("SELECT 1")` throws → `pool.end()` called once, `this.pool` nulled; a second `connect()` builds a fresh pool | fake Pool whose probe rejects; `end` spy records calls |
| 3 | edge: resource | `close()` with an open cursor resolves < 5s | cursor `ROLLBACK` + `release(true)` fired, `pool.end()` raced vs the 3s guard resolves; `close()` never hangs past 5s | adapter with a registered open cursor record; fake pool.end() that hangs (tests the race guard) |
| 4 | edge: cancel | `cancelActiveQuery` uses a dedicated client, never the pool | with all pool slots held, cancel opens ONE one-off `Client` (`connectionTimeoutMillis: 5_000`), issues `pg_cancel_backend($1)` per PID, `end()`s it; the pool is untouched | fake `Client` tracking `connect`/`query`/`end`; a non-empty `activeNonCursorPids` |
| 5 | edge: late/cancel | idle/no-PID cancel is a no-op | empty `activeNonCursorPids` → NO dedicated client opened; `cancelActiveQuery()` resolves silently | adapter with no recorded PIDs |

## Test Files

- `src/adapters/__tests__/postgres.test.ts` — contains the cases above. (The integration file
  `postgres.integration.test.ts` is DB-gated and excluded from this task's run.)

## Verification Commands

```bash
grep -qi "## Probe: PostgreSQL" docs/decisions/0002-cross-driver-resilience-contract.md
npx vitest run src/adapters/__tests__/postgres.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `postgres.ts` → tests-map `[postgres.test.ts, postgres.integration.test.ts,
postgres.sortQuery.test.ts, postgresCatalog.test.ts]`. The pinned target is `postgres.test.ts`;
`postgres.integration.test.ts` is DB-gated and excluded from the DB-free focused run; sibling suites are
exercised by the wave/cycle `npm test` net.)

## Acceptance Criteria

- [ ] Cases 1–5 pass (TDD: RED probe output pasted before implementation; pin cases stay GREEN on today's code).
- [ ] The RED/GREEN probe results are appended to the ADR under `## Probe: PostgreSQL` (grep check exits 0); wave-0 ADR content and other tasks' sections untouched.
- [ ] If a production gap was found: the probe that proved it is pasted and the change is minimal; if no gap: `git diff 65b9c4f -- src/adapters/postgres.ts` is empty (pin-only, recorded in the Executor Report).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] No regression: ARP-02 dedicated-client cancel semantics preserved (seam still never closes the pool/adapter).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP05-000 — the ADR records the SLO/no-replay decision this task must not violate, and the PG rows of the matrix are its source of truth.

## Interfaces

- Consumes: (none). Reads the ADR `docs/decisions/0002-cross-driver-resilience-contract.md` (PG matrix +
  SLO/no-replay). Grounding: `PostgresAdapter` (`connect` :289, `close` :323, `testConnection` :371,
  `cancelActiveQuery` :513, `openCursorForStatement` :1086), `PG_POOL_MAX = 4` (:107), `activeNonCursorPids`
  (:268). Driver imports are top-level (`import { Pool, Client } from "pg"` at :7) — the pg mock must keep the existing hoisted `vi.mock` pattern.
- Produces: (none) for later tasks — the pins live in `postgres.test.ts`. **The ADR append (`## Probe:
  PostgreSQL`) feeds ARP-05.4's gate** and completes the wave-0 measurement contract. If a production change
  was made, it must stay within `src/adapters/postgres.ts` and preserve the signatures above.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
