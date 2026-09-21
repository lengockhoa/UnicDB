# TASK-CHATUX-W5-2 — W5 perf: ≤30fps stream paint + memoized markdown blocks

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-009, FR-010 (§5); state machine §7.2; API §8.5–§8.6; edge cases §10

## Goal

Close the performance half of the advisor W5 audit: cap streaming transcript
paints at ≤30fps (today rAF ≈ 60fps) and memoize rendered markdown blocks so
a streaming repaint only rebuilds the tail block instead of every block in
the message.

## Target Files

- `webview/aiChat/transcript.ts` — add `STREAM_PAINT_MIN_INTERVAL_MS = 33`;
  `schedulePaint` routes through the min-interval gate (SPEC §7.2); keep the
  rAF path + 100ms `STREAM_PAINT_FALLBACK_MS` fallback intact. Also owns any
  aria fixes in transcript nodes surfaced by W5-1's audit (Discussion).
- `webview/aiChat/markdown.ts` — `renderMarkdownInto` memoizes block DOM per
  root via `WeakMap<HTMLElement, { keys: string[]; nodes: HTMLElement[] }>`;
  block key = serialized `kind|level|lang|text/code`; unchanged key → reuse
  the cached node (re-append in place); changed → `createBlockElement`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (throttle) | burst coalescing | 5 `schedulePaint`-triggering updates inside <33ms produce exactly 1 flush / 1 `renderMarkdownInto` call (fails today — rAF path allows per-frame paints) | transcript renderer + fake timers, streaming assistant item |
| 2 | edge (boundary) | interval boundary | a second update ≥33ms after the last flush schedules via the rAF path (not the timeout path) | fake timers advanced exactly 33ms |
| 3 | edge (jsdom/no-rAF) | fallback preserved | with `requestAnimationFrame` undefined, paints still flush via setTimeout | jsdom env without rAF |
| 4 | regression (memoization) | node identity | second `renderMarkdownInto(root, raw')` where only the last paragraph grew reuses the SAME element object for unchanged blocks (fails today — `replaceChildren` rebuilds all) | jsdom root, two raws sharing a prefix block |
| 5 | happy | changed tail rebuilds | modified/added blocks render correct text; block order preserved | same fixture, assert `textContent` |
| 6 | edge (state survival) | code-block copy survives repaint | a `Copy` button listener on a reused `-codeblock` node still fires after a second paint | `renderMarkdownInto` twice, click copy, clipboard spy |
| 7 | edge (isolation) | per-root cache | two different roots rendering the same raw get DISTINCT node objects | two jsdom roots |

## Test Files

- `webview/aiChat/__tests__/transcript.test.ts` — extend, cases 1–3.
- `webview/aiChat/__tests__/codeBlock.test.ts` — extend, cases 4–7 (it
  already owns markdown DOM assertions; create it if absent — check first).

## Verification Commands

