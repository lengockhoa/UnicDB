// src/core/ddl/renameCatalog.ts — TASK-DBX06-002 + DBX06-005
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
// DBX06-005 — trigger / index row mappers (pure; reusable for DBX06-006)
// ---------------------------------------------------------------------------

/** pg_trigger.tgtype bit layout — mirrors pgCatalog.decodeTriggerType. */
function decodeTriggerTypeBits(
  tgtype: number,
): { timing: string; event: string } {
  const events: string[] = [];
  if (tgtype & 4) events.push("INSERT");
  if (tgtype & 8) events.push("DELETE");
  if (tgtype & 16) events.push("UPDATE");
  if (tgtype & 32) events.push("TRUNCATE");
  const event =
    events.length === 0
      ? "ROW"
      : events.length === 3 && (tgtype & 28) === 28
        ? "INSERT OR UPDATE OR DELETE"
        : events.join(" OR ");
  let timing: string;
  if (tgtype & 64) timing = "INSTEAD OF";
  else if (tgtype & 2) timing = "BEFORE";
  else timing = "AFTER";
  return { timing, event };
}

/** Raw pg_trigger row shape returned by TRIGGERS_SQL. */
export interface RawRenameTriggerRow {
  tgname: string;
  tgtype: number;
  tgrelid?: string | null;
}

export function mapRenameTriggerRows(
  rows: RawRenameTriggerRow[],
): Array<{ name: string; event: string; timing: string }> {
  const out: Array<{ name: string; event: string; timing: string }> = [];
  for (const r of rows) {
    if (typeof r?.tgname !== "string") continue;
    const tgtype = typeof r.tgtype === "number" ? r.tgtype : 0;
    const { timing, event } = decodeTriggerTypeBits(tgtype);
    out.push({ name: r.tgname, event, timing });
  }
  return out;
}

const INDEXDEF_PRIMARY_RE = /PRIMARY\s+KEY/i;
const INDEXDEF_UNIQUE_RE = /\bUNIQUE\b/i;
const INDEXDEF_COLS_RE = /\(([^)]*)\)\s*$/;

/**
 * Parse a `pg_get_indexdef(...)` string for the subset the rename
 * preview cares about: isPrimary / isUnique / columns. The full parser
 * in pgCatalog covers more (method, expressions); here we only need
 * the three fields exposed in the typed usage API.
 */
