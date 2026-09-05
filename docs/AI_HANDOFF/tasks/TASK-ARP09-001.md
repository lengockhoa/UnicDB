# TASK-ARP09-001 — Pure redacted diagnostics formatter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§3 (09.1) — wave 1

## Goal

Create the pure, vscode-free diagnostics formatter `src/core/diagnostics.ts` (NEW): `logLine()` turns a category/severity/message (+ optional correlation id + optional timestamp) into ONE redacted, single-line string `[<ISO time>] [<category>] [<severity>] <message>` (+ ` (corr:<id>)`), with the 2000-char bound applied to the ASSEMBLED line as the last step, reusing `redact()` from `src/ai/trace.ts` (imported — never re-implemented) and never throwing on any input. This is the module every other ARP-09 task consumes.

## Target Files

- `src/core/diagnostics.ts` — (NEW) pure formatter module: `DiagCategory`, `DiagSeverity`, `MAX_DIAG_LINE_CHARS`, `logLine()`.
- `src/core/__tests__/diagnostics.test.ts` — (NEW) RED-first tests below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `logLine("connection","info","connection opened", undefined, FIXED)` | exactly `[2026-09-02T00:00:00.000Z] [connection] [info] connection opened` | `FIXED = new Date("2026-09-02T00:00:00.000Z")` |
| 2 | happy | `logLine("ai","warn","retry", "run-42", FIXED)` | prefix `[2026-09-02T00:00:00.000Z] [ai] [warn] retry` and ends ` (corr:run-42)` | correlation id present |
| 3 | edge (secret) | `logLine("ai","error", 'provider failed: Authorization: Bearer eyJhbGciOiJFUzI1NiIs…', undefined, FIXED)` | output contains `<redacted>`, does NOT contain the bearer token substring | redact() must scrub BEARER_RE |
| 4 | edge (KV-in-SQL) | `logLine("general","warn","SELECT * FROM users WHERE password = 'hunter2'")` | output does NOT contain `hunter2`; contains `password<redacted>` | redact() KV_RE scrubs `password = '…'` |
| 5 | edge (multiline) | message = `"line1\nline2\r\nline3"` | output contains zero `\n`/`\r`, is exactly one line, `trim()`-equal to itself | single-line invariant |
| 6 | edge (length bound) | 5000-char message (`"x".repeat(5000)`) | ASSEMBLED line `length <= 2000` (bound applied AFTER prefix + corr-suffix assembly, as the last step); prefix `[` … `]` intact; the MESSAGE tail is what gets cut | `MAX_DIAG_LINE_CHARS = 2000` asserted in test |
| 7 | edge (non-string) | `logLine("general","info",{a:1})` / `null` / `undefined` | contains `{"a":1}` / `null` / `undefined`; never throws | JSON.stringify fallback → String() |
| 8 | edge (degenerate) | `const c:any = {}; c.self = c;` → `logLine("general","info",c)` | returns a string, never throws, contains `"[object Object]"` | circular → JSON.stringify throws → String() fallback |
| 9 | happy | every category × severity accepted | for all 5 categories × 3 severities, output carries exactly `[<cat>] [<sev>]` | category/severity union contract |

## Test Files

- `src/core/__tests__/diagnostics.test.ts` — contains all 9 cases above (RED before implementation, GREEN after).

## Verification Commands

```bash
npm run typecheck
npx vitest run src/core/__tests__/diagnostics.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED-first: 1-9 fail against an empty module).
- [ ] `logLine` never throws on any input (string/number/object/null/undefined/circular).
- [ ] Output is always a single line, `[<ISO>] [<cat>] [<sev>]` prefix, ` (corr:<id>)` suffix when id given, length ≤ `MAX_DIAG_LINE_CHARS`.
- [ ] `redact` from `src/ai/trace.ts` is IMPORTED and used on every message — no re-implementation, no copied regexes.
- [ ] No `vscode` import in `src/core/diagnostics.ts` (pure, unit-testable).
- [ ] `npm run typecheck` and the focused vitest run exit 0.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — first task of the cycle.

## Interfaces

- Consumes: `redact(value: unknown): unknown` from `src/ai/trace.ts` (line 57; pure, recursive, never throws — import, don't copy).
- Produces:
  ```ts
  export type DiagCategory = "lifecycle" | "connection" | "ai" | "schema" | "general";
  export type DiagSeverity = "info" | "warn" | "error";
  export const MAX_DIAG_LINE_CHARS = 2000;
  export function logLine(
    category: DiagCategory,
    severity: DiagSeverity,
    message: unknown,
    correlationId?: string,
    now?: Date, // test seam — defaults to new Date()
  ): string;
  ```
  Line shape: `[<ISO 8601 from now|new Date()>] [<category>] [<severity>] <redacted single-line message>` plus ` (corr:<id>)` when `correlationId` is a non-empty string (id single-lined, trimmed, sliced to 64 chars). The `MAX_DIAG_LINE_CHARS` (2000) bound is applied to the FULLY ASSEMBLED line (prefix + message + corr suffix), as the last step — so `line.length <= 2000` always holds; a long message tail is what gets truncated, never the prefix.

---

## Discussion

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

- Status: `ready` → implemented, pending review
- Round: 1
- EXECUTOR_TOOL: Claude Code (Agent tool)
- EXECUTOR_MODEL: claude-sonnet-4-5 (unic-code per harness tier resolution; differs from reviewer unic-smart)
- EXECUTOR_SUBAGENT: feature-implementer

### RED (before implementation)

`npx vitest run src/core/__tests__/diagnostics.test.ts` — module missing, suite fails to load:

```
 FAIL  src/core/__tests__/diagnostics.test.ts [ src/core/__tests__/diagnostics.test.ts ]
