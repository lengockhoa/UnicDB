// src/core/compare/syncPlan.ts
// TASK-DBX03-003 — directional (source->target) sync plan builder.
// Pure data structure: NO execution path, NO vscode import. Data
// statements carry $N placeholders with parallel `values` arrays —
// never literal row values in SQL text.

import { quoteIdent } from "../importer/importDryRun";
import type { SchemaDiffResult, TableShape } from "./schemaDiff";
import type { DataRowDiff, DataDiffResult } from "./dataDiff";

export interface SyncStatement {
  sql: string;
  summary: string;
  dangerous?: boolean;
  values?: unknown[];
}

export interface SyncGroup {
  id: "ddl" | "data";
  statements: SyncStatement[];
}

export interface SyncPlan {
  direction: "source->target";
  executable: boolean;
  reasons: string[];
  groups: SyncGroup[];
  totals: { ddl: number; data: number };
}

export interface SyncPlanTables {
  sourceTable: { schema: string; table: string };
  targetTable: { schema: string; table: string };
}

function qualified(t: { schema: string; table: string }): string {
  return `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`;
}

export function buildSyncPlan(opts: {
  source: TableShape;
  target: TableShape;
  schemaDiff: SchemaDiffResult;
  dataDiff: DataDiffResult;
  sourceTable: { schema: string; table: string };
  targetTable: { schema: string; table: string };
}): SyncPlan {
  const { source, target, schemaDiff, dataDiff, sourceTable, targetTable } = opts;

  const reasons: string[] = [];
  if (!schemaDiff.compatible) {
    const broken = schemaDiff.entries
      .filter((e) => e.kind === "added" || e.kind === "dropped" || (e.kind === "changed" && e.change === "type"))
      .map((e) => (e.kind === "pk-changed" ? "(primary key)" : e.column));
    reasons.push(
      `Schema shapes are incompatible (columns/type sets differ: ${[...new Set(broken)].join(", ") || "unknown"}); ` +
        "sync data requires identical column names and types.",
    );
  }
  if (dataDiff.skipped === "no-key") {
    reasons.push("No usable key (primary key) — row-level sync statements cannot be generated safely.");
  }

  const targetQ = qualified(targetTable);
  const sourceQ = qualified(sourceTable);

  // ---- DDL group: ADD COLUMN -> ALTER -> DROP COLUMN ----
  const ddl: SyncStatement[] = [];
  const targetCols = new Map(target.columns.map((c) => [c.name, c]));

  for (const entry of schemaDiff.entries) {
    if (entry.kind === "added") {
      const col = source.columns.find((c) => c.name === entry.column);
      if (!col) continue;
      const nullSql = col.nullable ? "" : " NOT NULL";
      const defSql = col.defaultValue !== null ? ` DEFAULT ${col.defaultValue}` : "";
      ddl.push({
        sql: `ALTER TABLE ${targetQ} ADD COLUMN ${quoteIdent(col.name)} ${col.dataType}${nullSql}${defSql};`,
        summary: `Add column "${entry.column}" (${col.dataType})`,
      });
    }
  }
  for (const entry of schemaDiff.entries) {
    if (entry.kind !== "changed") continue;
    const targetCol = targetCols.get(entry.column);
    if (entry.change === "type") {
      ddl.push({
        sql: `ALTER TABLE ${targetQ} ALTER COLUMN ${quoteIdent(entry.column)} TYPE ${entry.to};`,
        summary: `Change type of "${entry.column}": ${entry.from} -> ${entry.to}`,
      });
    } else if (entry.change === "nullable") {
      ddl.push({
        sql:
          entry.to === true
            ? `ALTER TABLE ${targetQ} ALTER COLUMN ${quoteIdent(entry.column)} DROP NOT NULL;`
            : `ALTER TABLE ${targetQ} ALTER COLUMN ${quoteIdent(entry.column)} SET NOT NULL;`,
        summary: `Make "${entry.column}" ${entry.to === true ? "nullable" : "NOT NULL"}`,
      });
    } else if (entry.change === "default") {
      ddl.push({
        sql:
          entry.to === null
            ? `ALTER TABLE ${targetQ} ALTER COLUMN ${quoteIdent(entry.column)} DROP DEFAULT;`
            : `ALTER TABLE ${targetQ} ALTER COLUMN ${quoteIdent(entry.column)} SET DEFAULT ${entry.to};`,
        summary: `Set default of "${entry.column}" to ${entry.to === null ? "(none)" : String(entry.to)}`,
      });
    }
    void targetCol;
  }
  for (const entry of schemaDiff.entries) {
    if (entry.kind === "dropped") {
      ddl.push({
        sql: `ALTER TABLE ${targetQ} DROP COLUMN ${quoteIdent(entry.column)};`,
        summary: `Drop column "${entry.column}" (exists only in target)`,
        dangerous: true,
      });
    }
  }

  // ---- Data group: INSERT -> UPDATE -> DELETE ----
  const data: SyncStatement[] = [];
  const rows: DataRowDiff | null =
    dataDiff.skipped === "no-key" ? null : (dataDiff as DataRowDiff);
  const cols = source.columns.map((c) => c.name);
  const keyCols: string[] = source.primaryKeys;

  if (schemaDiff.compatible && rows !== null) {
    for (const added of rows.addedRows) {
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      data.push({
        sql: `INSERT INTO ${targetQ} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")});`,
        summary: `Insert row ${JSON.stringify(added.key)}`,
        values: cols.map((c) => added.row[c]),
      });
    }

    for (const change of rows.changedRows) {
      const setCols = change.cellDiffs.map((d) => d.column);
      const whereParts = keyCols.map((k, i) => `${quoteIdent(k)} = $${setCols.length + i + 1}`);
      data.push({
        sql: `UPDATE ${targetQ} SET ${setCols
          .map((c, i) => `${quoteIdent(c)} = $${i + 1}`)
          .join(", ")} WHERE ${whereParts.join(" AND ")};`,
        summary: `Update row ${JSON.stringify(change.key)} (${change.cellDiffs.map((d) => d.column).join(", ")})`,
        values: [...change.cellDiffs.map((d) => d.to), ...change.key],
      });
    }

    for (const removed of rows.removedRows) {
      data.push({
        sql: `DELETE FROM ${targetQ} WHERE ${keyCols
          .map((k, i) => `${quoteIdent(k)} = $${i + 1}`)
          .join(" AND ")};`,
        summary: `Delete row ${JSON.stringify(removed.key)} (exists only in target)`,
        dangerous: true,
        values: keyCols.map((k, i) => removed.key[i]),
      });
    }
  }

  const executable = reasons.length === 0;

  return {
    direction: "source->target",
    executable,
    reasons,
    groups: [
      { id: "ddl", statements: ddl },
      { id: "data", statements: data },
    ],
    totals: { ddl: ddl.length, data: executable ? data.length : 0 },
  };
}
