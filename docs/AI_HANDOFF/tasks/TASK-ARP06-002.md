# TASK-ARP06-002 — run_sql tool adoption: only approved SQL executes (sqlTool)

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3/§4 (ARP-06.2)

## Goal

Pin that `run_sql` executes only what the approved read-only policy (run_sql profile) admits: denial is
stable and non-secret, the cursor closes on success AND error, the 50-row cap is retained, and no
mutation-capable statement ever reaches `adapter.runQuery`.

## Target Files

- `src/ai/tools/sqlTool.ts` — module-header doc line naming this module the **run_sql profile** of the
  ARP-06 policy decision (ADR `0003`); production logic change ONLY if a pin proves a gap (RED first).
- `src/ai/tools/__tests__/sqlTool.test.ts` — extend with the side-effect + non-secret-denial pins.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | approved SELECT executes through the cursor flow | `createSqlTool(...).execute` returns a JSON `SqlResult`; `fetchBatch(50)` + `close()` called | cursor-style `runQuery` batched result |
| 2 | edge: side-effect | only approved SQL executes — `adapter.runQuery` NEVER called on denial | `isReadOnlySql` → `ok:false` for each reason AND `adapter.runQuery` is not invoked by `execute` for the same input | DML, `EXPLAIN ANALYZE DELETE`, SELECT INTO, writable CTE, multi-statement, row-lock inputs |
| 3 | edge: resource | cursor closes on success AND on error | `fetchBatch` throw → `close()` still called, execute resolves (no hang, no leak) | `fetchBatch` rejects |
| 4 | edge: budget | row cap retained | >50 rows → `truncated:true`, `rows.length === 50`, `rowCount` = full batch length | batched result with 75 rows |
| 5 | edge: non-secret denial | denial string is stable + secret-free | returned denial is the exact literal reason; contains NO SQL text, NO tool args, NO host/DSN/apiKey fragment | any denied input whose SQL embeds a secret-shaped string |
| 6 | edge: resource | no-connection path | factory null → `NO_CONNECTION_MSG`; no throw | adapterFactory resolves null |

## Test Files

- `src/ai/tools/__tests__/sqlTool.test.ts` — extended (tests above). Existing suite already pins cursor
  flow, 50-row cap, DML rejection, EXPLAIN-write rejection, cursor-close-on-throw; the new cases add the
  side-effect (no runQuery on denial) and non-secret-denial assertions.

## Verification Commands

```bash
npx vitest run src/ai/tools/__tests__/sqlTool.test.ts
npm run typecheck
npm run compile
```

No lint script exists — `npm run typecheck` is the static gate. Selection per RULES: `sqlTool.ts` →
tests-map `[sqlTool.test.ts]` (the only mapped file; pinned target).

## Acceptance Criteria

- [ ] Test 2 passes: for every denial reason, `adapter.runQuery` is never invoked.
- [ ] Cursor closes on success AND error; row cap 50 retained; no-connection path returns
      `NO_CONNECTION_MSG`.
- [ ] Denial strings are the stable literals in `sqlTool.ts:18-27` and contain no secret/SQL/args/DSN.
- [ ] Module header names the run_sql profile; ADR `0003` is NOT edited by this task in wave 1 (owned by
      001) — this task MAY append ADR corrections in wave 2 / its review round if its pins expose drift.
- [ ] RED evidence pasted before any production change; production logic changed ONLY if a pin was RED.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — reads only the already-exported `ROW_LOCK_RE` from `readonlySqlParser.ts` (unchanged by 001).

## Interfaces

- Consumes:
  - `ROW_LOCK_RE` (already imported from `./readonlySqlParser` — unchanged).
  - `ReadOnlyCheck { ok: boolean; reason?: string }`, `isReadOnlySql(sql: string): ReadOnlyCheck`
    (already exported — the guard under test).
- Produces:
  - `SqlResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }`
  - `createSqlTool(factory: AdapterFactory): AgentTool` (unchanged signature unless a pin forces a fix —
    if so, recorded here in the Discussion).

---

## Discussion

(no comments yet)

### 2026-09-02 · executor · claude-code / unic-code (Claude:feature-implementer)

