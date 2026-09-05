# PLAN_AI — Cycle AI: Results panel opens below the editor (v1.11.2)

## §1 Intent

User (verbatim): "Với lại tôi có cảm giác là khi chạy ra kết quả của query, nó lại hiển thị ở bên phải. Có thể nào đưa xuống dưới cho tôi được không? Khi chạy ra kết quả, tôi muốn cái tab được chia làm hai nhưng là chia xuống dưới, chứ không phải chia qua bên phải như hiện tại."

Answers from the one asking window:

1. Placement: "Mặc định Below (Recommended)" — default result placement is below the active editor, with a setting for users who prefer beside.
2. Reveal behavior: "Tôn trọng chỗ user đặt (Recommended)" — once the user drags an already-open results panel, later query runs must retain that location; never force it back to the setting.

**Success definition**: running a query creates UnicDB Results below the editor (vertical editor split), not beside it. A user may set placement to `beside`; a user-dragged existing panel stays where it was moved when later queries render results. Setting changes apply to the next newly-created panel only.

## §2 Scope

**In scope (one task):**

- Add `UnicDB.resultsPlacement` configuration (`"below" | "beside"`, default `"below"`) in package.json.
- Read that setting where the single `ResultsPanel` is constructed in `src/extension.ts`, passing `vscode.ViewColumn.Below` (default) or `Beside`.
- Change `ResultsPanel`'s internal default from `ViewColumn.Beside` to `ViewColumn.Below`.
- Change `show()` for an already-created panel from `panel.reveal(this.viewColumn)` to `panel.reveal()` with no column argument, preserving the user’s current editor group.
- Unit coverage for default, beside setting, existing-panel reveal, and new-panel-only setting semantics.

**Out of scope:** SQL Console placement (`consolePanel.ts` stays unchanged); vertical/horizontal layout inside the Results webview; QueryRunner or accumulated-tabs work (cycle AH); AG composer CSS; AF catalog/DDL/Console work; live re-placement after a setting change; any webview/main.ts change.

**Hard constraints:** one task / one wave. `src/ui/resultsPanel.ts` is also targeted by TASK-AH-002. Do not execute AI-001 concurrently with AH-002; AI can execute after AH-002 merges, or executor must re-read and safely rebase the small placement-only hunks. No other same-wave file overlap is possible.

## §3 Approach

1. **Initial placement is configuration-driven**: declare `UnicDB.resultsPlacement` as enum `below|beside`, default `below`. At `src/extension.ts` construction site, translate it into `ViewColumn.Below` or `ViewColumn.Beside` and pass it to `new ResultsPanel(...)`. The `ResultsPanel` default itself also changes to `Below` as a defensive direct-construction default.
2. **Reveal preserves user choice**: `viewColumn` is only an initial creation hint. `show()` calls `this.panel.reveal()` without a view-column argument when `this.panel` already exists. VS Code preserves the existing webview editor group, including a position manually dragged by the user.
3. **No live setting migration**: changing `UnicDB.resultsPlacement` affects the next panel creation (after closing Results), not a live panel. This respects the explicit user-drag decision and avoids surprise editor moves.
4. **Test using the existing VS Code mock**: add `Below` to its `ViewColumn` fixture and record arguments passed to `createWebviewPanel` / `reveal`. Existing panel tests prove the precise no-argument reveal contract.
5. **Versioning**: patch `v1.11.1 → v1.11.2` if free at release; releasing cycle wins if another patch ships first.

**Alternatives rejected:** always calling `reveal(configuredColumn)` would keep dragging a user’s panel back; a setting without a `below` default fails the requested default; a webview-internal split does not move the VS Code editor panel and solves the wrong layout problem.

## §4 Test Plan (TDD)

