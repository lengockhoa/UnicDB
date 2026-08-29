# TASK-AF-004 — SQL Console v2: tabs, per-statement run, history, EXPLAIN, Format

- Status: `done`
- Owner: `ExecAF004 (unic-code)`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_AF.md` §7 (Approach §3)

## Goal

Upgrade the single-instance SQL Console into a multi-tab console: named tabs with host-side state, per-statement and selection-only run, query history (up-arrow recall + persisted list capped at 200), an EXPLAIN / EXPLAIN ANALYZE plan pane (ANALYZE behind the existing destructive-confirm gate), and a Format button consuming `formatSql`.

## Target Files

- `src/ui/consolePanel.ts` — tab registry (create/close/rename/switch, buffers host-side), message handlers for `runStatement`/`runSelection`/`explain`/`format`/`history*`, history persistence in Memento (cap 200).
- `webview/consolePanelMain.ts` — tab bar UI, history recall keybinding (ArrowUp/ArrowDown in editor when no selection), plan pane rendering, Format button → host round-trip.
- `webview/styles.css` — tab bar + plan pane styles (only this file for styles).
- `src/extension.ts` — console open/create-tab command registration adjustments (wave-3 owner of this file).
- `src/ui/__tests__/consoleTabs.test.ts` — NEW (host-side tab registry + history).
- `tests/consolePanelWebview.test.ts` — EXTEND (jsdom bundle-eval: tab switching, history recall, format round-trip message, plan pane render).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | create/switch/close tabs keeps buffers isolated | typing in tab A does not leak into tab B; closing active tab activates neighbor | registry with 3 tabs |
| 2 | edge | close last tab → fresh empty tab, no crash | registry always ≥1 tab | single-tab registry |
| 3 | unit | runStatement executes only the statement at cursor | `splitStatements` output index N runs alone (spy on runner) | 3-statement buffer, cursor in #2 |
| 4 | unit | runSelection sends exactly the selection text | runner receives selection bytes verbatim | editor selection fixture |
| 5 | unit | history: successful run appends; recall cycles up-arrow/down-arrow | last-first ordering, recall index wraps at ends | history `[A,B,C]` |
| 6 | edge | history capped at 200 | 201st entry evicts oldest | seeded 200 entries + 1 |
| 7 | edge | history persists across panel reload via Memento | re-opened panel restores list | seeded Memento |
| 8 | unit | EXPLAIN runs plan query (no ANALYZE) without confirm | plan text reaches plan pane message | SELECT input |
| 9 | edge | EXPLAIN ANALYZE requires destructive confirm | confirm modal fires first; deny → no execution | `EXPLAIN ANALYZE SELECT …` |
| 10 | unit | Format round-trip replaces buffer via formatSql | webview `format` message → host calls `formatSql` → buffer replaced | multi-clause SELECT |
| 11 | edge | Format on empty buffer is a no-op | no message error, buffer unchanged | empty buffer |
| 12 | regression | existing console suites stay green | current console host/webview tests pass | existing tests |

## Test Files

- `src/ui/__tests__/consoleTabs.test.ts` — tests 1–3, 5–9 (host side).
- `tests/consolePanelWebview.test.ts` — tests 4, 10–12 (jsdom webview behavior).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consoleTabs.test.ts tests/consolePanelWebview.test.ts
npm run typecheck
npm test
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first, GREEN after).
- [ ] Multi-tab state survives panel close/reopen within a session (host-side buffers + Memento history).
- [ ] EXPLAIN ANALYZE can never execute without the confirm gate (destructive-statement path).
- [ ] Tab bar, history recall, plan pane, Format button render in webview and pass jsdom bundle-eval tests.
- [ ] Full `npm test` green; `npm run typecheck` exit 0; `npm run compile` clean.
- [ ] CHANGELOG entry for Console v2 + tree/DDL/formatter user-visible features (cycle-wide).

## Dependencies

- TASK-AF-002 must complete first (frees `src/extension.ts` from wave 2 → wave 3 ownership).
- TASK-AF-003 must complete first (consumes `formatSql(sql, opts?)` exactly as produced there).

## Interfaces

- Consumes: `splitStatements(...)` from `src/core/statementParser.ts`; `formatSql(sql, opts?)` from `src/core/sqlFormat.ts` (TASK-AF-003); existing destructive-statement gate (`analyzeStatement`); existing query runner path used by ConsolePanel.
- Produces: webview↔host message contract (documented in consolePanel.ts header): `{type:"runStatement", index}`, `{type:"runSelection", text}`, `{type:"explain", sql, analyze:boolean}`, `{type:"format"}`, `{type:"historyPush", sql}`, `{type:"historyList"}`; Memento key `"vsdb.consoleHistory"` (string[] capped 200).

---

## Discussion

- Tabs are host-side state in `ConsolePanel` (`tabs[]` + `activeTabId`); webview renders from the `state` push. Buffers never cross tabs; `updateBuffer` messages sync the active editor back.
- `runSelection`/`runStatement` route through the injected `onRun` (extension.ts's shared `runStatements` flow), so keyword-qualify + dangerous confirm still apply.
- History append happens after the awaited `onRun`; the success log is intentionally "user recall surface", deduped on consecutive identical entries.
- `EXPLAIN ANALYZE` detection is depth-0 tokenization (`isExplainAnalyze`), plus the explicit `analyze` flag from the webview button; both route through a modal confirm before execution (ANALYZE really executes the query).
- Test-timing note: `until` in consoleTabs.test.ts always yields one macrotask before checking — the run callback fires synchronously while history appends in the awaited continuation.

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecAF004
SUMMARY: SQL Console v2 — host-side multi-tab registry with per-tab buffers, per-statement/selection run, Memento-persisted history (cap 200) with recall, EXPLAIN/EXPLAIN ANALYZE behind a modal confirm gate, Format round-trip via formatSql; webview gained tab bar, plan pane, history recall, Format/Explain buttons; extension.ts wires globalState + `vsdb.consoleNewTab`.
TEST_PLAN_FOLLOWED: task §Test Cases 1-12
FILES_CHANGED:
  - src/ui/consolePanel.ts: tab registry, history (Memento), message handlers, isExplainAnalyze, confirm gate, formatSql round-trip
  - src/ui/consolePanelMessages.ts: extended wire contract + guards, CONSOLE_HISTORY_KEY/CAP, newTabId
  - webview/consolePanelMain.ts: tab bar, Run/Run Selection/Explain/Explain Analyze/Format/History buttons, ArrowUp/Down recall, plan pane, TASK-002 context menu preserved
  - webview/styles.css: tab bar, plan pane, history pane styles
  - src/extension.ts: pass context.globalState to ConsolePanel; vsdb.consoleNewTab command
  - package.json: activation event + contributed command vsdb.consoleNewTab (with icon)
  - CHANGELOG.md: Unreleased cycle AF entry (console v2)
TESTS_ADDED:
  - src/ui/__tests__/consoleTabs.test.ts: cases 1,2,3,5,6,7,8,9 (8 tests)
  - tests/consolePanelWebview.test.ts: cases 4,10,11,12 (4 tests, jsdom bundle-eval)
VERIFICATION:
  command: npx vitest run src/ui/__tests__/consoleTabs.test.ts tests/consolePanelWebview.test.ts && npm run typecheck && npm test && npm run compile
  result: 12/12 new tests pass; typecheck exit 0; full suite 2021 passed / 0 failed; esbuild clean
  output_excerpt: |
    Test Files 138 passed | 1 skipped (139)
    Tests 2021 passed | 2 skipped (2023)
    esbuild: build complete
ISSUES: none
HANDOFF_TO_REVIEWER: yes — full acceptance met; RED-first was enforced by writing tests before the consolePanel.ts rewrite (tests failed against the old single-tab host: listTabs/getHistory undefined, then assertions drove the registry/history/confirm implementation).
NEXT: ready for review

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart (running as unic/unic-smart; matches handoff.reviewer.model in .ukit/storage/config.json)
EXECUTOR_MODEL: unic-code (self-reported below; differs from reviewer — mustDifferFromExecutor satisfied)
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/consoleTabs.test.ts tests/consolePanelWebview.test.ts
  result: 12 pass / 0 fail (fresh re-run 2026-08-29: host 8 + webview 4); npm run typecheck exit 0
TEST_PLAN_COVERAGE: all-followed — §Cases 1–12 implemented (verified in test source); safety-critical edges hold: #2 close-last-tab no-crash, #6 history cap evicts oldest, #7 Memento rehydrate, #9 EXPLAIN ANALYZE deny → no execution (confirm gate verified in src/ui/__tests__/consoleTabs.test.ts:341-344).
FINDINGS:
  critical: none
  important: none
  minor:
    - Full-suite and compile claims in the report trusted via the cycle's release gate (v1.12.0, a72b9cf) rather than re-run by reviewer per assignment scope; targeted suites + typecheck re-run fresh and green.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Implementation commit 0ccaab9 verified in history (consolePanel.ts +445, consolePanelMessages.ts +125, webview +315, package.json command contribution, CHANGELOG entry). AF-003's formatSql consumed as contracted; extension.ts wave-3 ownership respected.
