# TASK-CHATUX2-002 — Steer queue core: decision, reducer state, composer hint

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 · Spec: `docs/AI_HANDOFF/SPEC.md` FR-003, §7

## Goal

Add the pure half of steering: a `steer` keyboard decision for
Enter-while-busy on a valid draft, the `steerQueue` reducer state
(FIFO, cap 8) with enqueue/dequeue/clear semantics, and the composer
hint that renders queue state. The controller wiring that dispatches and
flushes the queue lands in TASK-CHATUX2-004.

## Spec references

- SPEC.md §5 FR-003, §7 (state machine), §8.2-§8.4, §14 Q1-Q4

## Target Files

- `webview/aiChat/keyboard.ts` — add `{ kind: "steer" }` to
  `ComposerKeyDecision`; export `canSteerDraft({phase,draftText,
  hasUnresolvedContext})` (busy phase + non-blank + no unresolved context;
  busy set mirrors store BUSY_PHASES); ladder step (6): plain Enter →
  `submit` if `canSubmitDraft`, else `steer` if `canSteerDraft`, else
  `native`.
- `webview/aiChat/store.ts` — `ChatViewState.steerQueue: readonly
  ComposerDraft[]` (init `[]`); `export const STEER_QUEUE_CAP = 8`;
  actions `STEER_ENQUEUED` (busy + under cap → push `{...state.draft}`
  snapshot, reset draft text/selection to `""`, bump `draft.revision`;
  else same-state) and `STEER_DEQUEUED` (shift head; empty → same-state);
  clear `steerQueue` wherever transcript/session state resets
  (hydrate/session frames — same place `state.transcript` is replaced).
- `webview/aiChat/composer.ts` — hint render (~455-457): `steerQueue.length
  > 0` → `Queued N of 8 — sends when this turn ends` (at cap → `Queue
  full (8) — sends when this turn ends`); else busy → `COMPOSER_BUSY_HINT`;
  else hidden. Export `COMPOSER_QUEUE_HINT_LABEL`, `COMPOSER_QUEUE_FULL_LABEL`,
  `COMPOSER_QUEUE_SUFFIX`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `decideComposerKey` busy + valid draft → `steer` | `{kind:"steer"}` for each busy phase; `submit` still for idle/completed/failed | phase=streaming, draftText="hi", no unresolved context |
| 2 | unit | `STEER_ENQUEUED` snapshots + clears draft | steerQueue[0] = prior draft (text/context/attachments); `state.draft.text === ""`, revision bumped; phase unchanged | streaming state with draft "next" |
| 3 | unit | `STEER_DEQUEUED` shifts head; empty → same-state | queue [a,b] → [b]; empty queue → identical state object | steerQueue fixtures |
| 4 | edge (boundary) | queue at cap 8 → `STEER_ENQUEUED` no-op | 9th enqueue returns same state; length stays 8 | steerQueue length 8 |
| 5 | edge (invalid input) | Enter busy + blank draft / unresolved context | `native` both cases — nothing queued | draftText="   " / hasUnresolvedContext=true |
| 6 | edge (lifecycle) | session-reset frame clears steerQueue | `steerQueue` empty after the frame that resets `state.transcript` | queue length 2 + hydrate/session frame |
| 7 | unit | composer hint shows queue state | `Queued 2 of 8 — sends when this turn ends`; at cap `Queue full (8) — sends when this turn ends`; beats busy hint; hidden when idle+empty | render(state) with steerQueue |

## Test Files

- `webview/aiChat/__tests__/keyboard.test.ts` — cases 1, 5 (rewrite the pinned "busy → native" test at ~55).
- `webview/aiChat/__tests__/store.test.ts` — cases 2, 3, 4, 6 (extend #5 busy-draft block ~297).
- `webview/aiChat/__tests__/composer.test.ts` — case 7 (queued hint precedence over busy hint).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/store.test.ts webview/aiChat/__tests__/composer.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] `steer` decision exists and is unreachable for blank/unresolved drafts.
- [ ] `STEER_QUEUE_CAP = 8` enforced; enqueue at cap is a same-state no-op.
- [ ] Composer hint renders queue count/full state per frozen copy.
- [ ] `npm run typecheck` clean; no regression in related suites.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: `{ kind: "steer" }` decision; `canSteerDraft(input)`;
  `ChatViewState.steerQueue`; `STEER_ENQUEUED`/`STEER_DEQUEUED` actions;
  `STEER_QUEUE_CAP`; `COMPOSER_QUEUE_*` labels — all consumed by
  TASK-CHATUX2-004 (controller dispatch + flush).

