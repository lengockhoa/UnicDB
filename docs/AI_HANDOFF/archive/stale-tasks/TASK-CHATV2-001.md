# TASK-CHATV2-001 — Baseline, capability audit and cutover map

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§1–9

## Goal
Freeze current behavior and produce the migration map the remaining tasks consume. Make no runtime behavior change: inventory every host frame/intent, engine feature, legacy selector/listener and existing test that must be preserved, superseded or deleted.

## Target Files
- `docs/AI_HANDOFF/notes/chatv2-baseline.md` — new capability/audit table and baseline evidence.
- `docs/AI_HANDOFF/notes/chatv2-cutover-map.md` — new V1 symbol/selector/test → V2 owner/deletion map.
- `docs/AI_CHAT_PROFESSIONAL_SPEC.md` — correct only a fact proven stale; do not redesign.

## Required Work / Exact Spec
1. Inspect `src/ui/aiChatPanel*.ts`, `src/ai/{omp,claudeCode,codex}/**`, `webview/aiChatPanel*.ts`, `webview/styles.css`, `esbuild.js`, package scripts and mapped tests.
2. Produce four capability rows: builtin, OMP, Claude Code, Codex. Columns: text stream, reasoning stream, tools, permissions, bypass, image, model roles, native resume, saved transcript, provider commands, cancel, export. Every cell is `verified file:line`, `absent`, or `unknown`; never infer parity.
3. Record seven screenshots or reproducible DOM fixtures: empty/idle, long transcript, streaming, tool+reasoning, permission, error, slash+mention, plus widths 320/420/768 and dark/light/high-contrast where harness supports it.
4. Inventory every V1 `keydown`/`keyup`/`input`/click listener affecting send, slash, mention, attach, stop and model; name the V2 task that removes/replaces it. Explicitly flag composer/main duplicate Enter ownership.
5. Inventory IDs/classes pinned by tests. Classify `preserve temporarily`, `replace test`, or `delete at CHATV2-017`; permanent compatibility without a consumer is forbidden.
6. Confirm build entry remains `webview/aiChatPanelMain.ts` → `dist/aiChatPanel.js`; no CDN/framework/new dependency.
7. Record git baseline and focused test results. Do not change `src/`, `webview/`, `package.json`, version, bundle or release artifacts.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | Four-engine matrix | 4 rows × 12 columns; every cell evidenced or explicitly unknown |
| 2 | edge | Missing capability | Recorded `absent/unknown`, never silently treated false/true |
| 3 | regression | Duplicate keyboard path | Both current listener owners and deletion tasks are named |
| 4 | boundary | Cutover completeness | Every AI-chat source and mapped test has an owner/disposition |

## Test Files
- Existing AI chat tests only; no runtime test file is added because this task is evidence-only.

## Verification Commands
```bash
npm run typecheck
npm run compile
npm test -- --run webview/__tests__/aiChatPanelComposer.test.ts webview/__tests__/aiChatPanelThread.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelCommands.test.ts
node -e 'const f=require("fs");for(const p of ["docs/AI_HANDOFF/notes/chatv2-baseline.md","docs/AI_HANDOFF/notes/chatv2-cutover-map.md"]){if(!f.existsSync(p)||f.readFileSync(p,"utf8").length<1000)process.exit(1)}'
test -z "$(git diff --name-only -- src webview package.json esbuild.js)"
```

## Acceptance Criteria
- [ ] Matrix and cutover map are source-backed and name all four engines.
- [ ] Each legacy control/listener/test has a future owner or explicit final deletion.
- [ ] Baseline tests/build pass; runtime diff is empty.
- [ ] Unknown third-party/provider behavior is not represented as verified.

## Dependencies
- (none)

## Interfaces
- Consumes: current source/tests and `docs/AI_CHAT_PROFESSIONAL_SPEC.md`.
- Produces: matrix and cutover/deletion map consumed by TASK-CHATV2-002 through 017.

## Discussion
(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  FAIL tests/chatv2BaselineNotes.test.ts > #1 Four-engine matrix
  AssertionError: baseline must contain a 4-engine x 12-capability table: expected null not to be null
  FAIL tests/chatv2BaselineNotes.test.ts > #2 Missing capability
  AssertionError: expected null not to be null
  FAIL tests/chatv2BaselineNotes.test.ts > #3 Duplicate keyboard path
  AssertionError: must anchor the composer bubble-phase Enter listener: expected false to be true
  FAIL tests/chatv2BaselineNotes.test.ts > #4 Cutover completeness
  AssertionError: cutover map must be non-trivial: expected 0 to be greater than 1000
   Test Files  1 failed (1)
        Tests  4 failed (4)
Verification Output: |
  #1 npm run typecheck → tsc --noEmit, exit=0
  #2 npm run compile → esbuild build complete (aiChatPanel.js 73.6kb), exit=0
  #3 npm test -- --run webview/__tests__/aiChatPanelComposer.test.ts webview/__tests__/aiChatPanelThread.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/ui/__tests__/aiChatPanelCommands.test.ts
     → Test Files 4 passed (4); Tests 62 passed (62)
  #4 node -e '... existsSync + length>=1000 for both notes' → exit=0
  #5 test -z "$(git diff --name-only -- src webview package.json esbuild.js)" → exit=0 (empty runtime diff)
  Guard test tests/chatv2BaselineNotes.test.ts → 4 passed (4)
  Full suite npm test → Test Files 282 passed | 2 skipped; Tests 4180 passed | 5 skipped
Status: PASS
Note: Four capability cells recorded `unknown` (claude-code reasoning stream + bypass; codex tools + permissions) because the adapters declare callbacks with no emit site or expose no toggle; not inferred as parity. Screenshot states ship as jsdom DOM fixtures; widths 320/420/768 and dark/light/high-contrast are deferred to the CHATV2-017 real-bundle checklist (jsdom cannot prove geometry). Spec correction: the "normalized callbacks" claim at docs/AI_CHAT_PROFESSIONAL_SPEC.md §2 was narrowed to state only emitted kinds, proven stale by the two missing emit sites. All 112 file:line anchors validated in-range against this worktree.
