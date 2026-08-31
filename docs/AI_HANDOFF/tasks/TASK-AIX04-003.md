# TASK-AIX04-003 — panel consent + apply flow

Cycle: AIX-04 · Wave 4 · Priority: P1
Status: pending
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

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
