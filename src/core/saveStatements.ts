// src/core/saveStatements.ts
//
// TASK-503 — translate webview saveEdits payload into per-dialect SQL.
//
// Pure-logic, no DOM, no vscode, no DB driver. Consumes:
//   - EditEntry[]      (same shape as EditState.snapshot() in resultsGridModel.ts)
//   - serverRows       (the webview's authoritative row arrays, indexed by rowId)
//   - pkColumns + tableName (host-derived from statement metadata via listColumns)
//   - optional ctidByRowId map (postgres-only no-PK fallback)
//
// Produces:
//   - { ok: true; statements: string[]; parameters: unknown[]; warnings: string[] }
//     One combined `parameters` array tracks positional placeholders across
//     all statements so the caller can pass it straight to the driver.
//   - { ok: false; reason: 'no_pk'; warnings: string[] }
//     Returned when mysql/mssql get an edits payload but no PK is known.
//
// Dialect rules:
//   - postgres: $N placeholders, plain `table` / `col` identifiers.
//   - mysql:     `?` placeholders, backticks `` `table` `` / `` `col` ``.
//   - mssql:     `?` placeholders, square brackets `[table]` / `[col]`.
//   - postgres no-PK: emit `WHERE ctid = $N` if ctidByRowId is supplied;
//     rows missing a ctid entry are skipped with a warning (host may fetch
//     ctids from the server before replaying). Other dialects without a PK
//     return `{ ok:false; reason:'no_pk' }`.

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
  /** rowId → ctid (string in `'('"'"(x,y)'"'"'` form, or any string form
   *  the driver accepts as a ctid literal). Missing keys → row is skipped
   *  with a warning. */
  ctidByRowId?: ReadonlyMap<number, string>;
}

/** Successful build — `statements` are pushed in execution order; the
 *  caller passes `parameters` straight to the driver (PG: positional, MS:
 *  `?`-ordered, MSSQL: same). `ok` is the discriminator for the union. */
export interface SaveStatementsOk {
  ok: true;
  /** Output SQL, one entry per logical operation. */
  statements: string[];
  /** Per-statement positional parameters — index i corresponds to the
   *  $i+1 (postgres) or i-th `?` (mysql/mssql) placeholder in the joined
   *  statement text. */
  parameters: unknown[];
  /** Non-fatal notes (no_pk_warnings etc.). */
  warnings: string[];
}

/** Soft failure — caller MUST surface `reason` to the user (banner).
 *  `ok: false` is the discriminator. */
export interface SaveStatementsRefused {
  ok: false;
  reason: "no_pk";
  warnings: string[];
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

function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return name; // postgres — caller must quote if needed; we keep plain for host-supplied names.
}

function placeholder(index: number, dialect: Dialect): string {
  if (dialect === "postgres") return `$${index}`;
  return "?";
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
  const parameters: unknown[] = [];
  const warnings: string[] = [];
  const qTable = quoteIdent(tableName, dialect);

  if (edits.length === 0) {
    return { ok: true, statements, parameters, warnings };
  }

  // ---- 1) Insert markers → one INSERT per new row ------------------------
  for (const e of edits) {
    if (!isNewRowMarker(e.value)) continue;
    const values = e.value.values;
    const colList = columns.map((c) => quoteIdent(c, dialect)).join(", ");
    const valueList = values
      .map((v) => {
        parameters.push(v);
        return placeholder(parameters.length, dialect);
      })
      .join(", ");
    statements.push(
      `INSERT INTO ${qTable} (${colList}) VALUES (${valueList})`,
    );
  }

  // ---- 2) Delete markers → one DELETE per row ----------------------------
  for (const e of edits) {
    if (!isDeleteMarker(e.value)) continue;
    if (pkColumns.length === 0) continue; // surfaced via the no_pk gate below.
    const rowId = e.value.__rowId;
    const serverRow = serverRows[rowId];
    if (!serverRow) {
      warnings.push(`delete row ${rowId} skipped: no server row`);
      continue;
    }
    const colIdx = new Map<string, number>();
    for (let i = 0; i < columns.length; i++) colIdx.set(columns[i], i);
    const whereParts: string[] = [];
    let whereOk = true;
    for (const pk of pkColumns) {
      const i = colIdx.get(pk);
      if (i === undefined) {
        whereOk = false;
        warnings.push(`delete row ${rowId} skipped: pk column "${pk}" not in result`);
        break;
      }
      const v = serverRow[i];
      parameters.push(v);
      whereParts.push(
        `${quoteIdent(pk, dialect)}=${placeholder(parameters.length, dialect)}`,
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
    // mysql/mssql without PK: REJECT. We may have already emitted INSERT
    // markers above; those are still useful (new rows don't need PK to
    // be inserted). But the contract says refuse. Return the no_pk gate.
    return {
      ok: false,
      reason: "no_pk",
      warnings: [
        ...warnings,
        `${dialect} has no PRIMARY KEY for "${tableName}"; cannot save cell edits.`,
      ],
    };
  }

  const colIdx = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) colIdx.set(columns[i], i);

  for (const rowId of sortedRowIds) {
    const rowEdits = editsByRow.get(rowId)!;
    // Rows with an INSERT marker are already addressed by the INSERT; skip
    // the redundant UPDATE.
    const hasInsert = edits.some(
      (e) => e.rowId === rowId && isNewRowMarker(e.value),
    );
    if (hasInsert) continue;

    const cols: string[] = [];
    const vals: unknown[] = [];
    for (const e of rowEdits.slice().sort((a, b) => a.colIndex - b.colIndex)) {
      const c = columns[e.colIndex];
      if (c === undefined) {
        warnings.push(`row ${rowId}: skipped unknown col index ${e.colIndex}`);
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
        parameters.push(vals[i]);
        setParts.push(
          `${quoteIdent(c, dialect)}=${placeholder(parameters.length, dialect)}`,
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
          warnings.push(`row ${rowId} skipped: pk column "${pk}" missing`);
          break;
        }
        const v = serverRow[i];
        parameters.push(v);
        whereParts.push(
          `${quoteIdent(pk, dialect)}=${placeholder(parameters.length, dialect)}`,
        );
      }
      if (!whereOk) continue;
      statements.push(
        `UPDATE ${qTable} SET ${setClause} WHERE ${whereParts.join(" AND ")}`,
      );
    } else {
      // postgres no-PK fallback: WHERE ctid = ?
      const ctid = options.ctidByRowId?.get(rowId);
      if (!ctid) {
        warnings.push(
          `row ${rowId} skipped: postgres no-PK + missing ctid`,
        );
        continue;
      }
      const setParts: string[] = [];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        parameters.push(vals[i]);
        setParts.push(
          `${quoteIdent(c, dialect)}=${placeholder(parameters.length, dialect)}`,
        );
      }
      parameters.push(ctid);
      const whereClause = `ctid=${placeholder(parameters.length, dialect)}`;
      statements.push(
        `UPDATE ${qTable} SET ${setParts.join(", ")} WHERE ${whereClause}`,
      );
      warnings.push(
        `row ${rowId}: postgres no-PK fallback used (ctid) — not safe under concurrent writes`,
      );
    }
  }

  return { ok: true, statements, parameters, warnings };
}