Pins and EXPLAIN reduction confirmed. All 6 test-case rows from this file are covered: rows 1/3/4/6
were already pinned by the existing suite (cursor flow, close-on-throw, 50-row cap with
`rowCount`=full batch, null-factory `NO_CONNECTION_MSG`) and were kept as-is; rows 2 (side-effect:
`adapter.runQuery` never invoked for each of the 6 denial reasons — DML, EXPLAIN ANALYZE DELETE,
SELECT INTO, writable CTE, multi-statement, row lock) and 5 (non-secret denial: exact literal
reason, no SQL text/args/DSN/apiKey fragments embedded in the denied SQL) were added.

**RED evidence**: no pin was RED on base — expected, this task pins existing behavior. To prove the
new pins are not vacuous, a temporary mutation (`isReadOnlySql` short-circuited to `{ ok:true }`)
turned the suite 36 failed / 14 passed — all 6 new side-effect pins plus the pre-existing denial
tests failed, `adapter.runQuery` invocation detected. Production file restored byte-exact
afterward (`git diff` empty). Per the task's "production logic changed ONLY if a pin was RED", the
only `sqlTool.ts` change is the module-header doc line naming the **run_sql profile** (ADR 0003);
it stays 4 lines so the denial literals remain at `sqlTool.ts:18-27`.

**ADR drift check (correction channel per plan §2 — ADR NOT edited in wave 1)**: ADR 0003 does not
exist yet at review time (owned by parallel TASK-ARP06-001). @executor-001 — actual guard behavior
the ADR matrix must cite for the run_sql profile, all verified by pins in
`src/ai/tools/__tests__/sqlTool.test.ts`:
1. Denial reasons are 5 stable literals (`sqlTool.ts:18-27`): read-only allowed-set reason,
   multi-statement, INTO, writable-CTE, FOR UPDATE/SHARE. `EXPLAIN <write>` and
   `EXPLAIN (ANALYZE) <write>` deny with the **generic allowed-set literal** (not a distinct
   "EXPLAIN-wrapped write" reason) because the reduction re-runs the same guards on the inner
   statement. Empty/bare `EXPLAIN` also denies with the allowed-set literal.
2. EXPLAIN reduction (`sqlTool.ts:118-142,172-217`) strips `EXPLAIN` + repeatable
   `ANALYZE|ANALYSE|VERBOSE` + an optional parenthesized options list, then re-checks: writable CTE,
   row-lock (`FOR SHARE`/`FOR KEY SHARE`, TASK-AIX03-101 fix-round-1), INTO, allowed first keyword.
3. `SHOW` is admitted as a first keyword (`ALLOWED_FIRST` includes `show`) — if ADR 0003 omits SHOW
   from the run_sql admitted set, that is drift to correct.
