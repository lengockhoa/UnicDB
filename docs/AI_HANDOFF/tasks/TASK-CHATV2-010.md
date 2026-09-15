# TASK-CHATV2-010 — Universal and capability-gated slash commands

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4

## Goal
Replace direct textarea mutation and partial command handling with an accessible shared popover and complete local command registry. Commands select/insert first and execute only after a later valid Enter.

## Target Files
- `src/ui/aiChatPanelCommands.ts` — descriptor registry, grammar and validated parse results.
- `webview/aiChat/autocomplete.ts` — shared anchored listbox renderer/controller adapter.
- `webview/aiChat/slash.ts` — eligibility, filtering, templates and execution mapping.
- `src/ui/aiChatPanel.ts` — all advertised engine/model command validation.
- `src/ui/__tests__/aiChatPanelCommands.test.ts` — registry/arguments/all engines.
- `webview/aiChat/__tests__/slash.test.ts` — UI/keyboard/eligibility tests.

## Required Work / Exact Spec
Universal descriptors: `/new`, `/clear`, `/help`, `/engine`, `/model`, `/context`, `/export`, `/resume`. Each descriptor has id, name, description, syntax, source universal/provider, capability gate, insertedTemplate and execution mode. Provider descriptors come only from capabilities and implemented host handlers; universal wins collision, provider row labels `<Engine>: <name>`.

Eligibility: `/` begins current logical line after optional spaces. Do not open in URL/path, prose, escaped slash or Markdown inline/fenced code. Clicking 32×32 slash button invokes the identical state and focuses textarea. Popover aligns to composer/button, width min 280/max 420, max eight 44px rows, 12px vertical padding; each row has slash/name 13px, description/syntax 11px and optional engine badge. Top selectable active.

Keyboard is delegated through 009: arrows one row; Page keys by visible row count; Enter/Tab accept; Escape closes. Focus stays textarea. Accept replaces active token range with exact template and caret after trailing space where present, closes menu, and sends zero intents. A subsequent plain Enter with no menu parses a complete command.

Execution: `/new` and `/clear` show confirmation when history/draft/turn exists; `/help` local card no model; `/engine [name]` opens picker without arg or validates all host-advertised engines; `/model [role]` analogous; `/context` opens inspector; `/export [markdown|json]` opens flow; `/resume` opens saved UnicDB sessions and never claims native provider resume unless capability true. Invalid args preserve draft and show inline syntax + one example. Unknown `/foo` shows explicit selectable `Send as message`; never silently discard/forward as command. Local commands do not add transcript user message unless their specified action does.

No command handler uses raw provider slash strings. Existing quoted/backslash parser behavior remains covered or is deliberately superseded with tests. Filter is local, case-insensitive, stable order; empty state says `No matching commands` and is not selectable.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | unit | eight universal descriptors | unique names, exact templates/syntax/actions |
| 2 | eligibility | line start vs URL/path/code | opens only eligible location |
| 3 | interaction | typed/button shared state | same popover and focus behavior |
| 4 | keyboard | selection | inserts only; sends zero; next Enter executes once |
| 5 | edge | invalid/unknown | draft retained; syntax or explicit Send as message |
| 6 | capability | provider commands | appear only when advertised; collision disambiguated |
| 7 | regression | `/engine codex/claude-code` | accepted when available, not legacy builtin/omp-only |
| 8 | security | hostile descriptor text | textContent only; cannot create markup/class |

