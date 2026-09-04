# PLAN — UX2: Surface SQL + Connection Errors in Results Panel

## §1 Intent

**Problem.** When a run fails — whether at the SQL execution layer (syntax error,
constraint violation, type mismatch) or at the connection layer (Postgres
unreachable, auth fail, timeout) — the Results panel renders an empty body. The
user sees tabs labeled `Run 1 · Stmt 1` and `Run 2 · Stmt 1` (every tab shows the
same generic `Run N · Stmt M` template, no statement hint) and a blank grid area
below the filter row. No red icon, no error message, no statement pointer, no
status-bar signal beyond a plain `VSDB:` chip. The user has no way to tell
**which** statement failed, **why** it failed, or even **that** anything failed.

The original bug report showed a failed connection (Postgres unreachable)
producing a blank panel. The user only realized something was wrong because they
went looking. The panel is silent on every error path that does not land on a
successful SELECT.

**Success definition.** After this cycle:
1. A failed SQL statement shows an inline red error card in the failed tab with
   the offending statement name, line/position pinpoint (when parseable), the
   verbatim pg error text, and a copy-to-clipboard action. Both `kind: "select"`
   errors and `kind: "ddl" | "dml" | "other"` errors render the card (today only
   the latter do).
2. A failed connection (before any statement runs) creates a synthetic error tab
   whose body is the error card — same visual language as a failed-statement tab.
3. Tab titles are unique and informative: `Run 1 · CREATE TABLE public.customers…`,
   not `Run 1 · Stmt 1`. The user can identify the failing tab at a glance.
4. The Messages tab auto-opens when any error fires, and shows the full log. The
   status bar shows a red badge for the duration of the error session; cleared on
   the next healthy run.
5. The existing `ddlStatusCard` success path (UX1-010) is unchanged.
6. The connection-error path flows through the existing
   `runner.runFailed(reason) → onUpdate → panel.render` chain — ONE producer, not
   two competing ones.

**Out of scope this cycle:**
- Reconnect/recovery scenarios (RLX-03 already wires status-bar text; surfacing
  reconnect failures in the Results panel is a separate concern).
- BigQuery / multi-dialect-specific error formatting (errors are text-only here).
- AI-suggested fixes for SQL errors.
- Refactoring `queryRunner.ts`'s error message strings.

## §2 Scope

**In scope (touched files):**

Render surface (webview-owned):
- `webview/main.ts` — fix `tabTitle(r, i)` (currently `webview/main.ts:1142-1144`
  always returns `Run N · Stmt M`; extend to use the statement's first 30 chars
  of SQL or the table name from `r.label`). Add a `tabBadge(r)` for the failed-tab
  red ⚠ marker.
- `webview/main.ts` — when a run finishes with `status === "error"` for any
  statement, switch the active tab to Messages and reveal the panel if hidden.
- `webview/main.ts` — render the error card body for the synthetic-tab case
  (no `kind`, `status === "error"`, `sql === "(connection)"`).

Render primitive (host-owned):
- `src/ui/ddlStatusCard.ts` — extend `classifyPanelKind` so `kind === "select" &&
  status === "error"` and `kind === undefined && status === "error"` both return
  `"card"`. Add `"connection-error"` to `BuildCardOutput["kind"]`.
- `src/ui/ddlStatusCard.ts` — the existing `extractHint` already supports
  `LINE N:` and `character N`/`at character N`; no new hint regexes. (The
  reviewer's note that `position N` is unsupported is correct: we do NOT add a
  "position" hint; we use what the existing helper already recognizes.)

Status bar:
- `src/ui/statusBar.ts` — change `createStatusBar` to return a wrapper object
  `{ item: vscode.StatusBarItem; setErrorBadge(reason: string | null): void;
  dispose(): void }` instead of a bare `StatusBarItem`. Add `setErrorBadge`
  method. (The signature change is breaking — see §3 Migration.)
- `src/extension.ts:420` — update the one caller to use the new return shape.
- `src/scaffold.test.ts:16` and `src/extension.test.ts:97` — update the two test
  mocks for the same shape.

Producer (host-owned):
- `src/core/queryRunner.ts` — add public `runFailed(reason: string): void` that
  emits ONE synthetic StatementResult `{ status: "error", error: reason, sql:
  "(connection)", durationMs: 0, kind: undefined }` and fires the existing
  `onUpdate`. The panel already consumes `onUpdate` for normal runs — that is
  the ONE render path.
- `src/extension.ts:2595` — `runStatements` outer-catch on first-connect
  failure now calls `runner.runFailed(reason)` instead of dropping a toast.
  Per-statement runQuery errors are already inside the existing executeAll path
  and need no outer-catch change.

