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

- Action: 4 webview fixes từ grid/UI audit: (1) `orderByFromColumnState` maps colId qua
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


- Action: handoff cycle W — 4 tasks / 2 waves từ backlog INDEX: TASK-001 ORDER BY parser
  (quote-aware comma split, dialect quoting, composite-PK tiebreaker khi mọi PK column được
  project, emptyIsBlank theo declared type family anchored), TASK-002 buildDistinctValuesQuery
  (module mới src/ui/distinctValues.ts, pure), TASK-003 webview sort header-click 3 dialect +
  DISTINCT set-filter + typed values (strict driver-token dialect parse; sort carried trong
  filter/paging requery; cache invalidation re-request sau render), TASK-004 host wiring
  (distinct-values round trip + stale statement-index guard + batch drain + truncated giữ
  nguyên; multi-term ORDER BY qua AS vsdb_sub; SaveContext.listColumnTypes).
- Plan review 2 rounds (R1: 1 critical + 5 important; R2: 5 blocking — full composite PK,
  stale guard, AS vsdb_sub, LONGTEXT family, mismatched-quote reject — applied without
  re-review theo loop cap). Review code: round 1 cả 4 changes_requested → fix round 1 cả 4
  PASS → 3 approved, TASK-003 còn 1 finding → fix round 2 (refresh mounted filters SAU
  render) → approved.
- Flake fix: webviewServerSort test 5+18 flaky ~40% aggregate (debounce race) — drain
  posts deterministically; 5/5 full-suite runs green 1494 passed / 2 skipped / 0 failed.
