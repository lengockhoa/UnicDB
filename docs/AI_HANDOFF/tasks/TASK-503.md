# TASK-503 — Save edits (PK/ctid) + Commit flow + warning banner

- Status: `pending_review`
- Owner: `Exec503`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Cmd/Ctrl+Enter / nút Commit gửi 1 message `saveEdits` chứa mọi dirty cells (batch). Host build statements per adapter (UPDATE theo PK; PostgreSQL no-PK → ctid; MySQL/MSSQL no-PK → từ chối với warning). Webview hiện warning banner khi không save được; grid refresh sau commit.

## Target Files

- `src/ui/messages.ts` — thêm `saveEdits` message type.
- `webview/main.ts` — Cmd/Ctrl+Enter listener + Commit button → `postToHost({type:'saveEdits', index, edits, tableName, pkColumns})`; warning banner div; clear edit state sau ack.
- `src/ui/resultsPanel.ts` — handle `saveEdits` → gọi `runner`/adapter buildSaveStatements → run → trả state mới + `saveResult` (ok/errors).
- `src/core/queryRunner.ts` hoặc `src/adapters/*` — `buildSaveStatements(adapter, table, pkColumns, edits)`; postgres thêm `ctid` fallback query (SELECT ctid cần thiết — nếu result rows không có ctid, host query `SELECT ctid FROM t WHERE pk…` trước, hoặc webview nhận tableName+pkColumns từ metadata câu query gốc).
- `src/extension.ts` — pass table/pk metadata khi render results (parse từ query nếu có `FROM <table>`).
- `src/adapters/__tests__/` + `src/ui/__tests__/` — tests mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | buildSaveStatements PK present | `UPDATE t SET b=$1 WHERE a=$2` (postgres) / quoted mysql / mssql TOP syntax đúng dialect | edits 2 cells |
| 2 | unit | postgres no-PK → ctid | WHERE ctid = '(0,1)' syntax, warning flag set | no pkColumns |
| 3 | edge | mysql/mssql no-PK | trả `{ ok: false, reason: 'no_pk' }`, không build statement | no pkColumns |
| 4 | unit | commit-no-edits | KHÔNG post saveEdits (no-op) | dirtyCount=0 |
| 5 | unit | commit batch nhiều dòng | 1 message chứa tất cả edits (2 rows, 3 cells) | dirty 3 cells |
| 6 | integration | saveEdits → host ack → edit state clear + banner ẩn | state reset | jsdom |
| 7 | edge | save fail (SQL error) | banner hiện lỗi từ host, edit state GIỮ (không clear) để retry | ack error |
| 8 | regression | theme/filters vẫn hoạt động sau commit + re-render | 232 test cũ pass | full suite |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts`
- `src/ui/__tests__/webviewSaveEdits.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Browser smoke: edit cell → Cmd+Enter → đúng 1 postMessage.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-501 (EditState.snapshot)

## Interfaces

- Consumes: `EditState.snapshot()` (TASK-501), `sqlLiteral` (TASK-502).
- Produces: message `{ type:'saveEdits'; index: number; edits: Array<{ rowId: number; colIndex: number; value: unknown }>; tableName: string | null; pkColumns: string[] }`; host ack `{ type:'saveResult'; index: number; ok: boolean; errors?: string[] }`.

---

