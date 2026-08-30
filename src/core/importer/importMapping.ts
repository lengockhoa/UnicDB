// src/core/importer/importMapping.ts
// DBX-01-002 — pure mapping layer. Consumes an `ImportParseResult`
// and a list of `ColumnMapping` declarations, projects rows to the
// target column order, and coerces per-column types opt-in. No `vscode`,
// no I/O, no Date.now/random.

import type { ImportParseResult, ImportRowError } from "./importTypes";

export type CoercionType = "text" | "int" | "numeric" | "bool" | "timestamp" | "json";

export interface ColumnMapping {
  source: string;
  target: string;
  type: CoercionType;
}

export interface MappedRows {
  /**
   * One entry per surviving source row, in source order. Each inner
   * array is in target-column order (the order given to
   * `applyMapping`). Values are either the coerced JavaScript value
   * (number / boolean / Date / object) or the source string for
   * "text" / null for explicit nulls.
   */
  values: unknown[][];
  /**
   * Coercion / structural errors that caused a row to be dropped. The
   * dry-run + execute layers treat this as authoritative — a row
   * with an error is gone from `values`.
   */
  errors: ImportRowError[];
}

/**
 * Apply a `ColumnMapping[]` to a parsed source.
 *
 * The output `values[i]` is a row in target order. Source columns
 * NOT named in the mapping are dropped (the mapping list is the
 * authoritative target column set).
 *
 * @param parse The parse result.
 * @param mapping The user-defined column mappings (source → target).
 * @param requiredTargets Target columns the table REQUIRES. Any
 *   required target not covered by a mapping entry becomes a fatal
 *   error (the import is refused).
 */
export function applyMapping(
  parse: ImportParseResult,
  mapping: readonly ColumnMapping[],
  requiredTargets: readonly string[],
): MappedRows {
  const errors: ImportRowError[] = [];

  // Detect missing required targets BEFORE walking rows. We emit
  // exactly one error (the first missing required column) so the
  // wizard can show a single actionable message.
  const targetsCovered = new Set(mapping.map((m) => m.target));
  for (const req of requiredTargets) {
    if (!targetsCovered.has(req)) {
      errors.push({
        line: 0,
        column: req,
        message: `Required target column "${req}" is not mapped`,
      });
      break;
    }
  }
  if (errors.length > 0) {
    return { values: [], errors };
  }

  const sourceIndex = new Map<string, number>();
  parse.headers.forEach((h, i) => sourceIndex.set(h, i));
  for (const m of mapping) {
    if (!sourceIndex.has(m.source)) {
      errors.push({
        line: 0,
        column: m.source,
        message: `Mapping source column "${m.source}" is not present in the parse result`,
      });
    }
  }
  if (errors.length > 0) {
    return { values: [], errors };
  }

  // Final column list = explicit mapping targets, in mapping order.
  const finalColumns: Array<{ header: string; type: CoercionType; source: string }> = mapping.map(
    (m) => ({ header: m.target, type: m.type, source: m.source }),
  );

  const values: unknown[][] = [];
  for (let rowIdx = 0; rowIdx < parse.rows.length; rowIdx++) {
    const srcRow = parse.rows[rowIdx] ?? [];
    const out: unknown[] = new Array(finalColumns.length);
    let rowHasError = false;
    for (let colIdx = 0; colIdx < finalColumns.length; colIdx++) {
      const col = finalColumns[colIdx];
      if (col === undefined) continue;
      const sourcePos = sourceIndex.get(col.source);
      if (sourcePos === undefined) {
        out[colIdx] = "";
        continue;
      }
      const raw = srcRow[sourcePos] ?? "";
      const coerced = coerceValue(raw, col.type, errors, {
        line: rowIdx + 2, // +1 for 1-based, +1 for header.
        column: col.source,
      });
      if (coerced === COERCION_ERROR) {
        rowHasError = true;
        out[colIdx] = null;
        break;
      }
      out[colIdx] = coerced;
    }
    if (rowHasError) continue;
    values.push(out);
  }

  return { values, errors };
}

const COERCION_ERROR = Symbol("coercion-error");

interface ErrorCtx {
  line: number;
  column: string;
}

function coerceValue(
  raw: string | null,
  type: CoercionType,
  errors: ImportRowError[],
  ctx: ErrorCtx,
): unknown {
  if (raw === null) {
    return null;
  }
  switch (type) {
    case "text":
      return raw;
    case "int": {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      if (!/^-?\d+$/.test(trimmed)) {
        errors.push({
          line: ctx.line,
          column: ctx.column,
          message: `Cannot coerce "${raw}" to int`,
        });
        return COERCION_ERROR;
      }
      return Number.parseInt(trimmed, 10);
    }
    case "numeric": {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        errors.push({
          line: ctx.line,
          column: ctx.column,
          message: `Cannot coerce "${raw}" to numeric`,
        });
        return COERCION_ERROR;
      }
      return n;
    }
    case "bool": {
      const trimmed = raw.trim().toLowerCase();
      if (["true", "1"].includes(trimmed)) return true;
      if (["false", "0"].includes(trimmed)) return false;
      errors.push({
        line: ctx.line,
        column: ctx.column,
        message: `Cannot coerce "${raw}" to bool (expected true/false/1/0)`,
      });
      return COERCION_ERROR;
    }
    case "timestamp": {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      if (trimmed.length > 64) {
        errors.push({
          line: ctx.line,
          column: ctx.column,
          message: `Timestamp too long (${trimmed.length} chars)`,
        });
        return COERCION_ERROR;
      }
      return trimmed;
    }
    case "json": {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        errors.push({
          line: ctx.line,
          column: ctx.column,
          message: `Cannot parse JSON: ${(err as Error).message}`,
        });
        return COERCION_ERROR;
      }
    }
  }
}
