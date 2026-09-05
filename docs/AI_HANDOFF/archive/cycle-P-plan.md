# PLAN — Cycle P: permission detail + builtin tool-call streaming UI + VSIX release pass

## §1 Intent

Final backlog sweep, 3 items (user-approved "do all of them"):

1. **Permission detail** — ACP `session/request_permission` currently renders tool id/name
   and a detail line that is effectively always empty (`aiChatPanel.ts:601-602` passes the
   server string through; omp sends nothing useful). Users must Allow/Deny blind. Surface the
   tool's arguments safely: host builds a plain-text detail (SQL preview for `run_sql`,
   pretty JSON otherwise), size-capped; webview renders it collapsible. Success: an Allow/Deny
   dialog shows *what* the tool will do.
2. **Builtin tool-call streaming UI** — Cycle N streams text deltas live, but tool calls only
   appear via `onStep` **after** the whole step (model reply + tool execution) completes
   (`src/ai/agent.ts:259-268` → `aiChatPanel.ts:399-406` posts one label, `toolCalls[0]`
   only). During a multi-tool run the panel looks frozen. Surface each tool call the moment
   the model emits it (before execution), one step line per call. Success: `→ run_sql`
   appears while the SQL is still executing; abort stops new step lines immediately.
3. **VSIX release pass** — `npm run package` (`vsce package`) must produce a clean,
   marketplace-ready `.vsix`: version bump 1.5.1 → 1.6.0, add CHANGELOG.md (vsce warns
   without it; Marketplace "Changes" tab empty), verify artifact contents (dist/ + assets in;
   src/, node_modules/, maps out), document release steps. **No publishing.**

## §2 Scope

**In-scope**
- `src/ui/permissionDetail.ts` (new, pure) + host wiring in `handleAcpServerRequest`.
- Webview permission detail rendering (collapsible, textContent-only) + CSS.
- `AgentCallbacks.onToolCall` (additive hook) + panel wiring; webview `step` case reused.
- package.json version bump, CHANGELOG.md (new), docs/RELEASE.md (new), .vscodeignore audit.

**Out-of-scope**
- No changes to ACP engine turn flow, session resume, replay buffers (cycles M/N frozen).
- No agent-loop restructure — only the one additive callback; loop shape untouched.
- No `vsce publish`, no marketplace upload, no CI changes.
- No new npm runtime or dev dependencies.
- ACP-side tool-call streaming (omp already streams its own updates) — slice 2 is builtin-only.

**File ownership (wave constraint)**

| Task | Files owned |
|------|-------------|
| TASK-001 | src/ui/permissionDetail.ts (new), src/ui/aiChatPanel.ts, webview/aiChatPanelMain.ts, webview/styles.css, src/ui/__tests__/permissionDetail.test.ts (new), src/ui/__tests__/aiChatPanelAcp.test.ts, src/ui/__tests__/aiChatPanelWebview.test.ts |
| TASK-002 | src/ai/agent.ts, src/ai/__tests__/agent.test.ts, src/ai/__tests__/agentStream.test.ts, src/ui/aiChatPanel.ts, src/ui/__tests__/aiChatPanel.test.ts |
| TASK-003 | package.json, CHANGELOG.md (new), docs/RELEASE.md (new), .vscodeignore |

TASK-001 and TASK-002 both own `src/ui/aiChatPanel.ts` → TASK-002 depends on TASK-001
(serialized across waves). TASK-003 is disjoint from both.

## §3 Approach

### Slice 1 — permission detail (TASK-001)

Server data is untrusted; all shaping happens host-side in a **pure module** (no vscode
import → node-env unit tests, mirrors `src/ai/omp/hostTools.ts` pattern):

```ts
// src/ui/permissionDetail.ts
export const PERMISSION_DETAIL_CAP = 2000;
export function buildPermissionToolInfo(toolCall: unknown): {
  id: string; name: string; detail: string;
};
```

Rules (frozen):
- `id`/`name`: string-guarded exactly as today (`aiChatPanel.ts:599-600`).
- detail source, first match wins:
  1. server-provided `detail` non-empty string → used as-is (still capped);
  2. else args object (`arguments` or `args` field, record-like): tool name `run_sql` +
     string `sql` → `SQL:\n<sql>`; otherwise `JSON.stringify(args, null, 2)`;
  3. else `""` (webview hides the row).
- Cap at `PERMISSION_DETAIL_CAP` chars, append literal `"… (truncated)"` when cut.
- Defense-in-depth redaction: any arg key matching `/api[-_]?key|secret|token|password/i`
  (case-insensitive) → value replaced with `"[redacted]"`. apiKey never crosses the ACP path
  today; this guards future/foreign tools.
- Webview: if detail ≤ 120 chars and single-line → current plain `<div>`; else
  `<details><summary>Show tool details</summary><pre>` — every node set via `textContent`,
  never `innerHTML`. Empty detail → no node at all. Add missing `.UnicDB-chat-permission*`
  styles (grep shows zero rules in `webview/styles.css` today).

