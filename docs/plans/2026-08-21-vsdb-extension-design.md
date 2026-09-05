# UnicDB — VS Code Database Extension: Design Document

**Date:** 2026-08-21
**Status:** Approved through brainstorming
**Decision makers:** Owner (user), Claude (design)

---

## 1. Overview & Goals

UnicDB is a VS Code extension that lets you run SQL directly from the editor with an experience as close as possible to DataGrip.

**Current problem:** Connecting to a DB from VS Code is difficult; you have to use an external tool (DataGrip) alongside VS Code.

**Goals:**
- Open a `.sql` file → select SQL → **Cmd+Enter** → run against the DB, see results right inside VS Code
- A familiar experience for DataGrip users (statement at the cursor, result grid, schema explorer)
- Support **PostgreSQL, MySQL/MariaDB, SQL Server** (more adapters later)
- Install once, use for every project (extension installed globally per user)
- Internal distribution via a self-updating script (initial phase), publish to the Marketplace later

**Out of scope (YAGNI):**
- No complex server-side pagination — Load More is enough
- No CSV/Excel export (later)
- No direct data editing in the grid (later)
- No ER diagram (later)
- No connection sync between machines (each machine manages its own)

---

## 2. Architecture & Technology

**Language:** TypeScript. Bundled with esbuild (the current standard for VS Code extensions).

**Project structure:**

```
UnicDB/
├── src/
│   ├── extension.ts              # Entry point: registers commands, keybinding, activity bar
│   ├── config/
│   │   └── types.ts              # Types: ConnectionConfig, DriverType
│   ├── adapters/
│   │   ├── types.ts              # Shared DbAdapter interface
│   │   ├── postgres.ts           # Driver: pg (server-side cursor)
│   │   ├── mysql.ts              # Driver: mysql2 (streaming)
│   │   ├── mssql.ts              # Driver: tedious (streaming)
│   │   └── factory.ts            # Creates an adapter per driver type
│   ├── core/
│   │   ├── connectionManager.ts  # Connection active, lazy connect, idle disconnect
│   │   ├── queryRunner.ts        # Execution, batch fetch 500 rows, cancel
│   │   └── statementParser.ts    # Split statements; statement at the cursor
│   └── ui/
│       ├── resultsPanel.ts       # Result webview panel
│       ├── statusBar.ts          # Active connection button
│       └── schemaTree.ts         # TreeDataProvider for the Schema Explorer
├── webview/                      # Grid UI: plain HTML/CSS/JS, virtual scroll
│   ├── main.ts
│   ├── grid.ts                   # Virtual-scroll table
│   └── styles.css
├── media/
│   └── icon.png                  # 128×128 extension icon
├── scripts/
│   ├── build.sh                  # vsce package → .vsix (for the maintainer)
│   └── install-UnicDB.sh           # download vsix + install/update (for the team)
├── package.json                  # Manifest: commands, keybinding, views
└── esbuild.js
```

**Adapter pattern (the crux):**

```typescript
interface DbAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  runQuery(sql: string): AsyncIterable<QueryResult>;   // multiple result sets
  listTables(schema?: string): Promise<TableInfo[]>;
  listViews(schema?: string): Promise<ViewInfo[]>;
  listRoutines(schema?: string): Promise<RoutineInfo[]>;
  listColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
}
```

All 3 drivers are pure JS (`pg`, `mysql2`, `tedious`) — no native compilation, they bundle cleanly with esbuild. Adding a new DB later = add 1 adapter + 1 case in the factory, without touching core.

---

## 3. Connection Management (local, per machine)

**No config file lives in the repo.** All connection data is stored locally per machine:

| Data | Storage location | Protection |
|---|---|---|
| Connection list (name, driver, host, port, user, database) | VS Code Workspace State | Per machine + per workspace, never in the repo |
| Password | **VS Code SecretStorage** | Encrypted via the macOS Keychain — no plaintext on disk |

**Important note about Workspace State:** connections are stored per workspace. Each project (workspace) has its own connection list — exactly the "everyone manages their own, nothing shared" requirement. Opening a different workspace = separate connections. (The VS Code secrets API is per workspace, which matches the need.)

**Add-connection flow** — command `UnicDB: Add Connection`:
1. QuickPick to choose the driver: PostgreSQL / MySQL / SQL Server
2. InputBox in order: name → host → port (default per driver: 5432/3306/1433) → user → password → database
3. **Test the connection before saving** — on failure report the error immediately and do not save a broken connection
4. Save: password → SecretStorage, everything else → workspace state
5. Status bar + schema tree update

