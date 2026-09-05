# Cycle X Plan — Adversarial QA and correctness hardening

## §1 Intent

The user wants the most reliable runnable UnicDB release, not another feature-heavy cycle. Cycle X therefore starts with an adversarial review of the shipped `v1.6.3..v1.6.6` changes, fixes the known aggregate-only AG Grid test flake at its test-harness root cause, and closes selected small hardening gaps whose real source paths and interfaces are already known.

Success means:

1. two independent audit reports cover the high-risk host/adapter and webview/grid surfaces, with every finding carrying severity, evidence (`file:line`), reproduction, and disposition;
2. every confirmed P0/P1 and every small-to-medium P2 audit finding is either represented by a bounded follow-up task or explicitly queued with rationale—never silently ignored;
3. `resultsGridModelNull.test.ts` no longer installs repeated bundle listeners/grids and remains green under deterministic shuffled single-worker stress;
4. whitespace-only string values round-trip through `(Blanks)` consistently, all SQL wrappers use one trailing-semicolon normalizer, and MySQL gains the real adapter sort helper;
5. MySQL sessions and driver parsing are normalized to UTC, while MSSQL's already-default UTC behavior becomes explicit, so UTC-derived filter literals are not interpreted through the extension host machine's local timezone;
6. compile, typecheck, targeted suites, the full 1494-test baseline, and VSIX packaging all pass.

Scope complexity: MODERATE. The work spans several layers of one SQL-client subsystem, not independent products. Audit is a mandatory gate; keyset paging is deliberately deferred because it is a separate protocol/data-model project.

## §2 Scope

### In scope

- **TASK-001:** adversarial audit of adapter, query-runner, save-path, statement-parser, and extension-host changes in `v1.6.3..v1.6.6`; report to `docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md`.
- **TASK-002:** adversarial audit of result-panel, query-composer, messages, grid/webview, completion, and SQL-coloring changes in the same tag range; report to `docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md`.
- **TASK-003:** test-harness root-cause fix for the known `resultsGridModelNull.test.ts` case 6 flake. Evidence already confirmed: `loadBundle()` evaluates `dist/webview.js` once per test, while the bundle installs an anonymous `window.message` listener and creates AG Grid state that the test cannot remove. The sixth test therefore runs with six bundle closures and deferred timers in one jsdom file.
- **TASK-004:** make whitespace-only strings part of `(Blanks)` across entry grouping, local membership, typed-value resolution, and string-column SQL (`TRIM(quotedColumn) = ''`); at the same time hoist the identical `stripTrailingSemicolon(sql: string): string` implementation from `queryComposer.ts`, `distinctValues.ts`, and `resultsGridModel.ts` into `src/core/text.ts` because the first two named files and `resultsGridModel.ts` must otherwise be edited in colliding tasks.
- **TASK-005:** add `getTableSortQuery(originalSql, whereFromBar, column, direction)` to `src/adapters/mysql.ts` and delegate the MySQL arm of `composeSortQuery` to it; normalize every MySQL pool session and MySQL date parser to UTC and set tedious `useUTC: true` explicitly.
- **Post-audit reconciliation:** after TASK-001 and TASK-002, use `TASK-006` and `TASK-007` as the normal follow-up budget for confirmed, independently testable, small-to-medium defects. This two-task budget is not a cap on critical work: if unrelated confirmed P0/P1 findings cannot fit without violating file ownership or task right-sizing, the orchestrator must create `TASK-008` onward as needed. Every added task must use `_TEMPLATE.md`, depend on the relevant audit task(s), obey grounding/test rules, and preserve the same-wave-no-shared-file rule; group findings only when they must own the same file. P0/P1 findings are not deferrable. Additional P2 findings and large architectural findings go to `INDEX.md` “Next cycles” with severity/evidence/rationale. If there are no real findings, create no follow-up task and record “no actionable finding” in both reports.

### Out of scope

