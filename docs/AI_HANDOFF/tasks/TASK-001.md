# TASK-001 — Message contract: thought + regenerate (host side)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2.1, §3, §4, §7

## Goal

Extend the host↔webview message protocol with `thought` (host→webview, live agent reasoning) and
`regenerate` (webview→host). Make the host forward `agent_thought_chunk`s live (replacing the deliberate
drop at src/ui/aiChatPanel.ts:1022-1027) and implement Regenerate by popping the trailing
`[user, assistant]` history pair and re-running the normal send path.

## Target Files

- `src/ui/aiChatPanelMessages.ts` — add `AiChatPanelThought { type: "thought"; text: string }` to
  `AiChatPanelHostMessage`; add `AiChatPanelRegenerate { type: "regenerate" }` to
  `AiChatPanelWebviewMessage`.
- `src/ui/aiChatPanel.ts` — (a) in `handleAcpNotification`: branch `sessionUpdate === "agent_thought_chunk"`
  → read `update.chunk` (string, non-empty) and `this.post({ type: "thought", text: chunk })`; thoughts
  NEVER touch `session.buffer` or `this.history`; same `token?.aborted` + `turnSettled` gates as deltas.
  (b) new `handleRegenerate()`: ignore when `this.token !== null` (turn in flight); ignore when
  `history.length < 2`; pop trailing pair only when `history[last].role === "assistant"` and
  `history[last-1].role === "user"`; then `await this.handleSend(lastUser.content)` (string cast via
  typeof guard). Wire `case "regenerate"` into `handleMessage`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | thought shape joins host union, regenerate joins webview union | Both fixtures assignable to their unions; `JSON.stringify` contains no apiKey-shaped field | `AiChatPanelThought`/`AiChatPanelRegenerate` fixtures |