| Area | Happy path | Edge 1 (configuration) | Edge 2 (user state) | Regression |
|---|---|---|---|---|
| Initial placement | no explicit option/config → ResultsPanel calls `createWebviewPanel(..., ViewColumn.Below, ...)` | `resultsPlacement="beside"` → construction passes `ViewColumn.Beside` | invalid/missing config falls back to `below`, never throws | existing ResultsPanel construction/render suite stays green |
| Existing panel reveal | initial panel below, render second query → `reveal()` receives no view-column argument | user-drag simulation: existing panel’s recorded group differs from configured initial column; later render does not pass/coerce any column | setting changes while panel exists → second render preserves existing panel; closing/recreating uses new setting | existing busy/render/dispose behavior remains green |
| Manifest setting | package manifest has enum `["below","beside"]`, default `"below"`, human-readable description | `beside` remains selectable | malformed workspace value remains handled at runtime by fallback | manifest/package compile stays green |

## §5 Verification

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npm test
npm run compile
```

Manual smoke: open a SQL editor → run query → Results opens BELOW editor; close Results → set `UnicDB.resultsPlacement` to `beside` → run query → Results opens beside; drag Results to another editor group → run another query → it remains in the dragged group.

## §6 Acceptance

- [ ] TASK-AI-001 TDD cases pass (RED output and GREEN evidence recorded by executor).
- [ ] Default new Results panel uses `vscode.ViewColumn.Below`.
- [ ] `UnicDB.resultsPlacement` supports only `below` and `beside`, defaults to `below`.
- [ ] Existing Results panel is revealed without a view-column argument, retaining user placement.
- [ ] Placement setting applies to next panel creation only; never moves a live panel.
- [ ] SQL Console / webview layout / query execution paths unchanged.
- [ ] `npm run typecheck`, full `npm test`, and `npm run compile` pass.
- [ ] CHANGELOG entry and next-free patch version at release.

## §7 Task split

| Task | Slice | Owns (files) | Wave | Depends on |
|---|---|---|---|---|
| TASK-AI-001 | Configurable below/beside initial placement + preserve existing panel group | src/ui/resultsPanel.ts, src/extension.ts, package.json, src/ui/__tests__/resultsPanel.test.ts | 1 | none; coordinate with AH-002 before touching resultsPanel.ts |

Waves: W1 = AI-001 (single).

## Planner Report

PLANNER_MODEL: unic-smart

PLAN_REVIEW: Approved by unic-smart (Round 1, 2026-08-28; 2 minor findings applied to TASK-AI-001 — manifest enum assertion + explicit disjoint regions)

DEVIATION NOTE: contracted `handoff-planner` agent returned malformed/empty HTTP 200 after 0 output and wrote zero files. This plan was authored inline by the session strong tier (unic-smart) after source-grounding `ResultsPanel` options/default/show(), the sole extension construction site, manifest configuration, and test ViewColumn mock.

## Plan Review Log

### Round 1 — 2026-08-28 · Approved (reviewer model: unic-smart)
- minor: §4 "Manifest setting" row Edge 1 ("beside remains selectable") is a near-duplicate of the happy-path enum assertion; per plan rules two near-identical cases do not count as different kinds, leaving the malformed-workspace-value fallback (Edge 2) as the only genuinely distinct kind in that row. In the derived task file, either strengthen Edge 1 (e.g., assert the enum declaration and description strings in package.json) or fold manifest Edge 1 into the happy path — the behavioral rows (placement, reveal) already carry configuration + invalid-input + user-state + lifecycle kinds.
- minor: §2 hard constraint resolves the resultsPanel.ts overlap with TASK-AH-002 via sequential dispatch ("do not execute AI-001 concurrently with AH-002; after merge or re-read/rebase") and "placement-only hunks", but never names the disjoint regions. In the derived task file, state explicitly that AI-001 touches only the constructor-options site in src/extension.ts plus the ResultsPanel default and the show() reveal call, while AH-002 owns accumulated-tabs/QueryRunner regions, so the rebase fallback is unambiguous for the executor.
