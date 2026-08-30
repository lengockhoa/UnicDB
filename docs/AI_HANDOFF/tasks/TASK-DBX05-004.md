# TASK-DBX05-004 — scaffold hygiene + regression + docs

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

Cycle guardrails and closure: scaffold tests enforcing the new modules' purity and CSP discipline, extension regression proof, CHANGELOG entry.

## Target Files

- `src/__tests__/dbx05Scaffold.test.ts` — NEW:
  - `src/core/connectionGroups.ts`, `src/core/readOnlyIntent.ts`, `src/core/sshTunnel.ts`, `src/core/sshTunnelManager.ts` contain NO `vscode` import (source text check, word-boundary regex `\bvscode\b`).
  - `sshTunnelManager.ts` contains NO `shell: true` and no `exec`/`execSync` (injection guard).
  - connectionForm webview files contain no `innerHTML`/`insertAdjacentHTML`/`eval(`/`new Function(` (word-boundary regexes — DBX-03 lesson).
- `src/extension.test.ts` — ADDITIVE regression: extension dispose calls `tunnels.stopAll()` (fake manager spy).
- `CHANGELOG.md` — fold into the v1.20.0 release section at closure time.
- README feature bullet (one line) under connections.

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | scaffold | 4 new modules vscode-free |
| 2 | scaffold | no shell:true / exec in tunnel manager |
| 3 | scaffold | webview files CSP-clean |
| 4 | regression | dispose stops tunnels |
| 5 | regression | full suite green |

## Verification

```bash
npx vitest run src/__tests__/dbx05Scaffold.test.ts src/extension.test.ts
npm test
npm run compile
```

## Executor Report

### Executor (unic-code)

**RED evidence**: first run of `npx vitest run src/__tests__/dbx05Scaffold.test.ts` → `Tests no tests` (file failed to load: `describe is not defined` — vitest globals are NOT enabled in `vitest.config.ts`, so the file needed an explicit `import { describe, it, expect } from "vitest"`; after that, `ROOT` const was missing after an edit collision — fixed; then `2 failed`: the vscode-import regex matched the *comment* "No vscode import" and the shell regex matched regex-method `.exec(` — tightened both to real-import / `execSync` / `shell:true`-in-spawn patterns).

**GREEN evidence**: `npx vitest run src/__tests__/dbx05Scaffold.test.ts src/extension.test.ts` → 5 + 71 passed. Full `npm test` → 2495 passed | 2 skipped (185 files). `npm run typecheck` → 0 errors. `npm run compile` → esbuild clean. CHANGELOG 1.20.0 section + compare link added; README key-features bullets for read-only connections, SSH tunnels, folder grouping added.

