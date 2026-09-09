Command: handoff-fullstack
Goal: Split results toolbar into exactly 2 rows — row 1 keeps icon buttons + tsv; row 2 holds WHERE/ORDER BY/run/clear/header/copy/export/chip/Search
Base: main @ 7e29d2e (v1.53.38)
Phase: R5
Cursor: Review approved with minor; stale P0 parent pin fixed in 183f6cc. Version metadata and changelog prepared for v1.53.39; package build produced UnicDB-1.53.39.vsix. Full npm test has documented unrelated carried failures; targeted toolbar/requery suites pass.
Constraints: USER OVERRIDE on version bump — patch v1.53.39 + publish at R5
Next: Commit release metadata and handoff records, rebuild the VSIX after changelog update, publish with VSCE_PAT from .secrets/.pat, then verify Marketplace publish result and close Phase done.
