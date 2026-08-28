// src/core/ddl/pgCatalog.ts
//
// TASK-AF-001 — pgCatalog pure module.
// Pure SQL template constants + typed row mappers. NO vscode / pg imports —
// unit-testable in isolation. The PostgresAdapter wires these through its
// existing `pool.query(sql, params)` path.
//
// All identifiers go through `quoteIdent` (PostgreSQL identifier-quoting:
// wrap in `"…"` and double internal `"`). SQL identifiers never interpolate
// raw into the template; $1/$2 bind through pool params.

// =============================================================================
// Public types — TASK-AF-001 §Interfaces (consumed by AF-002 schema tree).
// =============================================================================

export interface IndexInfo {
  name: string;
  schema: string;
  table: string;
  isUnique: boolean;
  method: string;
  columns: string[];
}

export type ConstraintType = "pk" | "fk" | "unique" | "check";

export interface TableConstraintInfo {
  name: string;
  type: ConstraintType;
  columns: string[];
  fkTarget?: { table: string; schema?: string; columns: string[] };
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  statement: string;
}

export interface SequenceInfo {
  name: string;
  schema: string;
  dataType: string;
  lastValue?: string;
}

// =============================================================================
// Raw row shapes returned by SQL templates. Internal to this module.
// =============================================================================

/** Raw row from indexesSql — pg_indexes-shaped output. */
interface IndexRow {
  indexname: string;
  schemaname: string;
  tablename: string;
  indexdef: string;
}

/** Raw row from constraintsSql — pg_constraint + pg_attribute resolution. */
interface ConstraintRow {
  conname: string;
  contype: string; // 'p' | 'f' | 'u' | 'c'
  conkeycols: string[];
  consrc?: string | null;
  confrelidname?: string | null;
  confkeycols?: string[] | null;
}

/** Raw row from triggersSql — pg_trigger-shaped output. */
interface TriggerRow {
  tgname: string;
  tgtype: number;
  tgrelid?: string | null;
  action_statement: string;
}

/** Raw row from sequencesSql — pg_sequences-shaped output. */
interface SequenceRow {
  schemaname: string;
  sequencename: string;
  data_type: string;
  last_value: string | null;
}

// =============================================================================
// Identifier quoting — PostgreSQL: ".." wrapper, double internal ".
// =============================================================================