| 2 | unit | host forwards live thought chunk | Feed `feedAgentThoughtChunk(transport, "thinking hard")` mid-turn → exactly one posted message `{type:"thought", text:"thinking hard"}`; `session.buffer` unchanged | ACP panel mid-turn (pattern: aiChatPanelAcp.test.ts #1) |
| 3 | edge (malformed) | thought chunk missing/empty `chunk` field | `{sessionUpdate:"agent_thought_chunk"}` and `{..., chunk: ""}` → no post, no throw | crafted update objects |
| 4 | edge (late frame) | thought after turn settled | Post `done` first, then thought chunk → message dropped silently (no post) | turnSettled panel |
| 5 | edge (invariant) | thought never enters history/buffer | After a turn with 3 thought chunks + final assistant text, `panel.history` contains only user+assistant; buffer === final text | mid-turn thought feed |
| 6 | edge (concurrency) | regenerate while turn in flight | send → (mid-turn) regenerate → no second `session/prompt`; webview receives no duplicate turn | in-flight token |
| 7 | edge (empty) | regenerate with empty history | `history = []` → handleRegenerate no-op, no crash, no posts | fresh panel |
| 8 | happy | regenerate reruns last user message | Completed turn ("q1"→"a1"), then regenerate → `session/prompt` re-sent with "q1"; history ends exactly `[...prev, user(q1), assistant(...)]` — no duplicate pair | completed ACP turn |
| 9 | edge (state) | regenerate skipped when trailing entry is not a pair | history `[user]` only (stopped turn) → no-op | crafted history |
| 10 | regression | thought forwarding does not break delta/permission routing | Re-run of acp #1 assertions: agent_message_chunk still → delta; permission still → 1 request; unknown kinds still ignored | existing acp suite |

## Test Files

- `src/ui/__tests__/aiChatPanelMessages.test.ts` — extend: #1 union membership + no-secret assertions.
- `src/ui/__tests__/aiChatPanelAcp.test.ts` — extend: #2-#5, #8-#10 (FakeAcpTransport harness exists;
  reuse `feedAgentThoughtChunk`, panel assertion pattern from existing #1 test).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate.
(Test selection: `.cache/index/tests-map.json` `sourceFile: src/ui/aiChatPanel.ts` → the 6 chat suites;
narrowed to the 2 touched contracts above. Full `npm test` at wave boundary is the regression net.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; RED first for #2 (thought currently dropped) before implementing.
- [ ] `npm run typecheck` exits 0.
- [ ] No thought text reachable from `this.history`, `session.buffer`, or `deriveHistoryFromReplay` output.
- [ ] Regenerate never fires concurrently with an in-flight turn and never duplicates a history pair.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none) — extends existing union types in place.
- Produces: `AiChatPanelThought { type: "thought"; text: string }` on
  `AiChatPanelHostMessage`; `AiChatPanelRegenerate { type: "regenerate" }` on
  `AiChatPanelWebviewMessage`; host behavior: `thought` posts during a live turn only, `regenerate`
  accepted any time (host decides validity). TASK-002 consumes both shapes; TASK-004 depends on
  `handleSend`/`buildMessages` being the ONLY turn entry points (regenerate reuses them).

---

## Discussion

(no comments yet)

---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Added host↔webview `thought` + `regenerate` message contract per PLAN §3; host now forwards live `agent_thought_chunk` as `{type:"thought", text:chunk}` and implements Regenerate via pop-pair-then-handleSend (with PLAN §3 Regenerate-after-Stop semantics: re-send `lastSentText` when history has no trailing pair).
TEST_PLAN_FOLLOWED: task §4 inline
FILES_CHANGED:
  - src/ui/aiChatPanelMessages.ts: added `AiChatPanelThought` to `AiChatPanelHostMessage` union; added `AiChatPanelRegenerate` to `AiChatPanelWebviewMessage` union.
  - src/ui/aiChatPanel.ts: (a) `handleAcpNotification` now branches `sessionUpdate === "agent_thought_chunk"` → posts `{type:"thought", text:chunk}` with `token?.aborted` + chunk-shape gates; the stale "deliberately ignored" comment block at the old :1022-1027 is superseded; (b) new `handleRegenerate()` with PLAN §3 semantics (busy → ignore; trailing `[user, assistant]` pair → pop + handleSend; otherwise re-send `lastSentText`); wired into `handleMessage`. New `lastSentText` field on the panel; `handleSend` captures the trimmed text at entry.
  - src/ui/__tests__/aiChatPanelAcp.test.ts: retired the obsolete "ignores agent_thought_chunk" expectation in case #1 (PLAN §3 supersession); the new contract is owned by aiChatPanelThoughtRegen.test.ts #2/#5/#10. Replay filtering (deriveHistoryFromReplay, webview history branch, aiChatPanelResume.test.ts #3/#5) is INTACT — only the LIVE wire path changed.
  - src/ui/__tests__/aiChatPanelMessages.test.ts: added TASK-001 #1 — thought + regenerate fixtures join their respective unions (assignable); `JSON.stringify` contains no apiKey-shaped field.
TESTS_ADDED:
  - src/ui/__tests__/aiChatPanelThoughtRegen.test.ts: 10 host-side tests (#2 mid-turn forward, #3 malformed, #4 late-frame drop, #5 history/buffer invariant, #6 regenerate-busy ignore, #7 empty history no-op, #8 happy rerun, #9 regenerate-after-stop, #10 routing regression) — all mirror the FakeAcpTransport/feedAgentThoughtChunk/respondPrompt harness pattern from aiChatPanelAcp.test.ts.
VERIFICATION:
  command: npx vitest run src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts
  result: 41 pass / 0 fail (10 new + 31 acp regression)
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanelThoughtRegen.test.ts  (10 tests) 22ms
    ✓ src/ui/__tests__/aiChatPanelAcp.test.ts  (31 tests) 98ms
    Test Files  2 passed (2)
    Tests  41 passed (41)
  command: npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts
  result: 20 pass / 0 fail (added #1 thought+regenerate union membership; existing 18 still green)
  command: npm run typecheck
  result: exit 0
ISSUES: none — pre-fix RED was exactly the 4 expected failures (2× thought posts, 2× regenerate); post-fix all 41 contract tests green. Two pre-existing bundle tests in the broader suite (consolePanelBundle, agGridSmoke) fail because `dist/` is not compiled in this worktree — not a TASK-001 concern; wave-boundary compile step owns them.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report (fix round 1)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Fixed both R2 reviewer findings. Finding 1: `handleRegenerate` now strips the TASK-005 `--- Referenced context ---` marker from the popped user text before re-sending, so the normal send path re-resolves mentions fresh from the original trimmed text — eliminating the duplicated-context bug + the wire-leak of the DDL/file body inside the user prompt. Finding 2: `handleClear` (and `handleResumePick`) now reset `lastSentText`, so Regenerate after Clear or after a session reload is a true no-op.
TEST_PLAN_FOLLOWED: task §4 inline (regression tests added; RED verified before GREEN for both)
FILES_CHANGED:
  - src/ui/aiChatPanel.ts:
    - new `stripReferencedContextMarker(text)` export near `parseMentionTokens` — strips from the first `\n\n--- Referenced context ---` substring onward (returns input unchanged when absent). Pure, no I/O.
    - `handleRegenerate()` pop-pair branch now calls `await this.handleSend(stripReferencedContextMarker(poppedUserText))` instead of re-sending the augmented text verbatim.
    - `handleClear()` now sets `this.lastSentText = null` alongside `this.history = []`.
    - `handleResumePick()` now sets `this.lastSentText = null` after posting the loaded `history` batch (same stale-text exposure: a Regenerate right after a resume must not re-send the pre-resume prompt into the reloaded session).
    - `handleRegenerate` doc comment updated to document the strip-on-pop contract and the Clear/resume interaction with `lastSentText`.
  - src/ui/__tests__/aiChatPanelThoughtRegen.test.ts:
    - new `vscode.workspace.fs.readFile` stub (ENOENT) added to the vscode mock — required by `resolveMentionsForTurn`'s file-fallback path under the R4.5 #1 test.
    - new `makeMentionAdapter()` factory returning a spy DbAdapter (runQuery never called → privacy invariant holds) that resolves `@public.users` to a deterministic CREATE TABLE block via the REAL `resolveMentionsForTurn` (intra-module call → vi.mock cannot intercept it; the regression asserts the wire-level effect, not the resolver internals).
    - new describe block "fix round 4.5" with 5 tests (2 main regressions + 3 unit checks for `stripReferencedContextMarker`).
TESTS_ADDED:
  - src/ui/__tests__/aiChatPanelThoughtRegen.test.ts:
    - R4.5 #1 — send "describe @public.users" → complete turn → regenerate. Asserts the first send's prompt carries EXACTLY ONE `--- Referenced context ---` block (baseline), the second send ALSO carries EXACTLY ONE block (regression for the duplicate-context bug), `describe @public.users` survives the round-trip, the adapter factory is queried again (re-resolution actually ran), and the post-regen history tail has exactly one block per entry. RED check (fix reverted): `expected 2 to be 1 // Object.is equality` on the second-prompt block count.
    - R4.5 #2 — send "hello" → complete turn → Clear → regenerate. Asserts total session/prompt writes (across all fake transports, because Clear disposes the live ACP session and a regenerate-after-respawn would land on a NEW transport) is unchanged, no new ACP session was spawned, no runAgent call leaked through the builtin path, and `this.history` stays empty. RED check (fix reverted): `expected 2 to be 1 // Object.is equality` on total session/prompt count.
    - 3 unit checks for `stripReferencedContextMarker`: returns input unchanged when no marker; strips the marker line + everything after; does NOT strip a user-written `--- Referenced context ---` header that lacks the `\n\n` separator (so a user typing the literal header text for unrelated reasons is preserved).
VERIFICATION:
  command: npx vitest run src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelResume.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelMentions.test.ts src/ui/__tests__/aiChatPanelPrivacy.test.ts
  result: 6 files / 111 pass / 0 fail
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanelThoughtRegen.test.ts  (15 tests) 23ms
    ✓ src/ui/__tests__/aiChatPanelAcp.test.ts  (31 tests) 45ms
    ✓ src/ui/__tests__/aiChatPanelResume.test.ts  (11 tests) 20ms
    ✓ src/ui/__tests__/aiChatPanelMessages.test.ts  (20 tests) 6ms
    ✓ src/ui/__tests__/aiChatPanelMentions.test.ts  (28 tests) 7ms
    ✓ src/ui/__tests__/aiChatPanelPrivacy.test.ts  (6 tests) 4ms
    Test Files  6 passed (6)
    Tests  111 passed (111)
  command: npm run typecheck
  result: exit 0 (Wall time: 1.02 seconds)
  RED evidence (separate verification runs with the source-fix reverted):
    R4.5 #1 reverted → "expected 2 to be 1 // Object.is equality" on second-prompt block count
    R4.5 #2 reverted → "expected 2 to be 1 // Object.is equality" on total session/prompt count
ISSUES: intra-module call to `resolveMentionsForTurn` cannot be intercepted by `vi.mock("../aiChatPanel", ...)` — the resolver is called by reference inside the same module. Switched the R4.5 #1 test to drive the REAL resolver via a stub DbAdapter (privacy-preserving: `runQuery` returns no rows + never called). All assertion strength preserved: the wire-level effect (one block, not two) is what the contract requires, and that is exactly what we measure.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for R4.5 re-review


## Reviewer Verdict (fix round 1)

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/aiChatPanelThoughtRegen.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelResume.test.ts
  result: 3 files / 57 tests pass (ThoughtRegen 15, Acp 31, Resume 11) — exit 0
  command: npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts
  result: 20 tests pass — exit 0
  command: npm run typecheck
  result: exit 0 (no errors)
TEST_PLAN_COVERAGE: all-followed — both R2 findings each mapped to a wire-level regression test with real assertions (R4.5 #1: second session/prompt carries EXACTLY ONE `--- Referenced context ---` block + adapter re-resolution asserted; R4.5 #2: prompt-write count snapshotted across ALL transports pre/post Clear→Regenerate, no runAgent call, history stays empty) plus 3 pure unit checks for stripReferencedContextMarker. Fix-round RED_OUTPUT contains genuine assertion-failure output ("expected 2 to be 1"), not bare claims. package.json has no lint script; typecheck is the task's declared static gate and passed.
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ui/aiChatPanel.ts:1650 — if a user's ORIGINAL text itself contains "\n\n--- Referenced context ---", strip eats user content on regenerate; documented trade-off, negligible in practice (already noted in the helper's doc comment).
    - src/ui/__tests__/aiChatPanelThoughtRegen.test.ts:775 — block-count assertions split on the bare marker string; a user quoting the header inside their message would inflate the count. Cosmetic; same negligible-collision class as the helper itself.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Fix delta verified via git diff 97012cc..56a7b36 scoped to the regenerate/clear/resume regions (mention-parser changes in the same diff are TASK-005 scope, approved separately by ReRevT5). Thought forwarding (acp 31/31) and replay filtering (resume 11/11) regressions clean; Clear/resume lastSentText resets cannot break the Stop→Regenerate path (stop leaves lastSentText intact; only Clear/resume null it, where no-op is the correct behavior).
