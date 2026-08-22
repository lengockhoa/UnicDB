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

/** Optional postgres-only ctid lookup for no-PK tables. */
export interface SaveStatementsOptions {
  /** rowId → ctid. Missing keys → row is skipped with a warning. */
  ctidByRowId?: ReadonlyMap<number, string>;
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
  // postgres: caller must pre-validate the identifier shape.
  return name;
}

/** Validate a single SQL identifier. Used by the host's CTID helper and
 *  by buildSaveStatements when verifying host-derived identifiers. */
function isSafeIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name);
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

/** Walk the SQL, skipping over string literals and SQL comments.
 *  Returns true when `i` is inside one of those — used to make sure we
 *  do not trip over a FROM token that lives inside a string or a
 *  comment. */
function inSkippedRegion(sql: string, i: number): boolean {
  let j = 0;
  while (j < i && j < sql.length) {
    const c = sql[j];
    if (c === "'") {
      // Single-quoted string: skip until next single quote. Doubled quotes
      // inside ('') are one literal escape.
      j++;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      continue;
    }
    if (c === '"') {
      j++;
      while (j < sql.length && sql[j] !== '"') j++;
      if (j < sql.length) j++;
      continue;
    }
    if (c === "-" && sql[j + 1] === "-") {
      while (j < sql.length && sql[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && sql[j + 1] === "*") {
      j += 2;
      while (
        j < sql.length &&
        !(sql[j] === "*" && sql[j + 1] === "/")
      ) {
        j++;
      }
      if (j < sql.length) j += 2;
      continue;
    }
    j++;
  }
  return j > i;
}

export function parseFromClause(sql: string): ParsedFrom | null {
  const lower = sql.toLowerCase();
  type Kw = "from" | "into" | "update";
  const candidates: Array<{ idx: number; key: Kw }> = [];
  for (let i = 0; i < lower.length; i++) {
    if (inSkippedRegion(sql, i)) continue;
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
  }
  if (candidates.length === 0) return null;
  const first = candidates[0];
  const i = skipWs(sql, first.idx + first.key.length);
  const ident = readIdent(sql, i);
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

  const qTable = quoteIdent(tableName, dialect);

  if (edits.length === 0) {
    return { ok: true, statements, warnings };
  }

  const colIdx = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) colIdx.set(columns[i], i);

  // ---- 1) Insert markers → one INSERT per new row ------------------------
  for (const e of edits) {
    if (!isNewRowMarker(e.value)) continue;
    const values = e.value.values;
    if (!Array.isArray(values) || values.length !== columns.length) {
      warnings.push(
        `insert row ${e.rowId}: values length (${values?.length ?? "?"}) does not match column count (${columns.length}); skipped`,
      );
      continue;
    }
    const colList = columns.map((c) => quoteIdent(c, dialect)).join(", ");
    const valueList = values.map((v) => sqlLiteral(v)).join(", ");
    statements.push(
      `INSERT INTO ${qTable} (${colList}) VALUES (${valueList})`,
    );
  }

  // ---- 2) Delete markers → one DELETE per row ----------------------------
  for (const e of edits) {
    if (!isDeleteMarker(e.value)) continue;
    if (pkColumns.length === 0) continue;
    const rowId = e.value.__rowId;
    const serverRow = serverRows[rowId];
    if (!serverRow) {
      warnings.push(`delete row ${rowId} skipped: no server row`);
      continue;
    }
    const whereParts: string[] = [];
    let whereOk = true;
    for (const pk of pkColumns) {
      const ci = colIdx.get(pk);
      if (ci === undefined) {
        whereOk = false;
        warnings.push(
          `delete row ${rowId} skipped: pk column "${pk}" not in result`,
        );
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
    }
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

  const hasPk = pkColumns.length > 0;
  if (!hasPk && dialect !== "postgres") {
    // mysql/mssql without PK: REJECT.
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
    // the redundant UPDATE.
    const hasInsert = edits.some(
      (e) => e.rowId === rowId && isNewRowMarker(e.value),
    );
    if (hasInsert) continue;

    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const e of rowEdits
      .slice()
      .sort((a, b) => a.colIndex - b.colIndex)) {
      const c = columns[e.colIndex];
      if (c === undefined) {
        warnings.push(
          `row ${rowId}: skipped unknown col index ${e.colIndex}`,
        );
        continue;
      }
      cols.push(c);
      vals.push(e.value);
    }
    if (cols.length === 0) continue;

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
        warnings.push(`row ${rowId} skipped: only PK columns edited`);
        continue;
      }
      const setClause = setParts.join(", ");

      const serverRow = serverRows[rowId];
      if (!serverRow) {
        warnings.push(`row ${rowId} skipped: no server row for UPDATE`);
        continue;
      }
      const whereParts: string[] = [];
      let whereOk = true;
      for (const pk of pkColumns) {
        const i = colIdx.get(pk);
        if (i === undefined) {
          whereOk = false;
          warnings.push(
            `row ${rowId} skipped: pk column "${pk}" missing`,
          );
          break;
        }
        whereParts.push(
          `${quoteIdent(pk, dialect)}=${sqlLiteral(serverRow[i])}`,
        );
      }
      if (!whereOk) continue;
      statements.push(
        `UPDATE ${qTable} SET ${setClause} WHERE ${whereParts.join(" AND ")}`,
      );
    } else {
      // postgres no-PK fallback: WHERE ctid = '<literal>'
      const ctid = options.ctidByRowId?.get(rowId);
      if (!ctid) {
        warnings.push(
          `row ${rowId} skipped: postgres no-PK + missing ctid`,
        );
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

  return { ok: true, statements, warnings };
}
