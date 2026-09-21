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



## Reviewer Verdict (unic-smart, cycle reviewer Dbx05Reviewer)

Review rounds 1-6 (commits 2de43e2 → d49b7af → 0f236a4 → fb88be0 → HEAD → 65b53a7):

- Round 1 CHANGES-REQUESTED: 8 findings (form payload fields dropped, tunnel bastion/target port conflation, probes bypassing tunnel lifecycle, invalid SetEnv syntax, readiness from debug-level line, EXPLAIN-parens read-only bypass, scaffold missing DOM-sink assertions, README Table Designer heading). All fixed in d49b7af.
- Round 2 CHANGES-REQUESTED: ephemeral localPort parsed from pre-bind debug line; missing spawn `error` handler; edit probe reusing old tunnel via idempotent start; password field still missing from readForm. All fixed in 0f236a4.
- Round 3 CHANGES-REQUESTED: blind TCP-connect readiness accepted any local listener (traffic theft). Fixed with quiet-period in fb88be0.
- Round 4 CHANGES-REQUESTED: timing not proof of bind (reviewer verified OpenSSH channels.c prints the forward line pre-bind). Replaced with listener identity proof in round 5.
- Round 5 CHANGES-REQUESTED: Windows portability (ss-only). Fixed with netstat -ano parsing in 65b53a7.
- **Round 6: APPROVED** — "The listener ownership check now verifies the spawned ssh PID against the actual LISTEN socket (with lsof/ss/netstat dispatch), fails closed when unavailable, and the readiness docs match implementation. No remaining patch-introduced correctness or security blocker found."

Final verification at 65b53a7: 2499 passed | 2 skipped (vitest, 185 files); `npm run typecheck` 0 errors; `npm run compile` esbuild clean.

VERDICT: APPROVED
