// src/ui/aiChatPanel.ts — TASK-004 ACP permission coordinator + panel
// session wiring.
//
// AiChatPanel — single-instance webview panel that hosts a multi-turn chat
// against the AI agent. The webview only sends: ready, send, stop, clear,
// permission_response. The host builds the message list (system prompt +
// history + user msg), wires the tool registry (createDbTools +
// register(createSqlTool)), and runs runAgent with a ChatAbortToken gating
// final-assistant posting.
//
// Engine modes:
//   - "builtin" — runAgent via direct provider. Used when no acp deps or
//     when the ACP session has terminated (fallback per spec).
//   - "acp"     — spawn omp acp; stream session/update.agent_message_chunk
//                 as assistant deltas; surface server-side
//                 session/request_permission as opaque-ID host requests and
//                 reply with one ACP result per server request.
//
// Stop / dispose / replacement / process exit / timeout semantics:
//   - Incoming `stop` flips ChatAbortToken and cancels every pending
//     permission request with a one-shot cancelled ACP result.
//   - Panel dispose, replacement send, process exit, and the per-request
//     timeout all do the same: every outstanding opaque ID is settled
//     exactly once with `outcome:"cancelled"`.
//
// Permission security contract (TASK-003 + TASK-004):
//   - requestId is host-generated opaque; never derived from server data.
//   - To allow, the webview must echo the SAME requestId AND a listed
//     optionId. Anything else (unknown requestId, unlisted optionId,
//     duplicate response, late response) is treated as deny.
//   - Tool/detail/option text is rendered verbatim as plain text — no
//     innerHTML, no markdown.
//   - apiKey never crosses either direction of the wire.
//
// Mirror pattern (aiSettingsForm / newTableForm): CSP strict, reveal-on-
// reshow, dispose parity, no apiKey ever sent to webview.
 import * as vscode from "vscode";
 import {
   runAgent,
   type AgentDeps,
   type AgentStep,
  type AgentTool,
   type AgentCallbacks,
   type ToolRegistry,
 } from "../ai/agent";
import type { ChatMessage, ChatContentPart } from "../ai/provider";
import type { AdapterFactory } from "../ai/tools/types";
import {
  MAX_ATTACHMENTS_PER_TURN,
  validateImageAttachment,
  validateAttachmentsForVision,
  summarizeAttachmentsForLog,
  type MinimalAttachment,
} from "./aiChatAttachments";
import { defaultAiSettings } from "../ai/settings";
import { createDbTools } from "../ai/tools/registry";
import { createSqlTool } from "../ai/tools/sqlTool";
import { createExportStructureTool } from "../ai/tools/schemaTools";
import { createDbAwareTools } from "../ai/tools/dbAwareTools";
import type { AcpProcessHandle } from "../ai/omp/acpProcess";
import { createMcpBridge, type McpBridge } from "../ai/omp/mcpBridge";
 import {
   buildDatabaseStructure,
   buildTableStructure,
   buildViewStructure,
   type ExportColumn,
 } from "./exportStructure";
 import type {
   TableInfo,
   ViewInfo,
   ColumnInfo,
   RoutineInfo,
   DbAdapter,
 } from "../adapters/types";
 import {
   type AcpServerRequest,
   type AcpNotification,
   type AcpReplayNotification,
   type AcpReplayBuffer,
   type AcpSessionListItem,
 } from "../ai/omp/acp";
 import {
   HISTORY_RENDER_CAP,
   type AiChatPanelEngine,
   type AiChatPanelHostMessage,
   type AiChatPanelWebviewMessage,
} from "./aiChatPanelMessages";
import type { OmpChatEngine } from "../ai/omp/ompChatEngine";
 import { buildPermissionToolInfo } from "./permissionDetail";
 
 const PANEL_ID = "vsdb.aiChatPanel";
 
 const SCHEMA_CONTEXT_BUDGET = 12_000; // chars (tăng từ 8000)
 const SCHEMA_CONTEXT_TABLE_LIMIT = 200; // objects (tăng từ 30)
 const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

// ============================================================================
// TASK-005 — @-mention references (DB objects + workspace files)
// ============================================================================

/** Hard cap for `mention_objects.items` (DB shortlist). Past this the list
 * is truncated; the webview filters client-side. */
export const MENTION_OBJECT_CAP = 30;
/** Hard cap for file candidates in `mention_objects.items`. */
export const MENTION_FILE_CAP = 20;
/** Kinds we surface in the mention dropdown. */
export const MENTION_OBJECT_KINDS = [
  "table",
  "view",
  "routine",
  "file",
] as const;
/** 100 KB cap on file-content blocks (TASK-005 spec). Files above this
 * are truncated and a `[truncated]` notice line is appended. */
export const MENTION_RESOLVE_FILE_CAP_BYTES = 100 * 1024;
/** Regex for @-tokens: optional `schema.` or `path/` prefix + bare
 * identifier. Word/dot/hyphen/underscore characters only — no spaces, no
 * punctuation that would extend past the real token boundary.
 * Emails (`foo@bar`) do NOT match because the `(?<![\w@])` lookbehind
 * requires no word char AND no `@` directly before the `@` we're
 * matching. */
const MENTION_TOKEN_RE = /(?<![\w@])@((?:[\w.-]+\/)*[\w.-]+)/g;

/** Pure @-token extractor. Returns the canonical token text (no leading
 * `@`), deduplicated, order-stable. Empty / no-mention text → []. */
export function parseMentionTokens(text: string): string[] {
  if (text.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_TOKEN_RE)) {
    let tok = m[1];
    if (tok === undefined || tok.length === 0) continue;
    // Strip trailing `.` / `,` / `;` so a mention like "@users." yields
    // the same token as "@users". Hyphens/digits stay (they're legal in
    // identifier names); we only trim punctuation that can never end a
    // real schema/path/identifier token.
    tok = tok.replace(/[.,;]+$/u, "");
    if (tok.length === 0) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}


/**
 * Strip the `--- Referenced context ---` mention-augmentation block from
 * a user-message string. `handleSend` mutates `userMsg.content` to embed
 * the resolved DDL/file body under this header (see `:908`), then that
 * augmented text is what lands in `this.history`. Regenerate pops the
 * trailing `[user, assistant]` pair; before re-sending, we strip the
 * augmentation so the normal send path re-resolves mentions fresh from
 * the ORIGINAL trimmed text — otherwise the model sees the DDL twice
 * (once in the prompt text, once as a freshly-appended block) and the
 * wire's "user text" leaks the schema body verbatim.
 *
 * The marker is exactly the prefix `resolveMentionsForTurn` writes
 * (`--- Referenced context ---` plus the appended body). A user typing
 * this literal header themselves would need the exact `\n\n` separator
 * AND the exact header text — collisions are not a concern in practice.
 */
export function stripReferencedContextMarker(text: string): string {
  const idx = text.indexOf("\n\n--- Referenced context ---");
  if (idx === -1) return text;
  return text.slice(0, idx);
}

/** Resolved mention item returned by `resolveMentionsForTurn`. `block` is
 * the per-turn context text that gets appended under the `--- Referenced
 * context ---` header. `kind` mirrors `MentionObjectItem.kind` so the
 * host can post `mention_miss` per missing token. */
export interface MentionResolveItem {
  kind: "table" | "view" | "routine" | "file";
  token: string;
  /** The literal string inserted at @-time (e.g. "public.users"). */
  label: string;
  /** Displayable per-kind DDL / file body — never apiKey material. */
  block: string;
}

/** Item shape on the wire (`AiChatPanelMentionObjects.items`). Re-exported
 * here so tests can construct fixtures without depending on the message
 * module's exact type shape (host contract is `MentionObjectItem`). */
export type MentionObjectItem = MentionResolveItem;

/** Result of `resolveMentionsForTurn`. `resolved` is the per-token DDL /
 * file blocks in input order (deduped); `misses` is the list of tokens
 * the host could not resolve to either a DB object or a workspace file —
 * the caller is expected to post one `mention_miss` per entry to the
 * webview so the user knows the token was silently dropped. */
export interface MentionResolveResult {
  resolved: MentionResolveItem[];
  misses: string[];
  /** Concatenated blocks joined by blank lines, wrapped in the
   * `--- Referenced context ---` header (only when non-empty). */
  contextBlock: string;
}

/** Optional deps for file resolution + workspace-root override. Tests
 * inject `fs` so they can stage files without touching the real disk;
 * production callers omit and the helper uses `vscode.workspace.fs.readFile`
 * + the first workspace folder. */
export interface ResolveMentionsOptions {
  fs?: typeof vscode.workspace.fs.readFile;
  workspaceRoot?: string;
}

/** Resolve a list of @-tokens (output of `parseMentionTokens`) into per-turn
 * context blocks. Object tokens use the adapter's introspection APIs
 * (listTables/listViews/listRoutines/listColumns) — the SAME DDL-only path
 * `buildMessages` uses, NEVER `runQuery`. File tokens are read via
 * `vscode.workspace.fs.readFile` with a 100KB cap. Unresolved tokens
 * are returned in `misses`; the caller posts `mention_miss` for each.
 *
 * `adapterFactory` may return `null` or throw — both cases yield an empty
 * resolution and every token becomes a miss. The function NEVER throws. */
export async function resolveMentionsForTurn(
  adapterFactory: AdapterFactory,
  tokens: readonly string[],
  options: ResolveMentionsOptions = {},
): Promise<MentionResolveResult> {
  const out: MentionResolveResult = {
    resolved: [],
    misses: [],
    contextBlock: "",
  };
  if (tokens.length === 0) return out;

  // Dedupe input tokens, order-stable. `parseMentionTokens` already dedupes
  // but a programmatic caller may pass a raw list — duplicate tokens must
  // collapse here so the user never sees the same DDL block twice in one
  // turn's context injection.
  const seen = new Set<string>();
  const uniqueTokens: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniqueTokens.push(t);
  }

  const fs = options.fs ?? vscode.workspace.fs.readFile;
  const workspaceRoot =
    options.workspaceRoot ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    process.cwd();

  let adapter: DbAdapter | null = null;
  try {
    adapter = await adapterFactory();
  } catch {
    adapter = null;
  }

  // Collect DB shortlist once (reused across object tokens). Best-effort —
  // any introspection failure degrades to an empty shortlist (the token
  // then becomes a miss or a file match).
  let dbShortlist: Map<string, { kind: "table" | "view" | "routine"; schema: string; name: string }> = new Map();
  if (adapter !== null) {
    try {
      const schemas = await adapter.listSchemas(false);
      for (const s of schemas) {
        let tables: TableInfo[] = [];
        try {
          tables = await adapter.listTables(s.name);
        } catch {
          tables = [];
        }
        for (const t of tables) {
          dbShortlist.set(`${t.schema}.${t.name}`, {
            kind: "table",
            schema: t.schema,
            name: t.name,
          });
          dbShortlist.set(t.name, {
            kind: "table",
            schema: t.schema,
            name: t.name,
          });
        }
        let views: ViewInfo[] = [];
        try {
          views = await adapter.listViews(s.name);
        } catch {
          views = [];
        }
        for (const v of views) {
          dbShortlist.set(`${v.schema}.${v.name}`, {
            kind: "view",
            schema: v.schema,
            name: v.name,
          });
          dbShortlist.set(v.name, {
            kind: "view",
            schema: v.schema,
            name: v.name,
          });
        }
        let routines: RoutineInfo[] = [];
        try {
          routines = await adapter.listRoutines(s.name);
        } catch {
          routines = [];
        }
        for (const r of routines) {
          dbShortlist.set(`${r.schema}.${r.name}`, {
            kind: "routine",
            schema: r.schema,
            name: r.name,
          });
          dbShortlist.set(r.name, {
            kind: "routine",
            schema: r.schema,
            name: r.name,
          });
        }
      }
    } catch {
      // Introspection hard-failed — every object token becomes a miss.
      dbShortlist = new Map();
    }
  }

  for (const token of uniqueTokens) {
    const obj = dbShortlist.get(token);
    if (obj !== undefined) {
      const block = await resolveObjectBlock(adapter, obj);
      if (block !== null) {
        out.resolved.push({
          kind: obj.kind,
          token,
          label: `${obj.schema}.${obj.name}`,
          block,
        });
        continue;
      }
    }
    // Fall back to file resolution. We attempt the file read for every
    // unresolved token — the read is best-effort (ENOENT → miss).
    const fileBlock = await resolveFileBlock(
      fs,
      workspaceRoot,
      token,
    );
    if (fileBlock !== null) {
      out.resolved.push({
        kind: "file",
        token,
        label: token,
        block: fileBlock,
      });
      continue;
    }
    out.misses.push(token);
  }

  if (out.resolved.length > 0) {
    const body = out.resolved.map((r) => r.block).join("\n\n");
    out.contextBlock = `--- Referenced context ---\n${body}`;
  }
  return out;
}

