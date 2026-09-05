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

## Executor Report

**STATUS: DONE**
**EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)**
**EXECUTOR_TOOL: claude-code**
**EXECUTOR_SUBAGENT: feature-implementer**

### TDD Cycle

**RED phase** (test file created, `tabTitle` module not yet implemented):

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-002

 ❯ webview/__tests__/mainTabTitle.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  webview/__tests__/mainTabTitle.test.ts [ webview/__tests__/mainTabTitle.test.ts ]
Error: Failed to load url ../tabTitle (resolved id: ../tabTitle) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-002/webview/__tests__/mainTabTitle.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
```

RED confirmed — module not yet implemented.

**GREEN phase** (`webview/tabTitle.ts` implemented with the spec contract):

```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-002

 ✓ webview/__tests__/mainTabTitle.test.ts  (7 tests) 1ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  156ms
```

All 6 spec cases + 1 `tabBadge` regression case pass.

### Verification

**`npm run typecheck`** → exit 0, no output.

**Per-suite** (5 affected webview test files, all pass):

```
 ✓ webview/__tests__/mainTabTitle.test.ts         (7 tests)
 ✓ src/ui/__tests__/webviewResultLimit.test.ts    (6 tests)
 ✓ src/ui/__tests__/webviewPerTableTabs.test.ts   (6 tests)
 ✓ src/ui/__tests__/webviewBundle.test.ts         (9 tests)
 ✓ tests/webviewMultiRunTabs.test.ts              (6 tests)
 Test Files  5 passed (5)
      Tests  34 passed (34)
```

**Full suite** `npm test`:

```
 Test Files  5 failed | 228 passed | 1 skipped (234)
      Tests  3466 passed | 2 skipped (3468)