```bash
npx vitest run webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/codeBlock.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for #1 and #4).
- [ ] `STREAM_PAINT_MIN_INTERVAL_MS === 33` exported; rAF + 100ms fallback preserved.
- [ ] `renderMarkdownInto` reuses unchanged block nodes (identity-pinned); per-root isolation.
- [ ] No `innerHTML`; escape-first contract intact; `extractSqlFences` unchanged.
- [ ] No regression in `webview/aiChat/__tests__/`.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - `STREAM_PAINT_MIN_INTERVAL_MS: 33` — `webview/aiChat/transcript.ts`
  - `renderMarkdownInto(root: HTMLElement, raw: string): void` — same
    signature, memoized internals (`webview/aiChat/markdown.ts`)

---

## Discussion

### 2026-09-21 · planner · unic-smart
Memoization key: serialize `block.kind + "|" + (level??"") + "|" +
(lang??"") + "|" + (text ?? code)`. Position matters — compare
index-by-index against the cached key array; a mismatch at index i rebuilds
from i onward is NOT required (simplest correct rule: reuse per-index on
key match, rebuild that index otherwise). Reused nodes keep their
listeners — that is the point (code-block Copy state survives).
`pendingPaint` already maps record→latest raw; the throttle only changes
WHEN `flushPending` runs, never what it paints.

## Progress

- 2026-09-21T21:26+07:00 · milestone: green-verify · last-green: vitest transcript+codeBlock 43/43, aiChat dir 450/450, tsc --noEmit clean · files: webview/aiChat/transcript.ts, webview/aiChat/markdown.ts, webview/aiChat/__tests__/transcript.test.ts, webview/aiChat/__tests__/codeBlock.test.ts · drift: none

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecW52
SUMMARY: Capped streaming transcript paints at ≤30fps via STREAM_PAINT_MIN_INTERVAL_MS=33 gate in schedulePaint (throttled flushes defer through a remainder timeout; rAF + 100ms fallback preserved) and memoized renderMarkdownInto per root via WeakMap keyed on kind|level|lang|text/code so unchanged blocks reuse the same DOM node.
TEST_PLAN_FOLLOWED: task §Test Cases — all 7 cases implemented (1-3 in transcript.test.ts, 4-7 in codeBlock.test.ts)
FILES_CHANGED:
  - webview/aiChat/transcript.ts: STREAM_PAINT_MIN_INTERVAL_MS export, throttleHandle + lastFlushAt gate in schedulePaint, cancelScheduled covers throttle timer, contract comment updated
  - webview/aiChat/markdown.ts: RenderedBlocks WeakMap cache + blockKey serializer; renderMarkdownInto reuses unchanged block nodes per root
  - webview/aiChat/__tests__/transcript.test.ts: W5-2 describe block (export pin, burst coalescing, 33ms boundary, no-rAF fallback); existing burst test updated to deferred-flush contract; afterEach adds useRealTimers
  - webview/aiChat/__tests__/codeBlock.test.ts: W5-2 describe block (node identity, tail rebuild, Copy listener survival, per-root isolation)
TESTS_ADDED:
  - webview/aiChat/__tests__/transcript.test.ts: "exports STREAM_PAINT_MIN_INTERVAL_MS === 33", "#1 burst coalescing", "#2 interval boundary", "#3 fallback preserved"
  - webview/aiChat/__tests__/codeBlock.test.ts: "#4 node identity", "#5 changed tail rebuilds", "#6 code-block Copy listener survives", "#7 per-root cache"
RED_OUTPUT: |
  FAIL codeBlock.test.ts > #4 node identity: unchanged blocks reuse the SAME element object
  FAIL codeBlock.test.ts > #6 code-block Copy listener survives a repaint on a reused node
  FAIL transcript.test.ts > exports STREAM_PAINT_MIN_INTERVAL_MS === 33 (expected undefined to be 33)
  FAIL transcript.test.ts > #1 burst coalescing (expected "replaceChildren" to be called 1 times, but got 5 times)
  Test Files 2 failed (2) — Tests 4 failed | 39 passed (43)
VERIFICATION:
  command: npx vitest run webview/aiChat/__tests__/transcript.test.ts webview/aiChat/__tests__/codeBlock.test.ts
  result: 43 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ webview/aiChat/__tests__/codeBlock.test.ts (11 tests) 21ms
    ✓ webview/aiChat/__tests__/transcript.test.ts (32 tests) 165ms
    Test Files 2 passed (2)
    Tests 43 passed (43)
  command: npm run typecheck
  result: exit 0 (tsc --noEmit clean)
  command: npx vitest run webview/aiChat/__tests__/
  result: 450 pass / 0 fail / exit 0 (24 files — no regression)
ISSUES: none — one existing test ("coalesces a delta burst") updated to the new deferred-flush contract; node_modules symlinked from main checkout for vitest (untracked)
HANDOFF_TO_REVIEWER: yes — task status set to pending_review in INDEX.md
NEXT: ready for review
