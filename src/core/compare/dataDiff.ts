// src/core/compare/dataDiff.ts
// TASK-DBX03-002 — pure keyed row diff. Rows are INPUTS; this module
// never queries. Deterministic: every output group is sorted by key
// tuple before emit (stable stringify compare, NOT Map order).

export interface CellDiff {
  column: string;
  from: unknown;
  to: unknown;
}

export interface RowChange {
  key: unknown[];
  cellDiffs: CellDiff[];
}

export interface AddedRow {
  key: unknown[];
  row: Record<string, unknown>;
}

export interface DataRowDiff {
  addedRows: AddedRow[];
  removedRows: AddedRow[];
  changedRows: RowChange[];
  duplicateKeyCount: number;
}

export type DataDiffResult =
  | ({ skipped: "no-key" } & Partial<DataRowDiff>)
  | ({ skipped?: undefined } & DataRowDiff);

/** Stable total order over key tuples (null-safe, type-tagged). */
function keyLess(a: unknown[], b: unknown[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) continue;
    const an = typeof av === "number" && typeof bv === "number";
    if (an) return (av as number) < (bv as number);
    // Mixed/other types: stable stringification order (null -> "null").
    const as = String(av);
    const bs = String(bv);
    if (as !== bs) return as < bs;
  }
  return a.length < b.length;
}

function sortKeyed<T extends { key: unknown[] }>(rows: T[]): T[] {
  return rows.sort((a, b) => (keyLess(a.key, b.key) ? -1 : 1));
}

function tupleOf(row: Record<string, unknown>, keys: string[]): unknown[] {
  return keys.map((k) => row[k]);
}

export function diffData(
  keys: string[],
  sourceRows: Record<string, unknown>[],
  targetRows: Record<string, unknown>[],
  columns: string[],
): DataDiffResult {
  if (keys.length === 0) {
    return {
      skipped: "no-key",
      addedRows: [],
      removedRows: [],
      changedRows: [],
      duplicateKeyCount: 0,
    };
  }

  let duplicateKeyCount = 0;

  const buildIndex = (rows: Record<string, unknown>[]) => {
    const map = new Map<string, { key: unknown[]; row: Record<string, unknown> }>();
    for (const row of rows) {
      const key = tupleOf(row, keys);
      const id = JSON.stringify(key);
      if (map.has(id)) {
        duplicateKeyCount++;
        continue; // first occurrence wins
      }
      map.set(id, { key, row });
    }
    return map;
  };

  const source = buildIndex(sourceRows);
  const target = buildIndex(targetRows);

  const valueCols = columns.filter((c) => !keys.includes(c));

  const addedRows: AddedRow[] = [];
  const removedRows: AddedRow[] = [];
  const changedRows: RowChange[] = [];

  for (const [id, entry] of source) {
    const other = target.get(id);
    if (!other) {
      addedRows.push(entry);
      continue;
    }
    const cellDiffs: CellDiff[] = [];
    for (const col of valueCols) {
      const from = entry.row[col];
      const to = other.row[col];
      if (from !== to) {
        // null-safe: identical NaN-ish/primitive equality is enough here;
        // objects are already decoded scalars from the driver.
        cellDiffs.push({ column: col, from, to });
      }
    }
    if (cellDiffs.length > 0) {
      changedRows.push({ key: entry.key, cellDiffs });
    }
  }

  for (const [, entry] of target) {
    if (!source.has(JSON.stringify(entry.key.map((v) => v)))) {
      removedRows.push(entry);
    }
  }

  return {
    addedRows: sortKeyed(addedRows),
    removedRows: sortKeyed(removedRows),
    changedRows: sortKeyed(changedRows),
    duplicateKeyCount,
  };
}