Error: Failed to load url ../diagnostics (resolved id: ../diagnostics) in
/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-arp09-001/src/core/__tests__/diagnostics.test.ts.
Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

### GREEN + Verification

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  10:53:24
   Duration  167ms

> UnicDB@1.44.0 typecheck
> tsc --noEmit
TYPECHECK_EXIT=0
```

### Implementation notes

- `redact` is imported from `src/ai/trace.ts` (no copied regexes); every message string passes
  through it BEFORE newline-stripping, so scrub tokens stay intact on one line.
- Bound applied to the fully assembled line (prefix + message + corr suffix) as the LAST step,
  followed by `trim()`; prefix is never truncated, message tail is.
- Correlation id: single-lined, trimmed, sliced to 64 chars; empty/whitespace id → no suffix.
- Total functions + outer try/catch: never throws on null/undefined/circular/objects/invalid Date.
- No `vscode` import; pure module.

### Deviations from the literal test fixtures (recorded per handoff rules)

- Case 6 fixture `"x".repeat(5000)` is itself secret-shaped under trace.ts `LONG_RUN_RE`
  (≥24-char opaque run), so `redact()` legitimately collapses it to `<redacted>` BEFORE bounding —
  the contract's "message tail gets cut" cannot manifest with that fixture. Test asserts the
  scrubbed result exactly, then pins tail-cutting with a redact-surviving long message
  (`"x ".repeat(3000)`): length ≤ 2000 (trim of a slice-end space yields 1999, within the
  contracted `<= MAX_DIAG_LINE_CHARS`), prefix intact, tail cut.
- No other fixture was altered; cases 1-5, 7, 8, 9 are literal per §Test Cases.

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: (not self-reported — EXECUTOR_TOOL/EXECUTOR_MODEL/EXECUTOR_SUBAGENT all missing from the Executor Report)
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/diagnostics.test.ts && npm run typecheck
  result: 9 pass / 0 fail; tsc --noEmit exit 0 (fresh re-run at HEAD, clean tree)
TEST_PLAN_COVERAGE: all-followed — 9/9 cases implemented with real assertions; RED evidence is a genuine module-load failure ("Failed to load url ../diagnostics"), not a bare claim
FINDINGS:
  critical:
    - (none)
  important:
    - docs/AI_HANDOFF/tasks/TASK-ARP09-001.md:87 — Executor Report is missing the mandatory EXECUTOR_TOOL/EXECUTOR_MODEL/EXECUTOR_SUBAGENT self-report (RULES.md executor-report contract; model-isolation table: missing field → refuse). Fix: append the three fields with the real executor model (must differ from unic-smart) and re-submit. No code change required: reviewer re-verified all 9 tests green, typecheck exit 0, plus adversarial probes (lone CR, exact-2000 vs 2001 bound, corr-id newline/64-char cut, invalid-Date fallback, throwing toString/getter, circular+throwing → <diagnostics failure> fallback) all pass.
  minor:
    - (none) — the case-6 fixture deviation (5000-char x-run is LONG_RUN_RE-secret-shaped) is legitimate and documented; the added redact-surviving 6000-char probe plus the corr+overlong bound case is stronger than the contract.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation is technically clean — redact imported from ../ai/trace (no local secret regexes; the only regex is the sanctioned newline stripper), redact runs before newline-stripping, and the bound slices the ASSEMBLED line as the last step (prefix never cut). The gate fails solely on the missing model self-report; a report amendment clears it.
