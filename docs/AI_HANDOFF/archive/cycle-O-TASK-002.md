# TASK-002 — AcpProcess session/new envelope fix + list/load on spawned client

- Status: `approved`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.B

## Goal

Sửa envelope `session/new` của `AcpProcess.start()` thành `{ cwd, mcpServers: [] }` (fix
latent bug `-32603` theo evidence fact 1) và chứng minh client do handle exposes sẵn
`sessionList()`/`sessionLoad()` chạy qua process thật (fake child) — không seam mới.

## Target Files

- `src/ai/omp/acpProcess.ts` — dòng `session/new` params: thêm `mcpServers: []`. Không đổi
  gì khác (spawn, handshake, version, dispose, watchdog giữ nguyên).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy-regression) | `session/new` frame gửi đúng `{cwd, mcpServers: []}` | frame thứ 2 child nhận được parse ra `params` deep-equal `{cwd:"/w",mcpServers:[]}` | FakeChildProcess hiện có; drive handshake; đọc stdin buffer |
| 2 | unit (edge-flag) | `supportCwdFlag:false` vẫn spawn cwd đúng + envelope vẫn có `mcpServers: []` | spawn options `cwd === "/w"`; KHÔNG có `--cwd` arg; `session/new` params vẫn đủ `{cwd, mcpServers: []}` | opts `supportCwdFlag:false` |
| 3 | unit (edge-sessionLoad) | `sessionLoad` qua handle của process: result settle + replay buffer được trả (cửa sổ còn mở) | `handle.acp.sessionLoad("s1","/w")` resolve với `replay.notifications` chứa đúng 2 notifications theo thứ tự, `replay.closed === false` (cửa sổ chỉ đóng khi request kế — xem TASK-001 §Interfaces); frame gửi đi có `params:{sessionId:"s1",cwd:"/w",mcpServers:[]}` | sau handshake, fake child respond `{result:{configOptions:[],modes:{}}}` + feed 2 `session/update` notifications (đều mang `params.sessionId:"s1"`) |
| 4 | unit (edge-list) | `sessionList` qua handle của process: lỗi server propagate nguyên vẹn | `handle.acp.sessionList()` reject, message chứa nội dung lỗi, `code` giữ `-32603` nếu server trả code đó | fake child respond `{error:{code:-32603,message:"boom"}}` |
| 5 | unit (regression-lifecycle) | toàn bộ lifecycle hiện có không đổi | mọi test hiện có trong `acpProcess.test.ts` pass nguyên (initialize → session/new → sessionId/version/dispose/notifications/server-request wiring); fake child chỉ đổi chỗ assert envelope | existing suite |

Lưu ý fixture: case 1 là **regression RED** — code hiện tại (dòng ~165) gửi `{cwd}` không
kèm `mcpServers`; test phải fail trước fix. Case 3 cần các `await Promise.resolve()` giữa
các frame như pattern `driveHandshake` hiện có (stdin/stdout cùng tick).

## Test Files