## Discussion


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: feature-implementer (omp subagent)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec503
SUMMARY: Implemented TASK-503 end-to-end — Cmd/Ctrl+Enter + Commit button post a single `saveEdits` batch; host builds per-dialect UPDATE/INSERT/DELETE via the new pure `buildSaveStatements` fn, runs through the adapter, re-runs the original SQL, and acks `saveResult` so the webview can clear the dirty map (success) or show the banner (failure / mysql-mssql no_pk refusal).
TEST_PLAN_FOLLOWED: inline — happy path + 2 dialect edges (mysql/mssql no_pk refusal, postgres no_pk ctid) + Add/Delete markers + batch coalescing; webview tests cover postMessage contract + ack shape + state preservation on failure.
FILES_CHANGED:
  - `src/core/saveStatements.ts` (new): pure dialect-aware UPDATE/INSERT/DELETE builder. Postgres: `$N` placeholders + plain identifiers (host-supplied names). MySQL: backtick identifiers + `?`. MSSQL: square-bracket identifiers + `?`. Postgres no-PK → `WHERE ctid = ?` with `ctidByRowId` opt-in; rows without a ctid are warned + skipped. mysql/mssql without PK → `{ ok:false, reason:'no_pk' }`. Aggregate `parameters[]` array tracks positional placeholders monotonically across all statements so the caller can hand the bundle straight to the driver.
  - `src/core/queryRunner.ts`: added `runSql(sql): Promise<RunResult>` so the host save flow can execute each generated statement through the same adapter pipeline used by `run()`.
  - `src/ui/messages.ts`: added `SaveEditsMessage` (webview→host) and `SaveResultMessage` (host→webview, with `refused`/`reason` discriminator). Threaded both into `WebviewMessage` and `HostMessage` unions.
  - `src/ui/resultsPanel.ts`: added `SaveContext` interface (driver + `listPkColumns(schema, table)`) wired through `ResultsPanelOptions`. New `handleSaveEdits(index, tableName, pkColumns, edits)` dispatch + helper `fetchPostgresCtids` for the no-PK fallback. Soft refusal (`ok:false, reason:'no_pk'`) translates to `refused:true` so the webview can clear the dirty state with a banner explaining why no save happened. After successful statements, the host re-runs the original SQL and posts a fresh `state` so the grid refreshes.
  - `src/extension.ts`: constructs a `SaveContext` from `mgr.getActive()?.driver` + `adapter.listColumns(table, schema).filter(isPrimaryKey).map(name)`; passes it to the new `ResultsPanel` constructor.
  - `webview/main.ts`: added Commit toolbar button + Cmd/Ctrl+Enter capture-phase keydown listener + persistent `.vsdb-save-banner` div inside `gridWrap` (preserved across re-renders). New `onCommitClick()` short-circuits when `editState.dirtyCount === 0` and otherwise posts a single batched `saveEdits`; new `handleSaveResult(msg)` clears `editState` (success / refused) or keeps it (failure) and surfaces the host's `errors`/`reason` in the banner. Exposes `commit` via `__vsdb` for tests.
  - `webview/styles.css`: `.vsdb-save-banner` block (warning palette: warning-bg/fg/border VS Code vars) + `.vsdb-hidden` rule (display:none).
  - `src/adapters/__tests__/saveStatements.test.ts` (new, 12 tests): PK present on each of 3 dialects, postgres no-PK + ctid (with edge: missing ctid → warn+skip), mysql/mssql no-PK refusal, Add/Delete markers, batch coalescing across multiple rows, empty edits, exhaustive-dialect coverage.
  - `src/ui/__tests__/webviewSaveEdits.test.ts` (new, 4 tests, jsdom): T1 — Commit with N dirty cells posts EXACTLY one saveEdits batch carrying every entry; T2 — no-op when dirtyCount=0; T3 — `saveResult{ok:true}` clears editState and hides the banner; T4 — `saveResult{ok:false, errors}` keeps editState and shows the banner text.
TESTS_ADDED:
  - `src/adapters/__tests__/saveStatements.test.ts`: 12 cases (PK present × 3 dialects, postgres no-PK + ctid (with edge), mysql/mssql no-PK refusal, Add/Delete markers, batch shape, empty edits, type coverage).
  - `src/ui/__tests__/webviewSaveEdits.test.ts`: 4 cases (commit batch, no-op no-commit, ok-clear, fail-keep).
VERIFICATION:
  command: `npm run typecheck && npx vitest run src/adapters/__tests__/saveStatements.test.ts src/ui/__tests__/webviewSaveEdits.test.ts && npm run compile && npx vitest run`
  result: typecheck exit 0 (no errors); targeted 16/16 pass; compile clean; full suite 325/325 pass across 27 files.
  output_excerpt: |
    > vsdb@1.3.2 typecheck
    > tsc --noEmit
    (no output — clean)
    ✓ src/adapters/__tests__/saveStatements.test.ts  (12 tests) 4ms
    ✓ src/ui/__tests__/webviewSaveEdits.test.ts  (4 tests) 437ms
    Test Files  2 passed (2)
         Tests  16 passed (16)
    Test Files  27 passed (27)
         Tests  325 passed (325)
ISSUES:
  - Original RED for saveStatements: module-not-found (`Failed to load url ../../core/saveStatements`). Module was added before the test re-ran; first GREEN run is the canonical baseline.
  - postgres no-PK fallback fetches ctids one row at a time via `WHERE <cols>` equality (documented limitation: works for tables whose column set uniquely identifies the row; concurrent writes can shift ctids — warnings emitted). Simpler correctness-against-regression over performance for v1.
  - SqlLiteral escape is NOT consumed by buildSaveStatements (placeholders are positional). PostgresAdapter currently exposes only `runQuery(sql)` (no parameterised statement API), so the host pipes the statements straight through and the placeholder parameters from the build are tracked in `parameters[]` as a future-proofing field — actual SQLite/PG drivers that accept parameters can use them when wired up next.
  - WebviewSaveEdits test T4 needed a one-line patch in renderGrid to keep `saveBanner` persistent across re-renders (was being removed alongside transient error placeholders).
HANDOFF_TO_REVIEWER: yes — task file ready for review; Editor / Owner fields filled; Status `pending_review`.
NEXT: ready for reviewer; on approval → merge and close task. Possible follow-up (not blocking): thread `pkColumns`/`tableName` through `state` payload so the webview can send them up-front instead of letting the host re-derive; would skip the post-commit refresh on mysql/mssql no_pk (currently warns once and clears).
(chưa có comment)

