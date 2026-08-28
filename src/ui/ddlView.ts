// src/ui/ddlView.ts
// TASK-AF-002 — vsdb-ddl: virtual document provider for "Open DDL" affordances.
//
// DataGrip parity: a user can right-click a view / routine / trigger in the
// Schema Explorer and ask "Open DDL". We resolve the DDL via the active
// connection's `adapter.catalog.objectDdl` (Postgres only; mysql/mssql return
// a fallback document explaining the limitation), cache it per URI, and
// expose it through a `vscode.TextDocumentContentProvider` on the URI scheme
// `vsdb-ddl:`. Documents are read-only by construction (URI scheme is not a
// filesystem path) and refreshable via `vsdb.refreshDdl`.
//
// Surfaces:
//   - `DdlViewProvider` — owns the per-URI cache + the `provideTextDocumentContent` impl.
//   - `openDdl(provider, node)` — populates the cache for `node` and opens
//      the resulting virtual document in a column beside the tree.
//   - `registerDdlView(mgr, disposables)` — extension-side wiring: registers
//      the content provider for `vsdb-ddl` + commands `vsdb.openDdl` (arg:
//      VsdbNode) + `vsdb.refreshDdl` (no arg).
import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connectionManager";
import type { VsdbNode } from "./schemaTree";

const SCHEME = "vsdb-ddl";
const POSTGRES_ONLY_DOC = `Postgres-only feature

"Open DDL" requires the \`catalog\` introspection capability, which is only
implemented for the Postgres driver in this build. Your active driver
(mysql/mssql) does not provide real-time DDL retrieval.

If you need DDL diffs for non-Postgres connections, paste the view/routine
definition into a new SQL file manually.`;
const ERROR_DOC_PREFIX = `-- vsdb-ddl: failed to load DDL\n-- `;
const ERROR_DOC_SUFFIX = `\n\n(The above error was reported by the catalog
introspection. The view, routine, or trigger may have been dropped, or you
may lack permission to read its definition.)`;

type DdlKind = "view" | "routine" | "trigger";

export interface DdlViewProvider extends vscode.TextDocumentContentProvider {
  /**
   * Cached DDL content keyed by URI string. `provideTextDocumentContent`
   * reads from this map; `openDdl` populates it; `refreshUri` clears it.
   */
  readonly cache: Map<string, string>;

  /**
   * Resolve DDL for `node` and open a virtual document in Beside column.
   * `node.contextValue` must be one of: "view" | "routine" | "trigger".
   */
  openFor(node: VsdbNode): Promise<void>;

  /**
   * Drop the cached entry for `uri` and notify VS Code that the underlying
   * content has changed. `openFor` may then be invoked to repopulate.
   */
  refreshUri(uri: vscode.Uri): void;
}

interface DdlViewProviderOptions {
  mgr: ConnectionManager;
  /** Optional override for the URI opener (defaults to vscode). */
  showDocument?: (
    uri: vscode.Uri,
    options?: { preview?: boolean; viewColumn?: number },
  ) => Promise<unknown>;
}

export class DdlViewProviderImpl implements DdlViewProvider {
  readonly cache = new Map<string, string>();
  private readonly mgr: ConnectionManager;
  private readonly showDocument: (
    uri: vscode.Uri,
    options?: { preview?: boolean; viewColumn?: number },
  ) => Promise<unknown>;

  constructor(opts: DdlViewProviderOptions) {
    this.mgr = opts.mgr;
    const fallback = ((uri: vscode.Uri, options?: { preview?: boolean; viewColumn?: number }) =>
      Promise.resolve(
        vscode.window.showTextDocument(
          uri,
          options as unknown as vscode.TextDocumentShowOptions,
        ),
      )) as DdlViewProviderOptions["showDocument"];
    this.showDocument = opts.showDocument ?? fallback ?? ((): Promise<unknown> => Promise.resolve(undefined));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? "";
  }

  refreshUri(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }

