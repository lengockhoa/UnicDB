Cycle: CLIPGRID   Date: 2026-09-10   Base: main @ d955873 (v1.53.42)
Goal: Results-grid clipboard — select cell/range/rows/column → Cmd/Ctrl+C copies the TSV matrix; Cmd/Ctrl+V pastes it (Excel tab/newline paste lands as edits); Save / Cmd/Ctrl+Enter persists
Tasks: 4 total planned
  - TASK-CLIP-001 (tests-only): pin copy matrix shapes at bundle + pure level (1×1, N×M, row checkboxes, column strip, hidden-col exclusion, no-selection guard)
  - TASK-CLIP-002 (tests-only): pin paste semantics (focused anchor, range tiling/clipping, CRLF + trailing newline, empty/filter-input/bottom-edge/local-row edges)
  - TASK-CLIP-003 (webview): Cmd/Ctrl+V keydown wiring via readClipboard/clipboardText host round-trip + fix the never-read suppressNextCellClickClear stale-range defect + debugClipboard seam
  - TASK-CLIP-004 (tests-only): pin save persistence — paste → Cmd/Ctrl+Enter = one saveEdits batch; ok clears highlights; refused shows banner
Status: planning_done — ready for executor
  - Prior cycle RES2ROW archived at INDEX_RES2ROW.md / ACTIVE_RES2ROW.md / PLAN_RES2ROW.md
  - Pipeline largely exists (TASK-501/502/RANGE-001/503): copySelectionToHost (webview/main.ts:4031), onGridPaste (:3300), parseTsvPaste/applyPasteToDirty/applyRangePasteToDirty (resultsGridModel.ts:1226/1261/1387), onCommitClick (:3782), host copy write (resultsPanel.ts:1033)
  - Real gaps this cycle: (1) no Cmd/Ctrl+V keydown path — new readClipboard/clipboardText round-trip; (2) suppressNextCellClickClear (main.ts:479,1260) is written but never read → stale rectangle misdirects next paste
  - Constraints: no new npm deps; only 2 additive message discriminators; one capture listener per chord (A16 rule); isFilterInput guard on every entry; npm run compile before any bundle test
