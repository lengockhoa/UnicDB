# PLAN_ARP01 — Read-only enforcement completeness (transaction execution boundary)

Source: `docs/plans/2026-09-01-UnicDB-additive-roadmap.md` §ARP-01 (P0, no deps).
Base: `main @ a948b3f` (v1.36.0). Executor: `unic-code`. Reviewer: `unic-smart`.
Full-suite baseline: **2952 passed | 2 skipped** (from `npm test`).

## §1 Intent

**Problem.** The read-only promise currently wraps `adapter.runQuery` only. A caller
can obtain an optional transaction via `DbAdapter.beginTransaction?()` and the
returned `DbTransaction.runQuery()` is NOT wrapped by `guardAdapter()` —
`src/core/connectionManager.ts:652-669` (the real `guardAdapter`) only replaces the
`runQuery` property; `src/adapters/types.ts:86-95` (`DbTransaction`) and
`:123` (`beginTransaction?()`) are separate interfaces that escape the guard. This is a
concrete policy boundary: a read-only connection that opens a manual transaction can
execute any mutation through `tx.runQuery()` with no interception. The existing
classifier (`src/core/readOnlyIntent.ts:25-107`) blocks key DML/DDL/DCL forms, writable
CTEs, EXPLAIN-wrapped mutation, and PostgreSQL backend admin calls, but it is not a full
SQL parser and its per-dialect behavior is currently incidental rather than formalized.

**Success.** (1) A mutation sent through a transaction obtained on a read-only adapter is
blocked before the underlying driver is invoked, with no signature changes; (2) classifier
behavior is formalized by dialect (`postgres`/`mysql`/`mssql`) with the decisions pinned by
tests; (3) safe reads, commit/rollback, and the pre-existing `runQuery` guard are unchanged.

## §2 Scope

**In**
- ARP-01.1 — classifier matrix: formalize per-dialect behavior of `readOnlyIntent.ts`;
  document dialect candidates and the transaction-control decision; fix the MySQL
  backtick-identifier false positive (confirmed RED against a948b3f, see §4).
- ARP-01.2 — transaction guard: wrap `DbAdapter.beginTransaction?()` inside
  `guardAdapter()` so the returned `DbTransaction.runQuery()` is guarded. No signature
  change to `DbAdapter`/`DbTransaction`; `src/adapters/types.ts` untouched.
- ARP-01.3 — interface regression: prove the optional execution API (`beginTransaction` /
  `DbTransaction.runQuery`) has no bypass path; may close as not-needed if the evidence
  shows `types.ts` and the `adapterQueryShape.test.ts` fixture are byte-identical.

**Out** (explicit, from roadmap)
- Server-side read-only roles/sessions; a full SQL parser dependency; confirmation-based
  exceptions; changing commit/rollback semantics without an explicit decision.
- Parser dependency rejected in §3 (roadmap line 461: introduce only if a shared tokenizer
  corpus proves a harmful gap).

**Same-wave file disjointness (absolute)**
- Wave 1: ARP-01.1 owns `src/core/readOnlyIntent.ts` (+ test). ARP-01.2 owns
  `src/core/connectionManager.ts` (+ test). No file shared.
- ARP-01.1 MAY also touch `src/core/dangerousStatement.ts` (`maskLiteralsAndComments`,
  the masking seam) for the MySQL backtick fix — that file is owned by no other task in
  this cycle, so the wave stays disjoint. The executor may alternatively apply a
  readOnlyIntent-local mask; both are cycle-in-scope (documented in task Discussion).
- Wave 2: ARP-01.3 owns `src/adapters/types.ts` and `src/adapters/__tests__/adapterQueryShape.test.ts`
  **only if a change is needed** — otherwise closes as not-needed.
- ARP-01.2 must NOT change `types.ts`; the wrap is an inline closure in `guardAdapter`.

## §3 Approach

