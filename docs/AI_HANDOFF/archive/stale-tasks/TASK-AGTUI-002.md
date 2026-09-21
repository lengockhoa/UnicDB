# TASK-AGTUI-002 — Wire protocol: `models` frame + `model_select` / `bypass_permissions`

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3

## Goal

Extend the chat panel message protocol additively: host→webview `models` frame (active role + configured roles), webview→host `model_select` and `bypass_permissions` messages. Types + union membership + doc comments only; no handler changes (TASK-AGTUI-006/007 consume).

## Target Files

- `src/ui/aiChatPanelMessages.ts` — add three interfaces + union members; import `type { AiModelRole } from "../ai/settings"` (host-side only; the webview keeps its own inline copies — see Interfaces).
- `src/ui/__tests__/aiChatPanelMessagesClone.test.ts` (new) — shape/union tests (assignability + exhaustive-union mirrors, pattern of existing `aiChatPanelMessages.test.ts`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | new frames are union members | `const m: AiChatPanelHostMessage = {type:"models", active:"work", roles:[{role:"work",modelId:"m",vision:true}]}` and `const w: AiChatPanelWebviewMessage = {type:"model_select", role:"smart"}` / `{type:"bypass_permissions", enabled:false}` all compile (type-level assertions) | current unions lack them (RED: TS error) |
| 2 | edge (empty) | empty roles array valid | `{type:"models", active:"work", roles:[]}` compiles — empty list is the "nothing configured" signal, not a schema violation | type assertion |
| 3 | edge (malformed value) | invalid role literal rejected | `{type:"model_select", role:"turbo"}` fails to compile (role typed `AiModelRole`, not string) | `// @ts-expect-error` assertion |
| 4 | edge (omitted optional) | deny response still omits optionId | existing `permission_response` doc contract unchanged; regression: `aiChatPanelMessages.test.ts` passes unmodified | existing suite |

## Test Files

- `src/ui/__tests__/aiChatPanelMessagesClone.test.ts` (new)

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelMessagesClone.test.ts
npx vitest run src/ui/__tests__/aiChatPanelMessages.test.ts   # regression, unmodified
npm run typecheck
```

## Acceptance Criteria

- [ ] Interfaces + unions added; zero changes to existing interfaces (diff is purely additive).
- [ ] `npm run typecheck` green; existing messages tests pass.

## Dependencies

- none

## Interfaces

- Consumes: `AiModelRole` = `"work" | "smart" | "autocomplete" | "lite"` from `src/ai/settings.ts:13`.
- Produces (exact signatures):
  - `interface AiChatPanelModels { type: "models"; active: AiModelRole; roles: Array<{ role: AiModelRole; modelId: string; vision: boolean }> }` — added to `AiChatPanelHostMessage` union.
  - `interface AiChatPanelModelSelect { type: "model_select"; role: AiModelRole }` and `interface AiChatPanelBypassPermissions { type: "bypass_permissions"; enabled: boolean }` — added to `AiChatPanelWebviewMessage` union.
  - Webview mirror: `aiChatPanelMain.ts` duplicates these shapes inline (webview bundles standalone; cannot import host modules) — TASK-AGTUI-007 copies these exact literals.

### 2026-09-08 · planner · unic-smart
Kept `model_select` as a dedicated message rather than reusing `AiChatPanelCommand("model")` so the chip path stays typed and does not inherit the slash-command echo behavior.

## Executor Report

```
EXECUTOR_TOOL: Claude Code (Agent tool)
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: Direct tsc on src/ui/__tests__/aiChatPanelMessagesClone.test.ts before implementation:
  error TS2724: '"../aiChatPanelMessages"' has no exported member named 'AiChatPanelModels'
  error TS2724: '"../aiChatPanelMessages"' has no exported member named 'AiChatPanelModelSelect'
  error TS2305: Module '"../aiChatPanelMessages"' has no exported member 'AiChatPanelBypassPermissions'
  error TS2367: This comparison appears to be unintentional because the types ... and '"models"' have no overlap.
  error TS2367: ... and '"model_select"' have no overlap.
  error TS2367: ... and '"bypass_permissions"' have no overlap.
  error TS2339: Property 'enabled' does not exist on type 'never'.
  (12+ type-level errors confirming the new types and union members were absent)
Verification Output:
  > UnicDB@1.53.24 typecheck
  > tsc --noEmit
  (clean exit — no errors)

  RUN  v1.6.1 .../task-agtui-002
   ✓ src/ui/__tests__/aiChatPanelMessagesClone.test.ts  (8 tests) 2ms
   ✓ src/ui/__tests__/aiChatPanelMessages.test.ts  (20 tests) 3ms
   Test Files  2 passed (2)
        Tests  28 passed (28)
Status: PASS
Note: Webview mirror of these literal shapes is intentionally NOT mirrored
      here (aiChatPanelMain.ts will copy the literals inline per task spec
      "Interfaces" note; webview bundles standalone and cannot import host
      modules). Import of AiModelRole is type-only (re-exported) so the host
      module graph stays free of runtime coupling. 20/20 regression preserved.
```

---

## Reviewer Verdict

(appended below by reviewer)

## Reviewer Report

REVIEWER_MODEL: unic-smart
Verdict: APPROVED
Findings: none blocking; scope walked 1-5, all clean.

- Completeness — all three spec shapes present and unioned exactly per §Interfaces: `AiChatPanelModels` (src/ui/aiChatPanelMessages.ts:231, host union :283), `AiChatPanelModelSelect` (:420), `AiChatPanelBypassPermissions` (:431, webview union :447-448). Diff is purely additive; every pre-existing export preserved; existing `aiChatPanelMessages.test.ts` byte-identical (empty diff 515d87e..87ec6e2).
- Wire contract — no type-literal collision with any existing member of either union; file-header "type discriminator, unknown ignored" pattern (aiChatPanelMessages.ts:2-4) keeps new frames round-trip safe with the legacy host/webview (unknown types are dropped, not mishandled). Whole-repo `tsc --noEmit` green proves no exhaustive switch elsewhere in src/ broke from the widened unions.
- Backward compat — PLAN §3 additive-only contract (PLAN.md:106 "existing message shapes and element ids unchanged") satisfied: no element ids live in this file and no pinned shape was altered; `AiModelRole` re-export matches src/ai/settings.ts:13 exactly ("work" | "smart" | "autocomplete" | "lite").
- Test quality — 8 tests with real `expect` assertions pinning union membership, empty-roles edge, frozen key sets (`Object.keys` equality), direction exclusivity, and roles[] entry shape. The `@ts-expect-error` tripwires (aiChatPanelMessagesClone.test.ts:111, 115) are proven live: my clean `tsc --noEmit` confirms they suppress real errors (unused directives would fail typecheck), so a regression to `role: string` re-trips RED. Fixtures are self-contained constants, independent of unrelated refactors.
- TDD — RED_OUTPUT carries concrete TS diagnostics (TS2724 x2, TS2305, TS2367 x3, TS2339), consistent with PLAN.md:115's pre-declared type-level RED for this task. Genuine, not a bare claim.

VERIFICATION_RERUN (independent, this review turn):
  npm run typecheck -> exit 0, no errors
  npx vitest run aiChatPanelMessagesClone.test.ts + aiChatPanelMessages.test.ts -> 28/28 pass (8 new + 20 regression, unmodified)

Cosmetic (non-blocking, no action): one extra blank line added at src/ui/aiChatPanelMessages.ts:236 — mirrors the file's pre-existing double-blank precedent at :136-137; no lint script exists in package.json.
