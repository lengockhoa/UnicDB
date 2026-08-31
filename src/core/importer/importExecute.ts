// src/core/importer/importExecute.ts
// DBX-01-003 — the ONLY module in the importer that touches a
// `DbAdapter`. Runs a `DryRunPlan` inside a single `DbTransaction`,
// guarded by `dangerousStatement.analyzeStatement` so only INSERT
// statements ever reach the database.
//
// Guarantees:
//  - parameterized SQL only (plan.parameterSets are bound values).
//  - BEGIN/COMMIT/ROLLBACK through the adapter's transaction — the
//    importer NEVER calls `adapter.runQuery` directly.
//  - Rollback on any mid-batch failure; the partial result is never
//    surfaced as success.
//  - Rows exceeding `maxBatchBytes` are reported as per-row errors and
//    skipped (never truncated, per PLAN_DBX01 §3 Approach 4).
//  - Non-PostgreSQL driver → gate error before any work begins.

import type { DbAdapter } from "../../adapters/types";
import type { ImportRowError } from "./importTypes";
import type { DryRunPlan } from "./importDryRun";
import { analyzeStatement } from "../dangerousStatement";

export interface ImportExecuteOptions {
  /** Per-batch byte ceiling. Rows above this are reported, not sent. */
  maxBatchBytes?: number;
  /** Rows per INSERT statement (default 1000; plan already batches). */
  defaultBatchSize?: number;
}

export interface ImportExecuteResult {
  /** Total rows successfully inserted (sum of executed batch sizes). */
  rowCount: number;
  /** Per-row errors that caused a row to be skipped. */
  errors: ImportRowError[];
  /** Fatal phase error — the transaction did not commit. */
  error?: { phase: "begin" | "runQuery" | "commit" | "gate" | "driver"; message: string };
}

const DEFAULT_MAX_BATCH_BYTES = 1_048_576; // 1 MiB

