# Worklog

Track session-level execution details.

## Budget Rules

Keep this file compact to save AI context tokens:

- **Max 30 entries.** When over, archive the oldest entries to `docs/WORKLOG_ARCHIVE.md`.
- **Max ~600 lines.** If over, archive oldest entries until under budget.
- Each entry should be 10-20 lines max (summary, not transcript).
- On archive: move full entry block to `docs/WORKLOG_ARCHIVE.md` (create if missing).
- Keep a compaction marker as the last line: `<!-- Entries before YYYY-MM archived to docs/WORKLOG_ARCHIVE.md. Keep this file < 600 lines. -->`
- If the user says "compact worklog" or "clean worklog", perform the archive pass and report what moved.

For each significant action, append:
- Date/time
- Action taken
- Files changed
- Verification run
- Outcome

---

## 2026-08-23 — Cycle 2026-08-23-H: hardening + release v1.5.1

- Action: carry-over minors từ reviews cycle G → 4 task handoff (701 EXPLAIN guard, 702 codepoint cap, 703 lock hygiene, 704 release).
- Files: `src/core/dangerousStatement.ts` (skip-past-`explain` prelude, `sawExplain` flag), `src/core/text.ts` (new `truncateAtBoundary`), `src/extension.ts` (capDetail dùng helper — 2 dòng), `package-lock.json` (root 1.3.0→1.5.1), `src/__tests__/releaseHygiene.test.ts` (new), package.json 1.5.1.
- Waves: W1 = 701∥702∥703 (disjoint files, executors unic-code trong worktrees) → 9ac114e; W2 = 704 → 9e3f7b1; reviews 0bf6bc8; close 0438762.
- Review: 4/4 approved (701/702/704 approved_minor). 702 cần 1 vòng auto-fix — blocker chỉ là thiếu RED_OUTPUT paste; Fix702 temp-revert helper → capture real lone-surrogate failure → restore byte-identical.
- Verification: full suite 40 files / 453 tests PASS; `tsc --noEmit` 0; `scripts/build.sh` → dist/vsdb-1.5.1.vsix 1576198 bytes.
- Release: push main (356973d..0438762), tag v1.5.1, gh release + asset verified (`gh release view`).

## 2026-08-24 — Cycle M: approval-aware omp ACP bridge

- Action: replaced Cycle L's `omp --mode rpc --approval-mode yolo` integration with a JSON-RPC/NDJSON ACP bridge; user-facing ACP permissions now require explicit Allow/Deny in AI Chat and default-deny on timeout, stop, disposal, replacement, and process exit.
- Files: `src/ai/omp/acp.ts`, `acpProcess.ts`, ACP tests; `src/ui/aiChatPanel.ts`, message/webview permission UI and ACP tests; `src/extension.ts`; removed legacy RPC/process bridge and its tests after caller migration.
- Protocol evidence: live `omp acp` 18.0.1 probe established `initialize`, `initialized`, canonical `session/new`, session ID, and child `cwd`; unsafe guessed `session/create` was rejected and never shipped.
- Review: 4/4 approved (TASK-004 approved_minor after fix round for real child-exit → default-deny lifecycle). Known minor: `hostTools.ts`/`detect.ts` are now orphaned; deferred rather than deleting fallback-related code outside this cycle.
- Verification: full suite 751 passed / 2 opt-in availability smoke skipped; `npm run compile` and `npm run typecheck` clean.
- Lesson lặp lại: copy-back bằng `git diff --name-only` + `ls-files` bỏ sót file gitignored (`.cache/release-notes-v1.5.1.md` ở cycle G) → cycle H copy tay notes ngay đầu và báo path trong report — không mất lần nữa.

## 2026-08-24 — Cycle N: builtin engine streaming

- Action: streaming cho builtin AI engine (đóng UX gap chờ full response); unfreeze có chủ đích `provider.ts`/`agent.ts` (frozen từ cycle J chỉ là scope).
- Files: `src/ai/provider.ts` (streamComplete SSE, parser tự viết 0 dep, CRLF-safe, AbortError trần), `src/ai/agent.ts` (opt-in streamComplete deps + onStreamFallback 1 lần + catch order pin: abort→rethrow / ProviderError@0→fallback / else→rethrow), `src/ui/aiChatPanel.ts` + `webview/aiChatPanelMain.ts` (delta render có sẵn từ ACP, banner "— streaming", deStreamOpenBubble trên done/error), `src/extension.ts` (5-arg closure).
- Fix rounds: T001 (CRLF parse + abort wrap), T003 (Stop hiện error bubble — phân loại abort-vs-error; test tự gate theo signal).
- Flaky-type fix: `webviewExport.test.ts` drain AG Grid debounce-0 timer sau teardown (unhandled 'window is not defined' → exit 1 dù 777 pass).
- Verification: full suite 778 passed / 2 opt-in skipped, exit 0; compile + typecheck clean. Pushed 2056828.

## 2026-08-24 — Cycle O: ACP session history & resume

- Action: AI Chat thêm Resume session — list/load/replay/resume omp sessions qua ACP; fix latent bug session/new thiếu mcpServers:[] (live -32603).
- Probe-first: live omp acp NDJSON probes chứng minh session/list, session/load (replay 157 notifications), resume prompt end_turn; ghi queue/ACP-SESSION-research.md trước khi plan (không đoán envelope).
- Files: src/ai/omp/acp.ts (sessionList/sessionLoad + AcpReplayBuffer — cửa sổ replay đóng theo outgoing write, multi-flush safe), src/ai/omp/acpProcess.ts (wiring + mcpServers fix), src/ui/aiChatPanel.ts + aiChatPanelMessages.ts (picker, replay drop-guard, cap 50 + truncated notice, streaming guard), webview/aiChatPanelMain.ts (picker UI + history render textContent-safe).
- Fix round T003: missing RED output, streaming guard, 2 test không giết mutation (sort monotonic fixture, drop-guard bị transport absorb che).
- Verification: full suite 819 passed / 2 opt-in skipped exit 0; compile + typecheck clean. Pushed a3ba36b.

## 2026-08-24 — Cycle P: permission detail + tool-call UI + VSIX release

- Action: dọn sạch backlog cuối — permission dialog hiện tool args/SQL preview, builtin engine hiện tool-call live, release pass VSIX 1.6.0.
- Files: src/ui/permissionDetail.ts (sanitizer pure: redact secret keys, SQL preview, JSON pretty, cap 2000), aiChatPanel.ts + webview (collapsible textContent detail), agent.ts (AgentCallbacks.onToolCall additive — fire trước executeToolCall, không abort-check trong loop), CHANGELOG.md (I–P), docs/RELEASE.md, .vscodeignore (thêm vitest.integration-all.config.ts bị leak).
- Lỗi bắt được: releaseHygiene test phát hiện package-lock root version 1.5.1 ≠ package.json 1.6.0 → npm install --package-lock-only sync lại.
- Verification: full suite 838 passed / 2 opt-in skipped exit 0; compile + typecheck clean; vsdb-1.6.0.vsix (15 files, 1.55 MB, không src/node_modules). Pushed 6df9083.
