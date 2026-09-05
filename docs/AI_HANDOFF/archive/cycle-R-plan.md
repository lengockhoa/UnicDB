# PLAN — Cycle R: AI overhaul + Table-grid Excel-ification (table + AI round)

Scope complexity: MEDIUM-HIGH
Detected systems: (1) AI stack audit/fix + full-DB context, (2) results-grid Excel editing overhaul (bug ctid + editing/undo + visual alignment)
Decision: keep ONE cycle (user: "This round focuses on the table... Combine with the AI bug fix") — 9 tasks / 2 waves. Grid ctid bug (TASK-006) is wave 1 because the user is blocked from saving. Grid spec source: `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` (verbatim quotes in §1).

## §1 Intent

User (verbatim): "[please review the AI feature carefully. Right now it does not seem to work well, review thoroughly. Chatting must show results. Must have full DB context and an Export Structure feature so the model can reference all context when advising the user]" + "[After pressing Clear I cannot start a new chat]" + "[This round focuses on the table — optimise the table area to be as Excel-like as possible, save to DB and we are done. Combine with fixing the AI bug and leverage omp's power to maximise user support]" + Cmd+Enter cursor-mode defect (orchestrator probe: parser 17 cases did NOT reproduce — deviation candidate: gap-fallback to the LAST statement).

Success = 5 outcomes:
1. **Chat always produces a result** — builtin engine end-to-end: config error → actionable error bubble; every turn ends in `assistant` or `error` + `done`; Clear does NOT kill the panel; Cmd+Enter cursor-mode runs the statement containing the cursor.
2. **Full-DB context** — system prompt contains ALL user schemas/tables/views of the connection (NOT just the first 30 tables in `public`), rendered through Export-Structure DDL, with a char budget + footer pointing the model at `export_structure`.
3. **Export Structure → AI context** — tool `export_structure` lets the model pull the full DDL blob on demand; command `UnicDB.exportAllStructures` copies the whole-DB DDL for the user.
4. **Excel-like grid** — fix the no-PK ctid save bug (hidden-ctid-column approach), edit highlight, add/delete row, single-transaction Cmd+Enter commit, unified undo/redo stack.
5. **Grid alignment** — requery bar sits on a single straight baseline; set-filter popup items left-aligned uniformly.

## §2 Scope

**In-scope** (9 tasks — 5 AI + 4 grid):
- TASK-001: `buildDatabaseStructure` builder + `export_structure` agent tool (src/ui/exportStructure.ts, src/ai/tools/schemaTools.ts + tests).
- TASK-002: Full-DB context injection into `buildMessages` (src/ui/aiChatPanel.ts + tests).
- TASK-003: Chat reliability — Clear dead-state + not-configured error surface (src/ui/aiChatPanel.ts, webview/aiChatPanelMain.ts + tests).
- TASK-004: `UnicDB.exportAllStructures` command copies the whole-DB DDL (src/ui/tableCommands.ts, package.json, src/extension.test.ts + tests).
- TASK-005: Cmd+Enter cursor-mode lock + gap-rule fix (src/core/statementParser.ts, src/core/__tests__/statementParser.test.ts, src/extension.test.ts, src/ui/__tests__/codeLensProvider.test.ts).
- TASK-006 (grid A, P0): Fix no-PK ctid save — hidden ctid column (src/ui/resultsPanel.ts, src/ui/resultsGridModel.ts + tests).
- TASK-007 (grid B): Excel editing — dirty highlight + add-row/delete-row commit INSERT/DELETE (webview/main.ts, webview/styles.css, src/core/saveStatements.ts + tests).
- TASK-008 (grid C): Unified undo/redo stack (cell edits + row add/delete) (webview/main.ts, webview/styles.css + tests).
- TASK-009 (grid D+E): Requery bar alignment + set-filter popup alignment (webview/styles.css, webview/main.ts + tests).

**Out-of-scope:** ACP/omp engine internals (builtin fallback is the main path), provider SSE parser, MySQL/MSSQL DDL generation, view CREATE definition (ColumnInfo lacks viewdef), AI Settings form, sampleDataAi, resume picker, undo-after-commit (spec C: document, do NOT implement).