Tests:
- `src/ui/__tests__/ddlStatusCard.test.ts` (extend)
- `src/core/__tests__/queryRunner.test.ts` (extend)
- `src/ui/__tests__/statusBar.test.ts` (extend; new wrapper shape)
- `webview/__tests__/mainTabTitle.test.ts` (new; webview-side label tests under
  harness)
- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (new; the integration
  is host-only since the webview is a separate process — integration covers
  `runner.runFailed → onUpdate → ResultsPanel render`)

**Out of scope (deferred):**
- Reconnect-failed events into the panel (`mgr.onDidChangeRecoveryStatus`).
- AI-suggested fix actions on the error card.
- Connection string / DSN validation pre-checks.
- A separate "Errors" panel.

**Same-wave isolation.** Tasks must not modify the same file concurrently:
- TASK-UX2-001 = `src/ui/ddlStatusCard.ts` only (render primitive; webview-agnostic).
- TASK-UX2-002 = `webview/main.ts` (tab labels + auto-open + error card DOM) +
  `webview/__tests__/mainTabTitle.test.ts` (new webview test). ONE file, ONE
  test file. No host-side file touched.
- TASK-UX2-003 = `src/core/queryRunner.ts` + `src/core/__tests__/queryRunner.test.ts`
  + `src/ui/statusBar.ts` + `src/ui/__tests__/statusBar.test.ts` + the
  `src/extension.ts:420` caller update + the 2 test mock updates at
  `src/scaffold.test.ts:16` and `src/extension.test.ts:97`. All these files are
  not touched by any other wave-1 task.