## Test Files
- `src/ui/__tests__/aiChatPanelCommands.test.ts`
- `webview/aiChat/__tests__/slash.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatPanelCommands.test.ts webview/aiChat/__tests__/slash.test.ts webview/aiChat/__tests__/keyboard.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] SLASH-01 through SLASH-08 pass.
- [ ] All buttons/rows/arguments have exact visible and failure behavior.
- [ ] No selection path sends a turn.
- [ ] Provider-specific commands require verified host semantics.

## Dependencies
- TASK-CHATV2-003, TASK-CHATV2-009

## Interfaces
- Consumes: capability command descriptors, controller key routing, V2 command/session/export intents.
- Produces: `ChatCommandDescriptor[]`, `parseChatCommand()`, `getSlashToken()`, shared `AutocompleteView` for 011.

## Discussion
(no comments yet)

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: -
RED_OUTPUT: |
  Files were written incrementally, one file at a time (milestone commits on
  handoff/task-chatv2-010). Each module was RED before GREEN:
    - aiChatPanelCommands.test.ts → "TypeError: providerCommandsFromCapabilities
      is not a function" (24 of 25 failed; new exports absent).
    - slash.test.ts → "Failed to resolve import "../slash" ... Does the file exist?"
    - autocomplete.test.ts → "Failed to resolve import "../autocomplete" ..."
    - advertisedModelRoles block → "advertisedModelRoles is not a function".
  Real failures found and fixed by writing the implementation:
    - getSlashToken initially rejected an indented line-start token; fixed the
      line-start scan (test rewritten to assert the correct eligibility rule).
    - /engine + /model argument matching was case-sensitive; a user typing
      `Claude-Code` was rejected. Added `includesFolded` (case-insensitive
      membership, argument bytes preserved for the insertion template).
    - buildSlashRows truncated a >8 list at row 8, stranding provider rows;
      changed to a window that keeps the active row on screen.
    - The listbox silently sliced rows and dropped `aria-expanded` on close;
      both corrected (caller owns windowing, close collapses the attribute).
Verification Output: |
  $ npm test -- --run src/ui/__tests__/aiChatPanelCommands.test.ts webview/aiChat/__tests__/slash.test.ts webview/aiChat/__tests__/keyboard.test.ts
   ✓ webview/aiChat/__tests__/keyboard.test.ts  (23 tests) 7ms
   ✓ src/ui/__tests__/aiChatPanelCommands.test.ts  (29 tests) 5ms
   ✓ webview/aiChat/__tests__/slash.test.ts  (24 tests) 4ms
   Test Files  3 passed (3)
        Tests  76 passed (76)

  $ npm run typecheck
  > tsc --noEmit
  (no output — clean)

  $ npm run compile
  esbuild: build complete

  Additional (delivered file + consumers):
  $ npx vitest run webview/aiChat/__tests__/autocomplete.test.ts
   ✓ webview/aiChat/__tests__/autocomplete.test.ts  (10 tests) 36ms
  $ npx vitest run src/ui/__tests__/aiChatPanelCloneWebview.test.ts src/ai/__tests__/capabilities.test.ts webview/aiChat/__tests__/composer.test.ts webview/aiChat/__tests__/controller.test.ts src/ui/__tests__/aiChatPanelCloneHost.test.ts
   Test Files  5 passed (5) / Tests  92 passed (92)
  $ npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelEngine.test.ts
   Test Files  3 passed (3) / Tests  68 passed (68)
Status: PASS
Note: |
  The full-suite run shows 6 pre-existing environmental failures unrelated to
  this task: the worktree has no installed `node_modules` (`node_modules/.bin`
  is empty), so five webview bundle tests that spawn `node_modules/.bin/esbuild`
  and one vsce packaging test that spawns `node_modules/.bin/vsce` fail with
  ENOENT. They fail identically on the untouched base and are not affected by
  these modules. No version bump, package or publish touches were made. The
  appended `webview/aiChat/styles.css` block is a clean append under
  `.UnicDB-ai-chat-v2` selectors for the orchestrator merge.
  Scope decision: `/model <role>` validates against the roles the capability
  snapshot advertises (falling back to the closed `AiModelRole` set pre-ready),
  which is what the host's `buildModelsFrame`/`model_select` accept; the
  host-side "not configured" check stays on the chip path so the pinned
  `/model smart` behavior is unchanged.
