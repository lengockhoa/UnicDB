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

---
