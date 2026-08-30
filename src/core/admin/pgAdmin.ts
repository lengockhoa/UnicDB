// src/core/admin/pgAdmin.ts
// Pure pgAdmin module: SQL templates + GRANT/REVOKE builders + identifier safety.
// Mirrors the pgCatalog pattern in src/core/ddl/pgCatalog.ts.
// No vscode / driver imports.

export const NAMEDATALEN_MINUS_ONE = 63; // PostgreSQL NAMEDATALEN = 64; identifiers cap at 63.

export type AdminErrorCode =
  | "emptyGrantee"
  | "emptyPrivileges"
  | "unknownKind"
  | "granteePublicForbidden"
  | "invalidIdentifier"
  | "nameTooLong";

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: AdminErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.details = details;
  }
}

// -------------------------------------------------------------------
// Identifier safety (mirror pgCatalog.quoteIdent semantics)
// -------------------------------------------------------------------

export function quoteIdent(name: string): string {
  // PG identifier quoting: wrap in double-quotes, double any embedded ".
  if (typeof name !== "string") {
    throw new AdminError("invalidIdentifier", "identifier must be a string");
  }
  if (name.length === 0) {
    throw new AdminError("invalidIdentifier", "identifier must not be empty");
  }
  if (name.includes('"')) {
    throw new AdminError("invalidIdentifier", `identifier must not contain quotes: ${name}`);
  }
  return `"${name}"`;
}

// -------------------------------------------------------------------
// Role-name validation (NAMEDATALEN-1 + no embedded NUL/quote/whitespace)
// -------------------------------------------------------------------

export function validateRoleName(name: string): void {
  if (typeof name !== "string") {
    throw new AdminError("invalidIdentifier", "role name must be a string");
  }
  const trimmed = name;
  if (trimmed.length === 0 || trimmed.trim().length === 0) {
    throw new AdminError("invalidIdentifier", "role name must not be empty");
  }
  if (trimmed.includes('"')) {
    throw new AdminError("invalidIdentifier", "role name must not contain quotes");
  }
  if (trimmed.includes("\u0000")) {
    throw new AdminError("invalidIdentifier", "role name must not contain NUL");
  }
  if (trimmed.length > NAMEDATALEN_MINUS_ONE) {
    throw new AdminError(
      "nameTooLong",
      `role name exceeds NAMEDATALEN-1 (${NAMEDATALEN_MINUS_ONE}) characters`,
      { length: trimmed.length, max: NAMEDATALEN_MINUS_ONE },
    );
  }
}

// -------------------------------------------------------------------
// Row-shape types
// -------------------------------------------------------------------

export interface RoleInfo {
  name: string;
  canLogin: boolean;
  isSuperuser: boolean;
  memberOf: string[];
}

export interface RoleGrantInfo {
  objectKind: "table" | "sequence" | "schema";
  schema: string;
  object: string;
  privileges: string[];
  grantee: string;
}

export interface SessionInfo {
  pid: number;
  usename: string;
  state: string;
  durationMs: number;
  query: string;
  waitEvent?: string;
  applicationName?: string;
}

export interface LockWaitInfo {
  blockedPid: number;
  blockedQuery: string;
  blockingPid: number;
  blockingQuery: string;
  lockType: string;
  mode: string;
  relation?: string;
}

export type GrantRequest =
  | {
      grantee: string;
      privileges: string[];
      on: { kind: "table"; schema: string; table: string };
    }
  | {
      grantee: string;
      privileges: string[];
      on: { kind: "sequence"; schema: string; sequence: string };
    }
  | {
      grantee: string;
      privileges: string[];
      on: { kind: "schema"; schema: string };
    };

export type RevokeRequest = GrantRequest;

export interface GrantOptions {
  allowGrantPublic?: boolean;
}

export interface RevokeOptions {
  cascade?: boolean;
}

// -------------------------------------------------------------------
// SQL templates (parameterized via $1/$2/...; identifiers via quoteIdent)
// -------------------------------------------------------------------

export interface ListRolesOptions {
  includeSystemRoles?: boolean;
}

