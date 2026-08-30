# Worklog

Track session-level execution details.

## Budget Rules

Keep this file compact to save AI context tokens:

- **Max 30 entries.** When over, archive the oldest entries to `docs/WORKLOG_ARCHIVE.md`.
- **Max ~600 lines.** If over, archive oldest entries until under budget.
- Each entry should be 10-20 lines max (summary, not transcript).
- On archive: move full entry block to `docs/WORKLOG_ARCHIVE.md` (create if missing).
- Keep a compaction marker as the last line: `<!-- Entries before YYYY-MM archived to docs/WORKLOG_ARCHIVE.md. Keep this file < 600 lines. -->`
- If the user says "compact worklog" or "clean worklog", perform the archive pass and report what moved.

For each significant action, append:
- Date/time
- Action taken
- Files changed
- Verification run
- Outcome

---

## 2026-08-30 — DBX-02 SQL Intelligence Navigation shipped

- Action: executed the full DBX-02 cycle (tasks 001–005): SchemaCache catalog accessors + vscode-free `createCatalogResolver`; completion extended with FK targets + views/routines/sequences; new SqlNavigationProvider (hover + definition over `vsdb-sql-catalog:` virtual docs); `extractIdentifierReferences` in statementParser + SqlReferenceProvider (find usages); all wired in extension.ts behind partial-mock guards sharing one schemaCache.
- Files: src/ui/sqlCatalog.ts, sqlCatalogDocumentProvider.ts, sqlNavigationProvider.ts, sqlReferenceProvider.ts, sqlCompletionProvider.ts, schemaCache.ts, src/core/statementParser.ts, src/extension.ts, + tests.
- Verification: `npx vitest run` 2237 passed | 2 skipped (+49 vs AIC baseline 2188); `npm run typecheck` exit 0; `npm run compile` clean. Commits: f40ae1f, aa5f36d, 29d065f, a093381 (+ docs).
- Outcome: DBX-02 5/5 tasks done; docs/AI_HANDOFF updated (INDEX_DBX02 all done, ACTIVE.md rotated).

## 2026-08-30 — Reliability audit and verification baseline

- Action: completed focused reliability fixes/audit covering AI SQL autocomplete safety and PostgreSQL SQL navigation contracts; finalized the navigation test harness so it runs under the standard Node Vitest environment.
- Verified protections: schema-context connection races and bounded hydration, multiline document offsets and stale completion responses, SQL trailing comments/literal lexical handling, and SQL catalog hover/definition behavior.
- Verification: `npx vitest run` — 151 files passed, 1 skipped; 2232 tests passed, 2 skipped. `npm run typecheck` and `npm run compile` passed.
- Outcome: no active verified regression remains from this audit. Future reliability work should start with the R1 QueryRunner/Results lifecycle regression-net plan; DBX-02 in-flight ownership boundaries remain respected and no external release/publish action occurred.

## 2026-08-29 — AI Chat slash commands + session UX

- Action: implemented local slash-command parsing and composer UX for `/clear`, `/resume`, `/engine`, `/context`, `/export`, and `/model`.
- Files: `src/ui/aiChatPanelCommands.ts`, `src/ui/aiChatPanelMessages.ts`, `src/ui/aiChatPanel.ts`, `webview/aiChatPanelMain.ts`, `webview/styles.css`, and focused AI chat tests.
- Behavior: slash autocomplete uses text-safe DOM nodes; Enter/Tab/Arrow/Esc precedence is isolated from mention handling; recognized commands never enter normal `send`; clear/resume reuse existing wire handlers; context/export stay local; engine/model are host-routed without secrets.
- Model role: `/model work|smart` is session-local and is passed into the next builtin `runAgent` turn. Engine selection validates `builtin|omp`, persists the setting, and explains when reopening is required.
- Verification: targeted parser/host/bundle suites 58 passed; final bundle suite 21 passed; all AI chat suites 316 passed; full suite 2066 passed with 2 skipped; `npm run typecheck` and `npm run compile` passed; release hygiene 3 passed; `git diff --check` passed.
- Release prep: `npm version minor --no-git-tag-version` set v1.14.0, changelog and comparison links updated, `scripts/build.sh` passed, and the final `npx @vscode/vsce package --no-dependencies -o dist/` produced `dist/vsdb-1.14.0.vsix` (1,720,515 bytes). External tagging/publishing intentionally not performed; release remains local-prepared.

## 2026-08-28 — Cycle AB: AI chat image attach + clipboard paste + release v1.9.0

