# ROADMAP — Legacy Compatibility Index

The durable strategic roadmap is now [`PRODUCT_ROADMAP.md`](PRODUCT_ROADMAP.md). It retains the PostgreSQL-first database-IDE history and adds the AI/OMP product pillar, dependency waves, safety boundaries, and future DBX/AIX queue. [`PLAN_PRODUCT_VISION.md`](PLAN_PRODUCT_VISION.md) is the corresponding planning-only portfolio handoff.

## Historical map (preserved)

| Legacy cycle | Topic | Historical status |
|---|---|---|
| AF | Catalog + DDL + Console + Formatter | complete — released |
| AG | Import/Export + advanced grid | planned; its original AG2026 draft was rejected and removed |
| AH / AHL | Admin: users/roles/grants + sessions/locks | AHL is in flight; suffix avoids collision with shipped `PLAN_AH` / `INDEX_AH` results-panel history |
| AI | Schema/data diff + rename refactor | portfolio successor: DBX-03 and DBX-06 |
| AJ | ER diagrams + SSH tunnel + connection UX | portfolio successor: DBX-04 and DBX-05 |
| AK | MySQL/MSSQL parity + polish | portfolio successor: DBX-08, following PostgreSQL depth |

## Existing capabilities not to re-plan from zero

- AI chat, DB-aware tools, permission cards, and OMP engine (legacy AA/AD/AE).
- Data grid server-side sort/filter, keyset paging, inline edit, paste, undo/redo, and eight export formats.
- Connection manager (add/edit/test, SecretStorage, SSL), destructive-SQL confirmation, completion, and semantic tokens.

AHL remains the sole active handoff; see `PLAN_AHL.md`, `INDEX_AHL.md`, and `tasks/TASK-AHL-001..004.md`. This compatibility index creates no new active cycle or task.
