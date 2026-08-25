# TASK-007 — AI chat: turn never settles, blank bubbles, dead Stop, dead Resume, leaked child, schema cost

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.6 (B1, B2, B5, B6, B7, B9, B14) — §7 Global Constraints applies by reference

## Goal

Make one omp chat turn work end to end. This is the "chat does not work at all" task.

- **B1** — `runAcpTurn` (`src/ui/aiChatPanel.ts:574-579`) awaits a `session/update` whose
  `sessionUpdate` is `"agent_end"` or `"turn_complete"` (`:692`). Those are cycle-L `--mode rpc`
  names; ACP never emits them (real kinds: `user_message_chunk`, `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`,
  `session_info_update` — `docs/AI_HANDOFF/queue/ACP-SESSION-research.md:12,16`). Completion is
  the `session/prompt` **response** `{stopReason:"end_turn"}`, which `:570` discards. Result: no
  `assistant`, no `done`, webview busy forever (`webview/aiChatPanelMain.ts:158-163`).
- **B2** — streamed text is read from `update.delta` (`:682`) but ACP `agent_message_chunk`
  carries `content: {type:"text", text}` — the same file already uses that envelope at `:927`.
  Blank bubbles. Same bug in `deriveHistoryFromReplay` (`:918`) ⇒ resumed sessions show no
  assistant text.
- **B5** — Stop (`:825-838`) flips `token` and cancels permissions but never resolves
  `acpTurnResolvers`, never posts `done`, never sends ACP `session/cancel`: the UI stays busy and
  omp keeps generating.
- **B6** — `this.token` is never reset to `null` after a turn (only `handleClear:858` does), so
  both resume guards (`:979`, `:1024`) `if (this.token !== null) return;` permanently swallow
  `resume_list` / `resume_pick` after the first message — the Resume button silently dies.
- **B7** — `onDidDispose` (`:343-349`) never calls `cancelAllPending()` / `disposeAcpSession()`:
  closing the tab leaks the `omp acp` child and leaves the `extension.ts:37` singleton holding a
  stale session with uncleared permission timers.
- **B9** — `buildMessages` (`:128-251`) re-introspects the whole database every turn (every
  schema → `listTables` + `listViews` → `listColumns` for up to 200 objects, uncached): hundreds
  of round trips per message. And in ACP mode the resulting system prompt is **discarded** —
  `runAcpTurn` sends only `text` (`:570-573`). Cache the introspection, and prepend the schema
  context to the ACP prompt so the omp path has real context.
- **B14** — the tests encode the wrong protocol and stay green while production hangs. Fix the
  fakes (see Acceptance).

## Target Files

- `src/ui/aiChatPanel.ts`
- `src/ui/__tests__/aiChatPanelAcp.test.ts`
- `src/ui/__tests__/aiChatPanelResume.test.ts`
- `src/ui/__tests__/aiChatE2e.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | full ACP turn | fake streams `agent_message_chunk` with `content.text` = `"Hi"`, then the `session/prompt` response resolves `{stopReason:"end_turn"}` ⇒ posts `delta("Hi")`, `assistant("Hi", markdown:true)`, `done` — in that order, exactly once each |
| Happy | history append | after the turn, `history` ends with `{role:"assistant", content:"Hi"}` |
| Edge (cancel stopReason) | response `{stopReason:"cancelled"}` | `done` posted, **no** assistant history entry |
| Edge (concurrency) | Stop pressed mid-stream | `session/cancel` sent once, pending resolvers settle, `done` posted exactly once, no late `assistant` after `done` |
| Edge (state reset) | second turn after a completed first | `token === null` between turns; `resume_list` is handled, not swallowed |
| Edge (lifecycle) | panel disposed mid-turn | `cancelAllPending()` + `disposeAcpSession()` called; no pending permission timer survives |
| Edge (empty stream) | zero chunks, then `end_turn` | `assistant("")` is **not** posted as a blank bubble; `done` still posted |
| Edge (cache) | two turns, same connection | schema introspection runs once, not twice |
| R (B1) | prompt response only, no `agent_end` notification | today: hangs, no `assistant`, no `done` |
| R (B2) | chunk with `content.text` and no `delta` | today: blank bubble |
| R (B5) | Stop | today: no `session/cancel`, no `done` |
| R (B6) | `resume_list` after one turn | today: swallowed by the `token !== null` guard |
| R (B7) | dispose | today: child leaked |
| R (B9) | ACP prompt payload | today carries only the raw user text; after fix it carries the schema context |

## Test Files

- `src/ui/__tests__/aiChatPanelAcp.test.ts` (extend — turn lifecycle, stop, cancel, dispose)
- `src/ui/__tests__/aiChatPanelResume.test.ts` (**fix the fakes** — `:881` hand-feeds
  `{sessionUpdate:"agent_end"}`; replay fakes supply `delta` instead of `content.text`)
- `src/ui/__tests__/aiChatE2e.test.ts` (extend — one end-to-end turn reaching `assistant` + `done`)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ui/__tests__/aiChatPanelAcp.test.ts
npm test -- src/ui/__tests__/aiChatPanelResume.test.ts
npm test -- src/ui/__tests__/aiChatE2e.test.ts
npm test -- src/ui/__tests__/aiChatPanel.test.ts
npm test -- src/ui/__tests__/aiChatPanelMessages.test.ts
npm test -- src/ui/__tests__/aiChatPanelWebview.test.ts
npm test -- src/ai/__tests__/agent.test.ts
```