/** Resolve a single DB object to its DDL block via `buildTableStructure` /
 * `buildViewStructure` — same DDL-only path as `buildMessages`. Returns
 * null if the introspection call throws (degrades silently — caller will
 * treat the token as a miss). */
async function resolveObjectBlock(
  adapter: DbAdapter | null,
  obj: { kind: "table" | "view" | "routine"; schema: string; name: string },
): Promise<string | null> {
  if (adapter === null) return null;
  if (obj.kind === "table") {
    let cols: ColumnInfo[] = [];
    try {
      cols = await adapter.listColumns(obj.name, obj.schema);
    } catch {
      cols = [];
    }
    const mapped: ExportColumn[] = cols.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey === true,
    }));
    return buildTableStructure(obj.schema, obj.name, mapped);
  }
  if (obj.kind === "view") {
    let cols: ColumnInfo[] = [];
    try {
      cols = await adapter.listColumns(obj.name, obj.schema);
    } catch {
      cols = [];
    }
    const mapped: ExportColumn[] = cols.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey === true,
    }));
    return buildViewStructure(obj.schema, obj.name, mapped);
  }
  // routine — no per-column block; render a one-liner that names it. The
  // routine contract is opaque DDL (CREATE FUNCTION/PROCEDURE …) which we
  // cannot reproduce from introspection alone — surface the qualified
  // name + kind instead. The user still gets enough context to ask the
  // agent to inspect it further.
  return `-- Routine: ${obj.schema}.${obj.name} (${obj.kind})`;
}

/** Read a single file and return its content as a context block. Returns
 * null on ENOENT / permission error / oversized-or-binary failure.
 * Files > MENTION_RESOLVE_FILE_CAP_BYTES are truncated to the cap with a
 * `[truncated]` notice appended. */
async function resolveFileBlock(
  fs: typeof vscode.workspace.fs.readFile,
  workspaceRoot: string,
  token: string,
): Promise<string | null> {
  // Reject workspace escapes at the resolve boundary: absolute paths and
  // any '..' segment (leading or mid-path) never resolve — the token must
  // stay inside the workspace root (TASK-005 fix round 1, reviewer #2).
  if (token.startsWith("/") || token.split("/").includes("..")) {
    return null;
  }
  const abs = `${workspaceRoot.replace(/\/+$/, "")}/${token}`;
  let bytes: Uint8Array;
  try {
    bytes = await fs(vscode.Uri.file(abs));
  } catch {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
  if (bytes.length > MENTION_RESOLVE_FILE_CAP_BYTES) {
    // Byte-accurate cap (UTF-8): slice raw bytes, then decode. The notice
    // says bytes — so the measurement must be bytes, not UTF-16 units.
    const notice = `\n\n[truncated at ${MENTION_RESOLVE_FILE_CAP_BYTES} bytes]`;
    const capped = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.slice(0, MENTION_RESOLVE_FILE_CAP_BYTES),
    );
    text = capped + notice;
  }
  return `--- File: ${token} ---\n${text}`;
}

/** Optional second constructor arg used by tests to control permission timeout. */
export interface AiChatPanelTuning {
  /** Per-permission timeout (ms). Defaults to 60_000. */
  permissionTimeoutMs?: number;
}

export interface ChatAbortToken {
  aborted: boolean;
}

/**
 * ACP engine dependencies. When provided, the panel spawns `omp acp` via
 * `start()`, streams assistant message chunks as deltas, and surfaces server
 * permission requests as host `permission_request` messages keyed by opaque
 * IDs. When absent (or `start()` rejects), the panel falls back to the
 * built-in agent loop.
 *
 * TASK-012 (B11): `start()` gains an optional 3rd `mcpServers` param — the
 * panel builds an in-process McpBridge (see `ensureAcpSession()`) exposing
 * the same DB tool registry the builtin engine uses, and forwards its ACP
 * `McpServer` descriptor here so the omp engine gets real database access.
 */
export interface AcpPanelDeps {
  start(
    ompPath: string,
    cwd: string,
    mcpServers?: ReadonlyArray<Record<string, unknown>>,
  ): Promise<AcpProcessHandle>;
}

export interface AiChatPanelOptions {
  extensionUri: vscode.Uri;
  /**
   * AI provider/agent deps — loadConfig + complete. Injected so host tests
   * can swap a fake without depending on the full vscode-bound stack.
   */
  deps: AgentDeps;
  /**
   * Async factory for the active DB adapter. May resolve to null (no active
   * connection). Spec: factory null → context is empty, no throw.
   */
  adapterFactory: AdapterFactory;
  /** Optional ACP engine deps. When absent, panel runs builtin only. */
  acp?: AcpPanelDeps;
  /**
   * Detected omp version (B8) — set by the caller from a single upstream
   * `detectOmp()` call (see `resolveEngine` in `src/ai/engineChoice.ts`).
   * Rendered in the "engine" banner when the engine is "omp"; absent for
   * builtin.
   */
  engineVersion?: string;
  /**
   * Review Finding 2: resolved omp binary path (`EngineChoice.path`) from
   * the same upstream `detectOmp()` call. Threaded into `acp.start()`
   * instead of the bare "omp" literal — on Windows `where omp` resolves
   * `omp.cmd`, and `spawn("omp", …)` without `shell:true` cannot execute a
   * `.cmd` shim on Node >= 20.12. Falls back to `"omp"` when absent.
   */
  engineOmpPath?: string;
  /**
   * Install/update hint (B8) — `OMP_INSTALL_HINT` | `OMP_UPDATE_HINT` from
   * the same upstream `resolveEngine` call. Rendered in the "engine" banner
   * when the engine is "builtin" because omp was unavailable/too old.
   */
  engineHint?: string;
  /** Optional tuning for tests (permission timeout, etc). */
  tuning?: AiChatPanelTuning;
  /**
   * Finding 7 (review): fired whenever this panel actually tears down its
   * webview — both the explicit `dispose()` call AND the user closing the
   * tab (`panel.onDidDispose`). Without this, a caller holding a
   * single-instance reference (e.g. extension.ts's module-level
   * `aiChatPanel`) has no way to learn the instance is dead, so
   * `if (aiChatPanel) { aiChatPanel.show(); return; }` on the next "open AI
   * chat" keeps reusing a disposed instance forever instead of
   * re-detecting the engine (stale engine choice survives an omp
   * install/uninstall or config change until a full reload).
   */
  onDispose?: () => void;
  /**
   * Cycle AE TASK-003 — when the engine is "omp", the chat panel
   * delegates `handleSend` to `OmpChatEngine.send(text, events)` instead
   * of the raw ACP session/prompt path. Wire `createOmpChatEngine()` in
   * `extension.ts` when `vsdb.ai.engine === "omp"`. When this is absent
   * (default), the panel keeps the existing raw ACP path used by cycle
   * AB's tests — opt-in by host.
   */
  ompChatEngine?: OmpChatEngine;
}
/**
 * Per-turn input assembly — system prompt + history + user msg.
 *
 * Full-DB context injection (TASK-002): introspect every user schema
 * (tables + views), render DDL via `buildDatabaseStructure`, budget to a
 * 12_000-char ceiling cut at block boundaries, and footer-hint the model to
 * call `export_structure` for the rest. Factory null / introspection
 * failures → empty context, no crash (prompt stays minimal).
 *
 * `opts` is injectable so tests can verify the budget cut without paying
 * the cost of generating 12_000 chars of fixtures; production call sites
 * omit it and the production constants apply.
 */
/**
 * Schema-context cache entry (TASK-007 B9). `adapter` is the object
 * REFERENCE returned by the adapter factory, used as a minimal proxy for
 * "connection identity": `DbAdapter` has no explicit connection-id field,
 * but `ConnectionManager.getAdapter()` returns the SAME instance while the
 * active connection is unchanged and a NEW instance after a connection
 * switch — so reference equality is a valid cache key that self-invalidates
 * on connection change without any extra bookkeeping.
 */
export interface SchemaContextCacheEntry {
  adapter: DbAdapter;
  context: string;
}

// ============================================================================
// Cycle AD TASK-001 — host permission gate for the DB-aware tools
// ============================================================================

/** Verbatim text bubbled back to the model when the user denies (or lets a
 * request lapse). Criterion 12: the rejection reason reaches the model
 * unaltered. */
export const DB_TOOL_DENIED_MESSAGE =
  "Permission denied by user: this tool was not allowed to read the database.";

const DB_TOOL_PERMISSION_OPTIONS: ReadonlyArray<{
  optionId: string;
  label: string;
}> = [
  { optionId: "allow-once", label: "Allow once" },
  { optionId: "allow-session", label: "Allow for this session" },
  { optionId: "deny", label: "Deny" },
];

interface DbToolPending {
  settled: boolean;
  toolName: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
  resolve(optionId: string | undefined): void;
}

/**
 * Wraps a DB-aware `AgentTool` so every invocation first posts a
 * `permission_request` card (same wire shape as the ACP bridge, so the
 * webview needs no new rendering) and blocks until the user answers.
 *
 * Default-deny on EVERY abnormal exit: unknown/duplicate/late response,
 * unlisted optionId, missing optionId, timeout, and `cancelAll()` (stop /
 * dispose / process exit) all resolve to `DB_TOOL_DENIED_MESSAGE` without
 * ever calling the underlying tool.
 *
 * `allow-session` grants the tool for the panel's lifetime; `allow-once`
 * grants exactly this call and the next invocation re-asks.
 */
export class DbToolPermissionGate {
  private readonly pending = new Map<string, DbToolPending>();
  private readonly sessionAllowed = new Set<string>();
  private readonly timeoutMs: number;
  private seq = 0;