export interface SqlWithParams {
  sql: string;
  params: unknown[];
}

export function listRolesSql(opts: ListRolesOptions = {}): SqlWithParams {
  // Default: exclude pg_* system roles. Pattern passed as $1 to keep parameter binding.
  // If includeSystemRoles is true, return SQL with no filter and empty params.
  if (opts.includeSystemRoles) {
    return {
      sql:
        "SELECT rolname::text AS name, rolcanlogin AS can_login, rolsuper AS is_superuser, " +
        "ARRAY(SELECT b.rolname FROM pg_catalog.pg_auth_members m " +
        "JOIN pg_catalog.pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid ORDER BY b.rolname) AS member_of " +
        "FROM pg_catalog.pg_roles r " +
        "ORDER BY r.rolname",
      params: [],
    };
  }
  return {
    sql:
      "SELECT rolname::text AS name, rolcanlogin AS can_login, rolsuper AS is_superuser, " +
      "ARRAY(SELECT b.rolname FROM pg_catalog.pg_auth_members m " +
      "JOIN pg_catalog.pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid ORDER BY b.rolname) AS member_of " +
      "FROM pg_catalog.pg_roles r " +
      "WHERE r.rolname !~ $1 " +
      "ORDER BY r.rolname",
    params: ["^pg_"],
  };
}

export function listRoleGrantsSql(_role: string): string {
  // Use $1 — callers pass the role via parameterized query (the value flows as a
  // text parameter, not as an inline identifier, so quoteIdent is unnecessary here).
  return (
    "SELECT grantee, table_schema AS schema, table_name AS object, " +
    "'table' AS object_kind, ARRAY_AGG(DISTINCT privilege_type ORDER BY privilege_type) AS privileges " +
    "FROM information_schema.role_table_grants " +
    "WHERE grantee = $1 " +
    "GROUP BY grantee, table_schema, table_name " +
    "UNION ALL " +
    "SELECT grantee, table_schema AS schema, object_name AS object, " +
    "'column' AS object_kind, ARRAY_AGG(DISTINCT privilege_type ORDER BY privilege_type) AS privileges " +
    "FROM information_schema.role_column_grants " +
    "WHERE grantee = $1 " +
    "GROUP BY grantee, table_schema, object_name " +
    "ORDER BY schema, object"
  );
}

export interface ListSessionsOptions {
  limit?: number;
}

export function listSessionsSql(opts: ListSessionsOptions = {}): string {
  const limit = opts.limit ?? 200;
  return (
    "SELECT pid, COALESCE(usename, '') AS usename, COALESCE(state, '') AS state, " +
    "EXTRACT(EPOCH FROM (now() - state_change)) * 1000 AS duration_ms, " +
    "LEFT(COALESCE(query, ''), 500) AS query, " +
    "wait_event_type || ':' || COALESCE(wait_event, '') AS wait_event, " +
    "COALESCE(application_name, '') AS application_name " +
    "FROM pg_stat_activity " +
    "WHERE backend_type = 'client backend' " +
    "ORDER BY state_change NULLS LAST " +
    "LIMIT " +
    String(limit)
  );
}

export function listLockWaitsSql(): string {
  return (
    "WITH blocked AS ( " +
    "  SELECT l.pid AS blocked_pid, l.locktype AS lock_type, l.mode AS mode, l.relation::regclass::text AS relation, " +
    "         a.query AS blocked_query " +
    "  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid " +
    "  WHERE NOT l.granted " +
    "), blockers AS ( " +
    "  SELECT b.blocked_pid, b.lock_type, b.mode, b.relation, b.blocked_query, " +
    "         bl.pid AS blocking_pid, ba.query AS blocking_query " +
    "  FROM blocked b, LATERAL pg_blocking_pids(b.blocked_pid) AS bl(pid) " +
    "  JOIN pg_stat_activity ba ON ba.pid = bl.pid " +
    ") " +
    "SELECT blocked_pid, blocked_query, blocking_pid, blocking_query, lock_type, mode, relation " +
    "FROM blockers " +
    "ORDER BY blocked_pid " +
    "LIMIT 200"
  );
}

