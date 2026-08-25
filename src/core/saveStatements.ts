// src/core/saveStatements.ts
//
// TASK-503 — translate webview saveEdits payload into per-dialect SQL.
//
// Fix Round 1 — INLINE LITERAL contract (option B per reviewer's plan).
//
// After Fix R1 the build emits complete SQL with values inlined via the
// portable sqlLiteral (single-quote doubling, NO backslash escaping).
// The aggregate `parameters[]` field has been REMOVED — no driver-side
// substitution is needed and the `?` / `$N` placeholders are gone. The
// output SQL can be shipped straight to `adapter.runQuery(sql)` and works
// against pg / mysql2 / tedious without any parameter-channel plumbing.
//
// Why option B and not (A) per-adapter parameter channel:
//   - DbAdapter.runQuery(sql: string) has no parameter argument. Adding one
//     requires touching the adapter contract + three concrete adapters +
//     every test that mocks runQuery. The inline-literal path uses the
//     portable sqlLiteral already shipped with TASK-502 (single-quote
//     doubling, no backslash escaping — PG standard_conforming_strings=on
//     and MSSQL both treat backslash literally, so pre-fix double-backslash
//     escaping corrupted data on those DBs).
//   - The webview saves ONE statement per UPDATE (coalesced per row) so
//     the literal path is bounded to the user's selected edits.
//   - Identifier quoting is per-dialect (postgres plain, mysql backtick,
//     mssql bracket) — already a dialect concern in v1.
//
// Pure-logic, no DOM, no vscode, no DB driver.
import { sqlLiteral } from "../ui/resultsGridModel";

/** Database dialect (mirrors the WebviewMessage contract / DBA driver). */
export type Dialect = "postgres" | "mysql" | "mssql";

/** One entry from EditState.snapshot() — see resultsGridModel.ts. */
export interface EditEntry {
  rowId: number;
  colIndex: number;
  value: unknown;
}

/** Marker shape for a locally-added row (Add Row toolbar). */
export interface NewRowMarker {
  __vsdb_new_row__: true;
  __rowId: number;
  /** Per-column current values (length === column count). */
  values: unknown[];
}

/** Marker shape for a deleted row (Delete Row toolbar). */
export interface DeleteRowMarker {
  __vsdb_deleted__: true;
  __rowId: number;
}

/** Marker shape for an INSERT cell whose value was never touched by the
 *  user — the column is omitted from the INSERT column/value lists so the
 *  server applies its own DEFAULT instead of receiving `''` (A11). */
export interface DefaultValueMarker {
  __vsdb_default__: true;
}

export function isDefaultValueMarker(v: unknown): v is DefaultValueMarker {
  if (typeof v !== "object" || v === null) return false;
  return (v as Record<string, unknown>)["__vsdb_default__"] === true;
}

/** Reserved `EditEntry.colIndex` slots for row-level markers (insert /
 *  delete). TASK-002 declares the same two values locally in
 *  webview/main.ts (same wave — it must not import from here). Values
 *  must match. Never used to index into `columns[]`. */
export const MARKER_COL_INSERT = -1;
export const MARKER_COL_DELETE = -2;

/** Optional postgres-only ctid lookup for no-PK tables. Used by the
 *  UPDATE branch (cell edits) AND the DELETE branch (delete markers) when
 *  `dialect === "postgres"` and `pkColumns.length === 0` — without a ctid
 *  the row is skipped and a warning is emitted. */
export interface SaveStatementsOptions {
  /** rowId → ctid. KEYED BY rowId (not server row index). Missing keys →
   *  row is skipped with a warning. */
  ctidByRowId?: ReadonlyMap<number, string>;
  /** rowId → index into `serverRows` (A12). The webview's high-water-mark
   *  `rowId` and the server's row index diverge after Add Row / streamed
   *  appends; this remaps producer→consumer. Absent ⇒ identity
   *  (`serverIndex(rowId) = rowId`), i.e. today's behavior. Applies to
   *  both the UPDATE and the DELETE (PK) branch. */
  serverIndexByRowId?: ReadonlyMap<number, number>;
  /** Schema parsed from the query's FROM clause (A8). Absent ⇒ emit
   *  `"table"` unqualified, matching today's behavior. */
  schema?: string;
}

