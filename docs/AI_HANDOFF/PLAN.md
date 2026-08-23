# PLAN — Cycle M: approval-aware omp ACP bridge

## §1 Intent
Replace Cycle L’s long-lived `omp --mode rpc --approval-mode yolo` bridge with an ACP stdio bridge. A user must explicitly Allow or Deny every omp permission request in VSDB chat; no response, stop, panel disposal, or process exit denies it. Preserve the builtin agent fallback, never send an API key to the webview/ACP path, and keep DB operations behind VSDB’s existing read-only tools.

## §2 Scope
**In:** typed injected JSON-RPC/NDJSON ACP transport with server-request routing; proof-first safe lifecycle/cwd probe; `initialize → initialized → newSession → prompt`; `session/update` text streaming only; correlated permission UI/response; ACP process launch without yolo; panel/extension migration; removal of obsolete Cycle L RPC/process code after every caller migrates; and focused tests. **Out:** ACP SDK/new runtime, bundling omp, telemetry/backend, DB-tool bypass, model/tool live smoke, and changing builtin behavior. No dependency is added unless TASK-001 proves it necessary.

`AcpClient` is a pure injected JSON-RPC transport: `request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>`, `onNotification(cb)`, `handleRequest(cb)`, `respond(id, result)`, `respondError(id, error)`, and `dispose()`. It serializes client IDs, parses NDJSON, and routes server `session/request_permission` calls by their JSON-RPC request ID. It does not own permission timeouts. Before implementation assumptions reach consumers, TASK-001’s opt-in no-prompt probe must prove the initialize capabilities/`initialized` exchange, minimal `newSession` request/returned session ID, and whether `omp acp --cwd` is accepted. The probe must use child-process `cwd` and must never prompt, invoke a model, register a tool, or make a permission request.

`AcpProcess.start()` always supplies spawn `cwd`; it adds `--cwd` only if TASK-001 records that support. It exposes the proven session lifecycle plus notifications. Verified ACP facts: `session/update` includes `agent_message_chunk`; server request `session/request_permission` includes `{sessionId,toolCall,options}` and must receive selected `optionId` or cancelled outcome. The panel maps a request to a host-generated opaque ID, renders all tool/details/options as plain text, accepts only its currently-pending opaque IDs and listed option IDs, and writes exactly one correlated ACP result. It default-denies pending requests on timeout, stop, panel disposal, replacement, and process exit; late/duplicate responses are ignored. `agent_thought_chunk` is ignored. Existing `createDbTools`/`createSqlTool` remains the read-only DB chokepoint; ACP workspace permission never bypasses it. Detection/fallback stays intact.

## §4 TDD Test Plan
| Type | Test Name | Expected |
|---|---|---|
| happy | ACP server request routing | fake `session/request_permission` calls receive exactly one result with the matching JSON-RPC ID |
| edge—malformed | invalid/unknown JSON-RPC frame | ignored without settling a pending client request or handler |
| edge—concurrent | two incoming permission requests | each gets only its own correlated response |
| edge—lifecycle | timeout/stop/dispose/exit/replacement | every pending permission gets one cancelled ACP result |
| regression | builtin chat and DB read-only host tools | builtin still posts final/done; destructive SQL remains rejected |
| gated probe | `VSDB_OMP_ACP_SMOKE=1` lifecycle/cwd proof | initialize capabilities + initialized + no-prompt newSession/session ID are recorded; spawn `cwd` works and `--cwd` support is explicitly recorded |

## §5 Verification
`npx vitest run src/ai/omp/__tests__/acp.test.ts src/ai/omp/__tests__/acpProcess.test.ts && npm run typecheck`; `npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanel.test.ts src/extension.test.ts && npm run compile && npm run typecheck`. `package.json` has no lint script. ACP smoke is opt-in only: `VSDB_OMP_ACP_SMOKE=1 npx vitest run src/ai/omp/__tests__/acpLiveSmoke.test.ts`; do not run it unless the fixture remains initialize-only.

## §6 Acceptance
- [ ] ACP spawn always scopes the child to workspace `cwd`, never enables yolo/auto approval, and uses `--cwd` only when proof-supported. (TASK-001/002/004)
- [ ] ACP’s proven lifecycle initializes, creates one session, prompts it, and streams only assistant message chunks. (TASK-001/002/004)
- [ ] Permission Allow selects only a listed option for its matching opaque request; Deny/default paths write one cancelled ACP result. (TASK-003/004)
- [ ] Timeout, stop, disposal, replacement, and process exit deny all pending permissions; late/duplicate responses do nothing. (TASK-004)
- [ ] Tool/detail/option text is not rendered as HTML/markdown; no apiKey crosses webview/ACP; DB execution remains existing read-only guarded tooling. (TASK-003/004)
- [ ] Focused tests, compile, and typecheck pass in executor/reviewer gates. (all)

## §7 Task Split & Global Constraints
Wave 1: TASK-001 ACP client + proof-first safe lifecycle/cwd probe; TASK-003 permission message protocol/webview. Wave 2: TASK-002 ACP process lifecycle (depends TASK-001). Wave 3: TASK-004 panel/extension migration, permission coordinator, and legacy RPC removal (depends TASK-001, TASK-002, TASK-003). Same-wave tasks have no shared files.

