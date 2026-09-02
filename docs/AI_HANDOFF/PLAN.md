# PLAN — ARP-07: Successful-DDL cache/context invalidation

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-07 (lines 320-358; P1; dep ARP-01 — shipped v1.37.0; preserve ARP-02 ownsRun/deactivate sentinel, ARP-03 row cap, ARP-04 tunnel identity, ARP-06 AI policy).
Base: `main @ aa01a78` (v1.42.0). Executor: `unic-code`. Reviewer: `unic-smart`. No lint script — static gate is `npm run typecheck`.

**Citation corrections (roadmap line anchors are stale — verified against HEAD):**
- Roadmap cites `src/extension.ts:294-312,492-499,657-687,1433-1470` as "connection change and manual refresh" wiring. Actual wiring: `schemaCache.invalidate()` on `mgr.onDidChangeActive` at **`extension.ts:331-333`**; manual refresh `vsdb.refreshSchema` at **`521-526`**; `acSchemaCache.invalidate()` on `onDidChangeActive` at **`718-721`**. The cited lines are NOT schema wiring (294-312 CodeLens/browse, 492-499 `vsdb.cancelQuery`, 657-687 AI command surface, 1433-1470 AIX-07 policy derivation).
- `src/ui/schemaCache.ts:277-324` ≈ actual: `invalidate()` (generation bump + inflight clear) at **`288-308`**; generation guard + commit gate at **`74, 356-387`** (commit `if (this.generation === startGen)` at **`374`**).
- `src/ai/schemaContextCache.ts:116-127,217-219` — accurate: `SchemaContextCache` interface at **`115-119`**, `invalidate()` at **`217-219`**.
- Shared execution seam: `runStatements` at **`extension.ts:1705-1769`** (success path `1748-1756`), called from console run (**`1597`**), editor runQuery (**`1656`**), codelens run (**`1670`**). `commandRunScript` uses a terminal, not `runStatements`.

## §1 Intent

**Problem.** SchemaCache invalidation already handles generation and stale in-flight results
(`src/ui/schemaCache.ts:288-308,356-387`); the AI schema context cache has an explicit `invalidate()`
(`src/ai/schemaContextCache.ts:217-219`). Both are wired on connection change (`extension.ts:331-333,718-721`)
and manual refresh (`extension.ts:521-526`) — but NOT after shared successful DDL. After a user runs
`CREATE`/`ALTER`/`DROP`/`RENAME` from the console, editor, or CodeLens, schema completion, the schema
tree, and AI autocomplete context keep serving the pre-DDL metadata until the next TTL expiry or manual
refresh. Additionally, grounding uncovered a REAL gap in the AI cache: `hydrate()` commits its entry
unconditionally (`schemaContextCache.ts:175-180`), so an `invalidate()` that lands while a hydration is
in-flight does NOT stop the stale entry from committing — the exact failure the roadmap's wave-1
regression is meant to close.

**Success.** (1) A pure, dialect-aware classifier in `src/core/schemaImpact.ts` (new) that decides
whether a statement, if it actually completed, changes the schema surface (depth-0 CREATE/ALTER/DROP/
RENAME; DML and literal/comment text are false). (2) After a successful shared run, if any *completed*
statement has schema impact, a host seam invalidates SchemaCache + AI schema cache and refreshes the
tree in one place. Failed/cancelled/rejected-confirmation DDL never invalidates. (3) The AI cache
hydration race is closed so a post-success lookup cannot serve a pre-DDL context. (4) The classifier
reconciles with the existing `dangerousStatement`/`readOnlyIntent` semantics (documented in-code +
reviewer criterion), reusing `maskLiteralsAndComments` rather than a new parser.

## §2 Scope