/** Successful build — `statements` are pushed in execution order; the
 *  caller passes the SQL strings straight to `adapter.runQuery(sql)`.
 *  `ok` is the discriminator for the union. */
export interface SaveStatementsOk {
  ok: true;
  /** Output SQL, one entry per logical operation. Inline literals — safe to
   *  pipe directly to the adapter. */
  statements: string[];
  /** Non-fatal notes (ctid warnings, no_pk warnings, ambiguous rows). */
  warnings: string[];
  /** NEW (A19-skip, §3.4a): rows whose edits produced NO statement, so the
   *  host can keep them dirty instead of the webview clearing them as
   *  saved. `undefined`/empty ⇒ every row's edits were emitted. */
  skippedRows?: ReadonlyArray<{ rowId: number; reason: string }>;
}

/** Soft failure — caller MUST surface `reason` to the user (banner).
 *  `ok: false` is the discriminator. */
export interface SaveStatementsRefused {
  ok: false;
  reason: "no_pk" | "invalid_identifier";
  warnings: string[];
  /** Optional structured error attached when the host adds extra context
   *  (e.g. ambiguous ctid match). Surfaced as banner copy. */
  detail?: string;
}

export type SaveStatementsResult = SaveStatementsOk | SaveStatementsRefused;

// ---- helpers ---------------------------------------------------------------

function isNewRowMarker(v: unknown): v is NewRowMarker {
  if (typeof v !== "object" || v === null) return false;
  return (v as Record<string, unknown>)["__vsdb_new_row__"] === true;
}

function isDeleteMarker(v: unknown): v is DeleteRowMarker {
  if (typeof v !== "object" || v === null) return false;
  return (v as Record<string, unknown>)["__vsdb_deleted__"] === true;
}

/** Identifier-quoting per dialect. Exposed (not just internal) so the
 *  ctid-fetch helper can reuse it for table + column names (Fix R1
 *  important #1 — quoted identifiers + safe literal escape). */
export function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === "mysql") {
    return "`" + name.replace(/`/g, "``") + "`";
  }
  if (dialect === "mssql") {
    return "[" + name.replace(/]/g, "]]") + "]";
  }
  // postgres (A9): double-quote + escape embedded double quotes by
  // doubling — the standard SQL identifier-quoting rule. This makes
  // mixed-case, spaced and non-ASCII identifiers addressable instead of
  // being silently mismatched against `search_path`-resolved lower-case
  // names.
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Validate a single SQL identifier before interpolation. `quoteIdent`
 *  now quotes every identifier for every dialect, so this gate only needs
 *  to reject what quoting cannot make safe: empty names and embedded
 *  control characters (NUL, newline, etc). Mixed-case, spaced and
 *  non-ASCII identifiers are allowed through — quoted, not refused. */
function isSafeIdent(name: string): boolean {
  return name.length > 0 && !/[\x00-\x1f]/.test(name);
}

/** Parsed FROM clause: schema (if any) + table. Returned as null when
 *  the SQL has no SELECT/INSERT/UPDATE FROM. Exposed so the host
 *  ResultsPanel can derive the table name without trusting the webview.
 *
 *  Recognises (case-insensitive keyword, ignoring comments + string
 *  literals):
 *    - SELECT ... FROM [schema.]table [alias]
 *    - INSERT INTO [schema.]table ...
 *    - UPDATE [schema.]table SET ...
 *    - DELETE FROM [schema.]table WHERE ...
 *
 *  Strips bracket [name] and backtick `name` wrappers.
 */