- Keyset/cursor paging for deep offsets: it needs a stable unique cursor transported through messages, first/subsequent-page query variants, NULL ordering semantics, and mutation behavior. It does not fit a release-hardening slice and remains queued.
- Projecting absent PK columns, scoped DISTINCT values, MySQL/MSSQL `NULLS FIRST/LAST`, and typed `StateMessage.dialect`: retain the existing queue.
- Broad rewrites, speculative cleanup, dependency upgrades, schema migrations, and user-facing redesign.
- Treating audit observations as bugs without reproduction or source evidence.

### File and wave constraints

Tasks in the same wave must not modify the same file. Audit tasks own only their separate new note files; reading overlapping source is allowed. TASK-003 and TASK-004 have disjoint targets. TASK-005 depends on TASK-004 because both must modify `src/ui/queryComposer.ts`. Dynamic audit-fix tasks must be placed after their audit dependency and after any static task owning the same file; merge same-file findings rather than creating parallel collisions.

Initial graph and waves:

- Wave 1: TASK-001, TASK-002 (parallel audits).
- Reconciliation gate: materialize zero to two normal-budget grounded audit-fix tasks, or explicitly record none; expand with TASK-008 onward when confirmed unrelated P0/P1 findings require independently owned fixes.
- Wave 2: TASK-003 and TASK-004 depend on TASK-002; add non-colliding audit follow-ups with the relevant audit dependency.
- Wave 3: TASK-005 depends on TASK-001 and TASK-004; add follow-ups whose file ownership requires TASK-004/TASK-005 ordering. Any expanded P0/P1 tasks join the earliest later wave whose dependencies are satisfied and whose targets do not collide.

## §3 Approach

### 3.1 Audit before claiming release quality

Both auditors inspect the actual `git diff v1.6.3..v1.6.6`, not only current files. They trace changed public paths into existing tests and classify each observation:

- P0: data loss/security/unrecoverable corruption;
- P1: wrong SQL, wrong saved data, crash/hang, cross-statement state leak;
- P2: user-visible correctness/reliability defect;
- P3: maintainability/performance with no demonstrated wrong behavior.

A report row is actionable only with severity, `file:line`, concrete trigger, expected versus actual behavior, proposed smallest fix, and test location. Duplicates and false positives are documented as rejected. This prevents “thorough review” from degenerating into speculative task generation.

### 3.2 Flake: one bundle lifecycle, event-driven waits

Do not increase arbitrary sleeps and do not add a retry. Refactor the test harness so the bundle is evaluated once for the suite and subsequent cases reset/reuse that single grid lifecycle. Flush AG Grid's public `GridApi.flushAllAnimationFrames()` after column-definition replacement and use bounded `vi.waitFor` on observable editing/overlay state instead of assuming 50 ms is sufficient. Clear viewer/edit state between cases through existing user-visible behavior/API; do not add production test-only reset methods.

Rejected alternatives: longer `tick(500)`, `retry`, or global Vitest serialization. They hide leaked listeners and make the suite slower without proving isolation.

### 3.3 Blanks and SQL normalization

Use one shared predicate-level definition: `null`, `undefined`, `""`, and strings whose `trim().length === 0` are blank. Apply it in `buildSetFilterEntries`, `setFilterPass`, and webview typed-value lookup. For a declared string column, `(Blanks)` composes `column IS NULL OR TRIM(column) = ''`; unknown/non-string columns remain NULL-only to avoid applying `TRIM` to numeric/date values. This intentionally accepts the documented index trade-off only when the user selects `(Blanks)`.

Export `stripTrailingSemicolon(sql: string): string` from existing browser-safe `src/core/text.ts`. Import it from all three current wrapper builders. Preserve its verified behavior: strip one trailing terminator/whitespace, preserve interior semicolons, and preserve all-whitespace input as trimmed empty text. A source-contract test prevents local copies from returning.

### 3.4 Adapter symmetry and timezone contract

