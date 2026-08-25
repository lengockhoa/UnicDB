// src/core/keywordQualify.ts
// TASK-007 — pure pre-execution SQL transform.
//
// Rewrite rule (case-insensitive):
//   identifier `name` is unquoted AND unqualified (NOT preceded by `.`)
//   AND positioned at paren-depth 0 right after FROM / INTO / UPDATE / JOIN
//   AND isPgReservedKeyword(name)
//   AND name ∈ listTables("public")
//   → emit `"public"."<name>"`.
//
// Everything else is left untouched: string literals, comments, dollar-quotes,
// already-qualified names, CTE references that shadow tables, keyword usages
// (`ORDER BY`, `GROUP BY`, column references, etc).
//
// The module is pure (no vscode / db imports) so the transform stays cheap to
// unit-test and safe to compose with `splitStatements` / `sqlToRun`.

/**
 * Postgres reserved keywords that cannot appear unquoted as an identifier.
 * Source: Postgres documentation (SQL Key Words — reserved). Includes the
 * names most likely to collide as table identifiers (order/user/select/group/…).
 */
const PG_RESERVED: Record<string, true> = {
  all: true,
  analyse: true,
  analyze: true,
  and: true,
  any: true,
  array: true,
  as: true,
  asc: true,
  asymmetric: true,
  both: true,
  case: true,
  cast: true,
  check: true,
  collate: true,
  column: true,
  constraint: true,
  create: true,
  current_catalog: true,
  current_date: true,
  current_role: true,
  current_time: true,
  current_timestamp: true,
  current_user: true,
  default: true,
  deferrable: true,
  desc: true,
  distinct: true,
  do: true,
  else: true,
  end: true,
  except: true,
  false: true,
  fetch: true,
  for: true,
  foreign: true,
  from: true,
  grant: true,
  group: true,
  having: true,
  in: true,
  initially: true,
  intersect: true,
  into: true,
  lateral: true,
  leading: true,
  limit: true,
  localtime: true,
  localtimestamp: true,
  new: true,
  not: true,
  null: true,
  off: true,
  offset: true,
  old: true,
  on: true,
  only: true,
  or: true,
  order: true,
  placing: true,
  primary: true,
  references: true,
  returning: true,
  select: true,
  session_user: true,
  some: true,
  symmetric: true,
  table: true,
  then: true,
  to: true,
  trailing: true,
  true: true,
  union: true,
  unique: true,
  user: true,
  using: true,
  variadic: true,
  when: true,
  where: true,
  window: true,
  with: true,
};

/** True when `word` is a Postgres reserved keyword (case-insensitive). */
export function isPgReservedKeyword(word: string): boolean {
  if (!word) return false;
  return PG_RESERVED[word.toLowerCase()] === true;
}

/** Result of `qualifyKeywordTables`. `changed` is true iff at least one rewrite occurred. */
export interface QualifyResult {
  sql: string;
  changed: boolean;
}

/**
 * Caller-owned handle around a per-schema, TTL-expiring table-name cache.
 * Deliberately NOT a module-level singleton — a hidden global would keep
 * serving a stale table list after a DDL change in the same session (see
 * docs/AI_HANDOFF/tasks/TASK-008.md §Discussion). Callers that want reuse
 * across multiple `qualifyKeywordTables` calls (e.g. a multi-statement run)
 * create one cache and pass it via `opts.cache`.
 */
export interface KeywordTableCache {
  /** Returns the cached lowercase table-name set, or fetches via `load` and stores it. */
  get(schema: string, load: () => Promise<string[]>): Promise<Set<string>>;
  clear(): void;
}

interface CacheEntry {
  value: Promise<Set<string>>;
  timestamp: number;
}