export interface ParsedFrom {
  schema?: string;
  table: string;
}

function skipWs(sql: string, i: number): number {
  while (i < sql.length && /\s/.test(sql[i])) i++;
  return i;
}

/** Read a SQL identifier starting at `i`. Returns `{ name, end }` where
 *  `end` is the index just past the last character of the identifier.
 *  Recognises bracket-quoted `[name]`, backtick `` `name` ``, double-quoted
 *  `"name"`, and bareword forms. Returns null if no identifier starts at
 *  `i`. */
function readIdent(
  sql: string,
  i: number,
): { name: string; end: number } | null {
  if (i >= sql.length) return null;
  const ch = sql[i];
  if (ch === "[") {
    const close = sql.indexOf("]", i + 1);
    if (close < 0) return null;
    return { name: sql.substring(i + 1, close), end: close + 1 };
  }
  if (ch === "`") {
    const close = sql.indexOf("`", i + 1);
    if (close < 0) return null;
    return { name: sql.substring(i + 1, close), end: close + 1 };
  }
  if (ch === '"') {
    const close = sql.indexOf('"', i + 1);
    if (close < 0) return null;
    return { name: sql.substring(i + 1, close), end: close + 1 };
  }
  let j = i;
  while (j < sql.length && !/[\s(),;.]/.test(sql[j])) {
    j++;
  }
  if (j === i) return null;
  return { name: sql.substring(i, j), end: j };
}

function isKeyword(sql: string, i: number, kw: string): boolean {
  const slice = sql.substring(i, i + kw.length).toLowerCase();
  if (slice !== kw) return false;
  // Word boundary on both sides.
  const before = i === 0 ? " " : sql[i - 1];
  const after = sql[i + kw.length] ?? " ";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

/** Walk the SQL ONCE (A20), skipping over string literals and SQL
 *  comments in place, and collecting FROM/INTO/UPDATE keyword candidates
 *  as it goes. The old version called an `inSkippedRegion(sql, i)` helper
 *  that itself re-scanned from 0 to `i` on every character — O(n) work per
 *  character, O(n²) overall on large SQL (a big string literal was the
 *  worst case). This single forward pass jumps straight past each
 *  string/comment region instead of re-deriving "am I inside one?" from
 *  scratch every time, so the whole scan is O(n). */
export function parseFromClause(sql: string): ParsedFrom | null {
  const lower = sql.toLowerCase();
  type Kw = "from" | "into" | "update";
  const candidates: Array<{ idx: number; key: Kw }> = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      // Single-quoted string: skip until next single quote. Doubled quotes
      // inside ('') are one literal escape.
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      if (i < sql.length) i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      if (i < sql.length) i += 2;
      continue;
    }
    if (isKeyword(lower, i, "from")) {
      candidates.push({ idx: i, key: "from" });
      i += 4;
      continue;
    }
    if (isKeyword(lower, i, "into")) {
      candidates.push({ idx: i, key: "into" });
      i += 4;
      continue;
    }
    if (isKeyword(lower, i, "update")) {
      candidates.push({ idx: i, key: "update" });
      i += 6;
      continue;
    }
    i++;
  }
  if (candidates.length === 0) return null;
  const first = candidates[0];
  const identStart = skipWs(sql, first.idx + first.key.length);
  const ident = readIdent(sql, identStart);
  if (!ident) return null;
  // Optionally read schema-qualified `.<ident>`.
  if (sql[ident.end] === ".") {
    const second = readIdent(sql, ident.end + 1);
    if (!second) return { table: ident.name };
    return { schema: ident.name, table: second.name };
  }
  return { table: ident.name };
}

// ---- public fn ------------------------------------------------------------