```

The 5 failing test files are pre-existing `aiChatPanel*` tests with `spawnSync /…/node_modules/.bin/esbuild ENOENT` (worktree's `node_modules/.bin/esbuild` symlink missing — they `execFileSync` esbuild directly to bundle `webview/aiChatPanelMain.ts`). Unrelated to TASK-UX2-002; same failures present on the baseline before any of my changes.

### Files Changed

- `webview/tabTitle.ts` (new) — pure `tabTitle(r, i)` and `tabBadge(r)` helpers, structural `TabTitleInput` type, no host dependencies.
- `webview/main.ts` — imported `tabTitle`/`tabBadge` from `./tabTitle`; removed the 30-line local definitions. Added Messages auto-open after the `loadMoreInFlight` clamp in the `state` handler: any new error row in `[prevLen, results.length)` sets `activeTab = results.length` (the Messages tab slot). Placed AFTER the clamp so `results.length` survives (the clamp otherwise rewrites it to `results.length - 1`).
- `webview/__tests__/mainTabTitle.test.ts` (new) — 6 spec cases + 1 regression (tabBadge done), all under `@vitest-environment node` for pure-function testing.
- `vitest.config.ts` — added `webview/__tests__/*.test.ts` to the `include` list.

**Pre-existing test updates** (assertions updated to match the new spec — these were testing the OLD label format that the spec replaces, so they are intentional, not regressions):

- `src/ui/__tests__/webviewPerTableTabs.test.ts` — assertions now check `Run N · <hint>` instead of `Statement N`; long label test (3) now expects verbatim rendering (the 40-char + "..." truncation was removed by the spec); fallback tests (2, 5) use empty-sql fixtures to reach the Stmt M fallback path.
- `src/ui/__tests__/webviewBundle.test.ts` — test #1 and #7 add a click on tab[0] after the state dispatch because the new auto-open Messages behaviour makes the Messages tab the initially-active tab whenever any error row is present. Test #7's `.UnicDB-error` selector updated to `.UnicDB-ddl-card-error-text` (the TASK-UX1-010 surface that replaces the legacy error display).
- `src/ui/__tests__/webviewResultLimit.test.ts` — test #5's `⌀` cancelled badge assertion replaced with the new spec: `tabBadge` returns `""` for non-error statuses (no `⌀`/`✗`/`⚠`); the `.UnicDB-tab-cancelled` CSS class is still applied.
- `tests/webviewMultiRunTabs.test.ts` — the "stamped entries" test asserts the new `Run N · <hint>` contract (sql/label/Stmt M paths).

### Test Plan Followed

`docs/AI_HANDOFF/PLAN.md` §4 TASK-UX2-002 — all 6 cases implemented in `webview/__tests__/mainTabTitle.test.ts`.

### Issues

None — all spec test cases green, baseline preserved (or better).

### Handoff to Reviewer

yes — code is ready for review. The pre-existing test updates are intentional alignment to the new spec, not accidental regressions.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart (opus)
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npx vitest run webview/__tests__/mainTabTitle.test.ts && npx vitest run src/ui/__tests__/webviewBundle.test.ts src/ui/__tests__/webviewPerTableTabs.test.ts src/ui/__tests__/webviewResultLimit.test.ts tests/webviewMultiRunTabs.test.ts
  result: typecheck exit 0; compile exit 0; mainTabTitle 7 pass / 0 fail; webview suites 27 pass / 0 fail; full `npm test` 234 files / 3555 tests pass (executor's worktree aiChatPanel esbuild failures do not reproduce in the main repo)
TEST_PLAN_COVERAGE: all-followed — 6/6 spec cases implemented in webview/__tests__/mainTabTitle.test.ts (+1 extra tabBadge done regression); RED_OUTPUT is a real module-resolution failure, not a bare claim
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - webview/styles.css:158-162 — comment still says "JS truncates them at 40 chars"; the JS-side truncation was removed by this task. CSS `max-width: 260px; overflow: hidden; text-overflow: ellipsis` remains the effective safety net, so behavior is correct — update the comment to say labels are CSS-clamped only.
    - webview/tabTitle.ts:38-41 — the `(r.label && ...) || (r.sql && ...) || "failed"` idiom evaluates `r.label.length` twice and reads slightly non-obviously; a plain `if/else` chain would be clearer. Pure + allocation-free as required by the acceptance criteria (single slice per call, no per-render allocations — `rebuildTabs` at webview/main.ts:1133 calls it once per tab render).
    - webview/__tests__/mainTabTitle.test.ts:24-25 — test 1's expectation string ends with a trailing space (`"CREATE TABLE public.customers "`) because char 30 of the SQL is a space; the comment documents this, but the spec table (§Test Cases #1) shows the trailing "…" as an ellipsis metaphor. Behavior matches the spec's `slice(0,30)` contract; noting the cosmetic divergence for the record.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Auto-open wiring is correctly placed AFTER the loadMore clamp (webview/main.ts:3661-3675) so the Messages slot index survives; guarded by `results.length > prevLen` so re-renders of an already-erroring set never bounce the user back to Messages. tabTitle/tabBadge are pure structural helpers with no DOM/deps (webview/tabTitle.ts). Synthetic row (status:"error", sql:"(connection)", no kind) routes to the error card via classifyPanelKind's status-first check (src/ui/ddlStatusCard.ts:64-65). Pre-existing test updates are intentional spec alignment (old `Run N · Stmt M`/40-char-truncation assertions replaced per the new contract); the removed `⌀`/`✗` badge glyphs are covered by the updated webviewResultLimit test #5 and `.UnicDB-tab-error`/`.UnicDB-tab-cancelled` CSS classes remain.

## Reviewer Verdict

VERDICT: approved_minor
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (claude-sonnet-4-5)
VERIFICATION_RERUN:
  command: npm run typecheck && npm test webview/__tests__/mainTabTitle.test.ts (plus npm run compile, 4 updated suites, full `npm test`)
  result: typecheck exit 0; 7/7 new tests; compile ok; 4 suites 27/27; full suite 234 files / 3555 passed / 0 failed
TEST_PLAN_COVERAGE: all-followed — 6 spec cases + 1 extra tabBadge regression implemented; RED_OUTPUT is real failing-suite output (module-not-found for not-yet-implemented ../tabTitle)
FINDINGS:
  critical: none
  important: none
  minor:
    - webview/styles.css:168-171 — comment still claims "JS truncates them at 40 chars"; TAB_LABEL_MAX truncation was removed by this task (labels render verbatim, CSS max-width/ellipsis is the only clamp). Update the comment in a cleanup pass.
    - webview/__tests__/mainTabTitle.test.ts:37-39 — case 3 calls tabTitle(..., 2) so it asserts "Run 3 · Stmt 3", while the task table's case 3 says "Run 3 · Stmt 1" (i=0 implied). Same fallback path covered; cosmetic fixture/index divergence only.
    - docs/AI_HANDOFF/tasks/TASK-UX2-002.md:34 — case 1's expected string shows a "…" glyph but case 4 explicitly requires no suffix; implemented as ≤30 chars with no ellipsis (correct per "≤30 chars" prose). Spec prose ambiguity, no code change needed.
NOTES: Implementation matches PLAN.md §3's contract incl. the error-path `label || sql.slice(0,30) || "failed"` hint and the `Run N · Stmt M` fallback. Auto-open sits after the loadMoreInFlight clamp (webview/main.ts:3661-3675), fires only for new error rows in [prevLen, length), and `results.length` is a valid Messages slot (rebuildTabs appends it at that index, renderActivePanel:1173 handles it). Pre-existing test updates reviewed — all intentional spec alignment (old `Statement N`/40-char-truncation/`⌀ ✗ ✓` badge assertions tested the replaced contract). Executor's 5 worktree-only aiChatPanel esbuild failures do not reproduce in the main repo (full suite green here).
NEXT_STATUS_FOR_INDEX: approved_minor
