# TASK-AIX04-003 — panel consent + apply flow

Cycle: AIX-04 · Wave 4 · Priority: P1
Status: done
Depends on: AIX04-002
Reviewer: unic-smart (cycle reviewer)

## Spec

Wire plan_change into the chat panel consent flow:

1. `src/ui/aiChatPanelMessages.ts` — new host message kind
   `AiChatPanelChangePlan {type: "change_plan", tool: string, plan: {
   statements: Array<{sql, tier, dangerNote}>, drift: string[],
   drifted: boolean, intent: string}}`; new webview message
   `plan_approve {type: "plan_approve"}` and `plan_reject {type:
   "plan_reject"}`.
2. `src/ui/aiChatPanel.ts` — when a `plan_change` tool result (ok envelope
   with plan) lands in `onToolResult`, post the `change_plan` card instead
   of a plain `tool_result`; on `plan_approve`:
   - host re-checks `drifted` (re-run fingerprint — defense in depth);
     drifted → posts updated card + error, does NOT apply.
   - splits statements via `splitStatements`, runs
     `confirmDangerousStatements(parsed, driver)` — PREFER extracting
     `confirmDangerousStatements` from `src/extension.ts:1303` into a
     shared module (e.g. `src/ui/confirmDangerous.ts`) so both extension.ts
     and the panel use the same function; re-export from extension.ts to
     keep existing call sites intact.
   - reject → posts `tool_result {tool:"plan_change", status:"denied",
     summary:"rejected by user"}`; nothing runs.
   - approve → sequential apply with per-statement `progress` posts;
     failure → partial-apply report (applied/failedAt/error card).
3. `webview/aiChatPanelMain.ts` — render the change_plan card
   (statement list with tier badges + drift lines, textContent-only) with
   Approve/Reject buttons; Approve disabled when drifted.

## Acceptance

- [ ] Message contract: host posts change_plan for ok envelopes; webview
      renders statements + tiers + drift (textContent); approve posts
      plan_approve; reject posts plan_reject.
- [ ] Host approve path: drifted → no apply + error card; reject →
      denied tool_result; approve → confirm gate called BEFORE any apply;
      confirm false → denied card, 0 runQuery; confirm true → sequential
      apply with progress; mid-run failure → applied/failedAt report.
- [ ] `confirmDangerousStatements` is a single shared implementation (no
      panel copy).
- [ ] `npx vitest run <targeted files>` green.

## Executor

**RED**: typecheck failed — `AiChatPanelPlanApprove`/`AiChatPanelPlanReject` not in
`AiChatPanelWebviewMessage` union; consent-flow tests initially failed (drift
re-check compared SQL strings against column names → always drifted).

**GREEN**:
- `npm run typecheck` → 0 errors.
- `npx vitest run src/ui/__tests__/aiChatPanelPlan.test.ts` → Tests 6 passed (6):
  card post from ok envelope; approve→consent→apply 2/2; denied→0 runQuery;
  drift at approve→stale card+error+0 runQuery; mid-run failure→1/2+boom at 2;
  reject→0 runQuery.
- `npx vitest run src/ui/__tests__/aiChatPanelPlanWebview.test.ts` → 4 passed (4):
  render intent/statements/tier/dangerNote/buttons; drifted→Approve disabled;
  buttons post plan_approve/plan_reject; hostile SQL stays text (no live nodes).

Notes:
- `confirmDangerousStatements` extracted to `src/ui/confirmDangerous.ts`
  (shared with extension.ts via re-export) — ONE consent implementation.
- Approve path: host re-checks drift (`adapter.listColumns` names vs
  `claimedColumns` minus target table/schema), then consent gate, then
  `runRenameStatements` sequential apply with per-statement `step` posts.
- `plan_change` registered gate-wrapped in BOTH builtin and OMP/MCP registries.

## Reviewer

(verdict appended by reviewer)

Reviewer: done (reviewer APPROVED — see full verdict block in TASK-AIX04-001.md).