Implement the MySQL helper beside `MySqlAdapter`, using the real `quoteIdent(column, "mysql")` and the exact Postgres/MSSQL four-argument signature. `composeSortQuery("mysql", ...)` delegates to this helper; Postgres remains inline for now to avoid importing the `pg` driver into a pure composer path beyond current constraints.

For temporal correctness, configure mysql2 with `timezone: "Z"` and route all four verified explicit `pool.getConnection()` call sites through one adapter checkout helper. The helper must also own `MySqlAdapter.query(sql, values)` at `src/adapters/mysql.ts:397-406`: it currently calls `this.pool.query(sql, values)` directly for `information_schema` metadata queries and `executeText` non-streaming SQL, which permits an implicit replacement checkout to bypass initialization. Replace that direct pool call with helper checkout, `connection.query(sql, values)`, and `finally` release. On first checkout of each physical core connection (the promise wrapper exposes it as `connection`), await `SET time_zone = '+00:00'` before returning it to user work and remember successful initialization in a `WeakSet`; on failure release the checkout and reject rather than silently running with an unknown timezone. This is deliberately stronger than an async pool `connection` event, which mysql2 emits immediately before `acquire` without awaiting listener promises. Test checkout/queue ordering and physical-connection replacement after loss with a faithful mysql2 mock: both the replacement's `SET time_zone = '+00:00'` and its subsequent metadata/non-streaming query must occur in that order. Set tedious `options.useUTC: true` explicitly and retain UTC-naive MySQL/MSSQL `datetime` literals from `typedLiteral`. This chooses a UTC session contract over offset arithmetic in SQL literals: one invariant applies to display, DISTINCT typed values, and requery filters.

### 3.5 Audit finding materialization

The executor/orchestrator performs the reconciliation gate immediately after Wave 1. A follow-up task is allowed only after its paths, neighboring test style, real interface, and commands are verified. TASK-006 and TASK-007 are the normal budget for bounded findings, but confirmed unrelated P0/P1 findings expand the task count with TASK-008 onward rather than being deferred or forced into an unreviewable/same-file-colliding task; every expansion follows `_TEMPLATE.md` and the same-wave ownership rule. Huge findings and non-critical overflow are queued, not squeezed into an unreviewable mega-task. The initial task count is five; seven is a planning target, not a hard cap.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| audit happy | Host/adapter changed-path trace | Every changed host/adapter production file in the scoped tag diff is reviewed or explicitly excluded with reason; report contains no un-evidenced claim. |
| audit edge — malformed/error | SQL/save/cancel failure-path review | Wrong SQL, rejected query, cancellation, retry, transaction, and partial-save paths each have a disposition with source/test evidence. |
| audit edge — concurrency/state | Grid/webview async state review | Listener, timer, stale reply, tab switch, load-more, sort/filter, and commit-refresh ownership paths each have a disposition. |
| regression | Single bundle lifecycle in NULL/viewer suite | Bundle evaluation and message-listener installation occur once; all six behavior cases remain isolated and case 6 shows exactly one 500-character overlay. |
| edge — ordering/load | Shuffled single-worker flake stress | Seeds 1–5 pass without retry; read-only viewer opens after async column-def flush regardless of test order. |
| edge — cleanup | Viewer/edit state reset | An overlay or active editor from a prior case is absent before the next assertion and Escape/outside-close behavior remains functional. |
| happy | Whitespace-only set-filter entry | `[null, "", "  ", "x"]` produces one `(Blanks)` entry with count 3 and one `x` entry. |
| edge — type safety | Non-string/unknown blanks SQL | `(Blanks)` for integer or unknown column type emits only `col IS NULL`, never `TRIM(col)`. |
| edge — SQL escaping | String-column blanks SQL | MySQL/Postgres/MSSQL quote the identifier by dialect and emit `IS NULL OR TRIM(quoted) = ''`; a mixed normal value remains in the `IN` list. |
| happy | Shared trailing-semicolon helper | Each wrapper builds the same SQL as before for `SELECT 1;   ` while importing the single shared helper. |
| edge — lexical | Interior semicolon and whitespace input | `SELECT ';' AS s;` preserves the literal semicolon and strips only the terminator; whitespace-only input returns `""`. |
| happy | MySQL adapter sort twin | Helper returns `SELECT * FROM (SELECT 1) UnicDB_sort ORDER BY `backtick-name` ASC`, and composer output is identical. |
| edge — injection | MySQL quoted sort identifier | Embedded backtick/payload stays inside one doubled-backtick identifier; direction is constrained to `ASC|DESC`. |
| edge — empty/boundary | Sort WHERE/original SQL boundaries | Whitespace WHERE is omitted; DESC and empty original SQL match existing adapter contracts. |
| happy | UTC connection contract | mysql2 pool receives `timezone: "Z"`, each new connection queues `SET time_zone = '+00:00'`, and tedious receives `useUTC: true`. |
| edge — failure | Session timezone initialization fails | MySQL connect rejects and closes/resets the pool; no user query runs on an uninitialized session. |
| edge — replacement/state | Direct-query replacement connection | After the initialized physical connection is lost, `MySqlAdapter.query(sql, values)` checks out its replacement, runs `SET time_zone = '+00:00'` once before its metadata or non-streaming SQL, and releases it; no direct `pool.query()` bypass remains. |
| edge — environment | Non-UTC host process | A canonical UTC Date/filter literal remains the same under a non-UTC `TZ`; no host-local offset is introduced. |
| regression | Full release suite | After compile, `npm test` remains at least the 1494 passed / 2 skipped / 0 failed baseline (plus new tests), with zero failures. |