## Acceptance Criteria

- [ ] All 14 cases pass; each regression case confirmed failing on `main` first, with the failing
      output pasted into this task's report.
- [ ] **Test-fake correction is explicit and verifiable:** `grep -rn "agent_end\|turn_complete"
      src/ui/__tests__/` returns no fake that *drives* a turn (a negative-path assertion that an
      unknown kind is ignored is acceptable and must be labelled as such), and no ACP fake in
      these files supplies `delta` for `agent_message_chunk`. State in the report that the
      regression tests were run against the **corrected** fakes.
- [ ] The turn settles on the `session/prompt` response; the notification resolver remains only
      as a belt and cannot double-post `assistant`/`done` (`turnDonePosted` still guards).
- [ ] Every `stopReason` other than `end_turn` is handled explicitly (at minimum `cancelled`,
      `refusal`, `max_tokens`) — no silent fallthrough.
- [ ] `this.token` is reset to `null` on every turn exit path (success, error, abort) — assert in
      a test, not by inspection.
- [ ] `onDidDispose` cancels pending permissions and disposes the ACP session.
- [ ] Schema introspection is cached (keyed by connection identity) and invalidated on connection
      change; the ACP prompt carries the schema context.
- [ ] Builtin-engine behavior is unchanged (its tests stay green untouched).
- [ ] `npm run typecheck` clean.

## Dependencies

- (none)

## Interfaces

- Consumes (existing, unchanged this wave):

```ts
// src/ai/omp/acp.ts
export class AcpClient {
  request(method: string, params: unknown): Promise<unknown>;
  // session/prompt response shape (ACP): { stopReason: "end_turn" | "cancelled" | ... }
}
// src/ai/omp/acpProcess.ts
export interface AcpProcessHandle { acp: AcpClient; sessionId: string; version: string; dispose: () => void; }
```

- Produces:

```ts
// src/ui/aiChatPanel.ts — internal, but relied on by TASK-011 (banner) and TASK-012 (tools)
export type EngineKind = "builtin" | "omp";
export interface AiChatPanelOptions {
  extensionUri: unknown;
  deps: AgentDeps;
  adapterFactory: AdapterFactory;
  acp?: AcpPanelDeps;   // unchanged this wave
}
```

ACP `session/update` envelope this task must consume (from
`docs/AI_HANDOFF/queue/ACP-SESSION-research.md:12`):

```ts
{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: string }, messageId?: string }
```

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

Do not touch `src/extension.ts`, `src/ai/omp/acpProcess.ts` or `webview/aiChatPanelMain.ts` in
this task — they belong to TASK-006 and TASK-011. In particular the engine **banner** (B8) and the
zero-config open gate (B3) are TASK-011's, even though they live partly in this file: TASK-011
runs in a later wave and owns `aiChatPanel.ts` then.

The turn currently has two independent hang paths: this one (resolver never fires) and TASK-006's
(handshake never times out). Fixing only one still leaves a permanent spinner in the other
scenario — the E2E test here should use a fake that settles the handshake immediately so the two
remain separable.

`agent_thought_chunk` must continue to be ignored entirely (never rendered, never buffered) — that
is a deliberate existing behavior, not an oversight.

---
