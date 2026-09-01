// src/core/ddl/renameRunner.ts — TASK-DBX06-003 + DBX06-006
// Sequential rename-statement runner: progress per statement, cancel
// BEFORE the next statement, mid-run failure reporting. PURE — the host
// injects the execute callback (adapter.runQuery) and isCancelled probe.
//
// DBX06-006 — `runRenameSteps` mirrors the legacy runner but operates on
// the typed `RenamePlanStep` surface (executable vs review), emits per-step
// progress with a label, and reports named applied/failed step outcomes
// that the webview renders as concrete text.
export type RunOutcome =
  | { applied: number }
  | { applied: number; failedAt: number; error: string; failedStatement: string }
  | { applied: number; cancelledAfter: number; remaining: number };

/** Minimal shape the step runner needs from a RenamePlanStep. */
export interface RenamePlanStepLike {
  kind: string;
  executable: boolean;
  statement: string;
  /** Operation payload on executable rename steps — drives the label. */
  operation?: { kind: string };
}

/**
 * Human-readable label for a plan step — "Rename table" / "Rename column"
 * for executable rename steps (from `operation.kind`), and the dependency
 * kind for review steps. Shared by progress, applied, and failed reporting
 * so the preview and the outcome use the same wording.
 */
export function renameStepLabel(step: RenamePlanStepLike): string {
  if (step.kind === "rename") {
    return step.operation?.kind === "column" ? "Rename column" : "Rename table";
  }
  return step.kind;
}

/** Progress payload for a typed plan step. */
export interface RenameStepProgress {
  index: number;
  label: string;
  sql: string;
}

/** Named step entry — preserved for concrete applied/failed reporting. */
export interface NamedStep {
  index: number;
  label: string;
  sql: string;
}

export type RunStepsOutcome =
  | { applied: NamedStep[] }
  | { applied: NamedStep[]; failed: NamedStep & { error: string } }
  | { applied: NamedStep[]; cancelledAfter: number; remaining: number };

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

/**
 * DBX06-006 — typed plan-step runner.
 *
 * Iterates the declared `steps` order and runs only the executable ones
 * (non-executable review steps contribute to the step list but never run).
 * Outcomes carry the actual `index`/`label`/`sql` of every step that was
 * applied and (on failure) the failed step's error — the webview uses these
 * to render concrete "Rename table" / "Rename column" lines.
 *
 * Semantics match `runRenameStatements`: cancel is polled BEFORE the next
 * step; a thrown execute error stops the run and nothing after the failure
 * executes.
 */
export async function runRenameSteps(
  steps: ReadonlyArray<RenamePlanStepLike>,
  execute: (sql: string) => Promise<void>,
  onProgress: (step: RenameStepProgress, total: number) => void,
  isCancelled: () => boolean,
): Promise<RunStepsOutcome> {
  const execSteps: Array<{ originalIndex: number; label: string; sql: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.executable && typeof s.statement === "string" && s.statement.length > 0) {
      execSteps.push({
        originalIndex: i,
        label: renameStepLabel(s),
        sql: s.statement,
      });
    }
  }
  const total = execSteps.length;
  const applied: NamedStep[] = [];
  for (let i = 0; i < total; i++) {
    if (isCancelled()) {
      return { applied, cancelledAfter: i, remaining: total - i };
    }
    const step = execSteps[i]!;
    onProgress({ index: step.originalIndex, label: step.label, sql: step.sql }, total);
    try {
      await execute(step.sql);
    } catch (err) {
      return {
        applied,
        failed: {
          index: step.originalIndex,
          label: step.label,
          sql: step.sql,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
    applied.push({ index: step.originalIndex, label: step.label, sql: step.sql });
  }
  return { applied };
}
