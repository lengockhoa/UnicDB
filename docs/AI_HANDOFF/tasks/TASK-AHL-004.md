# TASK-AHL-004 — Extension wiring + package.json + regression

## Goal

Wire the admin cycle into `extension.ts` and `package.json`: register the `adminTree` provider, expose the sessions/locks webview panel, add 5 new commands (`vsdb.refreshAdmin`, `vsdb.openSessionsPanel`, `vsdb.killSession`, `vsdb.terminateSession`, `vsdb.runGrantSql`), extend `confirmDangerousStatements` so GRANT/REVOKE always prompt (new admin-red tier) while leaving existing DML/DDL tier semantics unchanged. Add a `vsdb.admin.confirmGrant` setting (default true).

## Target Files

- `src/extension.ts` — ADDITIVE only. Register the admin tree provider + session panel commands inside `activate()`. NEVER modify `runStatements` body or `ResultsPanel` construction site (AH/AI-locked regions). Extension.ts gains a small `registerAdminFeatures(ctx, mgr, rootSaveContext)` helper called from `activate()` after the schema tree registration.
- `src/core/dangerousStatement.ts` — ADDITIVE. Extend `analyzeStatement()` to detect GRANT/REVOKE shapes via a `matchAdminDcl(sql)` helper; new kinds: `"grant" | "revoke" | "kill" | "terminate"`; new tier `"admin-red"` (always prompt). Existing `kind: "drop"|"delete"|"truncate"|"update"|"other"` and tier `"red"|"amber"|"none"` branches unchanged.
- `package.json` — ADDITIVE. `contributes.commands`: add 5 new with icon and category "VSDB". `activationEvents`: add the two palette ones. `menus.view/item/context`: add entries for admin nodes. `menus.view/title`: add refresh-admin in navigation group. `configuration`: add `vsdb.admin.confirmGrant` (default true). Optional `vsdb.admin.allowGrantPublic` (default false) — gated behind TASK-AHL-001 builder.
- `src/__tests__/extension.test.ts` — EXTEND. Add an admin-feature smoke that verifies the 5 commands appear in `package.json contributes.commands` (counting by id).
- `src/__tests__/scaffold.test.ts` — EXTEND. Confirm new command ids + activation events exist after compile.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (manifest) | 5 new command ids declared with category "VSDB" + icon | json shape | n/a |
| 2 | unit (manifest) | activation events include `onCommand:vsdb.refreshAdmin` + `onCommand:vsdb.openSessionsPanel` | n/a | n/a |
| 3 | unit (manifest) | `vsdb.admin.confirmGrant` setting defaults to true | n/a | n/a |
| 4 | unit (dangerous) | `analyzeStatement("GRANT SELECT ON TABLE x TO y")` returns `{kind:"grant", tier:"admin-red"}` | tier/admin branch | n/a |
| 5 | unit (dangerous) | analyzeStatement on existing DML kinds (DELETE/UPDATE/DROP) returns unchanged tiers | kinds/tiers identical to baseline | n/a |
| 6 | unit (dangerous) | kind/tier union type now includes `grant\|revoke\|kill\|terminate`; tier union now includes `admin-red` | TypeScript compile succeeds | n/a |
| 7 | unit (scaffold) | extension.test / scaffold.test command count rises by exactly 5 | n/a | n/a |
| 8 | regression | confirmDangerousStatements flow for non-admin statements unchanged | n/a | n/a |

## Test Files

- `src/__tests__/extension.test.ts` — extend (tests 1, 2, 3, 7).
- `src/__tests__/scaffold.test.ts` — extend (test 7).
- `src/core/__tests__/dangerousStatement.test.ts` (or equivalent) — extend (tests 4, 5, 6, 8).

## Verification Commands

```bash
npx vitest run src/__tests__/extension.test.ts src/__tests__/scaffold.test.ts src/core/__tests__/dangerousStatement.test.ts
npm run typecheck
npm test
npm run compile
```

## Acceptance Criteria

- [ ] All 8 tests pass (RED first, GREEN after).
- [ ] `package.json commands` adds exactly 5 entries; activation events + setting added; no other manifest diff.
- [ ] `extension.ts` extension remains additive in the activate()-tail region; runStatements body and resultsPanel construction site byte-identical (verified by `git diff --stat`).
- [ ] dangerous-statement tier/kind unions widened additively; existing analyzeStatement results unchanged for non-admin inputs.
- [ ] `npm run typecheck` exit 0; full `npm test` green; `npm run compile` clean.

## Dependencies

- TASK-AHL-002 (admin tree wiring), TASK-AHL-003 (sessions panel wiring).

## Interfaces

- Consumes: existing extension.ts context, `connectionManager`, `confirmDangerousStatements`, `runSql`.
- Produces: 5 new commands (`vsdb.refreshAdmin`, `vsdb.openSessionsPanel`, `vsdb.killSession`, `vsdb.terminateSession`, `vsdb.runGrantSql`), new `vsdb.adminTree` view, new panel `vsdb.adminSessions`; one setting `vsdb.admin.confirmGrant`.
