# TASK-004 — Privacy regression lock: auto-context is DDL-only (HARD invariant)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1 invariant, §2.4, §3, §4, §7

## Goal

Permanently lock the user-locked HARD invariant: the chat NEVER automatically pulls database row/data
content and pushes it to the AI. Auto-context is schema structure (DDL) only; only user-typed prompts and
explicit attachments go to the model. `buildMessages` (src/ui/aiChatPanel.ts:186-325) is the single
context funnel for BOTH engines (`runBuiltinTurn` and `runAcpTurn`) — locking it locks both. The tests
here are a standing regression net for every future chat change.

## Target Files

- (none — test-only task; src files must remain untouched by this task)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | DDL-only auto-context | Spy adapter (listSchemas/listTables/listViews/listColumns return real schema metadata; `runQuery` throws "row access forbidden in context build" if called) → returned messages: exactly one system message whose content includes "CREATE TABLE" DDL text and the export_structure hint; user+history pass through unchanged | AdapterFactory stub per `AdapterFactory` from src/ai/tools/types |
| 2 | regression (invariant) | sentinel rows never leak | Spy `runQuery` resolves rows containing sentinel `XSECRETROWDATA42X`; assert sentinel appears in NO message of `buildMessages` output AND `runQuery` call count === 0 | seeded spy adapter |
| 3 | edge (error path) | introspection failure → empty context, no crash | factory rejects / `listSchemas` rejects / `listTables` rejects per-schema → context empty; system prompt is the minimal no-DDL variant; no throw (existing behavior, now pinned) | rejecting stubs |
| 4 | edge (boundary) | DDL budget cut keeps first block + footer | `contextBudgetChars: 200` with multi-block DDL → output context ≤ budget boundary behavior: cut at blank-line block boundary, first block kept even if oversize, `(+N more objects omitted` footer appended | small budget via opts (injectable, no 12k fixtures) |
| 5 | edge (mutation) | history passthrough by value | Supplied history array and entries unmodified after call (deep-equal before/after; not the same mutated array) | history fixture |
| 6 | edge (malformed) | empty schema/table names tolerated | schema/table with empty names → DDL still renders non-empty context, no throw | crafted metadata |

## Test Files

- `src/ui/__tests__/aiChatPanelPrivacy.test.ts` — (new) pure vitest unit tests over `buildMessages` with
  spy adapters (no DOM, no vscode mock needed — factory is injected).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelPrivacy.test.ts
npx vitest run src/ui/__tests__/aiChatPanel.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate.
(Test selection: `.cache/index/tests-map.json` `sourceFile: src/ui/aiChatPanel.ts` → chat suites;
narrowed to the privacy suite + `aiChatPanel.test.ts` which already covers `buildMessages` budget/cache
behavior so the lock composes with existing coverage. Full `npm test` at wave boundary is the net.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; sentinel (#2) and DDL-only (#1) assertions are in place and FAIL
      if anyone adds row sampling to the context path (verify by temporarily making runQuery feed the
      context in a scratch patch — revert; note observation in Executor Report).
- [ ] `npm run typecheck` exits 0; `src/ui/aiChatPanel.ts` byte-identical after the task (test-only).
- [ ] No test asserts on mocked `buildMessages` internals — all assertions go through the real function.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — test-only; independent of TASK-001/002/003.

## Interfaces

- Consumes: real `buildMessages(factory, history, userMsg, opts?)` signature from
  `src/ui/aiChatPanel.ts` (opts: `contextBudgetChars`, `contextTableLimit`, `cache`);
  `AdapterFactory` from `src/ai/tools/types`; `DbAdapter` methods `listSchemas/listTables/listViews/
  listColumns/runQuery` from `src/adapters/types`.
- Produces: the standing privacy suite `src/ui/__tests__/aiChatPanelPrivacy.test.ts` — future chat
  changes must keep it green (PLAN §7 invariant enforcement point).

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