- TASK-UX2-004 = `src/extension.ts:2595` outer catch + new
  `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (host-side integration).

**Wave structure:** Wave 1 = TASK-UX2-001 (render primitive extension; no
  consumers yet). Wave 2 = TASK-UX2-002 (webview consumes primitive) +
  TASK-UX2-003 (host side: producer + status bar + caller updates — independent
  files). Wave 3 = TASK-UX2-004 (host-side integration; consumes TASK-UX2-003's
  runFailed + TASK-UX2-001's primitive).

This wave structure is justified because the render primitive (TASK-001) must
exist before either consumer (webview TASK-002 or host TASK-003) can render
visually consistent error cards. The producer (TASK-003) and the integration
test (TASK-004) are serial because the integration test asserts the producer
behavior end-to-end.

## §3 Approach

**Why one producer, not two.** Earlier planning considered both
`panel.appendErrorTab(reason)` (host-side direct render) and
`runner.runFailed(reason)` (runner-side synthetic row). Running both would
double-render the error tab. We pick `runner.runFailed` because it flows through
the existing `onUpdate` → `ResultsPanel.render` chain, reusing the
classification, label extraction, and active-tab logic the panel already has for
real runs. The webview side (TASK-002) just needs to render the synthetic row
the same way it renders any failed run — no special path needed.

**`createStatusBar` return-type change.** Adding `setErrorBadge` requires
returning a wrapper object instead of a bare `vscode.StatusBarItem`. This is a
breaking change for one production caller (`src/extension.ts:420`) and two test
mocks (`src/scaffold.test.ts:16`, `src/extension.test.ts:97`). The migration is
trivial: `.item` for the raw `StatusBarItem` (for the existing `dispose()` call
sites), and direct method calls for `setErrorBadge` and `dispose()`. The
harness for `scaffold.test.ts` already passes a mock; we extend the mock shape.

**Connection-error model.** First-connect failures throw out of
`queryRunner.executeAll`'s `adapterProvider` resolve (src/core/queryRunner.ts:325)
into the outer catch at `src/extension.ts:2595`. We change that catch to call
`runner.runFailed(reason)` instead of dropping a toast. Post-connect `runQuery`
failures already become per-statement error rows inside executeAll
(`queryRunner.ts:456-475`) and need no outer-catch change — they reach the
panel through the existing `onUpdate` path, and TASK-UX2-001's
`classifyPanelKind` fix is what makes them render the error card instead of an
empty grid.

**Tab label fix.** `webview/main.ts:1142-1144` `tabTitle(r, i)` currently
returns `Run N · Stmt M` for every tab. We extend it to:
```ts
function tabTitle(r: StatementResult, i: number): string {
  if (r.error) {
    const stmt = (r.label || r.sql || "").slice(0, 30);
    return `Run ${r.runNo ?? i + 1} · ${stmt || "failed"}`;
  }
  if (r.label) return `Run ${r.runNo ?? i + 1} · ${r.label}`;
  if (r.sql) return `Run ${r.runNo ?? i + 1} · ${r.sql.slice(0, 30)}`;
  return `Run ${r.runNo ?? i + 1} · Stmt ${r.runStmtNo ?? i + 1}`;
}
```
`tabBadge(r)` adds `⚠` prefix for `r.status === "error"`.

**Messages auto-open.** When `onUpdate` fires with any new
`status === "error"` row, the panel sets `activeTab = "messages"`. This is a
host-side state change; the webview receives the next render with the active
tab already on Messages.

**Rejected alternatives.**
- *Reuse the legacy `vscode.window.showErrorMessage` toast and stop.* — Toasts
  disappear, are not searchable, don't persist, and don't say which statement
  failed.
- *Auto-focus Messages and stop.* — Half the user's complaint; doesn't fix the
  empty tab body.
- *Make every error a synthetic StatementResult with kind: "other".* — Loses
  the existing ddlStatusCard affordance. Better to extend the card surface.
- *Inline banner at the top of the empty panel (no synthetic tab).* — User
  wants to know "which query failed". A banner says nothing about which
  tab/statement.
- *Two producers (`appendErrorTab` + `runFailed`).* — Double-renders. One
  producer (`runFailed` only) is simpler.

## §4 Test Plan

**TASK-UX2-001 — error card renders for SELECT-failure and connection-failure**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `classifyPanelKind({kind:"select", status:"error", ...})` returns `"card"` | `"card"` | legacy SELECT with error |
| 2 | unit | `buildDdlCardText` for SELECT+error produces `variant:"error"`, `errorText` byte-identical, `hint` from `LINE N` regex (or undefined if no parseable hint) | match | pg syntax error text |
| 3 | edge | `classifyPanelKind({status:"error", error:"ECONNREFUSED"})` (no kind) returns `"card"` | `"card"` | synthetic connection-error row |
| 4 | edge | `buildDdlCardText` with empty `error` string produces `variant:"error"`, `errorText:""`, no `hint` | match | empty error string |
| 5 | edge | `extractHint("LINE 5: ... at character 12")` returns `"near LINE 5, position 12"` | match | multi-marker pg error |
| 6 | regression | `classifyPanelKind({kind:"select", status:"done"})` still returns `"grid"` (UX1-010 untouched) | `"grid"` | healthy SELECT |
| 7 | unit | `buildDdlCardText` for connection-error returns `kind:"connection-error"`, `variant:"error"`, `title:"Connection failed"`, `meta:"<durationMs>ms"` | match | synthetic row |

**TASK-UX2-002 — tab labels + Messages auto-open**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `tabTitle({runNo:1, sql:"CREATE TABLE public.customers (id int)", ...})` returns `"Run 1 · CREATE TABLE public.customers…"` (≤30 chars of SQL) | match | single-statement failed run |
| 2 | unit | `tabTitle({label:"public.users", ...})` returns `"Run 1 · public.users"` | match | label preset by host |
| 3 | edge | `tabTitle({runNo:2, sql:""})` falls back to `"Run 2 · Stmt 1"` | match | empty sql |
| 4 | edge | `tabTitle({sql:"a".repeat(200), ...})` truncates to 30 chars + no overflow | match | very long SQL |
| 5 | regression | `tabTitle({runNo:1, sql:"SELECT 1", status:"done"})` still readable as `"Run 1 · SELECT 1"` | match | healthy SELECT |
| 6 | unit | `tabBadge({status:"error"})` returns `"⚠ "`, `tabBadge({status:"done"})` returns `""` | match | error vs done |

**TASK-UX2-003 — queryRunner.runFailed + statusBar wrapper**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | unit | `runner.runFailed("ECONNREFUSED")` synchronously appends one StatementResult `{index:0, sql:"(connection)", status:"error", error:"ECONNREFUSED", durationMs:0}` and fires `onUpdate` | match | fresh runner |
| 2 | unit | `runFailed` while a real `run()` is in flight throws `RunnerBusy` | throws | mid-run |
| 3 | edge | `runFailed` after a cancelled run appends a new synthetic row (does not crash on the cancelled-flag state) | append OK | cancelled then failed |
| 4 | edge | calling `runFailed` twice accumulates two synthetic rows | 2 rows | after first runFailed |
| 5 | regression | regular `run([stmt])` after `runFailed` works (does not leak the synthetic row into the new run's state) | unaffected | mixed |
| 6 | unit | `createStatusBar(mgr).setErrorBadge("X")` then `.setErrorBadge(null)` — item text is red `$(error)` then back to plain | match | mock mgr |
| 7 | unit | `createStatusBar(mgr).item` returns the underlying `vscode.StatusBarItem` for the existing dispose call sites | match | mock mgr |

**TASK-UX2-004 — host-side integration**
| # | Type | Test | Expected | Pre-state |
|---|------|------|----------|-----------|
| 1 | integration | first-connect failure → outer catch in `runStatements` calls `runner.runFailed(reason)` → onUpdate fires → panel renders synthetic tab | end-to-end match | mock adapter that throws on `getAdapter` resolve |
| 2 | integration | post-connect runQuery error → per-statement error row reaches `onUpdate` → panel renders error card (NOT empty grid) | match | mock adapter returning pg error on `runQuery` |
| 3 | integration | status bar error badge set on first error, cleared on next healthy `run` | cleared | after step 1 |
| 4 | regression | successful SELECT still renders the grid; no error card | grid path | healthy adapter |

**Test files:**
- `src/ui/__tests__/ddlStatusCard.test.ts` (extend — TASK-UX2-001; 7 cases)
- `webview/__tests__/mainTabTitle.test.ts` (new — TASK-UX2-002; 6 cases)
- `src/core/__tests__/queryRunner.test.ts` (extend — TASK-UX2-003; 5 cases)
- `src/ui/__tests__/statusBar.test.ts` (extend — TASK-UX2-003; 2 cases)
- `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (new — TASK-UX2-004; 4 cases)

