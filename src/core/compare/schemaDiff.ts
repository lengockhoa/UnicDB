// src/core/compare/schemaDiff.ts
// TASK-DBX03-001 — pure schema diff between two table shapes.
// vscode-free; adapter-free (host maps listTableDetail via
// shapeFromTableDetail). Deterministic ordering: source column order
// first, then target-only columns alphabetical.

import type { TableDetail } from "../../adapters/types";

export interface TableColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface TableShape {
  columns: TableColumn[];
  primaryKeys: string[];
}

export type SchemaDiffEntry =
  | { kind: "added"; column: string; position: number }
  | { kind: "dropped"; column: string }
  | {
      kind: "changed";
      column: string;
      change: "type" | "nullable" | "default";
      from: string | boolean | null;
      to: string | boolean | null;
    }
  | { kind: "pk-changed"; from: string[]; to: string[] };

export interface SchemaDiffResult {
  identical: boolean;
  compatible: boolean;
  entries: SchemaDiffEntry[];
}

function samePk(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function diffSchema(source: TableShape, target: TableShape): SchemaDiffResult {
  const entries: SchemaDiffEntry[] = [];

  const targetByName = new Map(target.columns.map((c) => [c.name, c]));
  const sourceNames = new Set(source.columns.map((c) => c.name));

  for (let i = 0; i < source.columns.length; i++) {
    const sc = source.columns[i]!;
    const tc = targetByName.get(sc.name);
    if (!tc) {
      entries.push({ kind: "added", column: sc.name, position: i });
      continue;
    }
    if (sc.dataType !== tc.dataType) {
      entries.push({ kind: "changed", column: sc.name, change: "type", from: sc.dataType, to: tc.dataType });
    }
    if (sc.nullable !== tc.nullable) {
      entries.push({ kind: "changed", column: sc.name, change: "nullable", from: sc.nullable, to: tc.nullable });
    }
    if ((sc.defaultValue ?? null) !== (tc.defaultValue ?? null)) {
      entries.push({ kind: "changed", column: sc.name, change: "default", from: sc.defaultValue, to: tc.defaultValue });
    }
  }

  const dropped = target.columns
    .filter((c) => !sourceNames.has(c.name))
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of dropped) {
    entries.push({ kind: "dropped", column: name });
  }

  if (!samePk(source.primaryKeys, target.primaryKeys)) {
    entries.push({ kind: "pk-changed", from: source.primaryKeys, to: target.primaryKeys });
  }

  const sameColumns =
    source.columns.length === target.columns.length &&
    source.columns.every((sc) => {
      const tc = targetByName.get(sc.name);
      return tc !== undefined && sc.dataType === tc.dataType;
    });

  return {
    identical: entries.length === 0,
    compatible: sameColumns,
    entries,
  };
}

/** Map adapter.listTableDetail output into a TableShape. */
export function shapeFromTableDetail(detail: TableDetail): TableShape {
  const columns: TableColumn[] = detail.columns.map((c) => ({
    name: c.column_name,
    dataType: c.format_type,
    nullable: c.is_nullable === "YES",
    defaultValue: c.column_default,
  }));

  const primaryKeys: string[] = [];
  for (const con of detail.constraints) {
    if (con.contype !== "p") continue;
    for (const ordinal of con.conkey) {
      const col = columns[ordinal - 1]; // conkey is 1-based attnum
      if (col) primaryKeys.push(col.name);
    }
    break; // one PK constraint per table
  }

  return { columns, primaryKeys };
}