**In**
- ARP-07.1 (wave 1) — pure classifier: `src/core/schemaImpact.ts` (new) + `src/core/__tests__/schemaImpact.test.ts` (new). Depth-0 CREATE/ALTER/DROP/RENAME → true; SELECT / DML (INSERT/UPDATE/DELETE/MERGE/TRUNCATE) → false; keywords inside literals/comments/quoted identifiers → false (reuses `maskLiteralsAndComments`); `with` prelude handling; batch semantics (`completedSchemaImpact` = true iff ANY completed statement has impact).
- ARP-07.2 (wave 1) — schema cache race: VERIFY-FIRST. The generation guard (`schemaCache.ts:74,356-387`) already defeats invalidate-during-fetch stale commits (existing test `#3 invalidate defeats a refresh that started before it`, `schemaCache.test.ts:194-227`). Add a feature-named regression test scoped to the DDL-invalidation use case. **Modify `schemaCache.ts` only if the new test exposes a gap — expected: no source change.**
- ARP-07.3 (wave 1) — AI cache regression: `schemaContextCache.ts` — close the real hydration-commit gap. `invalidate()` must (a) prevent a pre-invalidate hydration from committing its entry (generation guard, mirroring SchemaCache) and (b) drop the in-flight hydration so a post-invalidate `resolve()` starts a fresh hydration (with an ownership check so the old hydration's `finally` does not null the new promise). Interface unchanged. Preserves the resolver's identity/race guard (unchanged) and the return-by-reference cache-hit contract.
- ARP-07.4 (wave 2) — execution wiring: `extension.ts` + `extension.test.ts`. Module-level host seam assigned in `activate` (closing over `schemaCache`, `acSchemaCache`, `state?.tree`); `runStatements` success path feeds only `status === "done"` statements to `completedSchemaImpact` and calls the seam, gated on `!deactivating` (ARP-02 composition). Failed/cancelled/rejected-confirmation runs never call the seam.

**Out** (explicit, from roadmap)
- Universal SQL semantics; server event subscriptions; DML invalidation absent evidence; automatic tree expansion.
- Changing `dangerousStatement.ts` / `readOnlyIntent.ts` — the classifier imports their exported `maskLiteralsAndComments` only.
- Wiring the two direct-`adapter.runQuery` DDL surfaces — form-view DDL (`src/ui/tableCommands.ts:117-123` `runDdl`) and AI plan-apply (`src/ui/aiChatPanel.ts:3619-3743` `handlePlanApprove`). These files are NOT in the roadmap's candidate set; the seam is designed so a follow-up can consume it. **Known gap — see Self-Audit.**
- Any ARP-02 ownsRun/deactivate behavior change; ARP-03 retained-row cap; ARP-04 tunnel identity; ARP-06 AI policy.

**Same-wave file disjointness (absolute)**
- Wave 1: ARP-07.1 owns `schemaImpact.ts` + `schemaImpact.test.ts` (both new); ARP-07.2 owns `schemaCache.ts` (expected no change) + `schemaCache.test.ts`; ARP-07.3 owns `schemaContextCache.ts` + `schemaContextResolver.test.ts`. Disjoint.
- Wave 2: ARP-07.4 owns `extension.ts` + `extension.test.ts` only. No `src/` file is shared within a wave.

## §3 Approach

**Seam design (why a module-level callback, not a `runStatements` parameter).** `runStatements` and its
three callers (`extension.ts:1597,1656,1670`) are module-scope functions that receive `mgr/runner/panel`
as params and do NOT close over `schemaCache`/`acSchemaCache` (both are `activate`-local, `extension.ts:317,696`).
The schema tree IS reachable module-wide via `state?.tree` (`ExtensionState.tree`, `extension.ts:109`). A
module-level `let invalidateAfterSchemaDdl: ((completed: readonly string[], dialect?: SqlDialect) => void) | null = null;`
assigned once in `activate` keeps all three callers untouched, is trivially testable by mocking
`./ui/schemaCache` + `./ai/schemaContextCache`, and is the single "explicit host seam" the roadmap names.
`runStatements` success path (inside the existing `if (!deactivating)` block, after `panel.render`):

```ts
const completed = results.filter((r) => r.status === "done").map((r) => r.sql);
invalidateAfterSchemaDdl?.(completed, active?.driver);
```

**Seam payload (pinned).** `runner.run()` resolves to `StatementResult[]`; the record shape is the
exported `StatementResult` interface (`queryRunner.ts:49-52`): `status: StatementStatus` (line 52) and
the original statement text on `sql: string` (line 51). So `r.status`/`r.sql` are the actual field names
and the seam receives the real statement SQL text — never undefined. Executor: pin these two field names
in 004's mocked result records and assert the seam receives the exact text (004 test row below).

**Failure semantics (why "completed" is the right filter).** `QueryRunner.run()` never throws per-statement
— `executeAll` marks a statement `error` and cancels the remainder (`queryRunner.ts:331-352`). A batch can
therefore resolve with a mix of `done`/`error`/`cancelled`. Only `done` statements genuinely completed, so
only those are fed to the classifier; a `CREATE` that itself errored, a cancelled batch, and a
`confirmDangerousStatements` rejection (early return `extension.ts:1719-1721`, before `runner.run`) all
leave the caches untouched. A `done` `CREATE` earlier in a batch that later fails still invalidates — the
schema DID change.

**Classifier semantics (reconciliation with existing guards).** Import source: the classifier imports
`maskLiteralsAndComments` from `./dangerousStatement` (`src/core/dangerousStatement.ts:90` — where the
symbol actually lives; `readOnlyIntent` re-imports the same symbol at `readOnlyIntent.ts:9`), never from
`readOnlyIntent`. It mirrors the depth-0 token-scan STRUCTURE of `readOnlyIntent.statementIsMutation`
(`readOnlyIntent.ts:60-95`) as a reference pattern, not its import graph:
`maskLiteralsAndComments(sql, dialect)` → depth-0 token scan, `with` prelude skipped. Schema-impact keyword set = `{create, alter, drop, rename}`. Relationship to
`readOnlyIntent` (mutation set `{insert,update,delete,merge,truncate,drop,alter,create,grant,revoke,comment,lock}`):
schema-impact is a STRICT SUBSET of mutation on the DDL keywords, PLUS `rename`; DML words (insert/update/
delete/merge/truncate) mutate data but NOT schema → false. `drop` overlaps `dangerousStatement`'s red tier
(so it is confirmed before running, and only a confirmed+successful DROP invalidates). `rename` is a
standalone depth-0 keyword only in MySQL (`RENAME TABLE`); Postgres/MSSQL rename routes through
`ALTER TABLE … RENAME TO` which already matches `alter`. `readOnlyIntent` does NOT list `rename` as a
mutation — a pre-existing, separate gap, out of scope, documented for the reviewer. `TRUNCATE`/`VACUUM`/
`ANALYZE`/`COMMENT ON` are deliberately false (data/maintenance/metadata-only, absent roadmap evidence).

**ARP-02 composition.** The seam call sits inside the existing `if (!deactivating)` success block
(`extension.ts:1754-1756`) — no invalidation or tree write after teardown started, mirroring the ARP-02
sentinel. The `ownsRun` snapshot and `finally` busy gate are untouched.

**Rejected alternatives.** (a) Invalidating on ANY completed run — over-invalidates on SELECT/INSERT,
cheap but defeats the roadmap's success-only contract. (b) Server event subscriptions / trigger-based
invalidation — explicitly out of scope. (c) New parser for the classifier — rejected; `maskLiteralsAndComments`
is already dialect-correct (MySQL backslash/backtick) and shared. (d) A `runStatements` signature change
threading the seam through three callers — rejected; module-level seam keeps the shared path's signature
stable and centralizes the refresh.

**ADR decision: NO ADR.** ARP-07 introduces no new policy, security-posture, or cross-cutting contract —
it wires the existing `invalidate()` seams behind a classifier. ADRs 0001-0003 were gating decisions
(identity policy, resilience contract, fail-closed AI policy); this is additive cache hygiene with a
code-comment + reviewer reconciliation, not an architecture decision. Next free number `0004` stays unused.

## §4 Test Plan

Happy-path shape for every task plus ≥2 edge cases of DIFFERENT kinds. All `Expected` values are concrete.

| Task | Type | Test name | Expected |
|---|---|---|---|
| 001 | happy | `hasSchemaImpact("CREATE TABLE users (id int)", "postgres")` | `true` |
| 001 | happy | DROP / ALTER / RENAME depth-0 | `true` each (e.g. `"DROP TABLE users"`, `"ALTER TABLE users ADD COLUMN email text"`, `"RENAME TABLE a TO b"` mysql) |
| 001 | happy | SELECT and DML (INSERT/UPDATE/DELETE/MERGE/TRUNCATE) | `false` each |
| 001 | edge (literal masking) | `"INSERT INTO t VALUES ('DROP TABLE users')"` | `false` — keyword inside string literal |
| 001 | edge (comment masking) | `"/* DROP TABLE users */ SELECT 1"` and `"SELECT 'CREATE' FROM t"` | `false` — comment and quoted literal masked |
| 001 | edge (boundary — CTE/parens) | `"WITH x AS (SELECT 1) SELECT * FROM x"` and `"SELECT count(*) FROM users"` | `false` — WITH prelude skipped; parens not depth-0 |
| 001 | edge (dialect) | MySQL backtick identifier `` "SELECT `create` FROM t" `` and backslash-escaped literal body, `dialect="mysql"` | `false` — masking honors MySQL escaping/backticks |
| 001 | edge (data-only) | `"TRUNCATE TABLE users"`, `"VACUUM ANALYZE users"` | `false` — data/maintenance, not schema |
| 001 | happy (batch) | `completedSchemaImpact(["SELECT 1", "CREATE TABLE t (id int)"])` | `true` |
| 001 | edge (batch empty / none) | `completedSchemaImpact([])` and `["SELECT 1", "INSERT INTO t VALUES (1)"]` | `false` both |
| 002 | regression | `#3` variant renamed for DDL: completion lookup in-flight at the moment a successful DDL invalidates → pre-invalidate response never becomes cache state; next `getTables` refetches fresh | passes against CURRENT code (guard `schemaCache.ts:374`); cache slot empty after invalidate |
| 002 | edge (order) | invalidate before a fetch starts | normal fresh fetch, no stale window |
| 002 | edge (boundary) | invalidate during a multi-family fetch (tables + columns in flight) | neither family commits stale data |
| 003 | regression (RED first) | invalidate() during an in-flight hydration → hydration resolves → entry must NOT be committed; next `resolve` re-hydrates (`listTables` called again) | RED before fix (unconditional commit `schemaContextCache.ts:175-180`), GREEN after |
| 003 | regression (RED first) | resolve() called AFTER invalidate() while a pre-invalidate hydration is still in flight → starts a FRESH hydration (new adapter call), does not coalesce onto the stale in-flight one | RED before fix, GREEN after |
| 003 | edge (idempotent) | `invalidate()` twice with no hydration; `invalidate()` with empty cache | no-op; next `resolve` re-hydrates once |
| 003 | happy (contract kept) | existing "repeated resolve same connection → same reference" and "invalidate() refreshes" (`schemaContextResolver.test.ts:167,187`) | unchanged and passing — identity guard + by-reference cache-hit intact |
| 004 | happy | successful `CREATE TABLE t (id int)` through the shared run path (mocked caches) | `schemaCache.invalidate`, `acSchemaCache.invalidate`, `tree.refresh` each called once |
| 004 | happy | batch `SELECT 1; CREATE TABLE t(id int)` (mixed) | seam fires (the completed CREATE changed schema) |
| 004 | edge (failed DDL) | the CREATE statement itself errors (adapter throws) → runner marks it `error`, rest `cancelled` | seam NOT called |
| 004 | edge (rejected confirmation) | `confirmDangerousStatements` resolves false (mocked) | early return before `runner.run` — seam NOT called |
| 004 | edge (cancelled run) | cancelled before any statement completes → no invalidation | seam NOT called |
| 004 | edge (deactivating) | `deactivating === true` at success time | seam NOT called — no post-teardown write (ARP-02) |
| 004 | edge (DML-only) | successful `INSERT`/`UPDATE`/`TRUNCATE` | seam NOT called (classifier false) |
| 004 | happy (non-DDL) | successful `SELECT` run | caches untouched (invalidate NOT called) |
| 004 | edge (seam payload) | mocked `done` StatementResult carries the original statement text on `StatementResult.sql` (`queryRunner.ts:49-52`) → seam receives that exact text, never undefined | captured `completed[0] === "CREATE TABLE t (id int)"` |

## §5 Verification

Exact commands the executor runs for each task (focused test + static gate; no lint script exists). See
`package.json` `scripts`: `test` (vitest run), `typecheck` (tsc --noEmit).

```bash
# TASK-ARP07-001
npm test src/core/__tests__/schemaImpact.test.ts && npm run typecheck

# TASK-ARP07-002
npm test src/ui/__tests__/schemaCache.test.ts && npm run typecheck

# TASK-ARP07-003
npm test src/ai/__tests__/schemaContextResolver.test.ts && npm run typecheck

# TASK-ARP07-004
npm test src/extension.test.ts && npm run typecheck
```

Note: the tests-map entry for `src/ai/schemaContextCache.ts` is STALE — it resolves to
`src/ai/tools/__tests__/schemaContext.test.ts` (which only tests `formatSchemaContext`). The real cache
tests live in `src/ai/__tests__/schemaContextResolver.test.ts`; pin that file. Do NOT run the full suite by
default; run it only once at cycle close as a regression net (`npm test`), not per task.

## §6 Acceptance

- [ ] ARP-07.1: `hasSchemaImpact`/`completedSchemaImpact` pass the §4 corpus; no change to `dangerousStatement.ts`; module header documents the reconciliation with `readOnlyIntent`/`dangerousStatement` (schema-impact ⊂ mutation on DDL keywords + `rename`; DML/data-only false).
- [ ] ARP-07.2: feature-named regression test passes against current `SchemaCache`; `schemaCache.ts` changed ONLY if a test exposed a gap (expected: no change, record evidence in the Executor Report).
- [ ] ARP-07.3: the two RED-first regression tests fail on the current commit and pass after the `schemaContextCache.ts` fix; existing cache tests (`167,187,206,316`) pass unchanged; `SchemaContextCache` interface identical.
- [ ] ARP-07.4: after a successful schema-impacting run through the shared path, the next completion/tree/AI lookup cannot use stale locally changed schema (invalidate + tree.refresh fired exactly once); failed/cancelled/rejected-confirmation/deactivating DDL never invalidates; ARP-02 `ownsRun`/`deactivating` logic byte-identical in behavior.
- [ ] Reviewer reconciles the classifier semantics with dangerous/read-only classification; focused tests + `npm run typecheck` green; full suite green at cycle close.
- [ ] Manual: create / rename / drop via console run, editor `vsdb.runQuery`, and CodeLens run → completion list, schema tree, and AI context reflect the fresh names without manual `vsdb.refreshSchema`. (Scope note: form-view DDL and AI plan-apply are NOT covered this cycle — Known gap.)

## §7 Global Constraints

Every `TASK-ARP07-xxx.md` inherits these by reference — do not repeat them inside tasks.

- Version/stack: Node v22.22.1, npm, vitest. **No lint script** — the static gate is `npm run typecheck`. Run focused tests, never the full suite by default.
- `src/core/schemaImpact.ts` is a NEW roadmap-sanctioned core file; it imports (never modifies) `maskLiteralsAndComments` from `./dangerousStatement` and `SqlDialect` from `./statementParser`.
- Same-wave file disjointness is absolute (see §2). A task edits only its own Target Files.
- ARP-02 (extension.ts): preserve the `ownsRun` snapshot and the `deactivating` sentinel; the invalidation seam fires from the success path only and is gated on `!deactivating` — no post-deactivation writes.
- ARP-03 retained-row cap, ARP-04 tunnel identity, ARP-06 AI policy: untouched.
- Do NOT touch `docs/AI_HANDOFF/RUN.md`; do NOT commit.

## Planner Report

PLANNER_MODEL: claude-opus-5

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: (1) Corrected all stale roadmap extension.ts citations to real wiring lines (331-333/521-526/718-721/1705-1769); (2) promoted ARP-07.3 from "regression verify" to a real FIX — grounding proved `schemaContextCache.hydrate()` commits its entry unconditionally (175-180), so invalidate-during-hydration lands a stale entry; (3) pinned 07.3's test file to `schemaContextResolver.test.ts` because the tests-map entry for `schemaContextCache.ts` is stale; (4) designed the seam as a module-level callback to avoid touching the 3 `runStatements` call sites and to keep the ARP-02 `ownsRun` path byte-identical.
Known gaps: (1) Form-view DDL (`src/ui/tableCommands.ts` `runDdl`) and AI plan-apply (`src/ui/aiChatPanel.ts` `handlePlanApprove`) run `adapter.runQuery` directly and are NOT wired this cycle — roadmap candidate set excludes those files; the module-level seam is the designed consumption point for a follow-up, and the manual acceptance box is scoped to the shared runStatements surfaces (console/editor/codelens). (2) Transaction rollback is out of scope per roadmap: a `done` schema statement later rolled back by a `ROLLBACK` in the same batch still invalidates. (3) `readOnlyIntent` does not list `rename` as a mutation — a pre-existing separate gap, documented for the reviewer, not fixed here.

## Plan Review Log

### Round 1 — 2026-09-02 · unic-smart
Status: Approved

COMPLETENESS:
  - none — no TODO/TBD; every §4 test has a concrete Expected value; 002 verify-first properly gated (schemaCache.ts changed only if a test exposes a gap, evidence recorded); 003 has genuine RED-first grounded at schemaContextCache.ts:175-180; per-task focused test + `npm run typecheck` in §5; full suite only once at cycle close.
CONSISTENCY:
  - §3 Approach vs §2 Out: the classifier "mirrors readOnlyIntent.ts:60-95" but §7 pins the import to `./dangerousStatement`. Both are likely consistent (readOnlyIntent itself imports maskLiteralsAndComments), but §3 should state the import source explicitly to stop an executor wiring the wrong module. Fix: one line in §3 naming `./dangerousStatement` as the import.
  - §4 row 004 "cancelled run → no done statement" reads like an invariant, but §3 failure semantics explicitly lets done-before-failure statements count. Fix: reword to "cancelled before any statement completes → no done → seam NOT called" so it does not contradict the batch semantics.
CLARITY:
  - §3 seam snippet `results.filter((r) => r.status === "done").map((r) => r.sql)` assumes the QueryRunner result record carries `.status` and the original statement text. The plan cites queryRunner.ts:331-352 for error/cancelled marking but never confirms the record shape. If the completed record lacks the SQL text, the classifier receives undefined and invalidation silently no-ops — the exact failure ARP-07 closes. Fix: in 004, verify the result record's status + statement-text field (or thread the statement list beside results), and add a 004 assertion that the seam receives the real SQL, not undefined.
SCOPE:
  - none — success-only contract testable (§4 004 rows for failed/rejected/cancelled/deactivating/DML-only all assert seam NOT called); out-of-scope list matches the roadmap; known gaps (form-view DDL runDdl, AI plan-apply handlePlanApprove, transaction rollback, readOnlyIntent rename gap) documented honestly in §2/§6/Self-Audit; seam is the roadmap-named single host seam, not a speculative abstraction.
YAGNI:
  - none — rejected alternatives (no new parser, no runStatements signature threading, no server subscriptions) show restraint; keyword set is a strict subset of mutation + rename; dependency order {001,002,003}→{004} is conservative (004 strictly needs only 001) but harmless.

NOTES: Executor=claude-opus-5 (planner), Reviewer=unic-smart, matches config handoff.reviewer.model. Round-1 approval; findings 1-3 are executor-facing clarifications, none risks a flawed build.

#### Round 1 minors applied (no re-review per Approved verdict)
PLANNER_REVISION_1: §3 seam payload pinned + §4 004 row added — `runner.run()` resolves to `StatementResult[]` (`queryRunner.ts:49-52`) with field `status` (line 52) and original text on `sql` (line 51); the seam therefore receives the real statement SQL, never undefined. Executor must pin these two field names in 004's mocked result records.
PLANNER_REVISION_2: §3 classifier import source made explicit — `maskLiteralsAndComments` is imported from `./dangerousStatement` (`dangerousStatement.ts:90`, where it actually lives; `readOnlyIntent` re-imports it at `readOnlyIntent.ts:9`). `readOnlyIntent.ts:60-95` is cited only as the mirrored depth-0 token-scan STRUCTURE, not the import source. Aligns with §7.
PLANNER_REVISION_3: §4 004 "cancelled" row reworded to "cancelled before any statement completes → no invalidation" so it cannot be read as contradicting the done-before-failure batch semantics (§3).
