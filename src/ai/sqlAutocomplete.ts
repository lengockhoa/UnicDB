// src/ai/sqlAutocomplete.ts
// Cycle AIC — TASK-AIC-002.
// Pure, testable SQL autocomplete orchestration service.
//
// Design contract (PLAN §3.0, §3.2; TASK-AIC-002 §Goal / §Interfaces):
//   - NO `vscode` import — exercised directly under vitest with fakes.
//   - Schema-only context. Prompt includes ONLY schema/table/column names
//     plus bounded cursor prefix/suffix, the active dialect label, and the
//     connection's display name. NEVER rows, results, history, secrets,
//     baseUrl, or full document.
//   - One active request per caller scope. A new call into the SAME caller
//     scope aborts the previous one and discards its late result.
//   - LRU cache (TTL + size) keyed by (callerScope, schemaFingerprint,
//     bounded prefix, bounded suffix). Cooldown prevents thrash on rapid
//     identical requests. Connection change → callerScope changes → cache
//     miss is automatic.
//   - Result sanitization: short SQL suffix only. Strips fences, leading
//     ";", English-prose markers; truncates to the FIRST non-empty line.
//   - Silently returns `null` on disabled/cancelled/stale/malformed/error
//     states. No notifications, no throws, no logging of prompt/response.

import type { AiConfig } from "./settings";
import type { ProviderRequest, ProviderResult } from "./provider";

// ---- hard bounds (exported, tested) ---------------------------------------
export const DEBOUNCE_MS = 300;
export const SQL_PREFIX_MAX_CHARS = 2_000;
export const SQL_SUFFIX_MAX_CHARS = 500;
export const SCHEMA_CONTEXT_MAX_CHARS = 12_000;
export const MAX_OUTPUT_TOKENS = 64;
export const CACHE_TTL_MS = 30_000;
export const CACHE_MAX_ENTRIES = 100;
export const COOLDOWN_MS = 500;

// ---- types ----------------------------------------------------------------
/** Provider function the host wires up. role is always "autocomplete". */
export type ProviderFn = (
  cfg: AiConfig,
  role: "autocomplete",
  req: ProviderRequest,
  signal: AbortSignal,
) => Promise<ProviderResult>;

/** Logger injection point. The service NEVER passes prompt or suffix text. */
export type Logger = {
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
};

/** A single table's schema info, used in the prompt. */
export interface SchemaTable {
  schema: string;
  name: string;
  columns: Array<{ name: string; dataType: string }>;
}

/** Schema context. Stripped of credentials, rows, history, body bytes. */
export interface SchemaContext {
  dialect: string;
  connectionName: string;
  tables: SchemaTable[];
}

/** The request the service receives. */
export interface SqlAutocompleteRequest {
  /** Caller scope — e.g. `document.uri.toString()` for the editor, or
   *  `${consoleTabId}` for the Console. Distinct scopes own their own
   *  active request, sequence number, and cache partition. */
  callerScope: string;
  /** Cursor offset (0-based) in the document. */
  cursorOffset: number;
  /** Full document text. The service slices it itself with bounded caps. */
  documentText: string;
  /** Free-form schema fingerprint used as part of the cache key. A schema
   *  refresh / connection change should bump this to invalidate stale
   *  cache entries automatically. */
  schemaFingerprint: string;
  /** Optional external cancellation signal. When aborted, the in-flight
   *  request short-circuits to `null` without leaking a late suffix. The
   *  service still owns its own per-scope AbortController — this signal is
   *  ADDITIVE: any of them aborting is enough. */
  signal?: AbortSignal;
}

