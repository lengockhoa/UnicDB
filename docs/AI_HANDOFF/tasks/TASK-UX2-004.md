# TASK-UX2-004 — End-to-end integration of error visibility

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Wire TASK-UX2-001 + TASK-UX2-002 + TASK-UX2-003 together. Verify the user-visible
reproducers (failed connection, failed SQL, tab labels) end-to-end. This is the
host-side integration scaffold — the webview integration is covered by
TASK-UX2-002's `webview/__tests__/mainTabTitle.test.ts`.

The integration specifically tests the **two distinct error paths**:
- **First-connect failure**: adapterProvider rejects → executeAll outer catch
  fires → `extension.ts:2595` calls `runner.runFailed(reason)` → onUpdate
  fires → panel renders synthetic tab.
- **Post-connect runQuery failure**: executeAll catches inside
  (`queryRunner.ts:456-475`) → per-statement error row → onUpdate fires →
  panel renders error card (NOT empty grid) — this only works because
  TASK-UX2-001's `classifyPanelKind` fix routes SELECT+error to the card.

## Target Files

- `src/extension.ts:2595` — `runStatements` outer-catch on first-connect
  failure now calls `runner.runFailed(reason)` instead of dropping a toast.
  (Post-connect runQuery errors need no outer-catch change — they reach the
  panel through the existing executeAll path.) On the next healthy `run()`,
  call `statusBar.setErrorBadge(null)` to clear the badge.
- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` — new file with the 4
  integration cases from PLAN §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | integration | first-connect failure → outer catch in `runStatements` calls `runner.runFailed(reason)` → onUpdate fires → panel renders synthetic tab | end-to-end match | mock adapter that throws on `getAdapter` resolve |
| 2 | integration | post-connect runQuery error → per-statement error row reaches `onUpdate` → panel renders error card (NOT empty grid) | match | mock adapter returning pg error on `runQuery` |
| 3 | integration | status bar error badge set on first error, cleared on next healthy `run` (via `setErrorBadge(null)`) | cleared | after step 1, then healthy run |
| 4 | regression | successful SELECT still renders the grid; no error card | grid path | healthy adapter |

## Test Files

- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (new, 4 cases).

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (4/4).
- [ ] Full test suite green (baseline 3530|2 or better).
- [ ] Screenshot reproducer (failed connection) now shows the synthetic tab
      with `Run N · Connection failed…` title, error card body, Messages
      auto-opened, status bar red badge.
- [ ] Screenshot reproducer (failed SELECT) now shows the error card in the
      tab with `Run N · <first 30 chars of SQL>` title.
- [ ] Tab labels are unique and informative — every tab with non-empty SQL or
      `r.label` shows the statement/table hint, not just `Stmt M`.
- [ ] `extension.ts` change is additive — no existing path is restructured.
- [ ] Status bar error badge is set on first error AND cleared on next
      healthy `run()`.

## Dependencies

- TASK-UX2-001, TASK-UX2-002, TASK-UX2-003 (all must be merged before this task
  runs).

## Interfaces

- Consumes:
  - `QueryRunner.runFailed(reason: string): void` (TASK-UX2-003)
  - `createStatusBar(mgr).setErrorBadge(reason: string | null)` (TASK-UX2-003)
  - `tabTitle` / `tabBadge` (TASK-UX2-002) — used by the webview to render the
    correct tab title; integration asserts the host emits the right
    `StatementResult` shape that the webview can render.
- Produces:
  - Wired `runStatements` first-connect-error path that flows through the
    entire error surface (host + webview + status bar).

---

## Discussion

(no comments yet)
