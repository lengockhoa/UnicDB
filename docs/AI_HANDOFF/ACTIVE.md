# ACTIVE

Cycle: W   Date: 2026-08-26   Base: main
Goal: Wire sort, distinct filter values and deterministic paging down to the server — real ORDER BY parsing, DISTINCT-value dropdowns, and gap-free Load More.
Tasks: 4 total
Status: planning_done — ready for executor
Planner: bao-opus (plan review round 1 → Issues Found → revised 2026-08-26; see PLAN.md
"Planner Revision — Round 1 findings applied")
Notes: Round-1 revision changed four things executors must not re-derive from memory:
(1) `PLAN.md` §7's requery back-compat is BEHAVIOURAL, not SQL-text identity — the single-term
sort path keeps `composeSortQuery`/`vsdb_sort` quoting from cycle V; (2) the ORDER BY identifier
charset is bare `[A-Za-z_][A-Za-z0-9_$]*` OR already-quoted, and TASK-003 must quote a non-bare
`colId` before sending; (3) the multi-term ORDER BY wrapper is pinned to alias `vsdb_sub` with no
LIMIT/OFFSET; (4) `(Blanks)` opt-in is `columnTypes` from declared types (`SaveContext.
listColumnTypes`), not row-value sniffing. NULLS emulation is cut; DISTINCT is base-statement
scoped (`where = ""`) as an accepted limitation. TASK-004 now also touches `src/extension.ts`
(~8 lines) — still no file shared between tasks.
`webview/main.ts` is owned solely by TASK-003. Run `npm run compile` before any
`webview*.test.ts`. Webview tsc gate is a per-file COUNT snapshot diff (baseline: main.ts 14,
connectionFormMain 10, aiSettingsFormMain 10, schemaFormMain 5, newTableFormMain 1), not a
zero-error check. Full-suite baseline 1400 passed / 2 skipped / 0 failed, plus the known
`resultsGridModelNull.test.ts` test-6 flake.
