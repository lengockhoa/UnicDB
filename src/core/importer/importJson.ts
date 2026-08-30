// src/core/importer/importJson.ts
// DBX-01-001 — pure JSON parser. Accepts an array of objects OR NDJSON
// (one object per line). Rejects ambiguous shapes loudly (PLAN_DBX01
// §2 + §3 Approach 1) and never silently coerces deeply-nested values
// (PLAN_DBX01 §3 Approach 5 — those errors name the offending column).
//
// No I/O, no `vscode`. Strings inside JSON are kept as strings; the
// mapping layer (DBX01-002) is the only place that decides "int" or
// "json" coercion.

import type { ImportParseResult, ImportRowError } from "./importTypes";

const NESTING_LIMIT = 1; // object at this column whose value is itself an object → reject.

interface JsonRecord {
  [key: string]: unknown;
}

/**
 * Parse a JSON text blob.
 *
 * @param text Raw JSON text. Caller reads the file (no I/O here).
 * @param _opts Reserved for future options.
 */
export function parseJson(text: string, _opts?: { maxRows?: number }): ImportParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      headers: [],
      rows: [],
      errors: [{ line: 0, message: "Empty JSON file" }],
    };
  }

  const isArrayForm = trimmed.startsWith("[");

  if (isArrayForm) {
    // Look for a `{` after the closing `]` to detect mixed shapes
    // (array wrapper + NDJSON) BEFORE trying JSON.parse. Doing this
    // earlier lets us return the descriptive "ambiguous" error
    // instead of a cryptic JSON.parse failure on the trailing `{`.
    const closeBracket = findClosingBracket(trimmed);
    if (closeBracket >= 0) {
      const tail = trimmed.slice(closeBracket + 1).trim();
      if (tail.startsWith("{")) {
        return {
          headers: [],
          rows: [],
          errors: [
            {
              line: 0,
              message: "Ambiguous JSON: file mixes an array with NDJSON objects",
            },
          ],
        };
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        headers: [],
        rows: [],
        errors: [
          {
            line: 0,
            message: `Invalid JSON: ${(err as Error).message}`,
          },
        ],
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return rejectRoot(
        "Top-level JSON value must be an array or object (got primitive root)",
        trimmed,
      );
    }
    return parseArray(parsed);
  }

  // NDJSON path: split on newlines, parse each non-empty line.
  // Reject primitive roots early: a line that parses to a number
  // / string / null / boolean is not an NDJSON object.
  return parseNdjson(trimmed);
}

function findClosingBracket(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseArray(value: unknown): ImportParseResult {
  if (!Array.isArray(value)) {
    return {
      headers: [],
      rows: [],
      errors: [{ line: 0, message: "Top-level value is not a JSON array" }],
    };
  }
  if (value.length === 0) {
    return {
      headers: [],
      rows: [],
      errors: [{ line: 0, message: "Empty JSON array" }],
    };
  }

  const headers = collectHeadersFromArray(value);
  const errors: ImportRowError[] = [];
  const rows: Array<Array<string | null>> = [];

  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push({
        line: i + 1,
        message: "Array element is not a JSON object",
      });
      continue;
    }
    const obj = item as JsonRecord;
    const deepErr = findTooDeepColumn(obj);
    if (deepErr !== null) {
      errors.push({
        line: i + 1,
        column: deepErr,
        message: `Deeply-nested object value at column "${deepErr}" (objects must be flat)`,
      });
      continue;
    }
    rows.push(projectObject(obj, headers));
  }

  return { headers, rows, errors };
}

function parseNdjson(text: string): ImportParseResult {
  const errors: ImportRowError[] = [];
  const rows: Array<Array<string | null>> = [];
  let headers: string[] = [];
  let rejectedAsPrimitive = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim() ?? "";
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push({
        line: i + 1,
        message: `Invalid JSON: ${(err as Error).message}`,
      });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push({
        line: i + 1,
        message: "NDJSON line is not a JSON object",
      });
      if (typeof parsed !== "object" || parsed === null) rejectedAsPrimitive = true;
      continue;
    }
    const obj = parsed as JsonRecord;
    const deepErr = findTooDeepColumn(obj);
    if (deepErr !== null) {
      errors.push({
        line: i + 1,
        column: deepErr,
        message: `Deeply-nested object value at column "${deepErr}" (objects must be flat)`,
      });
      continue;
    }
    if (headers.length === 0) {
      headers = Object.keys(obj);
    }
    rows.push(projectObject(obj, headers));
  }

  if (rows.length === 0) {
    if (rejectedAsPrimitive) {
      return {
        headers: [],
        rows: [],
        errors: [
          {
            line: 0,
            message:
              "Top-level JSON value must be an object per line (NDJSON) or an array (got primitive root)",
          },
        ],
      };
    }
    return {
      headers,
      rows,
      errors: errors.length > 0
        ? errors
        : [{ line: 0, message: "Empty JSON file" }],
    };
  }
  return { headers, rows, errors };
}

function rejectRoot(reason: string, _text: string): ImportParseResult {
  return {
    headers: [],
    rows: [],
    errors: [{ line: 0, message: reason }],
  };
}

function collectHeadersFromArray(arr: unknown[]): string[] {
  // Stable order: first object's keys, then any new keys in
  // subsequent objects appended in insertion order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    for (const k of Object.keys(item as JsonRecord)) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

function projectObject(
  obj: JsonRecord,
  headers: string[],
): Array<string | null> {
  return headers.map((h) => {
    if (!Object.prototype.hasOwnProperty.call(obj, h)) return "";
    const v = obj[h];
    if (v === null) return null;
    if (v === undefined) return "";
    if (typeof v === "object") {
      // Reached here only when the value at this column is itself
      // an object/array (we don't reject array values here — the
      // deep check already validated there are no nested objects).
      // Render them via JSON.stringify so the mapping layer sees
      // a parseable string.
      return JSON.stringify(v);
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
    return String(v);
  });
}

/**
 * Returns the column name whose value is an object/array (i.e. the
 * value itself is not a primitive), or null if the row is flat.
 * Test case: `{"a":{"b":{"c":1}}}` → "a" (because a's value is an
 * object). Top-level array values count as a nested shape too.
 */
function findTooDeepColumn(obj: JsonRecord): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === "object") return k;
  }
  return null;
}
