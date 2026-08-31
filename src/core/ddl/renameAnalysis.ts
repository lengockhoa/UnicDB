// src/core/ddl/renameAnalysis.ts — TASK-DBX06-001
// PURE rename-usage analysis for the DBX-06 Safe Rename Refactor.
// NO vscode, NO fs, NO net. Consumers: renameCatalog plan builder and the
// rename form host.

export interface RenameCatalogRows {
  /** Views + materialized views whose rule depends on the table. */
  dependentViews: Array<{ name: string; kind: string }>;
  /** FK constraints on OTHER tables referencing this table. */
  referencingFks: Array<{ constraint: string; fromTable: string }>;
  /** Routines whose body mentions the table (advisory only). */
  routines: Array<{ name: string }>;
  /** Target-name collisions, pre-labeled (e.g. "users_bk (table)"). */
  collisions: string[];
}

export interface RenameReport {
  views: Array<{ name: string; kind: string }>;
  fks: Array<{ constraint: string; fromTable: string }>;
  routines: Array<{ name: string }>;
  collisions: string[];
}

export interface RenameUsageSummary {
  report: RenameReport;
  /** views + fks + routines — objects the user should review. */
  usageCount: number;
  /** False only when the rename would collide with an existing relation. */
  safe: boolean;
}

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
// Boundary on the LEFT only — matches containsForbidden in
// readonlySqlParser: `inserted_at` starts "insert" at a boundary and IS
// rejected; `created_at`'s "ate" does not start a keyword at a boundary
// and is allowed. Left-boundary-only avoids false positives on plain
// identifiers that merely END with a keyword.
const FORBIDDEN_RE =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|exec|into)/i;

/**
 * Validate a candidate new name. Returns null when valid; otherwise a
 * human-readable error. Same strictness contract as the agent tools:
 * plain identifiers only (no quotes/dots/whitespace/semicolons — which
 * also makes multi-statement injection impossible), plus a forbidden
 * keyword substring check (inserted_at contains insert).
 */
export function validateNewName(newName: unknown): string | null {
  if (typeof newName !== "string" || newName.length === 0) {
    return "New name must be a non-empty string.";
  }
  if (!PLAIN_IDENTIFIER.test(newName)) {
    return `"${newName}" is not a plain identifier (letters, digits, _, $; must start with a letter or _).`;
  }
  if (FORBIDDEN_RE.test(newName)) {
    return `"${newName}" contains a forbidden SQL keyword.`;
  }
  return null;
}

/** Reduce catalog rows into the review report + safety flags. Pure. */
export function analyzeUsage(rows: RenameCatalogRows): RenameUsageSummary {
  const report: RenameReport = {
    views: rows.dependentViews,
    fks: rows.referencingFks,
    routines: rows.routines,
    collisions: rows.collisions,
  };
  return {
    report,
    usageCount:
      rows.dependentViews.length +
      rows.referencingFks.length +
      rows.routines.length,
    safe: rows.collisions.length === 0,
  };
}
