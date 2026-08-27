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
