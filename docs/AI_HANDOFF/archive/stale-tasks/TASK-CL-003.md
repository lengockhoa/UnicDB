# TASK-CL-003 — Console draft snapshot: cap the `name` field (ARP-08 minor)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 TASK-CL-003

## Goal

Close the ARP-08 R2 minor: the draft snapshot codec caps tabs (`CONSOLE_DRAFTS_MAX_TABS`
= 20) and buffer (`CONSOLE_DRAFTS_MAX_BUFFER_CHARS` = 64 000) but the tab `name` field is
uncapped — `parseConsoleDraftSnapshot` (consolePanelMessages.ts:253) accepts any string
length, and the host writer `buildDraftSnapshot` (consolePanel.ts:382-389) does not slice
it. Add a fail-closed name cap to the codec and the matching writer clamp.

## Target Files

- `src/ui/consolePanelMessages.ts` — new exported `CONSOLE_DRAFTS_MAX_NAME_CHARS = 200`; `parseConsoleDraftSnapshot` rejects any tab with `name.length > CONSOLE_DRAFTS_MAX_NAME_CHARS` (alongside the existing buffer check at :255); docstring updated to list the name cap.
- `src/ui/consolePanel.ts` — `buildDraftSnapshot` (:382-389) slices `t.name.slice(0, CONSOLE_DRAFTS_MAX_NAME_CHARS)` next to the existing buffer slice, preserving the "our own writer never emits a snapshot our own parse rejects" invariant.
- `src/ui/__tests__/consolePanelMessages.test.ts` — codec cap pins.
- `src/ui/__tests__/consolePanel.test.ts` — writer clamp pin.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | name exactly at cap round-trips | `parseConsoleDraftSnapshot(encodeConsoleDraftSnapshot(snapshot))` with a 200-char name → deep-equal rebuilt snapshot (`name.length === 200`) | valid snapshot, one tab |
| 2 | happy | short name unaffected | existing parse/encode tests stay green verbatim (name `"Query 1"`) | existing fixtures |
| 3 | edge (boundary over) | name 201 chars → reject | `parseConsoleDraftSnapshot` returns `null` (fail-closed) | hand-built JSON with a 201-char name; RED at `611df12` (currently parses) |
| 4 | edge (writer clamp) | host tab named 500 chars | `buildDraftSnapshot()` emits `name.length === 200`; the encoded snapshot re-parses to non-null | ConsolePanel with a renamed 500-char tab, draftMemento stub |
| 5 | edge (valid-min) | empty name `""` still valid | parse accepts (cap is an upper bound only; matches `renameTab`'s empty-name no-op at consolePanel.ts:310-314) | snapshot with `name: ""` |
| 6 | edge (corrupt carrier) | non-string name still rejected | existing `typeof tab.name !== "string"` reject path unchanged — new check composes after it, not instead of it | snapshot with `name: 42` |

## Test Files

- `src/ui/__tests__/consolePanelMessages.test.ts` — tests #1, #3, #5, #6
- `src/ui/__tests__/consolePanel.test.ts` — test #4

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consolePanelMessages.test.ts src/ui/__tests__/consolePanel.test.ts
npm run typecheck
```

(No `lint` script exists — `npm run typecheck` is the static gate.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; test #3 confirmed RED at `611df12` before the fix (paste RED output).
- [ ] `CONSOLE_DRAFTS_MAX_NAME_CHARS` exported from consolePanelMessages.ts; codec rejects > cap; host writer clamps to cap.
- [ ] `encodeConsoleDraftSnapshot` stays verbatim JSON.stringify (clamping stays the host's job, per the existing :205-210 contract comment).
- [ ] Existing ARP-08 pins (tabs cap, buffer cap, version reject, active-tab integrity, forward-compat strip) all green unchanged.
- [ ] `npm run typecheck` exits 0.
- [ ] No file outside §Target Files modified; no webview bundle change (`consolePanelMain.ts` untouched).

## Dependencies

- (none)

## Interfaces

- Consumes: `parseConsoleDraftSnapshot(raw: string): ConsoleDraftSnapshot | null` and `encodeConsoleDraftSnapshot(snapshot: ConsoleDraftSnapshot): string` (consolePanelMessages.ts:208/:227, existing); `CONSOLE_DRAFTS_MAX_TABS` / `CONSOLE_DRAFTS_MAX_BUFFER_CHARS` (existing constants, untouched); `ConsolePanel.buildDraftSnapshot()` (consolePanel.ts:382, existing private method).
- Produces: `CONSOLE_DRAFTS_MAX_NAME_CHARS: 200` (new exported constant from consolePanelMessages.ts). Contract change: snapshots with any tab name longer than 200 chars now fail parse (fail-closed); previously they parsed. `ConsoleDraftSnapshot` type shape unchanged.

---

## Discussion

### 2026-09-02 · planner · unic-smart
Cap value 200 chosen to sit far above any real tab name (default `"Query 1"`, rename via the tab UI) while making a corrupt multi-MB memento impossible; it mirrors the existing fail-closed style exactly — parse REJECTS (like buffer/tabs), writer CLAMPS (like `buffer.slice`). Version stays 1: older persisted snapshots with names ≤ 200 are unaffected, and a > 200-name snapshot can only come from a corrupt/hostile memento, which the codec's fail-closed contract already treats as reject-not-migrate.

## Executor Report

EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-sonnet-4-6
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
FAIL  src/ui/__tests__/consolePanel.test.ts > ConsolePanel — draft recovery (ARP-08) > #14 edge/writer-clamp: a 500-char tab name persists sliced to CONSOLE_DRAFTS_MAX_NAME_CHARS
AssertionError: expected 'Query 1' to have a length of undefined but got 7
 ❯ src/ui/__tests__/consolePanel.test.ts:868:32

FAIL  src/ui/__tests__/consolePanelMessages.test.ts > CONSOLE_DRAFTS_* constants (ARP-08) > exports the persisted-draft storage key, schema version, and caps
AssertionError: expected undefined to be 200
 ❯ src/ui/__tests__/consolePanelMessages.test.ts:233:43

FAIL  src/ui/__tests__/consolePanelMessages.test.ts > parseConsoleDraftSnapshot — tab name cap (TASK-CL-003) > #1 name exactly at cap round-trips through encode→parse losslessly
AssertionError: expected '' to have a length of undefined but got +0
 ❯ src/ui/__tests__/consolePanelMessages.test.ts:439:35

FAIL  src/ui/__tests__/consolePanelMessages.test.ts > parseConsoleDraftSnapshot — tab name cap (TASK-CL-003) > #3 name 201 chars (cap + 1) → parse rejects (fail-closed)
AssertionError: expected { Object (version, tabs, ...) } to be null
 ❯ src/ui/__tests__/consolePanelMessages.test.ts:464:44

Test Files  2 failed (2)
     Tests  4 failed | 57 passed (61)
```

Verification Output:
```
RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-cl-003

 ✓ src/ui/__tests__/consolePanelMessages.test.ts  (31 tests) 5ms
 ✓ src/ui/__tests__/consolePanel.test.ts  (30 tests) 19ms

 Test Files  2 passed (2)
      Tests  61 passed (61)
   Start at  22:14:03
   Duration  286ms

> UnicDB@1.47.0 typecheck
> tsc --noEmit
(exit 0, no output)
```

Status: PASS
Note: One small test-design adaptation for test #14 — the writer-clamp test mutates host state via the public `panel.renameTab(tabId, longName)` method instead of going through the message handler, because the existing `isConsoleToHostMessage` guard does not list `renameTab` (pre-existing latent gap, not in the task's scope to fix). The clamp itself is exercised by the same `buildDraftSnapshot` path triggered by an `updateBuffer` write.

## Reviewer Verdict

VERDICT: approved
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: claude-sonnet-4-6
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Verified pre-existing isConsoleToHostMessage guard gap — union lists renameTab (consolePanelMessages.ts:40) but switch has no case, hits default:false; guard body untouched by this diff, correctly out of scope. Test #14 exercises the clamp through the real updateBuffer→debounced persistDrafts→buildDraftSnapshot path (renameTab alone schedules no persist), so the writer clamp is genuinely covered.