/**
 * Quote a PostgreSQL identifier. Doubles internal `"` per SQL spec. Empty /
 * zero-length identifiers throw a structured `pgCatalog.identifier` error so
 * downstream SQL never sees a malformed fragment.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      "pgCatalog.identifier: empty or non-string identifier rejected",
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Compose `"schema"."table"` fragment with quoteIdent. */
function qname(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

// =============================================================================
// Structured error helpers — single namespace prefix lets callers grep.
// =============================================================================

export function objectNotFoundError(
  kind: string,
  name: string,
  schema?: string,
): Error {
  const where = schema ? `${schema}.${name}` : name;
  return new Error(
    `pgCatalog.objectDdl: object not found (${kind} ${where})`,
  );
}

// =============================================================================
// SQL templates — TASK-AF-001 §3 (Approach). All parameterized.
// =============================================================================

/**
 * Indexes for one (schema, table). Wraps `pg_indexes` for shape uniformity;
 * the WHERE filters by schema + tablename. Order: indexname ASC for stable
 * UI display. Schema/table bind through $1/$2.
 */
export function indexesSql(_schema?: string, _table?: string): string {
  return `
  SELECT indexname,
         schemaname,
         tablename,
         indexdef
    FROM pg_indexes
   WHERE schemaname = $1
     AND tablename  = $2
   ORDER BY indexname
`;
}

/**
 * Constraints (PK / FK / unique / check) for one (schema, table). Pulls
 * `conkey` and `confkey` from pg_constraint, then resolves to column names
 * via pg_attribute so we don't need text[] parsing in the adapter.
 *
 * $1 = schema, $2 = table.
 */
export function constraintsSql(_schema?: string, _table?: string): string {
  return `
  SELECT con.conname,
         con.contype,
         COALESCE(
           (
             SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a
                 ON a.attrelid = con.conrelid
                AND a.attnum  = k.attnum
           ),
           ARRAY[]::name[]
         ) AS conkeycols,
         pg_get_constraintdef(con.oid, true) AS consrc,
         con.confrelid::regclass::text AS confrelidname,
         (
           SELECT array_agg(a.attname ORDER BY k.ord)
             FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = con.confrelid
                AND a.attnum  = k.attnum
         ) AS confkeycols
    FROM pg_constraint con
    JOIN pg_class     c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
   ORDER BY con.contype, con.conname
`;
}

/**
 * Triggers attached to one (schema, table). tgtype encodes timing/event
 * bits per pg_trigger docs; we decode them in the mapper.
 *
 * $1 = schema, $2 = table.
 */
export function triggersSql(_schema?: string, _table?: string): string {
  return `
  SELECT t.tgname,
         t.tgtype,
         c.relname AS tgrelid,
         pg_get_triggerdef(t.oid, true) AS action_statement
    FROM pg_trigger t
    JOIN pg_class     c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1
     AND c.relname = $2
     AND NOT t.tgisinternal
   ORDER BY t.tgname
`;
}

/**
 * Sequences in one schema (across all tables). Pulled from `pg_sequences`
 * for shape parity with the rest of the catalog (data_type + last_value).
 *
 * $1 = schema.
 */
export function sequencesSql(_schema?: string): string {
  return `
  SELECT schemaname,
         sequencename,
         data_type,
         last_value::text AS last_value
    FROM pg_sequences
   WHERE schemaname = $1
   ORDER BY sequencename
`;
}

/**
 * Row count for one (schema, table). `quoteIdent` is safe for arbitrary
 * identifiers including embedded quotes (the helper doubles them). The
 * `schema.table` form is reconstructed as a quoted fragment, NOT bound
 * through $N — PG identifiers can't go through prepared-statement params,
 * but `quoteIdent` is the canonical safe wrapper.
 *
 * The test plan (TASK-AF-001 §4) accepts either: pure identifier path
 * (safe via quoteIdent) OR prepared-statement path. We use quoteIdent
 * here so the SQL stays a single statement (no PREPARE/EXECUTE round-trip).
 */
export function rowCountSql(schema: string, table: string): string {
  return `SELECT COUNT(*)::bigint AS n FROM ${qname(schema, table)}`;
}

// =============================================================================
// Object DDL — view / routine / trigger via pg_get_*.
// =============================================================================

/**
 * SQL returning the actual DDL text for a view / routine / trigger.
 *
 * - kind="view":     pg_get_viewdef wraps the SELECT body; we reconstruct
 *                    `CREATE VIEW <qname> AS <body>` for symmetry with
 *                    pg_dump output.
 * - kind="routine":  pg_get_functiondef already includes `CREATE FUNCTION`.
 * - kind="trigger":  pg_get_triggerdef emits `CREATE TRIGGER ...`.
 *
 * All paths use `quoteIdent` / `quoteLiteral` so even hostile identifiers
 * (embedded `"` or `'`) stay safe.
 *
 * 0 rows from the SQL ⇒ caller rejects with `objectNotFoundError`.
 */
export function objectDdlSql(
  kind: "view" | "routine" | "trigger",
  name: string,
  schema?: string,
): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `pgCatalog.objectDdl.${kind}: empty identifier rejected`,
    );
  }
  const safeSchema = schema && schema.length > 0 ? schema : "public";

  if (kind === "view") {
    return `
      SELECT pg_get_viewdef(
               ${quoteIdent(safeSchema)}.${quoteIdent(name)}::regclass,
               true
             ) AS ddl
    `;
  }

  if (kind === "routine") {
    const qualified = `${safeSchema}.${name}`;
    return `
      SELECT pg_get_functiondef(
               ${quoteLiteral(qualified)}::regproc::oid
             ) AS ddl
    `;
  }

  if (kind === "trigger") {
    return `
      SELECT pg_get_triggerdef(t.oid, true) AS ddl
        FROM pg_trigger    t
        JOIN pg_class      c ON c.oid = t.tgrelid
        JOIN pg_namespace  n ON n.oid = c.relnamespace
       WHERE n.nspname = ${quoteLiteral(safeSchema)}
         AND c.relname = $1
         AND t.tgname  = ${quoteLiteral(name)}
         AND NOT t.tgisinternal
    `;
  }

  throw new Error(`pgCatalog.objectDdl: unknown kind "${String(kind)}"`);
}

/** Quote a SQL literal — single quotes, doubled internal single quotes. */
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// =============================================================================
// Row mappers — pure functions, no DB access.
// =============================================================================

/**
 * Parse `pg_indexes.indexdef` rows into structured IndexInfo. Defensive:
 * malformed rows are skipped, never thrown.
 *
 * `indexdef` looks like:
 *   CREATE [UNIQUE] INDEX <name> ON <tbl> USING <method> (<col-list>)
 *     [WHERE ...] [INCLUDE (...) | WITH (...) | TABLESPACE ...]
 */
export function rowsToIndexes(rows: unknown[]): IndexInfo[] {
  const out: IndexInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<IndexRow>;
    if (
      typeof r.indexname !== "string" ||
      typeof r.schemaname !== "string" ||
      typeof r.tablename !== "string" ||
      typeof r.indexdef !== "string"
    ) {
      continue;
    }
    const parsed = parseIndexDef(r.indexdef);
    if (!parsed) continue;
    out.push({
      name: r.indexname,
      schema: r.schemaname,
      table: r.tablename,
      isUnique: parsed.isUnique,
      method: parsed.method,
      columns: parsed.columns,
    });
  }
  return out;
}