**Seam.** Every real transaction consumer obtains its adapter through `ConnectionManager`:
`getAdapter()` (`:543`, active path via `buildAdapter` `:398-412`) and `getAdapterFor()`
(`:343-374`, passive/schema-tree path) both route through `guardAdapter()`
(`:652-669`). Consumers: `QueryRunner.beginTransaction()` (`src/core/queryRunner.ts:419-424`),
ResultsPanel save-through-transaction (`src/ui/resultsPanel.ts:1057`), and import
dry-run execute (`src/core/importer/importExecute.ts:127-137`). Therefore wrapping
`beginTransaction` inside `guardAdapter()` covers every real caller with one change.

**Transaction wrap (ARP-01.2).** Extend `guardAdapter`:
```
if (!cfg.readOnly) return adapter;
// existing runQuery wrap (unchanged)
const originalBegin = adapter.beginTransaction?.bind(adapter);
if (originalBegin) {
  Object.defineProperty(adapter, "beginTransaction", {
    configurable: true, enumerable: true, writable: true,
    value: async () => {
      const tx = await originalBegin();
      const txQuery = tx.runQuery.bind(tx);
      Object.defineProperty(tx, "runQuery", {
        configurable: true, enumerable: true, writable: true,
        value: (sql: string, values?: unknown[]) => {
          if (isMutationSql(sql)) throw new ReadOnlyViolation(mutationStatements(sql));
          return txQuery(sql, values);
        },
      });
      return tx;
    },
  });
}
```
- `commit()`/`rollback()` pass through untouched (retain rollback behavior; commit/rollback
  semantics unchanged — roadmap Out).
- `adapter.beginTransaction === undefined` → nothing added (optional API preserved).
- Optional, low-risk synergy: thread `cfg.driver` into `isMutationSql(sql, cfg.driver)` if
  `ConnectionConfig.driver` is the same `"postgres"|"mysql"|"mssql"` union as `SqlDialect`
  — this makes the guard benefit from ARP-01.1's dialect masking. Not required; default
  (postgres) is acceptable and fully covered.

**Classifier dialect formalization (ARP-01.1).** `SqlDialect = "postgres" | "mysql" |
"mssql"` (`src/core/statementParser.ts:21`). The mutation-keyword scan (`statementIsMutation`,
`readOnlyIntent.ts:53-88`) is intentionally dialect-agnostic: the depth-aware top-level scan
over `MUTATION_KEYWORDS` (`:31-44`) is identical for the three dialects. What differs by
dialect is (a) statement splitting and (b) literal/comment/identifier masking in
`maskLiteralsAndComments` (`src/core/dangerousStatement.ts:89-194`, which already takes
`dialect` for MySQL backslash-escapes). Decisions to pin:
1. **Transaction control is NOT a mutation** — `BEGIN`/`COMMIT`/`ROLLBACK`/`START
   TRANSACTION`/`SAVEPOINT`/`RELEASE` change no data, schema, or permission; blocking them
   would also fight the "retain rollback behavior" scope. Document + pin by test (they
   already return false; the decision formalizes it).
2. **MySQL backtick-quoted identifiers must not leak fake keywords** — `maskLiteralsAndComments`
   masks `'...'`, `"..."`, `$tag$...$tag$`, `--`, `/* */` but has NO backtick branch.
   Confirmed RED (probe run 2026-09-01): `isMutationSql("SELECT \`insert\` FROM t", "mysql")`
   returns `true` today (false positive — blocks a safe SELECT on a column/table named
   `insert`). Fix: add a `` `...` `` (backtick, with ```` ```` `` escape) masking branch in
   `maskLiteralsAndComments` gated on `dialect === "mysql"`, so the masked span hides the
   identifier from the depth-scan. Preferred (B6 seam: fake keywords inside quoted spans
   must not slip through; also fixes `analyzeStatement`/`isPgBackendAdminCall` consumers of
   the same masker). Alternative (if the executor prefers to keep the diff inside
   `readOnlyIntent.ts`): a local backtick-blanking pre-pass in `mutationStatements` when
   `dialect === "mysql"`. Either way the mutation scan itself stays untouched.
3. **Dialect candidates documented** — a doc block in `readOnlyIntent.ts` enumerating the
   three dialects and stating that keyword classification is dialect-agnostic while
   split/mask are dialect-driven.