/** TTL default 30_000 ms. `now` is injectable for tests. */
export function createKeywordTableCache(
  ttlMs = 30_000,
  now: () => number = Date.now,
): KeywordTableCache {
  const entries = new Map<string, CacheEntry>();
  return {
    async get(schema, load) {
      const nowMs = now();
      const cached = entries.get(schema);
      if (cached && nowMs - cached.timestamp < ttlMs) {
        return cached.value;
      }
      const value = load().then((rows) => new Set(rows.map((n) => n.toLowerCase())));
      entries.set(schema, { value, timestamp: nowMs });
      // Failed fetches must not poison the cache for the next attempt.
      value.catch(() => {
        if (entries.get(schema)?.value === value) entries.delete(schema);
      });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * Rewrite SQL as described in the module header.
 *
 * `listTables` is async because callers need to hit the live adapter. It is
 * only ever invoked with `"public"`, and only lazily — the very first time a
 * reserved-keyword table candidate is actually encountered while scanning
 * `sql` — so a query with no such candidate never touches the catalog at all
 * (TASK-008 / D1). `opts.cache` is an opt-in, caller-owned cache so a
 * multi-statement run can share a single catalog round trip; omitted, this
 * call pays its own round trip at most once (today's semantics).
 */
export async function qualifyKeywordTables(
  sql: string,
  listTables: (schema: string) => Promise<string[]>,
  opts?: { cache?: KeywordTableCache },
): Promise<QualifyResult> {
  // Public table set — resolved lazily, on the first candidate lookup below,
  // and memoized locally so a single call never issues more than one fetch.
  let publicTableSet: Set<string> | null = null;
  const publicTables = async (): Promise<Set<string>> => {
    if (publicTableSet) return publicTableSet;
    try {
      publicTableSet = opts?.cache
        ? await opts.cache.get("public", () => listTables("public"))
        : new Set((await listTables("public")).map((n) => n.toLowerCase()));
    } catch {
      // Best-effort: on adapter failure, fall through with no known tables
      // so the original SQL passes through unchanged (matches the browse
      // path's `?? rawSql` fallback) instead of throwing.
      publicTableSet = new Set();
    }
    return publicTableSet;
  };

  // Per-statement state, reset at every `;` boundary.
  let prevTrigger: "" | "from" | "into" | "update" | "join" = "";
  let pendingCte: boolean = false; // armed right after `WITH [RECURSIVE]`
  let parenDepth = 0;
  const cteNames: Set<string> = new Set<string>();
  // Tracks the last non-whitespace char pushed to the output — used to detect
  // whether the next identifier is qualified (preceded by `.`).
  let lastNonWs = "";
  let rewriteCount = 0;

  const out: string[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i] as string;

    // Statement boundary — reset per-statement state.
    if (ch === ";" && parenDepth === 0) {
      out.push(";");
      lastNonWs = ";";
      i += 1;
      prevTrigger = "";
      pendingCte = false;
      cteNames.clear();
      continue;
    }

    // Single-quoted string literal — push verbatim.
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(sql.slice(start, i));
      lastNonWs = "'";
      continue;
    }

    // Double-quoted identifier — push verbatim, do NOT consider for rewrite.
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(sql.slice(start, i));
      lastNonWs = '"';
      continue;
    }

    // Dollar-quote ($$ or $tag$).
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const start = i;
        i += tag.length;
        while (i <= len - tag.length) {
          if (sql.slice(i, i + tag.length) === tag) {
            i += tag.length;
            break;
          }
          i += 1;
        }
        out.push(sql.slice(start, i));
        lastNonWs = "$";
        continue;
      }
    }

    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < len && sql[i] !== "\n") i += 1;
      out.push(sql.slice(start, i));
      continue;
    }

    // Block comment.
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < len - 1) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      out.push(sql.slice(start, i));
      continue;
    }

    // Parens / commas — reset trigger tracking so a subquery
    // `FROM (SELECT ...)` doesn't leak FROM into a sibling identifier after `)`.
    if (ch === "(") {
      parenDepth += 1;
      prevTrigger = "";
      pendingCte = false;
      out.push("(");
      lastNonWs = "(";
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      prevTrigger = "";
      pendingCte = false;
      out.push(")");
      lastNonWs = ")";
      i += 1;
      continue;
    }
    if (ch === ",") {
      prevTrigger = "";
      pendingCte = false;
      out.push(",");
      lastNonWs = ",";
      i += 1;
      continue;
    }

    // Identifier or keyword.
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentContinue(sql[i] as string)) i += 1;
      const word = sql.slice(start, i);
      const lower = word.toLowerCase();
      const isQualified = lastNonWs === ".";
      const atTopLevel = parenDepth === 0;

      if (atTopLevel && lower === "with") {
        // WITH may start a CTE list or a recursive CTE. Arm CTE-name detection.
        pendingCte = true;
        prevTrigger = "";
        out.push(word);
        lastNonWs = word;
        continue;
      }

      if (atTopLevel && pendingCte && lower === "recursive") {
        // `WITH RECURSIVE` — let RECURSIVE pass through, keep pendingCte armed.
        out.push(word);
        lastNonWs = word;
        continue;
      }
      if (atTopLevel && pendingCte && lower !== "as") {
        // First non-AS identifier right after WITH [RECURSIVE] — treat as CTE name.
        cteNames.add(lower);
        pendingCte = false;
        out.push(word);
        lastNonWs = word;
        continue;
      }

      if (atTopLevel && lower === "as") {
        pendingCte = false;
        prevTrigger = "";
        out.push(word);
        lastNonWs = word;
        continue;
      }

      if (
        atTopLevel &&
        (lower === "from" || lower === "into" || lower === "update" || lower === "join")
      ) {
        prevTrigger = lower;
        pendingCte = false;
        out.push(word);
        lastNonWs = word;
        continue;
      }

      // Rewrite check.
      if (
        atTopLevel &&
        prevTrigger !== "" &&
        !isQualified &&
        !cteNames.has(lower) &&
        isPgReservedKeyword(lower)
      ) {
        const tables = await publicTables();
        if (tables.has(lower)) {
          rewriteCount += 1;
          out.push(`"public"."${word}"`);
          lastNonWs = '"'; // closing quote of `"<name>"`
          // Reset trigger so two adjacent reserved words aren't both rewritten.
          prevTrigger = "";
          pendingCte = false;
          continue;
        }
      }

      // Default — push as-is and clear trigger.
      prevTrigger = "";
      pendingCte = false;
      out.push(word);
      lastNonWs = word;
      continue;
    }

    // Whitespace / other punctuation — push verbatim, leave lastNonWs unchanged.
    out.push(ch);
    i += 1;
  }

  return { sql: out.join(""), changed: rewriteCount > 0 };
}

function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j] as string;
    if (ch === "$") return sql.slice(i, j + 1);
    if (!/[A-Za-z0-9_]/.test(ch)) return null;
    j += 1;
  }
  return null;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentContinue(ch: string): boolean {
  return (
    isIdentStart(ch) ||
    (ch >= "0" && ch <= "9") ||
    ch === "$"
  );
}