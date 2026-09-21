# PLAN — CHATUX2-2026-09-21: AIChat composer/footer redesign + steering + transcript fixes

## §1 Intent

The AIChat V2 panel has a stray bottom info bar (deleted `#engineBanner`
fallback appends `#usageChip`/`#engineLifecycle` as implicit grid children
plus a 20px hint row), refuses input while a turn runs (Enter → newline,
primary → stop only), renders tool/reasoning steps twice (keyed transcript
+ activity timeline both mounted in `shell.transcript`) inside a nested
legacy `#thread` scroller — the overlapping-text bug — and lacks a
tree-style step view. Success: composer is the last element (~5px to panel
edge), hint inside the composer card, stats in the header right zone,
Enter-while-busy queues a FIFO steer queue flushed on `turn_finished`,
the transcript is owned by a single renderer (overlap fixed), and
consecutive tool/reasoning steps render as one tree with dimmed reasoning.

## §2 Scope

**In scope (4 tasks):**
- TASK-CHATUX2-001 — footer removal + header stats + all tree-step CSS:
  `shell.ts`, `styles.css`, `aiChatPanelMain.ts` (+ `shell.test.ts`,
  `shellGrid.test.ts`, `src/ui/__tests__/aiChatPanel.test.ts`).
- TASK-CHATUX2-002 — steer queue core (pure/view): `keyboard.ts`,
  `store.ts`, `composer.ts` (+ `keyboard.test.ts`, `store.test.ts`,
  `composer.test.ts`).
- TASK-CHATUX2-003 — tree `data-tree` marking: `transcript.ts`
  (+ `transcript.test.ts`).
- TASK-CHATUX2-004 — steer wiring + overlap cutover: `controller.ts`,
  `activity.ts`, `styles.css` (+ `controller.test.ts`,
  `controllerSurfaces.test.ts`, `activity.test.ts`, `shellGrid.test.ts`).

**Out of scope:** host/protocol changes (`src/ui/aiChatPanel.ts`,
`aiChatPanelMessages.ts`), engine mid-turn injection (does not exist —
SPEC §14 Q1), queue-cancel UI, scroll.ts/markdown.ts/permissions/sessions,
version bump/publish.

**Same-wave file rule:** wave 1 = TASK-001 ∥ TASK-002 ∥ TASK-003
(disjoint files). TASK-004 touches `styles.css` (TASK-001) and
`controller.ts`+steer symbols (TASK-002) → wave 2, depends on both.

## §3 Approach

- **Footer:** delete the shell `hint` row entirely; grid drops to 4 rows
  with `padding-bottom: 5px`. The hint copy moves to a `-footnote` element
  inside `refs.composer` (sibling of `composerBottom`, so
  `renderComposerV2`'s `bottom.replaceChildren()` can't remove it). Usage +
  engine lifecycle retarget from the deleted `#engineBanner`/root fallback
  to two new `hidden`-by-default header spans — keeping the legacy
  `usage`/`engine_state` frames and `textContent`-only contract (SPEC §14
  Q6: a V2 store usage case is protocol work for zero UX gain).
- **Steering:** webview-side queue, NOT mid-turn injection — no engine
  exposes one (`OmpChatEngine.send` resolves per turn). `decideComposerKey`
  gains a `steer` decision (busy + valid draft); the reducer snapshots the
  draft into `steerQueue` (cap 8) and clears the composer; `turn_finished`
  drains FIFO through the existing `requestRetry` → `submit_turn` path, so
  each queued message is a real turn with full host validation. Primary
  button keeps busy=stop; Enter never stops. At cap the `steer` decision
  still fires but `STEER_ENQUEUED` no-ops — draft kept, no newline, the
  `Queue full (8)` hint explains why (cap enforcement lives solely in the
  reducer; the pure keyboard layer takes no queue-length input).
