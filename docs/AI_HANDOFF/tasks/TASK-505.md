# TASK-505 — Run .sh button (terminal)

- Status: `pending_review`
- Owner: `feature-implementer-lane`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer-lane
SUMMARY: Registered vsdb.runScript; created/reused 'VSDB Script' terminal; added editor/title menu (when: resourceLangId == shellscript); added 4 TDD tests covering register, full-content sendText, empty-doc, terminal reuse.
TEST_PLAN_FOLLOWED: task §4 (4 Test Cases)
FILES_CHANGED:
  - src/extension.ts: added runScriptTerminal module var + commandRunScript() + vsdb.runScript registration
  - src/extension.test.ts: added createTerminal mock + Terminal class + 4 TASK-505 tests + updated smoke expected list
  - package.json: added vsdb.runScript command declaration + editor/title menu entry (when: resourceLangId == shellscript)
TESTS_ADDED:
  - src/extension.test.ts: TASK-505 describe block — Test #1 (command registered), Test #2 (terminal + sendText full content + show), Test #3 (empty doc → '\n', no throw), Test #4 (terminal reuse — single createTerminal across 2 invocations)
VERIFICATION:
  command: npm run compile
  result: exit 0
  output_excerpt: |
    ⚡ Done in 141ms
    esbuild: build complete
  command: npx vitest run src/extension.test.ts
  result: 15 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ src/extension.test.ts (15 tests) 5ms
    Test Files  1 passed (1)
    Tests  15 passed (15)
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > vsdb@1.3.2 typecheck
    > tsc --noEmit
RED_OUTPUT (captured before impl): |
   Test Files  1 failed (1)
        Tests  5 failed | 10 passed (15)
   FAIL  src/extension.test.ts > extension.activate — wiring smoke > register đủ 10 command theo package.json
   FAIL  src/extension.test.ts > TASK-505 — runScript command + terminal reuse > Test #1: command 'vsdb.runScript' được register khi activate
   FAIL  src/extension.test.ts > TASK-505 — runScript command + terminal reuse > Test #2: handler tạo terminal 'VSDB Script' + sendText full content của document shellscript
   FAIL  src/extension.test.ts > TASK-505 — runScript command + terminal reuse > Test #3: document rỗng → vẫn sendText (newline), không throw
   FAIL  src/extension.test.ts > TASK-505 — runScript command + terminal reuse > Test #4: terminal cũ còn sống → reuse, chỉ 1 createTerminal call khi run 2 lần
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review


## Goal

Nút Run trên editor title khi file `.sh` mở: gửi nguyên nội dung file vào Integrated Terminal (như paste full file vào shell), hiện terminal.

## Target Files

- `src/extension.ts` — register command `vsdb.runScript`; editor title button `when: resourceLangId == shellscript`; handler: đọc document text → tạo/reuse terminal `VSDB Script` → `sendText(fullContent + "\n", true)` → `show()`.
- `src/extension.test.ts` — thêm tests.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | command registered với đúng id | commands list chứa `vsdb.runScript` | activate |
| 2 | unit | handler tạo terminal + sendText full content | sendText called với toàn bộ text (giả vscode mock) | document shellscript |
| 3 | edge | document rỗng | vẫn sendText (chuỗi rỗng + newline), không throw | empty doc |
| 4 | unit | reuse terminal cũ nếu còn sống | chỉ 1 createTerminal call khi chạy 2 lần | run 2 lần |

## Test Files

- `src/extension.test.ts` (append)

## Verification Commands

