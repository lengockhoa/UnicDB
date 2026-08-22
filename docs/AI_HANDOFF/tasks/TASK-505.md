# TASK-505 — Run .sh button (terminal)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §7

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

