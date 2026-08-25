# TASK-006 -- Post-commit grid refresh after save

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` section 3.6

## Goal

After a successful saveEdits operation, automatically requery the server to refresh the grid with fresh data. This prevents stale row values (e.g. computed defaults like `now()` that changed on commit). The previous batched cursor is closed before the requery to avoid connection leaks.

## Target Files

- `webview/main.ts` (existing) -- after `saveResult.ok === true`, post `requery` message to host with current WHERE/ORDER BY; clear dirty state for saved rows before requery
- `src/ui/resultsPanel.ts` (existing) -- ensure `handleRequery` properly closes previous cursor before requery (already does, verify no regression)

## Test Cases (REQUIRED -- TDD)

| # | Loai | Ten test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | bundle | `saveResult.ok triggers requery post` | `postToHost` called with `{type:"requery", index, where, orderBy}` | saveResult.ok=true |
| 2 | bundle | `requery uses current WHERE from requery bar` | message.where matches input value | WHERE bar has value |
| 3 | bundle | `requery uses current ORDER BY from sort state` | message.orderBy matches sort state | Column sorted |
| 4 | unit | `dirty state cleared for saved rows after saveResult.ok` | editState.isCellDirty returns false for saved rows | Dirty cells saved |
| 5 | edge | `post-commit refresh when cursor is open` | Previous cursor closed before requery | Batched cursor active |
| 6 | edge | `saveResult with rowErrors does NOT trigger auto-requery` | No requery posted when partial failure | saveResult with rowErrors |

## Test Files

- `src/ui/__tests__/webviewPostCommit.test.ts` (new) -- tests for post-commit requery triggering

## Verification Commands

```bash
npm test src/ui/__tests__/webviewPostCommit.test.ts
npm test
npm run typecheck
```

## Acceptance Criteria

- [ ] Successful save (saveResult.ok=true) triggers automatic requery
- [ ] Requery uses current WHERE/ORDER BY state from the requery bar and sort
- [ ] Dirty state is cleared for saved rows before requery fires
- [ ] Previous batched cursor is closed before requery starts
- [ ] Partial failures (rowErrors present) do NOT trigger auto-requery
- [ ] Grid re-renders with fresh server data after requery completes
- [ ] `npm run typecheck` clean

## Dependencies

- (none)

## Interfaces

- Consumes: `SaveResultMessage` (existing), `requery` message type (existing), `handleRequery` in resultsPanel.ts (existing), `EditState.clearExceptRowIds()` (existing)
- Produces: Updated saveResult.ok handler in webview that posts requery

---

## Discussion

(chua co comment)
