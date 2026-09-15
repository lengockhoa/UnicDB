# TASK-CHATV2-014 — Permission policy, requests and change-plan safety

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§5–6

## Goal
Replace the small bypass toggle and inline legacy prompt with a truthful policy control and anchored permission sheet while retaining all host policy, destructive SQL and workspace-trust gates.

## Target Files
- `webview/aiChat/permissions.ts` — policy menu, request sheet and focus handling.
- `webview/aiChat/changePlan.ts` — reviewed SQL change-plan card in V2 visuals.
- `webview/aiChat/overlays.ts` — modal warning/confirm primitives.
- `src/ui/aiChatPanel.ts` — policy capability/ack/request correlation.
- `src/ui/__tests__/aiChatPanelPermissionsV2.test.ts` — deny/default/bypass/late response.
- `webview/aiChat/__tests__/permissions.test.ts`, `webview/aiChat/__tests__/changePlan.test.ts`.

## Required Work / Exact Spec
Composer permission button sits before send, >=36px, 16px shield and label `Permissions: Ask` (or host mapped policy). Hide it if unsupported. Click opens policy sheet describing current policy; it cannot resolve a pending request. Bypass option appears only if capability true and opens warning: `This may let the selected AI run supported tools without asking in this chat. Destructive SQL and workspace trust rules still apply.` Buttons `Enable for this chat` and `Cancel`; default Cancel; host ack required; reset on panel close/engine change.

A pending permission request renders anchored above composer, width clamp 360–560px, title `Allow tool action?`, safe tool name/detail, optional scope selector, actions `Allow once`, `Always allow for this chat` only when host option exists, and `Deny`. Default is deny/no approval; Enter must never implicitly allow. Exact opaque requestId/optionId echo only once. Replaced/expired/terminal requests disable/remove old sheet and late clicks send nothing.

Focus: modal sheet traps Tab/Shift+Tab among controls, stores prior focus and restores composer when disposed. Escape on ordinary request chooses Deny only if host contract defines it; destructive/high-impact Escape opens explicit deny confirmation rather than approval. Assertive live region announces one request/error, not every detail. All labels/details use textContent; long detail >120 or multiline collapses under `Show tool details` and remains copy-disabled unless host marks safe.

Turn phase is awaiting_permission; Stop remains available. Permission decision changes activity row status. Deny is not rendered as engine failure. Timeout/replacement has truthful host copy.

Change-plan card remains separately reviewed: title, intent, SQL code DOM-safe, tier/danger note, drift. `Approve & run` disabled when drifted. Approval still routes through existing destructive statement confirmation; bypass can never skip it. Reject and stale double-click emit once.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | security | Enter/default | zero implicit approval; Deny is safe default |
| 2 | capability | bypass unsupported/supported | hidden vs explicit warning+host ack |
| 3 | race | duplicate/replaced/expired request | one or zero exact opaque response as appropriate |
| 4 | a11y | focus trap/restore/Escape | deterministic focus and no accidental allow |
| 5 | security | hostile/long detail | safe text, collapsed threshold, no raw token/detail leak |
| 6 | regression | destructive plan with bypass | drift/SQL confirmation remains mandatory |
| 7 | lifecycle | stop while permission | stop intent valid; request settles truthfully |

## Test Files
- `src/ui/__tests__/aiChatPanelPermissionsV2.test.ts`
- `webview/aiChat/__tests__/permissions.test.ts`
- `webview/aiChat/__tests__/changePlan.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatPanelPermissionsV2.test.ts webview/aiChat/__tests__/permissions.test.ts webview/aiChat/__tests__/changePlan.test.ts src/ui/__tests__/aiChatPanelPlan.test.ts src/ui/__tests__/aiChatPanelPolicy.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] SAFE-03/SAFE-04 and permission races pass.
- [ ] Every permission/policy button has exact size/copy/default/focus behavior.
- [ ] Bypass is session-scoped, acknowledged and cannot weaken SQL/trust safety.
- [ ] Opaque IDs echo once and unsafe details remain host-filtered/text-only.

## Dependencies
- TASK-CHATV2-002, TASK-CHATV2-003, TASK-CHATV2-007, TASK-CHATV2-008

## Interfaces
- Consumes: capability/policy/request/plan V2 frames and controller intent transport.
- Produces: permission/policy/change-plan views and single-response focus lifecycle for 016/017.

## Discussion
(no comments yet)