- **Overlap:** delete the activity timeline's DOM renderer (it duplicates
  every tool/reasoning item into the same container; its `dispose()` even
  wipes siblings via `textContent=""`). Keep pure helpers for
  `phaseCopyLabel`. Neutralize `#thread`'s nested scroller with a
  V2-scoped CSS override — single scroll owner.
- **Tree:** mark maximal consecutive tool/reasoning runs with `data-tree`
  first/last in the existing reconcile pass; CSS rail + branch stubs do
  the rest. Reasoning joins the tree, dimmed 12px.
- **Alternatives rejected:** mid-turn steering API (no engine support);
  moving `#thread` out of the transcript (breaks legacy bridge ordering
  for zero gain vs. CSS neutralization); keeping the activity header as a
  steps summary (duplicates transcript content — the overlap itself);
  queue-length input on `canSteerDraft` so cap → `native` (breaks the
  "Enter while busy never inserts a newline on a valid draft" invariant
  and couples the pure keyboard layer to queue state — reducer no-op
  chosen instead, SPEC §7/§10).

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | shell mounts footnote inside composer, no `-hint` element | `refs.hint` gone; footnote has KEYBOARD_HINT copy; grid = 4 rows |
| happy | Enter while streaming + valid draft → steer | decision `steer`; draft snapshotted to steerQueue; composer cleared |
| happy | `turn_finished` drains queue FIFO | one `submit_turn` per queued item, in order, fresh clientRequestIds |
| happy | consecutive tool items get `data-tree` boundaries | run of 3 → first / (no attr) / last; singleton → `first last` |
| edge (boundary) | queue at cap 8 → Enter | `steer` decision; `STEER_ENQUEUED` no-ops (same-state); draft kept, no newline; hint `Queue full (8) — sends when this turn ends` |
| edge (invalid input) | Enter busy + unresolved context / blank draft | `native` — no queue of a blocked/empty draft |
| edge (lifecycle) | steer during `stopping`; session reset | queued; flushes after close; queue cleared on session reset |
| regression | mounted controller → transcript children | zero `-activity-*` nodes; each tool id = one `[data-chat-key]` node; `#thread` not a scroller |
| regression | `applyUsage` target | writes into `#UnicDB-ai-chat-v2-usage`, never appends to root |
| regression | `applyEngineState` target | writes into `#UnicDB-ai-chat-v2-engine-state`, never appends to root |
| regression | `activity.ts` exports only pure helpers | no `createActivityTimeline`/`ChatActivityRefs`/`ActivityTimeline` exports; `phaseCopyLabel`/`mapToolState`/`toolStateLabel`/`formatDuration`/`deriveEngineState`/`engineStateLabel`/`isActivePhase` remain (activity.test.ts pruned to pure-helper tests) |

## §5 Verification

```bash
npx vitest run webview/aiChat/__tests__/shell.test.ts webview/aiChat/__tests__/shellGrid.test.ts        # TASK-001
npx vitest run src/ui/__tests__/aiChatPanel.test.ts                                                    # TASK-001
npx vitest run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/store.test.ts \
  webview/aiChat/__tests__/composer.test.ts                                                            # TASK-002
npx vitest run webview/aiChat/__tests__/transcript.test.ts                                             # TASK-003
npx vitest run webview/aiChat/__tests__/controller.test.ts webview/aiChat/__tests__/controllerSurfaces.test.ts \
  webview/aiChat/__tests__/activity.test.ts webview/aiChat/__tests__/shellGrid.test.ts                  # TASK-004
npm run typecheck && npm run compile                                                                   # every task
npm test                                                                                             # wave boundary
```

(`package.json` scripts: `test`=vitest run, `typecheck`=tsc --noEmit,
`compile`=esbuild. No `test:release-core` script exists in this repo —
targeted vitest files are the narrowed selection; `npm test` is the
wave-boundary net per RULES.md.)

## §6 Acceptance