**Waves & dependency graph**:
- Graph: T1→{T2,T4}; T2→T3; T6→T7; T7→{T8,T9}; T5, T6-root are independent.
- Wave 1 (3, song song — files disjoint): TASK-001, TASK-005, TASK-006
- Wave 2 (2 sequential batches within the wave): batch A = TASK-002, TASK-004, TASK-007 (disjoint files within the batch; T7 deps T6 because rowErrors host-side emit touches resultsPanel.ts which T6 also edits); batch B = TASK-003 (deps T2, file aiChatPanel.ts), TASK-008 (deps T7), TASK-009 (deps T7) — within batch B, T8/T9 both touch webview/main.ts + styles.css so the executor queues these two tasks sequentially (T8 before T9).

Rationale (Round-1 review finding #1): T7 no longer belongs in wave 1 — it touches webview files (which T8/T9 also touch) and it touches resultsPanel.ts via rowErrors (which T6 owns). Moving T7 into wave 2 batch A (after T6) leaves wave 1 with only 3 clean tasks; every same-file pair is now linked via dependency or sequential batching.

## §3 Approach — AI stack (TASK-001..005)


**D1 — AI lacks full DB context.** `buildMessages` (aiChatPanel.ts:112-142) only fetches `adapter.listTables()` — PostgresAdapter defaults `schema="public"` (postgres.ts:206) → other schemas invisible; limited to 30 tables; no views. **Fix:** context built from `listSchemas(false)` + per-schema `listTables/listViews` + `listColumns` (mapped to ExportColumn), rendered via `buildDatabaseStructure` (T1). **Budget rule (fully defined per review #2/#4):** production constant `SCHEMA_CONTEXT_BUDGET = 12_000` chars, DEFINED IN ONE PLACE (a const in aiChatPanel.ts). Tests override the budget via the injectable parameter `buildMessages(factory, history, userMsg, opts?: {contextBudgetChars?: number; contextTableLimit?: number})` — do NOT hardcode the budget in two places, do NOT have tests fight against the production constant. Cut at BLOCK boundary (block = 1 object DDL; tables AND views share the SAME budget pool in render order: schema → its tables then views; blocks that do not fit are dropped whole + counted). **Oversize single block:** the FIRST block alone exceeding the budget (a giant single table) is kept whole regardless (context is never empty when the DB has objects) + footer `(+N more objects omitted — call export_structure for full context)`; if the footer also does not fit the budget, drop the footer (keep the blocks). Empty DB (0 objects) → context empty → fall back to the old prompt.

**D2 — Clear dead-state (user report).** `handleClear` (aiChatPanel.ts:738-741) resets `history` + posts `init` but does NOT reset `token`/`currentAbort`/`turnDonePosted`; the webview busy state only un-disables via `done` — Clear during an active turn stream → input dies. **Fix:** host clear = full turn reset (token/currentAbort/turnDonePosted + cancelAllPending) + post `done`; webview receives `init{hasHistory:false}` → force `setBusy(false)` + deStream.

**D3 — "AI is not configured" surfaces unclearly.** `commandOpenAiChat` (extension.ts:382-404) gates at command level; if the panel was opened earlier and settings get cleared mid-session, `runAgent` throws and the original error bubble lacks guidance. **Fix (T3):** enrich the catch in `runBuiltinTurn` with the standard message `"AI is not configured — open UnicDB: Open AI Settings to configure baseUrl/model/API key"` (keep the original prefix unchanged so any existing tests that match the prefix still pass). (The "engine-banner hint" sentence is removed from scope — no task covers it, dropped from §3.)

**D5 — Cmd+Enter cursor-mode (orchestrator probe did not reproduce across the parser's 17 cases).** The strongest deviation candidate per code-read: `statementAtCursor`'s fallback (statementParser.ts:497-500) returns `stmts[stmts.length-1]` when the offset sits in a GAP between two statements — a user standing between stmt1/stmt2 will run the LAST statement in the file instead of the statement preceding the cursor. **Fix:** in a gap → nearest statement BEFORE the cursor (user intent "run the statement containing the cursor"); before the first statement → the first statement. Lock the entire cursor-mode behaviour via regression tests (TASK-005) + audit the `runQueryFromEditor` handler + CodeLens path.

**Alternatives rejected (AI):** (a) dump the full DDL without a budget — context blow-up on large DBs; (b) tool returns per-table DDL — model wastes steps calling N times; (c) separate prompt for mysql/mssql — ColumnInfo-based DDL is PG-first; other drivers already have the guard pattern.

## §3.1 Approach — Grid Excel overhaul (TASK-006..009, spec: queue/GRID-EXCEL-OVERHAUL-spec.md)

**G1 — No-PK ctid save bug (P0, user blocked).** `fetchPostgresCtids()` (resultsPanel.ts:699-748) matches rows by VALUE comparison (`WHERE col IS NOT DISTINCT FROM <literal>` over every column, requiring exactly 1 match) — round-trip literals (timestamp/numeric/boolean via `sqlLiteral`) drift ⇒ 0 matches ⇒ "all_failed" banner. **Fix (spec recommendation):** for PG no-PK tables, the host adds `ctid` to the initial SELECT as a hidden column (requery/original path inside resultsPanel.ts) → row address is exact, no value match. Keep value-match only as a fallback when the `ctid` column is absent (hand-written query). The webview hides the `ctid` column (AG Grid `hide`); the host reads `ctid` from row data when building the save payload.

**G2 — Excel editing (spec B).** Already present: cell edit (TASK-501 EditState), Add Row/Delete Row markers (webview/main.ts:1716-1734), Commit button + Cmd+Enter, buildSaveStatements already understands NewRowMarker/DeleteRowMarker → INSERT/DELETE. Missing: **dirty highlight** (cellStyle/CSS class vs original), **new-row highlight**, **deleted-row strikethrough**, per-row error report, refresh + clear highlights after commit (new baseline). **Fix:** CSS classes `UnicDB-cell-dirty`/`UnicDB-row-new`/`UnicDB-row-deleted` (styles.css) + AG Grid `cellClassRules`/`getRowClass` reading editState; commit flow re-syncs the grid with DB truth.

**G3 — Unified undo/redo (spec C).** AG Grid undo only covers cell edits; add/delete row needs custom. **Fix:** ONE unified stack (pure module `src/ui/undoStack.ts` — new file, no vscode import) records every action (cell-edit, add-row, delete-row) in order; Ctrl/Cmd+Z + Shift+Z (and toolbar icons) drive the stack; redo stack is cleared on a new action. Undo-after-commit is out-of-scope (documented in the task).

**G4 — Alignment (spec D+E).** Requery bar: flexbox `align-items:center`, input/button at a uniform 26px height (makeIconButton is already 26px — webview/main.ts:393), even gaps — add rules `.UnicDB-requery-bar / .UnicDB-requery-label / .UnicDB-requery-input / .UnicDB-requery-run / .UnicDB-requery-clear` to styles.css (currently NO such rules exist — grep 0 matches, bar is unstyled). Set-filter popup: AG Grid themeQuartz params (webview/main.ts:1371 themeQuartz.withParams) — adjust via a CSS override of `.ag-set-filter-item` alignment or a theme param; left-align "Select All" + items at a uniform indent.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | T1#1 full-DB DDL builder: 2 schemas × tables+views | `buildDatabaseStructure` emits the `-- Database structure (2 schemas, 3 tables, 1 views)` header + `CREATE TABLE s.t (...)` per table, view blocks from buildViewStructure |
| happy | T1#2 export_structure tool execute | JSON `{ddl, schemas, tables, views, truncated}` whose ddl contains the header + DDL |
| happy | T2#1 buildMessages full-DB context PG | system prompt contains `Database structure` + DDL of tables from MULTIPLE schemas (public + custom), views rendered |
| happy | T2#2 context through the agent turn (E2E) | fake fetch receives a system message containing DDL; the model's final answer is posted as `assistant` |
| edge | T1#3 empty DB (0 schemas/tables) | header `0 schemas` + no crash, ddl string empty apart from the header |
| edge | T1#4 PG-only guard mysql/mssql | tool returns the string `"export_structure is only supported for PostgreSQL connections."` (NotImplementedError path) |
| edge | T2#3 budget cut at block boundary | override `contextBudgetChars: 2000` via opts (test value; production const 12_000 is not touched); DB with many tables → context keeps blocks whole, footer `(+N more objects omitted — call export_structure for full context)`, NO block half-cut |
| edge | T2#3b single oversize block | 1 table DDL > budget → first block kept whole (exceeding budget), footer omitted-count correct, context NOT empty |
| edge | T2#4 no active connection | factory null → system prompt has NO `Database structure:` section, chat still runs |
| edge | T2#5 introspection throw mid-schema | one schema's listTables throws → skip that schema + continue rendering the others |
| edge | T3#2 Clear while idle | history=[] + init posted; next turn runs normally |
| edge | T3#3 not-configured error surface | loadConfig null → error bubble `"AI is not configured"` in the thread, done posted, NO unhandled rejection |
| edge | T3#4 webview init re-enable | `init{hasHistory:false}` sau busy → setBusy(false) called, prompt enabled |
| happy | T4#1 UnicDB.exportAllStructures copies DDL | clipboard text = buildDatabaseStructure output (header + tables), statusbar message posted |
| edge | T4#4 no active connection (palette invoke, no arg) | mgr.getActive() null → info message instructing the user to connect first, NO crash, clipboard not written |
| happy | T5#1 cursor mid-stmt → full stmt | sqlToRun returns one statement with full text from the start of SELECT to `;`, NOT truncated from the offset |
| regression | T5#2 gap between 2 stmts → stmt BEFORE cursor | RED currently (returns last stmt); GREEN: statements[0] === stmt1 |
| edge | T5#3 offset before first stmt (leading comment) | returns the FIRST stmt (intentional behaviour change) |
| edge | T5#4 CRLF + EOF-no-semicolon + BEGIN...END + double `;;` | each case locks the exact statement containing the cursor |
| regression | T6#2 no-PK edit→commit saves successfully via ctid | NO banner "Cannot save... all_failed"; UPDATE ... WHERE ctid='(0,1)' targets the correct row (currently RED with literal round-trip data) |
| edge | T6#3 hand-written query without ctid column → fallback old value-match | old behaviour preserved (fallback path) |
| edge | T6#4 row ctid null/missing → skip per-row warning | remaining rows are saved, warning points at the correct row |
| happy | T7#1 dirty cell highlight | editState.markDirty → cell has class `UnicDB-cell-dirty`; revert/commit → class removed |
| happy | T7#2 add row + delete row → INSERT/DELETE on commit | new row has class `UnicDB-row-new`; deleted `UnicDB-row-deleted`; buildSaveStatements emits INSERT/DELETE (already present — lock via E2E message flow) |
| edge | T7#3 commit with 0 dirty → no-op (does NOT post saveEdits) | no message, no banner |
| edge | T7#4 commit 1 row with error → per-row error report + keep remaining dirty | banner lists the failing row; OK rows are saved |
| happy | T8#1 undo walks through cell-edit → add-row → delete-row (reverse order) | Ctrl+Z 3 times returns the grid to the initial state; Shift+Z redoes it |
| edge | T8#2 redo stack cleared on new action after undo | undo → new action → redo = no-op |
| edge | T8#3 undo when stack empty → no-op, does NOT throw | grid state unchanged |
| happy | T9#1 requery bar single baseline | every label/input/button has the same offsetTop (jsdom computed style align-items:center + height 26px) |
| edge | T9#2 set-filter items at a uniform indent | `.ag-set-filter-item` padding-left is consistent (CSS rule exists + selector matches) |

Regression net: existing tests across aiChatPanel/exportStructure/schemaTools/tableCommands/statementParser/saveStatements/resultsPanel/resultsGridModel/webview MUST NOT turn red after the wave.


## §5 Verification Commands

Project stack: npm + vitest + tsc (package.json: `test`, `typecheck`). No lint script — N/A, declared explicitly instead of being silently omitted.

```bash
# TASK-001
npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts src/ai/__tests__/agent.test.ts
# TASK-002
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatE2e.test.ts
# TASK-003
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts
# TASK-004
npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
# TASK-005
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
# TASK-006
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsGridModel.test.ts
# TASK-007
npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/saveStatements.test.ts src/adapters/__tests__/saveStatementsInline.test.ts src/adapters/__tests__/saveStatementsParser.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
# TASK-008
npx vitest run src/ui/__tests__/resultsGridModelEdit.test.ts src/ui/undoStack.test.ts
# TASK-009
npx vitest run tests/webviewRequeryAlignment.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts
# Typecheck (every task)
npx tsc --noEmit
```

Wave boundary (orchestrator): `npx vitest run` full suite.

## §6 Acceptance Criteria

- [ ] Chat builtin end-to-end always ends with a result: assistant bubble or error bubble + done — T2#2, T3#3 prove.
- [ ] After Clear, chat can start again immediately (T3#1 regression pass RED→GREEN).
- [ ] System prompt contains the full-DB DDL context (multi-schema, tables+views) — T2#1 proves it.
- [ ] Cmd+Enter runs the statement containing the cursor; gap → stmt BEFORE cursor (T5#2).
- [ ] No-PK PG table edit→commit saves successfully via hidden ctid, banner "all_failed" no longer appears (T6#2).
- [ ] Grid Excel: dirty/new/deleted highlight; add/delete row commit INSERT/DELETE; per-row errors (T7).
- [ ] Undo/redo is unified: walks through edit/add/delete (T8#1).
- [ ] Requery bar on a single straight baseline; set-filter items left-aligned (T9#1/2).
- [ ] `npx tsc --noEmit` PASS; no regression in related suites.

## §7 Global Constraints (every TASK inherits by reference)

- TypeScript strict; do NOT import vscode inside `src/ai/**` and `src/ui/exportStructure.ts` (pure, webview-importable pattern).
- npm/vitest/tsc is the verification stack; tests use fake adapters + vi.mock('vscode') following the pattern in src/ui/__tests__/aiChatE2e.test.ts.
- No real-DB integration (the UnicDB_IT=1 pattern exists but is not needed — unit tests with a fake adapter are sufficient).
- Error strings lockstep with existing patterns: `"No active connection..."` / `"Tool failed: <msg>"` / PG-only messages in describe_table style.
- apiKey NEVER crosses the webview wire.
- Version: no new dependencies added.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (a) T2/T3 share src/ui/aiChatPanel.ts → T3 deps T2; (b) grid scope was added mid-plan → re-waved (T7→T8/T9 same-file serialization; T6 wave 1 because the user-blocking save bug); (c) T9 verification path `tests/webviewRequeryAlignment.test.ts` is a NEW test file (documented as new in TASK-009) — all other paths verified against tests-map.json / existing files; (d) src/ui/undoStack.test.ts is NEW (TASK-008 creates the module + test). `typecheck` script verified in package.json (`tsc --noEmit`).
Known gaps: (1) View CREATE definition cannot be emitted — ColumnInfo lacks pg_get_viewdef (T1 contract: column list only). (2) ACP/omp engine path is not audited deeply — builtin fallback is the main path; if the omp engine is actually the source of "no result" issues, that requires another cycle. (3) T6 hidden-ctid integration on a real PG (docker) is NOT covered by unit tests — the unit uses a fake adapter with a ctid column; the spec notes "Integration (docker PG)" as optional (UnicDB_IT=1 pattern) — the executor may add it if quick, but it is not blocking. (4) T9 visual alignment: jsdom does not render for real — acceptance needs a human check / screenshot (documented in the task). (5) Undo-after-commit is out-of-scope (spec C).

## Plan Review Log

### Round 1 — 2026-08-24 · unic/unic-smart (PlanReview-R, REVIEW_TARGET_TYPE=plan)

Status: Issues Found

COMPLETENESS:
  - none — no TODO/TBD placeholders; intent, scope, approach, tests, verification commands, acceptance criteria, constraints all present; gaps (view DDL, undo-after-commit, docker integration) explicitly declared rather than hidden.

CONSISTENCY:
  - critical: PLAN.md:33-38 (Waves) vs PLAN.md:27 — Wave 1 (T1, T5, T6, T7) and Wave 2 (T4, T8, T9) both contain tasks touching `webview/main.ts` + `webview/styles.css` and `src/extension.test.ts`; the plan's own rule "same-wave no shared Target Files" is enforced only for T7→T8/T9, not across waves. Same-file conflicts are the exact failure mode the rule exists to prevent; a wave-boundary merge of Wave 1 and Wave 2 will collide in webview/main.ts and extension.test.ts. Fix: move T7 to Wave 2 (making Wave 1 = T1, T5, T6; Wave 2 = T2, T4, T7, T8, T9) or add an explicit cross-wave merge/anchor protocol per shared file.
  - critical: PLAN.md:74 (T2#3) vs PLAN.md:42 (D1) — test T2#3 uses "8000-char budget" while D1 specifies "Budget 12_000 chars". The executor will implement one and the test will assert the other → guaranteed red or a silently weakened test. Fix: pick one number (12_000) and make the test override it explicitly (e.g. via injected budget option), not via a contradictory constant.
  - important: PLAN.md:27 vs PLAN.md:121 — TASK-007 lists `src/core/saveStatements.ts` as a Target File, but the verification commands at line 121 run `src/adapters/__tests__/saveStatements*.test.ts` (adapters, not core). Either the target file path (`src/core/` vs `src/adapters/`) or the command list is stale; same drift appears at line 100 (regression net lists "saveStatements" without path). Fix: align the module path with the adapter test paths.

CLARITY:
  - important: PLAN.md:25-26 (D1) — "Budget 12_000 chars, cut at table boundary (keeping formatSchemaContext logic)" does not specify what happens when a single table's DDL exceeds the budget (keep it whole and exceed, or skip and count in `+N omitted`?), nor whether `views` count against the same budget or a separate one. T2#3 only tests "not cut mid-table". An executor can satisfy the letter of T2#3 while producing inconsistent behavior for oversized single tables. Fix: add one sentence defining oversized-table handling and whether views share the char budget.
  - minor: PLAN.md:81 (T4#1) — happy-path only, no edge case for T4 (e.g. no active connection → command shows the standard "No active connection..." message instead of copying). All other tasks have ≥1 edge test; T4 has none, which also undercuts the ≥2-edge-cases expectation the handoff gate applies at task level.

SCOPE:
  - none — 9 tasks / 2 waves with explicit dependencies is coherent for a MEDIUM-HIGH cycle; out-of-scope list correctly fences ACP/omp internals, other DDL dialects, undo-after-commit.

YAGNI:
  - minor: PLAN.md:44 (D3) — "engine banner does not hint when builtin because omp fails" is diagnosed but the fix (T3) only covers pre-flight `loadConfig()` and Clear dead-state; the banner-hint sub-problem is neither in T3's scope nor listed as rejected. Either drop the diagnosis sentence or assign it — leaving it half-addressed invites scope creep during execution.

NOTES: The plan is otherwise strong (real RED expectations on T3#1/T5#2/T6#2, honest known-gaps). The two critical findings are mechanical (wave file-overlap, 8000 vs 12000) and cheap to fix before task-file generation.

### Round 2 — revision — 2026-08-25 · unic/unic-smart (Plan-R)

Addressed 6/6 Round-1 findings:

1. **Waves restructured (critical #1)**: Wave 1 = T1, T5, T6 (3 tasks, files disjoint). Wave 2 split into 2 sequential batches: batch A = T2, T4, T7 (disjoint files in the batch); batch B = T3, T8, T9 (T8/T9 in-batch sequential because they share webview/main.ts + styles.css). T7 deps T6 (rowErrors host-side emit touches resultsPanel.ts — file T6 owns). Updated TASK-007 Dependencies, INDEX.md waves, ACTIVE.md Status.
2. **Budget unified (critical #2)**: D1 defines `SCHEMA_CONTEXT_BUDGET = 12_000` as a single-source const; `buildMessages` accepts an injectable `opts?: {contextBudgetChars?, contextTableLimit?}` — test T2#3 overrides the budget to 2000, no more 8000/12000 contradiction.
3. **T7 target/test alignment (important #3)**: removed `src/core/saveStatements.ts` from TASK-007 Target Files (the task does not modify that module); keep the adapter tests as the regression net + note the mapping (module lives under `src/core/`, tests live under `src/adapters/__tests__/` — confirmed via tests-map.json).
4. **Oversize block rule (important #4)**: D1 + TASK-002 Spec define: block = 1 object DDL; tables AND views SHARE the same budget pool in render order; the first block alone exceeding the budget is kept whole (context is never empty when the DB has objects), later blocks are dropped into the omitted count; the footer is emitted only when it still fits the budget. Edge test T2#7 (PLAN §4 row `T2#3b` + TASK-002 #7) locks this behaviour.
5. **T4 edge (minor #5)**: TASK-004 test #6 — no active connection (mgr.getActive() null / factory throw) → error message `Export All Structures failed: <reason>`, no crash, clipboard not written. PLAN §4 adds row `T4#4`.
6. **D3 banner clause (minor #6)**: dropped the sentence "engine banner does not hint when builtin because omp fails" from D3 — no task covers it, removed from §3 (not added to rejected because this is an unverified observation, not a design decision).

### Round 2 — 2026-08-25 · unic/unic-smart (PlanReview-R2, REVIEW_TARGET_TYPE=plan)

Status: Approved

ROUND-1 FINDINGS VERIFICATION (6/6):
  - (a) Wave overlap T7 vs T8/T9 — RESOLVED: Wave 1 = {T1,T5,T6} (files disjoint); Wave 2 batch A = {T2,T4,T7} (disjoint in-batch; T7 dep T6, cross-wave), batch B = {T3,T8,T9} with T8→T9 serialized in-batch on webview/main.ts + styles.css. Every same-file pair is now ordered by wave/batch/serial (T6→T7, T7→T8/T9, T8→T9, T2→T3, T1→{T2,T4}); dependency graph matches the batch layout.
  - (b) Budget unified — RESOLVED: single production const `SCHEMA_CONTEXT_BUDGET = 12_000` in aiChatPanel.ts; `buildMessages(factory, history, userMsg, opts?: {contextBudgetChars?; contextTableLimit?})` injectable; T2#3 overrides `contextBudgetChars: 2000` via opts. No 8000 remnant outside the historical Round-1 log itself.
  - (c) T7 saveStatements path — RESOLVED in TASK file + revision note #3; RESIDUE in PLAN §2:27 still lists `src/core/saveStatements.ts` in TASK-007's parenthetical, contradicting G2 ("already present") and note #3. Non-blocking: the TASK file governs execution.
  - (d) Oversize-block + shared pool — RESOLVED: D1 defines block = 1 object DDL; tables AND views share one budget pool in render order; first block alone exceeding budget is kept (context never empty when DB has objects); later blocks dropped whole + counted; footer dropped when it doesn't fit; empty DB → old prompt. Locked by T2#3 + T2#3b.
  - (e) T4 no-connection edge — RESOLVED: §4 row T4#4 added (mgr.getActive() null → info message, no crash, clipboard not written).
  - (f) D3 banner clause — RESOLVED: sentence removed from the diagnosis; only the removal note remains.

COMPLETENESS:
  - none — no TODO/TBD; declared gaps (view DDL, ACP/omp depth, docker integration, jsdom visual check) remain explicit.
CONSISTENCY:
  - minor: PLAN.md:27 vs PLAN.md:192 — stale `src/core/saveStatements.ts` in §2 TASK-007 summary; one-token delete, TASK file already correct.
  - minor: PLAN.md:81 (T4#4 "info message instructing the user to connect first") vs PLAN.md:194 (note #5: `Export All Structures failed: <reason>`) — align on one expected string; the executor follows TASK-004.
CLARITY:
  - minor: PLAN.md:134 (§6) cites "T3#1 RED→GREEN" but §4 table starts at T3#2 — test lives in TASK-003; pre-existing, harmless.
SCOPE:
  - none — 9 tasks / 2 waves / 2 batches coherent; revision introduced no creep.
YAGNI:
  - none — injectable opts is the minimal test seam; no new machinery added.

NOTES: Both Round-1 criticals are mechanically resolved and the wave/batch topology is now conflict-free; the three minors are one-line doc cleanups that cannot affect task-file execution. Approved — proceed. (Numbering: the planner's revision entry above is also labeled "Round 2 — revision"; this entry is the Round-2 review per the orchestrator's 2-round cap.)

PLAN_REVIEW: Approved by unic/unic-smart (PlanReview-R2, Round 2)
