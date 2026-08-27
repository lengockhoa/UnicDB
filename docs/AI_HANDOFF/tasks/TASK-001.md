# TASK-001 — Define Console webview protocol and save filename helper

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1

## Goal

Create the pure Console host/webview message contract and deterministic SQL save-name helper. This gives the webview and host a small, validated interface without importing VS Code APIs.

## Target Files

- `src/ui/consolePanelMessages.ts` (new) — define Console-to-host message types, a runtime message guard, and `suggestSaveFileName(date: Date): string`.
- `src/ui/__tests__/consolePanelMessages.test.ts` (new) — TDD unit coverage for the protocol guard and filename helper.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | validates run message | `isConsoleToHostMessage({ type: "runConsole", sql: "SELECT 1" })` is `true` and narrows to the declared run-message shape. | Valid run payload. |
| 2 | happy | formats deterministic SQL filename | `suggestSaveFileName(new Date(2026, 0, 2, 3, 4, 5))` returns `console_20260102_030405.sql`. | Fixed local Date. |
| 3 | edge-malformed | rejects untrusted webview payloads | `null`, `{ type: "runConsole" }`, `{ type: "runConsole", sql: 1 }`, and `{ type: "unknown", sql: "SELECT 1" }` all return `false`. | Invalid postMessage values. |
| 4 | edge-boundary | zero-pads month/day/time fields | A single-digit month, day, hour, minute, and second produce two-digit fields in `console_20260102_030405.sql`. | Fixed Date at 2026-01-02 03:04:05. |

## Test Files

- `src/ui/__tests__/consolePanelMessages.test.ts` (new) — contains all protocol and filename-helper cases above.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consolePanelMessages.test.ts
npm run typecheck
```

`package.json` defines no lint script; `npm run typecheck` is this task's required static gate.

## Acceptance Criteria

- [ ] `ConsoleToHostMessage` permits only `{ type: "runConsole"; sql: string }` and `{ type: "saveConsoleAsSql"; sql: string }`.
- [ ] The runtime guard rejects malformed or unknown postMessage data before host routing.
- [ ] `suggestSaveFileName` returns a zero-padded `.sql` filename for a supplied Date.
- [ ] The targeted Vitest test and `npm run typecheck` pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: (none)
- Produces: `export type ConsoleToHostMessage = { type: "runConsole"; sql: string } | { type: "saveConsoleAsSql"; sql: string }`; `export function isConsoleToHostMessage(value: unknown): value is ConsoleToHostMessage`; `export function suggestSaveFileName(date: Date): string`.

---

## Discussion

### 2026-08-27 · planner · bao-opus
The Date argument is deliberately required rather than defaulted: the save host supplies `new Date()` and tests remain deterministic. The protocol has no persistence, ready, copy, or busy messages because those are outside the resolved Console scope.

---
