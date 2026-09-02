# TASK-ARP09-004 — Redaction-reuse gate (verify-first)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (09.4) — wave 2

## Goal

PROVE by source evidence that ARP-09 reuses — and does not re-implement or bypass — the existing AI redaction: (a) `src/core/diagnostics.ts` imports and actually calls `redact()` from `src/ai/trace.ts`; (b) it contains NO copy of a secret scrubber; (c) `src/ai/auditExport.ts`'s final-pass redaction is byte-intact; (d) the 003 channel wiring has no unredacted write path — every `appendLine` argument is a logLine-formatted (redacted) string (direct matches at 003's flush site are expected by design; `appendLine(<raw>)` of user/provider/connection content is the failure mode). Expected close: **NOT-NEEDED** (no `trace.ts`/`auditExport.ts` source change) with recorded evidence — mirroring the ARP-04-004 / ARP-05-004 precedent. If evidence surfaces a real bypass, fix it within this task's file set (003's `extension.ts` seam) — never change `trace.ts`.

## Target Files

- `src/ai/__tests__/trace.test.ts` — append a READ-ONLY evidence `describe("ARP-09 diagnostics reuse", ...)` block (asserting source-shape facts about `src/core/diagnostics.ts`/`auditExport.ts`); do not alter existing redact/TraceRecorder tests.
- `docs/AI_HANDOFF/PLAN.md` §Planner Self-Audit `Known gaps` — append the evidence note (or record in this task's Discussion) when closing NOT-NEEDED.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 25 | happy (source evidence) | read `src/core/diagnostics.ts` source | contains an import of `redact` from `../ai/trace` (or `../../ai/trace`) AND at least one `redact(` call reachable from `logLine` | file exists (001 landed, wave 1) |
| 26 | edge (no re-implementation) | source scan of `src/core/diagnostics.ts` | NO copy of a secret scrubber: no `/Bearer\s+/` or `/Basic\s+/` regex literal, no `new RegExp(` secret pattern in the file | source read |
| 27 | edge (applied, not imported-only) | run 001's secret cases (PLAN §4 rows 3-4) | scrubbed output — the import is actually used, not dead | `diagnostics.test.ts` |
| 28 | edge (auditExport intact) | `git diff --stat src/ai/auditExport.ts src/ai/trace.ts` | empty; `serializeAuditExport` still returns `JSON.stringify(redact(buildAuditEnvelope(...)))` | working tree |
| 29 | edge (no bypass in wiring) | grep channel-write sites in `src/extension.ts` | every `appendLine` argument is logLine-formatted (REDACTED) — redaction reused, NO raw unformatted writes of user/provider/connection content; an `appendLine(<raw>)` anywhere is a FAIL (direct matches at 003's flush site are expected by design and must be redacted logLine output) | source grep |

## Test Files

- `src/ai/__tests__/trace.test.ts` — the evidence describe appended (read-only; existing tests untouched).
- `src/core/__tests__/diagnostics.test.ts` — consumed for cross-check #27 (owned by 001; not modified here).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ai/__tests__/trace.test.ts src/core/__tests__/diagnostics.test.ts
git diff --stat src/ai/auditExport.ts src/ai/trace.ts
grep -n "redact" src/core/diagnostics.ts
grep -n "appendLine" src/extension.ts   # matches at 003's flush site are EXPECTED and must be redacted logLine output (evidence #29)
```

## Acceptance Criteria

- [ ] Evidence #25-#29 all pass and are recorded (Discussion or PLAN Known gaps).
- [ ] `git diff` on `src/ai/trace.ts` and `src/ai/auditExport.ts` is empty (or whitespace-only) — no source change.
- [ ] Task closes as `done` with status NOT-NEEDED (no code change) OR with a minimal fix confined to 003's `extension.ts` seam if a real bypass is found.
- [ ] `npm run typecheck` and the focused vitest run exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-ARP09-001 must complete first (`src/core/diagnostics.ts` must exist to verify the import) and TASK-ARP09-003's wiring must be present to check #29 (same wave 2; if 003 hasn't landed when this task starts, gate #29 on 003's diff and record the dependency in Discussion).

## Interfaces

- Consumes: `src/core/diagnostics.ts` (001) — its `redact` import/calls; `src/ai/trace.ts` `redact` (line 57); `src/ai/auditExport.ts` `serializeAuditExport` (final-pass redact); 003's `logDiagnostic` call sites in `extension.ts`.
- Produces: evidence note; optionally one pinned source-shape assertion in `trace.test.ts`. No new runtime interface.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
