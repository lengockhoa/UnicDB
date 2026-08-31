// src/ai/tools/changePlanTool.ts — TASK-AIX04-002
// plan_change agent tool: turns an AI suggestion into a REVIEWED change
// plan (danger tiers + schema drift) WITHOUT executing anything.
// Same contracts as dbAwareTools/analysisTools: NO vscode import, adapter
// injected via AdapterFactory, never throws (envelopes), identifier guard
// before any adapter use. The consent path (confirmDangerousStatements)
// lives in the host — this tool NEVER calls runQuery on the statements.
import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import { containsForbidden } from "./readonlySqlParser";
import {
  classifyStatements,
  validatePlanStatements,
  detectDrift,
  type PlanStatement,
} from "../changePlan";
import { splitStatements } from "../../core/statementParser";

const NO_CONNECTION_MSG =
  "No active database connection. Connect to a database first, then retry.";

function badIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "schema and table must be non-empty strings";
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    return `"${value}" is not a plain identifier`;
  }
  if (containsForbidden(value)) {
    return `"${value}" contains a forbidden SQL keyword`;
  }
  return null;
}

/**
 * Extract plausible column-name tokens from statement SQL for the drift
 * comparison: identifiers following `SET`/`ADD COLUMN`/`COLUMN`/`(`…`)`
 * are overkill — a conservative heuristic suffices: collect every
 * snake/camel identifier token and compare against the fingerprint. The
 * drift report is advisory; the host re-checks before apply.
 */
export function claimedColumns(sql: string[]): string[] {
  const out = new Set<string>();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const s of sql) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const tok = m[1]!;
      const lower = tok.toLowerCase();
      if (
        ["select", "from", "where", "set", "and", "or", "not", "null",
          "update", "delete", "insert", "into", "values", "table",
          "alter", "add", "column", "drop", "grant", "revoke", "on",
          "to", "with", "as", "by", "order", "group", "having", "join",
          "inner", "left", "right", "outer", "limit", "offset"].includes(lower)
      ) {
        continue;
      }
      out.add(tok);
    }
  }
  return Array.from(out);
}

export type FingerprintFn = (
  schema: string,
  table: string,
) => Promise<string[]>;

export function createPlanChangeTool(
  f: AdapterFactory,
  fingerprint: FingerprintFn,
): AgentTool {
  return {
    name: "plan_change",
    description:
      "Turn an AI suggestion into a REVIEWED change plan: candidate SQL " +
      "statements are classified (destructive/DDL/DML danger tiers), and " +
      "when a target table is given, the plan is checked against the " +
      "current schema for drift (stale-plan guard). READ-ONLY — this tool " +
      "NEVER executes SQL; the host shows the plan and asks for explicit " +
      "confirmation before any statement runs.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", description: "what the change is meant to do" },
        statements: {
          type: "array",
          items: { type: "string" },
          description: "candidate SQL statements (may be empty to ask for a review-only plan)",
        },
        targetSchema: { type: "string", description: "schema for the drift check (default public)" },
        targetTable: { type: "string", description: "table for the drift check" },
      },
      required: ["intent"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const statements = Array.isArray(args.statements)
          ? args.statements.filter((s): s is string => typeof s === "string")
          : [];

        const schema = typeof args.targetSchema === "string" ? args.targetSchema : "public";
        const table = typeof args.targetTable === "string" ? args.targetTable : "";

        if (table !== "") {
          const bad = badIdentifier(schema) ?? badIdentifier(table);
          if (bad !== null) {
            return JSON.stringify({ ok: false, error: bad });
          }
        }

        const errors = validatePlanStatements(
          statements.length > 0 ? statements : undefined,
        );
        if (errors.length > 0) {
          return JSON.stringify({ ok: false, error: errors.join(" ") });
        }
        // Flatten multi-statement candidates BEFORE classification so the
        // card's tier/unit granularity equals the consent + apply granularity:
        // "SELECT 1; DROP TABLE x" renders as two items (none + red), never
        // as one safe-looking item.
        const flat = statements.flatMap((s) =>
          splitStatements(s).map((st) => st.text),
        );

        // Drift guard (advisory): only when a target table is named.
        let drift: string[] = [];
        if (table !== "") {
          const adapter = await f();
          if (!adapter) return JSON.stringify({ ok: false, error: NO_CONNECTION_MSG });
          const current = await fingerprint(schema, table);
          drift = detectDrift(current, claimedColumns(flat));
        }

        const plan = {
          intent: typeof args.intent === "string" ? args.intent : "",
          statements: classifyStatements(flat) as PlanStatement[],
          drift,
          drifted: drift.length > 0,
          // AIX-04: echoed so the HOST can re-check drift at consent time
          // (stale-plan guard) before any statement is executed.
          targetSchema: table !== "" ? schema : undefined,
          targetTable: table !== "" ? table : undefined,
        };
        return JSON.stringify({ ok: true, plan });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

export function createChangePlanTools(
  f: AdapterFactory,
  fingerprint?: FingerprintFn,
): AgentTool[] {
  const fp =
    fingerprint ??
    (async () => {
      return [];
    });
  return [createPlanChangeTool(f, fp)];
}
