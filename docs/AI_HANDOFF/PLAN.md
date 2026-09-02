# PLAN — Cycle CL-01: Cleanup cycle (close documented follow-ups)

Prior cycle (BQ-01, v1.47.0) plan is superseded; it lives in git history at `611df12`.
Source input: `docs/STATUS.md` §"Documented follow-ups not yet scheduled" (7 items).
Base: `main @ 611df12`. Suite baseline: **3251 passed | 2 skipped** (v1.47.0).

## §1 Intent

Ship one cleanup release that closes the STATUS.md follow-up backlog. Success = every
surviving follow-up has a code fix plus a regression pin, full suite stays at/above the
3251|2 baseline, typecheck + compile exit 0, BQ-00 frozen surface byte-untouched, and no
new public API beyond what an item explicitly requires.

**Verify-first findings (planner, 2026-09-02 — every item read at source before planning):**

| # | STATUS.md item | Verdict | Evidence |
|---|---|---|---|
| 1 | `browseCommands.ts:169-193` unguarded finally | **NON-ISSUE — dropped** | File is 187 lines; the whole command body IS wrapped: `try` at :148, `catch` at :178, `finally { panel.setBusy(false); }` at :181-183. No partial-state path exists. Cited line range never matched current HEAD. |
| 2 | MSSQL `[insert]` bracket false positive | **REAL** | `maskLiteralsAndComments` (dangerousStatement.ts:90-223) masks `'…'`, `"…"`, mysql backtick, dollar-quote, comments — but has NO `[…]` branch. `readOnlyIntent.statementIsMutation` (readOnlyIntent.ts:61-93) scans EVERY depth-0 token, so `SELECT * FROM [insert]` on a read-only connection is blocked as a mutation. Worse: `connectionManager.ts:813,832` call `isMutationSql(sql)` with NO dialect, so even the mysql backtick masking is inert on that path. `schemaImpact.ts`/`analyzeStatement` decide on the FIRST depth-0 keyword and are safe from this class (a bracket id cannot precede the leading keyword in valid SQL) — but they consume the same masker and inherit the fix. |
| 3 | ARP-07 form-view/AI plan-apply invalidation gap | **REAL, 3 sites** | Seam `invalidateAfterSchemaDdl` is module-private in extension.ts:117, assigned :863, fired only from `runStatements` (:1982). Unwired direct `adapter.runQuery` callers: `tableCommands.ts:117-124` (`runDdl` — newTable/modifyTable/renameTable/renameColumn/analyze/vacuum), `tableCommands.ts:578-580` (SchemaForm `createSchema`), `aiChatPanel.ts:3708` (plan-apply execute callback inside `runRenameStatements`). |
| 4 | Snapshot `name` field uncapped | **REAL** | `consolePanelMessages.ts:253` validates `typeof tab.name === "string"` with no length cap (buffer gets `CONSOLE_DRAFTS_MAX_BUFFER_CHARS` :255, tabs get `CONSOLE_DRAFTS_MAX_TABS` :241). Host writer `consolePanel.ts:382-389` (`buildDraftSnapshot`) clamps tabs + buffer but NOT `name`. A corrupt memento with 20 × multi-MB names hydrates unbounded. |
| 5 | BQ-00 R4.5 minors | **REAL** | `DECL_RE` declared at bigqueryPackage.test.ts:236 but never referenced — both loops (:240, :246) rebuild the same pattern inline via `new RegExp(...)`. ADR 0004 nits confirmed: :110-112 claims `BigQueryValue` lives in `src/adapters/types.ts` (grep = 0 hits; real location `src/adapters/bigqueryTypes.ts:90` — reviewer's ":63" has drifted, executor must re-grep); :348-349 cites a `§"Hard constraints"` section that does not exist in the ADR. |
| 6 | BQ-01 R4.5 carried minors | **REAL** | bigquery.ts: never-connected `requireClient()` (:299-310) throws `BigQueryClosedError` for an adapter that was never open; `durationMs: 0` hardcoded (:237); inline `import("./types").X` return annotations (:244-279) duplicate the top-level import block (:39-44). Reviewer verdicts: TASK-BQ01-002 R4.5 round 2, non-blocking carried minors. |
| 7 | `.claude/worktrees/agent-*` entries | **NON-ISSUE — out of scope by instruction** | Harness-owned; reclaimed on age-out. No task. |

## §2 Scope

**In-scope (5 items → 4 tasks):**
1. MSSQL bracket-identifier masking + dialect threading at the read-only guard (item 2) → TASK-CL-001
2. ARP-07 DDL-invalidation wiring for form-view DDL + AI plan-apply (item 3) → TASK-CL-002
3. Console draft snapshot `name` cap (item 4) → TASK-CL-003
4. BQ-00 + BQ-01 R4.5 carried minors, folded (items 5 + 6) → TASK-CL-004

**Out-of-scope:**
- Item 1 — already fixed at HEAD (see §1); no task, no code change.
- Item 7 — harness worktrees, explicitly non-issue.
- `statementParser.ts` mssql bracket tokenization (splitting on `;` inside `[…]`): a
  separate parser concern; the masker fix is per-already-split-statement and does not
  depend on it. Recorded as a known gap, not scheduled.
- BQ-02 (resource explorer, real introspection, `commandTag` sourcing).
- Any driver surface change, any new external dependency, any BQ-00 file edit.

**Wave constraint:** all 4 tasks own fully disjoint file sets (verified in §7) → single
wave 1, 4 parallel executors, zero serialization.

## §3 Approach

**Confirm-by-Read first** — done (§1 table). Line numbers in STATUS.md drifted; tasks cite
verified anchors and instruct executors to re-grep before editing.

**TASK-CL-001 (bracket masking):** add an mssql `[…]` branch to `maskLiteralsAndComments`
in `src/core/dangerousStatement.ts`, gated on `dialect === "mssql"`, `]`-doubling escape,
mirroring the existing mysql backtick branch (:178-204) and its gating rationale. Masking
MORE than the tokenizer sees is the safe direction here: today `[o'brien]` makes the
tokenizer open a bogus string literal; masking the bracket region hides a superset of what
the tokenizer hides. Thread dialect through `connectionManager.guardAdapter` (:813, :832)
via a local `DriverType → SqlDialect | undefined` narrowing (`"bigquery" → undefined`),
mirroring extension.ts:131-135 — do NOT import from extension.ts (wrong direction). Also
thread the dialect where the guard already has it available so the guard uses the same
dialect the splitter used. Alternatives rejected: unconditional bracket masking (violates
the masker/tokenizer sync contract the backtick branch documents; `[…]` is an array
subscript in postgres); fixing `statementParser` instead (larger blast radius, splitting
behavior change).

**TASK-CL-002 (invalidation wiring):** dependency injection, not a new global. Keep the
existing `invalidateAfterSchemaDdl` closure in extension.ts exactly as-is; pass it as an
OPTIONAL callback into the two existing injection points: `RegisterDeps.onSchemaDdl?` in
tableCommands.ts and `AiChatPanelOptions.onSchemaDdl?` in aiChatPanel.ts. tableCommands
narrows `conn.driver` itself (it holds `ConnectionConfig`); the panel callback takes only
`readonly string[]` and extension derives the dialect from `mgr` (the panel has no driver
access — `DbAdapter` exposes no driver field). Fire per successfully applied statement
(inside `runDdl` after `await adapter.runQuery` resolves; inside the plan-apply execute
callback after resolve) — `invalidate()` is idempotent and per-statement firing correctly
excludes the failed tail of a partial plan-apply. Never fire on the error path. All-optional
(`?.`) so every existing construction site and test keeps compiling/behaving. Alternatives
rejected: routing form DDL through `runStatements` (changes UX/error surfaces of reviewed
flows); a new `src/core/ddlInvalidation.ts` module-global seam (duplicates a pattern DI
already expresses; new file for no need).

**TASK-CL-003 (name cap):** new `CONSOLE_DRAFTS_MAX_NAME_CHARS = 200` in
consolePanelMessages.ts. Parse REJECTS over-cap names (fail-closed, byte-identical contract
to the buffer cap: "parse REJECTS over-cap input"); host `buildDraftSnapshot` slices
`name` (existing "our own writer never emits what our own parse rejects" invariant).
`encodeConsoleDraftSnapshot` stays verbatim by design. Empty name `""` remains valid.

**TASK-CL-004 (BQ minors, folded):** in `src/adapters/bigquery.ts` (BQ-01 surface —
editable; BQ-00 files stay frozen): new `BigQueryNotConnectedError` class;
`requireClient()` throws it for `client === null && !closed`, keeps `BigQueryClosedError`
for `closed` (existing tests #3/#6 pin that — they must stay green verbatim). Measure
`durationMs` around `client.query(...)` (`Date.now()` delta); `commandTag` stays `undefined`
(no tag source in `IQueryResponse` — documented, deferred to BQ-02). Replace the seven
inline `import("./types").X` return annotations with names added to the existing top-level
`import { … } from "./types"` block. Item 5 in the same task: delete unused `DECL_RE` (or
make it the single pattern source the two loops derive from — behavior unchanged either
way); fix ADR 0004 :110-112 (re-point to `src/adapters/bigqueryTypes.ts`, re-grep the line)
and :348-349 (drop or re-point the phantom `§"Hard constraints"` reference).

**TDD per task; no new external deps; no driver surface changes; BQ-00 frozen.**

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| **TASK-CL-001** (`readOnlyIntent.test.ts`, `dangerousStatement.test.ts`, `schemaImpact.test.ts`, `connectionManager.test.ts`) | |
| regression | `maskLiteralsAndComments('SELECT * FROM [insert]', 'mssql')` | `'SELECT * FROM          '` — length-preserving blank (RED today) |
| regression | `mutationStatements('SELECT * FROM [insert]', 'mssql')` | `[]` — benign SELECT no longer blocked on read-only mssql (RED today) |
| happy | `isMutationSql('DROP TABLE [insert]', 'mssql')` | `true` — real DDL in brackets still caught |
| edge (semantic inverse) | `hasSchemaImpact('CREATE TABLE [foo] (x int)', 'mssql')` | `true`; `hasSchemaImpact('SELECT * FROM [create]', 'mssql')` → `false` — classifier unaffected both ways |
| edge (escape/malformed) | `]`-doubling + unterminated | `mutationStatements('SELECT * FROM [we]]ird]', 'mssql')` → `[]`; `mutationStatements('SELECT * FROM [insert', 'mssql')` → `[]` (masker runs to EOF, no throw) |
| edge (dialect gate) | omitted/postgres dialect keeps today's behavior | `mutationStatements('SELECT * FROM [insert]')` (no dialect) → 1 entry — proves the guard closes ONLY via the connectionManager threading |
| unit | read-only mssql cfg through ConnectionManager | `SELECT * FROM [insert]` reaches `adapter.runQuery` (not `ReadOnlyViolation`) — extends the existing read-only describe block in `connectionManager.test.ts` |
| **TASK-CL-002** (`tableCommands.test.ts`, `aiChatPanelPlan.test.ts`) | |
| happy | newTable/modifyTable `runDdl` success fires seam | `onSchemaDdl` called once with `([sql], "postgres")` |
| edge (error path) | `adapter.runQuery` rejects | `onSchemaDdl` NOT called; error message surfaced (existing behavior) |
| edge (absent dep) | `RegisterDeps` without `onSchemaDdl` | command completes normally, no throw (optional-contract pin) |
| edge (driver narrowing) | `conn.driver === "bigquery"` | callback receives `dialect === undefined` |
| happy | plan-apply full success | `onSchemaDdl` called once per applied statement, in order |
| edge (partial failure) | execute throws at statement 3 of 4 | callback fired exactly 2× (applied prefix only) |
| edge (no connection) | `adapterFactory` resolves null | zero callbacks; "Plan apply stopped" assistant message (existing contract preserved) |
| **TASK-CL-003** (`consolePanelMessages.test.ts`, `consolePanel.test.ts`) | |
| happy | name exactly at cap round-trips | `parseConsoleDraftSnapshot(encode(...))` with 200-char name → deep-equal snapshot |
| edge (boundary) | name 201 chars | `parseConsoleDraftSnapshot` → `null` (fail-closed, RED today) |
| edge (writer clamp) | host tab named 500 chars | persisted snapshot `name.length === 200`; re-parse succeeds |
| edge (valid-min) | name `""` | accepted (cap is upper bound only; renameTab's empty-no-op unchanged) |
| **TASK-CL-004** (`bigquery.test.ts`, `bigqueryPackage.test.ts`) | |
| regression | `runQuery` before any `connect()` (not closed) | rejects `BigQueryNotConnectedError` (distinct class, `name === "BigQueryNotConnectedError"`), factory 0 calls (RED today — currently throws `BigQueryClosedError`) |
| regression | `runQuery` after `close()` | still rejects `BigQueryClosedError`, factory still 1 call — existing tests #3/#6 green verbatim |
| happy | durationMs measured | fake client awaiting a ~20ms timer → `result.results[0].durationMs >= 15` (not hardcoded 0) |
| edge (lifecycle preserve) | `connect()` after `close()` | still `BigQueryClosedError` (existing pin untouched) |
| edge (surface preserve) | introspection methods | still throw `NotImplementedError("bigquery")`; BQ-00 files byte-untouched (`git diff --stat` over `bigqueryTypes.ts`/`bigqueryAdc.ts` empty) |
| unit | DECL_RE cleanup | `bigqueryPackage.test.ts` 14/14 still green with the duplicated pattern removed |
| unit (non-test) | ADR nits | `grep -n "types.ts" docs/decisions/0004-*.md` shows no `BigQueryValue`-in-types.ts claim; `grep -n "Hard constraints"` → no phantom section ref |

## §5 Verification Commands

No `lint` script exists in this repo (package.json `scripts`: compile, watch, test,
test:integration, typecheck, package, verify:fast, verify:release, profile:fast,
profile:release). **Static gate is `npm run typecheck`; bundle gate is `npm run compile`** —
both are mandatory in every task and at cycle close (stated explicitly, not omitted).

Per task (see each TASK-CL-00x.md for its exact narrowed set — never the full suite):
```bash
npx vitest run <task's owned test files>
npm run typecheck
```
Cycle-level (orchestrator, wave boundary + release):
```bash
npm test                 # full suite — regression net, floor 3251 passed | 2 skipped
npm run typecheck
npm run compile
```

## §6 Acceptance Criteria

- [ ] Every test in every task's §Test Cases passes RED→GREEN (regression pins were RED at `611df12`). — all 4 tasks
- [ ] Full suite ≥ 3251 passed | 2 skipped; typecheck + compile exit 0. — cycle-level §5
- [ ] BQ-00 frozen surface byte-untouched: `git diff --stat 611df12..HEAD -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` is empty. — TASK-CL-004
- [ ] No new external dependency; `package.json` deps unchanged. — all
- [ ] New public API limited to: `BigQueryNotConnectedError`, `CONSOLE_DRAFTS_MAX_NAME_CHARS`, optional `RegisterDeps.onSchemaDdl?` / `AiChatPanelOptions.onSchemaDdl?` — each explicitly required by items 6, 4, 3. Nothing else exported. — all
- [ ] Release hygiene 20/20 (existing hygiene suite green via `npm test`). — cycle-level
- [ ] Existing pins preserved verbatim: bigquery tests #3/#6 (closed-error), bigqueryPackage 14/14, read-only postgres/mysql behavior unchanged. — TASK-CL-001, TASK-CL-004

## §7 Global Constraints

- Base `main @ 611df12`; 1 commit per wave; commit inside the executor worktree session before returning (BQ-01 lesson).
- No edits to `src/adapters/bigqueryTypes.ts` / `src/adapters/bigqueryAdc.ts` (BQ-00 frozen).
- No new external dependencies; no driver surface changes; no `package.json` script/command changes.
- No lint script exists — `npm run typecheck` is the static gate; state that, never skip silently.
- Every task: TDD, regression pin RED-first for bugfixes; verification re-run fresh in-turn.
- File ownership (same-wave disjointness, all wave 1):
  - TASK-CL-001: `src/core/dangerousStatement.ts`, `src/core/connectionManager.ts`, `src/core/__tests__/{readOnlyIntent,dangerousStatement,schemaImpact,connectionManager}.test.ts`
  - TASK-CL-002: `src/extension.ts`, `src/ui/tableCommands.ts`, `src/ui/aiChatPanel.ts`, `src/ui/__tests__/{tableCommands,aiChatPanelPlan}.test.ts`
  - TASK-CL-003: `src/ui/consolePanelMessages.ts`, `src/ui/consolePanel.ts`, `src/ui/__tests__/{consolePanelMessages,consolePanel}.test.ts`
  - TASK-CL-004: `src/adapters/bigquery.ts`, `src/adapters/__tests__/{bigquery,bigqueryPackage}.test.ts`, `docs/decisions/0004-bq-00-feasibility-contract.md`

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing — audit ran after grounding; item 1 was dropped BEFORE task split (verified non-issue at :148-183), items 5+6 folded into one task per instruction, wave plan collapsed from an assumed chain to a single 4-wide wave after confirming file disjointness.
Known gaps: (1) `statementParser.ts` does not tokenize mssql `[…]` — a `;` inside a bracket identifier still splits; separate parser concern, deliberately unscheduled. (2) `commandTag` stays `undefined` in bigquery results (no tag source; BQ-02). (3) Plan-apply fires the seam per applied statement, not once per batch — idempotent by design, noted for reviewer. (4) STATUS.md cites HEAD `fc81131`; actual base is `611df12` (one commit newer, the post-BQ-01 snapshot) — STATUS.md is stale by one commit, corrected here.

## Plan Review Log

### Round 1
- Verdict: Approved
- Reviewer: unic-smart
- Findings:
  - critical: none
  - important: none
  - minor:
    - PLAN.md:93-94 (SS3 TASK-CL-004) - "seven inline import(\"./types\").X return annotations" miscounts: HEAD has six (bigquery.ts:244, 247, 250, 253, 256, 277 - SchemaInfo, TableInfo, ViewInfo, RoutineInfo, ColumnInfo, TableDetail). Task file should state six or instruct the executor to re-grep the count before lifting names into the top-level import block (bigquery.ts:39-44).
    - PLAN.md:105 (SS4 CL-001 regression row) - expected masked literal is indicative only; exact output of maskLiteralsAndComments('SELECT * FROM [insert]', 'mssql') is 22 chars ("SELECT * FROM " + 8 blanks, i.e. 9 spaces after "FROM"). Task file must compute/paste the exact literal, not copy the plan's spacing.
- Source verification (Round 1): all load-bearing anchors confirmed at HEAD 611df12 - masker has no []] bracket branch and mysql backtick branch at dangerousStatement.ts:178-204; dialect-less guard calls connectionManager.ts:813/:832; seam module-private/assigned/fired at extension.ts:117/:863/:1982; unwired runQuery callers tableCommands.ts:123/:580 and aiChatPanel.ts:3708; RegisterDeps (tableCommands.ts:110-115) has no onSchemaDdl yet; name uncapped consolePanelMessages.ts:253, writer clamp gap consolePanel.ts:382-389; requireClient never-connected branch bigquery.ts:299-310 with tests #3/#6 pinning closed-error; DECL_RE declared-unused bigqueryPackage.test.ts:236; ADR 0004 nits real (:110-112 BigQueryValue actually at bigqueryTypes.ts:90; :348-349 phantom section ref); browseCommands.ts drop verified (try :148 / catch :178 / finally :181-183, 187-line file); package.json has no lint script, typecheck correctly named static gate; hasSchemaImpact already takes dialect (schemaImpact.ts:120) so CL-001 test rows need no schemaImpact.ts source change; wave-1 file sets in SS7 are disjoint.
