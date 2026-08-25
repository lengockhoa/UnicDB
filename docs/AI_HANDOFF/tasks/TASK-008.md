# TASK-008 — Keyword qualifier: stop scanning `information_schema.tables` on every Cmd+Enter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.9 (D1) — §7 Global Constraints applies by reference

## Goal

Fix D1. `qualifyKeywordTables` (`src/core/keywordQualify.ts:139-142`) eagerly awaits
`publicTables()` — a full `information_schema.tables` scan — on **every** call, explicitly so
that "callers always exercise the listTables path even when the SQL has no reserved-keyword
candidates". `extension.ts` calls it **per statement** (`:479-484`), so a 20-statement script
issues 20 extra catalog queries before the first row of user SQL, against a `max: 1` Postgres
pool. There is no cache and no TTL.

Two changes, both inside this file:

1. Delete the eager warm-up. `publicTables()` is already lazy; let it stay lazy so the catalog
   query happens **only** when a reserved-keyword candidate is actually present.
2. Add an opt-in, caller-owned cache handle so a multi-statement run pays at most once. The
   caller wiring (`extension.ts`) belongs to TASK-011 — this task only provides and tests the API.

## Target Files

- `src/core/keywordQualify.ts`
- `src/core/__tests__/keywordQualify.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | no candidate | `qualifyKeywordTables("SELECT 1", spy)` ⇒ spy called **0** times, `sql` returned unchanged |
| Happy | with candidate | `SELECT * FROM user` (reserved) ⇒ spy called exactly **1** time, rewrite applied as today |
| Edge (cache reuse) | 20 calls sharing one cache | spy called exactly **1** time in total |
| Edge (TTL) | cache older than its TTL | spy called again (assert with an injected clock, not a real sleep) |
| Edge (failure) | `listTables` rejects | `qualifyKeywordTables` still resolves with the original SQL (best-effort, matches the browse path's `?? rawSql` fallback) |
| Edge (isolation) | two different caches | no cross-talk; each triggers its own single fetch |
| R (D1) | plain SQL, no candidates | today: **1** catalog query per call (per statement) |

## Test Files

- `src/core/__tests__/keywordQualify.test.ts` (extend — call-count assertions with a spy
  `listTables`, injected clock for TTL)

## Verification Commands

```bash
npm run typecheck
npm test -- src/core/__tests__/keywordQualify.test.ts
npm test -- src/ui/__tests__/browseCommands.test.ts
npm test -- src/core/__tests__/statementParser.test.ts
```

## Acceptance Criteria

- [ ] All 7 cases pass; the regression case confirmed failing on `main` first (call-count
      assertion, output in the report).
- [ ] The eager `await publicTables()` warm-up and its comment at `keywordQualify.ts:139-141` are
      gone; no test still asserts "listTables is always called".
- [ ] Rewrite output is byte-identical to today for every existing test case (this is a cost fix,
      not a semantics change).
- [ ] The cache is **opt-in**: calling `qualifyKeywordTables(sql, listTables)` with two arguments
      keeps working and holds no cross-call state (no module-level global cache — a hidden global
      would silently serve stale table lists after a DDL change).
- [ ] Cache entries expire by TTL and the TTL is injectable for tests.
- [ ] `npm run typecheck` clean; no file outside Target Files touched.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)`
- Produces:

```ts
// src/core/keywordQualify.ts
export interface QualifyResult { sql: string; changed: boolean; /* existing fields unchanged */ }

export interface KeywordTableCache {
  /** Returns the cached lowercase table-name set, or fetches via `load` and stores it. */
  get(schema: string, load: () => Promise<string[]>): Promise<Set<string>>;
  clear(): void;
}

/** TTL default 30_000 ms. `now` is injectable for tests. */
export function createKeywordTableCache(
  ttlMs?: number,
  now?: () => number,
): KeywordTableCache;

/** `opts` is NEW and optional — omitted ⇒ no caching, today's semantics. */
export async function qualifyKeywordTables(
  sql: string,
  listTables: (schema: string) => Promise<string[]>,
  opts?: { cache?: KeywordTableCache },
): Promise<QualifyResult>;
```

Consumed by `src/extension.ts` (TASK-011, wave 2) which hoists one cache per run, and by
`src/ui/browseCommands.ts` (unchanged 2-argument call — do not edit that file).

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

Deliberate design choice, recorded so the reviewer does not read it as an omission: the cache is
a **caller-owned handle**, not a module-level singleton. A hidden global would keep serving a
stale table list after the user creates a table in the same session, trading a correctness bug
for a performance win — exactly the trade this cycle exists to undo.

Note the existing `browseCommands.ts` call site passes `(rawSql, listTablesFn)` and wraps the
whole thing in a `?? rawSql` fallback. Keeping the 2-argument signature valid is what lets this
task ship without touching that file (owned by nobody this cycle, but still out of scope).

### 2026-08-25 · executor · claude-sonnet-5