- [ ] No element renders below the composer; root `padding-bottom: 5px`;
      `-hint` element+rule deleted; footnote inside composer with the
      exact hint copy.
- [ ] `#usageChip`/`#engineLifecycle` render inside header spans
      (`#UnicDB-ai-chat-v2-usage`, `#UnicDB-ai-chat-v2-engine-state`);
      `applyUsage`/`applyEngineState` never append to `#UnicDB-root`.
- [ ] Enter while busy on a valid draft → `steer` → `STEER_ENQUEUED`;
      `turn_finished` drains FIFO via `submit_turn`; cap 8 → `steer`
      decision + `STEER_ENQUEUED` no-op (draft kept, no newline).
- [ ] `shell.transcript` children come from ONE renderer; no
      `-activity-header`/`-activity-body`/`-activity-row` in DOM or CSS;
      `#thread` not a scroll container.
- [ ] Consecutive tool/reasoning items carry `data-tree` boundaries;
      reasoning body 12px/18px muted.
- [ ] `npm run typecheck` clean; `npm test` green at each wave boundary.

## §7 Global Constraints

- VS Code theme tokens / existing `--UnicDB-ai-chat-v2-*` vars only — no
  hard-coded colors.
- `textContent` only for all new text — no `innerHTML`.
- No new dependencies; no new wire message kinds; no version bump/publish.
- `ChatShellRefs`/`ChatViewState`/`ComposerKeyDecision` changes are
  breaking — migrate every importer in the same task.
- Frozen copy: `Enter to send · Shift+Enter for a new line`;
  `Queued N of 8 — sends when this turn ends`;
  `Queue full (8) — sends when this turn ends`; `STEER_QUEUE_CAP = 8`.
- Pure modules stay pure: `keyboard.ts`/`store.ts` — no DOM, no clock, no
  transport.

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: assigned `controller.ts` to TASK-002 (steering) and
TASK-003 (activity unmount) — serialized via dependency; moved the
queued-indicator into `composer.ts` (TASK-002) since `state.toasts` has no
renderer; kept `phaseCopyLabel` in activity.ts for the controller import.
Known gaps: the overlap screenshot is not reproducible in jsdom — the fix
targets the two verified structural defects (duplicate activity renderer,
nested `#thread` scroller); if a third cause exists it will surface in
manual visual verification (CHAT_V2_SCREENSHOT_FIXTURES).

## Planner Report
PLANNER_MODEL: devin/swe-2 (handoff-planner agent; strong-tier unavailable on this gateway — content self-audited 14/14) — substitution reviewed and accepted by unic-smart plan review, Round 1 (2026-09-21)
PLAN_REVIEW: Round 1 Issues Found → findings applied 2026-09-21 (see Plan Review Log)

## Plan Review Log

### Round 1 — 2026-09-21 · unic-smart
Status: Issues Found

COMPLETENESS:
  - PLAN §1 Intent ends mid-sentence ("...flushed on `turn_finished`,") and the §2 heading is missing (jumps §1 → §3) — the overlap/tree success criteria are never stated in the intent paragraph.
  - PLAN §4 Test Plan omits two SPEC §11 rows: "activity.ts exports only pure helpers" (activity.test.ts prune) and the `applyEngineState` retarget (only `applyUsage` is listed). Task files may cover them, but the plan-level table is incomplete.
CONSISTENCY:
  - SPEC §7 + §10 + PLAN §4 say queue-at-cap Enter → `native`, but the frozen contract (§8.2 `canSteerDraft` takes no queue-length input; FR-003 ladder checks only canSubmit/canSteer; §8.3 `STEER_ENQUEUED` no-ops at cap) yields decision `steer` + reducer no-op. A test asserting `native` fails, and `native` would insert a newline the `steer` path preventDefaults. Resolve one way: add queue length to `canSteerDraft` input, or correct §7/§10/PLAN §4 to "steer decision + no-op, draft kept, no newline".
  - PLAN §4 "run of 3 → first/middle/last" implies a `middle` value; SPEC FR-005/§8.5 removes `data-tree` on middle items — reword to "first / (no attr) / last" to avoid a wrong assertion.