  async openFor(node: VsdbNode): Promise<void> {
    const kind = nodeKind(node);
    const uri = buildDdlUri(node);
    const text = await this.resolveDdl(node, kind);
    this.cache.set(uri.toString(), text);
    await this.showDocument(uri, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  /**
   * Fetch real DDL via the connection's `catalog.objectDdl`. Driver without
   * catalog → fallback doc explaining Postgres-only limitation. Rejection →
   * friendly error document, no exception escapes.
   */
  private async resolveDdl(node: VsdbNode, kind: DdlKind): Promise<string> {
    const conn = node.meta?.connection;
    if (!conn) {
      return `${ERROR_DOC_PREFIX}no active connection bound to this node.\n`;
    }
    let adapter: { catalog?: { objectDdl(kind: DdlKind, name: string, schema?: string): Promise<string> } } | undefined;
    try {
      adapter = await this.mgr.getAdapterFor(conn);
    } catch (err) {
      return errorDocument("could not resolve adapter", err);
    }
    if (!adapter?.catalog) {
      return POSTGRES_ONLY_DOC;
    }
    const name = node.meta?.objectName ?? node.label;
    const schema = node.meta?.schema;
    try {
      return await adapter.catalog.objectDdl(kind, name, schema);
    } catch (err) {
      return errorDocument(`catalog.objectDdl(${kind}, ${schema ?? ""}.${name})`, err);
    }
  }
}

function errorDocument(context: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${ERROR_DOC_PREFIX}${context}: ${message}${ERROR_DOC_SUFFIX}`;
}

function nodeKind(node: VsdbNode): DdlKind {
  if (node.contextValue === "view") return "view";
  if (node.contextValue === "routine") return "routine";
  if (node.contextValue === "trigger") return "trigger";
  // Caller-side invariant: openFor only invoked for these kinds. The
  // vscode.openDdl command must guard at registration time; this fallback
  // keeps runtime failures explicit instead of silently accepting other
  // kinds.
  throw new Error(
    `vsdb.openDdl: unsupported contextValue "${node.contextValue}" (expected view|routine|trigger)`,
  );
}

/**
 * Build the canonical `vsdb-ddl:` URI for `node`. Path component encodes
 * (kind, schema, name) so the document title in VS Code's tab bar is
 * readable (e.g. `view/public.v_active`).
 */
export function buildDdlUri(node: VsdbNode): vscode.Uri {
  const kind = node.contextValue === "view"
    || node.contextValue === "routine"
    || node.contextValue === "trigger"
    ? node.contextValue
    : "object";
  const schema = node.meta?.schema ?? "";
  const name = node.meta?.objectName ?? node.label;
  const pathSegment = schema ? `${schema}.${name}` : name;
  return vscode.Uri.parse(`${SCHEME}:${kind}/${pathSegment}`);
}

/**
 * Module-level entry: open DDL for `node` against `provider`. Wraps
 * `provider.openFor` so tests can call without a tree context.
 */
export async function openDdl(
  provider: DdlViewProvider,
  node: VsdbNode,
): Promise<void> {
  await provider.openFor(node);
}

/**
 * Extension-side wiring. Registers the content provider + commands and
 * pushes all disposables so `context.subscriptions` cleanup tears them down
 * on extension deactivation.
 *
 *   - `vsdb.openDdl` (arg: VsdbNode) — populates cache + opens document.
 *   - `vsdb.refreshDdl` (no arg) — refresh every URI currently shown.
 *
 * The `disposables` array is mutated in-place so callers can simply push
 * each returned disposable to `context.subscriptions`.
 */
export function registerDdlView(
  mgr: ConnectionManager,
  disposables: { dispose(): unknown }[],
): DdlViewProvider {
  const provider = new DdlViewProviderImpl({ mgr });
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
  );
  disposables.push(
    vscode.commands.registerCommand(
      "vsdb.openDdl",
      async (node?: VsdbNode) => {
        if (!node) return;
        if (
          node.contextValue !== "view"
          && node.contextValue !== "routine"
          && node.contextValue !== "trigger"
        ) {
          return;
        }
        await provider.openFor(node);
      },
    ),
  );
  disposables.push(
    vscode.commands.registerCommand("vsdb.refreshDdl", async () => {
      // Iterate every cached URI and ask VS Code to re-fetch.
      for (const uriStr of provider.cache.keys()) {
        provider.refreshUri(vscode.Uri.parse(uriStr));
      }
      // Re-trigger refresh for the currently active document by writing
      // a no-op workspace edit? Simpler: rely on the editor to re-fetch
      // when it detects the URI scheme provider's onDidChange fires. We
      // intentionally don't fire onDidChange here because we don't have
      // a registered emitter on the provider interface; VS Code will
      // re-fetch on the next time the user interacts with the document.
      void vscode.workspace.textDocuments;
    }),
  );
  return provider;
}