**Management:** `UnicDB: Add / Edit / Delete Connection` via the Command Palette. Edit allows changing every field; a new password overwrites SecretStorage. Deleting a connection also deletes the secret and closes the socket if it is open.

**Active connection:** remembered per workspace (workspace state). Reopening the project → the previous DB is reselected automatically. Status bar `$(database) work_db [postgres]` — click → QuickPick to switch. Only 1 connection is active at a time (though many connections can exist in the list; switching the active one closes the old connection).

**Connection lifecycle:**
- Lazy connect — the socket only opens on the first query (or a schema-tree refresh)
- Idle timeout of 10 minutes → closes automatically
- Connection error → show a clear error in a notification with guidance

---

## 4. Running Queries: Cmd+Enter + Statement Parser

**Keybinding** in `package.json`:

```json
{
  "key": "cmd+enter",
  "command": "UnicDB.runQuery",
  "when": "editorTextFocus && resourceLangId == sql"
}
```

Only active when a `.sql` editor has focus — it does not steal the shortcut from other extensions. If it conflicts with Copilot Chat → the user remaps it in Keyboard Shortcuts, or uses the Command Palette / the ▶ button.

**Logic for choosing which SQL to run** (`statementParser.ts`) — in priority order:

1. **There is a selection** → run the selected region as-is, no cutting and no splitting
2. **No selection** → find the statement containing the cursor:
   - Scan the file for `;` boundaries — ignore `;` inside string literals (`'...'`), dollar-quoted blocks (`$$...$$` Postgres), and comments (`--`, `/* */`)
   - A `BEGIN...END` block (PL/pgSQL, T-SQL) counts as 1 whole statement
   - From the nearest boundary above/below → the statement containing the cursor position
3. The first statement if the cursor sits before everything; empty file → show a message

**Splitting statements when running:** a selection containing multiple statements → run them sequentially, one result tab per statement. A failing statement → stop there, earlier tabs keep their results, and clearly show which statement number failed.

**3 entry points, 1 logic path** — all call `UnicDB.runQuery`:
- **Cmd+Enter** (keyboard)
- **The ▶ button on the editor title bar** (`menu.editor/title`, shown for `.sql`)
- **The "▶ Run" CodeLens** on each statement (setting `UnicDB.showRunLens`, enabled by default)

**Cancel:** long-running query → a Cancel button in the grid header + a Progress notification. The adapter supports cancellation through the driver API (pg_cancel_backend, query.kill for MySQL/MSSQL).

---

## 5. Result Grid (Webview Panel)

**A webview panel** opens below the editor (like the DataGrip Services panel) and is reused across runs — a new query replaces the previous results.

**Layout:**

```
┌──────────────────────────────────────────────────┐
│ work_db [postgres]  ✅ 2 statements · 134ms  [✕] │  header: connection + timing + cancel
├──────────────────────────────────────────────────┤
│ [Result 1] [Result 2] [Messages]                 │  tabs: 1 tab per statement
├──────────────────────────────────────────────────┤
│ id │ name  │ email          │ created_at         │
│ 1  │ An    │ an@mail.com    │ 2026-01-15         │  grid: virtual scroll, sticky header
│ 2  │ Binh  │ binh@mail.com  │ 2026-01-16         │
├──────────────────────────────────────────────────┤
│ 500 rows (of 12,340)  [Load 500 more]  ⏱ 45ms   │  footer
└──────────────────────────────────────────────────┘
```

**Virtual scroll:** only renders the ~30 visible rows — 100k+ rows still scroll smoothly.

**Load More (handling queries with >1M rows):**
- Fetch the first batch of 500 rows from the driver cursor → the grid renders immediately
- **Load 500 more** → the driver cursor fetches another 500 and appends them to the grid
- Server-side cursor (Postgres) / streaming (MySQL, MSSQL) — never load 1M rows into RAM
- **Load all** warns when there are >100k rows
- While fetching → a "Loading..." button

**Tabs:** one result tab per statement. The **Messages** tab aggregates: per-statement timing, `INSERT 0 5`, `UPDATE 3`, warnings. A failing tab → red, and the run stops there.

**Copy:** select cells/rows → Cmd+C to copy (tab-separated, pasteable into Excel). Plus a copy-all button.