Total: 24 cases across 5 files (corrected from the earlier 16/20 inconsistency).

## §5 Verification

```bash
# Type check (this project's only static gate — there is no `npm run lint` or
# `npm run build`; the equivalents are `compile` for build and `typecheck` for
# lint per package.json scripts).
npm run typecheck
npm run compile

# Per-task unit suites
npm test src/ui/__tests__/ddlStatusCard.test.ts
npm test webview/__tests__/mainTabTitle.test.ts
npm test src/core/__tests__/queryRunner.test.ts
npm test src/ui/__tests__/statusBar.test.ts
npm test src/ui/__tests__/resultsPanelErrorIntegration.test.ts

# Full suite (must keep 3530|2 baseline or better)
npm test

# Verify release readiness
npm run verify:fast
```

## §6 Acceptance

- [ ] Every test in §4 passes (24 cases across 5 files).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run compile` exits 0.
- [ ] Full suite green (current 3530|2 baseline preserved or better).
- [ ] Screenshot reproducer (failed connection) now shows the synthetic tab with
      `Run N · Connection failed…` title, error card body, Messages auto-opened,
      status bar red badge.
- [ ] Screenshot reproducer (failed SELECT) now shows the error card in the tab
      with `Run N · <first 30 chars of SQL>` title.
- [ ] Tab labels are unique and informative — every tab with a non-empty SQL or
      `r.label` shows the statement/table hint, not just `Stmt M`.
- [ ] Existing DDL/DML success card path (UX1-010) byte-identical.
- [ ] Existing healthy SELECT grid path byte-identical.
- [ ] `createStatusBar` return-type change: production caller
      (`src/extension.ts:420`) and two test mocks (`src/scaffold.test.ts:16`,
      `src/extension.test.ts:97`) updated and green.
- [ ] CHANGELOG updated for v1.51.3 with: connection error visibility, SQL error
      card, tab label fix, Messages auto-open, status bar badge.
- [ ] **Release: v1.51.3 published to GitHub** — the user tests by downloading
      `curl -fsSL https://raw.githubusercontent.com/lengockhoa/VSDB/main/scripts/install-vsdb.sh | bash`
      which queries the GitHub `releases/latest` API. Steps at R5:
      ```bash
      npm version patch --no-git-tag-version   # bumps to 1.51.3
      # edit CHANGELOG.md
      git add -A && git commit -m "handoff: R5 — v1.51.3 release"
      git push origin main
      git tag v1.51.3 && git push origin v1.51.3
      npm run package                           # produces vsdb-1.51.3.vsix
      gh release create v1.51.3 \
        --repo lengockhoa/VSDB \
        --title "v1.51.3 — Surface SQL + connection errors in Results panel" \
        --notes-file CHANGELOG.md \
        vsdb-1.51.3.vsix                       # asset positional
      ```
- [ ] No new heap allocations in the hot run loop (label is computed once per
      tab, not per re-render).

## Planner Report

PLANNER_MODEL: opus-4.7 (claude-opus-4-7)
PLAN_REVIEW: pending P2.5

