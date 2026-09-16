# PLAN — CHATFIX: V2 chat layout, scroll, activity timeline and message actions

## §1 Intent

Four user-reported defects in the V2 AI Chat webview (real usage, screenshots), plus two scope
updates recorded verbatim during planning:

1. **Composer huge on fresh open** — must always sit compact at the panel bottom, never up high.
2. **Composer crushed after a few turns** — "sau khi chat 1 vài câu thì nó tụt xuống dưới cùng
   luôn": the composer sinks to the bottom edge and is squeezed to a cut-off sliver. Same root
   cause as (1), opposite manifestation.
3. **Transcript dead** — no scrollbar, no auto-scroll to the newest message; no thinking/loading
   indication while a turn runs (bare unstyled "Bash running" text rows that never resolve
   visually); message action icons (copy / edit / reload / 3-dot) do nothing when clicked.
4. **Design target for the activity area** (user re-sent reference screenshot, "clear, tidy, and
   beautiful"): a Claude Code-style tool timeline — per-step tool label + one-line summary +
   status dot (running=pulsing, success=green, error=red) joined by a subtle vertical connector;
   Bash steps show an expandable monospace IN/OUT block (command in, result out, capped height
   with internal scroll and fade); a trailing "Working…" pulsing indicator while the turn is live.

Success: fresh open shows a compact composer pinned above the hint row; after any number of turns
the composer stays compact and fully visible; the transcript scrolls and follows the newest
message; a live turn renders the polished timeline; every message action button works.

Investigation (verified, line numbers confirmed 2026-09-16) is folded into §3 — executors must
not re-derive it, but must Read the named regions before editing.

## §2 Scope

In-scope (this cycle, 4 tasks):

- Explicit shell grid placement fix (`styles.css`) — resolves (1), (2), creates the scroll region.
- Driving the existing scroll controller in the render pass — resolves auto-scroll + unread pill.
- Tool activity timeline + live indicator in the transcript — resolves (3) thinking/loading and (4).
- Wiring the dead message action callbacks — resolves (3) dead icons.

Out of scope:

- Composer auto-grow bounds — verified CORRECT (`webview/aiChat/composer.ts:64-65`
  `COMPOSER_AUTO_GROW_MIN_PX=64` / `MAX_PX=160`, `applyAutoGrow` ~line 367). Do not touch.
- New host protocol MESSAGE kinds; the only wire change allowed is the one additive optional
  field spec'd in TASK-CHATFIX-003.
- Engine/agent loop behavior, permission policy, sessions, CHATV2 R2 P2 review advisories.
- Version bump / package / publish.

CONSTRAINT: tasks in the same wave must not modify the same file — see Dependencies in each task.

## §3 Approach

**Root cause of (1)+(2)+scroll region (verified).** `webview/aiChat/styles.css` lines 52-67: the
V2 root declares `grid-template-rows: 40px auto minmax(0, 1fr) auto auto 20px` and relies on
AUTO-PLACEMENT of 5 visible children (header, banner, main, composer, hint; the two aria-live
regions are visually-hidden/out-of-flow). When the banner is hidden at fresh open it gets
`display:none` (line ~208) — display:none grid items do not occupy their auto-placed row, so
every later child shifts up one row: `main` lands in the row-2 `auto` track (content-sized,
grows forever, clipped by root `overflow:hidden` line ~61 → no scrollbar) and `composer` lands
in the row-3 `minmax(0,1fr)` track — stretched on fresh open; after several turns the growing
auto track squeezes that same 1fr track toward 0 → crushed composer. Banner visible ⇒ correct —
why it only bites sometimes. Fix: explicit `grid-row: 1..5` on the five shell children (+
`.UnicDB-ai-chat-v2-main { display:flex; flex-direction:column; min-width:0; min-height:0 }`).
One change resolves composer size, bottom pinning, crush, and enables the scroll region.

**Auto-scroll (verified).** `webview/aiChat/scroll.ts` implements a full stick-to-bottom
controller (48px threshold, unread pill, prepend re-anchor, input-focus suppression). It is
instantiated at `webview/aiChat/controller.ts:777` but NEVER driven — zero call sites for
`beginFrame`/`notifyNewResponse`/`notifyReasoningActivity` in the repo. Wire it into the single
coalesced render pass (`controller.ts` ~264-285, where `transcript.render(state)` /
`activity.render(state)` already run): `beginFrame()` before paints; a user-visible-signature
diff after paints decides `notifyNewResponse()` vs `notifyReasoningActivity()`.

**Timeline (per user scope updates).** The transcript already renders in-flow tool rows
(`transcript.ts` `updateTool` lines 445-459: label + raw status text + summary). Upgrade those
rows into the timeline (no second surface): status dot classes from the existing `data-status`
attribute, bold label + muted summary, expandable monospace IN/OUT block, trailing live
indicator while `state.turn` is open. Data: `tool_started` (`src/ui/aiChatPanelMessages.ts:638`)
carries no payload — add ONE optional `detail?: string` filled by the host at the existing
`onToolCall` site (`src/ui/aiChatPanel.ts:3034-3048`, `ToolCall` from `src/ai/agent.ts:149`),
shape-only/sanitized/capped like all host copy; `tool_finished.summary` stays the OUT line.
Legacy frames without `detail` render without the IN block. Reducer (`store.ts:581/597`) plumbs
`ChatToolItem.detail`. Alternative rejected: rendering the collapsed `activity.ts` header as the
indicator — it is invisible when collapsed and duplicates the timeline rows.

**Dead icons (verified).** Buttons exist and fire `TranscriptCallbacks` (`transcript.ts:67`,
dispatch at 248-288; copy even self-services the clipboard + toast). `controller.ts:743-767`
wires only `onCopyUser`/`onCopyAssistant`/`onRegenerateAssistant`/`onLoadEarlier`;
`onEditUser`/`onRetryUser`/`onMoreAssistant` are undefined → no-ops. Wire: edit → `DRAFT_CHANGED`
(`store.ts:284`) + focus the composer textarea; retry → existing `requestRetry()`
(`controller.ts:990`); 3-dot → existing `createOverlayMenu` (`overlays.ts:92,151`) anchored at
the clicked button with Copy/Regenerate rows. No new subsystems.

## §4 Test Plan

| Task | Type | Test | Expected |
|---|---|---|---|
| 001 | regression | explicit grid-row on all five shell children | styles.css has `grid-row: 1..5` on header/banner/main/composer/hint — RED before fix; single assertion covers fresh-open, crush and scroll-region manifestations |
| 001 | happy | transcript is the scroll region | `.UnicDB-ai-chat-v2-main` = flex column + min-width/min-height 0; `.UnicDB-ai-chat-v2-transcript` keeps `overflow-y:auto` |
| 001 | edge (clipping) | root keeps `overflow:hidden`; main has none | root block matches `overflow:hidden`, main block does not |
| 001 | edge (scoping) | new selectors stay V2-scoped | every added selector/keyframe contains `.UnicDB-ai-chat-v2`, braces balanced |
| 002 | happy | new response auto-scrolls to bottom | mocked scrollHeight 2000 / clientHeight 400 → `scrollTop === 2000` after flushRender |
| 002 | edge (reasoning-only) | reasoning delta never scrolls | scrollTop unchanged, pill hidden |
| 002 | edge (user scrolled up) | position preserved + unread pill | scrollTop stays 0; `[data-chat-scroll-pill]` visible, label "↓ 1 new response" |
| 002 | regression | controller is never driven today | all above RED before the wiring lands |
| 003 | happy | Bash step with IN/OUT | `tool_started{label:"Bash",detail:"git status"}` + `tool_finished{status:"ok",summary:"3 files changed"}` → bold label, IN text "git status", OUT text "3 files changed", green status |
| 003 | happy | live indicator lifecycle | `.UnicDB-ai-chat-v2-live` node exists while turn open, removed after `turn_finished` |
| 003 | edge (absent field) | legacy frame without `detail` | no IN block node, row renders label + dot, no crash |
| 003 | edge (hostile input) | HTML/control chars in detail/summary | textContent only; no injected element in `innerHTML` |
| 003 | edge (boundary) | output longer than cap | capped max-height + `overflow-y:auto` rules asserted in CSS |
| 003 | regression | running pulse absent today | pulse rule + namespaced keyframes for `[data-status="running"]` — RED before fix (only failed/denied colored, styles.css:641) |
| 004 | happy | copy user message | `navigator.clipboard.writeText` called with message text; "Copied" toast |
| 004 | happy | edit user message | composer textarea value = message text and focused |
| 004 | happy | retry user message | postMessage body `{kind:"submit_turn", draft.text === message text}` |
| 004 | happy | assistant 3-dot | `[data-chat-overlay-menu]` opens with Copy + Regenerate rows; Escape closes |
| 004 | edge (clipboard failure) | writeText rejects | "Could not copy" alert, no throw |
| 004 | edge (empty text) | retry/edit on empty message | no `submit_turn` posted |
| 004 | regression | edit/retry/3-dot dead today | callbacks undefined → happy cases RED before fix |

Edge kinds are deliberately mixed: clipping/scoping (CSS-structural), absent-field, hostile
input, boundary-cap, user-scrolled-up, input-focus, clipboard-permission, empty-text.

## §5 Verification Commands

Per task (exact, from `package.json` scripts — verified):

```bash
npx vitest run <task's named test files>
npm run typecheck        # tsc --noEmit — the project's static gate
npm run compile          # node esbuild.js — bundle must stay green
```

- This project has **no lint script** (checked `package.json` scripts) — `npm run typecheck` is
  the static-analysis gate and is MANDATORY in every task.
- Full `npm test` at every wave boundary is the regression net for the per-task narrowed
  selections below.
- Task-budget validator note: `.claude/ukit/index/task-budget-validator.mjs` does not exist in
  this repo's installed UKit version (verified by directory listing + find) — the right-sizing
  gate could not be executed; each task file instead follows `_TEMPLATE.md` exactly and keeps to
  one file-boundary of work per the PLAN §2 constraint.
- Test-selection note (RULES resolution order): none of this cycle's targets resolve via
  `.cache/index/tests-map.json` (verified — not mapped), and the RULES step-3 floor names
  `yarn test:release-core`, which does not exist in this npm project. The binding convention here
  is colocated tests matched by the vitest `include` glob `webview/**/*.test.ts`
  (`vitest.config.ts`), so each task names its exact colocated files — never the full suite by
  default, never an empty selection.

## §6 Acceptance Criteria

- [ ] Fresh open: composer compact, pinned above the hint row at the bottom — not giant (TASK-001).
- [ ] After many turns: composer still compact and fully visible, transcript row absorbs the
      growth (TASK-001).
- [ ] Banner hidden or visible: identical placement (explicit grid-row, no auto-placement shift)
      (TASK-001).
- [ ] Transcript scrolls; newest message auto-follows when near bottom; scrolled-up preserves
      position and shows the unread pill (TASK-001 + TASK-002).
- [ ] Live turn shows the tool timeline: bold labels, muted summaries, pulsing/green/red status
      dots with connector line, Bash IN/OUT monospace cards (capped, internally scrollable), and
      a trailing pulsing "Working…" indicator that resolves when the turn closes (TASK-003).
- [ ] Copy, edit, retry and 3-dot on message actions all perform their action (TASK-004).
- [ ] `npm run typecheck` and `npm run compile` pass; full `npm test` passes at each wave
      boundary; all four tasks reviewed APPROVED/APPROVED-WITH-MINOR.

## §7 Global Constraints

- Native DOM TypeScript only; no UI framework, no new dependency, no CDN, no browser storage.
- All CSS scoped under `.UnicDB-ai-chat-v2` — `webview/aiChat/__tests__/shell.test.ts` enforces
  this globally: every NEW selector and keyframe name must carry the prefix.
- Wire-derived strings go through `textContent` only; wire values never become class names.
- esbuild bundle via `npm run compile`; no version bump, package or publish.
- Do not modify composer auto-grow bounds (`webview/aiChat/composer.ts` constants 64/160).
- npm only; Node v22; VS Code webview target (no Node APIs in `webview/**`).

## Planner Report
PLANNER_MODEL: bao-opus
PLAN_REVIEW: Approved by bao-opus (Round 1 — 0 critical / 0 important / 3 minor, logged in Plan Review Log)

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: merged the "crushed composer" second manifestation into TASK-001's
regression assertions (same grid-row contract); verified no existing test pins the broken
`grid-template-rows` string (checked shell/controllerSurfaces/composer/sessions/transcript/
errorsScrollA11y CSS assertions) so 001 cannot silently break neighbors; corrected §5 after
finding the RULES `yarn test:release-core` floor does not exist in this npm repo.
Known gaps: TASK-004 `onInsertSql` is wired only if an existing intent kind supports it —
otherwise the button stays hidden as today and the executor records the finding in Discussion;
Bash IN/OUT fidelity depends on what `ToolCall` (src/ai/agent.ts) exposes at the onToolCall
site — if arguments are not shape-safe the host sends a name-only detail and the IN block
degrades gracefully (covered by 003's absent-field edge test).

## Plan Review Log

### Round 1 — 2026-09-16 · bao-opus
STATUS: Approved
FINDINGS:
  - none (no critical or important findings; three minor advisories below are non-blocking)

NOTES (minor, advisory — record only, no re-round required):
  1. minor — §1 success line "every message action button works" (PLAN.md:23) overstates
     TASK-004 relative to the declared known gap that onInsertSql may stay hidden when no
     existing intent kind supports it (Planner Self-Audit, PLAN.md:181-183); §6 correctly
     enumerates only copy/edit/retry/3-dot. Suggested fix: scope the §1 line to those four
     actions or explicitly exclude onInsertSql, so no executor reads §1 as license to invent a
     new intent kind (which §2 out-of-scope forbids).
  2. minor — §4 edge-kind list names "input-focus" (PLAN.md:118) but no 002 table row exercises
     the input-focus scroll suppression that §3 attributes to scroll.ts (002 rows are
     PLAN.md:99-102). Suggested fix: add a 002 edge row (focus composer textarea mid-turn ->
     scrollTop unchanged, no pill) or drop the item from the list.
  3. minor — §2 states the same-wave no-shared-file CONSTRAINT (PLAN.md:46) but the plan never
     states the wave split, and the conflicts are non-obvious from the plan alone: 001 and 003
     both touch styles.css, 002 and 004 both touch controller.ts, 003 and 004 both touch
     transcript.ts. Suggested fix: state the intended wave grouping (e.g. wave 1 = 001+002,
     wave 2 = 003, wave 3 = 004, or any split honoring the constraint) so conflicting tasks are
     never co-scheduled.
