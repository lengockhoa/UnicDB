# TASK-AF-004 — SQL Console v2: tabs, per-statement run, history, EXPLAIN, Format

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
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

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