---

## Discussion

### 2026-09-21 · planner · devin/swe-2
Split from the original 4-file steering task (validator: maxTargetFiles=3).
This task is the pure/view half — fully testable without the controller.
`state.toasts` has no renderer, so queue feedback lives in the composer
hint. Pinned tests to rewrite: keyboard.test.ts ~55 ("busy → native"),
store.test.ts ~314 ("busy submit refused" — SUBMIT_REQUESTED while busy
still no-ops; the NEW path is STEER_ENQUEUED).

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

- 2026-09-21T23:23+07:00 · milestone: steer-queue-core · last-green: 72/72 tests pass in the three target suites · files: webview/aiChat/keyboard.ts, webview/aiChat/store.ts, webview/aiChat/composer.ts, webview/aiChat/__tests__/keyboard.test.ts, webview/aiChat/__tests__/store.test.ts, webview/aiChat/__tests__/composer.test.ts · drift: none

EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecC2 (feature-implementer)

RED_OUTPUT (before implementation — `npx vitest run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/store.test.ts webview/aiChat/__tests__/composer.test.ts`):

```
TypeError: Cannot read properties of undefined (reading 'map')
 ❯ webview/aiChat/__tests__/store.test.ts:402:25
FAIL webview/aiChat/__tests__/store.test.ts > CHATUX2-002 — steer queue > a queue at the cap of 8 refuses the 9th enqueue (same-state, draft kept)
AssertionError: Target cannot be null or undefined.
FAIL webview/aiChat/__tests__/store.test.ts > CHATUX2-002 — steer queue > a session-reset frame clears the queue (no cross-session send)
AssertionError: Target cannot be null or undefined.
 Test Files  3 failed (3)
      Tests  11 failed | 61 passed (72)
```

(11 failures: `canSteerDraft`/`{kind:"steer"}` missing in keyboard.ts, `steerQueue`/`STEER_*` missing in store.ts, `COMPOSER_QUEUE_*` exports missing in composer.ts.)

Verification Output (after implementation):

```
$ npx vitest run webview/aiChat/__tests__/keyboard.test.ts webview/aiChat/__tests__/store.test.ts webview/aiChat/__tests__/composer.test.ts
 ✓ webview/aiChat/__tests__/keyboard.test.ts (25 tests) 4ms
 ✓ webview/aiChat/__tests__/store.test.ts (21 tests) 8ms
 ✓ webview/aiChat/__tests__/composer.test.ts (26 tests) 46ms
 Test Files 3 passed (3)
      Tests 72 passed (72)

$ npm run typecheck
> tsc --noEmit            (clean, exit 0)

$ npm run compile
⚡ Done in 37ms
dist/webview.js 2.3mb ⚠️
dist/webview.css 41.6kb
```

Status: PASS

Note: SPEC §7 says "the same frames that reset `state.transcript`" — the
reducer never replaces `state.transcript` today, so `steerQueue` is cleared
on `session_hydrated`, the only hydrate/session frame in the V2 vocabulary
(initial ready + `resume_saved_session` re-hydration). `STEER_ENQUEUED`
snapshots the full draft (text/context/attachments) but clears only
text/selection in the composer per the task contract; context/attachments
stay editable for the next draft. `BUSY_PHASES` in keyboard.ts is a
`Partial<Record<TurnPhase, true>>` (project rule: static string-keyed
membership tables use Record, not Set) mirroring store.ts. Milestone commit
74a6301 on branch handoff/task-chatux2-002.