**Rejected alternatives.** Full SQL parser (roadmap Out — heavy dependency, current guards
are tested/conservative; the backtick fix removes the only known false positive). Wrapping
at the adapter level (postgres.ts `beginTransaction` `:458`, mysql.ts `:306`) instead of in
`guardAdapter` — would leak the guard for non-ConnectionManager callers and couple the
drivers to the read-only policy. Changing `DbTransaction`/`DbAdapter` signatures — explicitly
out (must preserve the optional API).

## §4 Test Plan

### ARP-01.1 — classifier matrix (`src/core/__tests__/readOnlyIntent.test.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy | Safe SELECT not a mutation (postgres default) | `isMutationSql("SELECT * FROM t")` → `false` |
| happy | CTE SELECT not a mutation | `isMutationSql("WITH x AS (SELECT 1) SELECT * FROM x")` → `false` |
| edge: identifier masking | MySQL backtick-quoted keyword identifier | `isMutationSql("SELECT \`insert\` FROM t", "mysql")` → `false` — **RED today**, flips GREEN after the backtick fix |
| edge: transaction control | `COMMIT`/`ROLLBACK`/`BEGIN`/`START TRANSACTION`/`SAVEPOINT x` are not mutations | each → `false` (decision pinned, not incidental) |
| edge: dialect threading | Core DML classified identically across all three dialects | `isMutationSql("DELETE FROM t", d)`, `("UPDATE t SET a=1", d)`, `("INSERT INTO t VALUES (1)", d)` → `true` for `d` in `postgres`/`mysql`/`mssql` |
| edge: batch composition | Transaction-control + safe SELECT batch | `mutationStatements("COMMIT; SELECT 1")` → `[]`; `mutationStatements("SELECT 1; COMMIT; DELETE FROM t")` → exactly `["DELETE FROM t"]` |
| regression | Writable CTE / EXPLAIN ANALYZE / admin DCL | existing assertions (readOnlyIntent.test.ts:61-74, :30-33) stay green |

### ARP-01.2 — transaction guard (`src/core/__tests__/connectionManager.test.ts`, reuse `STUB_CTX` + factory pattern at :411-437, fake adapter gains a `beginTransaction` that returns `{ runQuery, commit, rollback }` over a tracked `runs[]` driver)

| Type | Test name | Expected |
|---|---|---|
| happy | readOnly tx `SELECT` passes to driver once | `tx.runQuery("SELECT 1")` → driver tx-`runQuery` called once, result returned |
| edge: block-before-driver | readOnly tx `DELETE` throws before driver | `tx.runQuery("DELETE FROM t")` throws `ReadOnlyViolation`; driver tx-`runQuery` never called (`runs[]` stays empty) — **RED today** (unwrapped tx would call driver), flips GREEN after the wrap |
| edge: optional API preserved | adapter without `beginTransaction` | guarded `adapter.beginTransaction` stays `undefined`; `adapter.runQuery` still guarded |
| edge: per-call freshness | two `beginTransaction()` calls each guard their own tx | second tx mutation also throws; first tx `commit()`/`rollback()` unaffected |
| edge: non-readOnly regression | `readOnly: false` tx mutation passes through | no `ReadOnlyViolation`; driver tx-`runQuery` called |
| edge: values passthrough | `tx.runQuery(sql, values)` forwards args unchanged | driver receives `(sql, values)` |
| regression | commit/rollback pass through | `tx.commit()`/`tx.rollback()` call the driver once each |

### ARP-01.3 — interface regression (`src/adapters/__tests__/adapterQueryShape.test.ts` only if fixture change is needed)

| Type | Test name | Expected |
|---|---|---|
| happy (type) | `DbTransaction` interface shape unchanged | a typed fixture consuming `runQuery(sql, values?)` / `commit()` / `rollback()` compiles |
| edge (type) | guarded adapter still satisfies `DbAdapter` | object with `runQuery` + optional `beginTransaction?(): Promise<DbTransaction>` typechecks as `DbAdapter` |
| edge (runtime) | no optional-API bypass | the ONLY way to obtain a transaction on a guarded adapter is `beginTransaction()`, which is wrapped — runtime assertion added to `adapterQueryShape.test.ts` IF a fixture change is genuinely needed |
| decision | close-as-not-needed gate | evidence checklist in §6/ARP-01.3 §Acceptance; if all hold, close with documented rationale instead of a code change |

