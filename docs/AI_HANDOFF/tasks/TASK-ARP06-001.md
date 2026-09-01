# TASK-ARP06-001 — Fail-closed policy decision API + security parser corpus (readonlySqlParser + ADR 0003)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3/§4 (ARP-06.1)

## Goal

Document the one fail-closed AI-SQL policy decision in ADR `0003-ai-sql-policy.md` and pin `parseReadonly`
as its strict core profile with a mandatory security parser corpus: parser uncertainty never admits
mutation-capable SQL.

## Target Files

- `docs/decisions/0003-ai-sql-policy.md` (new) — ADR: the one fail-closed policy decision, the
  allowed/denied construct matrix, the two documented profiles (`parseReadonly` core profile;
  `isReadOnlySql` run_sql profile), the over-rejection rules, the EXPLAIN-reduction rule, the
  "uncertain → reject" principle, and the rejected alternative (full tokenizer). The ADR cites
  `sqlTool.ts`'s **existing run_sql behavior as the source of truth at write time** — it records the
  decision + principle + matrix, NOT guard internals that only ARP-06.2 can verify in the same parallel
  wave.
- `docs/decisions/README.md` — add the `0003` row to the ADR table.
- `src/ai/tools/readonlySqlParser.ts` — module-header doc line naming this module the **core profile** of
  the ARP-06 policy decision; production logic change ONLY if a corpus test proves a gap (RED first).
- `src/ai/tools/__tests__/readonlySqlParser.test.ts` — extend with the security parser corpus.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `parseReadonly` accepts plain SELECT and WITH | `{ ok:true, kind:"select" }` / `{ ok:true, kind:"with" }` | `SELECT * FROM t`; `WITH x AS (SELECT 1) SELECT * FROM x` |
| 2 | edge: mutation | writable CTE denied | `{ ok:false, reason:"non_select" }` | `WITH x AS (UPDATE t SET a=1) SELECT * FROM x` |
| 3 | edge: mutation | EXPLAIN ANALYZE DELETE denied by the core profile | `{ ok:false, reason:"non_select" }` (core never admits EXPLAIN; run_sql profile reduces + re-checks separately) | `EXPLAIN ANALYZE DELETE FROM t` |
| 4 | edge: mutation | SELECT INTO denied | `{ ok:false, reason:"non_select" }` | `SELECT * INTO t2 FROM t` |
| 5 | edge: structure | multi-statement denied | `{ ok:false, reason:"multi_statement" }` | `SELECT 1; SELECT 2` |
| 6 | edge: structure | malformed parens denied | `{ ok:false, reason:"unbalanced_parens" }` for both | `SELECT (1`; `SELECT 1)` |
| 7 | edge: lexical | comment/literal over-rejection pinned | `{ ok:false, reason:"non_select" }` for all three | `SELECT 'insert'`; `SELECT 1 -- insert`; `SELECT created_at FROM t` |
| 8 | security corpus | no mutation-capable construct is ever admitted | parametrized sweep → every case `{ ok:false }` (RED if any admits) | full denied corpus: DML/DDL keywords, INTO, writable CTE, EXPLAIN, row locks, literal-hidden, identifier-substring, multi-statement, unbalanced parens |

## Test Files

- `src/ai/tools/__tests__/readonlySqlParser.test.ts` — extended (tests above). Existing suite already
  covers happy SELECT/WITH, row-lock rejection, and lexical safety; the new corpus is the mandatory
  security sweep.

## Verification Commands

```bash
test -f docs/decisions/0003-ai-sql-policy.md
grep -qi "run_sql" docs/decisions/0003-ai-sql-policy.md && grep -qi "parseReadonly" docs/decisions/0003-ai-sql-policy.md
npx vitest run src/ai/tools/__tests__/readonlySqlParser.test.ts
npm run typecheck
npm run compile
```

No lint script exists — `npm run typecheck` is the static gate. Selection per RULES: `readonlySqlParser.ts`
→ tests-map `[readonlySqlParser.test.ts]` (the only mapped file; it is the pinned target).

## Acceptance Criteria

- [ ] `docs/decisions/0003-ai-sql-policy.md` exists with the one policy decision, the construct matrix,
      and both profiles named (`parseReadonly` core, `isReadOnlySql` run_sql); `grep` checks exit 0.
- [ ] `docs/decisions/README.md` lists `0003`.
- [ ] The security corpus sweep (test 8) passes — every mutation-capable construct denied.
- [ ] RED evidence pasted before any production change; production logic changed ONLY if a corpus case
      was RED on today's code.
- [ ] No weakening of `parseReadonly` over-rejection; ARP-01/`guardAdapter` untouched.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — reads today's `parseReadonly`/`containsForbidden`/`containsRowLock`/
  `stripTrailingSqlComments` as-is; reads `sqlTool.ts`'s existing run_sql behavior as the ADR's source of
  truth at write time).
- Produces:
  - `docs/decisions/0003-ai-sql-policy.md` (new ADR). **Ownership rule:** this task owns the ADR write in
    wave 1; ARP-06.2 may append ADR corrections in wave 2 (or via its own review round) if its pins expose
    drift between the documented matrix and the guard's actual behavior. No same-wave append.
  - `parseReadonly`/`ParseResult`/`ParseFailReason`/`containsForbidden`/`containsRowLock`/
    `ROW_LOCK_RE`/`stripTrailingSqlComments` remain the exported core-profile contract (unchanged unless
    a corpus gap forces a fix — if so, the exact new signature is recorded here in the Discussion).

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
