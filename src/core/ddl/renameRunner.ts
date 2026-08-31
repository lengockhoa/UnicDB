// src/core/ddl/renameRunner.ts — TASK-DBX06-003
// Sequential rename-statement runner: progress per statement, cancel
// BEFORE the next statement, mid-run failure reporting. PURE — the host
// injects the execute callback (adapter.runQuery) and isCancelled probe.
export type RunOutcome =
  | { applied: number }
  | { applied: number; failedAt: number; error: string; failedStatement: string }
  | { applied: number; cancelledAfter: number; remaining: number };

/**
 * Execute `statements` strictly in order.
 *  - onProgress(index, total, statement) fires before each statement.
 *  - isCancelled() is polled after each statement; when true the runner
 *    stops BEFORE the next statement and reports applied/cancelledAfter/
 *    remaining (cancellation/partial-failure edge from the roadmap row).
 *  - A thrown execute error stops the run and reports applied/failedAt/
 *    error/failedStatement — nothing after the failure executes.
 */
export async function runRenameStatements(
  statements: string[],
  execute: (sql: string) => Promise<void>,
  onProgress: (index: number, total: number, statement: string) => void,
  isCancelled: () => boolean,
): Promise<RunOutcome> {
  const total = statements.length;
  for (let i = 0; i < total; i++) {
    if (isCancelled()) {
      return { applied: i, cancelledAfter: i, remaining: total - i };
    }
    const sql = statements[i]!;
    onProgress(i, total, sql);
    try {
      await execute(sql);
    } catch (err) {
      return {
        applied: i,
        failedAt: i,
        error: err instanceof Error ? err.message : String(err),
        failedStatement: sql,
      };
    }
  }
  return { applied: total };
}
