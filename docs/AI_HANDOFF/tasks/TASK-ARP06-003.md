# TASK-ARP06-003 — Usage transport: missing/malformed safe, final usage once, no body retained (provider)

- Status: `pending_review`
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

### Executor decision note (implementation)

- Production change was required: RED pins proved negative/NaN/Infinity usage passed through in
  `parseChatCompletionsResponse`, `parseResponsesResponse`, and the streaming usage path.
- Fix: single `tokenCount()` guard (finite + non-negative number, else 0) applied at all 4 usage
  read sites (2 parsers + 2 stream sites). Streaming semantics unchanged: last valid usage chunk
  wins (never summed); a malformed usage chunk no longer clobbers an earlier good reading — it is
  skipped, so usage is `{0,0}` only when no valid usage ever arrived (never invented).
- One test-side fix during RED triage: `Object.keys(ProviderError)` also lists `name` (the Error
  label set in the constructor) — the retention pin expectation was adjusted to include it; it is
  not response-body retention.
- Retention verified already safe pre-change (no raw body on `ProviderResult`/`ProviderError`).
- `scrubApiKey` untouched.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Claude:feature-implementer

RED_OUTPUT: |
  npx vitest run src/ai/__tests__/provider.test.ts (before production change):
   Test Files  1 failed (1)
        Tests  4 failed | 30 passed (34)
   ❯ usage transport — malformed usage → 0, never throw, never NaN (#T3.3) > chat parser: string/null/negative/NaN/non-object usage → {0,0}
     → expected { inputTokens: -5, outputTokens: -2 } to deeply equal { inputTokens: +0, outputTokens: +0 }
     ❯ src/ai/__tests__/provider.test.ts:713:26
   ❯ usage transport — malformed usage → 0, never throw, never NaN (#T3.3) > responses parser: string/negative/null usage → {0,0}, no ProviderError, no NaN
     → expected { inputTokens: -7, outputTokens: -1 } to deeply equal { inputTokens: +0, outputTokens: +0 }
     ❯ src/ai/__tests__/provider.test.ts:730:26
   ❯ usage transport — aborted/malformed stream never invents usage (#T3.5) > stream with garbage usage values (negative/string usage objects) → usage {0,0}
     → expected { inputTokens: -3, outputTokens: +0 } to deeply equal { inputTokens: +0, outputTokens: +0 }
     ❯ src/ai/__tests__/provider.test.ts:784:26
   ❯ usage transport — no response body retained for accounting (#T3.6) > ProviderError carries only the scrubbed ≤300-char bodySnippet, never the full raw body
     → expected [ 'bodySnippet', 'endpoint', …(3) ] to deeply equal [ 'bodySnippet', 'endpoint', …(2) ]
     ❯ src/ai/__tests__/provider.test.ts:857:38
     (4th failure was a test-side over-strict expectation: `name` is an own property of
     ProviderError set in its constructor, not a retention gap — expectation corrected, re-confirmed
     RED on the 3 production gaps before the fix.)

Verification Output: |
  1) npx vitest run src/ai/__tests__/provider.test.ts
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-arp06-003
     ✓ src/ai/__tests__/provider.test.ts  (34 tests) 10ms
     Test Files  1 passed (1)
          Tests  34 passed (34)
       Start at  06:11:24
       Duration  201ms
     (exit 0)

  2) npm run typecheck
     > vsdb@1.41.0 typecheck
     > tsc --noEmit
     (exit 0)

  3) npm run compile
       dist/extension.js      5.3mb ⚠️
       dist/extension.js.map  9.2mb
     ⚡ Done in 146ms
     esbuild: build complete
     (exit 0)

Status: PASS
Note: |
  Streaming last-usage-chunk-wins and body-retention were already safe on base (tests 1-2 of RED
  run passed those pins GREEN-on-base, as the task anticipated for existing coverage). The only
  production gap was malformed (negative/NaN/Infinity) usage acceptance; fixed via `tokenCount()`
  guard at all 4 usage read sites in src/ai/provider.ts. Malformed usage chunk now skipped (does
  not clobber an earlier valid reading; never summed, never invented). scrubApiKey untouched; no
  new body retention; no files outside Target Files touched; no git commands run.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/provider.test.ts && npm run typecheck && npm run compile
  result: 34 pass / 0 fail; typecheck exit 0; compile exit 0
TEST_PLAN_COVERAGE: all-followed (tests 1-6 present; malformed cases cover string/null/negative/NaN/Infinity/non-object; retention asserts exact key sets)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ai/provider.ts:628,670 — streaming `tokenCount(...) || inputTokens` makes "last valid NON-ZERO chunk wins", not strict "last chunk wins": a genuine final usage chunk of 0/0 keeps the earlier value. Deviates only when a provider emits a real final 0 after a positive mid-stream value; never invents (both values were provider-reported). Acceptable; a one-line comment would remove the surprise.
NEXT_STATUS_FOR_INDEX: approved
NOTES: tokenCount guard confirmed at all 4 usage read sites (2 parsers + SSE main loop + trailing-buffer flush). RED evidence real (negative/NaN/Infinity passed through pre-fix). Retention verified: ProviderResult exposes only text/toolCalls/finishReason/usage; ProviderError `name` is the constructor-set Error label, not a body-retention gap (matches the corrected test expectation). scrubApiKey untouched; no new body retention.
