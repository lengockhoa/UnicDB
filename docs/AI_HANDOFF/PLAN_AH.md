# PLAN_AH — Cycle AH: Results panel — DataGrip-style accumulating multi-statement results

## §1 Intent

User (verbatim): "Tôi có một vấn đề khi chạy query. Nếu chạy một lúc nhiều câu query liên tiếp với nhau thì kết quả ra rất kỳ cục. Hãy tham khảo chỗ DataGrip... Tôi muốn chạy khoảng 3 câu query thì phải ra cho tôi 3 kết quả khác nhau, chứ không phải là như bây giờ chạy loạn xạ."

Answers from the one asking window (treat as user's own words downstream):

1. Symptom: "Bôi đen chạy 1 lần" — black-select 3 statements in a .sql editor, run once → chaotic results. NOTE: the attached screenshot showed the chat composer, NOT the results panel; this plan is grounded in source analysis, not the image.
2. Model: "Tích lũy, không đè (Recommended)" — DataGrip accumulation: each run APPENDS result tabs, never overwrites previous results.
3. Scope: "Chỉ results panel (Recommended)" — the .sql editor results panel only. SQL Console internals are cycle AF-004's territory (see §2 for the shared-choke-point note).

**Success definition**: bôi đen 3 câu → 3 tabs riêng; chạy lần 2 → 6 tabs; tab mới nhất active; kết quả cũ không mất. Multi-SELECT selection-runs no longer hang/timeout (cursor released between statements in the same run); Load More keeps working for single-statement runs; old tabs stay readable with their loaded rows.

## §2 Scope

**In scope (3 tasks):**

1. `src/core/queryRunner.ts` — `run()` gains `opts?: { append?: boolean }`; append mode accumulates into `this.results` with global indices instead of replacing; cursor discipline for multi-statement runs (`cursorClosed` flag + early cursor close when more statements are pending); `runNo`/`runStmtNo` metadata stamped in append mode.
2. `src/ui/resultsPanel.ts` + `src/extension.ts` (runStatements body only) — editor path threads `{ append: true }`; `render()` gains append-aware cache invalidation (`appendBase`); loadMore rejection for closed cursors surfaces as the existing error path.
3. `webview/main.ts` — append-only tab-strip growth (no replace churn), tab labels `Run N · Statement M` for stamped entries, active-tab pin to the first new tab, per-tab DISTINCT-cache preservation on append.

**Out of scope:** SQL Console internals (AF-004), tab eviction (deferred), OFFSET-stateless paging of closed cursors (deferred to ROADMAP), styles.css, `src/ai/**`, `src/adapters/**`, `src/core/ddl/**`, `src/core/sqlFormat.ts`, MySQL/MSSQL behavior changes, message-contract changes (`src/ui/messages.ts` untouched).

**Same-wave constraint:** waves run sequentially (W1 → W2 → W3) so no same-wave file overlap exists. File ownership: AH-001 owns `src/core/queryRunner.ts` + `src/core/__tests__/queryRunner.test.ts`; AH-002 owns `src/ui/resultsPanel.ts`, `src/extension.ts` (runStatements body, ~:807-844) + their tests; AH-003 owns `webview/main.ts` + `tests/webview*.test.ts`.

**Cross-cycle file locks (do not touch):**
- `webview/styles.css` — cycle AG (staged `ready`, owns it this instant).
- `src/ai/**`, `src/adapters/**`, `src/core/ddl/**`, `src/core/sqlFormat.ts` — cycle AF wave 1 in-flight per RUN.md.
- `src/extension.ts` coordination: AF-004 (pending wave 3) also owns extension.ts. AH-002's edit is confined to the `runStatements` body (runner.run call site :832 + render call :834-836); AF-004's planned edits (console command registration / format wiring) are disjoint regions. AH waves complete before AF wave 3 dispatches per the RUN.md cursor. Noted in TASK-AH-002 §Discussion.
- Resolved ambiguity (recorded, not re-asked): the Console `onRun` also routes through the shared `runStatements` choke point (extension.ts:709), so flipping that call site makes console runs accumulate into the same shared panel too. This is consistent with the user's "results panel" scope — there is exactly one results panel — and AF-004 may later route console runs differently when it owns this file.

## §3 Approach

- **Accumulate inside the runner, not the panel**: `run(statements, onUpdate, opts?: { append?: boolean })`. Default `append: false` = today's exact replace semantics (browse/requery/runSql paths unregressed). In append mode: `base = this.results.length` before mapping; new StatementResults get global indices `base..base+N-1`; previous entries are never mutated. Because `loadMore(index)`, `adopt(index, stmt)` and every webview message (`loadMore`/`requery`/`saveEdits` carrying `index: activeTab`) operate on array positions in `runner.results` / `panel.lastResults`, keeping the accumulating array AS the canonical array means the wire contract needs zero changes.
- **Cursor discipline (fixes the "loạn xạ" hang)**: today, within one run, statement i returns a batched keyset cursor that stays open after `pickResult`'s initial 500-row fetch; statement i+1's `adapter.runQuery` queues on the Postgres pool (max=1) and fails `connectionTimeoutMillis`. In append-mode multi-statement runs: after `pickResult` for statement i, if a batched cursor is open AND statement i+1 exists in THIS run → close the cursor immediately, set `cursorClosed: true` on the entry, keep the first batch rows. The last statement of a run (and every single-statement run) keeps its cursor open + Load More. `loadMore` on a `cursorClosed` entry rejects before touching the dead handle with: `Statement ${index} cursor closed after its run finished — run this statement alone to page through more rows.` (tests pin the substring `run this statement alone`). A new run (append or not) still closes previous runs' open cursors first (existing :120-129 behavior) — old tabs keep their loaded rows; Load More on them degrades with the same clear message.
- **Metadata for labels**: in append mode the runner stamps `runNo` (1-based run ordinal) and `runStmtNo` (1-based statement ordinal within the run) on new entries. Replace-mode runs stamp nothing → single/replace runs keep today's labels. Fields live on `StatementResult` in queryRunner.ts (NOT `src/adapters/types.ts` — AF owns that file).
- **Panel append-awareness**: `render(results, header, opts?: { appendBase?: number })`. With `appendBase`, wholesale cache invalidation (distinctCache / columnTypesByStatement / whereByStatement / tableByStatement / manualStatementIndex) is scoped to indices >= appendBase; caches for old tabs survive so switching back to run 1 keeps its DISTINCT lists and types. Without `opts` (all other callers: browse, retry, save-refresh) behavior is byte-identical to today.
- **Webview append detection is derived, not messaged**: `StateMessage` shape unchanged. The webview detects append as `msg.results.length > results.length` (today, results array length NEVER grows across state posts except append runs — loadMore grows rows, not tabs). On growth: pin `activeTab` to the previous length (first new tab), preserve `distinctByColumn` entries for indices below the previous length, and run the existing statement-identity check only for the new active tab. No clamp churn (append-only growth never shrinks; the existing shrink clamp stays for replace runs).
- **Versioning**: minor bump at release = next free minor (1.12.0 unless AF/AG released first — releasing cycle wins, one cycle rebases).
- **Alternatives rejected**: (a) per-run tab groups with separate arrays — rejected because the wire contract keys everything by global array index; separate arrays need index remapping per group = message-contract churn across loadMore/requery/saveEdits/distinct; (b) OFFSET-stateless loadMore for closed cursors — deferred to ROADMAP (re-executing user SQL with OFFSET has semantics/cost implications); (c) tab eviction — deferred (YAGNI: memory bounded at ~500 rows/tab; eviction shifts indices and breaks in-flight loadMore/requery references).

## §4 Test Plan (TDD)

| Area | Happy path | Edge 1 (kind) | Edge 2 (kind) | Regression |
|---|---|---|---|---|
| runner-append (AH-001) | run2 with `{append:true}` after run1 → accumulated array, old entries untouched, new entries get global indices | empty statements array + append → results unchanged, one onUpdate (boundary) | cancel mid-append-run → old tabs intact, new entries cancelled (concurrency/lifecycle) | default replace run still wipes results (existing Test #1/#2 green) |
| cursor-discipline (AH-001) | single-statement append run keeps cursor open; loadMore appends batch 2 | 2 batched statements in one run → stmt 1 cursor closed after initial fetch (close-spy), stmt 2 runs, `cursorClosed===true`, first batch kept (multi-stmt state) | loadMore on `cursorClosed` → rejects with `/run this statement alone/` before touching the dead cursor (error-message kind); last statement of a multi-run keeps its cursor (boundary) | "run() mới đóng batched cursor còn mở từ lần chạy trước" suite stays green (cross-run close preserved) |
| panel-state (AH-002) | runStatements threads `{append:true}` + renders with `appendBase` = pre-run length | append render keeps caches for indices < appendBase, invalidates only new ones (cache-scoping) | statement error in run 2 → old tabs intact in lastResults, error lands on the new tab (error state); loadMore rejection surfaces via showErrorMessage once + state repost | resultsPanelRequery suites green: requery-by-index lands on the right tab with the accumulated array |
| webview-tabs (AH-003) | growth state post → tab strip grows, first NEW tab active, labels `Run N · Statement M` for stamped entries | append post does NOT clear old tabs' DISTINCT caches; identity bump scoped to the new active tab (cache-stability) | stale `activeTab` on shrink → clamped to last (replace-run clamp preserved, boundary); Load More on `cursorClosed` tab → notice shown, rows unchanged (degraded path) | webviewEditHighlight / webviewRequeryAlignment / webviewUndoRedo stay green |

## §5 Verification

Per-task targeted (executor runs inside each task file):

```bash
npx vitest run src/core/__tests__/queryRunner.test.ts
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelRequery.test.ts src/extension.test.ts
npx vitest run tests/webviewMultiRunTabs.test.ts tests/webviewEditHighlight.test.ts tests/webviewRequeryAlignment.test.ts tests/webviewUndoRedo.test.ts
npm run typecheck
```

Wave/cycle boundaries (mandatory full net; webview tests need `dist/` built first):

```bash
npm run compile   # esbuild — also REQUIRED before tests/webviewMultiRunTabs.test.ts
npm test          # full suite green at every wave boundary
```

Manual smoke (review phase): connect Postgres → select 3 SELECTs in a .sql editor → Run: 3 result tabs, newest active → run 2 more: 5 tabs, run-1 tabs intact → Load More works on the last statement's tab; on an older batched tab shows the "run this statement alone" notice → Cancel mid-run 2: run-1 tabs intact.

**Lint/typecheck note**: `package.json` scripts are `compile`, `watch`, `test`, `test:integration`, `typecheck`, `package`, `vscode:prepublish`. There is NO lint script in this repo — `npm run typecheck` is the static gate and is mandatory in every task.

## §6 Acceptance

- [ ] All 3 tasks `approved`/`approved_minor` with executor self-report (tool/model + RED output) per Quality Gate. [AH-001/2/3]
- [ ] Bôi đen 3 câu → 3 tabs; run again → 6 tabs; newest tab active; old tabs' rows/labels intact. [AH-001+002+003]
- [ ] Multi-SELECT selection-run does not hang: stmt N+1 starts after stmt N's cursor is released (close-spy test green). [AH-001]
- [ ] Load More works for single-statement runs and the last statement of a run; degrades with the clear message elsewhere. [AH-001+002+003]
- [ ] Default (non-append) paths byte-identical semantics: browse/requery/saveEdits/single runs unregressed (full `npm test` green). [AH-001+002]
- [ ] Old tabs keep DISTINCT caches + column types across a later append. [AH-002+003]
- [ ] `npm run typecheck` exit 0; full `npm test` green at every wave boundary; `npm run compile` clean. [all]
- [ ] Cross-cycle locks respected: no diff in styles.css, `src/ai/**`, `src/adapters/**`, `src/core/ddl/**`, `src/core/sqlFormat.ts`, `src/ui/messages.ts`. [all]
- [ ] CHANGELOG entry (user-facing); version = next free minor at release step (1.12.0 unless AF/AG released first — releasing cycle wins). [release step]

## §7 Task split

| Task | Slice | Owns (files) | Wave | Depends on |
|---|---|---|---|---|
| TASK-AH-001 | Runner append mode + global indices + cursor discipline | src/core/queryRunner.ts + src/core/__tests__/queryRunner.test.ts (EXTEND) | 1 | none |
| TASK-AH-002 | Panel append-aware render + editor call-site flip | src/ui/resultsPanel.ts, src/extension.ts (runStatements body only) + src/ui/__tests__/resultsPanel.test.ts (EXTEND), src/ui/__tests__/resultsPanelRequery.test.ts (REGRESSION), src/extension.test.ts (EXTEND) | 2 | AH-001 |
| TASK-AH-003 | Webview accumulating tabs + labels + per-tab cache preservation | webview/main.ts + tests/webviewMultiRunTabs.test.ts (NEW), tests/webviewEditHighlight.test.ts / tests/webviewRequeryAlignment.test.ts / tests/webviewUndoRedo.test.ts (REGRESSION) | 3 | AH-002 |

Waves: W1 = AH-001; W2 = AH-002; W3 = AH-003 (prescribed chain). Note for the orchestrator: AH-003 consumes only AH-001's `StatementResult` fields and owns file-disjoint tests, so W2/W3 could legally widen to AH-002 ∥ AH-003 if parallel full-suite runs on the shared tree are acceptable; the prescribed chain is kept because AH-003's regression net (compile + full suite) benefits from the host flip already landed.

## Planner Report

PLANNER_MODEL: unic-smart

PLAN_REVIEW: Approved by unic-smart (Round 1, 2026-08-28; 2 minor test-pinning findings applied to TASK-AH-001 #9 and TASK-AH-003 #6a)

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit: (1) moved the new `StatementResult` fields (`runNo`/`runStmtNo`/`cursorClosed`) onto queryRunner.ts after discovering `src/adapters/types.ts` is AF-locked — plan originally risked implying a types.ts edit; (2) verified via tests-map.json that webview/main.ts has no mapped suite → AH-003 selection uses the path-convention branch (`tests/webview*.test.ts`) with named regression files; (3) resolved the Console-flows-through-runStatements ambiguity explicitly in §2 instead of leaving it to the executor.
Known gaps: (a) pre-existing race — loadMore in-flight while a new run() starts clears the in-flight chain (today's behavior, unchanged, not introduced by AH); (b) closing cursors early trades paging depth for run-throughput on multi-statement selection runs — the OFFSET-stateless alternative is deferred to ROADMAP by user decision; (c) AH-002's extension.ts edit shares the file with pending AF-004 — disjoint regions + wave ordering per RUN.md, recorded in TASK-AH-002 §Discussion.

## Plan Review Log

### Round 1 — Approved (reviewer model: unic-smart, 2026-08-28)
- minor: §4 cursor-discipline row — no unit test pins that a NEW run's cross-run cursor close stamps `cursorClosed` on the PREVIOUS run's entries. §3 promises "A new run (append or not) still closes previous runs' open cursors… Load More on them degrades with the same clear message", but planned tests only cover early-close within one run plus the pre-existing cross-run close. Fix: add one edge to AH-001's table — run1 (batched, cursor left open) → run2 → loadMore on run1's tab rejects with /run this statement alone/.
- minor: §3 webview append-detection depends on the asserted invariant "results array length NEVER grows across state posts except append runs", but no test pins it; a replace-mode post that grows the array (multi-statement replace run into a shorter accumulated array) would be misread as append and corrupt old-tab cache mapping. Per §2 caller analysis this looks unreachable post-flip (editor/console = append; browse/requery = single-statement), so pin the invariant with one webview test (replace post with old state present → append path NOT taken) instead of changing the design.
