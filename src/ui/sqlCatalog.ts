// src/ui/sqlCatalog.ts
//
// TASK-DBX02-001 — vscode-free catalog resolver. Pure types + thin wrapper
// around SchemaCache. NO vscode / NO adapter imports. All DBX-02 catalog
// rows are produced from values the cache already holds.
//
// Capability gate (DBX-08): every method early-returns `[]` / `undefined` when
//   1. `options.declaresCatalog()` returns false (no declared catalog
//      capability for the active adapter), or
//   2. `cache.hasCatalog()` returns false (adapter without the declared
//      capability — defensive re-check at the cache boundary).
// The resolver is the sole FK input for TASK-DBX02-002/003/004. Foreign-key
// rows are TABLE-SCOPED — `listForeignKeys(schema, table)` is never invoked
// for tables the caller did not ask about.

import type { SchemaCache } from "./schemaCache";

// ---- Row types — exact shapes from TASK-DBX02-001 §Interfaces Produces ------

export interface CatalogViewRow {
  readonly kind: "view";
  readonly schema: string;
  readonly name: string;
}

export interface CatalogRoutineRow {
  readonly kind: "routine";
  readonly schema: string;
  readonly name: string;
  readonly routineKind: "function" | "procedure";
}

export interface CatalogSequenceRow {
  readonly kind: "sequence";
  readonly schema: string;
  readonly name: string;
  readonly dataType: string;
  readonly lastValue?: string;
}

export interface CatalogForeignKeyRow {
  readonly kind: "foreignKey";
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: {
    readonly schema?: string;
    readonly table: string;
    readonly columns: readonly string[];
  };
}

export type CatalogRootRow =
  | CatalogViewRow
  | CatalogRoutineRow
  | CatalogSequenceRow;

// ---- Resolver contract -----------------------------------------------------

export interface CatalogResolver {
  /**
   * Schema-wide catalog rows — views, routines, sequences — collected into
   * one discriminated list. Empty array when the capability gate fails.
   */
  listRootRows(): Promise<readonly CatalogRootRow[]>;

  /**
   * Table-scoped FK rows. NEVER invokes constraints on a non-requested
   * table. Empty array when the capability gate fails.
   */
  listForeignKeys(
    schema: string,
    table: string,
  ): Promise<readonly CatalogForeignKeyRow[]>;

  /**
   * DDL text for one (kind, schema, name). Undefined when the capability
   * gate fails or the adapter reports no DDL.
   */
  getDefinition(
    kind: "view" | "routine",
    schema: string,
    name: string,
  ): Promise<string | undefined>;
}

export interface CatalogResolverOptions {
  /**
   * DBX-08 — declared-capability predicate. True only when the active
   * adapter DECLARES the `catalog` capability (checked via
   * `hasAdapterCapability` at the wiring site). Never a driver-identity
   * check; false/missing declarations keep every catalog method silent.
   * Async allowed: resolving the active adapter may require I/O.
   */
  declaresCatalog: () => boolean | Promise<boolean>;
}

// ---- Default schema for non-scoped lookups ---------------------------------

/**
 * Public is the convention used elsewhere in the codebase for "no explicit
 * schema" listings. Single source of truth so a future move to multi-
 * schema scoping only needs to change one constant.
 */
const PUBLIC_SCHEMA = "public";

/**
 * Fail-closed capability admission (DBX-08 review round 1): a rejected async
 * `declaresCatalog()` predicate must gate the resolver like any unsupported
 * declaration — callers (e.g. `SqlNavigationProvider` hover/definition)
 * await resolver methods without a catch, so an escape here would surface
 * as a rejected navigation request instead of the contract's empty result.
 */
async function admitted(options: CatalogResolverOptions): Promise<boolean> {
  try {
    return (await options.declaresCatalog()) && true;
  } catch {
    return false;
  }
}

// ---- Factory ---------------------------------------------------------------

/**
 * Build a CatalogResolver. Each method early-returns empty/undefined when
 * `declaresCatalog()` is false OR `cache.hasCatalog()` is false — no adapter
 * calls are made in that case. Foreign-key lookup is always table-scoped.
 */
export function createCatalogResolver(
  cache: SchemaCache,
  options: CatalogResolverOptions,
): CatalogResolver {
  return {
    async listRootRows(): Promise<readonly CatalogRootRow[]> {
      if (!(await admitted(options)) || !(await cache.hasCatalog())) return [];
      const [views, routines, sequences] = await Promise.all([
        cache.getViews(PUBLIC_SCHEMA),
        cache.getRoutines(PUBLIC_SCHEMA),
        cache.getSequences(PUBLIC_SCHEMA),
      ]);
      const rows: CatalogRootRow[] = [];
      for (const v of views) {
        rows.push({ kind: "view", schema: v.schema, name: v.name });
      }
      for (const r of routines) {
        rows.push({
          kind: "routine",
          schema: r.schema,
          name: r.name,
          routineKind: r.kind,
        });
      }
      for (const s of sequences) {
        rows.push({
          kind: "sequence",
          schema: s.schema,
          name: s.name,
          dataType: s.dataType,
          lastValue: s.lastValue,
        });
      }
      return rows;
    },

    async listForeignKeys(
      schema: string,
      table: string,
    ): Promise<readonly CatalogForeignKeyRow[]> {
      if (!(await admitted(options)) || !(await cache.hasCatalog())) return [];
      const constraints = await cache.getConstraints(schema, table);
      const rows: CatalogForeignKeyRow[] = [];
      for (const c of constraints) {
        if (c.type !== "fk" || !c.fkTarget) continue;
        rows.push({
          kind: "foreignKey",
          schema,
          table,
          name: c.name,
          columns: c.columns,
          target: {
            schema: c.fkTarget.schema,
            table: c.fkTarget.table,
            columns: c.fkTarget.columns,
          },
        });
      }
      return rows;
    },

    async getDefinition(
      kind: "view" | "routine",
      schema: string,
      name: string,
    ): Promise<string | undefined> {
      if (!(await admitted(options)) || !(await cache.hasCatalog())) {
        return undefined;
      }
      return await cache.getObjectDdl(kind, schema, name);
    },
  };
}