# ACTIVE

Cycle: W   Date: 2026-08-26   Base: main
Goal: Wire sort, distinct filter values and deterministic paging down to the server — real ORDER BY parsing, DISTINCT-value dropdowns, and gap-free Load More.
Tasks: 4 total
Status: review_done — 4/4 approved after 2 fix rounds (round 1 fixed all 4 tasks, round 2 fixed TASK-003 filter-refresh sequencing)
Reviewers: bao-opus (independent, differs from executor bao-sonnet)
Verification: compile clean · typecheck clean · 1494 passed / 2 skipped / 0 failed — 5 consecutive full-suite runs green after stabilizing webviewServerSort tests 5+18 (drain debounce posts; the resultsGridModelNull test-6 flake did not recur)
Note: full keyset paging, MySQL/MSSQL session-timezone literals, whitespace-only (Blanks), stripTrailingSemicolon hoist, MySQL getTableSortQuery twin — deferred to INDEX "Next cycles".
