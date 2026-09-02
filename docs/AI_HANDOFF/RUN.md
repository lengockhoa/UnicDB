Command: handoff-fullstack
Goal: Ship BQ-00 BigQuery provider feasibility + adapter contract spike (no real ADC).
Base: main @ 91737ce (plan commit)
Phase: I1
Cursor: P1 (lite sweep) → P2 (planner, opus) → P2.5 round 1 (reviewer found 2 important + 2 minor) → P2 revise (planner applied all 4) → P2.5 round 2 (reviewer approved, 0 findings) → P3 commit (91737ce) all complete. Plan is locked. 4 tasks ready: BQ-00.1 → (BQ-00.2 ∥ BQ-00.3) → BQ-00.4. Read-only list locked: src/adapters/{factory,mssql,mysql,postgres,types}.ts, src/core/queryRunner.ts, src/ui/resultsPanel.ts, src/extension.ts, esbuild.js, vitest.config.ts, vitest.integration.config.ts.
Next: I1 — verify clean tree, confirm handoff.maxParallelAgents from .ukit/storage/config.json, then I2 (infer wave groups) → I3 (worktree + per-task feature-implementer in parallel up to maxParallelAgents).
