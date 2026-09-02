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

**Executor (TASK-ARP09-004, verify-first) — 2026-09-02.** Closed NOT-NEEDED: no source change; evidence pins appended to `src/ai/__tests__/trace.test.ts` (`describe("ARP-09 diagnostics reuse — TASK-ARP09-004")`, 4 tests; existing redact/TraceRecorder tests untouched; pure — no vscode import; source-reading pattern mirrors `policy.test.ts`). Evidence:

- **#25**: `src/core/diagnostics.ts` line 11 `import { redact } from "../ai/trace";`; line 45 `const scrubbed = redact(raw);` inside `toRedactedSingleLine` (line 29), which `logLine` (line 64) calls at line 74 — redaction is reachable from `logLine`, applied (not dead).
- **#26**: source scan of `diagnostics.ts` found NO secret scrubber copy — no `/Bearer\s+/` or `/Basic\s+/` regex literal, no `new RegExp(`, no `SECRET_KEY_RE`-style definitions. The only `.replace()` calls (lines 47, 53) strip `\r\n|\r|\n` line breaks — not secret-shaped tokens.
- **#27**: equivalence pin — `logLine("ai","error","Authorization: Bearer eyJhbGciOi…")` output contains exactly what `redact()` returns directly for the same input (same `<redacted>` marker shape); key=value fixture `password = 'hunter2'` likewise. (Owned runtime cases also live in `src/core/__tests__/diagnostics.test.ts` cases 3-4.)
- **#28**: `git diff --stat src/ai/auditExport.ts src/ai/trace.ts` → empty (exit 0). `auditExport.ts` line 101 `return JSON.stringify(redact(buildAuditEnvelope(dumps, exportedAt)));` intact; final-pass redact comment at lines 94-95 unchanged.
- **#29 — GATED on 003 per Dependencies**: at execution time 003 had NOT landed (branch `handoff/task-arp09-003` sits at the same wave-1 commit `6bbce53`; `git diff main...handoff/task-arp09-003` empty; `grep appendLine src/extension.ts` → no matches, `logDiagnostic` absent). Evidence recorded: there is no unredacted write path today because there is no channel write path at all; the pin asserting "every `.appendLine(` argument contains `logLine(`" is future-proof — it passes vacuously now and, when 003 lands its expected flush site, forces `appendLine(logLine(...))` shape (`appendLine(<raw>)` fails the pin).
- No bypass found anywhere → no fix required; `trace.ts` and `auditExport.ts` untouched by this task.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

- Status: `done` — closed **NOT-NEEDED** (verify-first; no source change; expected close per ARP-04-004 / ARP-05-004 precedent)
- Executor model: `unic-code` (claude-code, feature-implementer subagent)
- Date: 2026-09-02

### RED phase

N/A — verify-first task (no behavior change to RED-test). The 4 evidence pins are read-only source-shape assertions appended to an existing green suite; they passed on first run against the landed wave-1 state, which is the expected outcome for an evidence gate (a pin failing here would have meant a real bypass, which was not found).

### Evidence (Test Cases 25-29)

| # | Result | Evidence |
|---|--------|----------|
| 25 | PASS | `src/core/diagnostics.ts:11` `import { redact } from "../ai/trace";`; `:45` `redact(raw)` inside `toRedactedSingleLine` (`:29`); reachable from `logLine` (`:64`, call at `:74`). Pinned by test "diagnostics.ts imports redact from ../ai/trace and calls it in logLine's path". |
| 26 | PASS | Source scan: no `/Bearer\s+/` or `/Basic\s+/` regex literal, no `new RegExp(`, no `SECRET_KEY_RE`/`BEARER_RE`/`BASIC_RE`/`KV_RE`/`AUTH_KV_RE`/`LONG_RUN_RE` identifiers. Only `.replace()` calls (lines 47, 53) strip `\r\n|\r|\n`. Pinned by "diagnostics.ts contains no re-implemented secret scrubber". |
| 27 | PASS | `logLine("ai","error","Authorization: Bearer eyJhbGciOiJFUzI1NiIsInRlc3Q")` output contains exactly `redact()`'s direct output for the same input; `password = 'hunter2'` fixture likewise. Runtime cases 3-4 also covered by `src/core/__tests__/diagnostics.test.ts` (owned by 001). |
| 28 | PASS | `git diff --stat src/ai/auditExport.ts src/ai/trace.ts` → empty, exit 0. `auditExport.ts:101` still `return JSON.stringify(redact(buildAuditEnvelope(dumps, exportedAt)));`; final-pass comment at `:94-95` intact. |
| 29 | PASS (gated on 003 per Dependencies) | 003 NOT landed at execution time: branch `handoff/task-arp09-003` = same commit `6bbce53` as HEAD; `git diff main...handoff/task-arp09-003` empty; `grep -n appendLine src/extension.ts` → no matches; `logDiagnostic` absent. No channel write path exists → no unredacted write path. Pin "every appendLine argument in extension.ts is logLine-formatted" passes vacuously now and enforces `appendLine(logLine(...))` shape when 003 lands. |

### Verification Commands (fresh, this turn)

```text
$ npx vitest run src/ai/__tests__/trace.test.ts src/core/__tests__/diagnostics.test.ts
 Test Files  2 passed (2)
      Tests  50 passed (50)   [trace.test.ts: 41 (was 37, +4 evidence pins); diagnostics.test.ts: 9]
   Duration  178ms

$ npm run typecheck          → exit 0 (tsc --noEmit, clean)

$ git diff --stat src/ai/auditExport.ts src/ai/trace.ts
(empty output, exit 0 — no source change)

$ grep -n "redact" src/core/diagnostics.ts
11:import { redact } from "../ai/trace";
45:  const scrubbed = redact(raw);
(+ doc-comment mentions at lines 2, 5, 6, 28, 43, 59)

$ grep -n "appendLine" src/extension.ts
(no matches — 003 wiring not landed; exit 1)
```

### Files changed

- `src/ai/__tests__/trace.test.ts` — +4 evidence tests in new `describe("ARP-09 diagnostics reuse — TASK-ARP09-004")` block + imports (`readFileSync`, `fileURLToPath`, `logLine` from `../../core/diagnostics`). Existing 37 tests untouched. Pure: no vscode import.
- `docs/AI_HANDOFF/tasks/TASK-ARP09-004.md` — Discussion evidence note + this report.

No source change to `src/core/diagnostics.ts`, `src/ai/trace.ts`, `src/ai/auditExport.ts`, or `src/extension.ts` (no bypass found → no fix needed).

### Test Plan Followed

Task §Test Cases 25-29 as evidence matrix; §Dependencies gate applied for #29 (003 not landed → gated on 003's diff, recorded in Discussion). RED phase N/A (verify-first; documented above).

### Issues

- None blocking. Note for 003's executor/reviewer: the new case-29 pin will actively enforce `appendLine(logLine(...))` shape once 003's flush site exists — any `appendLine(<raw>)` write will fail `trace.test.ts`.

### Handoff to reviewer

Yes — task closed NOT-NEEDED with recorded evidence; review verdict requested per acceptance criteria.
