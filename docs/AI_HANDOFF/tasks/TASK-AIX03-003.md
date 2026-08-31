# TASK-AIX03-003 — visible tool-call cards (panel + webview)

Cycle: AIX-03 · Wave 3 · Priority: P1
Status: pending
Depends on: AIX03-002
Reviewer: unic-smart (cycle reviewer)

## Spec

Make every DB-aware tool call VISIBLE in the thread: name, permission
decision, and a SHAPE-ONLY outcome (never row bytes).

1. `src/ai/agent.ts`: `AgentCallbacks` gains
   `onToolResult?(call: ToolCall, outcome: ToolOutcome)` where
   `ToolOutcome = { status: "ok" | "failed"; resultText: string }`.
   Fired once per executed tool call, in order, AFTER executeToolCall
   resolves. Thrown execute → failed; anything else ok.
2. `src/ui/aiChatPanel.ts` (builtin + omp mirror):
   - `onToolResult` posts `{type: "tool_result", tool, status, summary}` —
     summary = summarizeToolOutcome(tool, status, shape) where shape is
     built from the result TEXT ONLY: line count + `capped` marker when
     present, or first line trimmed via capTokens(30) (analysisReport
     helpers; SHAPE ONLY, never row bytes).
   - Gate denial: `DbToolPermissionGate.wrap` denied branch also posts a
     `tool_result` with status "denied" BEFORE returning the envelope.
3. `src/ui/aiChatPanelMessages.ts`: `AiChatPanelToolResult` message type
   {type: "tool_result"; tool: string; status: "ok" | "failed" | "denied";
   summary: string} — added to the host-message union.
4. `webview/aiChatPanelMain.ts`: `case "tool_result"` → appendToolResult()
   DOM-only card (textContent): class vsdb-chat-tool-result +
   vsdb-chat-tool-result-<status>; single compact line (no markdown).

## Acceptance

- [ ] agent tests: onToolResult fires ok + failed once per call, in
      order, after onToolCall.
- [ ] aiChatPanel tests: gate denial posts tool_result denied then
      returns envelope; happy path posts ok with shape-only summary
      (assert a known row cell value absent from the summary).
- [ ] webview bundle test: tool_result renders textContent-only card.
- [ ] `npx vitest run <targeted files>` green; existing suites unchanged.

## Executor

### Executor (unic-code)

**RED evidence**: added 3 onToolResult cases to `src/ai/__tests__/agent.test.ts` → 2 failed (callback not implemented: case #1 order assertion + case #2 status assertion) before implementing the agent change.

**GREEN evidence**: agent 19/19 (executeToolCall now returns ChatMessage & {outcome}; loop fires onToolResult AFTER execute, in order; unknown-tool/bad-args paths → failed). Panel: static toolShapeSummary (multi-line → "N lines (capped)"; one-line → capTokens 30; regex cap markers incl. "(N of M rows)"), onToolResult posts tool_result host message in builtin turn; DbToolPermissionGate denied branch posts tool_result denied before returning the envelope (gate tests 14/14 incl. 2 new); webview HostMsg union + appendToolResult (textContent only) + case branch (webview tests 5/5 incl. new card test). analysis tools registered gate-wrapped in runBuiltinTurn via createAnalysisTools. omp/MCP mirror keeps the existing visible permission bridge; its denial path shares the same gate → denial cards appear on both engines.


## Reviewer

(verdict appended by reviewer)
