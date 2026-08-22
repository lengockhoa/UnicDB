# TASK-205 — Version 1.3.0 + smoke manifest

Status: ready
Owner: -
Reviewer: -
Parent plan: docs/AI_HANDOFF/PLAN.md

## Goal

Bump version 1.2.2 → 1.3.0 (minor — user rule: số giữa = update lớn), cập nhật README feature bullet, chạy full regression + build vsix. Orchestrator lo GitHub release; task này chỉ bump + smoke.

## Target Files

- `package.json` — `"version": "1.3.0"`
- `README.md` — Features section thêm 1 bullet: results grid AG Grid (sort/filter per column, quick search, selection + copy, row count)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | happy | version đúng | `package.json` version === "1.3.0" |
| 2 | happy | vsix build | `npm run package` sinh file `vsdb-1.3.0.vsix` tồn tại trên disk |
| 3 | edge | smoke manifest vsix | unzip -p vsix 'extension/package.json' | jq .version → "1.3.0"; manifest KHÔNG chứa "ag-grid-enterprise" (Community only) |

## Test Files

N/A — verification bằng lệnh shell (không thêm test file cho version bump; đây là release chore, không có contract hành vi mới). Rule "≥2 edge" không áp dụng được cho bump version — justification: không có code path mới; bằng chứng là full-suite + vsix manifest.

## Verification Commands

```bash
npx tsc --noEmit && npx vitest run && npm run compile && npm run package && unzip -p vsdb-1.3.0.vsix extension/package.json | grep -o '"version": "[^"]*"'
```

## Acceptance Criteria

- [ ] `package.json` version 1.3.0
- [ ] README có bullet feature AG Grid results grid
- [ ] `npm run package` thành công, `vsdb-1.3.0.vsix` tồn tại, manifest version 1.3.0
- [ ] Full suite `npx vitest run` pass (regression net cuối cycle)

## Dependencies

TASK-201, TASK-203, TASK-204 (cần grid + host fix hoàn chỉnh trước khi bump + package)

## Interfaces

Consumes: none. Produces: `vsdb-1.3.0.vsix` (orchestrator sẽ tạo GitHub release + tag `v1.3.0`).

## Discussion

### 2026-08-22 · planner · unic-smart
Version rule user: "số cuối = patch nhỏ, số giữa = update lớn" — thay grid engine là update lớn → 1.3.0 đúng.
