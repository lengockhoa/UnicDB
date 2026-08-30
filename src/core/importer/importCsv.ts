// src/core/importer/importCsv.ts
// DBX-01-001 — pure RFC-4180 subset CSV parser. No I/O, no `vscode`.
// Returns headers + rows (string|null) + per-row errors. Empty file is
// an error (case 7 in §Test Cases) — the wizard surfaces it instead of
// presenting a zero-row preview that looks like a successful empty
// import.
//
// Quoting rules implemented:
//   - Fields may be wrapped in double quotes; double-double-quote inside
//     a quoted field decodes to a single `"`.
//   - Inside a quoted field, `,` and `\n`/`\r\n` are literal.
//   - Outside a quoted field, a line break ends the row.
//   - A ragged row (column count != header count) is dropped and
//     reported as a per-row error.
//
// We strip a leading UTF-8 BOM (`U+FEFF`) from the very first header
// (case 5). We do NOT strip BOM from data — only from the start of the
// file. This is intentional: BOM mid-file is binary noise, not a
// data signal, and silently rewriting data is exactly what we
// promised not to do (PLAN_DBX01 §3 Approach 5).

import type { ImportParseResult, ImportRowError } from "./importTypes";

const BOM = "\uFEFF";

/**
 * Parse a CSV text blob.
 *
 * @param text Raw CSV text. Caller is responsible for reading the file
 *             (we do no I/O).
 * @param _opts Reserved for future options (maxRows, custom delimiter).
 *              Currently unused.
 */
export function parseCsv(text: string, _opts?: { maxRows?: number }): ImportParseResult {
  const errors: ImportRowError[] = [];

  if (text.length === 0) {
    return {
      headers: [],
      rows: [],
      errors: [{ line: 0, message: "Empty CSV file" }],
    };
  }

  // Strip a single leading BOM.
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rawRows = tokenize(src);
  if (rawRows.length === 0) {
    return {
      headers: [],
      rows: [],
      errors: [{ line: 0, message: "Empty CSV file" }],
    };
  }

  const headerRow = rawRows[0] ?? [];
  const headers: string[] = headerRow.map((h) => h.trim());
  const expectedWidth = headers.length;

  const rows: Array<Array<string | null>> = [];
  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i] ?? [];
    if (cells.length === 1 && cells[0] === "" && isBlankLineFollowedByEof(src, i, rawRows)) {
      // Trailing blank line at EOF — drop silently.
      continue;
    }
    if (cells.length !== expectedWidth) {
      errors.push({
        line: i + 1, // 1-based; row 1 is the header.
        message: `Ragged row: expected ${expectedWidth} columns, got ${cells.length}`,
      });
      continue;
    }
    rows.push(cells.map((c) => (c === "" ? "" : c)));
  }

  return { headers, rows, errors };
}

/**
 * RFC-4180-style tokenizer. Splits `text` into rows of raw field
 * strings (quotes still present, escapes NOT yet decoded). Empty
 * trailing row from a final newline is dropped here.
 */
function tokenize(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field → keep one quote,
          // consume the next.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"' && field.length === 0) {
        // Opening quote at the start of a field.
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        out.push(row);
        row = [];
        field = "";
      } else if (ch === "\r") {
        // CRLF or lone CR — end the row; the `\n` will be consumed
        // (or this is the end of line on classic Mac files).
        row.push(field);
        out.push(row);
        row = [];
        field = "";
        if (text[i + 1] === "\n") i++;
      } else {
        field += ch;
      }
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/**
 * We only need this to decide whether a single empty cell at row N
 * was the result of a final trailing newline (drop it) versus a real
 * empty row (keep as empty). Since the tokenizer already drops the
 * final empty row when the source ends with `\n`/`\r\n`, this helper
 * is a no-op kept for symmetry and future tightening.
 */
function isBlankLineFollowedByEof(_src: string, _index: number, _rows: string[][]): boolean {
  return false;
}