## §5 Verification Commands

Run inside a clean worktree on `main @ a948b3f`. No real DB required — all suites are
mocked (`pg` Pool/Client, `vscode` module, fake adapters).

- **ARP-01.1** (wave 1):
  ```bash
  npx vitest run src/core/__tests__/readOnlyIntent.test.ts
  npm run typecheck
  npm run compile
  ```
- **ARP-01.2** (wave 1):
  ```bash
  npx vitest run src/core/__tests__/connectionManager.test.ts
  npm run typecheck
  npm run compile
  ```
- **ARP-01.3** (wave 2, after 001+002):
  ```bash
  npx vitest run src/adapters/__tests__/adapterQueryShape.test.ts   # only if fixture changed
  git diff a948b3f -- src/adapters/types.ts                          # expect empty (or only ARP-01.3's own change)
  git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts # expect empty if closed as not-needed
  npm run typecheck
  npm run compile
  ```
- **Wave-2 net (after all three tasks)**:
  ```bash
  npm test
  ```
  Expected: **≥ 2952 passed | 2 skipped** (baseline at a948b3f).

Note on test selection: per RULES resolution order, `src/` targets resolve through the
`tests` array in `.cache/index/tests-map.json` — `readOnlyIntent.ts → readOnlyIntent.test.ts`,
`connectionManager.ts → connectionManager.test.ts` (verified present). `types.ts` maps to
zero tests; ARP-01.3 therefore pins its own test file (`adapterQueryShape.test.ts`) directly.
There is no `lint` script in `package.json` (scripts: `test`, `typecheck`, `compile`,
`watch`, `test:integration`, `package`, `verify:fast`, `verify:release`); typecheck +
compile are the static gates.

## §6 Acceptance Criteria

Every criterion traces to a task.

- [ ] **ARP-01.1** — MySQL backtick false positive fixed: `isMutationSql("SELECT \`insert\` FROM t", "mysql")` is `false` (test was RED on a948b3f; RED output pasted before implementation).
- [ ] **ARP-01.1** — transaction-control decision pinned: `BEGIN`/`COMMIT`/`ROLLBACK`/`START TRANSACTION`/`SAVEPOINT` are `false` (not mutations).
- [ ] **ARP-01.1** — dialect candidates documented in `readOnlyIntent.ts` (postgres/mysql/mssql; keyword scan dialect-agnostic, split/mask dialect-driven).
- [ ] **ARP-01.1** — all matrix tests in `readOnlyIntent.test.ts` green; `npm run typecheck` + `npm run compile` exit 0.
- [ ] **ARP-01.2** — a mutation through a transaction obtained on a read-only adapter throws `ReadOnlyViolation` and the underlying driver's `runQuery` is never called (test was RED on a948b3f).
- [ ] **ARP-01.2** — readOnly tx `SELECT` passes to driver once; `commit()`/`rollback()` pass through unchanged; adapter without `beginTransaction` gains nothing; `readOnly:false` unchanged.
- [ ] **ARP-01.2** — `src/adapters/types.ts` byte-identical to base (no signature change).
- [ ] **ARP-01.3** — evidence documented for the decision: `git diff a948b3f -- src/adapters/types.ts` empty AND `git diff a948b3f -- src/adapters/__tests__/adapterQueryShape.test.ts` empty → closed as not-needed with rationale; OR a fixture/test was added that proves no optional-API bypass. `npm run typecheck` + `npm run compile` exit 0 either way.
- [ ] **Cycle** — `npm test` full suite: **≥ 2952 passed | 2 skipped** (no regression).
- [ ] **Reviewer** verdict APPROVED or APPROVED-WITH-MINOR on PLAN and on each task.
- [ ] **Security review** checklist item from roadmap: every optional execution API on `DbAdapter`/`DbTransaction` reviewed for bypass (recorded in ARP-01.3 evidence).

## §7 Global Constraints

