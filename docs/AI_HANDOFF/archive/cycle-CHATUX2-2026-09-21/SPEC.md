# SPEC — CHATUX2: AIChat composer/footer redesign, steering, transcript overlap fix, tree steps

<!--
Written by the planner at handoff-create (P2). Executor implements without
guessing: exact paths, signatures, frozen strings, thresholds, test
expectations. Open questions resolved in §14.
Cycle: CHATUX2-2026-09-21 · Base: main
-->

## 1. Problem and context

Four user-reported defects/requests on the AIChat V2 surface
(`webview/aiChat/*`, mounted by `webview/aiChatPanelMain.ts`, host
`src/ui/aiChatPanel.ts`):

1. **Bottom info bar.** The shell mounts a full-width 20px hint row
   (`shell.ts:206` `KEYBOARD_HINT` → `refs.hint`, grid row 5). Worse, the
   legacy `#engineBanner` was deleted (CHATV2-017, pinned absent by
   `aiChatPanelV2E2e.test.ts:138`), so `applyUsage`/`applyEngineState`
   (`aiChatPanelMain.ts:763-826`) fall back to `rootEl.appendChild(chip)` —
   `#usageChip` and `#engineLifecycle` become **implicit grid children**
   stacked under the composer. The user sees a stray bottom bar and wants:
   hint → compact spot under/right of the send button; stats → top-right
   header; chat frame bottom ~5px from the panel edge.
2. **No steering.** While a turn is live, plain Enter returns `native`
   (`keyboard.ts:155-156` — `canSubmitDraft` refuses non-submittable phases)
   and `requestSubmit()` while busy means **stop** (`controller.ts:1132-1134`).
   The user wants a submitted message queued into the running turn
   (continuous chat), not refused.
3. **Overlapping transcript text.** Root cause found: **three renderers share
   `shell.transcript`**. (a) `createActivityTimeline` mounts its own
   header+body+reasoning section into `shell.transcript`
   (`controller.ts:859-865` → `activity.ts:327` `container.append(header,
   body)`), re-rendering every tool item and reasoning text the keyed
   transcript already paints — duplicate content. (b) The legacy `#thread`
   (`aiChatPanelMain.ts:216-220`) is appended inside `shell.transcript` and
   carries `.UnicDB-chat-thread` (`webview/styles.css:1145-1157`:
   `flex:1 1 auto; overflow-y:auto`) — a **nested scroller** inside the V2
   scroll region with its own `scroll-behavior:smooth` and its own
   scroll-driving code (`aiChatPanelMain.ts:615-633` fights
   `scroll.ts`). (c) `activity.dispose()` does `container.textContent = ""`
   (`activity.ts:608`) — it would wipe the keyed transcript too.
4. **Step visualization.** Tool steps already render as keyed `item-tool`
   rows with a per-row `::before` rail (`styles.css:755-778`) but there is no
   tree grouping (rail runs full height of every row, no first/last
   trimming, no branch stub), and reasoning is a separate unstyled
   disclosure. User wants a Claude Code–style vertical tree; thinking text
   dimmed + smaller.

## 2. Goals

- G1: No element below the composer except ~5px padding; keyboard hint
  rendered inside the composer card under the bottom lane; usage + engine
  lifecycle text in the header's right zone.
- G2: Plain Enter on a valid draft while busy enqueues the draft
  (FIFO, cap 8); queue flushes automatically on `turn_finished`; composer
  hint shows queue state; primary button keeps its busy=stop contract.
- G3: Exactly one renderer owns `shell.transcript` children: the keyed
  transcript. No activity timeline DOM, no nested `#thread` scroller.
- G4: Consecutive tool/reasoning items form one visual tree (continuous
  rail, branch stubs, first/last trimming); reasoning body dimmed + 12px.

## 3. Non-goals

- NO host/protocol changes: `src/ui/aiChatPanel.ts`,
  `src/ui/aiChatPanelMessages.ts` untouched. Steering is webview-side
  queue-then-submit (§14 Q1 — engines have no mid-turn injection).
