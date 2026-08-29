# TASK-AHL-003 — Sessions/Locks panel + kill/terminate confirm

## Goal

Add a focused webview panel listing Postgres sessions (pg_stat_activity) and lock waits (pg_locks blocked → blocking chains). Per-row buttons Kill (cancel the running query via `pg_cancel_backend($pid)`) and Terminate (drop the connection via `pg_terminate_backend($pid)`), each behind a destructive confirm modal. Self-protection: pids matching `pg_backend_pid()` (the active VSDB connection) are rendered with a "(self)" badge and disabled buttons.

## Target Files

- `src/ui/adminSessionsPanel.ts` — NEW. `AdminSessionsPanel` webview panel class. HTML harness generated via the existing `buildHtml` pattern (CSP-clean). Two tabs: Sessions, Locks. Refresh button calls `admin.listSessions()` / `admin.listLockWaits()`. Sort by duration desc on Sessions; chained pid grouping on Locks. Self-pid detection via `SELECT pg_backend_pid()` on panel open (cached). CSP stays the same as existing webviews; no inline handlers.
- `src/ui/__tests__/adminSessionsPanel.test.ts` — NEW. Mock `getHtmlForWebview`, `postMessage`; fake AdminApi; assert:
  - Sessions tab populates with columns + rows.
  - Locks tab renders chains.
  - Kill button → confirm modal → `pg_cancel_backend($pid)` SQL built and run via dedicated client.
  - Terminate button → confirm modal (stricter copy) → `pg_terminate_backend($pid)`.
  - Self-pid: buttons disabled + "(self)" badge.
  - Insufficient privilege → error panel w/ 42501.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (panel) | Sessions tab populates rows from `admin.listSessions()` | table rows match fixture | fake listSessions → 3 rows |
| 2 | unit (panel) | Locks tab renders blocked → blocking chains | grouped rows | fake listLockWaits → 2 chains |
| 3 | edge (panel) | self-pid detected → buttons disabled + "(self)" badge | DOM contains "(self)" and buttons are `disabled` | pg_backend_pid() == pid 1234 |
| 4 | edge (kill) | Kill (cancel) → confirm modal → `pg_cancel_backend($pid)` SQL fires on dedicated connection | spy sees `pg_cancel_backend` | pid 9999 |
| 5 | edge (terminate) | Terminate → confirm modal → `pg_terminate_backend($pid)` fires | spy sees `pg_terminate_backend` | pid 9999 |
| 6 | edge (panel) | deny on confirm modal → no SQL runs | spy `runSql` count 0 | modal returns false |
| 7 | edge (panel) | insufficient privilege on the SELECT → error panel w/ 42501 | panel renders error node carrying the code | fake admin throws |
| 8 | regression | existing webview tests stay green | n/a | n/a |

## Test Files

- `src/ui/__tests__/adminSessionsPanel.test.ts` — tests 1–7.
- Existing `tests/webview*.test.ts` remain green (test 8).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/adminSessionsPanel.test.ts tests/webviewEditHighlight.test.ts tests/webviewRequeryAlignment.test.ts tests/webviewUndoRedo.test.ts
npm run typecheck
npm test
npm run compile
```

## Acceptance Criteria

- [ ] All 8 tests pass (RED first, GREEN after).
- [ ] Self-pid detection works against the actual session (via `SELECT pg_backend_pid()`), not a stub.
- [ ] Kill cancels only the running query; Terminate drops the connection.
- [ ] Confirm modals are modal (`{modal:true}`); deny = no SQL.
- [ ] No apiKey / password bytes in the webview HTML or messages.
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.

## Dependencies

- TASK-AHL-001 (uses `AdminApi`).

## Interfaces

- Consumes: `AdminApi` from TASK-AHL-001; existing `vscode.window.showWarningMessage` modal flow.
- Produces: `vscode.window.createWebviewPanel("vsdb.adminSessions", ...)` (id declared in `package.json` — wired by TASK-AHL-004). Messages handled by the panel webview; no new host messages in TASK-AHL-003 scope.

---

## Executor Report (added in handoff-fullstack wrap-up)

- Status: PASS
- EXECUTOR_TOOL: bash (git show + vitest rerun)
- EXECUTOR_MODEL: unic-code
- EXECUTOR_SUBAGENT: - (in-session wrap)
- RED_OUTPUT: Wave 2 was implemented earlier in commit cc7fdbe; this session re-verified. `npx vitest run src/ui/__tests__/adminSessionsPanel.test.ts` → `✓ 10 tests passed (3ms)`. Earlier session recorded full RED→GREEN for the 8 cases listed in §Test Cases.
- VERIFICATION_OUTPUT: `npm test` → `Test Files 145 passed | 1 skipped (146) / Tests 2133 passed | 2 skipped (2135)`; `npm run typecheck` exit 0; `npm run compile` clean.
- Note: Implementation already shipped in commit `cc7fdbe` alongside AHL-002. Self-pid detection via `SELECT pg_backend_pid()` is real (not stubbed) and surfaces "(self)" badge + disabled buttons. CSP-clean webview HTML. No apiKey/password bytes in any panel surface.
