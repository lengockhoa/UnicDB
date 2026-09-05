# TASK-ARP05-000 — ADR: cross-driver timeout, pool, and resilience contract (mandatory gate)

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1–§3

## Goal

Write the architecture decision that ARP-05's mandatory gate requires, **before any source change**: an ADR
in `docs/decisions/` documenting the per-driver timeout/pool/stream/cancel contract for PostgreSQL, MySQL,
and MSSQL — the connect/query/stream/cancel/pool/broken-socket matrix, the measured finite-failure behavior
of each path, and the SLO / no-automatic-replay decision that bounds every downstream driver task
(TASK-ARP05-001/002/003).

## Target Files

- `docs/decisions/0002-cross-driver-resilience-contract.md` — **new file** (new) — the ADR. (The
  `docs/decisions/` directory already exists from ARP-04 — `0001-ssh-host-key-identity-policy.md` + `README.md` are there; this task adds `0002`. Update `docs/decisions/README.md`'s ADR index if it lists entries explicitly.)
- `docs/decisions/README.md` — index update if it enumerates ADRs.

**Wave-1 ADR-update protocol (this task must tolerate it):** this task (wave 0) writes the matrix, known
gaps, SLO/no-replay decision, and rejected alternatives. During wave 1 the driver tasks append their
measured RED/GREEN probe results to this SAME file, each under its own disjoint named section —
TASK-ARP05-001 `## Probe: PostgreSQL`, TASK-ARP05-002 `## Probe: MySQL`, TASK-ARP05-003 `## Probe: MSSQL`
(PLAN.md §3). These are append-only, section-disjoint docs edits (not code), so copy-back merge is trivial
and they do not violate same-wave code-file disjointness. Wave-0 content must leave the sections for these
appends at the end (e.g. a "## Measured probe evidence" placeholder) and must NOT attempt to pre-fill the
measurements — the measured finite-failure evidence is produced by the wave-1 probes.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | N/A | Docs task — no code | N/A per RULES: zero testable behavior. Verification is the content checklist below and the acceptance checklist; there is no executable test for documentation. | — |

## Test Files

- (none) — no test file. Docs-only task; verification is §5's content checklist + greps, not a vitest run.

## Verification Commands

```bash
test -f docs/decisions/0002-cross-driver-resilience-contract.md
grep -qi "queueLimit" docs/decisions/0002-cross-driver-resilience-contract.md
grep -qi "no.*replay\|replay" docs/decisions/0002-cross-driver-resilience-contract.md
git status --short src/ | wc -l        # must be 0 — docs task, no src/ change
```

Content checklist — the ADR MUST document each of these (check off in the Executor Report):

- [ ] **Per-driver matrix**, each cell source-cited (exact file:line + current value):
  - Connect: PG `connectionTimeoutMillis: 10_000` (`src/adapters/postgres.ts:313`); MySQL
    `connectTimeout: 10_000` (`src/adapters/mysql.ts:158`); MSSQL `connectTimeout: 10_000` + LoggedIn poll
    deadline 10s (`src/adapters/mssql.ts:547,152`).
  - Query: PG `max: PG_POOL_MAX = 4` (`postgres.ts:311`); MySQL `connectionLimit: 1` + atomic
    multi-statement batch on one held connection (`mysql.ts:155,242-304`); MSSQL `requestTimeout: 0` +
    one-request `enqueue` chain (`mssql.ts:554,574-587`).
  - Stream: PG cursor `BEGIN`/`DECLARE`/`FETCH`/`CLOSE` holding a pool slot (`postgres.ts:1086-1180`);
    MySQL `connectionLimit: 1` held + `timeout: 0` stream (`mysql.ts:653-675`); MSSQL `requestTimeout: 0`
    so a paused stream survives load-more (`mssql.ts:548-554`).
  - Cancel: PG dedicated one-off `Client` + `pg_cancel_backend`, never through the pool
    (`postgres.ts:513-546`); MySQL `stream.destroy()`/`connection.destroy()` best-effort
    (`mysql.ts:343-368`); MSSQL `request.cancel()` best-effort + `cancelTimeout: 5_000`
    (`mssql.ts:205-211,555`).
  - Pool: PG 4 slots on demand (`postgres.ts:305-314`); MySQL 1 slot + `waitForConnections: true` +
    **`queueLimit: 0` infinite queue** (`mysql.ts:156-157`); MSSQL no pool — one tedious `Connection`
    serialized by `enqueue` (`mssql.ts:514-559`).
  - Broken socket: PG `close()` races cursor ROLLBACK/release(true) + `pool.end()` vs 2s/3s guards
    (`postgres.ts:323-369`); MySQL `close()` = `pool.end()` (`mysql.ts:198-204`); MSSQL `close()` cancels
    active requests then `connection.close()` (`mssql.ts:198-223`).
- [ ] **Intentional-difference explanation**: PG slot isolation (metadata never interleaves into a user's
  open transaction — `postgres.ts:291-304`), MySQL single-slot stream/transaction isolation, MSSQL
  `requestTimeout: 0` paused-stream survival (`mssql.ts:548-554`). State clearly these are deliberate.
- [ ] **Measured finite-failure behavior** per driver, with probe evidence pasted (slow connect, occupied
  pool, cancelled stream, broken socket — per roadmap wave-0 acceptance "Reproduce slow connect, occupied
  pool, cancelled stream, broken socket per driver"): every listed path terminates within a bounded time or
  a bounded error surface.
- [ ] **The known gap, recorded explicitly**: MySQL `queueLimit: 0` with the single connection held is an
  **unbounded wait** — a slow statement pins the only slot and every later connect/query enqueues with no
  upper bound. This is the gap TASK-ARP05-002 is expected to close (bounded acquire), and its chosen bound
  (recommend `acquireTimeout: 10_000`) must be recorded here once measured.
- [ ] **SLO / no-replay decision**: e.g. connect/query failure ≤ 10s surface, cancel ≤ 5s best-effort;
  **no automatic replay of mutations, transactions, or cursors** — read-only re-issue is a caller decision,
  mutation/transaction/cursor replay is prohibited. This decision is what the driver tasks must not violate.
- [ ] **Rejected alternatives**, each with the reason: per-driver value changes without measurement (all
  values are deliberate); a shared base-adapter abstraction (breaks lazy-per-dialect + DBX-08 capability
  matrix); blanket `connectionLimit` raising for MySQL (would let metadata interleave into an open
  transaction, the exact bug `postgres.ts:291-304` fixed); dependency-heavy circuit breakers (roadmap Out);
  automatic mutation/transaction/cursor replay (roadmap Out).

## Acceptance Criteria

- [ ] `docs/decisions/0002-cross-driver-resilience-contract.md` exists; `docs/decisions/README.md` updated if it enumerates ADRs.
- [ ] Every content-checklist bullet above is present and source-anchored (the checklist is written into the file, not just the plan) — **wave-0 scope: matrix + known gaps + SLO/no-replay decision + rejected alternatives. The measured finite-failure probe evidence is appended by TASK-ARP05-001/002/003 during wave 1 under their `## Probe: <driver>` sections; this task must NOT pre-fill those measurements.**
- [ ] The matrix explains the intentional adapter differences AND records the MySQL `queueLimit: 0` unbounded-wait gap.
- [ ] The SLO / no-automatic-replay decision is explicit and binds TASK-ARP05-001/002/003.
- [ ] A trailing "## Measured probe evidence (appended by wave-1 tasks)" placeholder section exists so the wave-1 appends have a stable merge point.
- [ ] All three verification `grep` commands exit 0; `git status --short src/ | wc -l` = 0.
- [ ] No `src/` file was created or modified by this task.

## Dependencies

- (none) — this is the Wave-0 gate; every source task in the cycle depends on it.

## Interfaces

- Consumes: (none). Grounding only — read `src/adapters/postgres.ts` (`PG_POOL_MAX` at :107, pool :305-314,
  `close()` :323-369, `cancelActiveQuery` :513-546), `src/adapters/mysql.ts` (pool :149-158, connect-fail
  cleanup :184-196, batch :242-304, cancel :343-368, streaming :648-705), `src/adapters/mssql.ts`
  (`connect()` :113-196, `close()` :198-223, `enqueue` :574-587, `runRequest` :589-657,
  `createConnection` options :514-559) to cite current behavior accurately.
- Produces: `docs/decisions/0002-cross-driver-resilience-contract.md` — the ADR that records the contract
  and the SLO/no-replay decision the downstream tasks must implement. TASK-ARP05-002 reads the
  "known gap / bounded acquire" section; TASK-ARP05-001/003 read the SLO/no-replay decision; TASK-ARP05-004
  reads the "host message" conclusion. **The ADR is then appended to by TASK-ARP05-001/002/003 during
  wave 1 (their `## Probe: <driver>` RED/GREEN sections) — this task does not do that appending, but must
  leave the stable merge point for it.**

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: unic-code (claude-sonnet-4-5 class, self-reported per RULES self-report rule)
- EXECUTOR_SUBAGENT: Claude:feature-implementer
- RED_OUTPUT: N/A (docs-gate task, no code tests — per task §Test Cases: "Docs task — no code, N/A per RULES: zero testable behavior")

Content checklist — verified present in `docs/decisions/0002-cross-driver-resilience-contract.md`:

- [x] **Per-driver matrix**, every cell source-cited — §2 + §2.1–§2.6 (connect/query/stream/cancel/pool/broken socket per driver; each citation read and verified against current source @ 85bf5cb)
- [x] **Intentional-difference explanation** — §3 (PG slot isolation `postgres.ts:291-304`, MySQL single-slot rationale `mysql.ts:88-92,250-252`, MSSQL `requestTimeout: 0` paused-stream survival `mssql.ts:548-554`; all stated as deliberate)
- [ ] **Measured finite-failure behavior with probe evidence pasted** — intentionally NOT written by wave 0, per task wave-0 scope rule and Acceptance Criteria ("this task must NOT pre-fill those measurements"); §7 placeholder + §5 SLO define what wave-1 (TASK-ARP05-001/002/003) must append
- [x] **Known gap recorded explicitly** — §4 (MySQL `queueLimit: 0` + `connectionLimit: 1` = unbounded wait; TASK-ARP05-002 closes it; recommended `acquireTimeout: 10_000` recorded as recommendation, measured bound to be recorded in §7 by -002)
- [x] **SLO / no-replay decision** — §5 (connect ≤ 10s, queued acquire bounded per §7, cancel ≤ 5s best-effort; documented no-timer exceptions for MSSQL query / MySQL stream; no automatic replay of mutations/transactions/cursors — binds 001/002/003)
- [x] **Rejected alternatives** (all 5, each with reason) — §6 (unmeasured value changes; shared base-adapter breaking lazy-per-dialect factory `factory.ts:14-26` + DBX-08 capability matrix `postgres.ts:282-287` / `mysql.ts:137-142`; blanket MySQL `connectionLimit` raise; circuit breakers — roadmap §ARP-05 Out line 248; automatic replay — roadmap Out + acceptance line 271)
- [x] Trailing `## Measured probe evidence (appended by wave-1 tasks)` placeholder — §7, stable merge point. Reviewer note: the placeholder deliberately does NOT contain the literal strings `## Probe: PostgreSQL` / `## Probe: MySQL` / `## Probe: MSSQL`, because TASK-ARP05-001/002/003 each gate with `grep -qi "## Probe: <driver>"` — spelling them in wave 0 would make those RED gates pass before any append. Verified all three greps currently exit 1.

Verification Output (task §Verification Commands, run in worktree `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-arp05-000`):

```
$ test -f docs/decisions/0002-cross-driver-resilience-contract.md; echo "cmd1 exit=$?"
cmd1 exit=0
$ grep -qi "queueLimit" docs/decisions/0002-cross-driver-resilience-contract.md; echo "cmd2 exit=$?"
cmd2 exit=0
$ grep -qi "no.*replay\|replay" docs/decisions/0002-cross-driver-resilience-contract.md; echo "cmd3 exit=$?"
cmd3 exit=0
$ git status --short src/ | wc -l
0
```

Extra guard checks (not in task, reviewer-relevant): wave-1 grep gates `## Probe: PostgreSQL` / `## Probe: MySQL` / `## Probe: MSSQL` all absent from the ADR (exit 1) — appends are detectable. `git status --short`: `M docs/decisions/README.md` + `?? docs/decisions/0002-cross-driver-resilience-contract.md` only. No `src/` file touched. INDEX.md untouched. No git add/commit/push/worktree run.

- Status: PASS
- Note: none. All file:line citations given in the task were verified against current source @ 85bf5cb and were accurate as written — no stale citations needed correcting. `docs/decisions/README.md` index updated (it does enumerate ADRs). Test Cases N/A honored (docs task, no token test invented). Scope: only the two target files changed.


## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: test -f docs/decisions/0002-cross-driver-resilience-contract.md; grep -qi "queueLimit" ...; grep -qi "no.*replay\|replay" ...; git status --short src/ | wc -l
  result: 3/3 greps exit 0; src/ dirty count 0
TEST_PLAN_COVERAGE: all-followed (docs-only task — Test Case N/A per RULES, zero testable behavior; report justification accepted)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Wave-0 ADR is complete and source-anchored; the §7 placeholder deliberately omits the literal `## Probe:` strings so wave-1 grep gates stay RED until appended. Wave-1 source edits (001/002) later shifted the MySQL/PG line citations inside wave-0 §2/§4 (e.g. mysql.ts:155-157 → :191-194) — inherent to the append-only protocol, not a wave-0 defect; re-cite in a future ADR amendment.