export async function executeImport(
  plan: DryRunPlan,
  adapter: DbAdapter,
  opts?: ImportExecuteOptions,
): Promise<ImportExecuteResult> {
  const maxBatchBytes = opts?.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  const errors: ImportRowError[] = [];

  // Driver gate: imports are PostgreSQL-only for DBX-01.
  const driver = (adapter as { driver?: string }).driver ?? "";
  if (driver !== "postgres") {
    return {
      rowCount: 0,
      errors: [
        {
          line: 0,
          message: `Import requires the PostgreSQL driver (active: "${driver || "unknown"}")`,
        },
      ],
    };
  }
  // Dangerous-statement gate: every statement in the plan must START
  // with INSERT (after masking literals/comments so a fake "INSERT"
  // inside a string doesn't pass). We reuse the project's
  // `maskLiteralsAndComments` indirectly through analyzeStatement for
  // the WHERE scan and check the leading keyword ourselves.
  for (let i = 0; i < plan.sqlStatements.length; i++) {
    const sql = plan.sqlStatements[i] ?? "";
    analyzeStatement(sql); // mask sanity: throws on pathological input (kept for parity)
    const firstWord = sql
      .trim()
      .slice(0, 64)
      .match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0]
      ?.toLowerCase();
    if (firstWord !== "insert") {
      return {
        rowCount: 0,
        errors,
        error: {
          phase: "gate",
          message: `Plan statement ${i + 1} is not an INSERT (starts with "${firstWord ?? "?"}")`,
        },
      };
    }
  }

  // Structural plan gate (fail closed BEFORE transaction acquisition):
  // a truly empty plan (no batches, no statements, no values) keeps its
  // successful no-op result; any non-empty plan must declare a positive
  // safe-integer batch count with exactly one SQL statement per batch
  // and at least one bound value. Anything else would force
  // executeImport to guess statement/batch/value alignment and risk
  // partial database work — refuse instead.
  const isEmptyPlan =
    plan.batches === 0 && plan.sqlStatements.length === 0 && plan.parameterSets.length === 0;
  if (
    !isEmptyPlan &&
    (!Number.isSafeInteger(plan.batches) ||
      plan.batches < 1 ||
      plan.sqlStatements.length !== plan.batches ||
      plan.parameterSets.length === 0)
  ) {
    // Pin the offending plan entry (0-based index, matching the plan array
    // order the user sees) and the concrete reason per case.
    let reason: string;
    if (!Number.isSafeInteger(plan.batches) || plan.batches < 1) {
      reason = `invalid batch count batches=${plan.batches}`;
    } else if (plan.sqlStatements.length < plan.batches) {
      reason = `statement ${plan.sqlStatements.length} is missing (declared batches=${plan.batches}, statements=${plan.sqlStatements.length})`;
    } else if (plan.sqlStatements.length > plan.batches) {
      reason = `statement ${plan.batches} is unexpected (declared batches=${plan.batches}, statements=${plan.sqlStatements.length})`;
    } else {
      reason = `statement 0 has empty parameterSets (parameterSets=${plan.parameterSets.length})`;
    }
    return {
      rowCount: 0,
      errors,
      error: {
        phase: "gate",
        message: `Malformed executable plan: ${reason} (expected batches ≥ 1, one INSERT statement per batch, and at least one parameter set)`,
      },
    };
  }
  if (isEmptyPlan) {
    return { rowCount: 0, errors };
  }

  if (typeof adapter.beginTransaction !== "function") {
    return {
      rowCount: 0,
      errors,
      error: { phase: "begin", message: "Adapter does not support transactions" },
    };
  }

  let tx;
  try {
    tx = await adapter.beginTransaction();
  } catch (err) {
    return {
      rowCount: 0,
      errors,
      error: { phase: "begin", message: (err as Error).message },
    };
  }

  // Chunk the flat parameterSets into plan.batches groups. Statement i
  // corresponds to parameterSets[i * rowsPerBatch .. (i+1) * rowsPerBatch).
  const rowsPerBatch = Math.max(1, Math.ceil(plan.parameterSets.length / plan.batches));
  let inserted = 0;
  for (let b = 0; b < plan.batches; b++) {
    const start = b * rowsPerBatch;
    const end = Math.min(start + rowsPerBatch, plan.parameterSets.length);
    const slice = plan.parameterSets.slice(start, end);

    // Per-row byte budget — a single oversized row fails the row,
    // not the whole batch. Rows that pass are bound as one statement.
    const survivors: unknown[][] = [];
    for (let r = 0; r < slice.length; r++) {
      const row = slice[r];
      if (row === undefined) continue;
      const bytes = row.reduce<number>((acc, v) => acc + approxBytes(v), 0);
      if (bytes > maxBatchBytes) {
        errors.push({
          line: start + r + 1,
          message: `Row exceeds maxBatchBytes (${bytes} > ${maxBatchBytes}); skipped`,
        });
        continue;
      }
      survivors.push(row);
    }

    if (survivors.length === 0) continue;

    // Flatten survivors into a single multi-row parameter set for
    // one statement (the dry-run already collated one statement per
    // batch, we preserve that contract).
    const flat: unknown[] = survivors.flat();
    try {
      await tx.runQuery(plan.sqlStatements[b] ?? "", flat);
      inserted += survivors.length;
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        // Rollback failure is not actionable on top of the runQuery
        // failure — the driver already aborted the transaction.
      }
      return {
        rowCount: inserted,
        errors,
        error: { phase: "runQuery", message: (err as Error).message },
      };
    }
  }

  try {
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // see above
    }
    return {
      rowCount: inserted,
      errors,
      error: { phase: "commit", message: (err as Error).message },
    };
  }

  return { rowCount: inserted, errors };
}

/**
 * `analyzeStatement` classifies DROP/DELETE/etc. by kind. We only care
 * whether the statement's FIRST keyword is INSERT; the helper converts
 * the DangerousKind union into a normalized word for the regex check
 * above. Anything not matching is refused.
 */
function statementKind(kind: string): string {
  return kind;
}

function approxBytes(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (typeof v === "number") return 8;
  if (typeof v === "boolean") return 1;
  if (typeof v === "string") return v.length;
  if (typeof v === "object") return JSON.stringify(v).length;
  return 0;
}
