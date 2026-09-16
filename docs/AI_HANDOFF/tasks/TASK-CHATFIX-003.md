# TASK-CHATFIX-003 — Tool activity timeline (Claude Code-style) + live-turn indicator

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Timeline), §4 (rows 003)

## Goal

Turn the transcript's bare "Bash running" rows into the user's reference look: a tidy timeline of
per-step tool rows — bold tool label + muted one-line summary, status dot (running=pulsing,
success=green, error=red) joined by a vertical connector line, Bash-style expandable monospace
IN/OUT cards (capped height, internal scroll, fade at the cut) — plus a trailing pulsing
"Working…" indicator while the turn is live. Everything native DOM, scoped CSS, textContent-only.

## Target Files

- `src/ui/aiChatPanelMessages.ts` — add ONE optional field `readonly detail?: string` to
  `AiChatHostToolStartedV2` (line ~638). No new message kinds.
- `src/ui/aiChatPanel.ts` — `sessionNoteActivity` input (line 5024) gains optional `detail`;
  the `onToolCall` site (lines 3034-3048) derives a shape-only single line from the existing
  `ToolCall` (src/ai/agent.ts:149 — Read the type first): tool name + short sanitized arg hint
  (e.g. Bash command / Read path+range), control chars stripped, ≤120 chars; the `tool_started`
  `postV2` (line 5048) carries it. Privacy: shape only, never row bytes — mirror how `summary`
  is already handled.
- `webview/aiChat/store.ts` — `ChatToolItem` (line 126) gains `readonly detail: string`
  (default `""`); `tool_started` reducer (line 581) stores it; `tool_finished` (line 597)
  preserves the existing item's detail.
- `webview/aiChat/transcript.ts` — `updateTool` (lines 445-459) rebuilds the tool row: bold
  label + muted summary line, status dot driven by the EXISTING `data-status` attribute,
  expandable IN/OUT block (`IN` = `item.detail`, `OUT` = `item.summary`) with markers
  `[data-tool-block="in"|"out"]`, toggle button, monospace class; render() appends ONE trailing
  live indicator node `.UnicDB-ai-chat-v2-live` (pulsing dot + "Working…" text) while
  `state.turn` is open (`!state.turn.closed`), removes it when closed. All wire text via
  `textContent`.