Rejected: rendering raw JSON in the dialog body (noise for 1-line SQL); parsing args in the
webview (untrusted data must not reach webview logic); sending untruncated detail (memory +
CSP-safe but bloated bubbles).

### Slice 2 — builtin tool-call streaming UI (TASK-002)

The only place tool calls can be surfaced *before* execution is inside the loop at
`src/ai/agent.ts:259`. Additive hook, loop untouched otherwise:

```ts
// AgentCallbacks (src/ai/agent.ts)
/** Fires once per tool call, immediately before executeToolCall, in order.
 *  Not fired for steps without tool calls. Fires regardless of abort state —
 *  the panel gates posting on its token. */
onToolCall?(call: ToolCall): void;
```

Panel wiring (`runBuiltinTurn` callbacks): post `{ type: "step", label: call.name || "tool" }`
gated on `token?.aborted`; delete the now-dead tool-step branch in `onStep`
(`aiChatPanel.ts:399-406`) so each call posts exactly once (clean cutover — no duplicate
"→ name" after step completion). Webview unchanged (`step` case + `appendStep` exist,
`webview/aiChatPanelMain.ts:571`, `:243`). ACP engine path untouched.

Edge semantics: empty tool name → label `"tool"`; abort mid-run → gate drops later step
lines (same gate `onText` already uses, `aiChatPanel.ts:347`); assistant-only final step →
still no step line; `agent_thought_chunk` never rendered (unchanged, `aiChatPanel.ts:567`).

Rejected: emitting from `onStep` only (post-execution = current bug); new message type
(`step` already fits); hooking `executeToolCall` itself (error policy + registry concern).

### Slice 3 — VSIX release pass (TASK-003)

Audit results (grounded): `repository`/`license: MIT`/`icon: media/icon.png`/`engines
^1.75.0` all present; README.md + LICENSE exist; `.vscodeignore` already excludes src/,
webview/, tests/, docs/, node_modules/, `**/*.map`, agent dirs. Gaps: version 1.5.1 (stale),
no CHANGELOG.md, no release doc. Actions: bump to `1.6.0`, add CHANGELOG.md (Keep a
Changelog format, 1.6.0 entry summarizing cycles M–P), add `docs/RELEASE.md` (exact
`npm run package` → verify listing → install-via-vsix → publish-later steps), sanity-check
`.vscodeignore` (expected: no edit needed; document why). Tests = artifact assertions
(script exit code, .vsix exists, `unzip -l` contains dist/extension.js, dist/aiChatPanel.js,
dist/webview.js, dist/webview.css, media/icon.png, README.md, LICENSE, package.json,
extension.vsixmanifest; and contains NO `src/`, `node_modules/`, `tests/`, `docs/`,
`*.map` entries). No runtime surface → no vitest file (justified in task Test Files).

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| unit (T1) | `buildPermissionToolInfo` renders SQL preview | `run_sql` + `{sql:"SELECT 1"}` → detail `"SQL:\nSELECT 1"`, id/name passthrough |
| unit (T1) | pretty-JSON fallback for object args | non-sql tool `{schema:"public"}` → detail = `JSON.stringify(...,null,2)` |
| edge (T1) | boundary: >2000-char detail | result length ≤ 2000 + marker, ends `"… (truncated)"` |
| edge (T1) | malformed input: non-string detail / non-object toolCall / secret-like key | detail `""` or redacted `"[redacted]"`; never throws |
| unit (T1, host wiring) | ACP permission_request carries built detail | posted msg `tool.detail` equals sanitizer output (regression: existing opaque-ID flow unchanged) |
| unit (T1, webview) | collapsible render for long detail | `<details>` + `<pre>`, text via textContent, no innerHTML |
| edge (T1, webview) | empty detail | no detail node rendered |
| unit (T2) | onToolCall fires once per call, before execution | 2 calls → 2 callbacks, each before its tool result message, in order |
| unit (T2, panel) | live step lines during builtin turn | one `{type:"step"}` per tool call posted before tool completes; no duplicate step after step end |
| edge (T2) | abort mid-tool | token flipped → no further step posts (gate) |
| edge (T2) | boundary: empty tool name | label `"tool"` |
| regression (T2) | assistant-only final step | no step message posted; existing `stepIdx < assistantIdx` assertion still green |
| artifact (T3) | `npm run package` happy path | exit 0, `UnicDB-1.6.0.vsix` exists, required entries in `unzip -l` |
| edge (T3) | exclusion audit | listing has no `src/`, `node_modules/`, `tests/`, `docs/`, `*.map` |
| edge (T3) | embedded metadata | vsix package.json shows version 1.6.0, license MIT, repository URL |
| regression (T3) | typecheck after metadata edits | `npm run typecheck` exit 0 |

## §5 Verification Commands

All from `package.json` scripts (`npm test` = `vitest run`, args after `--` pass through):