// -------------------------------------------------------------------
// Builders
// -------------------------------------------------------------------

/**
 * Re-review fix: validate EVERY grant-target identifier (NUL, length)
 * BEFORE quoting. quoteIdent alone only rejects empty/quote values, so a
 * NUL or >63-char target used to be emitted and could truncate to a
 * different existing identifier on the server.
 */
function validateTargetIdentifier(kind: "table" | "sequence" | "schema", field: string, value: string): void {
  if (value.includes("\u0000")) {
    throw new AdminError(
      "invalidIdentifier",
      `grant target ${kind}.${field} must not contain NUL`,
      { kind, field },
    );
  }
  if (value.length > NAMEDATALEN_MINUS_ONE) {
    throw new AdminError(
      "nameTooLong",
      `grant target ${kind}.${field} exceeds NAMEDATALEN-1 (${NAMEDATALEN_MINUS_ONE})`,
      { kind, field, length: value.length, max: NAMEDATALEN_MINUS_ONE },
    );
  }
}

function renderOn(req: GrantRequest): string {
  switch (req.on.kind) {
    case "table":
      validateTargetIdentifier("table", "schema", req.on.schema);
      validateTargetIdentifier("table", "table", req.on.table);
      return `TABLE ${quoteIdent(req.on.schema)}.${quoteIdent(req.on.table)}`;
    case "sequence":
      validateTargetIdentifier("sequence", "schema", req.on.schema);
      validateTargetIdentifier("sequence", "sequence", req.on.sequence);
      return `SEQUENCE ${quoteIdent(req.on.schema)}.${quoteIdent(req.on.sequence)}`;
    case "schema":
      validateTargetIdentifier("schema", "schema", req.on.schema);
      return `SCHEMA ${quoteIdent(req.on.schema)}`;
    default: {
      const unknown = req.on as { kind: unknown };
      throw new AdminError(
        "unknownKind",
        `unknown grant target kind: ${String(unknown.kind)}`,
        { kind: unknown.kind },
      );
    }
  }
}

function checkGrantee(grantee: string, allowPublic: boolean | undefined): void {
  if (typeof grantee !== "string" || grantee.trim().length === 0) {
    throw new AdminError("emptyGrantee", "grantee must be a non-empty string");
  }
  validateRoleName(grantee);
  if (grantee === "PUBLIC" && !allowPublic) {
    throw new AdminError(
      "granteePublicForbidden",
      "granting to PUBLIC is disabled by default; pass allowGrantPublic:true to override",
    );
  }
}

function renderPrivileges(privileges: string[]): string {
  if (!Array.isArray(privileges) || privileges.length === 0) {
    throw new AdminError("emptyPrivileges", "privileges must be a non-empty array");
  }
  for (const p of privileges) {
    if (typeof p !== "string" || p.length === 0) {
      throw new AdminError("emptyPrivileges", "privilege entries must be non-empty strings");
    }
    if (!/^[A-Z]+$/i.test(p)) {
      throw new AdminError("emptyPrivileges", `invalid privilege token: ${p}`);
    }
  }
  return privileges.map((p) => p.toUpperCase()).join(", ");
}

export function buildGrantSql(req: GrantRequest, opts: GrantOptions = {}): string {
  const { grantee, privileges } = req;
  const allowPublic = !!opts.allowGrantPublic;
  checkGrantee(grantee, allowPublic);
  const privsSql = renderPrivileges(privileges);
  const onSql = renderOn(req);
  return `GRANT ${privsSql} ON ${onSql} TO ${quoteIdent(grantee)}`;
}

export function buildRevokeSql(req: RevokeRequest, opts: RevokeOptions = {}): string {
  const { grantee, privileges } = req;
  const allowPublic = true; // REVOKE PUBLIC is allowed by default
  checkGrantee(grantee, allowPublic);
  const privsSql = renderPrivileges(privileges);
  const onSql = renderOn(req);
  const cascade = opts.cascade ? " CASCADE" : "";
  return `REVOKE ${privsSql} ON ${onSql} FROM ${quoteIdent(grantee)}${cascade}`;
}