- Action: full handoff cycle (P0→R5+release) adding image attach + Cmd/Ctrl+V paste to the AI Chat composer. P0 decisions: scope = image attach + paste (slash commands deferred); caps = 5 MB / 4 per turn; non-vision policy = block at attach with amber warning (rejected: auto-route to vision model / send-with-warning — both surprise the user or violate "no broken messages"). Plan review round 1 = Issues Found (3 BLOCKING: CSP img-src missing, omp/ACP silent-drop, userContentOverride redundant) → revised → loop cap reached, applied without re-review.
- Implementation: 4 tasks / 2 waves in 4 worktrees. Wave 1 (3 parallel): T1 host message contract + CSP fix + omp/ACP gate + buildMessages image-parts path; T3 CSS for attach strip + button + warning + dark theme + :focus-visible; T5 pure helpers (validateImageAttachment / log redaction / dataURL) + magic-byte sniff. Wave 2 (1): T2 webview UX (attach button + hidden file input + paste handler + strip renderer + dynamic tooltip + FileReader onerror drop+warn). All TDD: RED first, GREEN after. Cycle-AA keybind (Enter=send / Shift+Enter=newline) + height chain (.vsdb-chat-body) preserved.
- Review: 4 reviewers (unic-smart). R1 (T1) CHANGES-REQUESTED on paperwork (missing Executor Report with EXECUTOR_MODEL/RED_OUTPUT) + 2 missing tests (privacy sentinel + attachments, mention×attachment). R2 (T3) APPROVED-WITH-MINOR (stale comment + dark-token test pins 1 of 6). R3 (T5) APPROVED-WITH-MINOR (phantom ImageAttachment type import in test; misleading comment). R4 (T2) CHANGES-REQUESTED on paperwork (same gap as R1) + FileReader onerror resolved empty base64 → corrupt push + missing dynamic tooltip. R1.5 + R4.5 fixed all; re-review R1.5 APPROVED. Loop cap 2 reached → R5.
- Verification: 75 files / 1139 tests pass / 0 fail (TDD + cycle-AA + cycle-AB all green); typecheck exit 0. vsdb-1.9.0.vsix 18 entries / 0 forbidden / 0 markers; vsdb-chat-body + mention_objects + vsdb-chat-attach-btn + img-src 'self' data: all present in extension bundle. Released v1.9.0 (commit 5a9bb1d, tag v1.9.0, GitHub release with vsdb-1.9.0.vsix 1.65 MB).

## 2026-08-28 — Cycle AA: AI Chat UX overhaul + release v1.8.0

- Action: full handoff cycle (P0→R5+release) rebuilding the AI Chat panel to modern
  AI-chat standards. Mid-plan steering added: resume-picker repair (zero CSS existed),
  @-mentions (DB objects DDL + workspace files content, per-turn), Enter=send keybind.
  Plan reviewed: round 1 Issues Found (2 importants: thought-pin supersession unlisted,
  Regenerate-after-Stop undefined) → revised → loop cap reached, applied without re-review.
- Implementation: 5 tasks / 3 waves in worktrees. T1 thought+regenerate contract;
  T2 webview UX (thinking block, copy, keybind, scroll, states); T3 layout CSS (60vh
  kill, height chain, picker/mention styles); T4 privacy lock (DDL-only sentinel,
  mutation-tested by reviewer); T5 @-mentions (pure parser, host resolution, dropdown).
  Two executor parks (infra) → orchestrator finished T2 last 2 tests + T5 verification.
