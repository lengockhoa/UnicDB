# TASK-ARP06-003 — Usage transport: missing/malformed safe, final usage once, no body retained (provider)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3/§4 (ARP-06.3)

## Goal

Pin the provider usage transport: missing/malformed usage is safe (`{0,0}`, never a throw/NaN), streaming
emits final usage once (last chunk, never summed), and the response body is never retained for accounting.

## Target Files

- `src/ai/provider.ts` — production logic change ONLY if a pin proves a gap (RED first); the
  transport-normalized usage shape stays `usage: { inputTokens: number; outputTokens: number }`.
- `src/ai/__tests__/provider.test.ts` — extend with the usage-transport pins.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | chat/completions usage parsed | `usage: { inputTokens: 10, outputTokens: 5 }` | `usage: { prompt_tokens: 10, completion_tokens: 5 }` |
| 2 | edge: missing | absent usage → normalized zeros | both `parseChatCompletionsResponse` and `parseResponsesResponse` → `usage {0,0}` (transport value; semantic "unknown" applied by ARP-06.4) | response with no `usage` object |
| 3 | edge: malformed | non-numeric/negative usage → 0, never a throw / never NaN | `prompt_tokens:"x"`, `completion_tokens:null`, negative values → `0`/`{0,0}`; parse returns, no `ProviderError`, no `NaN` | malformed `usage` fields |
| 4 | edge: streaming | final usage emitted once | two `usage` chunks in one stream → result usage = LAST chunk (7/5), NOT the sum (12/9) | SSE with `usage` in two chunks |
| 5 | edge: streaming abort | aborted/malformed stream never invents usage | mid-stream abort or garbage events → `{0,0}`, no hang, no invented number | SSE ending with a malformed event / abort |
| 6 | edge: retention | response body never retained for accounting | a successful parse result exposes only `text/toolCalls/finishReason/usage`; a `ProviderError` carries only the scrubbed ≤300-char `bodySnippet` (never the full raw body) | success + error responses |

## Test Files

- `src/ai/__tests__/provider.test.ts` — extended (tests above). Existing suite already pins happy-path
  usage for both parsers and streaming usage-from-last-chunk; the new cases add the missing/malformed,
  final-once, abort, and retention pins.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/provider.test.ts
npm run typecheck
npm run compile
```

No lint script exists — `npm run typecheck` is the static gate. Selection per RULES: `provider.ts` →
tests-map `[provider.test.ts, aiSqlCompletionProvider.test.ts, …]` — the pinned target is
`provider.test.ts` (the others are sibling suites covered in the cycle `npm test` net).

## Acceptance Criteria

- [ ] Tests 2-3 pass: missing/malformed usage is always `{0,0}`/`0`, never a throw, never `NaN`.
- [ ] Test 4 passes: streaming final usage = the last usage chunk, never the sum (final usage once).
- [ ] Test 5 passes: aborted/malformed stream never invents usage.
- [ ] Test 6 passes: no raw response body is retained for accounting (only the scrubbed ≤300-char
      `bodySnippet` on error).
- [ ] RED evidence pasted before any production change; production logic changed ONLY if a pin was RED.
- [ ] `scrubApiKey`/redaction behavior not weakened; no new response-body retention introduced.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — pins today's exported contract).
- Produces:
  - `ProviderResult { text: string; toolCalls: ToolCall[]; finishReason: "stop" | "tool_calls" |
    "length" | "other"; usage: { inputTokens: number; outputTokens: number } }` (unchanged — the
    transport-normalized `{0,0}` for missing data is the contract ARP-06.4's accounting treats as
    "unknown").
  - `parseChatCompletionsResponse(json: unknown): ProviderResult`;
    `parseResponsesResponse(json: unknown): ProviderResult`;
    `createProviderClient(opts).streamComplete(req, opts): Promise<ProviderResult>` (unchanged unless a
    pin forces a fix — if so, recorded here in the Discussion).

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
