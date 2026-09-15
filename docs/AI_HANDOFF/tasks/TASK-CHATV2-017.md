# TASK-CHATV2-017 — V1 cutover, legacy deletion and complete quality gate
- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§7–9

## Goal
Make V2 the sole production chat UI, remove compatibility/V1 code and prove the bundled VS Code webview meets functional, security, visual, accessibility and lifecycle gates. This task does not release or bump version.

## Target Files
- `webview/aiChatPanelMain.ts` — minimal V2 boot only.
- `src/ui/aiChatPanel.ts` — V2-only frames/intents and root class.
- `src/ui/aiChatPanelV1Adapter.ts` — delete.
- `webview/aiChatPanelComposer.ts` — delete after all imports/tests migrate.
- `webview/aiChatPanelHeader.ts` — delete after all imports/tests migrate.
- `webview/aiChatPanelThread.ts` — delete or retain only proven shared safe Markdown primitive under accurate name.
- `webview/styles.css` — remove legacy chat blocks; retain unrelated webviews unchanged.
- Legacy clone/V1 tests — replace/delete only with mapped V2 coverage.
- `docs/CODE_MAP.md`, `docs/PROJECT.md`, `docs/WORKLOG.md`, `docs/AI_CHAT_PROFESSIONAL_SPEC.md` — update source truth/status.

## Required Work / Exact Spec
Use 001 cutover map and prove every legacy symbol/selectors/test disposition. Remove: V1 module-level UI flags, duplicate composer/main keyboard handlers, direct slash textarea mutation, keyup-only mention flow, disabled mic, paper-plane send, unconditional `— streaming`, DOM `innerText` export, silent clipboard catch, V1 adapter and old clone CSS. Search must show no live import/reference except historical docs/tests explicitly labeled legacy.

Final `aiChatPanelMain.ts` acquires API once, mounts shell/controller once, posts `ready_v2`, routes typed V2 frames and disposes cleanly. `buildHtml()` root is `.UnicDB-ai-chat-v2` without relying on `.UnicDB-chat` styling. CSP stays at least as strict: no remote scripts/styles/fonts, no eval, images only self/data as required. No localStorage/sessionStorage/IndexedDB.

Run full behavior matrix: KBD-01–08; SLASH-01–08; MENTION-01–10; ENGINE-01–04; SAFE-01–04; visual cases. Verify permission, change plan, tool timeline, thought capability gating, attachment, model, schema, sessions, export, Stop/retry and clear all through production bundle—not only direct modules.

Manual/bundled visual gate: capture or document observed screenshots at widths 320, 420, 480, 768, 1200; dark/light/high contrast; 200% zoom; reduced motion. States: empty idle, long user+assistant, streaming+caret, expanded/collapsed activity, reasoning allowed/unavailable, tool success/fail/deny, pending permission, error, slash, mention loading/results/empty/error, attachment strip, long chips, busy next draft, stopped partial, session/export. Compare against PLAN geometry: header 40; composer top 64–160; action min48; send/stop40; control>=32; rows40/44; no overlap/clipping/page horizontal overflow.

Lifecycle/soak: open/close panel 20 times and assert one handler/effect; stream representative deltas for 10 minutes with stable CPU/memory/no unbounded node growth; 200 messages <=200 rendered units; cancel/terminal race has one terminal state; no stale frame opens UI. Verify dark/light theme switch live.

Security review: recursive frame snapshots contain no secrets/base64/raw trace/stderr; XSS corpus remains inert; permission default deny; bypass preserves SQL/trust gates; export/session excludes forbidden data. Run package build if needed only as validation, but do not create release artifact, increment version, commit, push or publish unless separately requested.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | cutover | legacy search | no live V1 imports/listeners/selectors/adapter/dead controls |
| 2 | bundle E2E | all main flows | production bundle handles every behavior family |
| 3 | security | CSP/schema/XSS/privacy | no weakened boundary or forbidden payload |
| 4 | lifecycle | 20 remounts | one listener/event/action per interaction, no timer leak |
| 5 | performance | 10-minute/200-message soak | bounded DOM, responsive scroll, no content duplication |
| 6 | visual | state/theme/width/zoom matrix | exact dimensions; no clipping/overlap/overflow |
| 7 | accessibility | keyboard/HC/reduced motion | complete operation and understandable status |
| 8 | regression | all existing AI host/tool/database paths | full suite green; unrelated webviews unchanged |

## Test Files
- `src/ui/__tests__/aiChatPanelV2E2e.test.ts` — new production bundle flow suite.
- All `webview/aiChat/__tests__/*.test.ts` and mapped existing host tests.
- Delete old tests only when their behavior is superseded and mapped in 001; never delete a failing test merely to pass.

## Verification Commands
```bash
npm run typecheck
npm run compile
npm test
node -e 'const fs=require("fs");const files=["webview/aiChatPanelMain.ts","src/ui/aiChatPanel.ts","webview/styles.css"];const t=files.map(f=>fs.readFileSync(f,"utf8")).join("\n");for(const x of ["localStorage","sessionStorage","Voice input (coming soon)","paper-plane"]){if(t.includes(x)){console.error("forbidden",x);process.exit(1)}}'
test ! -e src/ui/aiChatPanelV1Adapter.ts
test ! -e webview/aiChatPanelComposer.ts
test ! -e webview/aiChatPanelHeader.ts
# Executor must append the real-webview visual/soak evidence paths and observed PASS results to Executor Report.
```

## Acceptance Criteria
- [ ] V2 is the only production UI and compatibility adapter is gone.
- [ ] No duplicate listeners, dead buttons, fake status or DOM-scraped export remains.
- [ ] Full npm test/typecheck/compile and production-bundle E2E pass freshly.
- [ ] Visual/zoom/theme/HC/reduced-motion/soak evidence is attached to report.
- [ ] Security/privacy/permission gates pass with no regression.
- [ ] Source-truth docs/worklog are updated.
- [ ] No version bump/package/publish occurs.

## Dependencies
- TASK-CHATV2-001 through TASK-CHATV2-016

## Interfaces
- Consumes: every V2 module/contract plus cutover map.
- Produces: sole production Chat V2 entry and final verified documentation; no compatibility output remains.

## Discussion
(no comments yet)