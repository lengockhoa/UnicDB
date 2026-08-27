# VSDB — Manual Testing Checklist (v1)

Smoke checklist for the first release (v1.0.0). Run on the Extension Development
Host (`F5`) or after installing from a `.vsix`. Test each DB once; check both
positive + negative flows.

> In this checklist -> tick each line manually while testing. Report issues at
> [GitHub Issues](https://github.com/lengockhoa/VSDB/issues).

---

## Prerequisites

- [ ] Docker running (Postgres / MySQL / MSSQL testcontainers).
- [ ] Sample data: table `users(id, name, email)` ~100k rows; table `orders(id, user_id, total)` ~500k rows.
- [ ] `npm run watch` is running (dev) OR `.vsix` is already installed (release).
- [ ] `code` CLI on `PATH`.

---

## 1. Connection management

- [ ] **Add**: `+` on the panel -> fill the form -> test connect succeeds with all 3 drivers (pg / mysql / mssql).
- [ ] **Edit**: right-click connection -> Edit -> change password -> save -> re-test OK.
- [ ] **Delete**: right-click connection -> Delete -> confirm -> disappears from the panel.
- [ ] **Select active**: status bar shows the connection name after selecting; click to switch.
- [ ] **Persistence**: reload VS Code -> connections still present.

## 2. Query execution (Cmd+Enter / Ctrl+Enter)

- [ ] **Single statement**: `SELECT 1` -> runs, result appears in the panel.
- [ ] **Statement in a multi-statement script**: only the selected statement runs, not the entire file.
- [ ] **No selection**: place the cursor inside a statement -> runs that exact statement.
- [ ] **Comment block**: `/* ... */ SELECT ...` -> runs the SQL statement correctly, skips the comment.
- [ ] **String literal containing `;`**: `SELECT 'a;b'` -> does NOT split incorrectly.
- [ ] **Quoted identifier containing `(`**: `[fn(1)](2)` -> does NOT confuse function call with identifier.
- [ ] **Keybinding matches the OS**: macOS uses `Cmd+Enter`, Win/Linux use `Ctrl+Enter`.
- [ ] **Outside `.sql` file**: keybinding does NOT trigger.

## 3. Editor UI buttons

- [ ] **▶ (Run) button on the title bar** when focused inside `.sql` -> runs the query.
- [ ] **■ (Cancel) button** while running -> query is cancelled server-side, panel shows "Cancelled".
- [ ] **CodeLens ▶ Run** on every statement -> click runs the correct statement.
- [ ] **Disable CodeLens**: setting `vsdb.showRunLens = false` -> CodeLens disappears, stays disabled after restart.

## 4. Schema Explorer

- [ ] **Tree expand**: connection -> schema -> Tables / Views / Routines -> table -> column.
- [ ] **All schemas shown**: open connection -> every accessible schema appears, not only `public` / `dbo` / the default database.
- [ ] **Count badge**: after expanding, the category shows the object count (e.g. Tables -> `2`).
- [ ] **Setting `vsdb.hideSystemSchemas`**: enabled (default) -> hides `pg_*` / `information_schema` / `mysql` / `sys`; disabled -> shows them again.
- [ ] **Tables + views + routines** (if the DB has them) render the correct kind.
- [ ] **Right-click table/view -> Generate SELECT** -> inserts `SELECT * FROM schema.table` into the editor (works for non-default schemas too).
- [ ] **Right-click -> Copy Qualified Name** -> clipboard has `schema.table` / `schema.table.column`.

## 5. Result panel

- [ ] **Small result** (< 500 rows): shows everything in one go.
- [ ] **Large result** (> 500 rows): shows 500 rows + a **Load 500 more** button at the bottom -> click to extend.
- [ ] **`vsdb.batchSize` = 1000**: reload extension -> loads 1000 per batch.
- [ ] **Cancel mid-load**: click ■ while loading -> stops immediately, no further load.
- [ ] **Column types**: timestamp/date/bytea/blob render correctly (string / hex / base64).
- [ ] **NULL cells**: show `(NULL)`, no layout breakage.

## 6. Cancel & errors

- [ ] **`SELECT pg_sleep(60)`** -> click ■ within 2s -> query cancels; check `pg_stat_activity` shows `idle`.
- [ ] **`SELECT SLEEP(60)`** (MySQL) -> cancel works the same way.
- [ ] **Syntax error**: `SELEC 1` -> panel shows a clear error message, extension does NOT crash.
- [ ] **Connection lost mid-query**: kill the DB container -> query reports an error, status bar updates, no hang.

## 7. Multi-connection

- [ ] Open 2 `.sql` files with 2 different connections (pg + mysql) -> each file uses its own connection when running.
- [ ] Switch active connection -> the focused file uses the new connection; the other file keeps the old one.

## 8. Packaging / install (release smoke)

- [ ] `bash scripts/build.sh` exit 0, prints the `.vsix` path.
- [ ] `bash scripts/install-vsdb.sh --local dist/vsdb-*.vsix` exit 0.
- [ ] `code --list-extensions | grep vsdb` shows `lengockhoa.vsdb`.
- [ ] Uninstall + reinstall multiple times (idempotency): always lands on the same final version.

---

## Pass criteria

The v1.0.0 release is ready when:

- 100% of the lines above are ticked (except driver-specific lines when only 1 DB is smoked).
- No regressions from `npm test` + `npm run test:integration`.
- `.vsix` installs successfully on ≥ 1 macOS machine and ≥ 1 Linux machine.

Report issues in the repo with: VS Code version, OS, DB driver, repro steps, log.