```bash
npm run compile
npx vitest run src/extension.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Tests PASS.
- [ ] Không regression.
- [ ] Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: command `vsdb.runScript` (id), menu contribution trong `package.json` contributes.menus.editor/title.

---

## Discussion

(chưa có comment)


## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (≠ reviewer — isolation OK, matches config handoff.reviewer.model=unic-smart)
VERIFICATION_RERUN:
  command: npm run compile
  result: PASS (exit 0, esbuild build complete)
  command: npx vitest run src/extension.test.ts
  result: PASS — 15 pass / 0 fail (exit 0)
  command: npm run typecheck
  result: PASS (tsc --noEmit, exit 0)
TEST_PLAN_COVERAGE: partial — 4/4 tests in §4 implemented, but edge-case floor unmet (handoff.plan.minTestsEdgeCase=2; only Test #3 empty-doc is edge) and dead-terminal→recreate branch has zero coverage
FINDINGS:
  important:
    - src/extension.test.ts:92-105 (createTerminal mock) + missing test — mock returns fresh terminals with `exitStatus = { code: 0 }`, i.e. models a newly created terminal as already dead; Test #4 must hand-patch `firstTerm.exitStatus = undefined` to simulate alive, and the opposite branch (src/extension.ts:562 `exitStatus !== undefined` → createTerminal again) is never exercised. If the liveness check regressed to always-reuse or always-recreate, no test would fail. Fix: (a) mock creates alive terminals — initialize `exitStatus: undefined`; (b) drop the manual patch in Test #4; (c) add Test #5 (2nd edge case, satisfies the ≥2 floor): run once → set `firstTerm.exitStatus = { code: 0 }` (dead) → run again → expect `state.createdTerminals.length === 2`, second terminal received `sendText(scriptText + "\n")` + `show`, first terminal NOT reused (`firstTerm.sendText` still 1 call).
  minor:
    - src/extension.test.ts:218 — smoke test title "register đủ 10 command theo package.json" now asserts 11 ids after adding vsdb.runScript; update title to "đủ 11 command" to remove drift.
    - src/extension.ts:565 — task Target Files spec `sendText(fullContent + "\n", true)`; impl sends single-arg `text + "\n"`. Functionally equivalent (trailing newline executes the script) and tests lock actual behavior — acceptable, noting the deviation.
RED_OUTPUT: credible — real failing test names (5 failed) captured pre-impl.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation itself is correct (reuse check, empty-doc, when-clause, icon, menu group all right); the gap is test coverage of the recreate branch only. Small fix: mock fidelity + 1 new test.

## Fix Round 1

ADDRESSED REVIEWER FINDINGS:
- IMPORTANT (src/extension.test.ts mock + missing Test #5):
  - Mock (src/extension.test.ts:93-105): createTerminal now returns terminals với `exitStatus: undefined` (alive-by-default, đúng VS Code API contract). Tests muốn simulate terminal chết phải chủ động set `term.exitStatus = { code: 0 }` sau khi tạo.
  - Test #4 đã drop manual patch `firstTerm.exitStatus = undefined`; comment đã cập nhật thành "mock alive-by-default".
  - Test #5 (NEW — 2nd edge case, satisfies ≥2 floor + covers recreate branch src/extension.ts:562): run lần 1 → mark firstTerm dead (exitStatus = {code:0}) → run lần 2 → expect length 2, terminal thứ 2 có name "VSDB Script", firstTerm.sendText chỉ 1 lần, secondTerm.sendText đúng 1 lần với payload `"echo first\n\n"`, secondTerm.show called.
  - Reset module giữa các it() bằng `vi.resetModules()` trong TASK-505 beforeEach + dynamic `import("./extension")` trong helper `activateFresh` — đảm bảo `runScriptTerminal` (module-level var) reset mỗi test, tránh cross-test leak gây RED giả.
- MINOR (title drift 10 → 11): smoke test "register đủ 10 command theo package.json" đã đổi thành "đủ 11" để khớp với 11 ids trong expected list.
- MINOR (sendText single-arg vs task-spec two-arg): accepted as-is per reviewer (test #2 lock actual behavior `text + "\n"`).

FILES_CHANGED:
  - src/extension.test.ts:
    - mock createTerminal: khởi tạo `exitStatus: undefined` (alive-by-default).
    - TASK-505 beforeEach: thêm `vi.resetModules()` + helper `activateFresh(ctx)` dùng dynamic `import("./extension")`.
    - Tests #1, #2, #3, #4: migrate sang `activateFresh(ctx)` (async) thay vì gọi `activate()` trực tiếp; Test #4 bỏ patch `firstTerm.exitStatus = undefined`.
    - Test #5: mới — dead-terminal → recreate branch covered.
    - Smoke test title: "đủ 10 command" → "đủ 11 command".
  - src/extension.ts: unchanged (impl đã đúng; reviewer accepted sendText deviation).
  - package.json: unchanged (id `vsdb.runScript` + menu contribution giữ nguyên).
  - docs/AI_HANDOFF/tasks/TASK-505.md: appended this Fix Round 1 report.

TESTS_ADDED:
  - src/extension.test.ts > TASK-505 … > Test #5: terminal cũ đã chết (exitStatus !== undefined) → tạo terminal mới khi run lại.

VERIFICATION (this round):
  command: npm run compile
  result: exit 0
  output_excerpt: |
    esbuild: build complete
    ⚡ Done in 122ms
  command: npx vitest run src/extension.test.ts
  result: 16 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ src/extension.test.ts (16 tests) 18ms
    Test Files  1 passed (1)
    Tests  16 passed (16)
  command: npm run typecheck
  result: exit 0
  output_excerpt: |
    > vsdb@1.3.2 typecheck
    > tsc --noEmit
RED_OUTPUT (Test #5 pre-mock-fix, this round): |
    FAIL src/extension.test.ts > TASK-505 … > Test #5
      expected +0 to be 1 // length after first call was 0
      (root cause: module-level runScriptTerminal persisted across `it()` blocks; first `await fn()` reused thay vì create → length=0. Resolved by `vi.resetModules()` + per-test dynamic import + activateFresh helper.)

ISSUES: none (Test #5 RED → GREEN after mock + resetModules + Test #5 expectation adjustment; all 16 tests pass clean).
HANDOFF_TO_REVIEWER: yes
NEXT: ready for re-review (Test #5 added; mock fidelity fixed; title drift fixed; recreate branch exercised end-to-end).