- NO true mid-turn injection / engine steering API.
- NO new dependencies, no version bump, no publish.
- NO V1 composer/header resurrection; `#thread` stays (legacy bridge
  renderers still write there) — only its scroller is neutralized.
- NO queue-cancel UI, no per-item dequeue affordance (YAGNI — §14 Q4).
- NO changes to scroll.ts, markdown.ts, permissions, sessions, changePlan.

## 4. User journeys

- **Footer:** chat opens → composer card is the last visible element; the
  `Enter to send · Shift+Enter for a new line` footnote sits inside the
  card under the controls; `Turn: N in / M out — Session: …` and the OMP
  lifecycle state sit in the header right zone; nothing renders below the
  composer.
- **Steering:** turn streaming → user types "also check indexes" → Enter →
  draft clears, hint reads `Queued 1 of 8 — sends when this turn ends` →
  `turn_finished` arrives → the queued draft auto-submits as the next turn
  (one `submit_turn` intent, fresh `clientRequestId`).
- **Overlap:** a turn with tool calls + reasoning renders each step once,
  in transcript order; no duplicate timeline block, no second scrollbar.
- **Tree:** consecutive tool rows share one continuous left rail with a
  branch stub per row; the rail stops at the last step; a reasoning item
  in the run joins the same tree, dimmed.

## 5. Functional requirements

