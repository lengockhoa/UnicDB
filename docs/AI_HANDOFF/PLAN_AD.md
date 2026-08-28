# PLAN_AD — Cycle AD: DB-aware AI Chat + OMP config injection (v1.10.0)

## §Goal

Make the AI Chat panel (VSDB's `src/ui/aiChatPanel.ts`) a real chat-extension for database work, and bridge it to the user's local `omp` install when they want OMP as the runtime.

Two layers, both must ship:

1. **DB-aware tools** (always available, builtin engine + omp engine): the model can actually *look* at the connected database, not just stare at DDL.
2. **OMP config injection** (opt-in): a button/command writes `vsdb.ai.*` into `.vscode/vsdb-ai-config.yml` so `omp --config .vscode/vsdb-ai-config.yml` connects to the same provider the panel uses. OMP keeps its own session/loop; VSDB keeps the chat UX.

## §Constraints

- Repo `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB`, base `main @ 5a9bb1d` (cycle AB release v1.9.0).
- DB-aware tools follow the existing ACP permission-bridge pattern (Allow/Deny cards + default-deny on every abnormal exit). Row access is opt-in per turn.
- Privacy invariant (cycle AA): `buildMessages` system prompt is DDL-only; row bytes flow only via explicit tool calls the user approved this turn.
- OMP integration is a **config-injection** layer — no OMP child_process wiring in this cycle. The user can copy/paste the suggested `omp` invocation into a terminal or wire it into a `tasks.json` shell task.
- TDD mandatory; RED first against current code, GREEN after.

## §Approach

### DB-aware tools (cycle AD core)

Reuse the existing tool registry pattern (`src/ai/tools/registry.ts`) plus the permission-bridge pattern from `src/ui/aiChatPanel.ts` (case "permission_response" + handlePermissionResponse).

New tools, all read-only, all gated by ACP permission cards (Allow/Deny):

| Tool name | Args | Behavior | Risk surface |
|---|---|---|---|
| `list_table_data_sample` | `{schema, table, limit?}` (default 20, cap 100) | SELECT first N rows | row data leak |
| `count_rows` | `{schema, table, where?}` | SELECT COUNT(*) with optional WHERE | row count leak |
| `run_readonly_query` | `{sql, maxRows?}` | Parse SQL, reject any non-SELECT/DML/DDL token (parser), cap rows | row data leak, parser bypass |
| `explain_query` | `{sql}` | Run EXPLAIN on read-only query | query plan leak |
| `get_table_relationships` | `{schema, table}` | FK introspection + referenced-tables | schema leak (already public) |

Parser guard for `run_readonly_query`: accept only statements whose first token is `SELECT`/`WITH`; reject everything else with a structured error. Reject semicolons (single statement only). Reject `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/`REVOKE`/`COPY` even as substrings of identifiers (defense in depth).

### OMP config bridge

When the user clicks "Use with OMP" (or runs `vsdb.ai.useWithOmp`):

1. Read current `vscode.workspace.getConfiguration('vsdb.ai')` + SecretStorage for the apiKey.
2. Write `.vscode/vsdb-ai-config.yml` next to `.vscode/settings.json` in YAML form that OMP understands (overlay format — keys that OMP merges over `~/.omp/config.yml`).
3. Post a notification with the exact `omp --config <path> -p "..." --append-system-prompt <contextPath>` line the user can run.

OMP-specific YAML keys to emit (verified against `omp --help` flags):

- `provider`: matches `--provider`. For OpenAI-compatible: emit env-var-friendly keys so `omp` reuses the user's existing `OPENAI_API_KEY`/`OPENAI_BASE_URL`.
- `model`: defaults map (work → user-set work model, smart → user-set smart model).
- `appendSystemPrompt.file`: `.vscode/vsdb-db-context.md` — generated on-demand when the user opens the command; contains the schema DDL the same way `buildMessages` already produces it (DRY: extract a single `formatSystemPrompt` helper from `src/ui/aiChatPanel.ts:186-325` and call from both).

This is a *config injection* layer — no OMP child_process wiring in this cycle. The user can copy/paste the suggested `omp` invocation into a terminal or wire it into a `tasks.json` shell task.

## §Files (expected)

- `src/ai/tools/readonlySqlParser.ts` — pure, unit-tested. Single export `parseReadonly(sql: string): {ok:true, kind:'select'|'with'} | {ok:false, reason}`.
- `src/ai/tools/sqlTool.ts` — extends existing `createSqlTool` with the **readonly** SQL guard (parser) + new `list_table_data_sample`, `count_rows`, `run_readonly_query`, `explain_query`, `get_table_relationships` tool definitions.
- `src/ui/aiChatPanel.ts` — extract `formatSystemPrompt` helper from current buildMessages (DRY for OMP exporter); extend `handleMessage` switch with new permission_request kind for the DB-aware tools (mirrors existing permission_request pipeline).
- `src/extensionConfigExport.ts` — **new** module (only `vscode` import; everything else pure). Reads `vscode.workspace.getConfiguration('vsdb.ai')`, writes the YAML + DB-context markdown. Returns a `{configPath, contextPath, ompCommandLine}` triple.
- `src/extension.ts` — register `vsdb.ai.useWithOmp` command + `vsdb.ai.refreshDbContext` (re-emit the context file).
- `webview/aiChatPanelMain.ts` — permission_request rendering already exists for ACP; the new DB tools reuse the same card shape (no new code).
- New tests:
  - `src/ai/tools/__tests__/readonlySqlParser.test.ts`
  - `src/ai/tools/__tests__/dbAwareTools.test.ts` (covers all 5 tools + parser guard)
  - `src/ui/__tests__/aiChatPanelDbAware.test.ts` (host integration, permission gate, buildMessages still DDL-only even with tools in the loop)
  - `src/__tests__/extensionConfigExport.test.ts` (YAML emission, apiKey absent on disk, formatSystemPrompt equality)

## §Acceptance criteria

0. **Privacy**: a cycle-AA-style sentinel-seeded adapter test still passes with the new tools in the registry — `runQuery` is 0 outside tool calls, no sentinel strings in system prompt.
1. `parseReadonly` accepts `SELECT … FROM …`, `WITH x AS (…) SELECT …`. Rejects `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/`REVOKE`/`COPY`/`MERGE`/`CALL`/`EXEC` even when they appear as substrings (case-insensitive after the leading keyword).
2. `list_table_data_sample` returns at most `limit` rows (default 20, hard cap 100). Header row included. Driver returns text. No exception path leaves the row data un-redacted in logs.
3. `count_rows` returns the COUNT with the optional WHERE; caps result at one number.
4. `run_readonly_query` rejects any non-SELECT/WITH statement via `parseReadonly` BEFORE touching the adapter. Multi-statement SQL (semicolon-separated) is rejected.
5. `explain_query` runs EXPLAIN; result rendered as text. EXPLAIN ANALYZE is rejected (no live execution of arbitrary SQL under the EXPLAIN alias).
6. `get_table_relationships` reads FK metadata + reverse-FK (which tables reference this one). No row data.
7. Each tool posts a permission_request card on first invocation per turn. Default-deny. User can Allow Once / Allow Session / Deny.
8. `formatSystemPrompt` is the **only** function building the system prompt content; both `buildMessages` (cycle-AA path) and `extensionConfigExport` (OMP config path) call it. Same byte output for same input. Test pins equality.
9. `vsdb.ai.useWithOmp` writes `.vscode/vsdb-ai-config.yml` + `.vscode/vsdb-db-context.md`. API key never written to disk (env var hint only).
10. The command's `ompCommandLine` output is copy-pasteable into a terminal and runs without further setup (`omp --config <path> -p "..." --append-system-prompt <contextPath>`).
11. Cycle-AA regression pins stay green: `aiChatPanelPrivacy.test.ts`, `aiChatPanelAttachments.test.ts`, `aiChatPanelWebview.test.ts`, `aiChatPanelThoughtRegen.test.ts`.
12. The new permission_request bubbles render in the chat thread with the same `.vsdb-chat-permission` card style; on Deny the tool bubbles the rejection reason to the model verbatim.

## §Test plan

| Layer | Cases | Tool |
|---|---|---|
| Parser RED | accept: SELECT, WITH, lowercase/uppercase; reject: INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/COPY/MERGE/CALL/EXEC, semicolon-stacked, identifiers containing FORBIDDEN tokens | T2 |
| Tools RED | list_table_data_sample limit/cap; count_rows with/without WHERE; run_readonly_query happy + parser reject; explain_query; get_table_relationships | T2 |
| Host integration | tool posts permission_request card; Allow once → tool runs → result posted; Deny → tool bubbles "denied by user"; buildMessages still DDL-only with tools in registry | T1 |
| OMP config bridge | writes YAML + context; configPath + contextPath resolve; apiKey never written; formatSystemPrompt equality between host and exporter | T3 |
| Cycle-AA regressions | privacy sentinel + 2 attachments, attachments host test #0b mention×attachment, mention block, keybind, webview legacy | T1 |

## §Out of scope

- Full OMP child_process session wiring (next cycle if user wants).
- Slash commands from cycle AC queue (`/clear`, `/resume`, `/engine`, `/context`, `/export`, `/model`).
- Cycle S grid Excel overhaul.
- ACP session resume for OMP mode.

## §Wave plan

- **Wave 1** (2 parallel, file-disjoint):
  - T1 readonly SQL parser + DB-aware tools (host side) + host permission gate + tests
  - T3 OMP config exporter + VS Code command + formatSystemPrompt extraction
- **Wave 2** (1):
  - T2 webview permission card (uses existing card style — minimal touch)

## §Verification

- `npx vitest run src/ai/tools/__tests__/ src/ui/__tests__/ src/__tests__/extensionConfigExport.test.ts`
- `npm run typecheck`
- `npm test` — full suite green
- `bash scripts/build.sh` — vsix artifact, 18 entries, 0 forbidden, 0 markers
- Smoke: open VS Code, set `vsdb.ai.*` config, run `vsdb.ai.useWithOmp`, paste the printed `omp` line into a terminal, confirm the model returns a response that references the connected DB schema.

## §Versioning

Minor bump `v1.9.0 → v1.10.0` per `docs/RELEASE.md` minor policy (new user-visible surface: OMP bridge command + 5 new DB tools).