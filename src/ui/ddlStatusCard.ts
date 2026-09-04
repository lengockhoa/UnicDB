// src/ui/ddlStatusCard.ts
// TASK-UX1-010 — pure helpers for the DDL/DML status card.
//
// The webview's state-tab logic routes each `StatementResult` through
// `classifyPanelKind` to decide between the legacy grid path (SELECT /
// no-kind-pending) and a new status-card path (DDL / DML / other).
// `buildDdlCardText` builds the text fields the card DOM reads.
//
// Lives in `src/ui/` (the webview imports from here via `../src/ui/…`)
// so the helpers can be unit-tested in plain node / vitest without
// pulling the DOM bundle. Webview-only DOM assembly stays in
// `webview/main.ts`'s `renderActivePanel` region.
//
// Design notes:
//   - Pure: no DOM, no vscode, no I/O.
//   - The card is the FINAL render surface — `kind === "select"` is
//     handled by the legacy grid path and never enters `buildDdlCardText`.
//   - Hint extraction is a regex over the pg error text, NEVER a
//     re-parse of SQL (per the planner's discussion note).

export type PanelKind = "grid" | "card";

export interface StatementResultLike {
  index: number;
  sql: string;
  status: "running" | "done" | "error" | "cancelled";
  result?: {
    columns?: string[];
    rows?: unknown[][];
    rowCount?: number | null;
    commandTag?: string;
    durationMs?: number;
  };
  error?: string;
  durationMs: number;
  /** TASK-UX1-010 — additive kind marker. Undefined ⇒ legacy grid. */
  kind?: "select" | "ddl" | "dml" | "other";
}

/**
 * Decide whether the panel should render the legacy AG Grid (SELECT)
 * or the new status card (DDL/DML/other).
 *
 * Rules:
 *   - `kind === "select"`                 → "grid" (legacy SELECT flow)
 *   - `kind` undefined (BQ-pending, never-stamped legacy) → "grid"
 *   - `kind === "ddl" | "dml" | "other"`  → "card"
 *
 * BQ-pending safety: an entry with no `kind` is treated identically
 * to the legacy "no kind field" path — the new status card branch only
 * fires when the host's stamping helper actually classified the SQL.
 * This keeps TASK-BQ03/04 behaviour byte-identical.
 */
export function classifyPanelKind(r: StatementResultLike): PanelKind {
  if (!r.kind) return "grid";
  if (r.kind === "select") return "grid";
  return "card";
}

export interface BuildCardInput {
  r: StatementResultLike;
  /** Total number of statements in this run (for "statement N of M"). */
  statementCount: number;
  /** 0-based index of this statement within its run. */
  statementIndex: number;
}

export interface BuildCardOutput {
  kind: "ddl" | "dml" | "other" | "select";
  variant: "success" | "error";
  /** Headline text — typically `<commandTag> (<KindLabel>)` or
   *  `<KindLabel> statement` when no commandTag is available. */
  title: string;
  /** Secondary text — always includes duration; for multi-statement
   *  runs appends ` — statement N of M`. */
  meta: string;
  /** Error verbatim (status === "error"). Byte-identical to
   *  `r.error`. Undefined when `variant === "success"`. */
  errorText?: string;
  /** Pinpointing hint (line / position extracted from pg error text).
   *  Undefined when no parseable line/position markers were present
   *  AND the variant is success. */
  hint?: string;
  hasError: boolean;
}

/**
 * Extract a pinpointing hint from a pg error message.
 *
 * Recognizes:
 *   - `LINE N:` (Postgres / MySQL)
 *   - `character N` / `at character N` (Postgres)
 *
 * Returns `undefined` when no parseable marker is present so the card
 * omits the hint node entirely instead of rendering an empty bullet.
 *
 * NOTE: a regex over the error text only — we never re-parse SQL.
 */
export function extractHint(pgError: string | undefined): string | undefined {
  if (!pgError) return undefined;
  const lineMatch = pgError.match(/LINE\s+(\d+)/i);
  const posMatch = pgError.match(/(?:at\s+)?character\s+(\d+)/i);
  if (!lineMatch && !posMatch) return undefined;
  const parts: string[] = [];
  if (lineMatch) parts.push(`near LINE ${lineMatch[1]}`);
  if (posMatch) parts.push(`position ${posMatch[1]}`);
  return parts.join(", ");
}

/**
 * Build the card text fields for a non-SELECT statement.
 *
 * Pure: produces strings only. The webview assembly reads these
 * fields to build the DOM (`title` → `<div class="vsdb-ddl-card-title">`,
 * `meta` → `<div class="vsdb-ddl-card-meta">`, etc.).
 *
 * Failure semantics:
 *     `errorText` is byte-identical to `r.error`. The `hint` is a
 *     short pinpoint (LINE N) so the user can jump to the offending
 *     line without re-reading the full pg error verbatim.
 */
export function buildDdlCardText(input: BuildCardInput): BuildCardOutput {
  const { r, statementCount, statementIndex } = input;
  const stmtKind = r.kind ?? "other";
  const isError = r.status === "error";

  const command = r.result?.commandTag;
  const kindLabel =
    stmtKind === "ddl" ? "DDL" : stmtKind === "dml" ? "DML" : "Other";
  const title = command
    ? `${command} (${kindLabel})`
    : `${kindLabel} statement`;

  const position = statementCount > 1
    ? `statement ${statementIndex + 1} of ${statementCount}`
    : "";
  const duration = `${r.durationMs}ms`;
  const meta = position
    ? `${duration} — ${position}`
    : duration;

  if (isError) {
    const errorText = r.error ?? "";
    const hint = extractHint(errorText);
    return {
      kind: stmtKind,
      variant: "error",
      title,
      meta,
      errorText,
      hint,
      hasError: true,
    };
  }

  return {
    kind: stmtKind,
    variant: "success",
    title,
    meta,
    hasError: false,
  };
}