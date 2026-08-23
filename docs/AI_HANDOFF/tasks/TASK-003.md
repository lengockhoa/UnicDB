# TASK-003 — omp detection, version gate + fallback decision

## Goal
detectOmp(): tìm binary, đọc version, so MIN_OMP_VERSION, trả quyết định dùng omp hay fallback builtin — với install/update hint message cho UI.

## Target Files
- `src/ai/omp/detect.ts` (mới)
- `src/ai/omp/__tests__/detect.test.ts` (mới)

## Spec (frozen)
```ts
export const MIN_OMP_VERSION = "17.0.0"
export const OMP_INSTALL_HINT = "curl -fsSL https://omp.sh/install | sh"
export const OMP_UPDATE_HINT = "omp update"
export function compareVersions(a: string, b: string): number  // semantic so sánh "17.0.1" vs "17.10.0" đúng numeric từng segment; non-numeric tail bỏ qua
export async function detectOmp(execFn?: (cmd: string) => Promise<string>): Promise<OmpDetection>
export interface OmpDetection {
  available: boolean   // binary chạy được và trả version
  ok: boolean          // available && version >= MIN_OMP_VERSION
  path?: string        // từ `which omp` output
  version?: string     // parse "omp/18.0.1" → "18.0.1"
  reason?: string      // "not-installed" | "version-too-old" | "version-unknown" | "spawn-failed"
}
```
- execFn injectable (default: promisified exec qua lazy import). Commands chạy: `which omp` (hoặc opts path), `<omp> --version`.
- Không import vscode; không chạy gì khi execFn provided (tests thuần).
- Spawn error (ENOENT) → available=false, reason "not-installed" — KHÔNG throw.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | execFn trả path + "omp/18.0.1" | available, ok, version "18.0.1", path set |
| 2 | edge (missing) | execFn reject ENOENT | available=false, reason "not-installed", không throw |
| 3 | edge (old) | "omp/16.9.0" | ok=false, reason "version-too-old" |
| 4 | edge (garbage) | output không parse được | reason "version-unknown", ok=false |
| 5 | unit | compareVersions "17.0.1" vs "17.10.0" | -1 (numeric, không string-compare); "18.0.0" vs "17.99.99" = 1; equal = 0 |
| 6 | edge (non-numeric tail) | "18.0.1-beta.2" | parse 18.0.1, so sánh ổn |

## Test Files
`src/ai/omp/__tests__/detect.test.ts`

## Verification Commands
```
npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit
```

## Acceptance
- [x] 6 test PASS RED→GREEN (output thật)
- [x] Không import vscode; không exec thật khi execFn provided
- [x] `npx tsc --noEmit` sạch

## Interfaces
- Consumes: `(none)`.
- Produces: `detectOmp`, `compareVersions`, `MIN_OMP_VERSION`, `OMP_INSTALL_HINT`, `OMP_UPDATE_HINT`, `OmpDetection` (T4 consume).

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecL-T003
SUMMARY: Implemented `src/ai/omp/detect.ts` (MIN_OMP_VERSION/OMP_INSTALL_HINT/OMP_UPDATE_HINT constants, semantic `compareVersions` with non-numeric tail tolerance, and `detectOmp(execFn?)` returning `OmpDetection`) per frozen spec. TDD: 6-case RED (module-not-found) → GREEN 11/11 passing.
TEST_PLAN_FOLLOWED: task §Test Cases (all 6 cases present + 5 supplementary assertions: equality, numeric ordering, constants)
FILES_CHANGED:
  - src/ai/omp/detect.ts: new — detectOmp + compareVersions + constants + OmpDetection
  - src/ai/omp/__tests__/detect.test.ts: new — 11 tests across 3 describe blocks
TESTS_ADDED:
  - src/ai/omp/__tests__/detect.test.ts: "detectOmp — frozen contract" (4 cases: happy/ENOENT/old/garbage), "compareVersions — frozen contract" (4 cases: 17.0.1<17.10.0, 18>17.99.99, equal, non-numeric tail), "constants — frozen values" (3 cases)
VERIFICATION:
  command: `npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit`
  result: 11 pass / 0 fail; tsc exit 0
  output_excerpt: |
    ✓ src/ai/omp/__tests__/detect.test.ts  (11 tests) 5ms
    Test Files  1 passed (1)
         Tests  11 passed (11)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — main-tree files are additive (no shared mutation risk with T001/T002)
NEXT: ready for review
