# CHATV2-001 — Cutover and deletion map

- Task: `docs/AI_HANDOFF/tasks/TASK-CHATV2-001.md`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§7–9
- Companion: `docs/AI_HANDOFF/notes/chatv2-baseline.md`
- Git baseline (worktree `handoff/task-chatv2-001`): `0a3d3b772629356bd6415dac571fdc6008e273f1`

Each line below names one V1 symbol / selector / test path and the V2 task that either
**preserves** it, **replaces** it, **deletes** it, or keeps it **temporary** until the final
deletion wave. Disposition keywords are deliberately explicit: `preserve`, `replace`,
`delete`, `temporary`. No V1 artifact keeps permanent compatibility without a consumer
(`PLAN.md:86`).

## 1. AI-chat source paths — disposition and owner

| Source path | Disposition | Owner task | Notes |
|---|---|---|---|
| webview/aiChatPanelMain.ts | replace | CHATV2-008 / CHATV2-009 / CHATV2-011 | V1 DOM composition, message handling, slash/mention; split into controller + transcript + composer. |
| webview/aiChatPanelComposer.ts | replace | CHATV2-008 | Refactor into `webview/aiChat/composer.ts`; no competing key listeners retained. |
| webview/aiChatPanelThread.ts | replace | CHATV2-006 | Safe render primitives reused, module replaced by `webview/aiChat/transcript.ts`. |
| webview/aiChatPanelHeader.ts | replace | CHATV2-005 | Header rebuilt as v2 shell component. |
| webview/styles.css | temporary | CHATV2-005 → CHATV2-017 | `.UnicDB-chat` rules kept live during migration, then deleted at CHATV2-017 in favour of `.UnicDB-ai-chat-v2`. |
| webview/main.ts | preserve | — | Console/results webview; chat CSS is disjoint. No chat change. |
| esbuild.js | preserve | — | Entry `webview/aiChatPanelMain.ts` → `dist/aiChatPanel.js` (esbuild.js:88-89) unchanged. |
| src/ui/aiChatPanel.ts | preserve | CHATV2-002 / CHATV2-003 | Host orchestration authority; extended with capabilities frame, not rewritten. |
| src/ui/aiChatPanelMessages.ts | replace | CHATV2-003 | Extended to versioned V2 discriminated frames; V1 frames kept via compatibility adapter only during migration. |
| src/ui/aiChatPanelCommands.ts | preserve | CHATV2-010 | Local command registry becomes the slash-menu source; engine gating extended. |
| src/ui/aiChatAttachments.ts | preserve | CHATV2-013 | Attachment validation/caps unchanged; UI re-points at it. |
| src/ai/omp/ompChatEngine.ts | preserve | CHATV2-002 | Engine adapter emits capability snapshot; event contract unchanged. |
| src/ai/claudeCode/claudeCodeChatEngine.ts | preserve | CHATV2-002 | Adapter kept; capability gaps recorded `unknown` in baseline. |
| src/ai/codex/codexChatEngine.ts | preserve | CHATV2-002 | Adapter kept; capability gaps recorded `unknown` in baseline. |
| src/ai/engineChoice.ts | preserve | CHATV2-012 | Engine resolution policy reused by the engine menu. |
| src/ai/provider.ts | preserve | CHATV2-002 | Builtin provider client; streaming contract unchanged. |
| src/ai/agent.ts | preserve | CHATV2-002 | Builtin agent loop + callback surface unchanged. |

## 2. Mapped AI-chat test paths — disposition and owner

| Test path | Disposition | Owner task | Notes |
|---|---|---|---|
| webview/__tests__/aiChatPanelComposer.test.ts | replace | CHATV2-008 | Pins `#prompt` / `#sendBtn` / `#stopBtn`; superseded by controller/composer v2 tests. |
| webview/__tests__/aiChatPanelThread.test.ts | replace | CHATV2-006 | Safe-render primitives re-tested against the v2 transcript. |
| webview/__tests__/aiChatPanelHeader.test.ts | replace | CHATV2-005 | Pins `#engineBanner` / `#sessionChip` / `#chatBrandMark`; superseded by v2 shell tests. |
| src/ui/__tests__/aiChatPanelMessages.test.ts | preserve | CHATV2-003 | Protocol tests extended for V2 frames; existing cases remain valid. |
| src/ui/__tests__/aiChatPanelCommands.test.ts | preserve | CHATV2-010 | Command parser/registry tests reused by the slash controller. |
| src/ui/__tests__/aiChatPanel.test.ts | temporary | CHATV2-001 → CHATV2-017 | Broad host regression net kept green during migration; delete at CHATV2-017 once v2 host tests cover the same paths. |
| src/ui/__tests__/aiChatPanelBundle.test.ts | temporary | CHATV2-017 | Bundle-shape guard; replaced by the CHATV2-017 bundle/deletion check. |
| test src/ai/omp/__tests__/ompChatEngine.test.ts | preserve | CHATV2-002 | Engine adapter contract unchanged; capability fixtures added. |
| test src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts | preserve | CHATV2-002 | Adapter contract unchanged; capability fixtures added. |
| test src/ai/codex/__tests__/codexChatEngine.test.ts | preserve | CHATV2-002 | Adapter contract unchanged; capability fixtures added. |

## 3. Legacy listeners / selectors — explicit final disposal

- Duplicate Enter ownership: `webview/aiChatPanelComposer.ts:521` (bubble `keydown`) and
  `webview/aiChatPanelMain.ts:816` (capture `keydown`) are **replace** — both removed by
  CHATV2-009 when the single capture-phase controller lands. Regression coverage for the
  duplicate path moves into the CHATV2-009 keyboard suite.
- `#chatBrandMark` (webview/aiChatPanelHeader.ts:108) — **delete** at CHATV2-017.
- `.UnicDB-chat` root rule (webview/styles.css:1104) — **temporary** until CHATV2-005 scopes
  `.UnicDB-ai-chat-v2`, then **delete** at CHATV2-017.
- Dead microphone placeholder (`micBtn`, DOM control) — **replace** by CHATV2-005; the spec
  (`docs/AI_CHAT_PROFESSIONAL_SPEC.md:315`) requires it be omitted, never shipped disabled.

## 4. Final deletion wave

**TASK-CHATV2-017** is the final deletion wave. It removes the compatibility bridge (the V1
`.UnicDB-chat` CSS tree, the V1 DOM ids/classes with no v2 consumer, and the legacy host
frames behind the adapter) after the host/webview V2 contract tests pass (`PLAN.md:88`). Every
row marked `temporary` above is deleted at CHATV2-017; nothing may survive it without a v2
consumer. This cutover map is consumed by TASK-CHATV2-002 through 017.
