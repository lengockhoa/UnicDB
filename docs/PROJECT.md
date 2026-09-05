# UnicDB — Project Context

## Stack

- Runtime: Node v22.22.1 | OS: darwin | PM: npm
- Frontend: false | Backend API: false | PostgreSQL: false
- Provider: true

## Architecture

UnicDB is a **VS Code extension** (single `vscode` host process, no backend server) that turns
the editor into a database client for PostgreSQL / MySQL / MSSQL. Host side (`src/`) wires
commands (`src/extension.ts`), a schema tree (`src/ui/schemaTree.ts`), and singleton
WebviewPanels per surface (Results grid, Connection form, Table Designer, AI Chat, SQL
Console). Webview side (`webview/`) ships as separate esbuild bundles under `dist/`
(`webview.js`, `consolePanel.js`, …) loaded through strict-CSP HTML built by each panel.
Pure logic (SQL parsing, DDL diff/generation, paging, grid filter model) lives dependency-free
under `src/core/` + selected `src/ui/*Model|Messages` modules so vitest can cover it without
`vscode`. Distribution is a `.vsix` attached to GitHub Releases; users install via a curl
one-liner (see MEMORY → Active Constraints).

## Key Modules

- `src/extension.ts` — activation, command registration, shared exec path `runStatements` (danger-confirm → keyword qualify → runner.run → results render).
- `src/core/queryRunner.ts` — sequential statement execution over the driver adapter; cancel + batching.
- `src/core/ddl/` — pure CREATE/ALTER generation + pg introspection behind the Table Designer.
- `src/ui/resultsPanel.ts` + `webview/main.ts` — AG Grid results surface, set filters, edit/requery/export.
- `src/ui/keysetPaging.ts` — browse-shape gate + keyset OFFSET replacement (cycle Y).
- `src/ui/consolePanel.ts` + `webview/consolePanelMain.ts` — SQL Console scratchpad (cycle Z).

## Data Flow

Editor / Console SQL → `statementParser.sqlToRun` → `confirmDangerousStatements` modal →
`applyKeywordQualify` → `QueryRunner.run` → driver adapter (node-postgres/mysql2/mssql pool)
→ `resultBatcher` → `resultsPanel.render` → webview `state` postMessage → AG Grid. Grid
edits go back via save-cell messages → `saveStatements` builds batched UPDATEs → same run
pipeline. Metadata calls (tree, introspection, DISTINCT values) go straight through the
adapter on pooled clients.

## Business Rules & Domain Constraints

- Destructive statements (`DELETE` no WHERE, `TRUNCATE`, `DROP`, `UPDATE` no WHERE) MUST pass the red confirm modal before execution (`UnicDB.confirmDestructive` opt-out only).
- AI-chat `run_sql` tool is SELECT/SHOW/EXPLAIN/clean-CTE only — never receives DML/DDL.
- Keyset paging may replace OFFSET ONLY when the structural browse gate passes AND no term carries NULLS ordering; every other shape keeps legacy composition byte-identical.
- A user-visible change is NOT shipped until a GitHub Release exists (merged ≠ shipped); releaseHygiene fails builds when package-lock version drifts.

## Known Dangerous Areas

- `webview/main.ts` — largest file, DOM state regressions jsdom cannot catch (cycle G lesson); needs browser smoke for display bugs.
- `dangerousStatement.ts` — hand-rolled parser; any new prelude (CTE/EXPLAIN forms) requires a RED test first.
- Worktree copy-back during agent cycles — see BUG_INDEX 2026-08-27 entry (absolute paths, cd "$ROOT", commit before remove).
- Parallel fixers editing ONE working tree can interleave edits — orchestrate sequentially or re-run aggregate verification after convergence.

## Delivery Profile

- Primary workflow: natural-language AI tooling installed by UKit
- Shared adapters: Claude Code, OpenAI Codex, Antigravity
- Change policy: smallest correct change with clear verification

## Session Start Routine

1. Run `ukit memory recall "<current task>"` for non-trivial work; reuse relevant `## Previous Context` before asking the user to restate prior decisions
2. Read `docs/MEMORY.md` — architecture decisions, active constraints, known bugs
3. Read `docs/AI_HANDOFF/ACTIVE.md` when continuing cross-AI planning, task breakdown, or task implementation handoff work
4. Read `docs/CODE_MAP.md` if it exists — structural navigation index
5. Use the installed source-code index / routed helpers to localize the smallest relevant file + test set first
6. Scan recent `docs/WORKLOG.md` entries if continuing prior work
7. Verify understanding against source before acting — **docs orient, source is truth; keep the index-first workflow intact**
