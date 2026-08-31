# TASK-AIX05-004 — tool permission parity + scaffold + docs

Cycle: AIX-05 · Wave 4 · Priority: P1
Status: pending
Depends on: AIX05-003
Reviewer: unic-smart (cycle reviewer)

## Spec

Pin builtin ↔ OMP/MCP tool permission parity and close the cycle docs:

1. **Registry parity** (`src/ui/aiChatPanel.ts`): the OMP/MCP path and the
   builtin path must register the SAME gate-wrapped tool set — DB-aware
   tools + `createAnalysisTools` (AIX-03) + `createChangePlanTools`
   (AIX-04) + grounding/workspace tools. Add a parity test
   (`src/ui/__tests__/aiChatPanelToolParity.test.ts`) that drives both
   registry builders with a fake adapter and asserts the registered tool
   name sets are EQUAL (plan_change must appear on both).
2. `src/__tests__/aix05Scaffold.test.ts`:
   - ompChatEngine/acp/acpProcess/hostMcp/engineChoice/detect: no
     `shell:true`, no `execSync` (acpProcess spawns via injected spawn —
     check the actual spawn call shape); ompChatEngine byte-scan for
     apiKey/secret in wire-frame literals (privacy invariant);
   - `OmpChatEngine` interface includes `cancel`;
   - `session_state` wire kind exists in aiChatPanelMessages;
   - exports present (createOmpChatEngine, detectOmp, resolveEngine,
     MIN_OMP_VERSION).
3. CHANGELOG 1.25.0 section + compare link (re-verify the whole link
   block after editing); README bullet after the 1.24.0 line.

## Acceptance

- [ ] Parity test green: builtin and OMP/MCP registries expose identical
      gate-wrapped tool names (incl. plan_change).
- [ ] Scaffold green (6+ assertions).
- [ ] CHANGELOG link block intact (all prior links present after edit).
- [ ] Full suite `npm test` green; `npm run typecheck` 0; `npm run
      compile` clean.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