  constructor(
    private readonly post: (msg: AiChatPanelHostMessage) => void,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  wrap(tool: AgentTool): AgentTool {
    return {
      ...tool,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const granted = await this.request(tool.name, args);
        if (!granted) return DB_TOOL_DENIED_MESSAGE;
        return tool.execute(args);
      },
    };
  }

  /** Apply a webview answer. Unknown/duplicate/late ids are ignored. */
  respond(requestId: string, optionId: string | undefined): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(requestId);
    entry.resolve(optionId);
    return true;
  }

  /** Default-deny every outstanding request (stop / dispose / exit). */
  cancelAll(): void {
    for (const requestId of Array.from(this.pending.keys())) {
      this.respond(requestId, undefined);
    }
  }

  private request(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.sessionAllowed.has(toolName)) return Promise.resolve(true);
    const requestId = `dbtool-${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    return new Promise<boolean>((resolve) => {
      const entry: DbToolPending = {
        settled: false,
        toolName,
        timeoutHandle: setTimeout(() => {
          this.respond(requestId, undefined);
        }, this.timeoutMs),
        resolve: (optionId) => {
          if (optionId === "allow-session") {
            this.sessionAllowed.add(toolName);
            resolve(true);
            return;
          }
          // Anything that is not the exact `allow-once` option is a deny.
          resolve(optionId === "allow-once");
        },
      };
      this.pending.set(requestId, entry);
      this.post({
        type: "permission_request",
        requestId,
        tool: {
          id: requestId,
          name: toolName,
          detail: summarizeDbToolArgs(args),
        },
        options: DB_TOOL_PERMISSION_OPTIONS.map((o) => ({
          optionId: o.optionId,
          label: o.label,
        })),
      });
    });
  }
}

/**
 * One-line human detail for the permission card. Values are the model's own
 * arguments (never DB row bytes) and are truncated so a giant generated SQL
 * string cannot blow up the card.
 */
function summarizeDbToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${(raw ?? "").slice(0, 200)}`);
  }
  return parts.join(" ");
}

/**
 * Cycle AD TASK-003 — DRY system prompt builder.
 *
 * `formatSystemPrompt` is the single source of truth for the system prompt
 * content. Both `buildMessages` (chat runtime, builtin + ACP engines) and
 * `extensionConfigExport.emitVsdbAiConfig` (OMP config emitter) call it.
 * Same factory + history + opts → identical byte output. Test pins the
 * equality against `buildMessages`'s first element so the privacy invariant
 * (cycle AA: DDL-only, no row bytes) survives the refactor unchanged.
 *
 * `history` is accepted for signature parity with `buildMessages`; it is
 * intentionally unused — the system prompt does not depend on prior
 * messages. Keeping it in the signature means both call sites pass the
 * same tuple shape (`factory, history, opts`) which is the seam cycle AD
 * §8 expects.
 */
export async function formatSystemPrompt(
  factory: AdapterFactory,
  history: readonly ChatMessage[],
  opts?: {
    contextBudgetChars?: number;
    contextTableLimit?: number;
    /** Optional mutable cache cell — populated/read by reference identity
     * of the resolved adapter. Only `AiChatPanel` instance call sites pass
     * this; bare test calls omit it and always re-introspect. */
    cache?: { current: SchemaContextCacheEntry | null };
  },
): Promise<string> {
  // `history` is part of the signature for shape parity; the system prompt
  // never varies with prior messages. Reference it so an unused-parameter
  // linter does not flag the contract.
  void history;
  const budget = opts?.contextBudgetChars ?? SCHEMA_CONTEXT_BUDGET;
  const limit = opts?.contextTableLimit ?? SCHEMA_CONTEXT_TABLE_LIMIT;
  let context = "";
  try {
    const adapter = await factory();
    if (adapter) {
      const cache = opts?.cache;
      if (cache?.current !== undefined && cache?.current !== null && cache.current.adapter === adapter) {
        // Cache hit — same connection identity as the last built context.
        context = cache.current.context;
      } else {
        const schemas = await adapter.listSchemas(false);
        const collected: Array<
          | { kind: "table"; schema: string; name: string }
          | { kind: "view"; schema: string; name: string }
        > = [];

        for (const s of schemas) {
          let schemaTables: TableInfo[] = [];
          try {
            schemaTables = await adapter.listTables(s.name);
          } catch {
            // Per-schema failure: skip schema, keep going.
            continue;
          }
          for (const t of schemaTables) {
            collected.push({ kind: "table", schema: t.schema, name: t.name });
          }
          let schemaViews: ViewInfo[] = [];
          try {
            schemaViews = await adapter.listViews(s.name);
          } catch {
            continue;
          }
          for (const v of schemaViews) {
            collected.push({ kind: "view", schema: v.schema, name: v.name });
          }
        }

        const total = collected.length;
        const kept = collected.slice(0, limit);
        const capDropped = total - kept.length;

        const tables: Array<{ schema: string; name: string }> = [];
        const views: Array<{ schema: string; name: string }> = [];
        const columns: Record<string, ExportColumn[]> = {};

        for (const obj of kept) {
          const key = `${obj.schema}.${obj.name}`;
          // Per-object listColumns failure: retain it with an empty column
          // list so its DDL (table name / schema) still surfaces in context.
          // Dropping the object entirely would hide a real table from the
          // model when introspection is flaky; missing columns is recoverable
          // (the model can call export_structure) but a missing table is not.
          let mapped: ExportColumn[] = [];
          try {
            const cols = await adapter.listColumns(obj.name, obj.schema);
            mapped = cols.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable,
              isPrimaryKey: c.isPrimaryKey,
            }));
          } catch {
            // Keep the object; columns default to [].
          }
          columns[key] = mapped;
          if (obj.kind === "table") {
            tables.push({ schema: obj.schema, name: obj.name });
          } else {
            views.push({ schema: obj.schema, name: obj.name });
          }
        }

        let ddl = buildDatabaseStructure({
          schemas,
          tables,
          views,
          columns,
        });
        // Budget cut at block boundaries (blocks = text between blank lines).
        // Tables AND views share ONE pool in render order; keep leading blocks
        // until the next one would push us over budget. The first block is
        // always kept even when it alone exceeds budget (oversize single-
        // table rule from review #4) — context stays non-empty.
        if (ddl.length > budget) {
          const blocks = ddl.split(/\n\n+/);
          const keptBlocks: string[] = [];
          let acc = 0;
          for (let i = 0; i < blocks.length; i++) {
            const piece = blocks[i] ?? "";
            const sep = keptBlocks.length > 0 ? 2 : 0;
            const next = acc + sep + piece.length;
            if (next > budget) {
              if (i === 0) {
                // First block alone exceeds budget — keep it anyway.
                keptBlocks.push(piece);
                acc = piece.length;
              }
              break;
            }
            keptBlocks.push(piece);
            acc = next;
          }
          const omitted = blocks.length - keptBlocks.length + capDropped;
          ddl = keptBlocks.join("\n\n");
          if (omitted > 0) {
            const footer = `\n\n-- (+${omitted} more objects omitted — call export_structure for full context)`;
            if (ddl.length + footer.length <= budget) ddl += footer;
          }
        }
        context = ddl;
        if (cache) {
          cache.current = { adapter, context };
        }
      }
    }
  } catch {
    // Introspection failure (factory rejection, listSchemas throw, …) →
    // empty context, no crash.
    context = "";
  }
  return context.length === 0
    ? "You are VSDB's AI assistant. Help the user explore and query their database."
    : `You are VSDB's AI assistant. Help the user explore and query their database.\n\nDatabase structure (DDL):\n${context}\n\nYou can call the export_structure tool for the complete structure when truncated.`;
}

/**
 * Per-turn input assembly — system prompt + history + user msg.
 *
 * Delegates the system prompt construction to `formatSystemPrompt` (cycle AD
 * TASK-003 §8). Byte output is identical to the pre-refactor
 * implementation — verified by `extensionConfigExport.test.ts` byte
 * equality pin.
 */
export async function buildMessages(
  factory: AdapterFactory,
  history: ChatMessage[],
  userMsg: ChatMessage,
  opts?: {
    contextBudgetChars?: number;
    contextTableLimit?: number;
    /** Optional mutable cache cell — populated/read by reference identity
     * of the resolved adapter. Only `AiChatPanel` instance call sites pass
     * this; bare test calls omit it and always re-introspect. */
    cache?: { current: SchemaContextCacheEntry | null };
  },
): Promise<ChatMessage[]> {
  const systemPrompt = await formatSystemPrompt(factory, history, opts);
  return [{ role: "system", content: systemPrompt }, ...history, userMsg];
}

/** Engine state, computed lazily on first show. */
type EngineKind = "omp" | "builtin";

interface PendingPermission {
  serverId: unknown;
  requestId: string;
  optionIds: Set<string>;
  settled: boolean;
  timeoutHandle: NodeJS.Timeout;
}

export const RESUME_PICKER_CAP = 20;

interface AcpSession {
  handle: AcpProcessHandle;
  /** Active session id used by `session/prompt`. Starts as the handle's
   * sessionId; updated to the loaded id after `resume_pick`. */
  sessionId: string;
  /** Accumulated assistant text for the current turn. */
  buffer: string;
  /** Active permission requests keyed by host requestId. */
  pending: Map<string, PendingPermission>;
  /**
   * TASK-012 (B11): the ACP `McpServer` descriptor array this session was
   * started with — reused verbatim on `session/load` (resume) so the loaded
   * session keeps the same DB tool access it had at `session/new` time.
   */
  mcpServers: ReadonlyArray<Record<string, unknown>>;
  /** Monotonic counter for host-generated opaque requestIds. */
  bumpRequestSeq(): number;
  /** Disposal teardown — cancels timers, drops references, closes the
   * McpBridge listener (TASK-012). */
  dispose(): void;
}

