# TASK-001 — Permission detail: surface tool args safely in ACP permission dialog

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 Slice 1

## Goal

ACP `session/request_permission` currently shows only tool id/name — the detail line is
effectively always empty, so users Allow/Deny blind. Build a plain-text, size-capped detail
from the tool's arguments (SQL preview for `run_sql`, pretty JSON otherwise) host-side, and
render it in the webview as a collapsible block, `textContent` only.

## Target Files

- `src/ui/permissionDetail.ts` — (new) pure sanitizer: `buildPermissionToolInfo` + `PERMISSION_DETAIL_CAP`
- `src/ui/aiChatPanel.ts` — `handleAcpServerRequest` (~lines 577-633): replace inline
  string-guards for id/name/detail with `buildPermissionToolInfo(toolCall)`; posted
  `permission_request.tool` shape unchanged
- `webview/aiChatPanelMain.ts` — `renderPermissionRequest` (~lines 370-445): detail ≤120
  chars & single-line → existing plain div; else `<details><summary>Show tool
  details</summary><pre>` all via textContent; empty detail → omit node
- `webview/styles.css` — add `.vsdb-chat-permission`, `-header`, `-tool-id`, `-tool-name`,
  `-tool-detail`, `-detail pre`, `-actions` rules (grep confirms none exist today)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | SQL preview for run_sql | detail === `"SQL:\nSELECT 1 FROM t"`, id/name passthrough | `{id:"t1", name:"run_sql", arguments:{sql:"SELECT 1 FROM t"}}` |
| 2 | unit | pretty JSON fallback | detail === `JSON.stringify({schema:"public"},null,2)` | `{name:"describe_table", args:{schema:"public", table:"users"}}` |
| 3 | edge (boundary) | >2000-char detail cap | length ≤ 2000+len(marker), ends with `"… (truncated)"` | 5000-char sql string |
| 4 | edge (malformed) | non-string detail, non-object toolCall, missing args | returns `{id:"",name:"",detail:""}` or empty detail — never throws | `null`, `42`, `{detail:42}` |
| 5 | edge (secret) | secret-like key redacted | value replaced with `"[redacted]"` in output | `{arguments:{sql:"x", api_key:"sk-1"}}` |
| 6 | unit (host) | posted permission_request carries built detail + opaque ID unchanged | posted `tool.detail` matches sanitizer; requestId still `req-…`; options untouched | FakeAcp session per existing harness, server sends toolCall w/ args |
| 7 | unit (webview) | long detail → collapsible, textContent only | card contains `<details>`+`<pre>`; `el.innerHTML` never assigned on new nodes; pre.textContent === detail | jsdom render, 150-char detail |
| 8 | edge (webview) | empty detail | no `.vsdb-chat-permission-tool-detail` node in card | detail `""` |
| 9 | regression | existing ACP permission semantics | all pre-existing cases in `aiChatPanelAcp.test.ts` + `aiChatPanelWebview.test.ts` still pass unmodified (opaque-ID, one-shot settle, deny default) | current suite |

## Test Files

- `src/ui/__tests__/permissionDetail.test.ts` — (new) cases 1-5
- `src/ui/__tests__/aiChatPanelAcp.test.ts` — add case 6 (extend existing fake-server harness)
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — add cases 7-8 (jsdom bundle harness)

## Verification Commands

```bash
npm run typecheck && npm test -- src/ui/__tests__/permissionDetail.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
```

## Acceptance Criteria

- [ ] Cases 1-9 PASS fresh (RED output pasted for new tests before implementation)
- [ ] No `innerHTML` on any new render path; no markdown on detail
- [ ] `src/ui/permissionDetail.ts` has zero `vscode` imports (node-env testable)
- [ ] apiKey-shaped keys redacted; detail capped at 2000 + marker
- [ ] Existing ACP permission tests unmodified and green

## Dependencies

- (none)

## Interfaces

- Consumes: `AcpServerRequest` (`src/ai/omp/acp.ts:27`), existing `AiChatPanelHostMessage`
  `permission_request` shape (`src/ui/aiChatPanelMessages.ts:52-58`) — both unchanged.
- Produces: `export const PERMISSION_DETAIL_CAP = 2000;` and
  `export function buildPermissionToolInfo(toolCall: unknown): { id: string; name: string; detail: string }`
  in `src/ui/permissionDetail.ts` (pure, total over `unknown`).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
omp's server-side args field name inside `toolCall` is not verified (no omp source in repo).
Sanitizer accepts, in order: server `detail` string → `arguments` record → `args` record →
`""`. If omp sends none of these, behavior degrades to today's (empty detail) — safe. → @executor:
do NOT guess additional field names; if you observe a different field in a live session, note
it here and extend the ordered list.

---
