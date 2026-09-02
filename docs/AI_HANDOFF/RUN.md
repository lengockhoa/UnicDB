Command: handoff-fullstack
Goal: Ship BQ-00 BigQuery provider feasibility + adapter contract spike (no real ADC).
Base: main @ 89d6b56 (post-wave-3)
Phase: R1
Cursor: All 3 waves implemented + committed (89d6b56). Suite 3209 passed | 2 skipped (floor 3189|2 preserved). Files: package.json + lockfile + 3 new src/adapters/{bigqueryTypes,bigqueryAdc}.ts + 3 new tests + docs/decisions/{_bq00-evidence.md, 0004-...md, README.md update}. No read-only file touched. 4 of 4 tasks PASS.
Next: I4 (consolidate INDEX to pending_review) → R1 verify clean → R2-R4 review (4 parallel code-reviewers, opus/unic-smart, MUST differ from executor sonnet/unic-code) → R4.5 auto-fix if needed → R5 (commit + push + version bump + vsce + gh release for v1.46.0).
