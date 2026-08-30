// src/core/readOnlyIntent.ts
// DBX-05 TASK-DBX05-001 — per-connection read-only intent guard.
// Pure: NO vscode import. Reuses the existing literal/comment masking +
// statement splitter so fake keywords inside strings/comments cannot slip
// through (B6 safety, same contract as dangerousStatement).
import type { SqlDialect } from "./statementParser";
import { splitStatements } from "./statementParser";
import {
  maskLiteralsAndComments,
  isPgBackendAdminCall,
} from "./dangerousStatement";
export class ReadOnlyViolation extends Error {
  /** The offending statement texts (only the mutations, not the whole batch). */
  readonly statements: string[];
  constructor(statements: string[]) {
    super(
      `Connection is marked read-only — mutation blocked: ${statements
        .map((s) => s.slice(0, 80))
        .join(" | ")}`,
    );
    this.name = "ReadOnlyViolation";
    this.statements = statements;
  }
}

/**
 * Leading keywords that mutate data, schema, or permissions. SELECT / WITH
 * (pure CTE select) / EXPLAIN / SHOW / comments-only are NOT mutations.
 * Data-modifying CTEs (WITH ... INSERT/UPDATE/DELETE) ARE mutations.
 */
const MUTATION_KEYWORDS: Record<string, true> = {
  insert: true,
  update: true,
  delete: true,
  merge: true,
  truncate: true,
  drop: true,
  alter: true,
  create: true,
  grant: true,
  revoke: true,
  comment: true,
  lock: true,
};

/** Keyword scan mirroring dangerousStatement.analyzeStatement's depth-0 walk. */
function statementIsMutation(masked: string): boolean {
  const wordRe = /[a-zA-Z_]+/g;
  wordRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  let sawWith = false;
  let sawExplain = false;
  while ((m = wordRe.exec(masked)) !== null) {
    const lower = m[0].toLowerCase();
    if (!sawWith && !sawExplain) {
      if (lower === "explain") {
        sawExplain = true;
        continue;
      }
    } else if (sawExplain) {
      if (lower === "analyze" || lower === "analyse" || lower === "verbose") {
        continue;
      }
      sawExplain = false;
    }
    if (!sawWith) {
      if (lower === "with") {
        sawWith = true;
        continue;
      }
      return MUTATION_KEYWORDS[lower] === true;
    }
    // withMode: only a real statement starter decides.
    if (MUTATION_KEYWORDS[lower] === true) return true;
    if (lower === "select" || lower === "show") return false;
  }
  return false;
}

/** True when ANY statement in `sql` mutates data/schema/permissions. */
export function isMutationSql(sql: string, dialect?: SqlDialect): boolean {
  return mutationStatements(sql, dialect).length > 0;
}

/** Collect the mutation statements of a batch. Empty array = nothing blocked. */
export function mutationStatements(
  sql: string,
  dialect?: SqlDialect,
): string[] {
  const statements = splitStatements(sql, dialect ?? "postgres");
  const bad: string[] = [];
  for (const stmt of statements) {
    const masked = maskLiteralsAndComments(stmt.text, dialect);
    if (statementIsMutation(masked) || isPgBackendAdminCall(masked) !== null) {
      bad.push(stmt.text.trim());
    }
  }
  return bad;
}