function parseIndexDef(def: string): null | {
  isUnique: boolean;
  method: string;
  columns: string[];
} {
  // Examples we accept:
  //   CREATE UNIQUE INDEX idx_a ON public.t USING btree (a)
  //   CREATE INDEX idx_b ON public.t USING btree (lower(b))
  //   CREATE INDEX idx_c ON public.t USING gin (a, b)
  //   CREATE UNIQUE INDEX idx_d ON public.t USING btree (a, b) WHERE active
  const m = def.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+(?:\.\S+)?\s+USING\s+(\S+)\s+/i,
  );
  if (!m) return null;
  const isUnique = Boolean(m[1]);
  const method = m[2].toLowerCase();
  const tail = def.slice(m[0].length).trimStart();
  if (!tail.startsWith("(")) return null;
  const colsRaw = extractBalancedParens(tail);
  if (colsRaw === null) return null;
  const columns = colsRaw.length === 0 ? [] : splitIndexedColumns(colsRaw);
  return { isUnique, method, columns };
}

/** Return the inner text of the first balanced `(...)` group in `s`. */
function extractBalancedParens(s: string): string | null {
  if (s[0] !== "(") return null;
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return s.slice(1, i);
    }
  }
  return null;
}

/** Split `lower(b), c, d` into ["lower(b)", "c", "d"] — paren-aware. */
function splitIndexedColumns(raw: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (!inQuote && ch === "(") depth++;
    if (!inQuote && ch === ")") depth--;
    if (ch === "," && !inQuote && depth === 0) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

export function rowsToConstraints(rows: unknown[]): TableConstraintInfo[] {
  const out: TableConstraintInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<ConstraintRow>;
    if (typeof r.conname !== "string" || typeof r.contype !== "string") continue;
    const columns = Array.isArray(r.conkeycols)
      ? r.conkeycols.map((c) => String(c))
      : [];

    const ctype = r.contype;
    if (ctype === "p") {
      out.push({ name: r.conname, type: "pk", columns });
    } else if (ctype === "u") {
      out.push({ name: r.conname, type: "unique", columns });
    } else if (ctype === "f") {
      const ref = parseRegclassText(r.confrelidname);
      const refCols = Array.isArray(r.confkeycols)
        ? r.confkeycols.map((c) => String(c))
        : [];
      const info: TableConstraintInfo = {
        name: r.conname,
        type: "fk",
        columns,
        fkTarget: { table: ref.table, schema: ref.schema, columns: refCols },
      };
      out.push(info);
    } else if (ctype === "c") {
      out.push({ name: r.conname, type: "check", columns });
    }
    // Unknown contype → skipped silently (mirrors pgIntrospect.rowsToSpec).
  }
  return out;
}

/** Strip `public.users` → `{ schema: "public", table: "users" }`. */
function parseRegclassText(raw: string | null | undefined): {
  table: string;
  schema?: string;
} {
  if (typeof raw !== "string" || raw.length === 0) return { table: "" };
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return { table: raw };
  return { schema: raw.slice(0, dot), table: raw.slice(dot + 1) };
}

/**
 * Decode pg_trigger.tgtype bits into event + timing strings.
 * Bit layout (per pg docs):
 *   bit 0 (1):   row-level (0 = statement-level)
 *   bit 1 (2):   BEFORE (0 = AFTER)
 *   bit 2 (4):   INSERT
 *   bit 3 (8):   DELETE
 *   bit 4 (16):  UPDATE
 *   bit 5 (32):  TRUNCATE
 *   bit 6 (64):  INSTEAD OF
 */
function decodeTriggerType(tgtype: number): { timing: string; event: string } {
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
  // Timing: bit 6 = INSTEAD OF, bit 1 = BEFORE, otherwise AFTER.
  let timing: string;
  if (tgtype & 64) timing = "INSTEAD OF";
  else if (tgtype & 2) timing = "BEFORE";
  else timing = "AFTER";
  return { timing, event };
}

export function rowsToTriggers(rows: unknown[]): TriggerInfo[] {
  const out: TriggerInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<TriggerRow>;
    if (
      typeof r.tgname !== "string" ||
      typeof r.action_statement !== "string"
    ) {
      continue;
    }
    const decoded = decodeTriggerType(
      typeof r.tgtype === "number" ? r.tgtype : 0,
    );
    out.push({
      name: r.tgname,
      event: decoded.event,
      timing: decoded.timing,
      statement: r.action_statement,
    });
  }
  return out;
}

export function rowsToSequences(rows: unknown[]): SequenceInfo[] {
  const out: SequenceInfo[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<SequenceRow>;
    if (
      typeof r.schemaname !== "string" ||
      typeof r.sequencename !== "string" ||
      typeof r.data_type !== "string"
    ) {
      continue;
    }
    const info: SequenceInfo = {
      name: r.sequencename,
      schema: r.schemaname,
      dataType: r.data_type,
    };
    if (typeof r.last_value === "string" && r.last_value.length > 0) {
      info.lastValue = r.last_value;
    }
    out.push(info);
  }
  return out;
}
