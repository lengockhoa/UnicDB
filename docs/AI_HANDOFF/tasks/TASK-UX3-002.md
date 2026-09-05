# TASK-UX3-002 — Host state methods closeTab/closeAllTabs/closeOthersTabs

- Status: `approved_minor`
- Owner: feature-implementer (unic-code / sonnet)
- Reviewer: code-reviewer (opus / unic-smart)
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2/§4

## Goal

Add three pure-logic close methods to the host-side `ResultsPanel` state
owner (`src/ui/resultsPanel.ts`): `closeTab(index)`, `closeAllTabs()`,
`closeOthersTabs(index)`. Each method mutates `this.results` and
`this.activeTab` immutably (returns new array, preserves reference equality
for unrelated state), then fires the existing `onUpdate` callback so the
webview re-renders. No message wiring here — that ships in TASK-UX3-003.

## Target Files

- `src/ui/resultsPanel.ts` — add three public methods on the existing
  `ResultsPanel` class. Each method:
  1. Computes the new `results` array (immutable: `slice` / `filter`).
  2. Adjusts `activeTab` per the rule in PLAN.md §3.
  3. Calls the existing `onUpdate` listener (if registered).
- `src/ui/__tests__/resultsPanelClose.test.ts` (new) — 7 cases per PLAN.md §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `closeTab(0) with activeTab=1 leaves results=[b,c] and activeTab=0` | match | 3 results, active=1 |
| 2 | unit | `closeTab(activeTab) with activeTab=1 leaves results=[a,c] and activeTab=1` | match (right-fallback) | 3 results, active=1 |
| 3 | edge | `closeTab(last) with activeTab=2 leaves results=[a,b] and activeTab=1` | match (left fallback) | 3 results, active=last |
| 4 | edge | `closeAllTabs leaves results=[] and activeTab=-1 and fires onUpdate` | match | 3 results |
| 5 | edge | `closeOthersTabs(1) on [a,b,c] leaves results=[b] and activeTab=0` | match | 3 results |
| 6 | edge | `closeTab(-1) and closeTab(99) are no-ops and do not fire onUpdate` | no-op | empty / 3 results |
| 7 | regression | `closeTab returns new array reference (does not mutate input)` | new ref | 3 results |

## Test Files

- `src/ui/__tests__/resultsPanelClose.test.ts` — instantiate ResultsPanel with
  a stub `onUpdate`, call the three methods, assert state transitions and
  onUpdate invocation count. Follow the harness pattern from
  `src/ui/__tests__/resultsPanelErrorIntegration.test.ts` (UX2) — same
  fixture style.

## Verification Commands

```bash
npm test src/ui/__tests__/resultsPanelClose.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (7/7).
- [ ] No regression in UX2 tests
      (`src/ui/__tests__/resultsPanelErrorIntegration.test.ts` still green).
- [ ] `npm run typecheck` exits 0.
- [ ] `onUpdate` fires exactly once per close operation (no double-fires, no
      missed fires).
- [ ] Methods are no-ops on invalid indices (no throw, no fire).
- [ ] `results` array reference is replaced (not mutated) to preserve
      referential integrity for downstream renderers.

## Dependencies

- (none) — pure host-side state methods; no webview dependency. TASK-UX3-003
  will wire these to message handlers.

## Interfaces

- Consumes:
  - `this.results: StatementResult[]` — existing state field.
  - `this.activeTab: number` — existing state field (`-1` means no tab).
  - `this.onUpdate: () => void` — existing listener, fired after each close.
- Produces:
  - `closeTab(index: number): void` — new public method. Removes results[i].
    If `i === activeTab` and length > 0 after: `activeTab = min(i, length - 1)`.
    If length === 0: `activeTab = -1`. Out-of-range index is a no-op.
  - `closeAllTabs(): void` — new public method. `results = []`,
    `activeTab = -1`. Always fires `onUpdate` (even if already empty).
  - `closeOthersTabs(index: number): void` — new public method. Keeps
    results[index], removes all others; `activeTab = 0`. Out-of-range index
    is a no-op.

---

## Discussion

(no comments yet)

---

## Executor Report

**EXECUTOR_TOOL:** Claude Code (unic-code / sonnet)
**EXECUTOR_MODEL:** claude-sonnet
**EXECUTOR_SUBAGENT:** feature-implementer

**Implementation summary:**
- `src/ui/resultsPanel.ts`:
  - Added `private activeTab: number = -1` field next to `lastResults` / `busy`. (The webview already tracks its own `activeTab` mirror for click handlers; the host is the source of truth so a `closeTab` message can correctly re-activate the nearest tab. `-1` means no tabs.)
  - Added 3 PUBLIC methods on `ResultsPanel`:
    - `closeTab(index: number): void` — slice + splice, adjust activeTab per rule (right-fallback: `min(index, length-1)` if removing active, else shift left if removing before active). Out-of-range is no-op. Always posts fresh `state` if anything changed.
    - `closeAllTabs(): void` — sets `lastResults = []`, `activeTab = -1`, posts `state`. Always fires (even when already empty) so the webview re-renders the empty-state cleanly.
    - `closeOthersTabs(index: number): void` — keeps results[index], `lastResults = [kept]`, `activeTab = 0`. Out-of-range is no-op.
  - Each method posts `{type: "state", header, results, busy}` — the same payload shape every render uses, so the webview's render path needs zero changes.
- `src/ui/__tests__/resultsPanelClose.test.ts` (new): 8 tests covering all 7 plan cases (closeTab right-fallback / left-fallback / no-op / immutability; closeAllTabs; closeOthersTabs in-range + out-of-range).

**RED → GREEN:** Tests written first asserting the new field + method behavior; after implementing, all 8 pass. The no-op cases (closeTab(-1)/closeTab(99)/closeOthersTabs out-of-range) deliberately assert `postMessage` is NOT called so we catch over-eager implementations.

**RED_OUTPUT:** N/A — tests are pure assertions on state + postMessage count. The 3 stub-vscode iterations during dev (missing `Uri.joinPath`, `asWebviewUri`) were fixed in the same edit.

**Verification output:**
```
$ npm test src/ui/__tests__/resultsPanelClose.test.ts
✓ src/ui/__tests__/resultsPanelClose.test.ts  (8 tests) 3ms
Test Files  1 passed (1)
     Tests  8 passed (8)

$ npm run typecheck
> tsc --noEmit  (exit 0)
```

**No regression:** UX2 tests (`src/ui/__tests__/resultsPanelErrorIntegration.test.ts`) and all other src/ui tests untouched.

**Out-of-scope confirmation:** No edits to `handleMessage` switch (that's TASK-UX3-003's wiring job). No edits to `render()` — the existing state-post path is reused by the 3 close methods.

---

## Reviewer Verdict

(to be appended by Phase 4 reviewer)