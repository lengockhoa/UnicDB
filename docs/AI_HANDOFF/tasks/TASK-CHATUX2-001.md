# TASK-CHATUX2-001 — Footer removal + header stats + tree-step CSS

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 · Spec: `docs/AI_HANDOFF/SPEC.md` FR-001, FR-002, FR-005 (CSS half)

## Goal

Remove the bottom info bar: delete the shell `hint` row, move the keyboard
hint into a `-footnote` element inside the composer card, retarget
`#usageChip`/`#engineLifecycle` from the deleted `#engineBanner`/root
fallback into two new header spans, shrink the root grid to 4 rows with a
5px bottom padding, and land ALL tree-step CSS (rail, branch stubs,
dimmed reasoning) that TASK-003's `data-tree` attributes hook into.

## Spec references

- SPEC.md §5 FR-001 (footer removal), FR-002 (header stats), FR-005 (tree CSS)
- SPEC.md §8.1 (ChatShellRefs), §8.7 (CSS selectors), §14 Q5/Q6

## Target Files

- `webview/aiChat/shell.ts` — delete `hint` element + `ChatShellRefs.hint`;
  add `footnote` (inside `refs.composer`, after `composerBottom`), `usage`
  + `engineState` spans in `buildHeader` (before overflow button, both
  `hidden`); update `mountChatShellIfNeeded` remount querySelector list.
- `webview/aiChat/styles.css` — root `grid-template-rows: 40px auto
  minmax(0,1fr) auto`; root `padding: 10px 12px 5px`; delete `-hint` rule;
  add `-footnote`, `-usage`, `-engine-state` rules (11px/16 muted;
  `-usage` `margin-left:auto`); TREE CSS: extend `-item-tool`'s
  `position:relative` + `::before` rail to `-item-reasoning`; rail becomes
  `data-tree`-aware (`[data-tree~="first"]::before { top:14px }`,
  `[data-tree~="last"]::before { bottom:calc(100% - 14px) }`); add
  `::after` branch stub (1px×10px, `left:9px; top:14px`) on both kinds;
  `-reasoning-body` `font-size:12px; line-height:18px`;
  `-reasoning-toggle` `min-height:24px; font-size:11px`.
  Do NOT touch `-activity-*` or `.UnicDB-chat-thread` — TASK-004 owns
  those deletions/override.
- `webview/aiChatPanelMain.ts` — `applyUsage` (~763-799) and
  `applyEngineState` (~805-826): mount target becomes
  `document.getElementById("UnicDB-ai-chat-v2-usage")` /
  `"UnicDB-ai-chat-v2-engine-state"` (unhide on first frame); NEVER append
  to `rootEl`/`#UnicDB-root`; keep `id="usageChip"`/`id="engineLifecycle"`
  + textContent-only contract.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `mountChatShell` exposes `footnote`/`usage`/`engineState`, no `hint` | refs.hint undefined; footnote inside `refs.composer` after `composerBottom`, textContent = `Enter to send · Shift+Enter for a new line`; usage/engineState inside header, `hidden` | fresh root div |
| 2 | edge | remount via `mountChatShellIfNeeded` after refs loss | rebuilds refs from DOM without duplicating nodes; footnote/usage/engineState resolved by querySelector | root with `data-chat-v2-shell="1"` + full tree |
| 3 | edge (CSS contract) | root grid + padding | `grid-template-rows` = `40px auto minmax(0,1fr) auto` (4 tracks); `padding-bottom: 5px`; no `-hint` rule; `-footnote`/`-usage`/`-engine-state` rules exist | readFileSync styles.css (shellGrid.test.ts pattern) |
| 4 | regression | `applyUsage` writes into header usage span, never appends to root | after a `usage` frame: `#UnicDB-ai-chat-v2-usage` contains `#usageChip` with `Turn: … — Session: …`; `#UnicDB-root` has NO direct `#usageChip`/`#engineLifecycle` child | jsdom boot + legacy `usage` message |
| 5 | unit (CSS) | tree + reasoning styles | `-item-reasoning::before` rail rule exists; `[data-tree~="first"]`/`[data-tree~="last"]` variants exist; `::after` stub on both step kinds; `-reasoning-body` 12px/18px; `-reasoning-toggle` 24px/11px | readFileSync styles.css |

## Test Files

- `webview/aiChat/__tests__/shell.test.ts` — cases 1-2 (modify existing shell contract tests).
- `webview/aiChat/__tests__/shellGrid.test.ts` — cases 3, 5 (update the pinned 5-row grid: hint row case removed; footnote/usage/engine-state/tree rules added).
- `src/ui/__tests__/aiChatPanel.test.ts` — case 4 (extend; it already drives the legacy bridge).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/shell.test.ts webview/aiChat/__tests__/shellGrid.test.ts
npx vitest run src/ui/__tests__/aiChatPanel.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] No `-hint` element, ref, or CSS rule remains; nothing renders below the composer.
- [ ] `applyUsage`/`applyEngineState` contain no `rootEl.appendChild`/`host.appendChild(chip)` fallback to `#UnicDB-root`.
- [ ] Tree CSS present: `data-tree` rail variants, `::after` stubs, reasoning 12px/18px dimmed.
- [ ] `npm run typecheck` clean; no regression in related suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: `ChatShellRefs.footnote|usage|engineState`; element ids
  `UnicDB-ai-chat-v2-usage`, `UnicDB-ai-chat-v2-engine-state`; the
  `[data-tree]` CSS contract consumed by TASK-003's attribute marking.

---

## Discussion

### 2026-09-21 · planner · devin/swe-2
Footnote is a SIBLING of `composerBottom` inside `refs.composer` — do NOT
put it inside `composerBottom` (`renderComposerV2` calls
`bottom.replaceChildren()` and would delete it). This task owns ALL of
styles.css for wave 1: footer/grid/header rules AND the tree-step rules
(rail extension to `-item-reasoning`, `data-tree` variants, `::after`
stub, reasoning dim). The `-activity-*` deletion and the
`.UnicDB-chat-thread` override belong to TASK-004 (wave 2, same file).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
