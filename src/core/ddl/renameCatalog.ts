// src/core/ddl/renameCatalog.ts — TASK-DBX06-002
// Parameterized pg_catalog usage analysis + pure plan builder for the
// DBX-06 Safe Rename Refactor. NO vscode. SQL takes bound params ONLY —
// never interpolate user identifiers into WHERE (same rule as
// pgIntrospect.ts).
import { alwaysQuote } from "./alterTable";
import {
  analyzeUsage,
  type RenameCatalogRows,
  type RenameReport,
} from "./renameAnalysis";

// ---------------------------------------------------------------------------
// Catalog usage SQL (parameterized; run with runQuery(sql, [schema, table]))
// ---------------------------------------------------------------------------

/** Views + matviews in schema $1 whose rule depends on table $2. */
export const DEPENDENT_VIEWS_SQL = (): string => `
  SELECT DISTINCT v.relname AS name,
         (CASE WHEN v.relkind = 'm' THEN 'materialized view' ELSE 'view' END) AS kind
    FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_rewrite r
      ON r.oid = d.objid
    JOIN pg_catalog.pg_class v
      ON v.oid = r.ev_class
    JOIN pg_catalog.pg_namespace vn
      ON vn.oid = v.relnamespace
    JOIN pg_catalog.pg_class t
      ON t.oid = d.refobjid
    JOIN pg_catalog.pg_namespace tn
      ON tn.oid = t.relnamespace
   WHERE d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
     AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND vn.nspname = $1
     AND tn.nspname = $1
     AND t.relname  = $2
     AND v.oid <> t.oid
   ORDER BY name
`;

/** FK constraints on other tables referencing table $2 in schema $1. */
export const TABLE_FKS_SQL = (): string => `
  SELECT con.conname AS constraint,
         src.relname  AS from_table
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class src
      ON src.oid = con.conrelid
    JOIN pg_catalog.pg_namespace sn
      ON sn.oid = src.relnamespace
    JOIN pg_catalog.pg_class tgt
      ON tgt.oid = con.confrelid
    JOIN pg_catalog.pg_namespace tn
      ON tn.oid = tgt.relnamespace
   WHERE con.contype = 'f'
     AND tn.nspname = $1
     AND tgt.relname = $2
     AND (sn.nspname <> $1 OR src.relname <> $2)
   ORDER BY constraint
`;

/**
 * Routines in schema $1 whose body mentions $2 — ADVISORY only (the server
 * does not rewrite routine bodies; pg_proc.prosrc contains them).
 */
export const ROUTINES_SQL = (): string => `
  SELECT p.proname AS name
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n
      ON n.oid = p.pronamespace
   WHERE n.nspname = $1
     AND p.prosrc ILIKE '%' || $2 || '%'
   ORDER BY name
`;

/**
 * Name collision for candidate $2 in schema $1 across ordinary tables,
 * views, matviews, sequences and indexes.
 */
export const NAME_COLLISION_SQL = (): string => `
  SELECT c.relname AS name,
         (CASE c.relkind
            WHEN 'r' THEN 'table'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materialized view'
            WHEN 'S' THEN 'sequence'
            WHEN 'i' THEN 'index'
          END) AS kind
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
     AND c.relkind IN ('r', 'v', 'm', 'S', 'i')
`;

// ---------------------------------------------------------------------------
// Pure plan builder
// ---------------------------------------------------------------------------

export type RenameKind = "table" | "column";

export interface RenamePlanRequest {
  kind: RenameKind;
  schema: string;
  table: string;
  oldName: string;
  newName: string;
  rows: RenameCatalogRows;
}

export interface RenamePlan {
  statements: string[];
  report: RenameReport;
  errors: string[];
}

function qualifiedTableRef(schema: string, name: string): string {
  return schema === ""
    ? alwaysQuote(name)
    : `${alwaysQuote(schema)}.${alwaysQuote(name)}`;
}

/**
 * Build the reviewable rename plan. PURE — no I/O, no vscode:
 *  - invalid request (empty names / newName === oldName) → errors only
 *  - collisions present → error listing them, no statements
 *  - otherwise exactly ONE ALTER statement (server-side atomic) + report
 */
export function buildRenamePlan(req: RenamePlanRequest): RenamePlan {
  const errors: string[] = [];
  const usage = analyzeUsage(req.rows);

  if (req.schema === "" || req.table === "" || req.oldName === "") {
    errors.push("Rename requires a schema, table, and current name.");
  }
  if (req.newName === req.oldName) {
    errors.push(
      req.kind === "table"
        ? "New table name is identical to the current name."
        : "New column name is identical to the current name.",
    );
  }

  if (!usage.safe) {
    errors.push(
      `Name collision — target already exists: ${usage.report.collisions.join(", ")}.`,
    );
  }

  if (errors.length > 0) {
    return { statements: [], report: usage.report, errors };
  }

  const t = qualifiedTableRef(req.schema, req.table);
  const statements =
    req.kind === "table"
      ? [`ALTER TABLE ${t} RENAME TO ${alwaysQuote(req.newName)};`]
      : [
          `ALTER TABLE ${t} RENAME COLUMN ${alwaysQuote(req.oldName)} TO ${alwaysQuote(req.newName)};`,
        ];

  return { statements, report: usage.report, errors };
}
