# TASK-ARP06-002 — run_sql tool adoption: only approved SQL executes (sqlTool)

- Status: `ready`
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