- Base: `main @ a948b3f` (v1.36.0). All work in a fresh worktree; no git commit in P2/P3 (release step is separate).
- No signature changes to `DbAdapter`/`DbTransaction`; `src/adapters/types.ts` untouched unless ARP-01.3 (wave 2) proves a change strictly necessary.
- Same-wave file disjointness absolute: ARP-01.1 owns `readOnlyIntent.ts`(+test) [+ `dangerousStatement.ts` if the masking seam is used]; ARP-01.2 owns `connectionManager.ts`(+test); ARP-01.3 owns `types.ts`/`adapterQueryShape.test.ts` only-if-needed.
- TDD mandatory: RED output pasted before implementation in every task report.
- No lint script exists — static gate is `npm run typecheck` + `npm run compile`.
- Keep `guardAdapter`'s existing `runQuery` behavior byte-identical; only add the `beginTransaction` wrap.
- Do not change commit/rollback semantics, read-only roles/sessions, or introduce a parser dependency.
- Preserve existing `DbAdapter.beginTransaction?()` optionality — never force it present.

---

## Planner Report

PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 1, 3 advisory findings — non-blocking, tracked in Plan Review Log)

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit:
- Source-plan line citations corrected to the real code: `guardAdapter` is at connectionManager.ts:652-669 (not 394-410, which is `buildAdapter`); `beginTransaction?` is types.ts:123 and `DbTransaction.runQuery` types.ts:92.
- RED-first proof made real: probed `isMutationSql("SELECT \`insert\` FROM t", "mysql")` and the tx-block case; both are RED against a948b3f (probe test created and removed after run; no src/ changes left).
- Wave disjointness verified file-by-file (incl. the optional `dangerousStatement.ts` fix target, owned by no other cycle task).
- Tests-map resolution applied: types.ts → 0 tests, so ARP-01.3 pins its own test file and records the fallback.
Known gaps:
- `ConnectionConfig.driver` union could not be re-verified (src/config is denied to this planner); the optional dialect-threading in ARP-01.2 is written as an optional, guarded decision — the default (postgres) path is fully acceptable and covered.
- `#` MySQL comments are not masked today (another latent false positive); noted in ARP-01.1 Discussion as an optional secondary fix, NOT a hard requirement, to keep the change reviewable.

---

## Plan Review Log

### Round 1
REVIEWER_MODEL: unic-smart
VERDICT: Approved
FINDINGS:
  1. [advisory] §5 ARP-01.1 verification block omits `dangerousStatement.test.ts`, yet §6/§2 permit the `dangerousStatement.ts` masking-seam path; a regression in that file would slip past the plan's commands. Fix when the seam path is chosen: add `npx vitest run src/core/__tests__/dangerousStatement.test.ts` to the ARP-01.1 verification/acceptance (task-001 already requires it; align the plan).
  2. [advisory] §4 ARP-01.2 "values passthrough" row implies `UPDATE` reaches the driver, but a mutation is blocked pre-driver; the task file correctly substitutes `SELECT $1`. Fix: restate the plan row with a non-mutation SQL.
  3. [advisory] §3 ARP-01.1 fixes only MySQL backticks; MSSQL bracket-quoted identifiers (`[insert]`) are the same false-positive class and are neither probed nor pinned. Fix: document the MSSQL identifier-masking decision (fix vs. defer) in the dialect-candidate doc block so "formalize by dialect" is unambiguous.

NOTES: All §2 file ownership, §5 DB-free commands, §6 acceptance criteria, and the wave-1/2 dependency graph match the roadmap and the three task files (001/002 wave 1, 003 wave 2); every cited source anchor verified real (guardAdapter 652-669, getAdapterFor 343, buildAdapter 398, getAdapter 543, readOnlyIntent.ts 25-107, types.ts 86-95/123, dangerousStatement.ts 89-194, queryRunner 419, resultsPanel 1057, importExecute 127, postgres.ts 458, mysql.ts 306); the MySQL backtick false-positive and the unwrapped tx-boundary RED claims confirmed by inspection; baseline 2952/2 corroborated by DX01 records; no lint script exists, typecheck+compile are the static gates.