function parseIndexDefForRename(indexdef: string): {
  isPrimary: boolean;
  isUnique: boolean;
  columns: string[];
} {
  const head = indexdef.split(/ ON /i)[0] ?? indexdef;
  const tail = indexdef.split(/ ON /i)[1] ?? "";
  const isPrimary = INDEXDEF_PRIMARY_RE.test(head);
  const isUnique = isPrimary || INDEXDEF_UNIQUE_RE.test(head);
  const m = tail.match(INDEXDEF_COLS_RE);
  const colsRaw = m ? m[1] : "";
  const columns = colsRaw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => c.replace(/^["']|["']$/g, ""));
  return { isPrimary, isUnique, columns };
}

/** Raw pg_index row shape returned by INDEXES_SQL. */
export interface RawRenameIndexRow {
  indexname: string;
  is_primary?: boolean | null;
  is_unique?: boolean | null;
  indexdef: string;
}

export function mapRenameIndexRows(
  rows: RawRenameIndexRow[],
): Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }> {
  const out: Array<{
    name: string;
    isPrimary: boolean;
    isUnique: boolean;
    columns: string[];
  }> = [];
  for (const r of rows) {
    if (typeof r?.indexname !== "string" || typeof r.indexdef !== "string") {
      continue;
    }
    const parsed = parseIndexDefForRename(r.indexdef);
    out.push({
      name: r.indexname,
      isPrimary: r.is_primary === true || parsed.isPrimary,
      isUnique: r.is_primary === true || r.is_unique === true || parsed.isUnique,
      columns: parsed.columns,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalog usage SQL (parameterized; run with runQuery(sql, params))
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

/**
 * Triggers on (schema, table) referencing column $3.
 *
 *  - $1 = schema, $2 = table, $3 = column || "" (table mode passes "")
 *  - column mode matches direct column reference via `tgattr`
 *    AND word-boundary match on the trigger's WHEN predicate `tgqual`
 *  - function body / pg_proc are deliberately excluded (advisory only)
 */
export const TRIGGERS_SQL = (): string => `
  SELECT t.tgname,
         t.tgtype,
         t.tgrelid::regclass::text AS tgrelid
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c
      ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
     AND NOT t.tgisinternal
     AND (
       $3 = ''
       OR EXISTS (
         SELECT 1
           FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_catalog.pg_attribute a
             ON a.attrelid = t.tgrelid
            AND a.attnum = k.attnum
          WHERE a.attname = $3
       )
       OR COALESCE(pg_catalog.pg_get_expr(t.tgqual, t.tgrelid), '') ~* ('\\m' || $3 || '\\M')
     )
   ORDER BY tgname
`;

/**
 * Indexes on (schema, table) referencing column $3.
 *
 *  - $1 = schema, $2 = table, $3 = column || ""
 *  - column mode matches `indkey` direct columns, expression columns
 *    (`indexprs`), and partial-index predicates (`indpred`) via
 *    word-boundary regex
 *  - function bodies (`pg_proc`, `prosrc`, `pg_get_functiondef`) are
 *    deliberately excluded
 */
export const INDEXES_SQL = (): string => `
  SELECT i.indexrelid::regclass::text AS indexname,
         i.indisprimary AS is_primary,
         i.indisunique  AS is_unique,
         pg_catalog.pg_get_indexdef(i.indexrelid) AS indexdef
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class tbl
      ON tbl.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n
      ON n.oid = tbl.relnamespace
   WHERE n.nspname = $1
     AND tbl.relname = $2
     AND (
       $3 = ''
       OR EXISTS (
         SELECT 1
           FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_catalog.pg_attribute a
             ON a.attrelid = i.indrelid
            AND a.attnum = k.attnum
          WHERE k.attnum > 0
            AND a.attname = $3
       )
       OR COALESCE(pg_catalog.pg_get_expr(i.indexprs, i.indrelid), '') ~* ('\\m' || $3 || '\\M')
       OR COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '') ~* ('\\m' || $3 || '\\M')
     )
   ORDER BY indexname
`;

// ---------------------------------------------------------------------------
// Pure plan builder
// ---------------------------------------------------------------------------

export type RenameKind = "table" | "column";

export interface RenameOperation {
  kind: RenameKind;
  schema: string;
  table: string;
  oldName: string;
  newName: string;
}

export interface RenamePlanRequest {
  kind: RenameKind;
  schema: string;
  table: string;
  oldName: string;
  newName: string;
  rows: RenameCatalogRows;
  /**
   * DBX06-005 — optional ordered list of dependent renames. When present
   * it overrides the single-rename legacy surface and `statements` follows
   * the order. When absent the plan still produces a single executable
   * step (backward compatible with TASK-DBX06-001/002/003/004).
   */
  operations?: RenameOperation[];
}

export type RenamePlanStepKind =
  | "rename"
  | "views"
  | "fks"
  | "routines"
  | "triggers"
  | "indexes";

export interface RenamePlanStep {
  kind: RenamePlanStepKind;
  executable: boolean;
  /**
   * SQL for executable steps. Non-executable review steps omit the SQL
   * (or carry an empty string for callers that want a uniform shape).
   */
  statement: string;
  /** When set, points to the single operation that produced this step. */
  operation?: RenameOperation;
}

export interface RenamePlan {
  /** Executable SQL in declared order (DBX06-005 keeps this surface). */
  statements: string[];
  /** Ordered plan: one or more executable rename steps + review steps. */
  steps: RenamePlanStep[];
  report: RenameReport;
  errors: string[];
}

function qualifiedTableRef(schema: string, name: string): string {
  return schema === ""
    ? alwaysQuote(name)
    : `${alwaysQuote(schema)}.${alwaysQuote(name)}`;
}

function renderRenameStatement(op: RenameOperation): string {
  const t = qualifiedTableRef(op.schema, op.table);
  return op.kind === "table"
    ? `ALTER TABLE ${t} RENAME TO ${alwaysQuote(op.newName)};`
    : `ALTER TABLE ${t} RENAME COLUMN ${alwaysQuote(op.oldName)} TO ${alwaysQuote(op.newName)};`;
}

function operationsFromRequest(req: RenamePlanRequest): RenameOperation[] {
  if (req.operations && req.operations.length > 0) return req.operations;
  return [
    {
      kind: req.kind,
      schema: req.schema,
      table: req.table,
      oldName: req.oldName,
      newName: req.newName,
    },
  ];
}

function isSameNameError(req: RenamePlanRequest): string | null {
  if (req.newName === req.oldName) {
    return req.kind === "table"
      ? "New table name is identical to the current name."
      : "New column name is identical to the current name.";
  }
  return null;
}

/**
 * Build the reviewable rename plan. PURE — no I/O, no vscode.
 *
 *  - `operations` (optional, DBX06-005) drives an ordered multi-step plan;
 *    when absent, a single executable step is produced (legacy behavior).
 *  - collision / same-name / empty names → errors only, no steps, no SQL
 *  - `statements` is always the executable SQL in order, for backward
 *    compatibility with the host runner.
 *  - `steps` distinguishes executable rename steps (carry `statement`)
 *    from non-executable review steps (one per populated dependency).
 */
export function buildRenamePlan(req: RenamePlanRequest): RenamePlan {
  const errors: string[] = [];
  const usage = analyzeUsage(req.rows);

  if (req.schema === "" || req.table === "" || req.oldName === "") {
    errors.push("Rename requires a schema, table, and current name.");
  }
  const sameNameErr = isSameNameError(req);
  if (sameNameErr) errors.push(sameNameErr);

  if (!usage.safe) {
    errors.push(
      `Name collision — target already exists: ${usage.report.collisions.join(", ")}.`,
    );
  }

  if (errors.length > 0) {
    return { statements: [], steps: [], report: usage.report, errors };
  }

  const ops = operationsFromRequest(req);
  const execSteps: RenamePlanStep[] = ops.map((op) => ({
    kind: "rename",
    executable: true,
    statement: renderRenameStatement(op),
    operation: op,
  }));

  const reviewSteps: RenamePlanStep[] = [];
  if (usage.report.views.length > 0) {
    reviewSteps.push({ kind: "views", executable: false, statement: "" });
  }
  if (usage.report.fks.length > 0) {
    reviewSteps.push({ kind: "fks", executable: false, statement: "" });
  }
  if (usage.report.routines.length > 0) {
    reviewSteps.push({ kind: "routines", executable: false, statement: "" });
  }
  if (usage.report.triggers.length > 0) {
    reviewSteps.push({ kind: "triggers", executable: false, statement: "" });
  }
  if (usage.report.indexes.length > 0) {
    reviewSteps.push({ kind: "indexes", executable: false, statement: "" });
  }

  const statements = execSteps.map((s) => s.statement);
  return {
    statements,
    steps: [...execSteps, ...reviewSteps],
    report: usage.report,
    errors: [],
  };
}
