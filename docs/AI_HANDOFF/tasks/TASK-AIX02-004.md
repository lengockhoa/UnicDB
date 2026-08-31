# TASK-AIX02-004 — scaffold hygiene + docs

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

NEW `src/__tests__/aix02Scaffold.test.ts`:
- `fileDiff.ts` + `fileOpsTool.ts` never import vscode (import-statement regex only).
- `fileOpsTool.ts` has no shell:true / execSync / child_process usage (pure over injected deps).
- No webview changes: existing connectionForm CSP scaffold still green.

Docs: CHANGELOG `## [1.21.0]` section + compare link; README key-features bullet
(Safe File Operations — diff preview, explicit approval card, allowlist scope, atomic write);
docs closure (ACTIVE/INDEX/WORKLOG/STATUS).

## Verification

```bash
npx vitest run src/__tests__/aix02Scaffold.test.ts src/__tests__/dbx05Scaffold.test.ts
npm test
npm run compile
```

## Executor Report

### Executor (unic-code)

**RED evidence**: none captured beyond module-load RED for the scaffold itself (file absent on first run → `no tests`); the target modules were already vscode-free and fs-free by construction (verified: the tightened import-regex checks passed immediately after creation — the DBX-05 lesson about comment-text false positives was applied up front).

**GREEN evidence**: 3/3 scaffold (no vscode imports in fileDiff/fileOpsTool; no shell:true/execSync/child_process/fs in fileOpsTool — I/O strictly via injected deps; both public exports present). CHANGELOG 1.21.0 + compare link; README feature bullet. Full `npm test` → 2522 passed | 2 skipped (189 files); typecheck 0; esbuild clean.

## Reviewer Verdict (unic-smart, cycle reviewer Aix02Reviewer)

**Round history** (executor commits vs review rounds):
- Initial implementation (e028910): CHANGES-REQUESTED — empty production allowlist; no pre-approval diff on the permission card; generic non-JSON denial; malformed no-newline sentinel placement; hunk truncation that hid the preview.
- Fix round 1 (dac484e): CHANGES-REQUESTED — missing workspace-trust enforcement; stale-preview overwrite protection; preservation of non-file/remote URI identity; normal multi-hunk truncation; old-side context newline handling.
- Fix round 2 (efc86df): CHANGES-REQUESTED — stale snapshot keyed only by path instead of per approval request; host write needed the expected-snapshot (CAS) contract; both-side no-final-newline needed two sentinels.
- Fix round 3 (f3be6e3): CHANGES-REQUESTED — overflowed hunks dropped newline sentinels.
- Fix round 4 (0b5d6b8): **VERDICT: APPROVED** — shared sentinel renderer covers full and truncated hunks (one- and two-sided missing-final-newline).

**Verified final behavior** (reviewer): workspace writes gated by grounding + workspace trust + exact URI-string allowlist membership + explicit permission + pre-approval capped unified diff + request-scoped expected-content binding + host-side conflict detection before atomic temp+rename; identical gated config on builtin and OMP/MCP paths; pure modules free of vscode/fs/child_process/shell; targeted suite 40/40.

**Residual notes**: none blocking. Full-suite/typecheck/compile re-run reported by executor (2539 passed | 2 skipped; 0 TS errors; esbuild clean) under the reviewer's scoped-validation constraint.

**Final: VERDICT: APPROVED** (all tasks TASK-AIX02-001..004 APPROVED, round 5 of review).