- Files: src/ui/{queryComposer,distinctValues,messages,resultsPanel}.ts, src/extension.ts,
  webview/main.ts, 5 test file mới + amendments; docs/AI_HANDOFF/*.
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
  pin PoolClient/PoolConnection), `handleSaveEdits` chạy save qua transaction, requery manual
  route qua pinned session (tránh deadlock pool.max=1), `closeStatementCursor` trước
  beginTransaction, R-A4 refresh-state race (compute refresh trước ack). R2 review APPROVED.
- Files: `src/adapters/{types,postgres,mysql}.ts`, `src/core/queryRunner.ts`,
  `src/ui/resultsPanel.ts`, `src/extension.ts`, `src/ui/__tests__/manualCommit.test.ts`,
  docs/AI_HANDOFF/*.
- Verification: compile clean · typecheck clean · full suite 1327 passed / 2 skipped / 0
  failed. Commit f5caddd trên main. Worktree sạch. Chưa push (cần xác nhận scope).
- Queued: Cycle V (SQL syntax coloring), server-side filter/paging, MSSQL sort.

## 2026-08-25 — Cycle S (lazy ctid) + release v1.6.3

- Action: fix `Error: column "ctid" does not exist` khi mở view PG. Handoff cycle S: 3 tasks
  (TASK-001 xóa eager ctid wrap ở read path; TASK-003 DELETE no-PK qua ctid lúc save;
  TASK-002 gộp save path về 1 lazy fetchPostgresCtids). Plan review 2 rounds (1 critical:
  2 file test webview không có owner → giao TASK-001); review 3/3 approved, TASK-001 cần
  1 fix round (restore test #7b/#8b ngoài scope bị xóa).
- Files: `src/ui/browseCommands.ts`, `src/ui/resultsPanel.ts`, `src/core/saveStatements.ts`,
  `src/ui/resultsGridModel.ts`, `webview/main.ts` (comments), 6 file test; docs/AI_HANDOFF/*.
- Post-merge: user vẫn thấy lỗi vì cycle S không release — installer 1 dòng kéo VSIX từ
  latest GitHub Release (vẫn 1.6.2 lỗi). Release v1.6.3: bump + CHANGELOG + lockfile sync
  (releaseHygiene bắt drift 1.6.2≠1.6.3 → `npm install --package-lock-only`) + build.sh
  (1043 pass) + tag + `gh release create` kèm vsdb-1.6.3.vsix + install qua one-liner
  (1.6.2 → 1.6.3, `__vsdb_browse__` = 0 trong bản đã cài).
- Docs: MEMORY.md (ship constraint + root cause), RELEASE.md (mục "Shipping to users"),
  CHANGELOG 1.6.3. Pushed 2d0fd94 + tag v1.6.3.

## 2026-08-23 — Cycle 2026-08-23-H: hardening + release v1.5.1

- Action: carry-over minors từ reviews cycle G → 4 task handoff (701 EXPLAIN guard, 702 codepoint cap, 703 lock hygiene, 704 release).
- Files: `src/core/dangerousStatement.ts` (skip-past-`explain` prelude, `sawExplain` flag), `src/core/text.ts` (new `truncateAtBoundary`), `src/extension.ts` (capDetail dùng helper — 2 dòng), `package-lock.json` (root 1.3.0→1.5.1), `src/__tests__/releaseHygiene.test.ts` (new), package.json 1.5.1.
- Waves: W1 = 701∥702∥703 (disjoint files, executors unic-code trong worktrees) → 9ac114e; W2 = 704 → 9e3f7b1; reviews 0bf6bc8; close 0438762.
- Review: 4/4 approved (701/702/704 approved_minor). 702 cần 1 vòng auto-fix — blocker chỉ là thiếu RED_OUTPUT paste; Fix702 temp-revert helper → capture real lone-surrogate failure → restore byte-identical.
- Verification: full suite 40 files / 453 tests PASS; `tsc --noEmit` 0; `scripts/build.sh` → dist/vsdb-1.5.1.vsix 1576198 bytes.
- Release: push main (356973d..0438762), tag v1.5.1, gh release + asset verified (`gh release view`).

## 2026-08-24 — Cycle M: approval-aware omp ACP bridge

- Action: replaced Cycle L's `omp --mode rpc --approval-mode yolo` integration with a JSON-RPC/NDJSON ACP bridge; user-facing ACP permissions now require explicit Allow/Deny in AI Chat and default-deny on timeout, stop, disposal, replacement, and process exit.
- Files: `src/ai/omp/acp.ts`, `acpProcess.ts`, ACP tests; `src/ui/aiChatPanel.ts`, message/webview permission UI and ACP tests; `src/extension.ts`; removed legacy RPC/process bridge and its tests after caller migration.
- Protocol evidence: live `omp acp` 18.0.1 probe established `initialize`, `initialized`, canonical `session/new`, session ID, and child `cwd`; unsafe guessed `session/create` was rejected and never shipped.
- Review: 4/4 approved (TASK-004 approved_minor after fix round for real child-exit → default-deny lifecycle). Known minor: `hostTools.ts`/`detect.ts` are now orphaned; deferred rather than deleting fallback-related code outside this cycle.
- Verification: full suite 751 passed / 2 opt-in availability smoke skipped; `npm run compile` and `npm run typecheck` clean.
- Lesson lặp lại: copy-back bằng `git diff --name-only` + `ls-files` bỏ sót file gitignored (`.cache/release-notes-v1.5.1.md` ở cycle G) → cycle H copy tay notes ngay đầu và báo path trong report — không mất lần nữa.

## 2026-08-24 — Cycle N: builtin engine streaming

- Action: streaming cho builtin AI engine (đóng UX gap chờ full response); unfreeze có chủ đích `provider.ts`/`agent.ts` (frozen từ cycle J chỉ là scope).
- Files: `src/ai/provider.ts` (streamComplete SSE, parser tự viết 0 dep, CRLF-safe, AbortError trần), `src/ai/agent.ts` (opt-in streamComplete deps + onStreamFallback 1 lần + catch order pin: abort→rethrow / ProviderError@0→fallback / else→rethrow), `src/ui/aiChatPanel.ts` + `webview/aiChatPanelMain.ts` (delta render có sẵn từ ACP, banner "— streaming", deStreamOpenBubble trên done/error), `src/extension.ts` (5-arg closure).
- Fix rounds: T001 (CRLF parse + abort wrap), T003 (Stop hiện error bubble — phân loại abort-vs-error; test tự gate theo signal).
- Flaky-type fix: `webviewExport.test.ts` drain AG Grid debounce-0 timer sau teardown (unhandled 'window is not defined' → exit 1 dù 777 pass).
- Verification: full suite 778 passed / 2 opt-in skipped, exit 0; compile + typecheck clean. Pushed 2056828.

## 2026-08-24 — Cycle O: ACP session history & resume

- Action: AI Chat thêm Resume session — list/load/replay/resume omp sessions qua ACP; fix latent bug session/new thiếu mcpServers:[] (live -32603).
- Probe-first: live omp acp NDJSON probes chứng minh session/list, session/load (replay 157 notifications), resume prompt end_turn; ghi queue/ACP-SESSION-research.md trước khi plan (không đoán envelope).
- Files: src/ai/omp/acp.ts (sessionList/sessionLoad + AcpReplayBuffer — cửa sổ replay đóng theo outgoing write, multi-flush safe), src/ai/omp/acpProcess.ts (wiring + mcpServers fix), src/ui/aiChatPanel.ts + aiChatPanelMessages.ts (picker, replay drop-guard, cap 50 + truncated notice, streaming guard), webview/aiChatPanelMain.ts (picker UI + history render textContent-safe).
- Fix round T003: missing RED output, streaming guard, 2 test không giết mutation (sort monotonic fixture, drop-guard bị transport absorb che).
- Verification: full suite 819 passed / 2 opt-in skipped exit 0; compile + typecheck clean. Pushed a3ba36b.

## 2026-08-24 — Cycle P: permission detail + tool-call UI + VSIX release

- Action: dọn sạch backlog cuối — permission dialog hiện tool args/SQL preview, builtin engine hiện tool-call live, release pass VSIX 1.6.0.
- Files: src/ui/permissionDetail.ts (sanitizer pure: redact secret keys, SQL preview, JSON pretty, cap 2000), aiChatPanel.ts + webview (collapsible textContent detail), agent.ts (AgentCallbacks.onToolCall additive — fire trước executeToolCall, không abort-check trong loop), CHANGELOG.md (I–P), docs/RELEASE.md, .vscodeignore (thêm vitest.integration-all.config.ts bị leak).
- Lỗi bắt được: releaseHygiene test phát hiện package-lock root version 1.5.1 ≠ package.json 1.6.0 → npm install --package-lock-only sync lại.
- Verification: full suite 838 passed / 2 opt-in skipped exit 0; compile + typecheck clean; vsdb-1.6.0.vsix (15 files, 1.55 MB, không src/node_modules). Pushed 6df9083.