**Formatting:** NULL in grey, numbers right-aligned, timestamps in ISO. Follows the VS Code theme (dark/light automatically via CSS variables).

---

## 6. Schema Explorer (Sidebar)

**Activity Bar** UnicDB icon (database cylinder + green arrow) → tree panel:

```
🗄️ UnicDB
├── ● work_db [postgres]          ← active, green dot
│   ├── 📁 Tables
│   │   ├── 📄 users
│   │   │   ├── 🔑 id · int4
│   │   │   ├── ✉ email · varchar
│   │   │   └── created_at · timestamptz
│   │   └── 📄 orders
│   ├── 📁 Views
│   │   └── 📄 v_active_users
│   └── ⚙ Routines
│       ├── fn_calc_total (function)
│       └── sp_sync (procedure)
├── ○ reporting_db [mysql]
└── ＋ Add Connection
```

**Lazy load:** a node fetches metadata when expanded. Metadata is cached for 60s; a 🔄 button refreshes each branch.

**Metadata queries:**
- Postgres: `information_schema.tables/columns`, `pg_proc` for routines
- MySQL: `information_schema.*`
- SQL Server: `sys.tables`, `sys.columns`, `sys.objects` + `sys.sql_modules`

**Context menu on a table/view:**
- **Generate SELECT** → insert `SELECT * FROM users LIMIT 100;` at the cursor
- **Copy qualified name** → `workdb.public.users`
- **Refresh**

Click a connection → switch the active one. A not-yet-connected connection shows a "Connect" child node — click it to connect.

---

## 7. Distribution & Updates

**Phase 1 (now):** build the `.vsix` and share it via a script.

- Maintainer: `scripts/build.sh` → `vsce package` → `UnicDB-<version>.vsix` → push to GitHub Releases / a shared drive
- Team: a single command:

```
curl -fsSL https://.../install-UnicDB.sh | bash
```

The script: read the latest version → download the vsix → `code --install-extension UnicDB-<version>.vsix` (installing over the top = update). It detects an older installed version automatically → reports the update.

**Phase 2 (once stable):** publish to the VS Code Marketplace → silent auto-update, zero effort. The code does not change, only a release step is added.

**Extension icon:** database cylinder + green run arrow, SVG → PNG 128×128 (generated during setup).

---

## 8. Error Handling

| Situation | Handling |
|---|---|
| No connections at all | Cmd+Enter → QuickPick suggesting "Add Connection" |
| Wrong password / host unreachable | Clear error notification + open the edit-connection form |
| Query timeout / long-running | Cancel button (kills the query server-side) |
| Statement fails mid-batch | Stop there, red error tab, keep the results of earlier statements |
| `.sql` file not focused | The ▶ button is hidden, Cmd+Enter does not trigger (when clause) |
| SecretStorage failure | Fallback: ask for the password on every connect (do not store it) |
| No workspace open (single file) | Connections are saved to global state instead of workspace state |

---

## 9. Testing

- **Unit tests** (mocha/vitest): `statementParser` (cases: strings containing `;`, dollar-quote, BEGIN...END, cursor at start/end of file, selection with multiple statements), config types
- **Integration tests** against real Docker DBs (docker compose: postgres + mysql + mssql): add connection → connect → run query → receive results → Load More → cancel
- **Manual test checklist** in `docs/testing-checklist.md`: 3 DBs × the main flows (Cmd+Enter, ▶ button, CodeLens, schema tree, load more >100k rows)

---

## 10. Design sign-off checklist (approved)

- [x] DBs: PostgreSQL, MySQL/MariaDB, SQL Server (adapter pattern, more later)
- [x] Connections: local per machine, never committed to the repo — passwords via SecretStorage
- [x] Active connection remembered per workspace, quick switching from the status bar + schema tree
- [x] Cmd+Enter: selection > statement at the cursor; the parser handles `;`, strings, dollar-quote, BEGIN...END
- [x] ▶ title-bar button + ▶ Run CodeLens — 3 entry points, 1 logic path
- [x] Grid webview: virtual scroll, one tab per statement, Load More 500, cancel
- [x] Schema Explorer: Activity Bar tree, lazy load, Generate SELECT context menu
- [x] Distribution: vsix + install script in phase 1, Marketplace later
- [x] Overriding priority: the most intuitive experience, as close to DataGrip as possible
