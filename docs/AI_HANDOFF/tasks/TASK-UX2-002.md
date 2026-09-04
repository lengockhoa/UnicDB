# TASK-UX2-002 — Tab labels + Messages auto-open (webview side)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Fix the webview-side `tabTitle(r, i)` so failed tabs show the offending statement
or table name, not the generic `Run N · Stmt M`. Add a `tabBadge(r)` for the
red ⚠ marker on error tabs. Auto-open the Messages tab when any error row is
rendered. Render the error card body for the synthetic-tab case (no `kind`,
`status === "error"`, `sql === "(connection)"`).

This task is webview-only — the host-side producer
(`QueryRunner.runFailed`) and the status-bar error badge live in TASK-UX2-003.

## Target Files

- `webview/main.ts` — fix `tabTitle(r, i)` (currently `webview/main.ts:1142-1144`
  always returns `Run N · Stmt M`); add `tabBadge(r)` (currently
  `webview/main.ts:`-area around 1142-1160). When a run finishes with
  `status === "error"` for any statement, switch the active tab to Messages and
  reveal the panel if hidden. Render the error card body for the synthetic-tab
  case.
- `webview/__tests__/mainTabTitle.test.ts` — new test file (6 cases) under the
  webview harness.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `tabTitle({runNo:1, sql:"CREATE TABLE public.customers (id int)"})` returns `"Run 1 · CREATE TABLE public.customers…"` (≤30 chars of SQL) | match | single-statement failed run |
| 2 | unit | `tabTitle({runNo:2, label:"public.users"})` returns `"Run 2 · public.users"` | match | label preset by host |
| 3 | edge | `tabTitle({runNo:3, sql:""})` falls back to `"Run 3 · Stmt 1"` | match | empty sql, no label |
| 4 | edge | `tabTitle({runNo:4, sql:"a".repeat(200)})` truncates to 30 chars + no overflow | match | very long SQL |
| 5 | regression | `tabTitle({runNo:5, sql:"SELECT 1", status:"done"})` returns `"Run 5 · SELECT 1"` (readable, not truncated) | match | healthy SELECT |
| 6 | unit | `tabBadge({status:"error"})` returns `"⚠ "`, `tabBadge({status:"done"})` returns `""` | match | error vs done |

## Test Files

- `webview/__tests__/mainTabTitle.test.ts` (new, 6 cases).

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test webview/__tests__/mainTabTitle.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (6/6).
- [ ] Tab labels with non-empty `r.label` show the label (e.g. `public.users`).
- [ ] Tab labels with non-empty `r.sql` show the first 30 chars of SQL.
- [ ] Tab labels with `status === "error"` are prefixed with the ⚠ marker via
      `tabBadge`.
- [ ] Empty `r.sql` + no `r.label` falls back to `Run N · Stmt M` (legacy
      behaviour preserved).
- [ ] Healthy SELECT path is byte-identical for the read-only case.
- [ ] No regression in existing webview suites.
- [ ] Label is computed once per render, not per re-render (no extra
      allocations in the hot loop).

## Dependencies

- TASK-UX2-001 (the render primitive must accept the synthetic row's
  `kind: undefined + status: "error"` shape before the webview can render the
  error card body).

## Interfaces

- Consumes:
  - `BuildCardOutput` with `kind: "connection-error"` (from TASK-UX2-001) —
    the webview renders the same error card DOM for the synthetic row.
- Produces:
  - `tabTitle(r: StatementResult, i: number): string` (in-place replacement of
    `webview/main.ts:1142-1144`).
  - `tabBadge(r: StatementResult): string` (new helper, returns `"⚠ "` on error
    or `""` otherwise).

---

## Discussion

(no comments yet)