Each task file maps the relevant rows to concrete fixtures and expectations. Dynamic audit-fix tasks must add one happy path and at least two genuinely different edge cases; a bugfix also requires a RED-before/GREEN-after regression case.

## §5 Verification

No `lint` script exists in `package.json`; this is explicit, not omitted. The defined static check is `typecheck`.

Per-wave/targeted commands are listed in each task. Final cycle verification is exactly:

```bash
npm run compile
npm run typecheck
npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts src/ui/__tests__/queryComposer.test.ts src/ui/__tests__/distinctValues.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/core/__tests__/text.test.ts src/adapters/__tests__/mysql.sortQuery.test.ts src/adapters/__tests__/timezone.test.ts
npm test
npm run package
```

Flake stress after compilation:

```bash
for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done
```

Audit range and report-presence checks:

```bash
git diff --check v1.6.3..v1.6.6
test -s docs/AI_HANDOFF/notes/cycle-x-audit-host-adapters.md
test -s docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md
```

## §6 Acceptance

- [ ] TASK-001 accounts for every scoped host/adapter production file and gives every reported item severity, `file:line`, trigger, expected/actual, fix, test, and disposition.
- [ ] TASK-002 does the same for the grid/UI scope and explicitly reviews async ownership/stale-state paths.
- [ ] Reconciliation creates grounded TASK-006/TASK-007 for normal-budget bounded findings; every confirmed P0/P1 is assigned, expanding with TASK-008 onward when independently owned fixes require it, while deferred large/non-critical-overflow findings are queued with rationale.
- [ ] TASK-003 evaluates the webview bundle once per suite, uses bounded observable synchronization, and passes seeds 1–5 without retries or longer arbitrary sleeps.
- [ ] TASK-004 classifies whitespace-only strings consistently in UI/local filtering, emits `TRIM(col) = ''` only for declared string columns, and leaves one exported trailing-semicolon implementation.
- [ ] TASK-005 exposes and tests the real MySQL four-argument sort helper, delegates composer MySQL sorting to it, and enforces the documented UTC connection contract—including `query(sql, values)` replacement-connection initialization and failure handling.
- [ ] No two same-wave tasks modify the same file; dynamic task dependencies are adjusted when audit findings collide with static owners.
- [ ] `npm run compile` and `npm run typecheck` exit 0.
- [ ] Targeted tests and `npm test` exit 0 with no regression below 1494 passed / 2 skipped.
- [ ] `npm run package` exits 0 and produces an installable VSIX.
- [ ] No unrelated feature, dependency, schema, or release-version change is introduced.

