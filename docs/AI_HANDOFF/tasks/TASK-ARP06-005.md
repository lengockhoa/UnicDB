# TASK-ARP06-005 — Privacy-safe policy + usage display in the chat panel (aiChatPanel)

- Status: `ready`
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
