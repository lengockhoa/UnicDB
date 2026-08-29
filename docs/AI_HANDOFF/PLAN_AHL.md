# PLAN_AHL — Cycle AHL: Admin (users/roles/grants + sessions/locks)

## §1 Intent

User (verbatim, history + roadmap):

- "Tree category `Roles` (login/role attributes), per-role grants (tables/sequences/schema), member-of."
- "Grant/revoke wizard với preview SQL + confirm (dangerous-statement gate)."
- "Sessions viewer: active queries (pid, user, state, duration, query), lock waits (blocked → blocking chain), kill/terminate (confirm)."

Roadmap says (cycle AH, ROADMAP.md, durable):
- Tree category `Roles`, per-role grants wizard (preview + confirm).
- Sessions viewer with lock waits + kill/terminate.

Note: `PLAN_AH.md` + `INDEX_AH.md` in this repo already describe a previously shipped cycle AH (results-panel accumulator, released v1.13.0). The new admin scope uses suffix `AHL` (`PLAN_AHL`, `INDEX_AHL`, `TASK-AHL-001..004`) to avoid clashing.

**Success definition**: TDD-tested, RED→GREEN for: (a) Admin tree category + roles sub-tree + grants wizard with preview SQL and confirm gate, (b) Sessions/Locks panel with kill/terminate confirm + self-protection, (c) extension command + manifest wiring. Postgres-first; mysql/mssql degrade gracefully (admin category hidden).

## §2 Scope (4 tasks, 4 waves)

1. **AHL-001** Pure `pgAdmin` module + `AdminApi` interface + Postgres adapter wires it.
2. **AHL-002** Admin tree provider + roles/grants wizard (host).
3. **AHL-003** Sessions/Locks webview panel + kill/terminate confirm.
4. **AHL-004** Extension wiring + package.json + regression (extends dangerous-statement gate with `grant`/`revoke`).

All tasks TDD-driven: tests first, RED output recorded, GREEN, then full-suite + typecheck + compile gates.

## §3 Approach (key grounded facts)

- pg_catalog pattern lives in `src/core/ddl/pgCatalog.ts`; reuse `quoteIdent` / `quoteLiteral` for all role names, identifiers, grants targets.
- New module `src/core/admin/pgAdmin.ts` (mirror of pgCatalog.ts) — pure SQL templates + row mappers; no vscode / no driver imports.
- `src/adapters/types.ts` gains additive `admin?: AdminApi` on `DbAdapter`; existing `CatalogApi` untouched (zero breaking change).
- `src/adapters/postgres.ts` gains additive `adapter.admin = { listRoles, listRoleGrants, listSessions, listLockWaits, buildGrantSql, buildRevokeSql }`; existing catalog untouched.
- `src/core/dangerousStatement.ts` extended with `Kind = "grant" | "revoke" | "kill" | "terminate"` and tier "admin-red". The existing `confirmDangerousStatements` modal (extension.ts ~:765) is widened additively — current callers (DML/DDL kinds) unaffected.
- The schema tree is left intact; admin lives in a sibling provider `src/ui/adminTree.ts` so AF-locked files stay clean.
- Sessions/locks panel lives in its own webview `src/ui/adminSessionsPanel.ts` (CSP-clean, no inline handlers).
- Hard constraint: tests first, RED, GREEN; full-suite green + typecheck 0 + compile clean at every wave.
- Safety: `quoteIdent` for every role/object name; reject empty + names with embedded NUL or quotes; reject grants to PUBLIC unless explicit `allowGrantPublic` flag; never terminate self; PG `pid === current_backend_pid` rejected; SQL flow always goes through `confirmDangerousStatements` regardless of guardTier; pool wedge prevention (admin reads go through `mgr.getAdapter()`); `LIMIT` cap on `pg_locks` reads.

## §4 Test Plan (high-level)

