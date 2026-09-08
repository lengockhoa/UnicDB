# TASK-CLEAN2-001 — policy.ts: drop dead `isValidEngineChoice` alias; re-verify four-value header comment

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (items #8, #1), §3

## Goal

Remove the module-private `isValidEngineChoice` alias (policy.ts:133-135) and point the
internal caller at :154 to `isEngineChoice` directly. Pre-change repository consumer evidence
is limited to the alias comment, declaration, and caller in `policy.ts`; `package.json` has no
`exports`, `types`, or `typings` field (only runtime `main: "dist/extension.js"`), so this
module-private alias is not a shipped TypeScript entry point. Re-verify (grep only, no edit)
that item #1's header comment stays landed (already fixed in 93746a4).

## Target Files

- `src/ai/policy.ts` — delete lines 133-135 (alias + comment); change :154
  `const validChoice = isValidEngineChoice(resolvedEngine);` → `isEngineChoice(resolvedEngine)`. No other change.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | existing `isEngineChoice — TASK-007 four-engine vocabulary guard` (policy.test.ts:185) | passes UNMODIFIED: builtin/omp/claude-code/codex → true; "unknown"/null/{} → false | existing suite |
| 2 | edge (consumer-check) | repository search plus package entry-point fields | pre-change `grep -rn "isValidEngineChoice" --include="*.ts" --include="*.tsx" src/ webview/ tests/` returns exactly the three `policy.ts` sites (:133 comment, :135 alias, :154 caller); `exports`, `types`, and `typings` are absent while `main` is runtime `dist/extension.js` | source tree + package.json |
| 3 | edge (grep) | `grep -c "isValidEngineChoice" src/ai/policy.ts` | 0 (today: 3 — comment x1 + alias + caller; fails before fix) | shell |
| 4 | edge (doc-consistency) | `grep -cE '"builtin" \| "omp"' src/ai/policy.ts` (stale two-value vocab claim, item #1) | 0 — header :13-15 keeps the four-value wording landed in 93746a4 | shell |

## Test Files

- `src/ai/__tests__/policy.test.ts` — regression only, MUST NOT be modified.
- `src/ui/__tests__/aiChatPanelPolicy.test.ts` — second mapped suite for policy.ts, MUST NOT be modified.

## Verification Commands

```bash
# Before deleting: record the only supported-consumer evidence.
grep -rn "isValidEngineChoice" --include="*.ts" --include="*.tsx" src/ webview/ tests/
node -p "JSON.stringify({exports: require('./package.json').exports ?? '<absent>', main: require('./package.json').main ?? '<absent>', types: require('./package.json').types ?? '<absent>', typings: require('./package.json').typings ?? '<absent>'})"
# Expected pre-change evidence: policy.ts:133 (comment), :135 (alias), :154 (caller);
# package API fields: exports/types/typings absent, main = dist/extension.js.
npx vitest run src/ai/__tests__/policy.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts
test "$(grep -c "isValidEngineChoice" src/ai/policy.ts || true)" -eq 0
test "$(grep -cE '"builtin" \| "omp"\)' src/ai/policy.ts || true)" -eq 0
npm run typecheck
```

## Acceptance Criteria

- [ ] Pre-change consumer/API evidence is recorded: exactly the three `policy.ts` sites;
      no `exports`/`types`/`typings` package entry point (runtime main only).
- [ ] Alias + its comment deleted; :154 calls `isEngineChoice`; no other diff in the file.
- [ ] Both mapped suites pass unmodified; typecheck exit 0.
- [ ] Post-change `isValidEngineChoice` and stale two-value-vocabulary checks both return 0.
- [ ] lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: (none) — `isEngineChoice(value: EngineChoice | null): value is EngineChoice`
  public surface and `resolvePolicy(input: PolicyInput): EffectivePolicy` unchanged.

---
## Discussion

### 2026-09-08 · planner · unic-smart
No TDD RED is possible: the alias is module-private and behavior-identical, so the
observable proof is grep-zero (#3, which fails against today's tree) + suites green.
Pre-change consumer evidence was run: the requested source search produced only
`policy.ts:133` (comment), `:135` (alias), and `:154` (caller); README/public docs returned
no mentions; package.json has no `exports`/`types`/`typings`, only runtime
`main: "dist/extension.js"`. If execution sees any different evidence, do not delete—retain
an `@deprecated` alias instead. Item #1 was already fixed in 93746a4 — do NOT "re-fix" the
header; only assert it.
