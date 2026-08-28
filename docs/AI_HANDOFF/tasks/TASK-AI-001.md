# TASK-AI-001 — Configurable below/beside initial placement + preserve existing panel group

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AI.md` §7 (Approach §3)

## Goal

Open query results in a vertical split below the active editor by default (`vscode.ViewColumn.Below`), expose `vsdb.resultsPlacement` (`below` | `beside`) for side-by-side users, and stop forcing an already-open panel back to its configured column on later runs — `reveal()` must preserve whatever group the user placed the panel in.

## Target Files

- `package.json` — contributes.configuration: add `vsdb.resultsPlacement` (enum `["below","beside"]`, default `"below"`, description: placement of the VSDB Results panel for new runs).
- `src/extension.ts` — the single ResultsPanel construction (~:146 `new ResultsPanel({ runner, saveContext })`): read `vscode.workspace.getConfiguration("vsdb").get<"below"|"beside">("resultsPlacement", "below")` and pass `viewColumn: placement === "beside" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Below`. Touch ONLY this construction region — runStatements body belongs to AH-002.
- `src/ui/resultsPanel.ts` — :172 default flips `?? vscode.ViewColumn.Beside` → `?? vscode.ViewColumn.Below`; :181 show()-existing-panel branch: `this.panel.reveal(this.viewColumn)` → `this.panel.reveal()` (no column arg → preserves current group). ViewColumn stays the CREATE-only hint. Touch ONLY options/default/show placement lines — render/handleMessage belong to AH-002.
- `src/ui/__tests__/resultsPanel.test.ts` — mock `ViewColumn` (:49) gains `Below: 6`; record `createWebviewPanel`/`reveal` args on the panel fake (:27); add the new cases below.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | default creation uses ViewColumn.Below | `new ResultsPanel({ runner })` → show() → createWebviewPanel called with viewColumn === ViewColumn.Below (6) | no options passed, mock config returns undefined |
| 2 | unit | explicit `beside` option honored | `new ResultsPanel({ runner, viewColumn: ViewColumn.Beside })` → createWebviewPanel viewColumn === Beside | explicit option |
| 3 | edge | extension construction maps setting → column | config `resultsPlacement="beside"` → construction passes Beside; config absent/malformed (e.g. `"diagonal"`) → falls back to Below, no throw | stubbed workspace.getConfiguration returning each case |
| 3a | unit (manifest) | package.json declares the setting correctly | contributes.configuration contains `vsdb.resultsPlacement` with enum exactly `["below","beside"]`, default `"below"`, non-empty description string | package.json read as JSON in test |
| 4 | edge | existing panel reveal preserves placement | create panel (any column), then second show()/render → `reveal` called with NO view-column argument (arg count 0 or undefined), panel object reused, createWebviewPanel NOT called again | panel already created |
| 5 | edge | setting change does not move a live panel | change stubbed config after creation; render again → still no column coercion (no-arg reveal); only after dispose+recreate does the new setting apply | live panel + changed config |
| 6 | regression | existing ResultsPanel suite green | all current tests in resultsPanel.test.ts pass with the new Below default (any test asserting Beside default is updated to Below as part of this task, noted in the diff) | current suite at HEAD |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — tests 1–6 + 3a (EXTEND existing file; mock + arg-recording additions).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npm test
npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for new cases, GREEN after; RED output in Executor Report).
- [ ] New Results panels default to `ViewColumn.Below`; `vsdb.resultsPlacement:"beside"` opts into side-by-side.
- [ ] Later runs never coerce an existing panel's group (no-arg `reveal()`).
- [ ] Setting applies only at next panel creation.
- [ ] package.json manifest valid (`npm run compile` + extension packaging clean); CHANGELOG entry; next-free patch at release.
- [ ] No diff beyond the 4 target files; in particular no consolePanel.ts, no webview files, no runStatements/handleMessage hunks.

## Dependencies

- (none) — but SEE Discussion: same-file coordination with TASK-AH-002 (src/ui/resultsPanel.ts, disjoint regions).

## Interfaces

- Consumes: `vscode.ViewColumn.Below` (VS Code API, value 6); `ResultsPanelOptions.viewColumn?: vscode.ViewColumn` (existing, unchanged shape).
- Produces: setting contract `vsdb.resultsPlacement: "below" | "beside"` (default `"below"`) — consumed by extension.ts construction; behavior contract "reveal() preserves user placement" relied on by all future panel-placement features (console panel may adopt the same pattern later).

---

## Discussion

### 2026-08-28 · planner · unic-smart
-> @executor + @reviewer: src/ui/resultsPanel.ts is shared with TASK-AH-002 (cycle AH, staged ready). Regions are disjoint and this is the authoritative split: **AI-001 owns ONLY** (a) the `ResultsPanelOptions` interface / default-assignment line (~:172 `?? ViewColumn.Beside` → Below), (b) the show() existing-panel reveal call (~:181 `reveal(this.viewColumn)` → `reveal()`), (c) the extension.ts ResultsPanel construction site (~:146), (d) package.json configuration + (e) the test file. **AH-002 owns** render/handleMessage/append-state logic + its own extension.ts runStatements body hunk. If AI-001 executes after AH-002 has landed, re-read the current file first and anchor edits on current content (Safe Patch protocol), not on the line numbers above. Never run AI-001 and AH-002 in parallel on the same base.

### 2026-08-28 · planner · unic-smart
Test #6 note: if any existing test asserts the Beside default, updating that expectation to Below is in-scope for this task (it is the deliberate behavior change); flag every such update in the Executor Report so the reviewer can distinguish intended change from accidental drift.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