/** Logger spy option. */
export interface ServiceLogger {
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface ServiceOptions {
  provider: ProviderFn;
  /** Resolves the active schema context. The service NEVER calls any
   *  row/value accessor here — only schema/table/column lists. */
  resolveSchema: (callerScope: string) => Promise<SchemaContext>;
  logger?: ServiceLogger;
  /** Injectable wall clock for tests. */
  now?: () => number;
}

// ---- helpers --------------------------------------------------------------

/** Slice the document around the cursor, bounded by the configured caps. */
export function sliceAroundCursor(
  text: string,
  offset: number,
  maxPrefix: number,
  maxSuffix: number,
): { prefix: string; suffix: string } {
  const o = Math.max(0, Math.min(text.length, offset));
  const start = Math.max(0, o - maxPrefix);
  const end = Math.min(text.length, o + maxSuffix);
  return { prefix: text.slice(start, o), suffix: text.slice(o, end) };
}

/** True iff the SQL text is "essentially empty" — whitespace + comments. */
export function isCommentOnlyOrWhitespace(text: string): boolean {
  const stripped = text
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  return stripped.length === 0;
}

/** Build a stable cache key for the request. */
export function buildCacheKey(
  req: SqlAutocompleteRequest,
  ctx: SchemaContext,
  prefix: string,
  suffix: string,
): string {
  return [
    req.callerScope,
    ctx.dialect,
    ctx.connectionName,
    req.schemaFingerprint,
    prefix,
    suffix,
  ].join("\u0000");
}

/** Build the prompt sent to the provider. Schema-only. */
export function buildPrompt(
  ctx: SchemaContext,
  prefix: string,
  suffix: string,
  schemaMaxChars: number,
): string {
  const lines: string[] = [];
  lines.push("You are an inline SQL autocomplete engine.");
  lines.push(
    "Reply with ONLY the SQL text that should be appended at the cursor. " +
      "No prose, no fences, no explanation. Keep it short (under 80 chars).",
  );
  lines.push("");
  lines.push(`dialect: ${ctx.dialect}`);
  lines.push(`connection: ${ctx.connectionName}`);
  lines.push("");
  lines.push("schema (table(column: type)):");
  const schemaLines: string[] = ctx.tables.map((t) =>
    `${t.schema}.${t.name}(${t.columns
      .map((c) => `${c.name}:${c.dataType}`)
      .join(", ")})`,
  );
  let schemaBlock = schemaLines.join("\n");
  if (schemaBlock.length > schemaMaxChars) {
    schemaBlock = schemaBlock.slice(0, schemaMaxChars) + "\u2026";
  }
  lines.push(schemaBlock || "(no tables in scope)");
  lines.push("");
  lines.push("--- cursor prefix ---");
  lines.push(prefix);
  lines.push("--- cursor suffix ---");
  lines.push(suffix);
  return lines.join("\n");
}

/** Sanitize the provider's response into a single safe SQL insertion. */
export function sanitizeSuffix(text: string): string {
  if (!text) return "";
  // Strip surrounding code fences.
  let s = text
    .replace(/^```(?:sql)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Keep only the first non-empty line — single-line continuation.
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  // Reject obvious English prose.
  if (/\b(the|please|here|sure|note:|explanation)\b/i.test(firstLine)) return "";
  // Strip leading semicolon (we always insert BEFORE the user's own next chars).
  let cleaned = firstLine.replace(/^\s*;\s*/, "");
  // Strip trailing SQL comments (`-- …` end-of-line and trailing `/* … */`)
  // so a provider that appends a comment to its SQL suffix cannot leak the
  // comment into the user's buffer. Comments INSIDE string literals / quoted
  // identifiers / dollar-quoted bodies must be preserved — the stripper walks
  // those lexical contexts instead of regexing blindly.
  cleaned = stripTrailingSqlComments(cleaned);
  // Drop trailing semicolons + whitespace — never end a continuation with ";".
  cleaned = cleaned.replace(/[\s;]+$/, "").trim();
  return cleaned;
}

/**
 * Remove trailing SQL line/block comments that are NOT inside a string
 * literal, a double-quoted identifier, or a dollar-quoted body.
 *
 * The provider occasionally appends a `-- note` or `/* hint *\/` after the
 * actual SQL. Those comments are model noise — they are not valid SQL to
 * insert at the cursor — and they bloat the user's buffer. We strip:
 *   - trailing `-- …` to end-of-line
 *   - trailing `/* … *\/` (block comment) if it extends to end of input
 * Lexical contexts that may legitimately contain `--` are copied verbatim:
 *   - single-quoted string literals (with `''` escapes)
 *   - PostgreSQL double-quoted identifiers (with `""` escapes)
 *   - PostgreSQL dollar-quoted strings `$tag$…$tag$`
 */
export function stripTrailingSqlComments(text: string): string {
  // Walk char-by-char so we know which lexical context we are in.
  let i = 0;
  let result = "";
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      // Single-quoted string literal: copy verbatim until the closing
      // unescaped `'` (a doubled `''` is an escaped quote).
      const [nextI, copied] = copyQuotedRegion(text, i, "'");
      result += copied;
      i = nextI;
      continue;
    }
    if (ch === '"') {
      const [nextI, copied] = copyQuotedRegion(text, i, '"');
      result += copied;
      i = nextI;
      continue;
    }
    if (ch === "$") {
      const tag = readDollarTag(text, i);
      if (tag !== null) {
        const close = text.indexOf(tag, i + tag.length);
        const end = close < 0 ? text.length : close + tag.length;
        result += text.slice(i, end);
        i = end;
        continue;
      }
      result += ch;
      i++;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      // Trailing line comment — drop everything to end of input.
      break;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) {
        // Unterminated — strip to end (defensive; shouldn't happen).
        break;
      }
      // Only treat as "trailing" if nothing but whitespace follows the
      // comment. Otherwise it is a mid-statement hint — keep it verbatim
      // and continue scanning after it.
      const restAfter = text.slice(close + 2).trim();
      if (restAfter.length === 0) {
        break;
      }
      result += text.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Copy a `'…'` or `"…"` region (with doubled-quote escapes) verbatim,
 *  returning `[index just past the closing quote, copied text]`. If
 *  unterminated, copies the rest of the input. */
function copyQuotedRegion(
  text: string,
  start: number,
  quote: string,
): [number, string] {
  let i = start;
  let out = quote;
  i++;
  while (i < text.length) {
    const c = text[i]!;
    out += c;
    i++;
    if (c === quote) {
      if (text[i] === quote) {
        // Doubled quote — escaped, stay inside the region.
        out += quote;
        i++;
        continue;
      }
      break;
    }
  }
  return [i, out];
}

/** If `text` at `i` starts with a dollar-quote delimiter (`$tag$` or `$$`),
 *  return the full delimiter; otherwise null. Tag body is
 *  `[A-Za-z_][A-Za-z0-9_]*`. */
function readDollarTag(text: string, i: number): string | null {
  if (text[i] !== "$") return null;
  const n = text.length;
  let j = i + 1;
  if (j < n && text[j] === "$") return "$$";
  const c = text[j];
  if (j >= n || !/[A-Za-z_]/.test(c!)) return null;
  j++;
  while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
  if (text[j] !== "$") return null;
  return text.slice(i, j + 1);
}

// ---- service --------------------------------------------------------------

/**
 * SqlAutocompleteService — the sole debounce/cancellation/cache owner for
 * the AIC feature. Editor (AIC-003) and Console (AIC-004) share this
 * service only — they keep their own caller scopes and own no debounce.
 */
export class SqlAutocompleteService {
  private readonly provider: ProviderFn;
  private readonly resolveSchema: (scope: string) => Promise<SchemaContext>;
  private readonly logger: ServiceLogger | undefined;
  private readonly now: () => number;

  /** Active request per caller scope; new calls into the same scope abort. */
  private readonly active = new Map<string, AbortController>();
  /** Monotonic per-scope sequence number — stale-result guard. */
  private readonly sequence = new Map<string, number>();
  /** Bounded LRU cache: key → { suffix, expiresAt }. */
  private readonly cache = new Map<string, { suffix: string; expiresAt: number }>();
  /** LRU insertion order — first element is oldest. */
  private readonly cacheOrder: string[] = [];
  /** Last successful call timestamp per scope — for cooldown. */
  private readonly lastCallAt = new Map<string, number>();

  constructor(opts: ServiceOptions) {
    this.provider = opts.provider;
    this.resolveSchema = opts.resolveSchema;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Request a SQL ghost-text suffix.
   *
   * Returns a non-null, non-empty SQL insertion string only when the call
   * completes successfully, the response is current for the latest
   * sequence in the scope, and the result sanitizes to a single safe line.
   *
   * Returns `null` for: unconfigured model, cancelled, superseded, stale,
   * empty/comment-only cursor context, schema-source failure, malformed
   * provider text, or any provider error. Never throws.
   */
  async suggest(
    cfg: AiConfig,
    req: SqlAutocompleteRequest,
  ): Promise<string | null> {
    // 1. Configured? Empty modelId = disabled, no provider call.
    const ac = cfg.models.autocomplete;
    if (!ac || !ac.modelId || ac.modelId.trim() === "") return null;

    // 2. Cursor context must contain non-comment SQL.
    if (isCommentOnlyOrWhitespace(req.documentText)) return null;

    // External signal — pre-cancelled → no work.
    if (req.signal?.aborted) return null;
    // 3. Sequence + active controller.
    const seq = (this.sequence.get(req.callerScope) ?? 0) + 1;
    this.sequence.set(req.callerScope, seq);
    const prev = this.active.get(req.callerScope);
    if (prev) prev.abort();
    const controller = new AbortController();
    this.active.set(req.callerScope, controller);
    linkSignal(controller, req.signal);
    try {
      // 4. Cooldown: same scope requested too recently → null. Prevents
      //    thrash on rapid identical typing. Per spec test #5: a distinct
      //    request inside COOLDOWN_MS returns null with no extra provider
      //    call. We do NOT fall back to "most recent" cache here — only an
      //    exact (scope, fingerprint, cursor-slice) match counts.
      const last = this.lastCallAt.get(req.callerScope) ?? 0;
      if (this.now() - last < COOLDOWN_MS) {
        return null;
      }

      // 5. Resolve schema context.
      let ctx: SchemaContext;
      try {
        ctx = await this.resolveSchema(req.callerScope);
      } catch {
        return null;
      }
      if (controller.signal.aborted) return null;
      // Schema-only — strip anything that smells like a row/value.
      ctx = sanitizeSchemaContext(ctx);

      // 6. Bounded cursor slice.
      const { prefix, suffix } = sliceAroundCursor(
        req.documentText,
        req.cursorOffset,
        SQL_PREFIX_MAX_CHARS,
        SQL_SUFFIX_MAX_CHARS,
      );
      const cacheKey = buildCacheKey(req, ctx, prefix, suffix);
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > this.now()) {
        this.lastCallAt.set(req.callerScope, this.now());
        return cached.suffix;
      }

      // 7. Build the schema-only prompt.
      const prompt = buildPrompt(ctx, prefix, suffix, SCHEMA_CONTEXT_MAX_CHARS);
      const providerReq: ProviderRequest = {
        modelId: ac.modelId,
        messages: [
          {
            role: "system",
            content:
              "You complete SQL. Reply with ONLY the SQL suffix to insert at the cursor. " +
              "No prose, no fences, no explanation. Keep it short (under 80 chars).",
          },
          { role: "user", content: prompt },
        ],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.1,
      };

      // 8. Fire the request. Race it against the caller-scope abort.
      let result: ProviderResult;
      try {
        result = await raceWithAbort(
          this.provider(cfg, "autocomplete", providerReq, controller.signal),
          controller.signal,
        );
      } catch {
        return null;
      }
      if (controller.signal.aborted) return null;

      // 9. Stale-result guard: did a newer call bump our sequence?
      const currentSeq = this.sequence.get(req.callerScope) ?? 0;
      if (currentSeq !== seq) return null;

      // 10. Sanitize the response. Empty / prose / fenced → null.
      const cleaned = sanitizeSuffix(result.text ?? "");
      if (!cleaned) return null;
      if (controller.signal.aborted) return null;

      // 11. Store in cache + cooldown.
      this.putCache(cacheKey, cleaned);
      this.lastCallAt.set(req.callerScope, this.now());
      return cleaned;
    } finally {
      // Only clear the active slot if we still own it.
      if (this.active.get(req.callerScope) === controller) {
        this.active.delete(req.callerScope);
      }
    }
  }

  /** Cancel the in-flight request for the given caller scope (if any). */
  cancel(callerScope: string): void {
    const ctrl = this.active.get(callerScope);
    if (ctrl) ctrl.abort();
    if (this.active.get(callerScope) === ctrl) {
      this.active.delete(callerScope);
    }
  }

  /** Drop cache, cooldown, sequence, active for one scope. Call on
   *  active-connection change or schema refresh so old cache keys
   *  cannot serve a different schema/connection. */
  invalidate(callerScope: string): void {
    this.cancel(callerScope);
    this.lastCallAt.delete(callerScope);
    this.sequence.delete(callerScope);
    for (const k of Array.from(this.cache.keys())) {
      // Cache key starts with callerScope\u0000.
      if (k.startsWith(`${callerScope}\u0000`)) {
        this.cache.delete(k);
        const i = this.cacheOrder.indexOf(k);
        if (i >= 0) this.cacheOrder.splice(i, 1);
      }
    }
  }

  /** Drop ALL state — used by extension deactivate. */
  invalidateAll(): void {
    for (const c of Array.from(this.active.values())) c.abort();
    this.active.clear();
    this.sequence.clear();
    this.cache.clear();
    this.cacheOrder.length = 0;
    this.lastCallAt.clear();
  }

  // ---- internals --------------------------------------------------------

  private putCache(key: string, suffix: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      const i = this.cacheOrder.indexOf(key);
      if (i >= 0) this.cacheOrder.splice(i, 1);
    }
    this.cache.set(key, { suffix, expiresAt: this.now() + CACHE_TTL_MS });
    this.cacheOrder.push(key);
    while (this.cacheOrder.length > CACHE_MAX_ENTRIES) {
      const drop = this.cacheOrder.shift();
      if (drop !== undefined) this.cache.delete(drop);
    }
  }

}

// ---- module-internal helpers ---------------------------------------------

/** Strip anything that doesn't belong in a schema context. Defensive. */
function sanitizeSchemaContext(ctx: SchemaContext): SchemaContext {
  return {
    dialect: String(ctx.dialect ?? "").slice(0, 64),
    connectionName: String(ctx.connectionName ?? "").slice(0, 256),
    tables: (ctx.tables ?? []).slice(0, 200).map((t) => ({
      schema: String(t.schema ?? "").slice(0, 128),
      name: String(t.name ?? "").slice(0, 128),
      columns: (t.columns ?? []).slice(0, 200).map((c) => ({
        name: String(c.name ?? "").slice(0, 128),
        dataType: String(c.dataType ?? "").slice(0, 64),
      })),
    })),
  };
}

/** Link an external AbortSignal into an internal controller so either
 *  source aborting rejects the wrapped promise. */
function linkSignal(
  internal: AbortController,
  external: AbortSignal | undefined,
): void {
  if (!external) return;
  if (external.aborted) internal.abort();
  external.addEventListener(
    "abort",
    () => internal.abort(),
    { once: true, signal: internal.signal },
  );
}

/** Race a promise against an AbortSignal. Resolves with the original value
 *  if it wins; rejects on abort. The provider promise itself is NOT
 *  cancelable through this primitive (the host's `createProviderClient`
 *  has its own internal timeout), but the late result is discarded. */
function raceWithAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
