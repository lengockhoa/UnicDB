// src/ui/sqlSemanticTokens.ts
// TASK-002 — DocumentSemanticTokensProvider cho .sql: tô màu identifier theo
// bản chất live (schema / table / column) bằng SchemaCache (TTL 60s). TextMate
// chỉ regex-match được — chỉ semantic token biết `users` là table thật.
//
// Contract: never-throw, never-reject — mọi lỗi / cache lạnh → empty token set.
import * as vscode from "vscode";
import type { SchemaCache } from "./schemaCache";
import { maskLiteralsAndComments } from "../core/dangerousStatement";

/** Legend cố định của provider — TextMate colouring riêng cho keyword. */
export const SQL_SEMANTIC_LEGEND: vscode.SemanticTokensLegend = {
  tokenTypes: ["namespace", "class", "property", "keyword"],
  tokenModifiers: [],
};

export interface SqlSemanticTokensDeps {
  /** Cache (TTL) wrapping adapter introspection — cùng shape SqlCompletionProvider. */
  cache: SchemaCache;
  /** False khi không có active connection → provider im lặng. */
  hasConnection?: () => boolean;
  /** Timeout chờ cache lạnh (test có thể đổi để nhanh hơn). */
  coldLookupTimeoutMs?: number;
}

const DEFAULT_COLD_LOOKUP_TIMEOUT_MS = 50;

const TIMEOUT: unique symbol = Symbol("cold-lookup-timeout");

export class SqlSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider
{
  readonly onDidChangeSemanticTokens: vscode.Event<void>;
  private readonly emitter: vscode.EventEmitter<void>;
  private readonly deps: SqlSemanticTokensDeps;
  /** Chặn fire-per-edit loop khi cache còn lạnh (xem Discussion R1 finding 2). */
  private coldRefreshScheduled = false;

  constructor(deps: SqlSemanticTokensDeps) {
    this.deps = deps;
    this.emitter = new vscode.EventEmitter<void>();
    this.onDidChangeSemanticTokens = (listener) => this.emitter.event(listener);
  }

  // `_token` giữ đúng arity của vscode.DocumentSemanticTokensProvider
  // (CancellationToken) — legend là hằng số module cố định, không cần truyền.
  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    _token?: unknown,
  ): Promise<vscode.SemanticTokens> {
    try {
      if (this.deps.hasConnection && !this.deps.hasConnection()) {
        return this.emptyTokens();
      }
      const scan = this.scanDocument(document);
      const timeoutMs =
        this.deps.coldLookupTimeoutMs ?? DEFAULT_COLD_LOOKUP_TIMEOUT_MS;
      const settled = await Promise.race([
        scan,
        new Promise<typeof TIMEOUT>((resolve) => {
          setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);
      if (settled === TIMEOUT) {
        // Cache lạnh (adapter/network còn pending) → paint trống bây giờ,
        // refresh 1 lần khi lookup thật settle. Không fire synchronous.
        this.scheduleColdRefresh(scan);
        return this.emptyTokens();
      }
      return settled;
    } catch {
      return this.emptyTokens();
    }
  }

  /** VS Code re-request tokens cho mọi SQL document đang visible khi fire. */
  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  // ---- Private ---------------------------------------------------------------

  private emptyTokens(): vscode.SemanticTokens {
    return new vscode.SemanticTokens(new Uint32Array(0));
  }

  /**
   * Schedule đúng MỘT refresh sau khi lookup đang in-flight settle. Boolean
   * ngăn fire-per-edit loop: fire → re-request → vẫn lạnh → fire lại là vòng
   * vô hạn. Không bao giờ fire synchronous trong provide().
   */
  private scheduleColdRefresh(scan: Promise<vscode.SemanticTokens>): void {
    if (this.coldRefreshScheduled) return;
    this.coldRefreshScheduled = true;
    void scan
      .then(() => {
        this.coldRefreshScheduled = false;
        this.refresh();
      })
      .catch(() => {
        this.coldRefreshScheduled = false;
      });
  }

  /**
   * Scan toàn bộ document: mask literal/comment, resolve schema/table/column
   * từ cache, build token data. FROM target không resolve được → chỉ emit
   * schema/table tokens (degradation cho phép).
   */
  private async scanDocument(
    document: vscode.TextDocument,
  ): Promise<vscode.SemanticTokens> {
    const text = document.getText();
    const masked = maskLiteralsAndComments(text);

    const [schemas, tables] = await Promise.all([
      this.deps.cache.getSchemas(),
      this.deps.cache.getTables(),
    ]);
    const schemaSet = new Set(schemas.map((s) => s.name.toLowerCase()));
    const tableSet = new Set(tables.map((t) => t.name.toLowerCase()));

    // FROM target cuối cùng quyết định bộ column (subquery FROM trong
    // document → relation chính là cái sau cùng).
    const fromRe = /\bfrom\s+(?:([A-Za-z_][\w$]*)\s*\.\s*)?([A-Za-z_][\w$]*)/gi;
    let fromSchema: string | undefined;
    let fromTable: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(masked)) !== null) {
      fromSchema = m[1] ?? undefined;
      fromTable = m[2]!;
    }

    const columnSet = new Set<string>();
    if (fromTable) {
      try {
        const cols = await this.deps.cache.getColumns(fromTable, fromSchema);
        for (const c of cols) columnSet.add(c.name.toLowerCase());
      } catch {
        // FROM không resolve → bỏ column, vẫn emit schema/table.
      }
    }

    const builder = new vscode.SemanticTokensBuilder();
    const wordRe = /[A-Za-z_][\w$]*/g;
    let w: RegExpExecArray | null;
    while ((w = wordRe.exec(masked)) !== null) {
      const word = w[0];
      const lower = word.toLowerCase();
      let type: string | null = null;
      if (schemaSet.has(lower)) type = "namespace";
      else if (tableSet.has(lower)) type = "class";
      else if (columnSet.has(lower)) type = "property";
      if (type === null) continue;
      const pos = document.positionAt(w.index);
      builder.push(
        pos.line,
        pos.character,
        word.length,
        SQL_SEMANTIC_LEGEND.tokenTypes.indexOf(type),
      );
    }
    return builder.build();
  }
}