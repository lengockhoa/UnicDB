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
- `webview/styles.css` — add `.UnicDB-chat-permission`, `-header`, `-tool-id`, `-tool-name`,
  `-tool-detail`, `-detail pre`, `-actions` rules (grep confirms none exist today)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | SQL preview for run_sql | detail === `"SQL:\nSELECT 1 FROM t"`, id/name passthrough | `{id:"t1", name:"run_sql", arguments:{sql:"SELECT 1 FROM t"}}` |
| 2 | unit | pretty JSON fallback | detail === `JSON.stringify({schema:"public"},null,2)` | `{name:"describe_table", args:{schema:"public", table:"users"}}` |
| 3 | edge (boundary) | >2000-char detail cap | length ≤ 2000+len(marker), ends with `"… (truncated)"` | 5000-char sql string |
| 4 | edge (malformed) | non-string detail, non-object toolCall, missing args | returns `{id:"",name:"",detail:""}` or empty detail — never throws | `null`, `42`, `{detail:42}` |
| 5 | edge (secret) | secret-like key redacted | value replaced with `"[redacted]"` in output | `{arguments:{sql:"x", api_key:"sk-1"}}` |
| 6 | unit (host) | posted permission_request carries built detail + opaque ID unchanged | posted `tool.detail` matches sanitizer; requestId still `req-…`; options untouched | FakeAcp session per existing harness, server sends toolCall w/ args |
| 7 | unit (webview) | long detail → collapsible, textContent only | card contains `<details>`+`<pre>`; `el.innerHTML` never assigned on new nodes; pre.textContent === detail | jsdom render, 150-char detail |
| 8 | edge (webview) | empty detail | no `.UnicDB-chat-permission-tool-detail` node in card | detail `""` |
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


## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Implemented pure `buildPermissionToolInfo` sanitizer (cap + redact + SQL preview + pretty JSON); wired host `handleAcpServerRequest` to use it; webview `renderPermissionRequest` now collapses long detail into `<details><pre>` (textContent only); CSS rules added.
TEST_PLAN_FOLLOWED: task §4 (cases 1-9 covered)
FILES_CHANGED:
  - src/ui/permissionDetail.ts: (new) pure sanitizer, PERMISSION_DETAIL_CAP=2000, JSON_INDENT=2, recursive secret redaction (api_key/authorization/bearer/password/secret/token), SQL preview path for run_sql/execute_sql/sql, 2000-char cap with '… (truncated)' marker.
  - src/ui/aiChatPanel.ts: handleAcpServerRequest now uses buildPermissionToolInfo(toolCall) — id/name/detail derived from sanitizer, requestId still host-generated opaque, options untouched.
  - webview/aiChatPanelMain.ts: renderPermissionRequest delegates detail rendering to new `permissionDetailNode(detail)`; empty detail omits node, short single-line (<=120 chars, no newline) → plain div, otherwise → `<details><summary>Show tool details</summary><pre>` with textContent only.
  - webview/styles.css: added `.UnicDB-chat-permission`, `-header`, `-tool-id`, `-tool-name`, `-tool-detail`, `-tool-detail pre`, `-actions` rules.
  - src/ui/__tests__/permissionDetail.test.ts: (new) cases 1-5.
  - src/ui/__tests__/aiChatPanelAcp.test.ts: added `feedPermissionRequestWithArgs` helper + cases #6a (sanitizer wired to host; opaque requestId unchanged; options untouched) and #6b (run_sql SQL preview).
  - src/ui/__tests__/aiChatPanelWebview.test.ts: added cases #7 (long detail → `<details><pre>`, textContent only), #7b (short detail → plain div), #8 (empty detail → node omitted).
TESTS_ADDED:
  - src/ui/__tests__/permissionDetail.test.ts: 5 cases (SQL preview, pretty JSON full args, 2000-char cap, malformed inputs, secret redaction)
  - src/ui/__tests__/aiChatPanelAcp.test.ts: 2 cases (#6a, #6b)
  - src/ui/__tests__/aiChatPanelWebview.test.ts: 3 cases (#7, #7b, #8)
VERIFICATION:
  command: npm run typecheck && npm test -- src/ui/__tests__/permissionDetail.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
  result: typecheck exit 0; 42 tests pass (5+13+24)
  output_excerpt: |
    ✓ src/ui/__tests__/permissionDetail.test.ts  (5 tests)
    ✓ src/ui/__tests__/aiChatPanelAcp.test.ts  (13 tests)
    ✓ src/ui/__tests__/aiChatPanelWebview.test.ts  (24 tests)
    Test Files  3 passed (3)
    Tests  42 passed (42)
RED_OUTPUT (verbatim, before implementation):
  FAIL  src/ui/__tests__/permissionDetail.test.ts [ src/ui/__tests__/permissionDetail.test.ts ]
  Error: Failed to load url ../permissionDetail (resolved id: ../permissionDetail) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/src/ui/__tests__/permissionDetail.test.ts. Does the file exist?
    Test Files  1 failed (1)
    Tests  no tests
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

### 2026-08-24 · executor · unic/unic-code
Observed one host-side gotcha while wiring: the existing `handleAcpServerRequest` had an inline `toolDetail` derivation using `typeof toolCall?.detail === "string"` plus a `const options = Array.isArray(p.options) ? p.options : [];` line. The sanitizer replacement collapses both into `buildPermissionToolInfo(toolCall)`, which preserves `tool.id` / `tool.name` / `tool.detail` from the same payload. Reviewer minor folded in: case #2 expected assertion uses full `JSON.stringify({schema:"public", table:"users"}, null, 2)`.
---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm test -- src/ui/__tests__/permissionDetail.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts
  result: 42 pass / 0 fail (typecheck exit 0)
TEST_PLAN_COVERAGE: all-followed (cases 1-9 real assertions; #2 asserts FULL args stringify — round-1 minor folded)
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ui/__tests__/permissionDetail.test.ts — RED_OUTPUT captures only this new file (module-load FAIL); cases #6a/#6b/#7/#7b/#8 lack pre-implementation RED captures. Non-blocking: all tests real, fresh-pass on rerun.
    - src/ui/permissionDetail.ts:44 — redactSecrets recurses with no cycle guard; a self-referential toolCall would stack-overflow before the JSON.stringify try/catch. Unreachable via JSON-parsed ACP wire; guard if ever called on live objects.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Sanitizer pure (zero imports) and total over wire-realistic input; detail→arguments→args→"" order + 2000 cap + recursive api_key redaction verified at permissionDetail.ts:76-113. Host aiChatPanel.ts:600-631 keeps opaque req- requestId and options untouched; webview permissionDetailNode (aiChatPanelMain.ts:373-394) is textContent-only (empty→omitted, ≤120 single-line→div, else details/pre); hostile `<script>`/`<img onerror>` render literal text. No innerHTML on any new render path.