export class AiChatPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  /** In-turn abort flag — flipped by `stop`; checked onStep + on settle. */
  private token: ChatAbortToken | null = null;
  /** History snapshot for replay; never holds apiKey (provider scrubbed). */
  private history: ChatMessage[] = [];
  /** TASK-001 Regenerate: most-recent trimmed user text captured at
   * handleSend entry. Used only when the trailing history is NOT an intact
   * `[user, assistant]` pair — i.e. the last UI exchange was stopped
   * mid-turn and the pair was therefore never appended (PLAN §3). */
  private lastSentText: string | null = null;
  /** Cached engine resolution — set on first show; reused on every turn. */
  private engine: EngineKind | null = null;
  /** Cached ACP session — created on first acp-mode send. */
  private acpSession: AcpSession | null = null;
  /** Set once per ACP turn when done was posted. */
  private turnDonePosted = false;
  /**
   * Finding 1b (review, both opus reviewers): true once the current ACP turn
   * has settled (done posted) or when there is no turn in flight at all.
   * `handleAcpNotification` drops `session/update` frames while this is
   * true — without it, a late `agent_message_chunk` arriving after `done`
   * (e.g. omp kept generating past its own session/prompt response) still
   * posts a `delta`, opening a second, orphan streaming bubble in the
   * webview. `token?.aborted` alone does not catch this: `token` is already
   * null once the turn has settled. Flipped false at the start of every
   * send, true whenever `done` is posted.
   */
  private turnSettled = true;
  /** Resolvers for in-flight ACP turns — fired by settle path. */
  private acpTurnResolvers: Array<() => void> = [];
  /** Per-turn AbortController for the built-in engine. Created in
   * handleSend and aborted in handleStop so the streaming path sees the
   * signal flip exactly when the user clicks Stop. ACP path ignores this. */
  private currentAbort: AbortController | null = null;
  private permissionTimeoutMs: number;
  /** Cycle AD: permission gate for the DB-aware (row-reading) tools.
   * Assigned in the constructor because it reads `permissionTimeoutMs`,
   * which class-field initialisation order would leave undefined here. */
  private readonly dbToolGate: DbToolPermissionGate;
  /** Drop-guard (F1 belt): true between `resume_pick` settle and the next
   * `session/prompt` write. While set, `session/update` notifications for
   * the loaded sessionId are absorbed silently (AcpReplayBuffer is the
   * primary defense; this guard is defense-in-depth). */
  private dropReplayFrames = false;
  /** Set while a `resume_list` round-trip is in flight, so the webview
   * can post a fresh `resume_list` only after the previous list resolves. */
  private resumeListInFlight = false;
  /** Schema-context cache cell (TASK-007 B9) — shared by builtin and ACP
   * turns, keyed by adapter object-reference identity. See
   * `SchemaContextCacheEntry` for why reference equality is a valid,
   * self-invalidating "connection identity" proxy. */
  private schemaCacheRef: { current: SchemaContextCacheEntry | null } = {
    current: null,
  };
  /**
   * Finding 7 belt: `dispose()` calling `this.panel?.dispose()` synchronously
   * re-enters the `onDidDispose` handler below (confirmed by the real
   * webview panel AND every test fake, which both fire `onDidDispose`
   * listeners from inside their `dispose()`). Without this guard, teardown
   * (cancelAllPending/disposeAcpSession/onDispose) would run twice for a
   * single explicit `dispose()` call.
   */
  private torndown = false;

  constructor(
    private readonly options: AiChatPanelOptions,
    tuning: AiChatPanelTuning = {},
  ) {
    this.permissionTimeoutMs =
      tuning.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.dbToolGate = new DbToolPermissionGate((m) => this.post(m), {
      timeoutMs: this.permissionTimeoutMs,
    });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.torndown = false;
    this.panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "VSDB AI Chat",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.options.extensionUri, "dist"),
        ],
      },
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        (msg: AiChatPanelWebviewMessage) => this.handleMessage(msg),
      ),
    );
    this.disposables.push(
      this.panel.onDidDispose(() => {
        // TASK-007 B7: closing the webview tab is a SEPARATE code path from
        // the explicit AiChatPanel.dispose() method below — it must tear
        // down the ACP session and cancel pending permissions the same way,
        // or the omp child process (and its permission timers) leaks.
        this.teardown();
      }),
    );
  }

  dispose(): void {
    // `panel.dispose()` (real vscode AND every test fake) synchronously
    // re-enters the `onDidDispose` handler registered in `show()`, which
    // calls `teardown()` itself — so this explicit call and that re-entrant
    // one must collapse into exactly one teardown. See `teardown()`'s guard.
    this.panel?.dispose();
    this.teardown();
  }

  /** Single teardown path shared by the explicit `dispose()` call and the
   * webview tab being closed by the user (`panel.onDidDispose`) — guarded
   * so cancelAllPending/disposeAcpSession/onDispose each run exactly once
   * per panel lifetime regardless of which path triggers it first. */
  private teardown(): void {
    if (this.torndown) return;
    this.torndown = true;
    // Cancel every pending permission request with one cancelled ACP
    // result per server request before tearing the session down.
    this.cancelAllPending();
    this.dbToolGate.cancelAll();
    this.disposeAcpSession();
    this.panel = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.options.onDispose?.();
  }

  private async handleMessage(msg: AiChatPanelWebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.handleReady();
        return;
      case "send":
        await this.handleSend(msg.text, msg.attachments);
        return;
      case "stop":
        this.handleStop();
        return;
      case "clear":
        this.handleClear();
        return;
      case "permission_response":
        // Cycle AD: one wire kind, two consumers. DB-aware tool cards carry
        // host-generated `dbtool-` ids owned by `dbToolGate`; every other id
        // belongs to the ACP permission bridge. `respond` returns false for
        // ids it does not own, so ACP ids still reach the ACP path.
        if (this.dbToolGate.respond(msg.requestId, msg.optionId)) return;
        this.handlePermissionResponse(msg.requestId, msg.optionId);
        return;
      case "resume_list":
        await this.handleResumeList();
        return;
      case "resume_pick":
        await this.handleResumePick(msg.sessionId);
        return;
      case "resume_cancel":
        this.handleResumeCancel();
        return;
      case "regenerate":
        await this.handleRegenerate();
        return;
      case "mention_list":
        await this.handleMentionList(msg.query);
        return;
    }
  }

  private async handleReady(): Promise<void> {
    if (this.engine === null) {
      // The engine itself was already decided upstream (caller resolved it
      // via `resolveEngine()`/`detectOmp()` before constructing this panel —
      // see `options.acp` being present iff the engine is "omp"). This is
      // just the wire announcement; it must not re-run detection (B8: at
      // most once per show).
      this.engine = this.options.acp === undefined ? "builtin" : "omp";
      this.postEngine(this.engine);
    }
    // TASK-001 (cycle AB): the omp engine cannot accept images regardless
    // of the active role's `vision` flag — engine is the belt. Skip the
    // (expensive, potentially throwing) settings read in omp mode. For
    // builtin we consult `loadSettings()` via the AI config store. Any
    // failure (null config, store absent, transient error) collapses to
    // the legacy default (`defaultAiSettings()` → work.vision: true) so
    // the webview UX does not regress on first-launch-with-no-settings.
    let visionCapable: boolean;
    if (this.engine === "omp") {
      visionCapable = false;
    } else {
      try {
        const cfg = await this.options.deps.loadConfig();
        visionCapable = cfg?.models.work.vision
          ?? defaultAiSettings().models.work.vision;
      } catch {
        visionCapable = defaultAiSettings().models.work.vision;
      }
    }
    this.post({
      type: "init",
      hasHistory: this.history.length > 0,
      visionCapable,
    });
  }

  private async handleSend(
    text: string,
    attachments?: MinimalAttachment[],
  ): Promise<void> {
    const trimmed = text.trim();
    // TASK-001 Regenerate: remember the trimmed user text so a Regenerate
    // pressed after Stop can re-send it verbatim. Overwritten only by a
    // non-empty send so a failed/empty call never erases the last real one.
    if (trimmed.length > 0) this.lastSentText = trimmed;
    if (trimmed.length === 0) return;

    // Fresh token for this turn. Also: a replacement send cancels any
    // outstanding permission requests from the previous turn before we
    // start the new one. Default-deny is mandatory.
    this.cancelAllPending();
    this.token = { aborted: false };
    this.turnDonePosted = false;
    this.turnSettled = false;
    // Per-turn AbortController for the builtin engine — `signal` flows
    // straight through runAgent → deps.streamComplete so a mid-stream Stop
    this.currentAbort = new AbortController();
    // turn starts. Pure pipeline — see aiChatAttachments.ts. Per-rejection
    // we post one `attach_error` bubble so the webview can name the
    // offending file in its amber notice; we never echo the base64 bytes
    // back, never log them, and never silently drop them.
    const validAttachments = this.prepareAttachments(attachments);
    if (validAttachments === "empty") {
      // Either the user sent zero attachments, or every attachment was
      // rejected by per-item validation. Either way: legacy text-only
      // turn. We still log the rejection summary so an operator can
      // observe the silent-drop surface without logging bytes.
      if (Array.isArray(attachments) && attachments.length > 0) {
        console.warn(
          "[aiChatPanel] all attachments rejected before turn",
          summarizeAttachmentsForLog(attachments),
        );
      }
    } else {
      console.log(
        "[aiChatPanel] attachments accepted for turn",
        summarizeAttachmentsForLog(validAttachments),
      );
    }

    const textPart: ChatContentPart = { type: "text", text: trimmed };
    const imageParts: ChatContentPart[] = Array.isArray(validAttachments)
      ? validAttachments.map((a) => ({
          type: "image_url" as const,
          imageUrl: `data:${a.mime};base64,${a.base64}`,
        }))
      : [];
    const userMsg: ChatMessage = {
      role: "user",
      content: imageParts.length > 0 ? [textPart, ...imageParts] : trimmed,
    };

    // TASK-005: resolve @-mentions BEFORE the turn runs. Object tokens →
    // DDL block (per-turn only — base buildMessages is untouched). File
    // tokens → file content (capped at MENTION_RESOLVE_FILE_CAP_BYTES).
    // Misses → one mention_miss bubble per missing token so the user
    // sees a silent drop instead of a silent ignore. Mention block is
    // concatenated into the TEXT part so image parts stay siblings and
    // never get re-encoded into the schema context.
    const tokens = parseMentionTokens(trimmed);
    if (tokens.length > 0) {
      try {
        const resolved = await resolveMentionsForTurn(
          this.options.adapterFactory,
          tokens,
        );
        if (resolved.contextBlock.length > 0) {
          const mergedText = `${trimmed}\n\n${resolved.contextBlock}`;
          userMsg.content = imageParts.length > 0
            ? [{ type: "text" as const, text: mergedText }, ...imageParts]
            : mergedText;
        }
        for (const miss of resolved.misses) {
          this.post({ type: "mention_miss", token: miss });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({
          type: "error",
          message: `Mention resolution failed: ${message}`,
        });
      }
    }
    if (this.engine === "builtin") {
      await this.runBuiltinTurn(userMsg);
      return;
    }

    // ACP engine: pass the augmented userMsg content as the prompt text so
    // the schema context + the @-mention Referenced-context block both
    // reach the model in one session/prompt write. Image parts are NEVER
    // forwarded here (the omp/ACP gate ran in `prepareAttachments` and the
    // surviving userMsg.content for an omp turn is text-only by invariant).
    const acpPrompt =
      typeof userMsg.content === "string" ? userMsg.content : trimmed;
    // Cycle AE TASK-003: when the host wired an OmpChatEngine, route the
    // turn through `engine.send(text, events)` — that module owns the
    // HostMcp bridge + ACP session lifecycle. Falling back to the raw
    // runAcpTurn path is preserved for cycle AB's tests which inject only
    // `acp.start` (no OmpChatEngine).
    if (this.options.ompChatEngine !== undefined) {
      await this.runOmpEngineTurn(acpPrompt, userMsg);
      return;
    }
    await this.runAcpTurn(acpPrompt, userMsg);
  }

  /**
   * TASK-001 (cycle AB) attachment pipeline. Returns:
   *   - `[]`                : no attachments sent (legacy text-only)
   *   - `"empty"` sentinel  : every attachment was rejected; caller proceeds
   *                           text-only, legacy shape intact
   *   - `MinimalAttachment[]` : surviving attachments ready to forward
   *
   * On entry: posts zero or more `{type:"attach_error", id, reason, message}`
   * bubbles — one per rejection. Pure with respect to the user message; the
   * side effect is the post call. Never logs base64.
   */
  private prepareAttachments(
    attachments: MinimalAttachment[] | undefined,
  ): MinimalAttachment[] | "empty" {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    // Vision gate (engine belt + model flag). Order: when engine is "omp"
    // we treat the whole batch as unsupported regardless of model flag.
    const visionOk = validateAttachmentsForVision(
      attachments,
      this.engine === "builtin",
    );
    if (!visionOk.ok) {
      for (const a of attachments) {
        this.post({
          type: "attach_error",
          id: a.id,
          reason: "vision_unsupported",
          message: `Attachment "${a.id}" rejected: image attachments are not supported in this engine.`,
        });
      }
      return "empty";
    }
    // Count cap — first N kept; the suffix is dropped with one error per
    // dropped item so the webview can name every offending file.
    const accepted: MinimalAttachment[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments[i]!;
      if (i >= MAX_ATTACHMENTS_PER_TURN) {
        this.post({
          type: "attach_error",
          id: a.id,
          reason: "count_cap",
          message: `Attachment "${a.id}" rejected: more than ${MAX_ATTACHMENTS_PER_TURN} attachments in one turn.`,
        });
        continue;
      }
      const r = validateImageAttachment(a, accepted);
      if (r.ok) {
        accepted.push(a);
      } else {
        this.post({
          type: "attach_error",
          id: r.attachmentId ?? a.id,
          reason: r.reason,
          message: `Attachment "${a.id}" rejected: ${r.reason}.`,
        });
      }
    }
    return accepted.length > 0 ? accepted : "empty";
  }
  /**
   * Built-in engine turn.
   * Wires the per-turn AbortController signal into runAgent (which routes
   * to deps.streamComplete). Posts {type:"delta"}
   * for each onText fragment;
   * the existing finalize-on-not-aborted branch
   * suppresses the final assistant message when the user clicked Stop.
   * onStreamFallback mirrors agent's fallback notice to the webview with
   * the literal "stream fallback" label so the UI surfaces why streaming
   * wasn't used (provider offline / model doesn't support SSE).
   */
  private async runBuiltinTurn(userMsg: ChatMessage): Promise<void> {
    const registry = createDbTools(this.options.adapterFactory);
    registry.register(createSqlTool(this.options.adapterFactory));
    registry.register(createExportStructureTool(this.options.adapterFactory));
    // Cycle AD: the five DB-aware tools reach real row data, so each one is
    // wrapped in the permission gate — the model may call them, but nothing
    // executes until the user answers the card (default-deny).
    for (const tool of createDbAwareTools(this.options.adapterFactory)) {
      registry.register(this.dbToolGate.wrap(tool));
    }

    const messages = await buildMessages(
      this.options.adapterFactory,
      this.history,
      userMsg,
      { cache: this.schemaCacheRef },
    );
    const token = this.token;
    const signal = this.currentAbort?.signal;
    const callbacks: AgentCallbacks = {
      onStep: (step) => this.onStep(step),
      onText: (text) => {
        // Gate at the boundary: a token flip in mid-stream means the user
        // hit Stop — drop pending deltas so the bubble doesn't keep
        // growing after we already committed to aborting.
        if (token?.aborted) return;
        this.post({ type: "delta", text });
      },
      onStreamFallback: () => {
        // Panel owns the literal fallback label (no shared const with
        // agent.ts — see TASK-003 §Interfaces). Rendered through the
        // existing webview `step` case.
        this.post({ type: "step", label: "stream fallback" });
      },
      onToolCall: (call) => {
        // TASK-002: live per-tool step line. Fires BEFORE the tool
        // executes so the UI shows progress on multi-tool turns. The
        // abort-token gate is at the boundary — aborting suppresses
        // further posts. Per spec, agent loop fires regardless of
        // abort state; gating belongs to the consumer.
        if (token?.aborted) return;
        this.post({ type: "step", label: call.name || "tool" });
      },
    };

    try {
      const result = await runAgent(
        { messages, tools: registry },
        this.options.deps,
        callbacks,
        signal,
      );
      if (!token?.aborted) {
        this.post({
          type: "assistant",
          text: result.finalText,
          markdown: true,
        });
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: result.finalText,
        };
        this.history = [...this.history, userMsg, assistantMsg];
      }
    } catch (err) {
      const aborted =
        this.token?.aborted ||
        (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        // User-driven stop (token flipped) or upstream provider AbortError:
        // the stop UX already surfaces a quiet "stopped" state via the
        // webview's done/de-stream path. Never post an error bubble here.
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // TASK-003 D3: when AI is not configured mid-session, the literal
      // provider error "AI is not configured" is not actionable on its
      // own — the user has to know where to set baseUrl/model/API key.
      // Enrich with the menu path. Other errors surface as-is (provider
      // / stream errors carry "stream" naturally; the webview error
      // case is a thin wrapper around the string).
      const enriched =
        message === "AI is not configured"
          ? "AI is not configured — open VSDB: Open AI Settings to configure baseUrl/model/API key"
          : message;
      this.post({ type: "error", message: enriched });
    } finally {
      this.post({ type: "done" });
      this.currentAbort = null;
      // TASK-007 B6: reset on every turn exit path (success, error, abort)
      // so the resume guards (`token !== null`) don't permanently swallow
      // resume_list/resume_pick after the first message.
      this.token = null;
      // Finding 1b: keep turnSettled accurate even for the builtin engine
      // so a later engine failover (B8) never leaves it stuck false.
      this.turnSettled = true;
    }
  }

  private onStep(_step: AgentStep): void {
    // TASK-002: live step lines are posted via onToolCall (fires per
    // call, before execution). onStep still fires for end-of-step
    // notification but no longer drives a webview post here — every
    // call would have already posted via onToolCall.
  }

  /**
   * Cycle AE TASK-003 — OmpChatEngine routing.
   *
   * When `vsdb.ai.engine === "omp"` and the host wired an `OmpChatEngine`,
   * handleSend delegates here. The engine owns session/prompt, the
   * HostMcp bridge, and the ACP notification forwarder. The panel's only
   * job is to wire the event callbacks back to the webview's
   * `{type:"delta"|"step"|"error"|"done"}` messages and to enforce the
   * mid-turn fallback contract: if the engine's `send()` rejects (process
   * crash / connection lost), the panel posts ONE error bubble, flips the
   * engine to "builtin" in `vsdb.ai.engine` so subsequent turns run on
   * the builtin engine, and resolves. The next `handleSend` will read the
   * flipped value from config and dispatch to the builtin path on its
   * own — no caller-side bookkeeping required.
   */
  private async runOmpEngineTurn(
    text: string,
    userMsg: ChatMessage,
  ): Promise<void> {
    const engine = this.options.ompChatEngine;
    if (engine === undefined) {
      // Defensive: handleSend already gated on options.ompChatEngine.
      this.engine = "builtin";
      this.postEngine("builtin");
      this.post({ type: "error", message: "OmpChatEngine not configured; falling back" });
      this.post({ type: "done" });
      this.turnSettled = true;
      this.token = null;
      return;
    }
    const token = this.token;
    let postedError = false;
    try {
      await engine.send(text, {
        onDelta: (delta) => {
          if (token?.aborted) return;
          this.post({ type: "delta", text: delta });
        },
        onThought: (chunk) => {
          if (token?.aborted) return;
          this.post({ type: "step", label: chunk });
        },
        onToolStart: (toolName) => {
          if (token?.aborted) return;
          this.post({ type: "step", label: toolName });
        },
        onToolEnd: (toolName, result, isError) => {
          if (token?.aborted) return;
          this.post({
            type: "step",
            label: isError ? `${toolName}: error` : toolName,
          });
          void result;
        },
        onError: (message) => {
          // Mid-turn crash. Post ONE error bubble, flip engine back to
          // builtin in settings, re-post engine so the banner self-
          // corrects on failover. Subsequent handleSend calls will route
          // through the builtin engine.
          if (postedError) return;
          postedError = true;
          this.post({ type: "error", message });
          this.engine = "builtin";
          this.postEngine("builtin");
          this.flipEngineToBuiltinInSettings().catch(() => {
            /* best-effort */
          });
        },
        onDone: () => {
          // Engine contract: never throws on crash; onError handles the
          // error path. Reaching onDone = clean turn end.
        },
      });
    } catch (err) {
      // OmpChatEngine.send is contractually non-throwing, but defend
      // anyway so a stray rejection surfaces as one error bubble + flip.
      if (!postedError) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({ type: "error", message });
        this.engine = "builtin";
        this.postEngine("builtin");
        this.flipEngineToBuiltinInSettings().catch(() => {
          /* best-effort */
        });
      }
    } finally {
      this.post({ type: "done" });
      this.token = null;
      this.turnSettled = true;
      void userMsg;
    }
  }

  /**
   * Cycle AE TASK-003 §5 — flip the user's `vsdb.ai.engine` setting back
   * to "builtin" so the next handleSend reads the flipped value and routes
   * to the builtin engine. Best-effort: silently swallows any config-store
   * rejection so a failed workspace write never bubbles a second error
   * bubble to the user (the engine flip in `this.engine` already surfaces
   * the same intent in the current panel).
   */
  private async flipEngineToBuiltinInSettings(): Promise<void> {
    try {
      await vscode.workspace
        .getConfiguration("vsdb")
        .update("ai.engine", "builtin", vscode.ConfigurationTarget.Global);
    } catch {
      /* best-effort */
    }
  }
  /**
   * ACP engine turn (TASK-007 rewrite — B1/B5/B6/B9).
   *
   * Completion: real ACP has no terminal `session/update` notification kind
   * (no `agent_end`/`turn_complete`) — the turn settles on the
   * `session/prompt` JSON-RPC RESPONSE itself, carrying
   * `{stopReason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | ...}`
   * (B1). `acpTurnResolvers` is repurposed as a "belt": `handleStop()` pushes
   * a resolver there to force early settlement of a turn whose response may
   * never arrive, without hanging indefinitely (Finding 8: `disposeAcpSession()`
   * does NOT push/resolve this belt — a dispose mid-turn instead settles via
   * the rejected `session/prompt` request itself, see `promptError` below).
   * `turnDonePosted` remains the single guard against double-posting
   * `assistant`/`done`, whichever path settles first.
   */
  private async runAcpTurn(
    text: string,
    userMsg: ChatMessage,
  ): Promise<void> {
    const acp = this.options.acp;
    if (acp === undefined) {
      // Shouldn't happen — engine is "acp" only when deps present — but degrade.
      this.engine = "builtin";
      this.post({ type: "error", message: "ACP engine unavailable; falling back" });
      this.post({ type: "done" });
      this.turnSettled = true;
      this.token = null;
      return;
    }

    let session: AcpSession;
    try {
      session = await this.ensureAcpSession();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `ACP session failed: ${message}` });
      this.post({ type: "done" });
      this.turnSettled = true;
      this.engine = "builtin";
      // B8: the banner must self-correct on failover — without this repost
      // the webview keeps showing "omp" forever even though every
      // subsequent turn now runs builtin.
      this.postEngine("builtin");
      this.token = null;
      return;
    }
    const token = this.token;

    // Reset per-turn buffer so this turn's assistant text doesn't accumulate
    // over previous turn's text (which would leak thinking across turns).
    session.buffer = "";

    try {
      // The drop-guard (F1 belt) is cleared RIGHT BEFORE the outgoing
      // session/prompt write — see AcpClient.request closing the replay
      // window. Any session/update frame for the loaded sessionId that
      // leaked into the handler between load-settle and this write was
      // silently dropped. From here on, agent_message_chunk streams as
      // deltas normally.
      this.dropReplayFrames = false;

      // B9: the ACP prompt previously carried only the raw user text,
      // discarding schema context entirely. Build (or reuse the cached)
      // schema context the same way the builtin engine does and prepend it.
      const contextMessages = await buildMessages(
        this.options.adapterFactory,
        [],
        userMsg,
        { cache: this.schemaCacheRef },
      );
      const systemMsg = contextMessages.find((m) => m.role === "system");
      const promptText =
        systemMsg && systemMsg.content.length > 0
          ? `${systemMsg.content}\n\n${text}`
          : text;

      // Finding 1a (review, both opus reviewers): session/prompt has no
      // bounded duration — it legitimately runs minutes, more so with DB
      // tools/permission round-trips (TASK-012) in the mix. Passing
      // `timeoutMs: 0` disables AcpClient's default 30s per-request bound
      // for THIS call only; initialize/session/new/session/load keep it.
      const requestPromise = session.handle.acp.request<
        { stopReason?: unknown } | undefined
      >(
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: promptText }],
        },
        { timeoutMs: 0 },
      );

      // Primary settlement path: the session/prompt RESPONSE. This wrapper
      // is engineered to NEVER reject (both branches resolve normally) so
      // it can safely race the forced-settlement belt below without an
      // unhandled-rejection warning. A genuine rejection (JSON-RPC error,
      // transport closed mid-turn, etc.) is captured in `promptError` and
      // re-thrown AFTER the race below — so it still reaches the `catch`
      // block (stderr-tail enrichment, error post) instead of being
      // silently discarded, unless the turn was forced to settle by
      // Stop/dispose or the user aborted, in which case a rejection here
      // is expected noise (AcpClient.dispose rejects all pending requests).
      let stopReason: string | undefined;
      let promptError: unknown;
      const responseSettled: Promise<void> = requestPromise.then(
        (result) => {
          const r = result?.stopReason;
          if (typeof r === "string") stopReason = r;
        },
        (err) => {
          promptError = err;
        },
      );

      // Belt: `handleStop()` pushes a resolver here (Finding 8: NOT
      // `disposeAcpSession()` — a bare dispose settles this turn via the
      // rejected session/prompt request instead, captured as `promptError`
      // above) to force early settlement of a turn that may never receive
      // a response (hung/killed process).
      let forced = false;
      let myResolve: () => void = () => {};
      const forcedSettled: Promise<void> = new Promise((resolve) => {
        myResolve = () => {
          forced = true;
          resolve();
        };
        this.acpTurnResolvers.push(myResolve);
      });

      await Promise.race([responseSettled, forcedSettled]);
      const idx = this.acpTurnResolvers.indexOf(myResolve);
      if (idx !== -1) this.acpTurnResolvers.splice(idx, 1);

      const userAborted = token?.aborted === true;

      if (promptError !== undefined && !forced && !userAborted) {
        throw promptError;
      }

      // Every stopReason is handled explicitly — no silent fallthrough.
      let postAssistant: boolean;
      if (forced || userAborted) {
        // Stop/dispose forced early settlement — never surface a (possibly
        // partial) assistant bubble for a turn the user cancelled.
        postAssistant = false;
      } else {
        switch (stopReason) {
          case "end_turn":
          case "max_tokens":
            // Real model content — surface it even when max_tokens
            // truncated it.
            postAssistant = true;
            break;
          case "cancelled":
          case "refusal":
            // Server-side cancel or refusal carries no usable final text.
            postAssistant = false;
            break;
          default:
            // Unrecognized/missing stopReason — conservatively surface
            // whatever text streamed rather than losing it silently.
            postAssistant = true;
            break;
        }
      }

      if (!this.turnDonePosted) {
        if (postAssistant && session.buffer.length > 0) {
          const finalText = session.buffer;
          this.post({ type: "assistant", text: finalText, markdown: true });
          this.history = [
            ...this.history,
            userMsg,
            { role: "assistant", content: finalText },
          ];
        }
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Finding 4 (review): the stderr tail was previously only surfaced on
      // a HANDSHAKE failure — after a successful handshake it kept filling
      // but nothing ever read it again, so an omp auth/model error DURING
      // session/prompt produced an empty assistant bubble with the real
      // explanation silently discarded. Append the live tail when present.
      const tail = session.handle.getStderrTail?.() ?? "";
      const enriched =
        tail.length > 0 ? `${message}\n--- omp stderr (tail) ---\n${tail}` : message;
      this.post({ type: "error", message: enriched });
      if (!this.turnDonePosted) {
        this.post({ type: "done" });
        this.turnDonePosted = true;
      }
    } finally {
      // TASK-007 B6: reset on every turn exit path (success, error, abort)
      // so the resume guards (`token !== null`) don't permanently swallow
      // resume_list/resume_pick after the first message.
      this.token = null;
      // Finding 1b: the turn is settled on every exit path from here —
      // a session/update notification arriving after this point is late
      // and must be dropped by handleAcpNotification's turnSettled gate.
      this.turnSettled = true;
    }
  }

  private async ensureAcpSession(): Promise<AcpSession> {
    if (this.acpSession !== null) return this.acpSession;
    const acp = this.options.acp;
    if (acp === undefined) {
      throw new Error("acp deps not configured");
    }
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // TASK-012 (B11): mirror runBuiltinTurn's tool registry (list_tables,
    // describe_table, run_sql, export_structure) and expose it to the omp
    // engine over an in-process MCP bridge — same adapterFactory, same
    // read-only guard on run_sql, no second execution path to the database.
    const registry = createDbTools(this.options.adapterFactory);
    registry.register(createSqlTool(this.options.adapterFactory));
    registry.register(createExportStructureTool(this.options.adapterFactory));
    // Cycle AD: the five DB-aware tools reach real row data, so each one is
    // wrapped in the permission gate — the model may call them, but nothing
    // executes until the user answers the card (default-deny).
    for (const tool of createDbAwareTools(this.options.adapterFactory)) {
      registry.register(this.dbToolGate.wrap(tool));
    }
    const bridge: McpBridge = await createMcpBridge(registry);
    const mcpServers: ReadonlyArray<Record<string, unknown>> = [bridge.descriptor];

    let handle: AcpProcessHandle;
    try {
      handle = await acp.start(this.options.engineOmpPath ?? "omp", cwd, mcpServers);
    } catch (err) {
      // start() failed (e.g. omp missing/spawn error) — the bridge's
      // dispose() closure never gets wired below, so close it here to avoid
      // an orphan loopback listener.
      try {
        bridge.dispose();
      } catch {
        /* best-effort */
      }
      throw err;
    }
    const pending = new Map<string, PendingPermission>();
    let nextRequestSeq = 0;
    const session: AcpSession = {
      handle,
      sessionId: handle.sessionId,
      buffer: "",
      pending,
      mcpServers,
      bumpRequestSeq: () => ++nextRequestSeq,
      dispose: () => {
        // Cancel timers + drop references; do NOT cancel the server requests
        // here — that's cancelAllPending()'s job. This is the "tear down
        // local bookkeeping" hook.
        for (const p of pending.values()) {
          clearTimeout(p.timeoutHandle);
        }
        pending.clear();
        // Close the McpBridge listener so no orphan loopback server survives
        // the session (TASK-012 lifecycle contract).
        try {
          bridge.dispose();
        } catch {
          /* best-effort */
        }
      },
    };
    // Wire notification handler — session/update streams assistant text.
    handle.acp.onNotification((n: AcpNotification) =>
      this.handleAcpNotification(session, n),
    );
    // Wire server request handler — every session/request_permission is
    // mirrored to the webview as a host permission_request with an opaque
    // ID; responses are correlated by that opaque ID.
    handle.acp.onServerRequest((call: AcpServerRequest) =>
      this.handleAcpServerRequest(session, call),
    );
    // Process-exit signal: AcpClient exposes an `onClose(cb)` hook that fires
    // when the underlying transport closes / the client is disposed. On that
    // signal we cancel every pending request with a cancelled result.
    const acpClient = handle.acp as unknown as {
      onClose?: (cb: () => void) => void;
    };
    if (typeof acpClient.onClose === "function") {
      acpClient.onClose.call(handle.acp, () => {
        if (this.acpSession !== session) return;
        this.cancelAllPending();
      });
    }
    this.acpSession = session;
    return session;
  }

  private handleAcpNotification(
    session: AcpSession,
    n: AcpNotification,
  ): void {
    if (n.method !== "session/update") return;
    // Finding 1b: a session/update notification arriving after the current
    // turn has already settled (done posted) is late — drop it instead of
    // rendering a delta into a fresh, orphan streaming bubble. `token` is
    // already null by this point, so `token?.aborted` alone never catches
    // this case.
    if (this.turnSettled) return;
    const params = n.params;
    if (params === null || typeof params !== "object") return;
    // Drop-guard (F1 belt): between resume_pick settle and the next
    // session/prompt write, ignore session/update for the loaded sessionId.
    // AcpReplayBuffer is the primary defense (server-originated frames
    // for the loaded id are absorbed there); this is belt + suspenders.
    if (
      this.dropReplayFrames &&
      (params as { sessionId?: unknown }).sessionId === session.sessionId
    ) {
      return;
    }
    const update = (params as { update?: unknown }).update;
    if (update === null || typeof update !== "object") return;
    const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
    if (sessionUpdate === "agent_message_chunk") {
      if (this.token?.aborted) return;
      // TASK-007 B2: ACP `agent_message_chunk` carries
      // `content: {type:"text", text}` — the SAME envelope
      // `user_message_chunk` already uses. There is no `delta` field.
      const content = (update as { content?: unknown }).content;
      let text: string | undefined;
      if (content !== null && typeof content === "object") {
        const t = (content as { text?: unknown }).text;
        if (typeof t === "string") text = t;
      }
      if (typeof text === "string" && text.length > 0) {
        session.buffer += text;
        this.post({ type: "delta", text });
      }
      return;
    }
    if (sessionUpdate === "tool_call") {
      // Finding 6 (review): the builtin engine posts a live `step` line per
      // tool call (see runBuiltinTurn's onToolCall callback) but the omp
      // path silently dropped this update kind — a multi-tool omp turn
      // showed no progress at all until the final assistant bubble. Mirror
      // deriveHistoryFromReplay's label derivation for the replayed-history
      // rendering of the SAME update kind to stay consistent.
      if (this.token?.aborted) return;
      const title = (update as { title?: unknown }).title;
      const name = (update as { name?: unknown }).name;
      const toolCallId = (update as { toolCallId?: unknown }).toolCallId;
      const label =
        (typeof title === "string" && title.length > 0 && title) ||
        (typeof name === "string" && name.length > 0 && name) ||
        (typeof toolCallId === "string" && toolCallId.length > 0 && toolCallId) ||
        "tool";
      this.post({ type: "step", label });
      return;
    }
    if (sessionUpdate === "agent_thought_chunk") {
      // TASK-001 supersedes TASK-004 §3: forward live `agent_thought_chunk`
      // to the webview as `{type:"thought", text:chunk}`. The webview owns
      // collapse/label state (TASK-002). Thought text NEVER touches
      // `session.buffer` and NEVER enters `this.history` — replay filtering
      // and the prompt payload are unchanged. Same late-frame / abort
      // gates as `agent_message_chunk` so a stray post-done thought
      // cannot open an orphan thinking block (turnSettled = the only true
      // gate; `token?.aborted` mirrors delta-side semantics).
      if (this.token?.aborted) return;
      const chunk = (update as { chunk?: unknown }).chunk;
      if (typeof chunk !== "string" || chunk.length === 0) return;
      this.post({ type: "thought", text: chunk });
      return;
    }
    // Every other update kind (including the stale cycle-L `agent_end` /
    // `turn_complete` names, which real ACP never emits — see runAcpTurn's
    // response-based settlement, TASK-007 B1) is deliberately ignored.
  }

  private handleAcpServerRequest(
    session: AcpSession,
    call: AcpServerRequest,
  ): void {
    if (call.method !== "session/request_permission") {
      // Unknown server request — reply with a JSON-RPC method-not-found so
      // the server can move on without waiting on us.
      call.respondError(-32601, `unsupported server request: ${call.method}`);
      return;
    }
    const params = call.params;
    if (params === null || typeof params !== "object") {
      call.respondError(-32602, "session/request_permission params required");
      return;
    }
    const p = params as {
      sessionId?: unknown;
      toolCall?: { id?: unknown; name?: unknown; detail?: unknown };
      options?: Array<{ optionId?: unknown; label?: unknown }>;
    };
    const options = Array.isArray(p.options) ? p.options : [];
    const toolCall = p.toolCall;
    const toolInfo = buildPermissionToolInfo(toolCall);
    const toolId = toolInfo.id;
    const toolName = toolInfo.name;
    const toolDetail = toolInfo.detail;
    const optionEntries: Array<{ optionId: string; label: string }> = [];
    const optionIdSet = new Set<string>();
    for (const opt of options) {
      const id = typeof opt.optionId === "string" ? opt.optionId : "";
      const label = typeof opt.label === "string" ? opt.label : "";
      if (id.length === 0) continue;
      optionEntries.push({ optionId: id, label });
      optionIdSet.add(id);
    }

    const seq = session.bumpRequestSeq();
    const requestId = `req-${Date.now().toString(36)}-${seq.toString(36)}`;
    const pending: PendingPermission = {
      serverId: call.id,
      requestId,
      optionIds: optionIdSet,
      settled: false,
      timeoutHandle: setTimeout(() => {
        // Default-deny on timeout — one cancelled ACP result.
        this.cancelPending(requestId);
      }, this.permissionTimeoutMs),
    };
    session.pending.set(requestId, pending);

    this.post({
      type: "permission_request",
      requestId,
      tool: { id: toolId, name: toolName, detail: toolDetail },
      options: optionEntries,
    });
  }

  /**
   * Apply a single webview permission response. Only one ACP result is
   * written per pending entry — duplicate / late / unknown / unlisted-option
   * responses are ignored.
   */
  private handlePermissionResponse(
    requestId: string,
    optionId: string | undefined,
  ): void {
    const session = this.acpSession;
    if (session === null) return;
    const pending = session.pending.get(requestId);
    if (pending === undefined || pending.settled) return;
    // Settle exactly once. We mark settled BEFORE writing to be safe in
    // case the write triggers a re-entrant path.
    pending.settled = true;
    clearTimeout(pending.timeoutHandle);
    const serverId = pending.serverId;
    session.pending.delete(requestId);

    // Allow requires a listed optionId; anything else (no optionId, unknown
    // optionId) is treated as deny — both paths write exactly one result.
    const isAllow =
      typeof optionId === "string" && pending.optionIds.has(optionId);
    if (isAllow) {
      session.handle.acp.respond(serverId, {
        outcome: { outcome: "selected", optionId: optionId as string },
      });
      return;
    }
    session.handle.acp.respond(serverId, {
      outcome: { outcome: "cancelled" },
    });
  }

  /**
   * Cancel every pending permission request with a one-shot cancelled ACP
   * result. Used on stop, dispose, replacement, and process exit. Each
   * pending entry writes at most one result (idempotent).
   */
  private cancelAllPending(): void {
    const session = this.acpSession;
    if (session === null) return;
    for (const requestId of Array.from(session.pending.keys())) {
      this.cancelPending(requestId);
    }
  }

  private cancelPending(requestId: string): void {
    const session = this.acpSession;
    if (session === null) return;
    const pending = session.pending.get(requestId);
    if (pending === undefined || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timeoutHandle);
    const serverId = pending.serverId;
    session.pending.delete(requestId);
    try {
      session.handle.acp.respond(serverId, {
        outcome: { outcome: "cancelled" },
      });
    } catch {
      // Process may have exited; the cancelled result is best-effort.
    }
  }

  private handleStop(): void {
    if (this.token) this.token.aborted = true;
    // Stop is an abnormal exit for any card still on screen: default-deny
    // every outstanding DB-tool request so its execute() unblocks.
    this.dbToolGate.cancelAll();
    if (this.engine === "builtin") {
      // Flip the per-turn signal so any in-flight streamComplete sees the
      // abort and stops reading from the SSE body. Agent-side emits the
      // bare AbortError which onText-on-the-host-side won't get to handle
      // (we suppress when token.aborted is true); the agent's runStep
      // rethrows it so the runBuiltinTurn catch is skipped.
      this.currentAbort?.abort();
    }
    if (this.engine === "omp" && this.acpSession !== null) {
      this.cancelAllPending();
      // TASK-007 B5: previously Stop never resolved `acpTurnResolvers`,
      // never posted `done`, and never told the server to stop generating
      // — the UI stayed busy forever and omp kept running. Best-effort
      // fire-and-forget `session/cancel` notification (no response
      // expected — see AcpClient.notify), then force the belt so
      // runAcpTurn's Promise.race settles immediately instead of waiting
      // on a response that may never distinguish this as a cancel.
      try {
        this.acpSession.handle.acp.notify("session/cancel", {
          sessionId: this.acpSession.sessionId,
        });
      } catch {
        // Best-effort — process may already be gone.
      }
      const resolvers = this.acpTurnResolvers.splice(0);
      for (const r of resolvers) r();
    }
  }

  /**
   * TASK-001 Regenerate (PLAN §3).
   *
   * Semantics:
   *   - Busy (`this.token !== null`) → no-op — a turn is already in flight.
   *   - Trailing `[user, assistant]` pair in history → pop both, strip
   *     the TASK-005 mention-augmentation block from the popped user text
   *     (so re-send does NOT leak the DDL/file body AND does NOT cause
   *     `resolveMentionsForTurn` to append a fresh `--- Referenced
   *     context ---` block on top of the stale one), then
   *     `await this.handleSend(stripped)`. The completed rerun appends
   *     exactly one new pair, so history never duplicates.
   *   - Otherwise the last UI exchange is a STOPPED one (history push sits
   *     inside `!token?.aborted`, so the stopped user message was never
   *     appended): re-send the stopped user text verbatim via
   *     `this.lastSentText`. `lastSentText` is reset by `handleClear` and
   *     `handleResumePick` so a Regenerate after either never resurrects
   *     a wiped/old-session prompt. History is not pre-mutated —
   *     handleSend's normal completion path appends the pair.
   *   - Empty history + nothing ever sent → no-op.
   */
  private async handleRegenerate(): Promise<void> {
    if (this.token !== null) return;
    if (
      this.history.length >= 2 &&
      this.history[this.history.length - 1]?.role === "assistant" &&
      this.history[this.history.length - 2]?.role === "user"
    ) {
      const prev = this.history[this.history.length - 2];
      const poppedUserText = prev.content;
      if (typeof poppedUserText !== "string") return;
      this.history = this.history.slice(0, -2);
      // TASK-005 mention augmentation mutated `userMsg.content` at handleSend
      // (:908) to embed the `--- Referenced context ---` block. Re-sending
      // the popped text verbatim would (a) leak the DDL/file content back
      // through the user's prompt text on the wire and (b) cause
      // resolveMentionsForTurn to APPEND a fresh block on top, producing
      // duplicated context. Strip the marker-then-onward before handleSend
      // so the normal send path re-resolves mentions fresh from the
      // ORIGINAL trimmed text.
      const stripped = stripReferencedContextMarker(poppedUserText);
      await this.handleSend(stripped);
      return;
    }
    // Not an intact trailing pair: the last UI exchange was stopped
    // (history never gained the pair). Re-send the stopped user text.
    if (
      typeof this.lastSentText !== "string" ||
      this.lastSentText.length === 0
    ) {
      return;
    }
    await this.handleSend(this.lastSentText);
  }

  private disposeAcpSession(): void {
    if (this.acpSession !== null) {
      try {
        this.acpSession.dispose();
      } catch {
        /* ignore */
      }
      try {
        this.acpSession.handle.dispose();
      } catch {
        /* ignore */
      }
      this.acpSession = null;
    }
  }

  private handleClear(): void {
    // Full turn reset: Clear giữa turn đang stream phải hủy turn + trả UI
    // về idle. Không reset token/currentAbort → webview busy mãi (D2).
    // Review Finding 2 (fix round 2): mark the LIVE token aborted before
    // nulling it. `runAcpTurn` captures `token` by reference before its
    // await, so a bare `this.token = null` here left that captured
    // reference's `aborted` still false — the ACP session dispose below
    // rejects the in-flight session/prompt with "disposed", and with
    // `token?.aborted` reading false (and `forced` also false, since Clear
    // doesn't push an acpTurnResolvers entry), that rejection was re-thrown
    // as `promptError` and rendered as an error bubble into the
    if (this.token) this.token.aborted = true;
    this.token = null;
    const beforeAbort = this.currentAbort;
    this.currentAbort?.abort();
    this.currentAbort = null;
    if (this.engine === "omp") {
      this.disposeAcpSession();
    }
    this.history = [];
    // this, Regenerate after Clear falls through to the stopped-path branch
    // (history has no trailing pair) and re-sends the pre-clear text,
    // resurrecting a message the user explicitly wiped.
    this.lastSentText = null;
    this.post({ type: "init", hasHistory: false, visionCapable: this.engine === "builtin" });
    this.post({ type: "done" });      // belt: webview busy flag về false
  }

  /** Workspace cwd used to filter session/list entries. */
  private workspaceCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    );
  }

  /** Compare two entries for sort-by-updatedAt-desc with a raw-string
   * fallback (TASK-003 F2): if Date.parse yields NaN for either side, fall
   * back to lexicographic comparison of the raw strings. */
  private static compareUpdatedAtDesc(
    a: AcpSessionListItem,
    b: AcpSessionListItem,
  ): number {
    const pa = Date.parse(a.updatedAt);
    const pb = Date.parse(b.updatedAt);
    if (Number.isNaN(pa) && Number.isNaN(pb)) {
      if (a.updatedAt < b.updatedAt) return 1;
      if (a.updatedAt > b.updatedAt) return -1;
      return 0;
    }
    if (Number.isNaN(pa)) return 1; // NaN last
    if (Number.isNaN(pb)) return -1;
    return pb - pa;
  }

  /** Pure helper: derive ordered history items from a replay buffer.
   * - agent_thought_chunk NEVER renders (TASK-003 §3)
   * - user_message_chunk: kind "user", text = content.text
   * - agent_message_chunk: kind "assistant", text = delta
   * - tool_call: kind "tool", text = title || name || toolCallId || "tool"
   * - cap: HISTORY_RENDER_CAP items; older items dropped, truncatedCount set.
   * - malformed entries (missing content/tool fields, unknown sessionUpdate)
   *   are skipped silently — derive NEVER throws. */
  static deriveHistoryFromReplay(
    notifications: readonly AcpReplayNotification[],
  ): {
    items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
    truncated: boolean;
    truncatedCount: number;
  } {
    const items: Array<{ kind: "user" | "assistant" | "tool"; text: string }> = [];
    for (const n of notifications) {
      if (n.method !== "session/update") continue;
      const params = n.params;
      if (params === null || typeof params !== "object") continue;
      const update = (params as { update?: unknown }).update;
      if (update === null || typeof update !== "object") continue;
      const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
      if (sessionUpdate === "agent_message_chunk") {
        // TASK-007 B2: same envelope as user_message_chunk below —
        // `content: {type:"text", text}`, not a `delta` field.
        const content = (update as { content?: unknown }).content;
        if (content === null || typeof content !== "object") continue;
        const text = (content as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          items.push({ kind: "assistant", text });
        }
        continue;
      }
      if (sessionUpdate === "user_message_chunk") {
        const content = (update as { content?: unknown }).content;
        if (content === null || typeof content !== "object") continue;
        const text = (content as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          items.push({ kind: "user", text });
        }
        continue;
      }
      if (sessionUpdate === "tool_call") {
        const title = (update as { title?: unknown }).title;
        const name = (update as { name?: unknown }).name;
        const toolCallId = (update as { toolCallId?: unknown }).toolCallId;
        const label =
          (typeof title === "string" && title.length > 0 && title) ||
          (typeof name === "string" && name.length > 0 && name) ||
          (typeof toolCallId === "string" && toolCallId.length > 0 && toolCallId) ||
          "tool";
        items.push({ kind: "tool", text: label });
        continue;
      }
      // agent_thought_chunk, unknown kinds: skipped silently.
    }
    const total = items.length;
    if (total <= HISTORY_RENDER_CAP) {
      return { items, truncated: false, truncatedCount: 0 };
    }
    const drop = total - HISTORY_RENDER_CAP;
    return {
      items: items.slice(drop),
      truncated: true,
      truncatedCount: drop,
    };
  }

  private async handleResumeList(): Promise<void> {
    // Guard: builtin engine has no session persistence — error inline.
    if (this.engine !== "omp") {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard: another list already in flight — drop silently.
    if (this.resumeListInFlight) return;
    const acp = this.options.acp;
    if (acp === undefined) {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard: while a turn is streaming, do not spawn a list round-trip.
    if (this.token !== null) return;
    this.resumeListInFlight = true;
    try {
      const session = await this.ensureAcpSession();
      const handle = session.handle;
      const cwd = this.workspaceCwd();
      const all = await handle.acp.sessionList();
      const ownSessionId = session.sessionId;
      const filtered = all
        .filter((e: AcpSessionListItem) => e.cwd === cwd)
        .filter((e: AcpSessionListItem) => e.sessionId !== ownSessionId)
        .slice()
        .sort(AiChatPanel.compareUpdatedAtDesc)
        .slice(0, RESUME_PICKER_CAP);
      this.post({
        type: "resume_sessions",
        sessions: filtered.map((e: AcpSessionListItem) => ({
          sessionId: e.sessionId,
          label:
            e.title !== null && e.title.length > 0 && e.title !== "<function>"
              ? e.title
              : "(untitled)",
          detail: `${e.messageCount} messages`,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", message: `Resume list failed: ${message}` });
    } finally {
      this.resumeListInFlight = false;
    }
  }

  private async handleResumePick(sessionId: string): Promise<void> {
    if (this.engine !== "omp") {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    // Guard (R5): while a turn is streaming, ignore resume_pick. Re-basing
    // sessionId mid-turn would let the in-flight agent_end arrive for the
    // OLD sessionId while session.sessionId is already the NEW one —
    // acpTurnResolvers never settles and the panel streams forever.
    if (this.token !== null) return;
    const acp = this.options.acp;
    if (acp === undefined) {
      this.post({
        type: "error",
        message: "Resume requires the omp engine.",
      });
      return;
    }
    try {
      const acpSession = await this.ensureAcpSession();
      const handle = acpSession.handle;
      // sessionLoad opens the replay window on the AcpClient. We arm the
      // panel-side drop-guard BEFORE awaiting so any in-flight frame that
      // races the load settles into the guard instead of leaking to the
      // delta path.
      this.dropReplayFrames = true;
      const cwd = this.workspaceCwd();
      const result = await handle.acp.sessionLoad(
        sessionId,
        cwd,
        acpSession.mcpServers,
      );
      const { items, truncated, truncatedCount } =
        AiChatPanel.deriveHistoryFromReplay(result.replay.notifications);
      // Re-base the active sessionId BEFORE posting the history batch so
      // the webview can immediately send a follow-up prompt. Both the
      // AcpProcessHandle AND the cached AcpSession must be updated so
      // runAcpTurn reads the new id when it next issues session/prompt.
      handle.sessionId = sessionId;
      acpSession.sessionId = sessionId;
      this.post({ type: "history", items, truncated, truncatedCount });
      // Fix round 4.5 (review): loading a saved session must NOT inherit
      // the in-memory `lastSentText` — a Regenerate pressed right after a
      // resume would re-send the pre-resume prompt into the reloaded
      // session. Drop it on every resume_pick settle.
      this.lastSentText = null;
      // dropReplayFrames stays armed until the next session/prompt write
      // (see runAcpTurn) — that write is what closes the AcpClient's
      // replay window, and the guard mirrors that lifecycle exactly.
    } catch (err) {
      this.dropReplayFrames = false;
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: "error",
        message: `Resume failed: ${message}`,
      });
    }
  }

  private handleResumeCancel(): void {
    // Nothing to cancel on the host side today — the webview closes the
    // picker. Reserved hook for a future in-flight load tracker.
  }

  /**
   * TASK-005: webview opened the @-mention dropdown and is asking for
   * candidate objects. We collect DB shortlist (tables/views/routines,
   * capped at MENTION_OBJECT_CAP) plus workspace files (capped at
   * MENTION_FILE_CAP) and post one `mention_objects` reply. The webview
   * filters client-side, so we always return the FULL shortlist on every
   * keystroke — server-side filtering would burn a round trip per char.
   *
   * Best-effort: any introspection failure → DB list is empty (only files
   * survive). findFiles failure → file list is empty (only DB objects).
   * Either or both empty → still post the message so the webview can
   * render "No matches" + close on Enter.
   */
  private async handleMentionList(query: string): Promise<void> {
    const items: Array<{
      kind: "table" | "view" | "routine" | "file";
      label: string;
      detail: string;
      token: string;
    }> = [];

    // DB shortlist — collected once, bounded at MENTION_OBJECT_CAP.
    let adapter: DbAdapter | null = null;
    try {
      adapter = await this.options.adapterFactory();
    } catch {
      adapter = null;
    }
    if (adapter !== null) {
      try {
        const schemas = await adapter.listSchemas(false);
        for (const s of schemas) {
          if (items.length >= MENTION_OBJECT_CAP) break;
          try {
            for (const t of await adapter.listTables(s.name)) {
              if (items.length >= MENTION_OBJECT_CAP) break;
              items.push({
                kind: "table",
                label: `${t.schema}.${t.name}`,
                detail: `${t.schema} · table`,
                token: `${t.schema}.${t.name}`,
              });
              items.push({
                kind: "table",
                label: t.name,
                detail: `${t.schema} · table`,
                token: t.name,
              });
            }
          } catch {
            /* per-schema failure → keep going */
          }
          if (items.length >= MENTION_OBJECT_CAP) break;
          try {
            for (const v of await adapter.listViews(s.name)) {
              if (items.length >= MENTION_OBJECT_CAP) break;
              items.push({
                kind: "view",
                label: `${v.schema}.${v.name}`,
                detail: `${v.schema} · view`,
                token: `${v.schema}.${v.name}`,
              });
              items.push({
                kind: "view",
                label: v.name,
                detail: `${v.schema} · view`,
                token: v.name,
              });
            }
          } catch {
            /* per-schema failure → keep going */
          }
          if (items.length >= MENTION_OBJECT_CAP) break;
          try {
            for (const r of await adapter.listRoutines(s.name)) {
              if (items.length >= MENTION_OBJECT_CAP) break;
              items.push({
                kind: "routine",
                label: `${r.schema}.${r.name}`,
                detail: `${r.schema} · ${r.kind}`,
                token: `${r.schema}.${r.name}`,
              });
              items.push({
                kind: "routine",
                label: r.name,
                detail: `${r.schema} · ${r.kind}`,
                token: r.name,
              });
            }
          } catch {
            /* per-schema failure → keep going */
          }
        }
      } catch {
        // Introspection hard-failed — DB list stays empty, files still try.
      }
    }

    // Workspace files. Default excludes from vscode are applied by
    // findFiles("**/*", …) when the exclude arg is `undefined`; we pass
    // the platform-default exclude set explicitly so behaviour is stable
    // across hosts (and so the .git / node_modules / out tree is skipped).
    try {
      const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}";
      const uris = await vscode.workspace.findFiles(
        "**/*",
        exclude,
        MENTION_FILE_CAP,
      );
      for (const u of uris) {
        if (items.length >= MENTION_OBJECT_CAP + MENTION_FILE_CAP) break;
        const wsRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const rel = wsRoot.length > 0 && u.fsPath.startsWith(wsRoot)
          ? u.fsPath.slice(wsRoot.length).replace(/^\/+/, "")
          : u.fsPath;
        items.push({
          kind: "file",
          label: rel,
          detail: "file",
          token: rel,
        });
      }
    } catch {
      // findFiles failed (no workspace / permission) — file list stays empty.
    }

    this.post({ type: "mention_objects", items });
  }

  private post(msg: AiChatPanelHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  /**
   * Post an `engine` banner message (B8). Called once on first `ready` and
   * again on ACP→builtin failover so the banner self-corrects instead of
   * permanently claiming an engine that is no longer active. `version`
   * (omp only) and `hint` (builtin only) come from the single upstream
   * `detectOmp()`/`resolveEngine()` call the caller made — this method never
   * calls `detectOmp()` itself, so detection stays at-most-once per show.
   */
  private postEngine(name: EngineKind): void {
    const msg: AiChatPanelEngine = { type: "engine", name };
    if (name === "omp" && this.options.engineVersion !== undefined) {
      msg.version = this.options.engineVersion;
    }
    if (name === "builtin" && this.options.engineHint !== undefined) {
      msg.hint = this.options.engineHint;
    }
    this.post(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "aiChatPanel.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview.css"),
    );
    const csp = [
      "default-src 'none'",
      // TASK-001 (cycle AB): the attachments strip renders
      // `<img src="data:image/png;base64,…">` thumbnails; without an
      // `img-src` directive every thumbnail is blocked by default-src 'none'.
      "img-src 'self' data:",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta http-equiv="Content-Security-Policy" content="${csp}" />
      <link rel="stylesheet" href="${styleUri}" />
      <title>VSDB AI Chat</title>
    </head>
    <body class="vsdb-form-body vsdb-chat-body">
      <div id="vsdb-root" class="vsdb-chat"></div>
      <script src="${scriptUri}"></script>
    </body>
    </html>`;
  }
}
