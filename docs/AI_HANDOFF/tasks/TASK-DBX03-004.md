# TASK-DBX03-004 — compare service + panel + extension wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX03.md` §3.4–3.5, §4 T15–T19

## Goal

Host service that fetches shapes + keyset-ordered rows and runs the pure diffs, a CSP-clean compare panel webview rendering schema diff / data diff / sync plan, and extension wiring for one new command `vsdb.compareTables`.

## Target Files

- `src/ui/compareService.ts` — new host orchestration.
- `src/ui/comparePanel.ts` — webview host (panel creation, message channel `vsdb-compare`, CSP nonce).
- `webview/comparePanelMain.ts` — webview script (renders sections from one postMessage payload).
- `src/extension.ts` — register `vsdb.compareTables` behind the partial-mock guard pattern used by DBX-01/02 registrations.
- `package.json` — command entry (`vsdb.compareTables`, category VSDB, icon `$(diff)`).
- `src/__tests__/dbx03Scaffold.test.ts` — manifest + hygiene guards.
- `src/ui/__tests__/compareService.test.ts`, `src/ui/__tests__/comparePanel.test.ts`.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | guard | non-postgres driver → refusal result | `result.error` matches /PostgreSQL/i; `adapter.listTableDetail` NOT called | mocked mysql adapter |
| 2 | guard | no active connection → refusal result | actionable error message | adapter undefined |
| 3 | unit | missing target table → actionable error | error mentions the table name | listTableDetail throws |
| 4 | boundary | rows > COMPARE_ROW_LIMIT → `truncated: true`, diff computed on prefix | flag + counts reported | fixture via injected fetcher |
| 5 | unit | happy path: CompareResult carries shapeDiff + dataDiff + executable plan | wired end-to-end on mocks | compatible shapes + PK |
| 6 | smoke | extension activation registers vsdb.compareTables without throwing (partial mocks, mirrors dbx01Scaffold pattern) | registered command present | mocked vscode |
| 7 | scaffold | package.json has vsdb.compareTables with category VSDB + icon | manifest contains entry | pkg read |
| 8 | hygiene | compare modules import no SchemaCache, no debounce/timer tokens | grep-clean (no-second-cache guard) | source read |
| 9 | hygiene | webview main uses no innerHTML/eval/inline-script assignment | grep-clean (CSP guard) | source read |

## Test Files

- `src/ui/__tests__/compareService.test.ts`
- `src/ui/__tests__/comparePanel.test.ts`
- `src/__tests__/dbx03Scaffold.test.ts`

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/compareService.test.ts src/ui/__tests__/comparePanel.test.ts src/__tests__/dbx03Scaffold.test.ts src/core/compare
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED evidence in report).
- [ ] Panel is preview-only: nothing in the panel executes the plan; clipboard "Copy SQL" is the only hand-off.
- [ ] Activation with partial mocks does not throw (guard pattern).
- [ ] Non-PostgreSQL drivers get graceful, actionable refusal text.
- [ ] No second cache, no debounce anywhere in the compare path.

## Dependencies

- TASK-DBX03-003 must complete first (consumes SyncPlan).

## Interfaces

- Consumes:
  - `diffSchema`, `shapeFromTableDetail`, `TableShape` (001); `diffData` (002); `buildSyncPlan`, `SyncPlan` (003).
  - `DbAdapter.listTableDetail(schema, table)` from `src/adapters/types.ts`.
  - The `importCtx` bridge pattern from `src/ui/importWizard.ts` (`getAdapter`/`getActiveDriver`) — reuse it in extension.ts.
- Produces:
```ts
// src/ui/compareService.ts
export const COMPARE_ROW_LIMIT = 10000;
export interface CompareRequest {
  source: { schema: string; table: string };
  target: { schema: string; table: string };
}
export interface CompareResult {
  ok: boolean;
  error?: string;
  truncated?: boolean;
  shapeDiff?: SchemaDiffResult;
  dataDiff?: DataDiffResult;
  plan?: SyncPlan;
}
export async function runCompare(
  req: CompareRequest,
  adapter: DbAdapter,
  driver: string | undefined,
): Promise<CompareResult>;
// src/ui/comparePanel.ts
export function showComparePanel(result: CompareResult, req: CompareRequest): void;
```
- package.json contributes: command `vsdb.compareTables` ("Compare Tables", category VSDB, icon `$(diff)`); no new activation event (command palette runs post-activation).

---

## Discussion

(no comments yet)

---

<!-- Executor appends report below -->
