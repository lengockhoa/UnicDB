# TASK-AGTUI-007 — Webview integration: compose header + thread + composer into `aiChatPanelMain.ts`

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3

## Goal

Rewire `webview/aiChatPanelMain.ts` to build its DOM from the three wave-1 modules (header, composer, thread) and wire the new protocol (`models` frame → chip; chip click → `model_select`; bypass toggle → `bypass_permissions`), replacing the old monolithic `renderInitial()` while preserving every element id, behavior, and message handler the existing suite pins.

## Target Files

- `webview/aiChatPanelMain.ts` — new `renderInitial()` composing `renderHeader` + thread container + `renderComposer`; delete the now-duplicated inline builders/`renderMarkdown` (moved in TASK-AGTUI-005) and the old inline header/banner/blocks; add `models`/`model_select`/`bypass_permissions` inline type mirrors + handlers; keep mention/slash dropdowns, attach flow, jump-latest, usage chip, busy state machine.
- `src/ui/__tests__/aiChatPanelCloneWebview.test.ts` (new) — esbuild+jsdom harness test (copy harness setup from `aiChatPanelWebview.test.ts`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | clone DOM mounts with legacy ids | dispatch `init{hasHistory:false,visionCapable:true}` → document contains `.UnicDB-chat-header` (brand "U"), `#thread`, `#prompt`, `#sendBtn`, `#stopBtn`, `#attachBtn`, `#resumeBtn`, `#clearBtn`, `#regenerateBtn`, `#sessionChip`, `#modelChipBtn`, `#bypassToggle`, `#micBtn`, `#engineBanner`, `#usageChip` slot, `#jumpLatest` — MUST pin `#resumeBtn`/`#clearBtn`/`#regenerateBtn`/`#sessionChip` in the DOM and assert the existing pinned assertions pass (busy-disable set per `aiChatPanelWebview.test.ts:788-801`; sessionChip classes/labels per `aiChatPanelSessionStateWebview.test.ts:85-118`) | bundle eval in jsdom |
| 2 | happy | models frame drives chip + select | host posts `{type:"models",active:"smart",roles:[work,smart]}` → chip shows `smart`; click chip row `work` → exactly one `{type:"model_select",role:"work"}` posted; no `send` posted | 2-role fixture |
| 3 | edge (empty) | empty roles → inert chip | `models` with `roles:[]` → chip disabled (`No models configured`), clicking posts nothing; panel still fully usable for send | empty fixture |
| 4 | edge (state repeat) | bypass toggle alternation | two clicks on `#bypassToggle` → posts exactly `[bypass_permissions{enabled:true}, bypass_permissions{enabled:false}]` in order; aria-checked alternates | double click |
| 5 | edge (parity) | legacy flows unchanged | whitespace-only send posts nothing; Enter on non-empty text posts `{type:"send",text}`; `stop` while busy posts `{type:"stop"}`; `engine` frame with unknown name → `#engineBanner` falls back to label `builtin`, class `UnicDB-chat-engine-builtin`; static title node stays `UnicDB AI` — all existing `aiChatPanelWebview*.test.ts` assertions hold unmodified | existing suite as oracle |
| 6 | edge (security) | XSS invariants survive refactor | hostile tool labels/summaries/mentions render as text (re-run the aiChatPanelWebview.test.ts security cases against the new DOM) | hostile fixtures |
| 7 | regression | full existing chat webview suite | `aiChatPanelWebview.test.ts`, `aiChatPanelWebviewTask002/005.test.ts`, `aiChatPanelDbAwareWebview.test.ts`, `aiChatPanelPlanWebview.test.ts`, `aiChatPanelSessionStateWebview.test.ts`, `aiChatPanelThoughtRegen.test.ts`, `aiChatPanelResume.test.ts`, `aiChatPanelPolicy.test.ts` pass UNMODIFIED | full suite |

## Test Files

- `src/ui/__tests__/aiChatPanelCloneWebview.test.ts` (new)

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelCloneWebview.test.ts
npx vitest run \
  src/ui/__tests__/aiChatPanelWebview.test.ts \
  src/ui/__tests__/aiChatPanelWebviewTask002.test.ts \
  src/ui/__tests__/aiChatPanelWebviewTask005.test.ts \
  src/ui/__tests__/aiChatPanelDbAwareWebview.test.ts \
  src/ui/__tests__/aiChatPanelPlanWebview.test.ts \
  src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts \
  src/ui/__tests__/aiChatPanelThoughtRegen.test.ts \
  src/ui/__tests__/aiChatPanelResume.test.ts \
  src/ui/__tests__/aiChatPanelPolicy.test.ts \
  src/ui/__tests__/aiChatPanelBundle.test.ts \
  src/ui/__tests__/aiChatPanelAttachments.test.ts \
  src/ui/__tests__/aiChatPanelEngine.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] All §Test Cases pass; NO existing test file modified (if one must change, that is a needs_breakdown signal — record it in Discussion instead).
- [ ] `#engineBanner` lives inside the header per PLAN §3; old banner insertion code removed.
- [ ] All new-module imports compile under the esbuild bundle (`npm run compile` succeeds).

## Dependencies

- TASK-AGTUI-001, TASK-AGTUI-002, TASK-AGTUI-003, TASK-AGTUI-004, TASK-AGTUI-005 (all wave-1 modules)

## Interfaces

- Consumes: `renderHeader` + `UnicDBHeader` (TASK-AGTUI-003), `renderComposer` + `UnicDBComposer` + `ComposerCallbacks` (TASK-AGTUI-004), thread builders + `renderMarkdown` (TASK-AGTUI-005), CSS classes/tokens (TASK-AGTUI-001), frame types mirrored inline from TASK-AGTUI-002.
- Produces: webview posts `{type:"model_select", role}` and `{type:"bypass_permissions", enabled}`; handles host `models` frame — consumed by TASK-AGTUI-006 (host) and TASK-AGTUI-008 (polish).

### 2026-09-08 · planner · unic-smart
The existing suite is the contract: if a pinned assertion conflicts with the clone layout (e.g. an element must move), adapt the DOM around the assertion, never the test.

## Executor Report

(appended below by executor)

---

## Reviewer Verdict

(appended below by reviewer)