**Global constraints:** VS Code engine remains `^1.75.0`; TypeScript/Node extension host only; no new dependency/runtime unless TASK-001 proves necessary; preserve names/copy conventions; no telemetry/backend/bundled omp; apiKey never crosses webview/ACP; default-deny is mandatory; DB access remains VSDB read-only guarded.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: separated ACP transport, ACP process, permission UI, and panel ownership to eliminate same-wave collisions; bounded unverified ACP details to an initialize-only probe. Independent review corrections: added server-request routing, proof-gated lifecycle/cwd, deferred legacy removal to panel migration, and strengthened plain-text/default-deny ordering coverage.
Known gaps: exact ACP envelopes are unavailable until TASK-001’s safe no-prompt probe; TASK-002/TASK-004 must consume its recorded evidence and must not invent unsupported fields.


## Plan Review Log — Cycle M

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart (configured reviewer tier cannot differ from planner under the stated policy; independent review performed, but model-isolation limitation remains)

1. **Incoming request routing is unspecified and TASK-001 tests the wrong direction.** §3 exposes only `request()` and `onNotification()`, but `session/request_permission` is a server-initiated JSON-RPC *request*, not a notification or a response to a host request. Amend TASK-001 to add a typed incoming-request handler and matching JSON-RPC result/error writer keyed by the server request ID; replace its “two concurrent permission requests” test with two injected incoming requests and assert exact correlated outgoing results. Move permission timeout/cancellation ownership to TASK-004’s coordinator, which alone has panel lifecycle state.
2. **Workspace scoping is committed without evidence.** `omp acp --help` has no documented `--cwd`, yet §3/TASK-002 require it. TASK-001 must proof-gate this before T2: launch with child-process `cwd`, probe whether `--cwd` is accepted, and record the observed result. T2 must always pass spawn `cwd`; include `--cwd` only when the probe proves support (and test both the mandatory spawn option and selected arguments).
3. **The initialize-only probe cannot establish the deferred lifecycle envelope.** §2/§3 defer initialize capabilities, `initialized`, and `newSession` inputs, while TASK-001 merely asserts a response to `initialize`. Make TASK-001 an executable proof-first gate: capture/assert the required initialize capabilities and initialized exchange, then the minimal no-prompt `newSession` request/response (including returned session ID), with no prompt/tool/model invocation. If that safe exchange cannot be evidenced, T2/T4 must not invent envelopes.
4. **Legacy deletion conflicts with its declared dependency boundary.** TASK-002 removes `process.ts`/`rpc.ts`, but current `src/ui/aiChatPanel.ts:40-41` and `src/extension.ts:27` still import them and TASK-004 alone owns panel migration. Either retain deletion until TASK-004 migrates every caller, or move those panel imports/interfaces and integration migration into TASK-002; require its typecheck to prove the clean cutover.
5. **Permission UI requirements are not testable enough for the security boundary.** TASK-003/004 must specify and test that every request/tool/detail/option label is rendered as text (never `innerHTML`/markdown), only host-generated opaque request IDs are accepted, selected option IDs must belong to that request, duplicate/late/disposed responses are ignored, and denial writes the ACP cancelled result exactly once. Add ordering tests for response-before/after timeout, replacement, exit, and panel disposal; do not expose `agent_thought_chunk`.

Verification note: package scripts do provide `npm run typecheck` (not `npx tsc --noEmit`); existing verification uses the valid script.

### Revision — 2026-08-23 · planner · unic/unic-smart
All five CHANGES-REQUESTED findings applied: server-request correlation; safe lifecycle/cwd proof gate; conditional `--cwd`; deferred legacy deletion to TASK-004 caller migration; and text-only/default-deny/late-response test coverage. Ready for re-review.


### Re-review — 2026-08-23 · unic/unic-smart
VERDICT: APPROVED

All five required corrections are present and consistently assigned: TASK-001 separates incoming server requests and produces proof-first lifecycle/cwd evidence; TASK-002 consumes conditional cwd evidence; TASK-004 owns lifecycle denial and deferred legacy cutover; TASK-003/004 now require text-only opaque-ID permission handling and race coverage. Existing package verification correctly uses `npm run typecheck`.

NOTES: Reviewer and planner are both `unic/unic-smart`; the required model-isolation limitation remains recorded above.

## Re-review — Cycle M (fix round 1 evidence)

VERDICT: APPROVED

All five round-1 plan findings are resolved and verifiably reflected in PLAN §2/§4 and TASK-001..004:

1. **Server-request correlation** — §2 exposes `handleRequest(cb)`/`respond(id,result)`/`respondError(id,error)`; TASK-001 test 3 injects two incoming `session/request_permission` requests and asserts each receives its own correlated JSON-RPC result ID.
2. **Workspace scoping proof** — §2 and TASK-001 test 5 probe child-process `cwd` and record `--cwd` acceptance; TASK-002 test 2 asserts spawn always supplies `cwd` and adds `--cwd` only when the probe proves support.
3. **Probe gates lifecycle envelope** — §4 gated-probe row and TASK-001 test 5 require capturing initialize capabilities, the `initialized` exchange, and a minimal no-prompt `newSession` with returned session ID (no model/prompt/tool use).
4. **Legacy deletion deferred** — TASK-002 no longer removes `rpc.ts`/`process.ts`; TASK-004 goal + test 6 own caller migration and delete them only after all imports/tests migrate and typecheck passes.
5. **Permission security tightened** — TASK-003 tests 3–4 require text-only (no `innerHTML`/markdown) rendering and single-response emission; TASK-004 tests 1–5 require opaque-ID + listed-option acceptance, one cancelled result on deny/stop/dispose/exit/timeout/replacement, and late/duplicate/disposed responses ignored, with `agent_thought_chunk` never surfaced.

REVIEWER_MODEL: unic/unic-smart

NOTES: Planner and reviewer both resolve to `unic/unic-smart`; the model-isolation limitation persists (no distinct reviewer tier is available), as already recorded in the log above.
