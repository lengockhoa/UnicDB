// src/core/importer/importTypes.ts
// DBX-01 — shared types for the importer pure modules. No `vscode`,
// no I/O, no Date.now/random. Used by parseCsv/parseJson (DBX01-001),
// applyMapping/buildDryRunPlan (DBX01-002), executeImport (DBX01-003).

/**
 * One parse/coerce failure that a row produced. `line` is 1-based
 * (line 1 = first row of the source, ignoring the header for CSV).
 * `column` is set when the failure is bound to a specific source column
 * (e.g. coercion failure on column `id`); otherwise it is undefined.
 * The wizard surfaces these verbatim.
 */
export interface ImportRowError {
  line: number;
  column?: string;
  message: string;
}

/**
 * Uniform output of `parseCsv` and `parseJson`. `headers` is the column
 * order; `rows[i][j]` is the value at row `i`, column `j`. Empty cells
 * for CSV are `""`; missing JSON keys are `""`; explicit JSON `null`
 * is `null` (the mapper treats `null` distinctly from `""`).
 */
export interface ImportParseResult {
  headers: string[];
  rows: Array<Array<string | null>>;
  errors: ImportRowError[];
}
