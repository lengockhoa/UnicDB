Command: handoff-fullstack
Goal: Ship BQ-00 BigQuery provider feasibility + adapter contract spike (no real ADC).
Base: main @ df760ae (post-wave-1)
Phase: I3
Cursor: wave 1 done — TASK-BQ00-001 PASS (7/7 green, suite 3196|2, sonnet/unic-code, 4 files: package.json + lockfile + bigqueryPackage.test.ts + _bq00-evidence.md). Engine floor 9.x satisfied by Node 22.22.1; test #3 refined to PEM-block scan to avoid google-auth-library identifier false positives.
Next: wave 2 — 2 parallel feature-implementer agents on TASK-BQ00-002 (pure bigqueryTypes.ts + named toBigQueryPage export) and TASK-BQ00-003 (ADC classifier + client seam, vi.fn()-wrapped impl, redaction-by-construction). Disjoint target files; no shared symbol. Both depend on TASK-BQ00-001 evidence file.
