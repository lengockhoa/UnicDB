# TASK-506 — Version 1.4.0 + README + full-suite boundary

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Goal

Bump version 1.3.2 → 1.4.0, README bullets cho edit/paste/export/save/where/run-sh, chạy FULL suite + gates làm boundary cuối cycle.

## Target Files

- `package.json` — version 1.4.0.
- `README.md` — bullets feature mới.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | boundary | full `npx vitest run` | 0 fail (232 cũ + mới) | sau mọi task |
| 2 | boundary | `npm run typecheck` | exit 0 | |
| 3 | boundary | `npm run compile` | dist artifacts sinh đúng | |
| 4 | regression | version read từ package.json | "1.4.0" | |

## Test Files

- (không file mới — boundary asserts trong verification)

## Verification Commands

```bash
node -e "console.log(require('./package.json').version)"
npm run compile
npx vitest run
npm run typecheck
```

## Acceptance Criteria

- [ ] Version 1.4.0.
- [ ] Toàn suite pass.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-501..505 done.

## Interfaces

- Consumes: (none)
- Produces: (none)

---

## Discussion

(chưa có comment)

