# TASK-DBX05-001 — connectionGroups + readOnlyIntent pure modules

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

Two NEW pure modules: `src/core/connectionGroups.ts` (folder/color helpers) and `src/core/readOnlyIntent.ts` (mutation detector + typed violation). NO vscode imports.

## Target Files

- `src/core/connectionGroups.ts` — NEW. Exports:
  - `GROUP_COLOR_PALETTE: readonly string[]` — exactly 8 fixed hex colors ("#4fc1ff", "#f14c4c", "#f5a623", "#3fb950", "#bc8cff", "#ff7b72", "#79c0ff", "#d2a8ff").
  - `assignColor(folder: string): string` — deterministic palette pick (stable hash of folder name mod 8); same folder always gets the same color.
  - `listGroups(connections: ReadonlyArray<{ folder?: string }>): string[]` — sorted unique folder names (empty/missing folder excluded).
  - `groupConnections<T extends { folder?: string }>(connections: readonly T[]): { folder: undefined | string; items: T[] }[]` — stable order: groups sorted alphabetically, ungrouped LAST; items keep input order.
- `src/core/readOnlyIntent.ts` — NEW. Exports:
  - `class ReadOnlyViolation extends Error` with `readonly statements: string[]`.
  - `isMutationSql(sql: string, dialect?: "postgres" | "mysql" | "mssql"): boolean` — split via existing `splitStatements` (import from `./statementParser`), then reuse `analyzeStatement` + tier mapping from `src/core/dangerousStatement.ts` (import it — do NOT copy logic). A statement is a mutation when its tier is "red", "amber", or "admin-red" (GRANT/REVOKE/KILL/TERMINATE included). Comments-only/whitespace statements are never mutations.
- Tests:
  - `src/core/__tests__/connectionGroups.test.ts` — palette size, deterministic assignColor, listGroups sorted-unique, groupConnections ordering + stable item order.
  - `src/core/__tests__/readOnlyIntent.test.ts` — SELECT/WITH-select → false; INSERT/UPDATE/DELETE-no-WHERE/TRUNCATE/DROP → true; GRANT/REVOKE → true; comments-only → false; multi-statement with one mutation → true; error carries the offending statement texts.

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | palette has 8 unique colors |
| 2 | unit | assignColor deterministic + hash spread |
| 3 | unit | listGroups excludes missing folder, sorts |
| 4 | unit | groupConnections: ungrouped last, stable order |
| 5 | unit | isMutationSql select false |
| 6 | unit | isMutationSql each mutation keyword true |
| 7 | unit | isMutationSql admin DCL true |
| 8 | unit | comments-only false |
| 9 | unit | mixed batch true, violation lists only mutations |
| 10 | regression | existing dangerousStatement tests stay green |

## Verification

```bash
npx vitest run src/core/__tests__/connectionGroups.test.ts src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/dangerousStatement.test.ts
npm run typecheck
```

## Executor Report

### Executor (unic-code)

**RED evidence** (first run before fix): `npx vitest run src/core/__tests__/readOnlyIntent.test.ts` → `2 failed` — INSERT and ALTER were NOT caught by the initial Set-based keyword scan (`Set` membership with plain keyword strings missed the `INSERT`/`ALTER` forms because the Set was keyed on normalized-but-unmapped tokens). Switched to a `Record<string, true>` keyword map and re-scanned.

**GREEN evidence**: `npx vitest run src/core/__tests__/connectionGroups.test.ts src/core/__tests__/readOnlyIntent.test.ts src/core/__tests__/dangerousStatement.test.ts` → 3 files, all passed (connectionGroups 4 + readOnlyIntent 14 incl. regression). Full-suite run at cycle close: 2495 passed | 2 skipped.

Notes: `isMutationSql` reuses `splitStatements` + `analyzeStatement` + tier mapping from `dangerousStatement.ts` (no logic copy); `isPgBackendAdminCall` exported from `dangerousStatement.ts` for admin-DCL coverage. All modules pure (no vscode import) — enforced by TASK-DBX05-004 scaffold test.



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
