# TASK-AIX03-103 — Tool-result attribution in the redacted audit trace

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX03.md` §3 (attribution axis)

## Goal

Give each recorded builtin tool event a stable, audit-correlatable provider identity
without weakening secret redaction. Real provider ids exceed the existing 24-character
opaque-token threshold, so encode them in a narrowly allowlisted audit-correlation
field before the final export redaction pass.

## Target Files

- `src/ai/agent.ts` — record `toolCallId: \`tcid:${call.id}\`` on both
  `tool_start` and `tool_end` payloads.
- `src/ai/trace.ts` — add the field-specific audit-correlation allowlist: a
  `toolCallId` string beginning with the exact `tcid:` marker bypasses only
  `LONG_RUN_RE`; every other recursive redaction rule remains active.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `tool_start` carries marked correlation id | `tool_start.payload.toolCallId === "tcid:c1"` | tool call id `"c1"` |
| 2 | happy | `tool_end` carries the SAME marked correlation id | `tool_end.payload.toolCallId === "tcid:c1"` | same turn |
| 3 | edge (attribution/order) | two tool calls in one turn keep distinct marked ids | `toolCallId` values are exactly `"tcid:c1"`, `"tcid:c2"`, in start/end order | two `toolCalls` in one step |
| 4 | edge (redaction/real provider id) | `tcid:`-marked OpenAI-format id survives audit export | JSON contains exactly `"tcid:call_abcdefghijklmnopqrstuvwxyz"` (31-character provider id plus marker) and not `<redacted>` at that field | `TraceRecorder` + `serializeAuditExport` with `toolCallId: "tcid:call_abcdefghijklmnopqrstuvwxyz"` |
| 5 | edge (redaction containment) | unmarked ≥24-character opaque run remains scrubbed | `toolCallId: "call_abcdefghijklmnopqrstuvwxyz"` becomes `<redacted>`; marker is required for the exemption | `TraceRecorder` + `serializeAuditExport` |
| 6 | regression | `tool_start.argsJson` still redacts secret-shaped content | `argsJson` contains `<redacted>` when arguments embed `sk-live-abcdefghijklmnop`; marked id remains visible | builtin tool call with secret-shaped arguments |

## Test Files

- `src/ai/__tests__/agent.test.ts` — cases 1–3 and 6; extend both existing
  duplicate `runAgent trace` describe blocks at lines 583 and 638 so either
  surviving block asserts the same contract.
- `src/ai/__tests__/auditExport.test.ts` — cases 4–5 against the final audit
  serialization boundary.
- `src/ai/__tests__/trace.test.ts` — field-specific `redact()` allowlist unit
  coverage if the existing redaction test layout exposes it.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/auditExport.test.ts src/ai/__tests__/trace.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `runAgent` records both `tool_start` and `tool_end` with
      `payload.toolCallId === \`tcid:${call.id}\``; the marker is part of the
      stored/exported correlation id.
- [ ] `src/ai/trace.ts` exempts only a `toolCallId` value prefixed `tcid:` from
      `LONG_RUN_RE` (currently `/[A-Za-z0-9_+/=-]{24,}/g`, which redacts runs
      of 24 or more characters). The exemption does not alter key-level,
      bearer, basic, key-value, or unmarked long-run redaction.
- [ ] A 31-character realistic OpenAI-shaped provider id
      `call_abcdefghijklmnopqrstuvwxyz` remains present only as
      `tcid:call_abcdefghijklmnopqrstuvwxyz` in exported JSON; the equivalent
      unmarked value remains `<redacted>`.
- [ ] The additive field does not bump `AUDIT_EXPORT_VERSION` (stays `1`).
- [ ] `npm run typecheck` exits 0 and `npm run compile` succeeds.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `ToolCall = { id: string; name: string; argumentsJson: string }` from
    `src/ai/provider.ts`.
  - `TraceRecorder.record(turnId: string, kind: TraceKind, payload: unknown): TraceEvent`
    from `src/ai/trace.ts`.
  - Existing `src/ai/agent.ts` payloads: `tool_start` → `{ name, argsJson }`;
    `tool_end` → `{ name, isError }`.
  - `LONG_RUN_RE = /[A-Za-z0-9_+/=-]{24,}/g` in `src/ai/trace.ts:54`, applied
    by the final recursive redaction pass.
- Produces: additive `toolCallId: \`tcid:${call.id}\`` on both trace events.
  The `tcid:` marker is a narrow audit-correlation allowlist key, not a general
  string bypass; audit export schema version remains 1.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Source grounding: `src/ai/agent.ts:314,322` mint the two trace payloads from
`call.id`, while `src/ai/trace.ts:54,91–102` redacts every 24+-character opaque
run. Therefore unmarked real provider ids would be exported as `<redacted>`.
The pinned `tcid:` field-specific exemption preserves correlation while leaving
all ordinary long runs and secret-shaped arguments redacted.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: ```
Test Files  3 failed (3)
Tests  9 failed | 62 passed (71)

Failures (representative):
- agent.test.ts: tool_start/tool_end payload.toolCallId is undefined; expected "tcid:c1"
- agent.test.ts: two tool calls -> [undefined, undefined]; expected ["tcid:c1","tcid:c2"]
- auditExport.test.ts: tcid:call_abcdefghijklmnopqrstuvwxyz scrubbed to "tcid:<redacted>"; marker exemption not in place
- trace.test.ts: redact({ toolCallId: "tcid:call_abcdefghijklmnopqrstuvwxyz" }) -> "tcid:<redacted>"; marker exemption missing
```
Verification Output: focused suites (agent.test.ts + auditExport.test.ts + trace.test.ts) -> 71/71 pass; full src/ai suite -> 505/505 pass (2 skipped, pre-existing); npm run typecheck -> exit 0; npm run compile -> esbuild build complete (dist/extension.js + dist/webview.js + dist/aiChatPanel.js).
Status: PASS
Note: Added narrow field-specific redaction allowlist (key="toolCallId" AND value startsWith "tcid:") that skips only LONG_RUN_RE; AUDIT_EXPORT_VERSION unchanged at 1; both duplicate describe blocks in agent.test.ts extended in lockstep.
