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

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart (matches config handoff.reviewer.model = unic-smart)
EXECUTOR_MODEL: unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit
  result: 11 pass / 0 fail; tsc exit 0 (fresh re-run, not executor output)
TEST_PLAN_COVERAGE: all-followed — 6/6 spec cases with real assertions (+5 supplementary); edge cases #2/#3/#4/#6 exceed minTestsEdgeCase=2; no lint script in package.json, typecheck script is exactly the Verification Command
FINDINGS:
  critical: none
  important:
    - docs/AI_HANDOFF/tasks/TASK-003.md (Executor Report) — RED_OUTPUT field is missing; SUMMARY claims "TDD: 6-case RED (module-not-found)" but no failing output is pasted. RULES.md:153 requires the actual RED paste. Fix: `mv src/ai/omp/detect.ts /tmp/ && npx vitest run src/ai/omp/__tests__/detect.test.ts` → paste the verbatim module-not-found failure into a `RED_OUTPUT:` field in the Executor Report → `mv` back → re-run Verification Commands fresh and confirm 11 pass / tsc 0.
  minor: none
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation is correct and approved on substance — reason taxonomy exactly as spec'd, ENOENT never throws, execFn-injected path runs zero real exec, no vscode import, constants verbatim from research doc; live sanity `which omp && omp --version` → `/Users/lenk/.local/bin/omp`, `omp/18.0.1` confirms the `omp\/(\d+(\.\d+)*)` parse expectation. Only the missing RED-evidence field blocks handoff.

## Executor Report (fix round 1)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: FixL-T003
SUMMARY: Captured missing RED_OUTPUT for the 6-case TDD RED step (module-not-found when `src/ai/omp/detect.ts` was temporarily moved aside), pasted verbatim below; restored the file; re-ran the task's Verification Commands fresh — 11 pass / 0 fail and `npx tsc --noEmit` exit 0. No implementation touched.
TEST_PLAN_FOLLOWED: task §Test Cases (unchanged from round 0 — RED_OUTPUT was the only gap)
FILES_CHANGED:
  - docs/AI_HANDOFF/tasks/TASK-003.md: appended this report with RED_OUTPUT + re-verification
TESTS_ADDED: none (no new tests; existing 11 cases unchanged)
VERIFICATION:
  command_red: `mv src/ai/omp/detect.ts /tmp/detect.ts.bak && npx vitest run src/ai/omp/__tests__/detect.test.ts`
  command_green: `mv /tmp/detect.ts.bak src/ai/omp/detect.ts && npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit`
  result_red: 1 failed suite / no tests collected (module-not-found) — exit 1
  result_green: 11 pass / 0 fail; tsc exit 0 (no output)
  RED_OUTPUT: |
    > npx vitest run src/ai/omp/__tests__/detect.test.ts

    The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB

     ❯ src/ai/omp/__tests__/detect.test.ts  (0 test)

    ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

     FAIL  src/ai/omp/__tests__/detect.test.ts [ src/ai/omp/__tests__/detect.test.ts ]
    Error: Failed to load url ../detect (resolved id: ../detect) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/src/ai/omp/__tests__/detect.test.ts. Does the file exist?
     ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

    ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

     Test Files  1 failed (1)
          Tests  no tests
       Start at  22:58:35
       Duration  206ms (transform 18ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 38ms)

  green_output_excerpt: |
    ✓ src/ai/omp/__tests__/detect.test.ts  (11 tests) 3ms
     Test Files  1 passed (1)
          Tests  11 passed (11)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — docs-only fix; implementation untouched
NEXT: ready for review

## Reviewer Verdict (re-review round 1)

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart (matches config handoff.reviewer.model = unic-smart)
EXECUTOR_MODEL: unic-code (FixL-T003; differs from reviewer — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit
  result: 11 pass / 0 fail; tsc exit 0 (fresh re-run)
FIX_VERIFICATION:
  - RED_OUTPUT now present with real module-not-found output (vite "Failed to load url ../detect … Does the file exist?", 1 failed suite, 0 tests, exit 1) — genuine RED evidence per RULES.md, matches the exact procedure prescribed in round-1 finding.
  - Implementation untouched: git diff be4626e..7a3d6b6 for src/ai/omp/detect.ts + detect.test.ts is empty (docs-only fix).
TEST_PLAN_COVERAGE: all-followed (unchanged from round 1 — 6/6 spec cases + 5 supplementary; round-1 sole finding now resolved)
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Round-1 finding (missing RED evidence) fully resolved; substance was already approved in round 1.