One unplanned test-file edit outside the listed Target Files, recorded here rather than silently
made: `src/ui/__tests__/browseCommands.test.ts` test `#11` asserted
`expect(listTablesSpy).toHaveBeenCalledWith("public")` for a normal browse. Investigation showed
`buildBrowseSelect` always fully double-quotes both schema and table
(`SELECT * FROM "public"."users"`), so under the module's own contract ("identifier is unquoted
AND unqualified") this SQL is *never* a reserved-keyword candidate — that assertion only passed
before this task because of the eager warm-up being deleted here. Removing the warm-up without
touching the test would turn a previously-green suite red for a case the fix is explicitly
supposed to change (D1's whole point). I updated only that one assertion (now
`.not.toHaveBeenCalled()`) and its surrounding comment to describe the corrected lazy behavior,
touching no other line in that file. `src/ui/browseCommands.ts` itself (the file the task
forbids editing) was left untouched — its 2-argument call site still works unmodified.

Also flagging per the executor's scope note: `keywordQualify.ts` contains its own
hand-rolled SQL tokenizer (string/quote/dollar-quote/comment scanning) that duplicates logic
already implemented in `src/core/statementParser.ts` (owned by TASK-004 this cycle). Unifying
them is out of scope here but would remove a maintenance hazard (two tokenizers that can drift).

---

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-sonnet-5
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 ❯ src/core/__tests__/keywordQualify.test.ts  (27 tests | 9 failed) 6ms
   ❯ qualifyKeywordTables > listTables is invoked with the `public` schema when (and only when) a reserved-keyword candidate is present (lazy — TASK-008)
     → expected "spy" to be called +0 times, but got 1 times
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Happy | no candidate — spy called 0 times, sql returned unchanged
     → expected "spy" to be called +0 times, but got 1 times
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Edge (cache reuse) | 20 calls sharing one cache — spy called exactly 1 time in total
     → createKeywordTableCache is not a function
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Edge (TTL) | cache entry older than its TTL is refetched (injected clock, no real sleep)
     → createKeywordTableCache is not a function
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Edge (failure) | listTables rejects — qualifyKeywordTables still resolves with the original SQL
     → promise rejected "Error: catalog scan failed" instead of resolving
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Edge (failure, cached) | listTables rejects through a cache handle — still best-effort, original SQL
     → createKeywordTableCache is not a function
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > Edge (isolation) | two different caches — no cross-talk, each triggers its own single fetch
     → createKeywordTableCache is not a function
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > R (D1) | plain SQL, no candidates — 0 catalog queries (was 1 per call before the fix)
     → createKeywordTableCache is not a function / expected "spy" to be called +0 times, but got 1 times
   ❯ TASK-008 — lazy candidate-gated lookup + opt-in cache > cache.clear() drops stored entries — next get() refetches
     → createKeywordTableCache is not a function

 Test Files  1 failed (1)
      Tests  9 failed | 18 passed (27)

Example detail:
 FAIL  qualifyKeywordTables > listTables is invoked with the `public` schema when (and only when) a reserved-keyword candidate is present (lazy — TASK-008)
AssertionError: expected "spy" to be called +0 times, but got 1 times
 ❯ src/core/__tests__/keywordQualify.test.ts:165:17
    163|     // No reserved-keyword candidate — `users` is not reserved — listT…
    164|     await qualifyKeywordTables("SELECT 1 FROM users", spy);
    165|     expect(spy).toHaveBeenCalledTimes(0);
       |                 ^
```
All 9 failures were for the expected reason: the eager warm-up still fired `listTables` for
SQL with no reserved-keyword candidate (call-count assertions failed), and `createKeywordTableCache`
did not exist yet (TypeError on import use). Confirmed RED for the right reason, then implemented.

Verification Output:
```
=== npm run typecheck ===
> vsdb@1.6.3 typecheck
> tsc --noEmit
(clean, no output)

=== npm test -- src/core/__tests__/keywordQualify.test.ts ===
 ✓ src/core/__tests__/keywordQualify.test.ts  (27 tests) 3ms
 Test Files  1 passed (1)
      Tests  27 passed (27)

=== npm test -- src/ui/__tests__/browseCommands.test.ts ===
 ✓ src/ui/__tests__/browseCommands.test.ts  (16 tests) 5ms
 Test Files  1 passed (1)
      Tests  16 passed (16)

=== npm test -- src/core/__tests__/statementParser.test.ts ===
 ✓ src/core/__tests__/statementParser.test.ts  (46 tests) 5ms
 Test Files  1 passed (1)
      Tests  46 passed (46)
```
Full-suite check (not a listed Verification Command, run as extra regression confirmation):
`npm test` → `Test Files 81 passed | 1 skipped (82)` / `Tests 1054 passed | 2 skipped (1056)`
(baseline was 1044 passed, 2 skipped, 81 files passed — net +10 tests, no regressions, one
previously-skipped-only-in-uncompiled-worktree build-artifact file now compiles and passes
after `npm run compile` was run once to generate `dist/` for that unrelated smoke test).

Status: PASS

Note: One test-file edit outside the Target Files list was required and is fully explained in
the `## Discussion` thread above: `src/ui/__tests__/browseCommands.test.ts` test `#11`'s
`toHaveBeenCalledWith("public")` assertion encoded the exact D1 defect (eager, unconditional
catalog call) this task removes — `buildBrowseSelect` always emits fully-quoted SQL, so under
correct lazy semantics `listTables` is provably never called from that call site. Updated the
one assertion + its comment; `src/ui/browseCommands.ts` itself was not touched. Also see
Discussion note on the `keywordQualify.ts` vs `statementParser.ts` duplicate-tokenizer concern
(TASK-004 owns the latter; not touched).