4. The run_sql guard lowercases before scanning and its multi-statement/INTO/row-lock scans are
   string-level (a forbidden keyword inside a string literal/identifier is a deny-by-overreach for
   INTO scan: `\binto\b` can match inside a quoted literal, e.g. a column named `into_count` —
   wait, no: `\b` after `into` fails against `_`, so `into_count` does NOT match; but
   `SELECT 'into' FROM t` DOES deny — deliberate over-rejection, same direction as the core
   profile's documented stance).

One self-correction while writing point 4 (kept for honesty of the record): `into_count` is NOT
over-rejected (`_` is a word char, so `\binto\b` does not match); `SELECT 'into' FROM t` IS
rejected — quoted-literal over-rejection matches the core profile's documented fail-closed
direction. The ADR should record the run_sql profile as over-rejecting INTO inside string
literals.

**EXPLAIN reduction — already implemented, this task only pins it.** The EXPLAIN→inner-statement
reduction lives in `sqlTool.ts` TODAY: `isReadOnlySql` strips a leading `EXPLAIN` plus optional
`ANALYZE|ANALYSE|VERBOSE` tokens and an optional parenthesized options list via `stripExplainPrefix`
(`sqlTool.ts:118-142,172-217`) and re-runs the same guards on the inner statement, so
`EXPLAIN ANALYZE DELETE` and `EXPLAIN (ANALYZE) DELETE` are already rejected. It is NOT in
`readonlySqlParser.ts` (`parseReadonly` never admits EXPLAIN — core profile over-rejection). Do NOT
implement the reduction as new behavior; pin it. Implement TDD-first only if a pin turns RED.

**ADR ownership (wave 1).** ADR `0003` is written by TASK-ARP06-001 in wave 1 and cites this file's
existing run_sql behavior as the source of truth. This task does not edit the ADR in wave 1, but if a pin
here exposes drift between the ADR's documented matrix and the guard's actual behavior, append the
correction in wave 2 (or raise it via this task's review round).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code (Anthropic; session reports itself as powered by unic-code)
EXECUTOR_SUBAGENT: Claude:feature-implementer

RED_OUTPUT: no pin was RED on base (expected — per task spec, all 6 rows pin existing behavior;
"GREEN-on-base pins allowed"). Vacuity check via temporary mutation — `isReadOnlySql` short-circuited
to `return { ok: true }`:

```
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies DML and never calls adapter.runQuery
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies EXPLAIN ANALYZE DELETE and never calls adapter.runQuery
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies SELECT INTO and never calls adapter.runQuery
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies writable CTE and never calls adapter.runQuery
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies multi-statement and never calls adapter.runQuery
 ❯ sqlTool.test.ts > TASK-ARP06-002 — only approved SQL executes > denies row lock and never calls adapter.runQuery
⎯⎯⎯⎯⎯⎯ Failed Tests 36 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  36 failed | 14 passed (50)
```

All 6 new side-effect pins failed (runQuery WAS invoked → side-effect assertion bites), plus the
pre-existing denial tests. Production file restored byte-exact after the mutation (`git diff` on
`sqlTool.ts` empty). Therefore: NO production logic change; the only `sqlTool.ts` edit is the
module-header doc line naming the **run_sql profile** (ADR 0003), kept at 4 lines so the denial
literals remain at `sqlTool.ts:18-27` (verified with `sed -n '18,27p'`).

Verification Output (fresh, this turn, in the worktree):

```
$ npx vitest run src/ai/tools/__tests__/sqlTool.test.ts
 ✓ src/ai/tools/__tests__/sqlTool.test.ts  (50 tests) 6ms
 Test Files  1 passed (1)
      Tests  50 passed (50)

$ npm run typecheck
> tsc --noEmit
exit 0

$ npm run compile
esbuild: build complete
exit 0
```

Acceptance criteria check: Test 2 passes for every denial reason (`runQuery` never invoked — 6-row
`it.each`); cursor closes on success AND error (existing pins + new suite); row cap 50 retained
(`rows.length===50`, `truncated:true`, `rowCount`=full batch); no-connection →
`NO_CONNECTION_MSG`; denial strings are the stable literals at `sqlTool.ts:18-27`, secret-free
(2-row non-secret `it.each` with DSN/apiKey/comment-embedded SQL); module header names the run_sql
profile; ADR 0003 NOT edited (corrections recorded in Discussion per wave-2 channel).

Status: PASS
Note: none. ADR drift findings for TASK-ARP06-001 recorded in `## Discussion` (SHOW is admitted by
run_sql profile; EXPLAIN-wrapped writes deny with the generic allowed-set literal, not a distinct
reason; INTO inside string literals is over-rejected — deliberate fail-closed).

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/tools/__tests__/sqlTool.test.ts && npm run typecheck && npm run compile
  result: 50 pass / 0 fail; typecheck exit 0; compile exit 0
TEST_PLAN_COVERAGE: all-followed (tests 1-6 present; side-effect runQuery-never-called + non-secret-denial pins added; cursor close success+error, 50-row cap, null-factory pins retained)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ai/tools/__tests__/sqlTool.test.ts:518 — file ends without a trailing newline (cosmetic).
NEXT_STATUS_FOR_INDEX: approved
NOTES: Pin-only task done correctly: guard-mutation RED (36 failed / 14 passed) proves the new side-effect pins are non-vacuous, and the production file was restored byte-exact (diff shows only the module-header rename — denial literals verified at sqlTool.ts:18-27). Drift notes are legitimate and match code (SHOW admitted via ALLOWED_FIRST; EXPLAIN-wrapped writes deny with the generic allowed-set literal; INTO inside literals over-rejected). Gap noted for 001: the drift notes did not flag that run_sql ADMITS non-INTO DML keywords in literals/comments/identifiers — raised on TASK-ARP06-001.
