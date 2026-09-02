# TASK-ARP06-005 — Privacy-safe policy + usage display in the chat panel (aiChatPanel)

- Status: `done`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3/§4 (ARP-06.5)

## Goal

The chat panel surfaces the policy decision + per-turn/per-session usage via a shape-safe `usage` wire
message containing no prompt, SQL, secret, trace, or tool arguments; the webview renders it as a status
chip. OMP turns show the policy notice with no invented usage.

## Target Files

- `src/ui/aiChatPanelMessages.ts` — add `AiChatPanelUsage` host→webview message type.
- `src/ui/aiChatPanel.ts` — post the `usage` frame once per builtin turn on the `done` path, consuming
  `AgentRunResult.usage` (from TASK-ARP06-004) + the `EffectivePolicy.notice`; accumulate the session
  total in a panel field; never include prompt/SQL/secret/trace/tool args.
- `webview/aiChatPanelMain.ts` — handle the `usage` message in the same switch as `session_state`
  (`webview/aiChatPanelMain.ts:1705`) and render a status chip.
- `src/ui/__tests__/aiChatPanelPolicy.test.ts` — extend (exists, 34 KB; has the `SECRET_RE` whole-turn
  byte-scan pattern #3).
- `src/ui/__tests__/aiChatPanel.test.ts` — extend (exists).
- `src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts` — extend (exists; webview chip render).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | builtin turn posts usage + policy notice | on `done`, a `{type:"usage"}` frame carries the exact summed `inputTokens/outputTokens`, `unknown:false`, session total, and `policyNotice` (non-empty when policy denies) | builtin turn, steps with usage `1/1` + `2/3` |
| 2 | edge: unknown | all-unknown usage → `unknown:true`, never invented | provider returns `{0,0}` for every step → posted usage is `{0,0, unknown:true}` + notice | all steps `{0,0}` |
| 3 | edge: privacy | whole-turn byte scan stays secret-free | aggregate every webview frame + history of a builtin turn containing a secret-shaped string in a prompt/tool arg → `SECRET_RE` scan finds nothing (mirror the existing #3 pattern) | secret-shaped prompt/tool arg |
| 4 | edge: privacy | usage frame is shape-safe | the `{type:"usage"}` message contains ONLY numeric fields + the `policyNotice` string — no prompt text, no SQL, no tool names/arguments, no trace | real builtin turn |
| 5 | edge: denied policy | denied policy → notice shown, chat still completes | generic prompt used, `policyNotice` non-empty on the usage frame, no error bubble | denied `EffectivePolicy` |
| 6 | edge: abort | aborted turn never posts fabricated usage | stop mid-turn → no `{type:"usage"}` frame with invented numbers (none, or `unknown`/partial as actually seen) | mid-turn stop |
| 7 | edge: render | webview renders the usage chip | chip shows tokens/unknown state; `textContent`-only, no child nodes on hostile numeric values | post a `usage` frame |

## Test Files

- `src/ui/__tests__/aiChatPanelPolicy.test.ts` — tests 1-6 (extend).
- `src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts` — test 7 (extend).
- `src/ui/__tests__/aiChatPanel.test.ts` — happy-path integration of the post (extend).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts
npm run typecheck
npm run compile
```

No lint script exists — `npm run typecheck` is the static gate. Selection per RULES: `aiChatPanel.ts` →
tests-map lists 10 files but is **stale** (omits `aiChatPanelPolicy.test.ts` and
`aiChatPanelSessionStateWebview.test.ts` — both verified on disk). The three pinned DB-free files are the
targets; sibling suites run in the cycle `npm test` net.

**Bundle freshness:** `npm run compile` runs `node esbuild.js` and rebuilds `dist/`, including
`dist/aiChatPanel.js` — the esbuild bundle of `webview/aiChatPanelMain.ts` (`esbuild.js:87-89,171`). The
vitest targets exercise only the TS source, so a stale committed bundle would otherwise pass every check
yet ship a non-functional panel; the `npm run compile` step in this sequence confirms the shipped bundle
is regenerated from the changed webview source.

## Acceptance Criteria

- [ ] The `usage` frame is posted once per builtin turn on the `done` path with exact summed numbers and
      the policy notice; OMP turns post the notice with no invented usage.
- [ ] Privacy: the frame is shape-safe (numeric fields + notice only) AND the whole-turn `SECRET_RE` scan
      stays clean; no prompt/SQL/secret/trace/tool args on the wire.
- [ ] Denied policy → generic chat completes with a non-empty notice; abort → no fabricated usage.
- [ ] Webview renders the usage chip (`textContent`-only).
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- **TASK-ARP06-004** — consumes `AgentRunResult.usage` / `TurnUsageSummary` produced by the accounting
  task (the panel must not re-invent accounting).

## Interfaces

- Consumes:
  - `AgentRunResult.usage: TurnUsageSummary` + `TurnUsageSummary { inputTokens: number; outputTokens:
    number; unknown: boolean; steps: number }` (from `../ai/agent`, added by TASK-ARP06-004).
  - `EffectivePolicy { provider; context; tools; auditExportAllowed; notice: string }` (from
    `../ai/policy`, existing — via `resolveEffectivePolicy()` at `aiChatPanel.ts:1348`).
  - `AgentStep.result.usage` (existing, only if the panel needs per-step detail — prefer the summary).
- Produces:
  - `AiChatPanelUsage { type: "usage"; inputTokens: number; outputTokens: number; unknown: boolean;
    sessionTokens: { inputTokens: number; outputTokens: number }; policyNotice: string }` (new, in
    `aiChatPanelMessages.ts`).
  - Webview `case "usage"` renderer in `webview/aiChatPanelMain.ts`.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (first RED run, before implementation — `npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts`):

```
 ❯ src/ui/__tests__/aiChatPanelPolicy.test.ts  (20 tests | 4 failed) 18ms
   ❯ ... > #A1 builtin turn posts usage + denied-policy notice once, before done
     → expected [] to have a length of 1 but got +0
   ❯ ... > #A2 all-unknown usage → unknown:true, zeros echoed, nothing invented
     → expected [] to have a length of 1 but got +0
   ❯ ... > #A4 usage frame carries only numeric fields + policyNotice string
     → expected [] to have a length of 1 but got +0
   ❯ ... > #A5 denied policy: non-empty notice ... no error bubble
     → expected [] to have a length of 1 but got +0
 ❯ src/ui/__tests__/aiChatPanel.test.ts  (35 tests | 1 failed) 26ms
   ❯ ... > posts exactly one usage frame per turn with exact sums, session totals, and empty notice on the allowed path
     → expected [] to have a length of 1 but got +0
 ❯ src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts  (9 tests | 5 failed) 32ms
   ❯ renders token counts into the usage chip            → expected null not to be null
   ❯ renders the unknown state instead of invented totals → expected null not to be null
   ❯ renders a non-empty policyNotice on the chip         → expected null not to be null
   ❯ accumulates across turns — second usage frame ...    → expected null not to be null
   ❯ chip is textContent-only — hostile numeric/string    → expected null not to be null
 Test Files  3 failed (3)
      Tests  10 failed | 54 passed (64)

Detailed (vitest -t "A1 builtin"):
AssertionError: expected [] to have a length of 1 but got +0
 ❯ src/ui/__tests__/aiChatPanelPolicy.test.ts:911
    911|     expect(usages).toHaveLength(1);
```

RED rationale: 10 new tests failed because no `{type:"usage"}` frame is posted and no
`#usageChip` exists on base — the expected reason. The two absence-guard tests
(#A3 whole-turn byte scan, #A6 abort posts no usage) pass on base as negative
invariants (there is no usage frame yet to leak or fabricate); they become
meaningful after GREEN and stay green with the frame live.

GREEN implementation:
- `src/ui/aiChatPanelMessages.ts` — new `AiChatPanelUsage` host→webview message
  (type/inputTokens/outputTokens/unknown/sessionTokens/policyNotice) + union membership.
- `src/ui/aiChatPanel.ts` — `sessionUsage` accumulator field; `postUsage(usage, notice)`
  helper (consumes `AgentRunResult.usage` verbatim — never re-derives accounting;
  unknown turns contribute 0 to session totals); posted once per COMPLETED builtin
  turn inside the `!token?.aborted` done path (aborted turns never post usage);
  OMP `runOmpEngineTurn` posts `postUsage(undefined, policy.notice)` at its single
  settle point — notice with NO invented usage.
- `webview/aiChatPanelMain.ts` — `UsageMsg` shape + `"usage"` case in the same
  switch as `session_state`; `applyUsage()` renders a `#usageChip`
  (textContent-only, fixed label templates, `Number.isFinite` guards, unknown
  renders "tokens unknown" instead of reading the zeros as confirmed cost,
  non-empty `policyNotice` joined as plain text).

Verification Output (all run inside the worktree, this turn):

```
$ npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts
 ✓ src/ui/__tests__/aiChatPanelPolicy.test.ts  (20 tests)
 ✓ src/ui/__tests__/aiChatPanel.test.ts  (35 tests)
 ✓ src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts  (9 tests)
 Test Files  3 passed (3)
      Tests  64 passed (64)

$ npm run typecheck
> tsc --noEmit
typecheck exit: 0

$ npm run compile
  dist/aiChatPanel.js  ...  dist/extension.js ...
esbuild: build complete
compile exit: 0
# dist/aiChatPanel.js regenerated (fresh mtime) and contains usageChip + "usage" case:
grep -c "usageChip" dist/aiChatPanel.js → 2 ; grep -c '"usage"' → 1
```

Extra regression net (beyond the pinned commands): 21 sibling suites re-run green —
aiChatPanelAcp, aiChatPanelEngine, aiChatPanelDbAware, aiChatPanelSessionState,
aiChatPanelToolParity, aiChatPanelMessages, aiChatE2e, aiChatPanelThoughtRegen,
aiChatPanelResume, aiChatGrounding, aiChatPanelAttachments, aiChatPanelPlan(+Webview),
aiChatPanelWebview(+Task002/Task005), aiChatPanelDbAwareWebview, aiChatPanelPrivacy,
aiChatPanelBundle — 293 tests, 0 failures. The new OMP-path usage frame breaks no
existing frame-order/byte-scan assertion.

Status: PASS

Note:
1. SECRET_RE scan adapter: the mandated wire key names (`inputTokens`/`outputTokens`/
   `sessionTokens`) contain the benign substring "token", so a raw `JSON.stringify`
   of the whole frames array would false-positive the existing byte-scan tests. The
   policy suite now serializes usage frames for the scan via `scanFrames()` — key
   names excluded, every carried VALUE (numbers, unknown flag, full notice string)
   included. Frame shape itself is pinned exactly (closed key set) by shape-safety
   test #A4. No other test's scan strength was reduced.
2. Test-#7 refinement during RED: the unknown-state test pins the TURN label
   (`/Turn: 0 in/i` absent) rather than any "0 in" anywhere — session totals may
   legitimately show 0s when nothing was ever reported.
3. webview chip placement mirrors the existing `#sessionChip`/`#engineLifecycle`
   pattern (span appended to `#engineBanner` or root), textContent-only.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/aiChatPanelPolicy.test.ts src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts && npm run typecheck && npm run compile
  result: 64 pass / 0 fail; typecheck exit 0; compile exit 0; dist/aiChatPanel.js regenerated (usageChip x2, "usage" x1)
TEST_PLAN_COVERAGE: all-followed - §Test Cases 1-6 in aiChatPanelPolicy.test.ts; #7 (render) split into 5 webview cases; integration in aiChatPanel.test.ts; OMP notice path exercised by existing #1b wire scan
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ui/__tests__/aiChatPanelPolicy.test.ts - no dedicated assertion pins the OMP usage frame's content (unknown:true, zeros, no invented numbers). The shared postUsage(undefined, notice) logic is correct and the builtin unknown/abort tests cover it; an explicit OMP-frame assertion would strengthen the pin.
    - src/ui/__tests__/aiChatPanelPolicy.test.ts (scanFrames) - the adapter drops any unknown extra field of a usage frame from the SECRET_RE scan; safe ONLY because #A4 pins the exact closed key set. Keep the two tests paired; worth a comment.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Privacy invariant holds: the usage frame carries only numeric fields + the closed-set policy notice (resolvePolicy reasons); no prompt/SQL/tool args/trace on the wire. Values-only scanFrames correctly neutralizes the benign "token" key substring while still scanning every carried value including the full notice string. Builtin posts usage only inside the !aborted done branch (abort never fabricates); OMP posts unknown:true notice-only at its single settle point. Webview chip is textContent-only with Number.isFinite guards (hostile input test confirms no live DOM).