export function buildSaveStatements(
  dialect: Dialect,
  tableName: string,
  pkColumns: string[],
  columns: string[],
  edits: EditEntry[],
  serverRows: unknown[][],
  options: SaveStatementsOptions = {},
): SaveStatementsResult {
  const statements: string[] = [];
  const warnings: string[] = [];

  // Identifier safety check — defensive: the parser already strips brackets /
  // backticks, but we double-check before interpolation.
  if (!isSafeIdent(tableName)) {
    return {
      ok: false,
      reason: "invalid_identifier",
      warnings: [
        `table name "${tableName}" is not a safe SQL identifier`,
      ],
    };
  }
  for (const pk of pkColumns) {
    if (!isSafeIdent(pk)) {
      return {
        ok: false,
        reason: "invalid_identifier",
        warnings: [
          `pk column "${pk}" is not a safe SQL identifier`,
        ],
      };
    }
  }
  for (const c of columns) {
    if (!isSafeIdent(c)) {
      return {
        ok: false,
        reason: "invalid_identifier",
        warnings: [
          `column "${c}" is not a safe SQL identifier`,
        ],
      };
    }
  }

  // A8: schema-qualify the emitted table when the caller parsed one.
  // Absent ⇒ unqualified, byte-identical to today.
  const qTable = options.schema
    ? `${quoteIdent(options.schema, dialect)}.${quoteIdent(tableName, dialect)}`
    : quoteIdent(tableName, dialect);

  if (edits.length === 0) {
    return { ok: true, statements, warnings };
  }

  // A19-skip (§3.4a): every `continue`/`break` below that leaves a row's
  // edits unemitted records a `{rowId, reason}` entry here, so the host can
  // tell the webview exactly which rows to keep dirty instead of silently
  // acking `ok:true` and losing the edit. Sites that do NOT belong here:
  //   - `insertRowIds.has(rowId)` (loop 3): the row IS addressed, by its
  //     own INSERT — recording it would produce a false "edit lost" banner.
  //   - `!rowEdits` (loop 3): defensive, unreachable (rowId always comes
  //     from `editsByRow.keys()`).
  const skippedRows: { rowId: number; reason: string }[] = [];

  // A12: rowId → index into `serverRows`. Absent option ⇒ identity, i.e.
  // today's `serverRows[rowId]` behavior. Applies to both the UPDATE and
  // the DELETE (PK) branch below.
  const resolveServerIndex = (rowId: number): number =>
    options.serverIndexByRowId?.get(rowId) ?? rowId;

  const colIdx = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) colIdx.set(columns[i], i);

  // Finding 1 (review fix round, cycle T) — Add Row silently discarded every
  // value the user typed. onCellValueChangedHandler records an ordinary
  // cell edit (colIndex >= 0) for a locally-added row SEPARATELY from the
  // insert marker's own `values` array; loop 3 below correctly recognises
  // the row is "already addressed by the INSERT" and skips re-emitting it
  // as an UPDATE — but nothing ever folded that typed value INTO the
  // INSERT, so it vanished entirely. Precompute rowId → cell edits here so
  // loop 1 can overlay them onto the marker's `values` before building the
  // INSERT column/value lists.
  const cellEditsByRow = new Map<number, EditEntry[]>();
  for (const e of edits) {
    if (isNewRowMarker(e.value) || isDeleteMarker(e.value)) continue;
    if (e.colIndex < 0) continue;
    let arr = cellEditsByRow.get(e.rowId);
    if (!arr) {
      arr = [];
      cellEditsByRow.set(e.rowId, arr);
    }
    arr.push(e);
  }

  // ---- 1) Insert markers → one INSERT per new row ------------------------
  for (const e of edits) {
    if (!isNewRowMarker(e.value)) continue;
    const markerValues = e.value.values;
    if (!Array.isArray(markerValues) || markerValues.length !== columns.length) {
      const reason = `insert row ${e.rowId}: values length (${markerValues?.length ?? "?"}) does not match column count (${columns.length}); skipped`;
      warnings.push(reason);
      skippedRows.push({ rowId: e.rowId, reason });
      continue;
    }
    // Finding 1 — overlay any ordinary cell edits typed into THIS new row
    // onto a copy of the marker's values before building the INSERT. Copy
    // so we never mutate the caller's marker object.
    const values = markerValues.slice();
    const overlay = cellEditsByRow.get(e.rowId);
    if (overlay) {
      for (const cellEdit of overlay) {
        if (cellEdit.colIndex < values.length) {
          values[cellEdit.colIndex] = cellEdit.value;
        }
      }
    }
    // A11: DEFAULT-value sentinel — omit untouched columns entirely so the
    // server applies its own DEFAULT instead of receiving `''`/`NULL`. If
    // every column is untouched, emit bare `DEFAULT VALUES`.
    const insertCols: string[] = [];
    const insertVals: unknown[] = [];
    for (let i = 0; i < columns.length; i++) {
      if (isDefaultValueMarker(values[i])) continue;
      insertCols.push(columns[i]);
      insertVals.push(values[i]);
    }
    if (insertCols.length === 0) {
      // Review Finding 3(b), fix round 2: a completely empty Add Row on a
      // mysql/mssql table with NO PRIMARY KEY would be unidentifiable —
      // there is no PK-based WHERE (and, unlike postgres, no ctid
      // fallback) to ever address the row again for a later edit/delete.
      // Refuse this specific row instead of emitting the anonymous
      // `INSERT INTO t () VALUES ()` the no_pk guard below exists to
      // prevent. Postgres is unaffected — its ctid fallback still lets a
      // later save target the row (Finding 3 discussion; postgres path
      // stays exactly as it is).
      if (pkColumns.length === 0 && dialect !== "postgres") {
        const reason = `insert row ${e.rowId} skipped: ${dialect} has no PRIMARY KEY for "${tableName}"; refusing to insert an unidentifiable empty row.`;
        warnings.push(reason);
        skippedRows.push({ rowId: e.rowId, reason });
        continue;
      }
      // Finding 3 — MySQL has no `DEFAULT VALUES` syntax; it needs the
      // explicit-empty-list form. Postgres and MSSQL both accept
      // `DEFAULT VALUES` unchanged.
      statements.push(
        dialect === "mysql"
          ? `INSERT INTO ${qTable} () VALUES ()`
          : `INSERT INTO ${qTable} DEFAULT VALUES`,
      );
    } else {
      const colList = insertCols
        .map((c) => quoteIdent(c, dialect))
        .join(", ");
      const valueList = insertVals.map((v) => sqlLiteral(v)).join(", ");
      statements.push(
        `INSERT INTO ${qTable} (${colList}) VALUES (${valueList})`,
      );
    }
  }

  // ---- 2) Delete markers → one DELETE per row ----------------------------
  for (const e of edits) {
    if (!isDeleteMarker(e.value)) continue;
    if (pkColumns.length === 0) {
      const delRowId = e.value.__rowId;
      if (dialect === "postgres") {
        const ctid = options.ctidByRowId?.get(delRowId);
        if (!ctid) {
          const reason = `delete row ${delRowId} skipped: postgres no-PK + missing ctid`;
          warnings.push(reason);
          skippedRows.push({ rowId: delRowId, reason });
        } else {
          statements.push(
            `DELETE FROM ${qTable} WHERE ctid=${sqlLiteral(ctid)}`,
          );
          warnings.push(
            `delete row ${delRowId}: postgres no-PK fallback used (ctid) — not safe under concurrent writes`,
          );
        }
      } else {
        // A10-remainder: mysql/mssql have no ctid-style fallback — the row
        // is skipped, but explicitly (warning + skippedRows), never a
        // silent no-op.
        const reason = `delete row ${delRowId} skipped: ${dialect} has no primary key for "${tableName}"`;
        warnings.push(reason);
        skippedRows.push({ rowId: delRowId, reason });
      }
      continue;
    }
    const rowId = e.value.__rowId;
    const serverRow = serverRows[resolveServerIndex(rowId)];
    if (!serverRow) {
      const reason = `delete row ${rowId} skipped: no server row`;
      warnings.push(reason);
      skippedRows.push({ rowId, reason });
      continue;
    }
    const whereParts: string[] = [];
    let whereOk = true;
    let breakReason = "";
    for (const pk of pkColumns) {
      const ci = colIdx.get(pk);
      if (ci === undefined) {
        whereOk = false;
        breakReason = `delete row ${rowId} skipped: pk column "${pk}" not in result`;
        warnings.push(breakReason);
        break;
      }
      whereParts.push(
        `${quoteIdent(pk, dialect)}=${sqlLiteral(serverRow[ci])}`,
      );
    }
    if (whereOk) {
      statements.push(
        `DELETE FROM ${qTable} WHERE ${whereParts.join(" AND ")}`,
      );
    } else {
      skippedRows.push({ rowId, reason: breakReason });
    }
  }

  // Insert-marked rows, precomputed once — the loop below used
  // `edits.some(...)` PER row (O(rows×edits)); with a large save batch
  // that's quadratic. Same semantics, linear now (dynamic numeric-key
  // membership → Set per project rule).
  const insertRowIds = new Set<number>();
  for (const e of edits) {
    if (isNewRowMarker(e.value)) insertRowIds.add(e.rowId);
  }
  // ---- 3) Cell edits → one UPDATE per row --------------------------------
  const editsByRow = new Map<number, EditEntry[]>();
  for (const e of edits) {
    if (isNewRowMarker(e.value) || isDeleteMarker(e.value)) continue;
    let arr = editsByRow.get(e.rowId);
    if (!arr) {
      arr = [];
      editsByRow.set(e.rowId, arr);
    }
    arr.push(e);
  }
  const sortedRowIds = Array.from(editsByRow.keys()).sort((a, b) => a - b);

  // Review Finding 3(a), fix round 2: `sortedRowIds` includes rows that are
  // ALSO covered by an insert marker — a typed value on an Add Row arrives
  // as its own plain cell-edit EditEntry (see the "Finding 1, cycle T"
  // discussion above), which lands in `editsByRow`/`sortedRowIds` even
  // though the UPDATE loop below skips it (`insertRowIds.has(rowId)`) since
  // the value already went into the INSERT. Gating the no_pk guard on the
  // raw `sortedRowIds` therefore hard-refused an insert-only batch before
  // that per-row skip ever ran — exactly the batch the guard's own comment
  // says is intentionally exempt. Compute the guard over rows that actually
  // need an UPDATE (i.e. exclude insert-marked rows) instead.
  const updateOnlyRowIds = sortedRowIds.filter((id) => !insertRowIds.has(id));

  const hasPk = pkColumns.length > 0;
  if (!hasPk && dialect !== "postgres" && updateOnlyRowIds.length > 0) {
    // mysql/mssql without PK: REJECT — but only when there is actual cell
    // (UPDATE) work needing a PK-based WHERE. A delete-only or insert-only
    // batch on a no-PK table does not need this hard refusal; deletes are
    // already skipped per-row above (with a warning + skippedRows entry),
    // and inserts never need a PK.
    return {
      ok: false,
      reason: "no_pk",
      warnings: [
        ...warnings,
        `${dialect} has no PRIMARY KEY for "${tableName}"; cannot save cell edits.`,
      ],
    };
  }
  for (const rowId of sortedRowIds) {
    const rowEdits = editsByRow.get(rowId);
    if (!rowEdits) continue;
    // Rows with an INSERT marker are already addressed by the INSERT; skip
    // the redundant UPDATE. insertRowIds is precomputed above the loop —
    // the old per-row `edits.some(...)` scan was O(rows×edits). NOT a
    // skippedRows site: the row's edits WERE emitted, via the INSERT.
    if (insertRowIds.has(rowId)) continue;

    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const e of rowEdits
      .slice()
      .sort((a, b) => a.colIndex - b.colIndex)) {
      // Reserved marker slots (MARKER_COL_INSERT/DELETE) must never index
      // into `columns[]` — those rows are handled by loops 1/2 above by
      // value shape already; this is a belt-and-suspenders guard against
      // a stray negative colIndex reaching `columns[e.colIndex]`.
      if (e.colIndex < 0) continue;
      const c = columns[e.colIndex];
      if (c === undefined) {
        const reason = `row ${rowId}: skipped unknown col index ${e.colIndex}`;
        warnings.push(reason);
        skippedRows.push({ rowId, reason });
        continue;
      }
      cols.push(c);
      vals.push(e.value);
    }
    if (cols.length === 0) {
      // Whole row dropped — every edit targeted an unknown col index.
      // Unlike the per-cell case above, no warning is pushed here today
      // (that's the `warnings.push` grep miss called out in TASK-001); the
      // skippedRows entry is the only signal, and it must not be skipped.
      skippedRows.push({
        rowId,
        reason: `row ${rowId} skipped: no editable columns (all edited col indexes unknown)`,
      });
      continue;
    }

    if (hasPk) {
      const pkSet = new Set(pkColumns);
      const setParts: string[] = [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (pkSet.has(c)) continue; // never UPDATE PK column.
        setParts.push(
          `${quoteIdent(c, dialect)}=${sqlLiteral(vals[i])}`,
        );
      }
      if (setParts.length === 0) {
        const reason = `row ${rowId} skipped: only PK columns edited`;
        warnings.push(reason);
        skippedRows.push({ rowId, reason });
        continue;
      }
      const setClause = setParts.join(", ");

      const serverRow = serverRows[resolveServerIndex(rowId)];
      if (!serverRow) {
        const reason = `row ${rowId} skipped: no server row for UPDATE`;
        warnings.push(reason);
        skippedRows.push({ rowId, reason });
        continue;
      }
      const whereParts: string[] = [];
      let whereOk = true;
      let breakReason = "";
      for (const pk of pkColumns) {
        const i = colIdx.get(pk);
        if (i === undefined) {
          whereOk = false;
          breakReason = `row ${rowId} skipped: pk column "${pk}" missing`;
          warnings.push(breakReason);
          break;
        }
        whereParts.push(
          `${quoteIdent(pk, dialect)}=${sqlLiteral(serverRow[i])}`,
        );
      }
      if (!whereOk) {
        skippedRows.push({ rowId, reason: breakReason });
        continue;
      }
      statements.push(
        `UPDATE ${qTable} SET ${setClause} WHERE ${whereParts.join(" AND ")}`,
      );
    } else {
      // postgres no-PK fallback: WHERE ctid = '<literal>'
      const ctid = options.ctidByRowId?.get(rowId);
      if (!ctid) {
        const reason = `row ${rowId} skipped: postgres no-PK + missing ctid`;
        warnings.push(reason);
        skippedRows.push({ rowId, reason });
        continue;
      }
      const setParts: string[] = [];
      for (let i = 0; i < cols.length; i++) {
        setParts.push(
          `${quoteIdent(cols[i], dialect)}=${sqlLiteral(vals[i])}`,
        );
      }
      const whereClause = `ctid=${sqlLiteral(ctid)}`;
      statements.push(
        `UPDATE ${qTable} SET ${setParts.join(", ")} WHERE ${whereClause}`,
      );
      warnings.push(
        `row ${rowId}: postgres no-PK fallback used (ctid) — not safe under concurrent writes`,
      );
    }
  }

  return {
    ok: true,
    statements,
    warnings,
    skippedRows: skippedRows.length > 0 ? skippedRows : undefined,
  };
}
