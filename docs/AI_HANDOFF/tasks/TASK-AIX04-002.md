# TASK-AIX04-002 — plan_change agent tool

Cycle: AIX-04 · Wave 4 · Priority: P1
Status: pending
Depends on: AIX04-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/ai/tools/changePlanTool.ts`:

1. `createPlanChangeTool(f: AdapterFactory, fingerprint: (schema: string,
   table: string) => Promise<string[]>): AgentTool` — tool `plan_change`:
   - args: `intent` (required string), `statements` (optional string[]),
     `targetSchema` (optional, default "public"), `targetTable` (optional).
   - READ-ONLY: never calls `runQuery` on the statements. Only `f()`
     (adapter acquisition) and `fingerprint(...)` (introspection) run.
   - `validatePlanStatements(statements)` errors → envelope
     `{"ok": false, "error": "<msg>"}`.
   - targetSchema/targetTable guarded by badIdentifier parity
     (`^[A-Za-z_][A-Za-z0-9_$]*$` + containsForbidden) → error envelope.
   - fingerprint columns → `detectDrift(current, claimed)` where claimed
     is parsed from the statements (column-name tokens) — drift list rides
     the plan; plan marked `drifted: drift.length > 0`.
   - returns `{"ok": true, "plan": {intent, statements: PlanStatement[],
     drift, drifted}}`.
2. `createChangePlanTools(f, fingerprint?)` — registers plan_change.

## Acceptance

- [ ] plan_change returns classification envelope for DELETE/UPDATE/DROP/
      GRANT; never invokes adapter.runQuery (inject a spy adapter —
      assert 0 calls).
- [ ] missing statements → `{"ok": false}` error envelope.
- [ ] bad targetTable (`users; DROP`) → error envelope, no adapter calls.
- [ ] drift: fingerprint ["a","b"] vs claimed ["a","c"] → drift ["b","c"],
      drifted true.
- [ ] `npx vitest run src/ai/__tests__/changePlanTool.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
