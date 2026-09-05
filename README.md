# UnicDB — Run SQL from VS Code

A compact VS Code extension to run SQL queries directly from the editor, without
jumping to an external client. Supports **PostgreSQL**, **MySQL / MariaDB**, and
**SQL Server**.

![screenshot](media/icon.png)

> Open a `.sql` file → select a connection → highlight a statement →
> **Cmd+Enter** (macOS) or **Ctrl+Enter** (Windows / Linux) → see the result
> right in the panel.

---

## Installation

**One single command** (fresh install and update alike — VS Code only needs to
have been opened at least once):

```bash
curl -fsSL https://raw.githubusercontent.com/lengockhoa/UnicDB/main/scripts/install-UnicDB.sh | bash
```

The script will automatically:

1. Find the `code` CLI on `PATH` (fallback: `/Applications/Visual Studio Code.app/.../bin/code` on macOS).
2. Download the latest `.vsix` from the GitHub Releases of the `lengockhoa/UnicDB` repo.
3. Call `code --install-extension <vsix> --force`.
4. Print the installed version. **Idempotent** — running again = update.

When a new version comes out, the team just runs the same command above and it
self-updates.

### Manual install via `.vsix` file (offline / no GitHub access)

Download `UnicDB-<version>.vsix` from [Releases](https://github.com/lengockhoa/UnicDB/releases)
(or grab the file the maintainer built with `scripts/build.sh`), then:

```bash
bash scripts/install-UnicDB.sh --local /path/to/UnicDB-<version>.vsix
# or install directly via VS Code CLI:
code --install-extension UnicDB-<version>.vsix
```

---

## Quick start

| Step | Action |
| ---- | -------- |
| 1    | Open VS Code, open the **UnicDB** panel in the activity bar (icon on the left). |
| 2    | Click the `+` icon at the top corner of the panel → **UnicDB: Add Connection** → fill in host/port/user/password → pick the driver (postgres / mysql / mssql) → save. |
| 3    | Open a `.sql` file, select the connection to use (click the connection name in the status bar or run `UnicDB: Select Active Connection` in the Command Palette). |
| 4    | Place the cursor / highlight a SQL statement → press **Cmd+Enter** (macOS) / **Ctrl+Enter** (Win/Linux). |
| 5    | Results appear in the **UnicDB Results** panel just below the editor. |

### Other ways to run a query

- **▶ button on the editor** (title bar): runs the query currently focused.
- **CodeLens ▶ Run** right above each statement in a `.sql` file (toggle via setting `UnicDB.showRunLens`).
- **Schema Explorer**: click a table/view → right-click menu → **Generate SELECT** to insert a `SELECT * FROM ...` statement into the editor.
- **Cancel query**: ■ button on the title bar, or `UnicDB: Cancel Query` in the palette.
- **Atomic multi-statement batch** (when the extension sends **one multi-statement string as a batch** — e.g. saving many cells, generating sample data, helper tables):
  - **DML (`INSERT` / `UPDATE` / `DELETE`...)** runs inside **a single transaction** — if any statement fails, the entire batch is rolled back and nothing is half-committed (PostgreSQL already behaves this way; MySQL is now guaranteed as well from this release).
  - **MySQL note**: **DDL** statements (`CREATE` / `ALTER` / `DROP`...) trigger an **implicit commit** inside MySQL — the portion before the DDL still commits and the DDL itself cannot be rolled back, so batches containing DDL are **NOT** guaranteed all-or-nothing.
- **Editor Run** (Cmd/Ctrl+Enter on a selection, or the whole file via the ▶ button) runs **each statement individually**: every statement is its own independent `runQuery`, not wrapped in a shared transaction — earlier statements remain committed if a later one fails.
- **A single `SELECT` statement** still runs through a streaming cursor as before (no transaction wrapping — avoids holding the pool's only connection).

### Keyboard shortcuts

| Key | Command |
| ---- | ---- |
| `Cmd+Enter` (macOS) / `Ctrl+Enter` (Win/Linux) | Run the selected statement |
| When `editorTextFocus && resourceLangId == sql` | (only triggers inside `.sql` files) |

---

## Documentation

Full user guide (Vietnamese): [`docs/UnicDB_USER_GUIDE.md`](docs/UnicDB_USER_GUIDE.md). Covers connection setup, schema explorer, console, AI chat, settings, SQL Generator, Sample Data, and every shipped feature. You can also open it from VS Code via the 📖 (notebook) icon on the **Schema Explorer** title bar → **UnicDB: Open User Guide**.

---

## Key features

- **3 drivers**: PostgreSQL (pg), MySQL/MariaDB (mysql2), SQL Server (tedious).
- **Schema Explorer tree**: connection → schema → Tables / Views / Routines (with counts) → table / view / column / routine.
  - Shows **every schema** you can access, not only the default schema (`public` / `dbo` / the connected database).
  - Setting `UnicDB.hideSystemSchemas` (default `true`): hide system schemas (`pg_catalog`, `information_schema`, `mysql`, `sys`...); turn it off if you want to see them.
  - Right-click a table/view → `Generate SELECT`, `Copy Qualified Name` (uses the correct `schema.table`, even for non-default schemas).
  - **Row count badge**: each table shows an estimated row count (from planner statistics — fast, no scan of large tables; unanalyzed tables show the schema name instead).
  - **Tree filter**: filter button on the **UnicDB** panel title bar → type to filter schemas/tables/views/routines/columns by name (case-insensitive); ✕ button appears while filtering to clear it.
- **Refresh metadata**: the refresh button on the **UnicDB** panel title bar (runs `UnicDB: Refresh Schema`) reloads the schema cache from the server — use after you create/delete a table outside VS Code and don't want to make a new connection.

- **Results grid (AG Grid Community)**: view results in the **UnicDB Results** panel — theme follows VS Code (dark/light); sort; **Excel-style set filter per column** (open a column's filter menu → distinct-value checkbox list with quick search above, `(Select All)` / `(Blanks)` helpers; large datasets render through AG Grid Set Filter native) + quick search; multi-row selection + copy (Ctrl+C); row count in the footer.
- **Grid edit mode (1.4.0)**: edit cells directly in the grid, **paste from Excel (TSV)** into the selection (auto-trim excess cells), Add/Delete Row, Undo, toggle CSV raw view; **Cmd/Ctrl+Enter commits once** (batch) — UPDATE by PK (PostgreSQL falls back to `ctid` with a warning when no PK; MySQL/MSSQL refuse without PK + banner), SQL errors surface as a banner and keep the edit for retry.
- **Export toolbar (1.4.0)**: TSV / CSV / XML / JSON / SQL Inserts / SQL Insert Multirow / SQL Updates / Where Clause — SQL mode follows the dialect; **Header checkbox** (TSV/CSV/XML/JSON); **To Clipboard** or **Export to file**.
- **WHERE/ORDER BY bar (1.4.0)**: set a WHERE / ORDER BY clause then **Re-Run** — wraps the original query as a subquery, resets the grid and runs load-more on the new cursor.
- **Run .sh (1.4.0)**: open a `.sh` file → the **Run** button on the editor title sends the full file content into the Integrated Terminal (like pasting the whole file into a shell).
- **Toolbar icons (1.5.0)**: the **UnicDB** panel title bar (refresh / filter) and the **UnicDB Results** panel title bar (copy / quick search / export / re-run) fit in a single icon-only row — saves horizontal space in the webview, labels hidden when wide enough.
- **Destructive statement guard (1.5.0)**: before submitting, UnicDB scans the statement — `DELETE with WHERE` → standard confirmation modal; `DELETE without WHERE` / `TRUNCATE` / `DROP` / `UPDATE without WHERE` → a red "EXTREMELY DANGEROUS" modal shows the FULL statement and the user MUST click **Run anyway (dangerous)**; Cancel aborts the whole batch. Setting `UnicDB.confirmDestructive` (default `true`) disables the guard when needed.
- **Read-only connections (1.20.0)**: tick **Read-only** in the connection form — every `runQuery` on that connection is guarded client-side before any network I/O: INSERT/UPDATE/DELETE/MERGE/TRUNCATE/DROP/ALTER/CREATE/GRANT/REVOKE/COMMENT/LOCK throw immediately with the offending statement list. SELECT/SHOW/EXPLAIN/clean WITH pass through untouched.
- **SSH tunnels (1.20.0)**: fill in bastion host/port/user/identity file in the connection form — the extension spawns a local `ssh -N -T` forward (`-L 127.0.0.1:<local>:127.0.0.1:<port>`) and connects through `127.0.0.1`; the tunnel is validated (no shell), started lazily on first use, and stopped when the connection is edited, deleted, or the extension reloads.
- **Folder grouping (1.20.0)**: set a **Folder** name in the connection form — the schema tree groups connections under collapsible folder nodes (deterministic color per folder); connections without a folder stay at the root.
- **Safe File Operations (1.21.0)**: with grounding enabled, the AI chat gains a `workspace_write` tool — it proposes an edit to one allowlisted workspace file, the approval card shows path + line counts + a unified diff preview, and nothing is written until you explicitly allow (once or for the session). Writes are atomic (temp + rename); paths outside the allowlist are refused (`..` traversal cannot widen scope).
- **Safe Rename Refactor (1.23.0)**: schema-tree commands `UnicDB: Rename Table…` and `UnicDB: Rename Column…` (PostgreSQL-only) open a Safe Rename dialog. The host first runs parameterized catalog lookups (dependent views, referencing foreign keys, routines that mention the name, and a name-collision check across tables/views/matviews/sequences/indexes), then shows the proposed `ALTER … RENAME …` plus the usage report for review. Approve runs the rename with per-statement progress; cancel stops before the next statement; a mid-run failure reports the exact statement + error + what already applied. Identifiers are validated against the plain-identifier + forbidden-keyword guards BEFORE any SQL is interpolated.
- **AI Change Plans (1.24.0)**: in the AI chat, ask for a migration/change plan — the `plan_change` tool returns a REVIEWED plan: every statement is tagged with its danger tier (destructive / DDL / DML / admin DCL) and the plan is checked against the live schema for drift (stale-plan guard). The chat renders the plan with Approve & run / Reject buttons; approving re-checks drift, funnels the SQL through the SAME dangerous-statement consent modal as the direct query runner, then applies sequentially with per-statement progress and partial-failure reporting. The tool itself never executes anything.
- **OMP Agent Workbench (1.25.0)**: the AI chat shows live session state (Connecting / Running / Done / Error) so you can see what the engine is doing mid-turn; Stop now actually cancels the OMP child instead of silently dropping late frames. The notification forwarder is hardened against malformed frames (unknown methods, missing fields, tool updates without an id) so a bad wire frame can never kill a turn. Detection now distinguishes "binary missing", "spawn failed", and "version unreadable" (all → install hint) from "version too old" (→ update hint) so the right next step is shown. Both the builtin and the OMP/MCP paths register the same gate-wrapped tool set (db tools, analysis, `plan_change`) — permission cards never diverge.
- **Agent Trace & Replay (1.26.0)**: every AI chat turn (builtin or OMP engine) is recorded into an ordered, redacted, in-memory trace — prompts, tool calls (arguments scrubbed for apiKey/secret/token/Authorization before storage), errors, and completion — with bounded retention (50 turns × 1000 entries). `dumpTrace`/`clearTrace` give future audit export a safe seam; no secrets ever reach the trace store.
- **Database Analysis Copilot (1.22.0)**: AI tool calls are now visible in the chat — each DB tool shows its outcome (rows shape, cap status, denial) as a compact card, never raw row bytes. New `analyze_table` one-call table report (shape + count + capped sample + FKs) and `diagnose_query` error classifier (syntax/permission/connection) with the read-only guard intact.
- **Table Designer (PostgreSQL)**: Schema Explorer panel → right-click a table (or use palette commands `UnicDB: New Table…` / `UnicDB: Modify Table…`) to open a create/edit form:
- **Run .sh CodeLens (1.5.0)**: a `.sh` file open in the editor shows a `▶ Run` CodeLens on the first line — runs the entire file content into the Integrated Terminal (same as the SQL CodeLens); setting `UnicDB.showRunLensSh` (default `true`); included fix: the extension now activates correctly when a `.sh` file is opened and `Run Script` from the palette no longer shoots `\n` into an empty terminal.
  - **New Table…**: form to add columns (name/type/default/NOT NULL), PK / UNIQUE / FK / CHECK, live SQL preview, a single Apply button runs `CREATE TABLE` through the selected connection.
  - **Modify Table…**: introspect the current schema → edit → a diff engine produces `ALTER TABLE` (rename/add/drop column, SET/DROP NOT NULL, SET/DROP DEFAULT, ADD/DROP constraint) and runs them in one go via `runQuery`.
  - **Copy Create Query**: introspect a table then re-emit `CREATE TABLE` (same generator as the form) — copy to clipboard.
  - **Generate Sample Data…**: insert N rows of `INSERT … VALUES` per column type (int/varchar/date/uuid/json) — opens in an untitled SQL tab so you can review/edit before running.
  - **Analyze / Vacuum**: send `ANALYZE` / `VACUUM` (PostgreSQL-only) to refresh planner stats / clean up dead tuples; the button is hidden for MySQL/MSSQL.
- **SQL Console (1.7.0)**: run `UnicDB: Open Console` from the Command Palette — a DataGrip-style scratchpad panel for ad-hoc SQL that can be closed when done. Run (button, Cmd/Ctrl+Enter, or right-click) sends the entire buffer through the exact same editor pipeline (danger-confirm → keyword qualify) and results show in the existing **UnicDB Results** panel; right-click → **Save as SQL file** (or Save button) writes the buffer to a `.sql` file with a suggested name like `console_YYYYMMDD_HHMMSS.sql`. Closing/reopening the console always starts empty — keep content with Save/Copy.
- **AI Settings (1.5.x)**: run `UnicDB: Open AI Settings…` from the Command Palette to open a form configuring an OpenAI-compatible backend (baseUrl, method `responses`/`chat/completions`, timeout, maxSteps, model id for 2 roles `work` (vision) + `smart`, apiKey). The **Test** button smoke-fires a small completion to verify the endpoint is actually alive before the agent uses it.
- **AI Chat & DB tools (1.5.x)**: chat panel `UnicDB: AI Chat` from the Command Palette — multi-turn with an agent loop. The agent has 3 tools: `list_tables`, `describe_table` (PostgreSQL only), and `run_sql`. **Read-only promise**: the `run_sql` tool only accepts `SELECT` / `SHOW` / `EXPLAIN` / `WITH … SELECT` (clean CTEs). Any `INSERT` / `UPDATE` / `DELETE` / `DROP` / `TRUNCATE` / `MERGE` / `INTO` / writable CTE is rejected by the tool on the spot with a specific reason — `adapter.runQuery` never sees DML/DDL. Multi-statement input is also rejected. When `UnicDB: Open AI Settings…` hasn't been run yet, the `UnicDB: AI Chat` command shows an info "Configure AI settings first" and opens the settings form for you.

---

## AI

### Privacy / Egress

- **Storage**: settings (baseUrl, method, timeout, maxSteps, model ids) live in the extension's **VS Code global state** (`UnicDB.ai.settings`); **apiKey** lives in **VS Code SecretStorage** (`UnicDB.ai.apiKey`) — encrypted via the OS keystore (macOS Keychain / Linux libsecret / Windows Credential Vault), never in settings JSON, never appearing in logs, errors, telemetry, or clipboard.
- **Egress contract**: **every** AI request only goes to the `baseUrl` you configured — no third-party endpoint, **no telemetry**, no analytics, no fallback endpoint. If `baseUrl` is empty or invalid the provider fails right at the entry point — it never silently calls somewhere else.
- **Key hygiene**: apiKey is read from SecretStorage per request (no cache). It is attached as the `Authorization: Bearer …` header of the HTTPS request to `baseUrl` and is NEVER included in any error message, response body snippet, or log — the provider `scrubApiKey` before throwing `ProviderError`.
- **Form webview**: the form receives `hasApiKey: boolean`, NOT the apiKey itself; only when the user clicks Save/Test is the field's value pushed up to the host (write-only). If the apiKey field is empty and a key was already saved → the form keeps the existing key.

### Opening the form

Open the Command Palette → type `UnicDB: Open AI Settings…` → fill in the fields → click **Test** to smoke-fire the provider → **Save** to write into the store.

### AI Chat & DB tools

Open the Command Palette → `UnicDB: AI Chat` → the chat panel opens with the multi-turn agent. The agent has 3 tools:

- `list_tables` — lists `(schema, table)` for the active adapter.
- `describe_table` — columns + constraints; only supported when the active connection is **PostgreSQL**.
- `run_sql` — runs **one** read-only statement (SELECT/SHOW/EXPLAIN/clean WITH…SELECT) via `adapter.runQuery`; returns ≤ 50 rows as JSON.

**Guardrails (defense-in-depth)**:

- **Read-only guard** inside `run_sql`: any `INSERT/UPDATE/DELETE/DROP/TRUNCATE/MERGE/ALTER`, multi-statement, or CTE with a DML branch is rejected on the spot by the tool — `adapter.runQuery` never sees DML. Even if the model "intentionally" calls `run_sql` with `DROP TABLE …`, the tool returns a reject reason, the agent loop continues, and the real DB in production stays untouched.
- **Adapter scope**: `run_sql` only resolves through the current active connection (driver `postgres`); if no connection is selected or the driver isn't `postgres` → the tool returns `"No active database connection."` instead of throwing.
- **Egress**: every AI completion only goes to the `baseUrl` you configured — no third-party endpoint, no telemetry, no fallback.
- **apiKey hygiene**: `apiKey` only lives in **SecretStorage** (`UnicDB.ai.apiKey`); read per request and attached as the `Authorization: Bearer …` header. The provider `scrubApiKey` before throwing `ProviderError` — never appears in error messages, response snippets, logs, or the UI.
- **Unconfigured fallback**: if AI Settings have not been saved yet, the command shows `UnicDB: Configure AI settings first.` then opens `UnicDB: Open AI Settings…` for you — no crash, no panel with empty config.


### AI engine: oh-my-pi (optional)

Beyond the built-in engine (`runAgent` via an OpenAI-compatible backend), UnicDB chat can use **oh-my-pi** (`omp`) as the real agent engine — spawn process, RPC JSONL, stream events, host-tool bridge.

- **Requirement**: `omp >= 17.0.0`. Auto-detected the first time you open the panel; if the binary is old / missing / has an unparseable version, the panel announces `{engine:"builtin", hint: "omp install hint"}` once and falls back to built-in as before.
- **Install**: `curl -fsSL https://omp.sh/install | sh` (one-time).
- **Update**: `omp update` (to bump version when a task raises the min-version).
- **UnicDB auto-upgrade**: re-run the existing `install-UnicDB.sh` (`curl -fsSL https://raw.githubusercontent.com/…/install-UnicDB.sh | sh`) — the extension update flow doesn't need to touch omp.
- **Security note**: omp mode grants the agent workspace tools (read/edit/bash scoped to the active workspace's cwd) via the `set_host_tools` RPC. **DB access remains read-only** — UnicDB only hosts the `list_tables` / `describe_table` / `run_sql` tools (the read-only guard inside `run_sql` stays in place), so omp has no tool that can bypass the read-only chokepoint. The agent can modify local SQL files outside of workspace tools, but the real database remains impervious to DML/DDL.
- **Crash fallback**: if the omp process exits mid-turn, the panel posts an error bubble + falls back to builtin for the next turn; it does NOT auto-respawn — the user retries to re-detect.

---


### `code` CLI not found during install

The script prints instructions, but the summary is:

- macOS: open VS Code → `Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH** → re-run the installer.
- Linux: install the extension from the Marketplace manually, or add the VS Code bin to `PATH`.
- Windows (git-bash): make sure `~/AppData/Local/Programs/Microsoft VS Code/bin` is on `PATH`.

You can also set `UnicDB_CODE_PATH=/path/to/code` and re-run the script.

### Conflict with Copilot / other extensions

Some extensions (e.g. Copilot, Codeium) also register `Cmd+Enter` / `Ctrl+Enter`.
Open **File → Preferences → Keyboard Shortcuts**, find `UnicDB.runQuery` and
change it to a different combo (e.g. `Cmd+Shift+Enter`), or unbind the key
on the other extension.

### Where are passwords / connections saved?

VS Code's `SecretStorage` — encrypted via:

- macOS: Keychain
- Linux: libsecret / kwallet
- Windows: Windows Credential Vault

To wipe: **Code → Settings → Clear Secret Storage** (or uninstalling the
extension removes them too).

### Uninstall

```bash
code --uninstall-extension lengockhoa.UnicDB
```

---

## For maintainers

Build and package:

```bash
bash scripts/build.sh
# → produces dist/UnicDB-<version>.vsix
```

Release (the orchestrator handles this after review):

1. Create Git tag `v<version>`.
2. Push the tag to `origin/main`.
3. GitHub Actions publishes a GitHub Release with the `.vsix` file attached.
4. **Marketplace auto-publish**: `.github/workflows/publish.yml` is triggered by
   the tag push and publishes to the VS Code Marketplace via the `VSCE_PAT`
   secret. Users with the extension installed get the update within ~5–10
   minutes (no reinstall needed).
5. The team re-runs the install one-liner → automatically picks up the latest
   version.

> Manual publish fallback: `npm run publish:patch` (or `:minor` / `:major`)
> with `$VSCE_PAT` set locally. See `docs/RELEASE.md` §Publishing.

---

## Development

```bash
git clone https://github.com/lengockhoa/UnicDB
cd UnicDB
npm ci
npm run watch                # incremental build inside src/ + webview/
# In VS Code: F5 → Extension Development Host
```

### Tests

```bash
npm test                     # unit (vitest)
npm run test:integration     # requires Docker (Postgres / MySQL / MSSQL)
```

---

## License

MIT — see [LICENSE](LICENSE).
