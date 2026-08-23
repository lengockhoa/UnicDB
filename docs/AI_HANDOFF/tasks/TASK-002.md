# TASK-002 — ACP process lifecycle + extension wiring

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal
Replace Cycle L’s RPC process with an ACP process wrapper and extension bootstrap wiring, preserving fallback and ensuring no `--approval-mode yolo`/`--auto-approve`/`--yolo` path.

## Target Files
- `src/ai/omp/acpProcess.ts` (new) — ACP spawn/session lifecycle for ACP-registered tools.
- `src/ai/omp/__tests__/acpProcess.test.ts` (new) — pure spawn/fake-transport coverage, including mandatory spawn `cwd` and conditionally selected `--cwd`.
- `src/extension.ts` (existing) — new wiring after TASK-001 exists.
- `src/extension.test.ts` (existing) — minimal wiring smoke for the new ACP activation path.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | start uses `omp acp` without approval-auto arguments | spawned args never contain `yolo`/`--approval-mode`/`--auto-approve` | FakeSpawn, FakeAcpTransport |
| 2 | unit | start passes workspace cwd and conditional `--cwd` from evidence | spawn options always have `cwd`; `--cwd` flag appears only if TASK-001 recorded support | FakeSpawn, recorded probe evidence |
| 3 | edge | spawn fails or exits immediately | host-reported failure and fallback available | FakeSpawn error/exit |
| 4 | regression | extension activation still registers and falls back to builtin | existing commands registered, builtin fallback not removed | vscode mock |
| 5 | regression | DB host tools remain read-only guarded | host-tool executor rejects or resolves read-only via existing guard | existing registry shape |

## Test Files
- `src/ai/omp/__tests__/acpProcess.test.ts`
- `src/extension.test.ts` (extend existing)

## Verification Commands
```bash
npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/extension.test.ts && npm run compile && npm run typecheck
```

## Acceptance Criteria
- [ ] no yolo/auto-approval args pass through ACP spawn.
- [ ] spawn always supplies `cwd` and conditionally uses `--cwd` only when TASK-001 proves support.
- [ ] extension registration remains complete and fallback path is not regressed.
- [ ] reviewer verdict APPROVED.

## Dependencies
- TASK-001

## Interfaces
- Consumes: `AcpClient` lifecycle from TASK-001 and its recorded cwd/`--cwd` probe evidence.
- Produces: ACP-aware process wrapper used by TASK-004 panel lifecycle and extension wiring.

## Discussion
(queued)

---
## Executor Report
(pending)

## Reviewer Verdict
(pending)
