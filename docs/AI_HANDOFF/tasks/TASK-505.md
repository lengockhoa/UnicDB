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