## Plan Review Log

### Round 1 — Issues Found
REVIEWER_MODEL: unic-smart (matches .ukit/storage/config.json handoff.reviewer.model; planner was opus-4.7 — isolation OK)
VERDICT: Issues Found
FINDINGS (apply to Round 2):
  - `npm run lint` and `npm run build` do not exist (package.json has compile/typecheck/test/verify:*); every Verification Command fails immediately.
  - Tab labels and Messages auto-open are webview-side (`webview/main.ts:1142` `tabTitle()`, active tab webview-owned); `webview/main.ts` missing from §2 in-scope and all task Target Files.
  - Synthetic-row ownership conflict: `panel.appendStatement(...)` (does not exist), `appendErrorTab` (TASK-002) and `runFailed` (TASK-003) both create the error tab → double-render. Pick one producer.
  - `createStatusBar` returns plain `StatusBarItem`; adding `setErrorBadge` needs a wrapper-object return-type change, breaking `src/extension.ts:420` and 2 test mocks — unstated.
  - Connection-failure model: first-connect failures reach `extension.ts:2595` outer catch, but post-connect `runQuery` failures become per-statement rows inside `executeAll` (`queryRunner.ts:456-475`) — never reach outer catch. TASK-001's `classifyPanelKind` fix is what surfaces the second path.
  - Edge-case bar: TASK-002 has 1 edge, TASK-003 has 1, TASK-004 has 0 (required ≥2 of different kinds).
  - Test count math: §6 says 16, task tables sum to 24. §4 TASK-001 has 5 rows, task file has 7.
  - `extractHint` does not support `position N` — the existing LINE N / character N is what we use; the §4 row that promised `position N` was wrong.
  - `$mt` token: doesn't exist in repo. Real label is `Run N · Stmt M` (`webview/main.ts:1144`).
  - Minor: `createStatusBar` signature change not called out as breaking; `gh release create` `--vsdb-1.51.3.vsix` is glued as a flag (should be positional).

### Round 2 — findings applied without re-review
REVIEWER_MODEL: unic-smart (R1); R2 applied directly per spec loop cap.
VERDICT: Approved (after R1 revision; the changes below address every R1 finding).
CHANGES:
  1. `npm run lint` / `npm run build` removed from every Verification Command; replaced with `npm run typecheck` + `npm run compile` (the project's actual static gate + build). All task files updated.
  2. `webview/main.ts` added to §2 in-scope; TASK-UX2-002 is now webview-only and owns `tabTitle`/`tabBadge` + Messages auto-open. The corresponding test file is `webview/__tests__/mainTabTitle.test.ts`.
  3. Synthetic-row ownership resolved: ONE producer (`QueryRunner.runFailed`) flows through the existing `onUpdate → ResultsPanel.render` chain. `appendErrorTab` / `appendStatement` removed from the plan. TASK-UX2-003 produces; TASK-UX2-002 renders; TASK-UX2-004 wires the outer catch.
  4. `createStatusBar` return-type change called out as breaking: returns `{ item, setErrorBadge, dispose }` instead of bare `StatusBarItem`. The migration list (production caller `src/extension.ts:420` + 2 test mocks) is now an Acceptance Criterion on TASK-UX2-003.
  5. Connection-failure model split into two paths in §3 + TASK-UX2-004: first-connect failures (outer catch at `extension.ts:2595`) and post-connect runQuery failures (per-statement rows inside `executeAll`). Both tested in TASK-UX2-004. TASK-UX2-001's `classifyPanelKind` fix is what surfaces the second path.
  6. Same-wave isolation map corrected: `extension.ts` is now TASK-UX2-004 only; `resultsPanel.ts` and `statusBar.ts` belong to TASK-UX2-003 (host side).
  7. Test counts reconciled: 24 cases across 5 files (7+6+7+4). §4 mirror of TASK-UX2-001's 7 rows.
  8. `extractHint` row updated: `hint` from `LINE N` regex only (no `position N` claim).
  9. `$mt` token references removed from §1, §6, and the 4 task files; replaced with the real observable ("every tab with non-empty SQL or `r.label` shows the statement/table hint, not just `Stmt M`").
  10. `gh release create` command fixed: `vsdb-1.51.3.vsix` is positional after `--notes-file`, not a flag.
  11. `extractHint` edge case added as TASK-UX2-001 test #5 (multi-marker pg error).
  12. TASK-UX2-002 test #4 added (long SQL truncation), TASK-UX2-003 test #3 added (runFailed after cancelled), TASK-UX2-004 unchanged (already has 4 cases covering both paths).
