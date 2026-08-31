// src/ai/changePlan.ts — TASK-AIX04-001
// PURE change-plan classification for the AIX-04 Database Change Workflow.
// NO vscode, NO fs, NO net. Consumed by the plan_change agent tool and the
// chat-panel consent flow.
import { analyzeStatement, guardTier } from "../core/dangerousStatement";
import { splitStatements, type SqlDialect } from "../core/statementParser";

export type PlanTier = "red" | "amber" | "none" | "admin-red";

export interface PlanStatement {
  sql: string;
  kind: string;
  hasWhere: boolean;
  tier: PlanTier;
  dangerNote: string;
}

const DANGER_NOTES: Record<string, string> = {
  red: "destructive — will be confirmed",
  "admin-red": "admin DCL — separate consent required",
};

/**
 * Classify each candidate statement via the existing pure guard
 * (analyzeStatement + guardTier) so the plan carries the SAME danger
 * semantics the confirm path uses — no second opinion, no reimplementation.
 */
export function classifyStatements(
  sql: string[],
  dialect?: SqlDialect,
): PlanStatement[] {
  return sql.map((s) => {
    const a = analyzeStatement(s, dialect);
    const tier = guardTier(a) as PlanTier;
    return {
      sql: s,
      kind: a.kind,
      hasWhere: a.hasWhere,
      tier,
      dangerNote: DANGER_NOTES[tier] ?? "",
    };
  });
}

/**
 * Validate that the candidate statements are usable as a plan.
 * Returns human-readable errors; empty array when valid.
 */
export function validatePlanStatements(sql: unknown, dialect?: SqlDialect): string[] {
  if (!Array.isArray(sql) || sql.length === 0) {
    return ["At least one SQL statement is required."];
  }
  const errors: string[] = [];
  for (const s of sql) {
    if (typeof s !== "string" || s.trim().length === 0) {
      errors.push("Every plan statement must be a non-empty SQL string.");
      continue;
    }
    try {
      const parsed = splitStatements(s, dialect);
      if (parsed.length === 0) {
        errors.push(`Statement does not parse: ${s.slice(0, 60)}`);
      }
    } catch {
      errors.push(`Statement does not parse: ${s.slice(0, 60)}`);
    }
  }
  return errors;
}

/**
 * Symmetric set difference of column-name sets — the stale-plan/schema
 * drift guard. Sorted for stable output.
 */
export function detectDrift(current: string[], claimed: string[]): string[] {
  const c = new Set(current);
  const k = new Set(claimed);
  const out = new Set<string>();
  for (const n of current) if (!k.has(n)) out.add(n);
  for (const n of claimed) if (!c.has(n)) out.add(n);
  return Array.from(out).sort();
}