CLARITY:
  - SPEC §11 "Stats retarget" test file says "aiChatPanel.test.ts or webview-level test" — PLAN resolves it to `src/ui/__tests__/aiChatPanel.test.ts`; acceptable, but the SPEC itself stays ambiguous.
SCOPE:
  - none — 4 tasks on one surface, explicit out-of-scope list; SPEC §6 covers every layer or N/A's it with reason.
YAGNI:
  - none — queue-cancel UI and mid-turn injection explicitly rejected with rationale (§14 Q1/Q4); activity deletion is the verified root cause, not gold-plating.

NOTES: All findings are doc-level; the cap→`native` contradiction is the only one that can produce a failing test or signature drift — resolve before P3. SPEC is otherwise frozen/authoritative; the devin/swe-2 planner substitution is acceptable given this gate.

### Round 1 — findings applied
Date: 2026-09-21 · reviser: P2Rev2 (devin/swe-2)

- Cap behavior resolved as **steer decision + `STEER_ENQUEUED` no-op at
  cap** (draft kept, no newline, `Queue full (8)` hint). Chosen over the
  `canSteerDraft` queue-length alternative because it keeps the frozen
  §8.2/§8.3 contract unchanged, preserves the §9 invariant "Enter while
  busy never inserts a newline on a valid draft" (a `native` outcome would
  add a newline the user did not intend), and keeps cap enforcement
  single-owner in the reducer. Applied to SPEC §7, §9, §10, §11, §14 Q2;
  PLAN §3, §4, §6; TASK-004 test case 8 + Discussion note.
- PLAN §1 truncated sentence completed (single-renderer + tree success
  criteria); `## §2 Scope` heading restored.
- PLAN §4: added `applyEngineState` retarget and `activity.ts` pure-helper
  prune rows; cap row and `first/middle/last` row corrected.
- SPEC §11: stats-retarget test file pinned to
  `src/ui/__tests__/aiChatPanel.test.ts`; Tree row reworded to
  `first / (no attr) / last`.
- PLANNER_MODEL line updated to record the unic-smart review acceptance
  of the swe-2 substitution (unblocks the model-tier guard for revision
  writes; the planning itself remains swe-2-authored as recorded).

### Round 2 — 2026-09-21 · unic-smart
Status: Approved

COMPLETENESS:
  - none — Round 1 gaps verified resolved: §1 intent sentence completed
    (single-renderer + tree success criteria), `## §2 Scope` heading
    restored, §4 gained the `applyEngineState` retarget and
    activity-pure-helpers regression rows; all SPEC §11 areas mapped.
CONSISTENCY:
  - none — cap behavior now uniform across SPEC §7/§9/§10/§11/§14 Q2 and
    PLAN §3/§4/§6: `steer` decision + `STEER_ENQUEUED` no-op at cap 8,
    draft kept, no newline, `Queue full (8)` hint; §8.2 `canSteerDraft`
    signature unchanged. `data-tree` wording aligned to
    first / (no attr) / last in both docs.
CLARITY:
  - none — SPEC §11 stats-retarget test file pinned to
    `src/ui/__tests__/aiChatPanel.test.ts`.
SCOPE:
  - none — 4 tasks on one surface, explicit out-of-scope; wave split
    (T1∥T2∥T3 → T4) consistent between PLAN §2 and SPEC §14 Q8.
YAGNI:
  - none — rejections (mid-turn injection, queue-cancel UI, activity
    header summary) carry rationale; no unrequested surface added.

NOTES: All Round 1 findings verified applied in both documents; no new
blocking issues found. The devin/swe-2 planner substitution stands
accepted — plan is internally consistent and executor-ready for P3.