- `src/ai/omp/__tests__/acpProcess.test.ts` — append cases 1–4 (case 5 = suite cũ chạy lại).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
```

(Không có lint script trong `package.json` — N/A.)

## Acceptance Criteria

- [ ] Case 1 RED trước fix (paste output), GREEN sau.
- [ ] Suite `acpProcess.test.ts` cũ pass nguyên vẹn — lifecycle/permission/watchdog không đổi.
- [ ] Không file nào ngoài `acpProcess.ts` + test bị sửa.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — tiêu thụ `AcpClient.sessionList()/sessionLoad()` (chữ ký ở TASK-001
  §Interfaces) trên client mà `AcpProcess.start()` trả về.

## Interfaces

- Consumes: từ TASK-001 — `sessionList(): Promise<AcpSessionListItem[]>`,
  `sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionLoadResult>` trên
  `handle.acp`, với `AcpSessionLoadResult { configOptions, modes, replay:
  AcpReplayBuffer }` (`replay.notifications`, `replay.closed` — semantics cửa sổ ở
  TASK-001 §Interfaces: đóng khi request kế, không drain-tick).
- Produces: (none mới) — `AcpProcessHandle` giữ nguyên shape
  `{ acp: AcpClient; sessionId: string; version: string; dispose(): void }`; giờ `acp`
  mang thêm 2 method của TASK-001. TASK-003 dùng trực tiếp.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Ghi chú cho @executor: evidence fact 1 nói `{cwd}` đơn lẻ → `-32603` trên omp 18.0.1. Đây là
bug tiềm ẩn của chính Cycle M (unit test cũ không bắt vì fake child trả lời bất kể params;
live smoke gửi đúng envelope thủ công). Chỉ sửa đúng 1 dòng params — không refactor kèm.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecO-T002
SUMMARY: Added `mcpServers: []` to the `session/new` envelope sent by `AcpProcess.start()` (the latent -32603 bug). Verified `handle.acp.sessionList()` and `handle.acp.sessionLoad()` from TASK-001 surface through the spawned client. No other code changed; lifecycle/permission/watchdog untouched.
TEST_PLAN_FOLLOWED: TASK §4 verbatim — cases #1..#4 appended to `src/ai/omp/__tests__/acpProcess.test.ts`; case #5 covered by the existing suite passing unmodified.
FILES_CHANGED:
  - src/ai/omp/acpProcess.ts:165 — `acp.request("session/new", { cwd: this.opts.cwd })` → `acp.request("session/new", { cwd: this.opts.cwd, mcpServers: [] })`. One line, one property. No other edits.
  - src/ai/omp/__tests__/acpProcess.test.ts: appended 4 tests + a `readStdinFrames` helper. Reads the fake child's stdin PassThrough buffer to assert envelope params.
TESTS_ADDED:
  - src/ai/omp/__tests__/acpProcess.test.ts: session/new frame sends {cwd, mcpServers: []} (regression for latent -32603)
  - src/ai/omp/__tests__/acpProcess.test.ts: supportCwdFlag:false still spawns cwd + session/new envelope carries mcpServers: []
  - src/ai/omp/__tests__/acpProcess.test.ts: handle.acp.sessionLoad resolves with replay buffer (window open across multi-flush)
  - src/ai/omp/__tests__/acpProcess.test.ts: handle.acp.sessionList rejects with server error code + message intact
VERIFICATION:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
  result: 28 pass / 0 fail / exit 0
  output_excerpt: |
    > vsdb@1.5.1 typecheck
    > tsc --noEmit
    ===
     RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
     ✓ src/ai/omp/__tests__/acp.test.ts  (14 tests) 4ms
     ✓ src/ai/omp/__tests__/acpProcess.test.ts  (14 tests) 7ms
     Test Files  2 passed (2)
          Tests  28 passed (28)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review
```

RED evidence (pre-fix, same command on `acpProcess.test.ts` only):
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB

 ❯ src/ai/omp/__tests__/acpProcess.test.ts  (14 tests | 2 failed) 11ms
   ❯ AcpProcess > session/new frame sends {cwd, mcpServers: []} (regression for latent -32603)
     → expected { cwd: '/w' } to deeply equal { cwd: '/w', mcpServers: [] }
   ❯ AcpProcess > supportCwdFlag:false still spawns cwd + session/new envelope carries mcpServers: []
     → expected { cwd: '/w' } to deeply equal { cwd: '/w', mcpServers: [] }

  Test Files  1 failed (1)
       Tests  2 failed | 12 passed (14)
```
Cases #3 and #4 (sessionLoad, sessionList) passed pre-fix because the AcpClient methods were already added by TASK-001 and `handle.acp` already exposes them; the regression contract pinned by case #1 is the only RED that depends on the AcpProcess edit.

## Reviewer Verdict

```
VERDICT: APPROVED
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (ExecO-T002) — differs from reviewer ✓
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/omp/__tests__/acpProcess.test.ts src/ai/omp/__tests__/acp.test.ts
  result: 28 pass / 0 fail / exit 0 (typecheck clean)
TEST_PLAN_COVERAGE: all-followed — cases #1-#4 appended verbatim; case #5 = existing 10 tests unmodified (diff is pure insertion, 0 deletions)
FINDINGS:
  critical: none
  important: none
  minor:
    - acpProcess.test.ts:680 — case #5 has no test body; comment documents the implicit
      regression contract. Acceptable anchor per task file's "case 5 = suite cũ chạy lại".
NEXT_STATUS_FOR_INDEX: approved
NOTES: Diff is minimal and exact: acpProcess.ts:165 single-property envelope fix, tests pure-insertion. Envelope pinned via stdin frame assert (WRITE side). sessionLoad params {sessionId, cwd, mcpServers:[]} and sessionList {} verified against acp.ts:166,213-216. Spawn args untouched (["acp"] + conditional --cwd only; no yolo/approval-mode/auto-approve). RED output verbatim with real assertion diffs. extension.ts not touched (TASK-003 scope). Lint script N/A (absent in package.json) — typecheck included instead.
```