Traceability: acceptance items 1–2 map to TASK-001/002; item 3 maps to the reconciliation gate and any TASK-006/007; item 4 maps to TASK-003; item 5 maps to TASK-004; item 6 maps to TASK-005; items 7–11 apply to all implementing tasks and final verification.

## §7 Global Constraints

- Runtime/version floors: preserve Node/TypeScript targets and VS Code engine `^1.75.0`; do not change package version in this cycle.
- Dependency limits: npm only; add no dependency and do not modify lockfiles except if an existing npm command does so unexpectedly (then revert it).
- Naming/copy: retain `UnicDB_*` SQL aliases, `(Blanks)` display copy, English code/test names, and existing Vietnamese comments where untouched.
- SQL safety: identifiers use `quoteIdent`; values use `sqlLiteral`/bound parameters; sort direction remains a closed `ASC|DESC` union.
- Platform: extension host and webview must remain cross-platform; tests may set `TZ` but must restore process state.
- TDD: each implementation task proves RED for behavior/regression before production edits, then GREEN; no retries or test-only production APIs.
- Audit: evidence over speculation; P0/P1 cannot be deferred, while huge P2/P3 work is queued rather than rushed.
- Handoff: every task inherits this section by reference; executor appends its report and reviewer appends its verdict in the task file.

## Planner Report
PLANNER_MODEL: bao-opus
PLAN_REVIEW: Approved by bao-opus

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: corrected the requested semicolon-duplication premise (`resultsPanel.ts` has no copy; the third real copy is `resultsGridModel.ts`), rejected keyset paging as too broad, merged same-file backlog slices, grounded MySQL UTC setup to awaited checkouts, made initialization failure explicit, gated all fix waves on the relevant audit, added audit-to-follow-up reconciliation, and replaced sleep/retry flake ideas with one lifecycle plus observable waits.
Known gaps: audit findings are intentionally unknown until Wave 1; TASK-006/007 are the normal budget, while each confirmed unrelated P0/P1 finding expands the task set rather than being deferred. Keyset paging and other architectural queue items remain out of scope. MySQL UTC initialization covers the four explicit checkout sites and `query(sql, values)`'s former direct `pool.query()` path; the faithful mock must prove physical-connection identity, replacement ordering, and release behavior during TDD.

## Plan Review Log

### Round 1
Reviewer: bao-opus
Status: Issues Found
Findings:
- (severity: important) §2 Post-audit reconciliation and §3.5 impose a hard cap of two follow-up tasks while also forbidding deferral of any P0/P1 and allowing unrelated findings to be grouped only when they own the same file. Three independent P0/P1 findings in three files make those rules impossible to satisfy. Allow the cap to expand for P0/P1 findings, or require the gate to halt and revise/re-review the plan before later waves.
- (severity: important) §3.4 routes the four explicit `getConnection()` sites through an initialized-checkout helper, but `src/adapters/mysql.ts:397-406` executes metadata and non-streaming SQL through `pool.query()`, which performs an implicit checkout outside that helper. After the original physical connection is destroyed and the pool replaces it, user SQL can run before `SET time_zone = '+00:00'`. Require `query()` to acquire/release through the initialized helper (or define another awaited all-connections mechanism), and add a replacement-connection test covering this path.

NOTES: The six required sections are substantive; the static wave DAG/file ownership is coherent; npm/compile/typecheck/package and Vitest commands are runnable; the sampled paths and APIs exist. TASK-003/004/005 each include a happy path and at least two edge cases of different kinds, and excluding keyset paging is appropriate for this hardening cycle.

### Round 2
Reviewer: bao-opus
Status: Approved
Findings:
- none