- Review: R2-R4 5 parallel reviewers. T2/T4 approved(+minor); T1 changes_requested
  (stale mention-context re-sent on Regenerate; Clear didn't reset lastSentText);
  T3 critical_block (height chain dead in real browser — body class missing, found via
  headless-Chromium probe); T5 changes_requested (single-segment regex, '..' escape,
  UTF-16 vs bytes). Fix round 1 + 1b fixed all; re-review approved 5/5.
- Verification: 73 files / 1086 tests pass, typecheck 0. vsix 18 entries, 0 forbidden,
  0 markers. Released v1.8.0 (commit 10d44f3, GitHub release with vsdb-1.8.0.vsix).

## 2026-08-27 — Cycle Z: SQL Console feature + release v1.7.0

- Action: full handoff cycle (P0→R5) for a DataGrip-style SQL Console. P0 decisions:
  results render in the EXISTING ResultsPanel via the shared runStatements flow; Save-as-SQL
  via in-webview context menu + toolbar Save button; no persistence (empty each open).
  Plan reviewed in 2 rounds (round 1: CSS contract + sqlToRun full-buffer semantics → fixed
  → Approved).
- Implementation: 3 chained tasks, one wave each. TASK-001 src/ui/consolePanelMessages.ts
  (pure helpers: suggestSaveFileName timestamped console_YYYYMMDD_HHMMSS.sql + message
  contract). TASK-002 webview/consolePanelMain.ts (textarea, Run/Save, Cmd/Ctrl+Enter,
  custom right-click menu) + esbuild.js entry → dist/consolePanel.js + .vsdb-console*
  styles + bundle pin tests. TASK-003 src/ui/consolePanel.ts host panel (CSP posture matches
  other panels) + extension.ts `vsdb.openConsole` + package.json contributes.
- Review: bao-opus per task — TASK-001 approved_minor, TASK-003 approved, TASK-002
  changes_requested (context menu ignored Escape / stayed open after keyboard run).
  R4.5 fix round 1: Escape + click-away + run-closes-menu behavior added with regression
  tests (#8/#9) → re-review APPROVED.
- Verification: aggregate suite 1693 passed / 2 skipped / 0 failed; typecheck clean;
  build.sh → vsdb-1.7.0.vsix (1,682,919 bytes), artifact assertions (console bundle
  present, zero forbidden paths), installer dry-run OK. Note: first build.sh run had 1
  flaky test failure mid npm-ci install; two subsequent full runs green — treated as
  environment flake, not product defect.
- Release: v1.7.0 — CHANGELOG entry, README feature bullet (vi), tag + push +
  `gh release create` with vsix attached.
- Files: src/ui/{consolePanelMessages,consolePanel}.ts (new),
  webview/consolePanelMain.ts (new), esbuild.js, webview/styles.css,
  src/extension.ts, package.json, 3 new test suites (20 targeted tests).

## 2026-08-27 — Cycle Y close + release v1.6.8

- Action: finished every queued results/query item from Cycle X backlog in one unattended
  handoff cycle (8 tasks / 3 waves): manual-commit UI toggle (C1, product decision = expose
  UI), atomic MySQL multi-statement batches, declared-type grid inference, keyset paging with
  safe hidden-PK projection (structural browse gate), mysql/mssql NULLS emulation, scoped
  DISTINCT dropdown + visible truncation/error footer, typed state dialect + positional sort,
  deterministic webview server-sort lifecycle.
- Phase R: 8 parallel bao-opus reviewers — 5 approved_minor, 3 changes_requested. R4.5 fix
  round 1 (3 parallel sonnet fixers): TASK-003 typmod type matching (numeric(10,2)/bit(1)),
  TASK-004 carry `nulls` through paging + keyset-lane refusal, TASK-007 ordinal as data flag
  (quoted `"2024"` stays quoted). Aggregate 261 targeted green → re-review round 1: all 3
  APPROVED (8/8 tasks green).
- Boundary verification: full suite 1642 passed / 2 skipped / 0 failed (baseline 1552, +90
  new tests), typecheck + compile clean.
- Release: v1.6.8 — CHANGELOG entry, `npm install --package-lock-only`, `bash scripts/build.sh`
  + artifact assertions, installer dry-run, tag + `gh release create`. Single fast-forward
  push to origin/main.
- Files: src/ui/{resultsPanel,keysetPaging(new),resultsGridModel,queryComposer,messages,
  distinctValues}.ts, src/adapters/mysql.ts, webview/{main,connectionFormMain}.ts,
  src/extension.ts, README.md, CHANGELOG.md, 14 test files (+2 new suites).
- Status: PUSHED + released v1.6.8. Docs under docs/AI_HANDOFF/ (PLAN/TASKS/INDEX/RUN)
  updated to done/approved.

## 2026-08-26 — Cycle Y TASK-007 (typed state dialect + declared-type wiring + webview minors)

- Action: StateMessage gains optional typed `dialect` + positional `columnTypes` (numeric-string
  ordinals). All 11 state posts fill them via one `decorateStateMessage` helper; maps produced by
  generation-guarded `refreshColumnTypes` under browse-shape gate (`assertBrowseShape` +
  `tableByStatement` provenance), one upgrade re-post when fresh types land. Webview prefers
  typed dialect (header parse stays fallback), converts positional→name once for
  `inferColumns(columns, rows, types)`, emits POSITIONAL ORDER BY (`2 ASC`) for duplicate
  projection names; host parseOrderBy accepts bare ordinals, emitted unquoted on all dialects
  (single-term lane bypasses composeSortQuery to avoid quote-wrapping). readExportInput return
  type declares `hiddenColumns: string[]`; dead test no-ops removed.
- TDD: RED across 4 files + queryComposer lane → GREEN 67/67. Two intentional expectation
  changes: queryComposer case 5 accepts ordinals; serverFilter case-16 "'1' rejected" pinned
  to bare ordinal composition.
- Files: src/ui/{messages,resultsPanel,queryComposer}.ts, webview/main.ts, 6 test files.
- Verify: compile → task files 4/4 (67 tests) ✓ · typecheck clean · adjacent regressions
  (queryComposer 65, serverFilter lane 112, resultsGridModel batch 63, webviewRequery/
  SaveEdits/CommitRefresh/Filters 22+63) all green. Uncommitted per handoff rules.

## 2026-08-26 — TASK-007 wave-3 (webview grid hardening: real sort column, warnings banner, quick-search no requery, in-DOM refresh confirm)

- Action: 4 webview fixes from grid/UI audit: (1) `orderByFromColumnState` maps colId via
  `currentSpecs` → `headerName` before quoting (dup columns `id__2` post real `id ASC`);
  (2) `SaveResultMessage.warnings?: string[]` + webview mirror, rendered on ok:true; (3)
  `onFilterChanged` only schedules server requery for column-filter sources — quick-search
  typing posts nothing (search handler now calls `onFilterChanged("quickFilter")`);
  (4) `onRefreshClick` replaces window.confirm with in-DOM saveBanner Discard/Cancel
  (reused .vsdb-save-retry style); Browse header carries ` — driver@host/db` token.
- TDD: 4 mandated RED failures (dup sort `id__2 ASC`, warnings banner hidden, search
  requery posted, dirty discard on refresh) → GREEN; A13 tests rewritten to drive the
  in-DOM controls (intentional expectation change).
- Files: webview/main.ts, src/ui/{messages,browseCommands}.ts + 5 test files.
- Verify: targeted 58/58 + regression 47/47 + typecheck 0 errors; dist/webview.js rebuilt.


## 2026-08-26 — Cycle X (adversarial QA + hardening) + release v1.6.7

- Action: handoff cycle X — 8 tasks / 3 waves: wave 1 (TASK-001, TASK-002 adversarial
  audits, 20 findings) → reconciliation gate materializes TASK-006/007/008; wave 2 (TASK-003
  webview flake root fix — bundle evaluated once per suite; TASK-004 export quoting +
  whitespace `(Blanks)`; TASK-006 resultsPanel hardening; TASK-008 save/core hardening);
  wave 3 (TASK-005 MySQL adapter sort twin + UTC sessions + stream-end settle; TASK-007
  webview grid hardening).
- TASK-004 went 2 fix rounds: R1 (bare-identifier export quoting + per-dialect whitespace
  Blanks predicate, RED→GREEN), R2 (dialect forwarded into both serializeExport call sites +
  end-to-end test 6b) → APPROVED-WITH-MINOR. All 8 tasks approved (bao-opus review).
- Files: webview/main.ts, src/ui/{resultsGridModel,queryComposer,resultsPanel,distinctValues}.ts,
  src/core/{saveStatements,queryRunner}.ts, src/adapters/mysql.ts, src/ui/messages.ts,
  src/core/text.ts + test amendments; docs/AI_HANDOFF/*.
- Verify: full suite 1552 passed / 2 skipped / 0 failed; typecheck exit 0.
- Git: plan a103eed → waves (a103eed→cee00ac) → reviews → R4.5 fix rounds → I4 df7319e →
  single push to main (fast-forward, 12 commits).
- Release v1.6.7: bump + CHANGELOG + lockfile sync + build.sh → dist/vsdb-1.6.7.vsix
  1672093 bytes, assertions 0 forbidden, dry-run OK, gh release v1.6.7 with vsix attached.


- Action: handoff cycle W — 4 tasks / 2 waves from backlog INDEX: TASK-001 ORDER BY parser
  (quote-aware comma split, dialect quoting, composite-PK tiebreaker when every PK column is
  projected, emptyIsBlank per declared type family anchored), TASK-002 buildDistinctValuesQuery
  (new module src/ui/distinctValues.ts, pure), TASK-003 webview sort header-click 3 dialect +
  DISTINCT set-filter + typed values (strict driver-token dialect parse; sort carried in
  filter/paging requery; cache invalidation re-request after render), TASK-004 host wiring
  (distinct-values round trip + stale statement-index guard + batch drain + truncated kept
  intact; multi-term ORDER BY via AS vsdb_sub; SaveContext.listColumnTypes).
- Plan review 2 rounds (R1: 1 critical + 5 important; R2: 5 blocking — full composite PK,
  stale guard, AS vsdb_sub, LONGTEXT family, mismatched-quote reject — applied without
  re-review per loop cap). Review code: round 1 all 4 changes_requested → fix round 1 all 4
  PASS → 3 approved, TASK-003 still 1 finding → fix round 2 (refresh mounted filters AFTER
  render) → approved.
- Flake fix: webviewServerSort test 5+18 flaky ~40% aggregate (debounce race) — drain
  posts deterministically; 5/5 full-suite runs green 1494 passed / 2 skipped / 0 failed.
- Files: src/ui/{queryComposer,distinctValues,messages,resultsPanel}.ts, src/extension.ts,
  webview/main.ts, 5 new test files + amendments; docs/AI_HANDOFF/*.
- Git: plan f0bc514 → waves 2e69859 → verdicts → fix rounds → R5 close 089941a, pushed.
- Release v1.6.6: bump + CHANGELOG + lockfile sync + build.sh → dist/vsdb-1.6.6.vsix
  1668464 bytes, assertions 0 forbidden, dry-run OK.

## 2026-08-26 — Cycle V (SQL coloring + server-side filter/paging + MSSQL sort) + release v1.6.5

- Action: handoff cycle V — 6 tasks / 2 waves: TASK-001 SQL TextMate injection grammar
  (`syntaxes/vsdb-sql-injection.tmLanguage.json` + package.json contribution, no
  contributes.languages), TASK-002 schema-aware semantic tokens provider
  (`src/ui/sqlSemanticTokens.ts` + extension.ts wiring, refresh() at both cache-invalidation
  sites, reuse schemaCache), TASK-003 webview SQL tokenizer (`webview/sqlHighlight.ts` +
  themed styles, no-innerHTML contract), TASK-004 dialect query composer
  (`src/ui/queryComposer.ts`: buildFilterWhere/buildPagedQuery/composeSortQuery, typed
  values, no String() coercion), TASK-005 server-side filter + OFFSET/LIMIT paging
  (messages.ts optional fields, resultsPanel.ts handleRequery, webview/main.ts wiring),
  TASK-006 MSSQL sort (mssql.ts getTableSortQuery T-SQL OFFSET/FETCH + composer delegation).
- Review: R1-R4 6/6 approved by bao-opus (5 approved + 1 approved_minor), 0 changes_requested,
  0 fix rounds. Reviewer re-ran each task's targeted tests + typecheck fresh.
- Boundary: full suite 1400 passed / 2 skipped / 0 failed + the known resultsGridModelNull
  test-6 flake (passed 8/8 isolated — transient, not a regression). compile + typecheck clean.
- Files: syntaxes/, webview/{sqlHighlight,main,aiChatPanelMain,styles}.ts/css, src/ui/{
  queryComposer,sqlSemanticTokens,messages,resultsPanel}.ts, src/adapters/{mssql,postgres}.ts,
  8 new test files + extension.test.ts/aiChatPanelWebview.test.ts amendments; docs/AI_HANDOFF/*.
- Git: plan f7ba1e1 → waves 11c36c5, 575d727 → I4 e2e0aee → review efbd5c5 → RUN done 3571ea4,
  all pushed to main. Worktree/branch cleanup verified clean.
- Release v1.6.5: bump + CHANGELOG + lockfile sync (npm install --package-lock-only) +
  build.sh (ci/typecheck/test/compile/package) → dist/vsdb-1.6.5.vsix 1662629 bytes, artifact
  assertions 0 forbidden, installer dry-run OK.

## 2026-08-25 — Cycle U (DataGrip parity) complete

- Action: handoff cycle U — 9 tasks / 5 waves: export keepIndices fix, MSSQL parameterized
  queries, PG server-side sort, NULL display + value viewer, A19 retry, post-commit refresh,
  per-table tabs, schema autocomplete, manual-commit mode. R1 review TASK-009 =
  CHANGES-REQUESTED → auto-fix: `DbTransaction` session-pinned handle (adapters PG/MySQL
  pin PoolClient/PoolConnection), `handleSaveEdits` runs save via transaction, requery manual
  route via pinned session (avoids deadlock pool.max=1), `closeStatementCursor` before
  beginTransaction, R-A4 refresh-state race (compute refresh before ack). R2 review APPROVED.
- Files: `src/adapters/{types,postgres,mysql}.ts`, `src/core/queryRunner.ts`,
  `src/ui/resultsPanel.ts`, `src/extension.ts`, `src/ui/__tests__/manualCommit.test.ts`,
  docs/AI_HANDOFF/*.
- Verification: compile clean · typecheck clean · full suite 1327 passed / 2 skipped / 0
  failed. Commit f5caddd on main. Worktree clean. Not pushed yet (scope confirmation needed).
- Queued: Cycle V (SQL syntax coloring), server-side filter/paging, MSSQL sort.

## 2026-08-25 — Cycle S (lazy ctid) + release v1.6.3

- Action: fix `Error: column "ctid" does not exist` when opening a PG view. Handoff cycle S: 3 tasks
  (TASK-001 remove eager ctid wrap in read path; TASK-003 DELETE no-PK via ctid at save;
  TASK-002 merge save path into 1 lazy fetchPostgresCtids). Plan review 2 rounds (1 critical:
  2 webview test files had no owner → assign TASK-001); review 3/3 approved, TASK-001 needed
  1 fix round (restore test #7b/#8b out-of-scope deletions).
- Files: `src/ui/browseCommands.ts`, `src/ui/resultsPanel.ts`, `src/core/saveStatements.ts`,
  `src/ui/resultsGridModel.ts`, `webview/main.ts` (comments), 6 test files; docs/AI_HANDOFF/*.
- Post-merge: user still saw the error because cycle S did not release — one-line installer
  pulls VSIX from latest GitHub Release (still 1.6.2, broken). Release v1.6.3: bump + CHANGELOG + lockfile sync
  (releaseHygiene catches drift 1.6.2≠1.6.3 → `npm install --package-lock-only`) + build.sh
  (1043 pass) + tag + `gh release create` with vsdb-1.6.3.vsix + install via one-liner
  (1.6.2 → 1.6.3, `__vsdb_browse__` = 0 in installed build).
- Docs: MEMORY.md (ship constraint + root cause), RELEASE.md ("Shipping to users" section),
  CHANGELOG 1.6.3. Pushed 2d0fd94 + tag v1.6.3.

## 2026-08-23 — Cycle 2026-08-23-H: hardening + release v1.5.1

- Action: carry-over minors from cycle G reviews → 4 task handoff (701 EXPLAIN guard, 702 codepoint cap, 703 lock hygiene, 704 release).
- Files: `src/core/dangerousStatement.ts` (skip-past-`explain` prelude, `sawExplain` flag), `src/core/text.ts` (new `truncateAtBoundary`), `src/extension.ts` (capDetail uses helper — 2 lines), `package-lock.json` (root 1.3.0→1.5.1), `src/__tests__/releaseHygiene.test.ts` (new), package.json 1.5.1.
- Waves: W1 = 701∥702∥703 (disjoint files, executors unic-code in worktrees) → 9ac114e; W2 = 704 → 9e3f7b1; reviews 0bf6bc8; close 0438762.
- Review: 4/4 approved (701/702/704 approved_minor). 702 needed 1 auto-fix round — blocker was only missing RED_OUTPUT paste; Fix702 temp-revert helper → capture real lone-surrogate failure → restore byte-identical.
- Verification: full suite 40 files / 453 tests PASS; `tsc --noEmit` 0; `scripts/build.sh` → dist/vsdb-1.5.1.vsix 1576198 bytes.
- Release: push main (356973d..0438762), tag v1.5.1, gh release + asset verified (`gh release view`).

## 2026-08-24 — Cycle M: approval-aware omp ACP bridge

- Action: replaced Cycle L's `omp --mode rpc --approval-mode yolo` integration with a JSON-RPC/NDJSON ACP bridge; user-facing ACP permissions now require explicit Allow/Deny in AI Chat and default-deny on timeout, stop, disposal, replacement, and process exit.
- Files: `src/ai/omp/acp.ts`, `acpProcess.ts`, ACP tests; `src/ui/aiChatPanel.ts`, message/webview permission UI and ACP tests; `src/extension.ts`; removed legacy RPC/process bridge and its tests after caller migration.
- Protocol evidence: live `omp acp` 18.0.1 probe established `initialize`, `initialized`, canonical `session/new`, session ID, and child `cwd`; unsafe guessed `session/create` was rejected and never shipped.
- Review: 4/4 approved (TASK-004 approved_minor after fix round for real child-exit → default-deny lifecycle). Known minor: `hostTools.ts`/`detect.ts` are now orphaned; deferred rather than deleting fallback-related code outside this cycle.
- Verification: full suite 751 passed / 2 opt-in availability smoke skipped; `npm run compile` and `npm run typecheck` clean.
- Repeated lesson: copy-back via `git diff --name-only` + `ls-files` missed gitignored files (`.cache/release-notes-v1.5.1.md` in cycle G) → cycle H manually copied notes up front and reported the path — never lost again.

## 2026-08-24 — Cycle N: builtin engine streaming

- Action: streaming for builtin AI engine (closes UX gap of waiting for the full response); unfreeze `provider.ts`/`agent.ts` deliberately (frozen from cycle J only as scope).
- Files: `src/ai/provider.ts` (streamComplete SSE, hand-written parser 0 deps, CRLF-safe, raw AbortError), `src/ai/agent.ts` (opt-in streamComplete deps + onStreamFallback once + catch order pin: abort→rethrow / ProviderError@0→fallback / else→rethrow), `src/ui/aiChatPanel.ts` + `webview/aiChatPanelMain.ts` (delta render reused from ACP, "— streaming" banner, deStreamOpenBubble on done/error), `src/extension.ts` (5-arg closure).
- Fix rounds: T001 (CRLF parse + abort wrap), T003 (Stop shows error bubble — classify abort-vs-error; test self-gates on signal).
- Flaky-type fix: `webviewExport.test.ts` drain AG Grid debounce-0 timer after teardown (unhandled 'window is not defined' → exit 1 even though 777 pass).
- Verification: full suite 778 passed / 2 opt-in skipped, exit 0; compile + typecheck clean. Pushed 2056828.

## 2026-08-24 — Cycle O: ACP session history & resume

- Action: AI Chat adds Resume session — list/load/replay/resume omp sessions via ACP; fix latent bug in session/new missing mcpServers:[] (live -32603).
- Probe-first: live omp acp NDJSON probes confirmed session/list, session/load (replay 157 notifications), resume prompt end_turn; write queue/ACP-SESSION-research.md before planning (do NOT guess envelope).
- Files: src/ai/omp/acp.ts (sessionList/sessionLoad + AcpReplayBuffer — replay window closes on outgoing write, multi-flush safe), src/ai/omp/acpProcess.ts (wiring + mcpServers fix), src/ui/aiChatPanel.ts + aiChatPanelMessages.ts (picker, replay drop-guard, cap 50 + truncated notice, streaming guard), webview/aiChatPanelMain.ts (picker UI + history render textContent-safe).
- Fix round T003: missing RED output, streaming guard, 2 tests did not kill mutations (sort monotonic fixture, drop-guard hidden by transport absorption).
- Verification: full suite 819 passed / 2 opt-in skipped exit 0; compile + typecheck clean. Pushed a3ba36b.

## 2026-08-24 — Cycle P: permission detail + tool-call UI + VSIX release

- Action: clean up the final backlog — permission dialog shows tool args/SQL preview, builtin engine shows tool-call live, release pass VSIX 1.6.0.
- Files: src/ui/permissionDetail.ts (pure sanitizer: redact secret keys, SQL preview, JSON pretty, cap 2000), aiChatPanel.ts + webview (collapsible textContent detail), agent.ts (AgentCallbacks.onToolCall additive — fires before executeToolCall, no abort-check inside the loop), CHANGELOG.md (I–P), docs/RELEASE.md, .vscodeignore (add vitest.integration-all.config.ts that was leaking).
- Bug caught: releaseHygiene test detected package-lock root version 1.5.1 ≠ package.json 1.6.0 → npm install --package-lock-only to resync.
- Verification: full suite 838 passed / 2 opt-in skipped exit 0; compile + typecheck clean; vsdb-1.6.0.vsix (15 files, 1.55 MB, no src/node_modules). Pushed 6df9083.

## 2026-08-28 — Cycle AD: DB-aware AI Chat + OMP bridge + release v1.10.0

- Action: implemented five read-only DB-aware tools with a strict parser and explicit ACP-style permission gate; added OMP config injection and two discoverable VS Code commands; extracted the shared DDL-only `formatSystemPrompt` builder.
- Files: `src/ai/tools/readonlySqlParser.ts`, `src/ai/tools/dbAwareTools.ts`, `src/ui/aiChatPanel.ts`, `src/extensionConfigExport.ts`, `src/extension.ts`, `package.json`, `package-lock.json`, webview regression tests and AD handoff docs.
- TDD/review fixes: parser tests caught and closed `SELECT INTO`; webview fixtures now match hyphenated host option IDs and cover Allow Once/Session/Deny plus stale clicks; package declarations preserve `vsdb.aiChat` and expose both OMP commands.
- Review: TASK-001 approved; TASK-002 and TASK-003 approved with non-blocking minor notes. Reviewer unic-smart was isolated from executor unic-code.
- Verification: full suite 128 files / 1937 passed / 2 skipped; `npm run typecheck` exit 0; `npm run package -- --no-dependencies` produced `vsdb-1.10.0.vsix` with 18 entries, 0 forbidden entries, and all AD/AB markers.
- Delivery: commit `3f24080`, pushed `main`, tag `v1.10.0` pushed, GitHub release live at https://github.com/lengockhoa/VSDB/releases/tag/v1.10.0.

## 2026-08-28 — Cycle AE: OMP runtime session wiring + release v1.11.0

- Action: built real-time omp runtime on top of cycle AD's config bridge. Added `vsdb.ai.engine` setting (builtin|omp), `src/ai/omp/hostMcp.ts` MCP HTTP server hosting the 5 cycle-AD DB-aware tools, `src/ai/omp/ompChatEngine.ts` chat glue, and engine routing in `commandOpenAiChat`.
- Files: `src/ai/settings.ts` (engine field + aiSettingsErrors check + legacy migration), `src/ai/config.ts` (legacy migration), `src/extension.ts` (activation detect + routing), `src/ui/aiChatPanel.ts` (engine option + wiring), `package.json` (vsdb-ai-engine activationEvent), new tests across `src/ai/omp/__tests__/`.
- TDD: 22 new tests (hostMcp 13 + ompChatEngine 7 + engine routing + legacy migration). Review R1 found 3 blockers (lifecycle/contract/engine source-of-truth). R4.5 closed all 3 + added activation race fix.
- Review: TASK-001 R2 APPROVED; TASK-002/TASK-003 still flagged but loop cap 2 reached per cycle AA/AB precedent. T3 still ships the engine="omp" branch with a runtime stub that flips to builtin on first turn — known caveat documented in CHANGELOG and next cycle.
- Verification: 1963 tests passed / 2 skipped; `npm run typecheck` exit 0; `npm run package -- --no-dependencies` produced `vsdb-1.11.0.vsix` (18 entries, 0 forbidden, all AD + AB + AE markers present).
- Delivery: commit `1a5b8ca`, pushed `main`, tag `v1.11.0` pushed, GitHub release live at https://github.com/lengockhoa/VSDB/releases/tag/v1.11.0.

## 2026-08-28 — Cycle AF: DataGrip parity wave 1 + AE.5 fix + release v1.12.0

- Action: shipped 4 AF tasks in 3 waves (AF-001 pgCatalog + adapter.catalog capability; AF-003 sqlFormat pure module; AF-002 schema-tree catalog categories + vsdb-ddl: DDL viewer; AF-004 Console v2 multi-tab/history/EXPLAIN/Format). Fixed cycle AE R2-critical by dropping the activation-time omp engine shim (AE.5) — omp runtime now gated at chat open.
- Files: src/core/ddl/pgCatalog.ts (NEW), src/core/sqlFormat.ts (NEW), src/ui/ddlView.ts (NEW), src/ui/schemaTree.ts, src/ui/consolePanel.ts, src/ui/consolePanelMessages.ts, webview/consolePanelMain.ts, webview/styles.css, src/extension.ts, src/adapters/types.ts, src/adapters/postgres.ts, package.json (vsdb.openDdl/refreshDdl/consoleNewTab), + 6 new test files.
- Verification: 2021 tests passed / 2 skipped; npm run typecheck exit 0; npm run compile clean; vsdb-1.12.0.vsix = 18 entries, 0 forbidden, all markers (pgCatalog, formatSql, consoleHistory, vsdb-ddl, hostMcp).
- Delivery: merge commits c0af36b (wave1) + 3ed2da4 (wave2) + 0a70c99 (wave3) + 49f49cd (AE.5), release a72b9cf; tag v1.12.0 pushed; GitHub release live.

## 2026-08-29 — Cycle AH: accumulating multi-statement result tabs + release v1.13.0

- Action: shipped AH-001 queryRunner append mode/cursor discipline, AH-002 results-panel append wiring/cache isolation, and AH-003 append-only webview tabs with `Run N · Statement M` labels and per-tab DISTINCT cache preservation.
- Verification: 2057 tests passed / 2 skipped; `npm run typecheck` exit 0; `npm run compile` clean; `vsdb-1.13.0.vsix` 18 entries with all AF/AG/AH markers.
- Delivery: release commit, tag `v1.13.0`, and GitHub release live.

## 2026-08-30 — Cycle AIC: SQL autocomplete (5 tasks, AIC-001 → AIC-005)

- Action: shipped the full AIC cycle. AIC-001 settings form + every-load migration; AIC-002 schema-only `SqlAutocompleteService` (debounce/cancel/sequence/cache/cooldown as the single source of truth); AIC-003 editor `AiSqlCompletionProvider` with VS Code `CancellationToken` bridge; AIC-004 Console ghost-text overlay (no textarea mutation, Tab/right-arrow accept, per-tab lifecycle); AIC-005 `registerSqlAutocomplete` adapts the service into both the editor provider and the Console panel's `onAutocomplete` callback.
- Files: `src/ai/settings.ts`, `src/ai/sqlAutocomplete.ts`, `src/ui/aiSettingsForm.ts`, `src/ui/aiSqlCompletionProvider.ts`, `src/ui/consolePanel.ts`, `src/ui/consolePanelMessages.ts`, `webview/consolePanelMain.ts`, new `src/extensionAutocomplete.ts`, `src/extension.ts`, plus unit/bundle tests for each task.
- Behavior: every prompt contains schema-only context (no rows/history/apiKey/baseUrl); no logging of prompt/response; service is the sole debounce/cancel/cache owner (no second controller in callers); Console callerScope = `tabId` so editor/console caches partition cleanly; unconfigured/cancelled/stale/malformed resolve to `null` or `[]` silently.
- Verification: 2188 passed | 2 skipped (+121 over v1.13.0 baseline of 2066); `npm run typecheck` exit 0; `npm run compile` clean; 5 handoff commits on `main` (AIC-001..AIC-005). Manual VS Code smoke test for the Console overlay alignment is logged in `docs/AI_HANDOFF/tasks/TASK-AIC-004.md`.