- TASK-001: `npm run typecheck && npm test -- src/ui/__tests__/permissionDetail.test.ts src/ui/__tests__/aiChatPanelAcp.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts`
- TASK-002: `npm run typecheck && npm test -- src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts src/ui/__tests__/aiChatPanel.test.ts`
- TASK-003: `npm run typecheck && npm run package && unzip -l UnicDB-1.6.0.vsix`
- Wave boundary (orchestrator): full `npm test` — 819-test baseline must hold.

## §6 Acceptance

- [ ] Permission dialog shows capped, textContent-only detail w/ SQL preview (TASK-001)
- [ ] Long detail collapsible; empty detail hidden; no innerHTML on any new path (TASK-001)
- [ ] Existing ACP permission tests still pass — opaque-ID/one-shot semantics untouched (TASK-001)
- [ ] Builtin turn posts one step line per tool call before execution; no duplicates (TASK-002)
- [ ] Abort stops step lines; assistant-only steps post none; `npm test` suite green (TASK-002)
- [ ] `UnicDB-1.6.0.vsix` packages clean with correct contents; CHANGELOG + RELEASE doc added (TASK-003)
- [ ] No new deps; no apiKey in webview/ACP; read-only DB boundary untouched

## §7 Global Constraints (inherited by every TASK file)

- No new npm runtime or dev dependencies.
- Host code pure where possible (new sanitizer = zero vscode imports).
- apiKey never sent to webview or across ACP; `agent_thought_chunk` never rendered.
- Read-only DB boundary (`isReadOnlySql` in `src/ai/tools/sqlTool.ts`) untouched.
- builtin + ACP engine paths must not regress — 819-test suite baseline.
- Webview rendering of any server/tool data: `textContent` only, no `innerHTML`, no markdown.
- Tasks ≤4; per-task TDD ≥1 happy + ≥2 distinct edge kinds + regression.
- Verification commands from package.json scripts only (`vsce package` allowed for TASK-003).
- No commit from planner; no `vsce publish`.

## Risk table

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| omp sends unexpected `toolCall` shapes → sanitizer throws, kills permission flow | Low | High | Sanitizer total function over `unknown`, never throws; unit tests for malformed input |
| Duplicate step lines (old onStep branch left alive) | Medium | Medium | Task mandates deleting the dead branch; panel test asserts exactly N step posts |
| onToolCall ordering breaks agentStream expectations | Low | Medium | agentStream.test.ts in TASK-002 verification; hook fires outside stream path |
| vsce includes/excludes wrong paths (bundle drift) | Medium | Medium | unzip -l assertions are the task's tests; .vscodeignore already audited grounded |
| Wave conflict on aiChatPanel.ts | Certain if parallel | High | TASK-002 depends on TASK-001 (serialized wave 2) |
| CHANGELOG/version drift with future cycles | Low | Low | RELEASE.md documents bump step per release |

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing
Known gaps: none — slice-3 has no vitest file by design (artifact assertions documented in TASK-003); omp's actual `request_permission` args field name is unverified server-side, so the sanitizer opportunistically accepts `detail` → `arguments` → `args` and degrades to "" (stated in TASK-001 Discussion).

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Plan Review Log

### Round 1 — 2026-08-24 · unic/unic-smart (PlanRevP)
Status: Approved

COMPLETENESS:
  - none — all three slices cover the user ask (permission detail w/ SQL preview + 2000 cap + textContent; live builtin tool-call steps; VSIX pass, no publish)
CONSISTENCY:
  - none — wave1 T001/T003 file sets are verifiably disjoint (T001: src/ui+webview+3 test files; T003: package.json/CHANGELOG/docs/RELEASE.md/.vscodeignore); T002→T001 dependency covers the shared aiChatPanel.ts; test files also disjoint between T001/T002
CLARITY:
  - MIN-1: TASK-001 test #2 fixture is `args:{schema:"public", table:"users"}` but Expected says `JSON.stringify({schema:"public"},null,2)` — a literal reading fails against a correct impl (which stringifies the whole args object). Executor: assert `JSON.stringify` of the full fixture args; fixture is authoritative.
SCOPE:
  - none — one additive callback, no loop restructure, no publish, no new deps
YAGNI:
  - none — rejected alternatives recorded; slice-3 vitest exemption justified

Evidence spot-checks: 819-pass baseline re-run green (2 skipped); scripts/typecheck/package/vscode:prepublish at package.json:362-363 as cited; .vscodeignore already excludes src/webview/tests/docs/node_modules/**/*.map/scripts; no CHANGELOG.md exists today; agent.ts:259 loop, aiChatPanel.ts:399-406 dead branch, :599-602 string guards, :347 abort gate, :567 thought-chunk guard, provider.ts ToolCall shape, messages.ts step/permission shapes — all match plan citations; install-UnicDB.sh supports --local/--dry-run; `vsce publish` appears only as explicit out-of-scope.

NOTES: Version 1.6.0 justified (user-visible features across M–P). MIN-1 is cosmetic; no re-plan needed.