- `webview/aiChat/styles.css` — timeline polish near the existing tool rules (lines ~628-660):
  vertical connector between step dots (`::before` border on the rows' left edge), bold
  high-contrast label + muted summary, dot pulse for `[data-status="running"]` + green
  `[data-status="ok"]` / red failed (failed/denied colors exist at 641 — extend, don't replace),
  IN/OUT inset cards (editor-font, inset bg, 1px border, radius-sm, `max-height` ≈ 8 rows,
  `overflow-y: auto`, fade mask at the cut), pulsing `.UnicDB-ai-chat-v2-live` keyframes.
  EVERY new selector and `@keyframes` name must carry the `UnicDB-ai-chat-v2` prefix
  (shell.test.ts enforces globally) — precedent: `UnicDB-ai-chat-v2-activity-spin` (line 1182).
- `webview/aiChat/__tests__/transcript.test.ts` — (modify) add the DOM cases below.
- `webview/aiChat/__tests__/store.test.ts` — (modify) add the reducer detail case below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Bash step with IN/OUT | `tool_started{toolId, label:"Bash", detail:"git status"}` then `tool_finished{status:"ok", summary:"3 files changed"}` → row shows bold "Bash", `[data-tool-block="in"]` textContent "git status", `[data-tool-block="out"]` textContent "3 files changed", status node `data-status="ok"` | real reducer state (transcript.test.ts pattern) |
| 2 | happy | live indicator lifecycle | after submit (turn open) transcript contains `.UnicDB-ai-chat-v2-live`; after `turn_finished` the node is removed | real reducer |
| 3 | edge (absent field) | legacy frame without detail | `tool_started` with NO `detail` → no IN block node; row still renders label + dot; no throw | reducer frame without the field |
| 4 | edge (hostile input) | HTML/control chars | detail/summary `"<img src=x onerror=alert(1)>"` → row `innerHTML` contains no `<img`; text is escaped as text | hostile strings |
| 5 | edge (boundary) | output longer than the cap | 2000-char summary → OUT block renders full text but CSS caps it (assert `[data-tool-block="out"]` rule has `max-height` + `overflow-y: auto`) | long string |
| 6 | regression | running pulse absent today | styles.css gains a pulse rule for the running state + namespaced keyframes — RED before fix (only failed/denied are colored, styles.css:641) | CSS text |
| 7 | reducer | detail plumbs through the store | `tool_started{detail}` → `ChatToolItem.detail` set; later `tool_finished` without detail PRESERVES it | store.test.ts reducer test |

## Test Files

- `webview/aiChat/__tests__/transcript.test.ts` — (modify) tests 1-6.
- `webview/aiChat/__tests__/store.test.ts` — (modify) test 7.

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/store.test.ts webview/aiChat/__tests__/shell.test.ts
npm run typecheck
npm run compile
```

(shell.test.ts re-runs the global scoping guard; typecheck covers the src/ui + src/ai type
changes — there is no lint script.)

## Acceptance Criteria

- [ ] All seven tests pass; RED evidence for 6 pasted.
- [ ] Timeline matches the polish bar: connector line, bold/muted contrast, inset capped
      monospace cards, pulsing running + live indicator — reviewer checks the CSS, not opinions.
- [ ] No new message kind; only the additive optional `detail` field end-to-end.
- [ ] Every new selector/keyframes namespaced; `npm test` full suite green at the wave boundary.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-CHATFIX-001 — owns styles.css first; the timeline is scrollable only after the grid fix.

## Interfaces

- Consumes: `AiChatHostToolStartedV2` (aiChatPanelMessages.ts:638), `sessionNoteActivity`
  (aiChatPanel.ts:5024) + `onToolCall` (aiChatPanel.ts:3034, `ToolCall` from src/ai/agent.ts:149),
  `ChatToolItem` (store.ts:126), `updateTool` (transcript.ts:445).
- Produces: `ChatToolItem.detail: string` (new required field, `""` default);
  `AiChatHostToolStartedV2.detail?: string`; DOM markers `[data-tool-block="in"]`,
  `[data-tool-block="out"]`, class `UnicDB-ai-chat-v2-live` — TASK-CHATFIX-004 and reviewers
  target these exact names.

---

## Discussion

### 2026-09-16 · planner · bao-opus
Per the user's scope update: if `ToolCall` arguments are not shape-safe for a command line, send
the tool name alone as `detail` — the absent-field edge (case 3) is the designed degradation.
The activity.ts timeline is intentionally left as-is: the transcript rows ARE the timeline; do
not mount a second surface. `action` field (e.g. icon semantics) may map to the existing
`createChatIcon` allowlist if trivially available; do not invent new icons.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer

### RED (tests first, committed `c11c275`)

`npx vitest run webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/store.test.ts`

```
 FAIL  store.test.ts > CHATFIX-003 — tool detail plumbs through the store > case 7 (reducer): tool_started stores detail; tool_finished WITHOUT detail preserves it
 FAIL  store.test.ts > CHATFIX-003 — tool detail plumbs through the store > legacy tool_started without the detail field defaults it to an empty string
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 1 (happy): Bash step renders bold label, IN/OUT blocks and ok dot
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 2 (happy): live indicator appears while the turn is open, leaves on turn_finished
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 3 (edge): legacy frame without detail — label + dot + OUT card, no IN card, no throw
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 4 (edge): hostile detail/summary stays escaped text, never an <img>
AssertionError: expected undefined to be '<img src=x onerror=alert(1)>' // Object.is equality
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 5 (boundary): 2000-char output renders in full while CSS caps the OUT card
AssertionError: expected undefined to be 'xxxx…' // no [data-tool-block="out"] node existed
 FAIL  transcript.test.ts > TASK-CHATFIX-003 tool activity timeline > case 6 (regression): running status gains a namespaced pulse rule
AssertionError: expected null not to be null  // no .tool-status[data-status="running"] rule in styles.css
 Test Files  2 failed (2)
      Tests  8 failed | 34 passed (42)
```

All 8 new tests failed for the expected reasons (missing IN/OUT blocks, no live node, no
namespaced running-pulse rule, no detail plumbing); all 34 pre-existing tests stayed green.

### Verification Output (fresh, current turn, after implementation)

`npx vitest run webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/store.test.ts webview/aiChat/__tests__/shell.test.ts`

```
 ✓ webview/aiChat/__tests__/store.test.ts (16 tests) 7ms
 ✓ webview/aiChat/__tests__/shell.test.ts (14 tests) 33ms
 ✓ webview/aiChat/__tests__/transcript.test.ts (26 tests) 145ms
 Test Files  3 passed (3)
      Tests  56 passed (56)
```

`npm run typecheck`

```
> tsc --noEmit
(exit 0, no errors)
```

`npm run compile`

```
  dist/webview.js  2.3mb · dist/webview.css 41.0kb · dist/extension.js 6.6mb
esbuild: build complete (exit 0)
```

`npm test` (full suite, wave-boundary acceptance)

```
 Test Files  310 passed | 2 skipped (312)
      Tests  4651 passed | 5 skipped (4656)
```

Note: the first full-suite run had 6 environment failures (ENOENT for
`node_modules/.bin/esbuild` / `vsce` — the worktree had no `node_modules`). Fixed by
symlinking the main repo's `node_modules` (gitignored); suite then fully green. Not caused
by this diff.

Status: PASS

Note:
- No new message kind — only the additive optional `detail` on `AiChatHostToolStartedV2`,
  plumbed `sessionNoteActivity` → `tool_started` postV2 → store → transcript.
- Only the builtin `onToolCall` site derives `detail` (closed arg-field allowlist:
  `command` / `file_path`+`offset`+`limit` / `path` / `pattern` / `query` / `url`;
  control chars stripped, ≤120 chars). The omp/ACP sites only receive a tool name, so
  they keep the designed absent-field degradation (§Discussion).
- Transcript muted line renders `detail` unless it duplicates the bold label (degradation
  case), then falls back to `summary`; IN card suppressed when `detail === label` so the
  degradation never paints a silly card. All wire text via `textContent`.
- The OUT card carries `max-height: 128px` + `overflow-y: auto` (case 5 pins it); the
  fade-at-the-cut mask is gated on `data-scrollable` computed in the renderer so short
  output never loses its last line to the gradient.
- Every new selector/keyframes usage carries the `UnicDB-ai-chat-v2` prefix (shell.test.ts
  scoping guard green); the running dot reuses the existing namespaced
  `UnicDB-ai-chat-v2-pulse` keyframes.
- Environment fix, no repo change: worktree `node_modules` → symlink to the main repo's
  `node_modules` (gitignored, inside the worktree).

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