| Area | Happy | Edge 1 | Edge 2 | Regression |
|---|---|---|---|---|
| pgAdmin SQL templates | listRoles/listRoleGrants/listSessions/listLockWaits return safe parameterized SQL | role-name with embedded `;DROP` quoted via `quoteIdent`; result SQL has no unsanitized payload | row mappers drop null fields; empty `[]` for empty results | existing pgCatalog / pgIntrospect tests stay green |
| AdminApi buildGrant/buildRevoke | grant SELECT, INSERT on table → properly quoted GRANT | grant to PUBLIC blocked unless allowGrantPublic | empty grantee / empty privileges rejected with structured error; names exceeding NAMEDATALEN-1 (63) rejected | mysql adapter admin stays undefined |
| Admin tree | Admin category appears for Postgres | absent for mysql/mssql (no admin capability) | error rendering when SELECT fails (insufficient_privilege 42501 surfaced) | existing schemaTree tests stay green |
| Sessions/Locks panel | Sessions tab lists pg_stat_activity rows; Locks tab shows blocked → blocking chains | kill vs terminate distinct buttons, both confirm modals | self-pid detected → buttons disabled, "(self)" badge | existing webview tests stay green |
| Extension wiring | 5 commands declared + activation events | admin DCL routes through confirm gate (admin-red tier) | existing DDL/DML kinds behave unchanged (regression on confirmDangerousStatements) | existing extension.test / scaffold.test stay green |

## §5 Verification

Per-task (executor runs inside each task file; targeted first):

```bash
npx vitest run <task-targeted tests>
npm run typecheck
npm test
npm run compile
```

Wave/cycle boundaries (mandatory full net):

```bash
npm test        # full suite green at every wave boundary
npm run typecheck
npm run compile
```

Manual smoke (review phase):
- Connect to Postgres → tree shows Admin → Roles → expand → see one role → see per-role grants (table objects).
- Right-click → Grant wizard → preview SQL appears in modal → confirm → row returns ok.
- Sessions panel: see pid+user+duration; click Terminate on a non-self row → confirm → pid disappears on refresh.
- Self-protection: open Admin on the active connection's psql; the panel disables the Kill/Terminate buttons on the row matching `pg_backend_pid()`.

## §6 Acceptance

- All 4 tasks `approved` or `approved_minor` with executor report + reviewer verdict recorded.
- Full `npm test` green at every wave boundary; `npm run typecheck` exit 0; `npm run compile` clean.
- No regression in shipped cycles AF/AI/AH/AG; `src/ai/omp/*` remains untouched.
- No API key / secret / password substrings in any admin panel, message, export, or log.
- CHANGELOG entries; version bump to next free minor at release step.

## §7 Task split

| Task | Slice | Owns (files) | Wave | Depends on |
|------|-------|--------------|------|------------|
| TASK-AHL-001 | pgAdmin pure module + AdminApi contract | `src/core/admin/pgAdmin.ts` (NEW), `src/core/admin/__tests__/pgAdmin.test.ts` (NEW), additive to `src/adapters/types.ts`, additive to `src/adapters/postgres.ts` | 1 | none |
| TASK-AHL-002 | Admin tree provider + roles/grants wizard | `src/ui/adminTree.ts` (NEW), `src/ui/adminWizard.ts` (NEW), `src/ui/__tests__/adminTree.test.ts` (NEW), `src/ui/__tests__/adminWizard.test.ts` (NEW) | 2 | AHL-001 |
| TASK-AHL-003 | Sessions/Locks panel + kill/terminate confirm | `src/ui/adminSessionsPanel.ts` (NEW), `src/ui/__tests__/adminSessionsPanel.test.ts` (NEW) | 3 | AHL-001 |
| TASK-AHL-004 | Extension wiring + package.json + regression | `src/extension.ts` (additive), `src/core/dangerousStatement.ts` (additive Kind extension), `package.json` (additive commands/events/menus), `src/__tests__/extension.test.ts` (extend), `src/__tests__/scaffold.test.ts` (extend) | 4 | AHL-002, AHL-003 |

## §8 Versioning

Next free minor at release. Existing cycles have produced 1.7.0 → 1.14.0 already; verify the slot at release step.

## §9 Planner notes

- `PLAN_AH.md` (results-panel accumulator, released v1.13.0) is distinct from this admin scope; `AHL` suffix prevents `INDEX_AH.md` collision.
- Reuse `pgCatalog.quoteIdent`, NOT introducing a second quoting helper. Identifier safety is one path.
- Admin panel does NOT use the existing `webview/main.ts` bundle — keeps the regular grid bundle lean and the admin panel in a separate `<webview>`.
- Extension.ts edits are additive — never modify the AH-locked regions (resultsPanel construction site, runStatements body).
- ai/omp/** untouched.