- **FR-001 (footer removal):** `shell.ts` — delete the `hint` element
  (creation, `root.appendChild(hint)`, `ChatShellRefs.hint`, remount
  querySelector + refs entry). `KEYBOARD_HINT` copy moves to a new
  `-footnote` element created inside `refs.composer` (appended AFTER
  `composerBottom`, before `composer` is appended to root — so
  `renderComposerV2`'s `bottom.replaceChildren()` cannot remove it).
  `ChatShellRefs` gains `footnote`, `usage`, `engineState`; loses `hint`.
  `styles.css` — root grid `grid-template-rows` becomes
  `40px auto minmax(0,1fr) auto` (4 rows); root `padding` becomes
  `10px 12px 5px`; delete the `-hint` rule block; add `-footnote`
  (11px/16 muted, `padding: 0 var(--UnicDB-ai-chat-v2-space-4)
  var(--UnicDB-ai-chat-v2-space-2)`, `text-align: right`).
- **FR-002 (header stats):** `shell.ts` `buildHeader` — append, in order:
  `-engine-state` span (`id="UnicDB-ai-chat-v2-engine-state"`, `hidden`),
  `-usage` span (`id="UnicDB-ai-chat-v2-usage"`, `hidden`), then the
  existing overflow button. CSS: `-usage`/`-engine-state` are 11px/16
  muted, `white-space: nowrap`; `-usage` gets `margin-left: auto` (right
  zone). `aiChatPanelMain.ts` — `applyUsage` retargets host to
  `document.getElementById("UnicDB-ai-chat-v2-usage")` (create-if-missing
  inside `shell.header` fallback dropped: if the span is absent, append to
  `#UnicDB-root .UnicDB-ai-chat-v2-header`); chip keeps `id="usageChip"`
  textContent-only contract but renders INTO the `-usage` span
  (`usageEl.hidden = false` on first frame; `chip.textContent` unchanged:
  `Turn: <in> in / <out> out — Session: <in> in / <out> out` +
  optional ` — <policyNotice>`). `applyEngineState` same retarget to
  `#UnicDB-ai-chat-v2-engine-state` (`hidden=false` on first frame).
  Neither function may append to `rootEl` anymore.
- **FR-003 (steer queue):** `keyboard.ts` — new decision
  `{ kind: "steer" }`; `canSteerDraft({phase,draftText,hasUnresolvedContext})`
  = `BUSY` phase + non-blank + no unresolved context (busy set =
  validating/connecting/waiting_for_first_event/streaming/
  awaiting_permission/stopping — mirrors store.BUSY_PHASES). Ladder step
  (6) becomes: plain Enter + modifiersClean → `submit` if canSubmitDraft,
  else `steer` if canSteerDraft, else `native`. `store.ts` —
  `ChatViewState.steerQueue: readonly ComposerDraft[]` (init `[]`),
  `STEER_QUEUE_CAP = 8`, actions `STEER_ENQUEUED` (busy + cap not reached →
  push `{...state.draft}` snapshot, reset draft text/selection to empty,
  bump revision; else same-state no-op) and `STEER_DEQUEUED` (pop head;
  absent/empty → same-state). `controller.ts` — `handleDecision` case
  `"steer"`: `event.preventDefault()` + `dispatch(STEER_ENQUEUED)`;
  `applyHostFrame` `turn_finished` branch calls `flushSteerQueue()`:
  while `state.steerQueue.length > 0 && !busyPhase(state.phase)` →
  `const d = state.steerQueue[0]` → `dispatch(STEER_DEQUEUED)` →
  `requestRetry({ draft: d })` (existing path: fresh clientRequestId,
  SUBMIT_REQUESTED w/ explicit draft, `submit_turn` intent). Guard
  `disposed`. `composer.ts` — hint render: `steerQueue.length > 0` →
  `Queued N of 8 — sends when this turn ends` (N = length; at cap →
  `Queue full (8) — sends when this turn ends`); else busy →
  `COMPOSER_BUSY_HINT`; else hidden. New exports:
  `COMPOSER_QUEUE_HINT_LABEL = "Queued"`, `COMPOSER_QUEUE_FULL_LABEL =
  "Queue full"`, `COMPOSER_QUEUE_SUFFIX = "sends when this turn ends"`.
- **FR-004 (overlap fix):** `controller.ts` — delete
  `createActivityTimeline` call + `activity.render(state)` + the
  `ActivityTimeline` import (keep `phaseCopyLabel` import — used by
  `announcePhase`). `activity.ts` — delete the DOM renderer
  (`createActivityTimeline`, `ChatActivityRefs`, `ActivityCallbacks`,
  `ActivityTimeline`, `ActivityViewInput`, `ActivityDetailInput`,
  `ToolRecord`, `nextId`, icon/detail/copy helpers); KEEP pure exports
  `phaseCopyLabel`, `mapToolState`, `toolStateLabel`, `formatDuration`,
  `deriveEngineState`, `engineStateLabel`, `isActivePhase`,
  `ActivityToolState` (controller imports `phaseCopyLabel`; tests pin the
  rest). `styles.css` — delete the `-activity-*` rule block
  (~lines 1382-1662); add
  `.UnicDB-ai-chat-v2-transcript > .UnicDB-chat-thread { flex: 0 0 auto;
  overflow: visible; scroll-behavior: auto; margin-bottom: 0; }` —
  `#thread` becomes a normal flow child (single scroll owner).
- **FR-005 (tree steps):** `transcript.ts` `render()` — after the
  reconcile loop, walk `desired` order; for each maximal run of
  consecutive `tool`/`reasoning` items set `data-tree` on the record root:
  `"first"` (run head, len>1), `"last"` (run tail, len>1),
  `"first last"` (len 1), remove the attribute for middle items and all
  non-step items. `styles.css` — `-item-reasoning` gets the same
  `position: relative` + `::before` rail as `-item-tool` (shared selector);
  rail `top`/`bottom` become `data-tree`-aware: default (middle) `top:0;
  bottom:0`; `[data-tree~="first"]::before` `top:14px`;
  `[data-tree~="last"]::before` `bottom:calc(100% - 14px)`; add `::after`
  branch stub (1px × 10px horizontal, `left:9px; top:14px`, same border
  color/opacity) on both step kinds; `-reasoning-body` `font-size:12px;
  line-height:18px` (dimmed already via `-muted`; add `opacity:0.85` NO —
  dim = muted color + smaller size only, no opacity stacking);
  `-reasoning-toggle` `min-height:24px; font-size:11px`.

## 6. Fullstack scope

### Backend
N/A — no extension-host changes (`src/ui/aiChatPanel.ts` untouched; the
existing `usage`/`engine_state` legacy frames already carry the data).

### Database / schema / migrations
N/A.

### API contract
Module-level only — §8. No wire protocol changes: steering reuses the
existing `submit_turn` intent.

### Frontend UI and state
`webview/aiChat/{shell,keyboard,store,controller,composer,transcript,
activity}.ts`, `webview/aiChat/styles.css`, `webview/aiChatPanelMain.ts`,
`webview/styles.css` (read-only reference — the `#thread` override lives
in the V2 sheet).

### Integration
`renderState()` stays the single coalesced paint pass (minus
`activity.render`). `requestRetry` is reused for queue flush — same
`submit_turn` path as card retries.

### Security and permissions
textContent-only everywhere; no innerHTML; no new message types; queued
drafts carry the same context/attachment validation on flush (host
`blockUnresolvedContext` still gates).

### Performance
One fewer renderer per paint pass. `data-tree` marking is O(visible
items) inside the existing render.

### Observability / logging
Unchanged (live regions, toasts, phase announce).

### Deployment and rollback
Pure webview bundle change; rollback = revert commit.

## 7. Steer queue state machine (frozen)

```
Enter on valid draft:
  submittable phase → submit (unchanged)
  busy phase        → steer: STEER_ENQUEUED (snapshot draft, clear composer)
  queue full (8)    → steer decision; STEER_ENQUEUED no-ops (draft kept,
                      no newline; hint shows "Queue full (8)…")

turn_finished (any outcome) → flushSteerQueue():
  while steerQueue non-empty AND phase not busy:
    STEER_DEQUEUED → requestRetry(draft) → submit_turn intent
  (each flushed submit re-enters busy → next item waits for ITS
   turn_finished — FIFO drain, one turn at a time)

session reset (create_session/resume_saved_session handling already
resets transcript): steerQueue cleared — spec: reducer clears steerQueue
on the same frames that reset `state.transcript` (hydrate/session frames).
```

## 8. API contract (module-level, frozen)

### 8.1 `webview/aiChat/shell.ts`

```ts
export interface ChatShellRefs {
  // …unchanged fields…
  readonly footnote: HTMLElement;    // inside composer, under composer-bottom
  readonly usage: HTMLElement;       // header right zone, id UnicDB-ai-chat-v2-usage
  readonly engineState: HTMLElement; // header right zone, id UnicDB-ai-chat-v2-engine-state
  // REMOVED: readonly hint: HTMLElement;
}
```

### 8.2 `webview/aiChat/keyboard.ts`

```ts
export type ComposerKeyDecision =
  | /* …existing kinds… */
  | { readonly kind: "steer" };   // plain Enter, valid draft, busy phase
export function canSteerDraft(input: {
  readonly phase: TurnPhase;
  readonly draftText: string;
  readonly hasUnresolvedContext: boolean;
}): boolean;
```

### 8.3 `webview/aiChat/store.ts`

```ts
export const STEER_QUEUE_CAP = 8;
// ChatViewState += readonly steerQueue: readonly ComposerDraft[];
export type ChatLocalAction =
  | /* …existing… */
  | { readonly type: "STEER_ENQUEUED" }
  | { readonly type: "STEER_DEQUEUED" };
```

### 8.4 `webview/aiChat/composer.ts`

```ts
export const COMPOSER_QUEUE_HINT_LABEL = "Queued";
export const COMPOSER_QUEUE_FULL_LABEL = "Queue full";
export const COMPOSER_QUEUE_SUFFIX = "sends when this turn ends";
// hint text: `${LABEL} ${N} of 8 — ${SUFFIX}` / `${FULL} (8) — ${SUFFIX}`
```

### 8.5 `webview/aiChat/transcript.ts`

- `render()` sets/removes `data-tree` (`"first"`/`"last"`/`"first last"`)
  on `item-tool`/`item-reasoning` roots. No signature changes.

### 8.6 `webview/aiChat/activity.ts`

- REMOVED: `createActivityTimeline`, `ChatActivityRefs`,
  `ActivityCallbacks`, `ActivityTimeline`, `ActivityViewInput`,
  `ActivityDetailInput`.
- KEPT: `phaseCopyLabel`, `mapToolState`, `toolStateLabel`,
  `formatDuration`, `deriveEngineState`, `engineStateLabel`,
  `isActivePhase`, `ActivityToolState`.

### 8.7 CSS selectors (all under `.UnicDB-ai-chat-v2`)

New: `-footnote`, `-usage`, `-engine-state`,
`-transcript > .UnicDB-chat-thread` override, `-item-tool::after`,
`-item-reasoning::before`/`::after`, `[data-tree]` rail variants.
Removed: `-hint` rule, entire `-activity-*` block.
Modified: root `grid-template-rows` + `padding`, `-reasoning-body`,
`-reasoning-toggle`, `-item-tool::before` (data-tree aware).

## 9. UI behavior

- Composer card is the lowest element; footnote inside it, right-aligned.
- Header right zone: `[engine-state] [usage] [overflow]`; both spans
  `hidden` until their first frame.
- Enter while busy never stops the turn and never inserts a newline on a
  valid draft — it queues (at cap: no-op, draft kept). Stop remains the
  primary button only.
- Tool/reasoning steps render once, as a continuous tree; thinking dimmed
  12px/18px.

## 10. Edge cases

- Enter while busy on EMPTY draft → `native` newline (canSteerDraft false).
- Enter while busy with unresolved context → `native` (same refusal as
  submit — no silent queue of a blocked draft).
- Queue at cap → `steer` decision; `STEER_ENQUEUED` no-ops (same-state);
  draft preserved, no newline; hint shows full state.
- `turn_finished` outcome `stopped`/`failed` → queue still flushes (user
  intent was "send next"); each item waits its own turn boundary.
- Steer while `stopping` → queued; flushes when the stop resolves.
- Session switch/new chat → queue cleared (no cross-session send).
- `turn_finished` with no queue → no-op (guard).
- Legacy `#thread` empty → zero-height flow child, harmless.
- `data-tree` on a single-item run → `"first last"` → rail collapses to a
  stub-height segment (no dangling line).

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| Footer/shell | no `-hint` element/ref; footnote inside composer w/ copy; grid rows = `40px auto minmax(0,1fr) auto`; root padding-bottom 5px; `-usage`/`-engine-state` in header, hidden initially | `webview/aiChat/__tests__/shell.test.ts`, `shellGrid.test.ts` (modify) |
| Stats retarget | `applyUsage` writes into `#UnicDB-ai-chat-v2-usage` (not root); `applyEngineState` into `#UnicDB-ai-chat-v2-engine-state`; no implicit grid children after composer | `src/ui/__tests__/aiChatPanel.test.ts` (modify/extend) |
| Steering | Enter busy+valid → `steer` decision; STEER_ENQUEUED snapshots+clears draft; cap 8 → `steer` + STEER_ENQUEUED no-op (draft kept, no newline); flush on turn_finished → one `submit_turn` per queued item FIFO; stopping→queued→flush after close; unresolved context → native | `webview/aiChat/__tests__/keyboard.test.ts`, `store.test.ts`, `controller.test.ts`, `composer.test.ts` (modify) |
| Overlap | mounted controller: transcript has NO `-activity-header`/`-activity-body`; each tool id → exactly one `[data-chat-key]` node; `#thread` CSS override present (no nested scroller) | `webview/aiChat/__tests__/transcript.test.ts`, `controllerSurfaces.test.ts`, `shellGrid.test.ts` (modify) |
| Tree | consecutive tool run → `data-tree` first / (no attr) / last; single → `first last`; reasoning in run joins tree; rail CSS data-tree variants exist; reasoning-body 12px | `webview/aiChat/__tests__/transcript.test.ts`, `shellGrid.test.ts` (extend) |
| Activity cutover | `activity.ts` exports only pure helpers; `controller.ts` has no `createActivityTimeline`/`activity.render` | `webview/aiChat/__tests__/activity.test.ts` (prune to pure-helper tests) |

## 12. Acceptance criteria

- [ ] `npx vitest run webview/aiChat/__tests__` — PASS.
- [ ] `npx vitest run src/ui/__tests__/aiChatPanel.test.ts` — PASS.
- [ ] `npm run typecheck` — 0 errors; `npm run compile` — bundle OK.
- [ ] `npm test` — full suite PASS at each wave boundary.
- [ ] No `-hint` element/rule; no `-activity-*` DOM or CSS; no
      `createActivityTimeline` reference outside `activity.test.ts` history.
- [ ] `applyUsage`/`applyEngineState` never append to `#UnicDB-root`.
- [ ] Enter-while-busy produces `steer`, never `submit`/`native` on a
      valid draft; queue drains FIFO on `turn_finished`.

## 13. Migration / upgrade steps

N/A — no persisted state. Intentional behavior changes: Enter-while-busy
queues instead of newline; activity timeline removed (its information —
tool rows, reasoning — already lives in the keyed transcript); usage chip
moves root→header.

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| Q1: steer = mid-turn inject or queue? | **Queue in webview, flush on `turn_finished`** via existing `submit_turn`. | `OmpChatEngine.send()` resolves per turn; no engine exposes mid-turn injection. Queue satisfies "not refused" + continuous chat with zero protocol risk. |
| Q2: queue cap? | 8, FIFO. | Bounded memory; beyond cap `STEER_ENQUEUED` no-ops — draft kept, hint shows full state, never silent drop. |
| Q3: flush on failed/stopped turns? | Yes — flush on every `turn_finished`. | User already committed the message; refusing after a stop would drop intent. |
| Q4: cancel-queued UI? | No. | YAGNI; queue drains fast and Stop already exists. Recorded as possible follow-up. |
| Q5: hint placement? | Inside composer card, under bottom lane, right-aligned (`-footnote`). | "Under/right of send button"; survives `bottom.replaceChildren()` because it is a sibling of `composerBottom`, not a child. |
| Q6: usage transport? | Keep legacy `usage`/`engine_state` frames + retarget mount to header spans. | V2 store has no usage case; adding one is protocol+store work for zero UX gain. |
| Q7: activity timeline fate? | Deleted (DOM renderer + CSS); pure helpers kept for `phaseCopyLabel`. | It is the duplicate renderer causing overlap; transcript tree supersedes it. |
| Q8: task split? | T1 footer+tree-CSS ∥ T2 steer-core ∥ T3 tree-marking (disjoint) → T4 steer-wiring+overlap-cutover (controller.ts, activity.ts, styles.css). | Same-file rule + validator maxTargetFiles=3: T4 merges the two controller.ts concerns to avoid a 3-wave chain on one file. |

## 15. Review checklist

- [x] Every FR testable (§11 maps each to file + concrete expectations).
- [x] All layers covered or N/A'd (no backend/DB/protocol work).
- [x] Frozen: `STEER_QUEUE_CAP=8`, grid `40px auto minmax(0,1fr) auto`,
      padding-bottom 5px, footnote/queue/usage copy, `data-tree` values,
      reasoning 12px/18px.
- [x] Dependencies: T1 ∥ T2 ∥ T3 disjoint (wave 1); T4 after T1+T2 —
      styles.css + controller.ts serialized.
- [x] Phase 0 sweep: INDEX empty (BACKLOG archived); tasks/ has only
      _TEMPLATE.md; `git status` shows only RUN.md modified
      (runner-owned); docs/TASKS.md has no Ready-for-AI items for this
      surface.
- [x] Anti-requirements honored: no protocol/engine changes, no
      hard-coded colors, no fake buttons, no V1 resurrection.
