// src/ui/aiChatSessionStore.ts — TASK-CHATV2-015
//
// Host-side structured chat session persistence. This is the ONLY place a
// chat transcript is written to disk. It replaces V1's DOM-scraped
// `innerText` export/history (docs/AI_HANDOFF/notes/chatv2-baseline.md §1.3)
// with a versioned record that is safe to persist.
//
// STORAGE — the existing VS Code extension-host mechanism (001 baseline):
// a `vscode.Memento` (workspaceState / globalState — see src/extension.ts).
// The store deliberately depends on a MINIMAL structural interface so it is
// unit-testable without `vscode`, but the production wiring passes
// `context.workspaceState`. Browser storage (localStorage / sessionStorage /
// IndexedDB) is NEVER used (PLAN §2).
//
// PRIVACY (hard): a persisted record never contains reasoning text, raw tool
// output, credentials, permission ids/tokens, connection strings, raw
// trace/stderr or attachment base64. `scanSessionRecordForForbidden`
// enforces this on every write and is exercised by the privacy test.
//
// DURABILITY: a terminal turn update is written IMMEDIATELY; a streaming
// checkpoint is coalesced behind a 750ms debounce and a terminal update
// flushes any pending checkpoint for that session. A corrupt/unknown-schema
// record is quarantined with a safe warning and never crashes the panel.
//
// Pure host TypeScript: no `vscode` import, no DOM.

/** The one live persisted schema version. Bump only with a migration. */
export const AI_CHAT_SESSION_SCHEMA_VERSION = 1 as const;

/** Streaming checkpoint coalescing window (task: 750ms). */
export const SESSION_CHECKPOINT_DEBOUNCE_MS = 750;

/** Older-history page size (task: 50 at a time). */
export const SESSION_PAGE_SIZE = 50;

/** Maximum live transcript units a viewport may render (PLAN §4 / task). */
export const SESSION_VIEWPORT_CAP = 200;

/** Resume picker cap (task: <=20 recent cwd-scoped entries). */
export const SESSION_RECENT_CAP = 20;

/**
 * Retention policy — explicit, conservative, documented defaults (the task
 * forbids hidden indefinite retention and names no existing project policy).
 * At most 50 sessions per cwd, and at most 30 days since `updatedAt`.
 */
export const SESSION_RETENTION_MAX_SESSIONS = 50;
export const SESSION_RETENTION_MAX_AGE_DAYS = 30;

/** Memento key namespace. Versioned so a future schema bump is additive. */
export const SESSION_INDEX_KEY = "UnicDB.aiChat.sessions.v1.index";
export const SESSION_RECORD_KEY_PREFIX = "UnicDB.aiChat.sessions.v1.record.";
export const SESSION_QUARANTINE_KEY = "UnicDB.aiChat.sessions.v1.quarantine";
/**
 * Per-session envelope sequence head. TASK-CHATV2-015 re-bases the panel's
 * LIVE V2 envelope onto a saved session when `resume_saved_session` adopts it;
 * without this the resumed session would restart at `sequence: 1`, which every
 * length-based gate (`LastSequenceBySession`, the webview `frameAccepted`)
 * treats as a stale/replayed frame. The head is host-owned and only ever
 * advances.
 */
export const SESSION_SEQUENCE_KEY_PREFIX = "UnicDB.aiChat.sessions.v1.seq.";

/** Minimal structural subset of `vscode.Memento` this store needs. */
export interface AiChatSessionMementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Persisted terminal state of the LAST turn in the session. */
export type AiChatSessionTerminalState = "idle" | "completed" | "stopped" | "failed";

/** Safe, structured activity summary — never raw tool output. */
export interface AiChatStoredActivity {
  readonly id: string;
  readonly turnId: string;
  readonly toolId: string;
  readonly label: string;
  readonly action: string;
  readonly status: "running" | "ok" | "failed" | "denied";
  readonly summary: string;
  readonly durationMs: number | null;
}

/** Selected context identity + resolution status (amber states preserved). */
export interface AiChatStoredContextRef {
  readonly kind: "file" | "selection" | "table" | "view" | "routine" | "schema";
  readonly id: string;
  readonly label: string;
  readonly status: "resolved" | "changed" | "missing";
}

/** One persisted visible message. Assistant text may be partial mid-stream. */
export interface AiChatStoredMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: string;
  /** True while the assistant message is still streaming. */
  readonly partial?: boolean;
  readonly context?: readonly AiChatStoredContextRef[];
  readonly activities?: readonly AiChatStoredActivity[];
}

/** A versioned, privacy-safe session record. */
export interface AiChatSessionRecord {
  readonly schemaVersion: typeof AI_CHAT_SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Workspace cwd the session was captured in (resume-picker scope). */
  readonly cwd: string;
  /** Display metadata only — never used to branch on capability. */
  readonly engine: string;
  readonly model: string;
  readonly messages: readonly AiChatStoredMessage[];
  readonly terminalState: AiChatSessionTerminalState;
  /** Short, safe diagnostic ids (never raw trace). */
  readonly diagnosticIds: readonly string[];
}

/** Index entry — everything the resume picker needs, without the messages. */
export interface AiChatStoredSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cwd: string;
  readonly messageCount: number;
  readonly terminalState: AiChatSessionTerminalState;
}

/** Result of a corrupt/migration failure — quarantined, never thrown. */
export interface AiChatQuarantineEntry {
  readonly key: string;
  readonly reason: string;
  readonly at: string;
}

export interface AiChatHydrateResult {
  readonly items: readonly AiChatStoredMessage[];
  readonly total: number;
  readonly hasMore: boolean;
}

export interface AiChatLoadEarlierResult {
  readonly items: readonly AiChatStoredMessage[];
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Privacy scan
// ---------------------------------------------------------------------------

/**
 * Forbidden KEY names (lower-cased, compared against object keys only — never
 * values, so legitimate user text mentioning a word is not flagged). Covers
 * reasoning, raw tool output, credentials/connection strings, permission
 * ids/tokens, raw trace/stderr and attachment base64.
 */
export const FORBIDDEN_SESSION_KEYS: readonly string[] = Object.freeze([
  "reasoning",
  "reasoningtext",
  "thought",
  "thoughts",
  "raw",
  "rawtext",
  "rawtooloutput",
  "tooloutput",
  "toolresult",
  "stdout",
  "stderr",
  "trace",
  "rawtrace",
  "apikey",
  "api_key",
  "credential",
  "credentials",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "connectionstring",
  "dsn",
  "base64",
  "permissionid",
  "requestid",
  "optionid",
  "token",
]);

export type AiChatSessionSafetyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively scan `value` for a forbidden object key. Returns the first
 * offending path so a failing test names exactly what leaked. Never throws.
 */
export function scanSessionRecordForForbidden(value: unknown): AiChatSessionSafetyResult {
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string): AiChatSessionSafetyResult => {
    if (node === null || typeof node !== "object") return { ok: true };
    if (seen.has(node)) return { ok: true };
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const r = walk(node[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (FORBIDDEN_SESSION_KEYS.includes(key.toLowerCase())) {
        return { ok: false, reason: `${path}.${key}`.replace(/^\./, "") };
      }
      const r = walk((node as Record<string, unknown>)[key], `${path}.${key}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
  return walk(value, "");
}

// ---------------------------------------------------------------------------
// Parsing / migration
// ---------------------------------------------------------------------------

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "stopped",
  "failed",
]);

const CONTEXT_KINDS: ReadonlySet<string> = new Set([
  "file",
  "selection",
  "table",
  "view",
  "routine",
  "schema",
]);

const CONTEXT_STATUSES: ReadonlySet<string> = new Set([
  "resolved",
  "changed",
  "missing",
]);

const TOOL_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "ok",
  "failed",
  "denied",
]);

function parseContextRef(raw: unknown): AiChatStoredContextRef | null {
  if (!isPlainRecord(raw)) return null;
  const { kind, id, label, status } = raw;
  if (typeof kind !== "string" || !CONTEXT_KINDS.has(kind)) return null;
  if (!isIsoString(id) || typeof label !== "string") return null;
  if (typeof status !== "string" || !CONTEXT_STATUSES.has(status)) return null;
  return {
    kind: kind as AiChatStoredContextRef["kind"],
    id,
    label,
    status: status as AiChatStoredContextRef["status"],
  };
}

function parseActivity(raw: unknown): AiChatStoredActivity | null {
  if (!isPlainRecord(raw)) return null;
  const { id, turnId, toolId, label, action, status, summary, durationMs } = raw;
  if (!isIsoString(id) || !isIsoString(turnId) || !isIsoString(toolId)) return null;
  if (typeof label !== "string" || typeof action !== "string") return null;
  if (typeof status !== "string" || !TOOL_STATUSES.has(status)) return null;
  if (typeof summary !== "string") return null;
  if (durationMs !== null && typeof durationMs !== "number") return null;
  return {
    id,
    turnId,
    toolId,
    label,
    action,
    status: status as AiChatStoredActivity["status"],
    summary,
    durationMs: (durationMs as number | null) ?? null,
  };
}

function parseMessage(raw: unknown): AiChatStoredMessage | null {
  if (!isPlainRecord(raw)) return null;
  const { id, role, text, createdAt, turnId, partial, context, activities } = raw;
  if (!isIsoString(id)) return null;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof text !== "string" || !isIsoString(createdAt)) return null;
  const msg: {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    turnId?: string;
    partial?: boolean;
    context?: readonly AiChatStoredContextRef[];
    activities?: readonly AiChatStoredActivity[];
  } = { id, role, text, createdAt };
  if (isIsoString(turnId)) msg.turnId = turnId;
  if (partial === true) msg.partial = true;
  if (context !== undefined) {
    if (!Array.isArray(context)) return null;
    const refs: AiChatStoredContextRef[] = [];
    for (const entry of context) {
      const ref = parseContextRef(entry);
      if (ref === null) return null;
      refs.push(ref);
    }
    msg.context = refs;
  }
  if (activities !== undefined) {
    if (!Array.isArray(activities)) return null;
    const acts: AiChatStoredActivity[] = [];
    for (const entry of activities) {
      const act = parseActivity(entry);
      if (act === null) return null;
      acts.push(act);
    }
    msg.activities = acts;
  }
  return msg;
}

/**
 * Parse one raw persisted value into a live record. Returns `null` for a
 * record this schema version cannot safely read (unknown version, wrong
 * shape) — the caller quarantines rather than throwing.
 */
export function migrateSessionRecord(raw: unknown): AiChatSessionRecord | null {
  try {
    if (!isPlainRecord(raw)) return null;
    if (raw["schemaVersion"] !== AI_CHAT_SESSION_SCHEMA_VERSION) return null;
    const { id, title, createdAt, updatedAt, cwd, engine, model, terminalState } = raw;
    if (!isIsoString(id) || typeof title !== "string") return null;
    if (!isIsoString(createdAt) || !isIsoString(updatedAt)) return null;
    if (typeof cwd !== "string") return null;
    if (typeof engine !== "string" || typeof model !== "string") return null;
    if (typeof terminalState !== "string" || !TERMINAL_STATES.has(terminalState)) return null;
    const rawMessages = raw["messages"];
    if (!Array.isArray(rawMessages)) return null;
    const messages: AiChatStoredMessage[] = [];
    for (const entry of rawMessages) {
      const msg = parseMessage(entry);
      if (msg === null) return null;
      messages.push(msg);
    }
    const rawDiagnostics = raw["diagnosticIds"];
    if (!Array.isArray(rawDiagnostics)) return null;
    const diagnosticIds: string[] = [];
    for (const entry of rawDiagnostics) {
      if (typeof entry !== "string") return null;
      diagnosticIds.push(entry);
    }
    return {
      schemaVersion: AI_CHAT_SESSION_SCHEMA_VERSION,
      id,
      title,
      createdAt,
      updatedAt,
      cwd,
      engine,
      model,
      messages,
      terminalState: terminalState as AiChatSessionTerminalState,
      diagnosticIds,
    };
  } catch {
    return null;
  }
}

function summaryOf(record: AiChatSessionRecord): AiChatStoredSessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    cwd: record.cwd,
    messageCount: record.messages.length,
    terminalState: record.terminalState,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface AiChatSessionStoreOptions {
  readonly memento: AiChatSessionMementoLike;
  /** Injectable clock (ISO strings). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable id factory. Defaults to a random opaque id. */
  readonly idFactory?: () => string;
  /** Resume label when a session has no user title yet. */
  readonly untitledLabel?: string;
}

/** Copy shown for a session with no user-set title. */
export const SESSION_UNTITLED_LABEL = "Untitled chat";

export interface CreateSessionInput {
  readonly cwd: string;
  readonly engine: string;
  readonly model: string;
  readonly title?: string;
  /** Explicit opaque id (the panel reuses its host session id). Optional. */
  readonly id?: string;
}

export interface FinalizeTurnInput {
  readonly terminalState: AiChatSessionTerminalState;
  /** Persisted assistant text — final OR the preserved partial on stop. */
  readonly assistantText: string;
  readonly assistantMessageId: string;
  readonly turnId: string;
  readonly activities?: readonly AiChatStoredActivity[];
  readonly diagnosticIds?: readonly string[];
  readonly partial?: boolean;
}

function defaultId(): string {
  return `sess-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Structured, crash-safe session store backed by a VS Code Memento.
 *
 * All reads are served from an in-memory cache hydrated lazily from the
 * memento; all writes validate + scan, update the cache synchronously, then
 * persist. Any throw from the underlying memento is swallowed and reported as
 * a safe warning — persistence failure must never crash the panel.
 */
export class AiChatSessionStore {
  private readonly memento: AiChatSessionMementoLike;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly untitledLabel: string;

  /** id -> record (hydrated lazily). */
  private readonly records = new Map<string, AiChatSessionRecord>();
  /** Index of summaries, newest-first is enforced on read. */
  private index: AiChatStoredSessionSummary[] | null = null;
  /** Quarantined records found while reading (safe warnings). */
  private readonly quarantine: AiChatQuarantineEntry[] = [];
  /** Pending debounce timers keyed by session id. */
  private readonly checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Pending checkpoint payloads keyed by session id. Only the latest text per
   * assistant messageId survives, so N deltas coalesce into ONE write.
   */
  private readonly pendingCheckpoints = new Map<
    string,
    { messageId: string; text: string; turnId: string }
  >();
  /** Safe warnings emitted by this store (quarantine + write failures). */
  private readonly warnings: string[] = [];

  constructor(options: AiChatSessionStoreOptions) {
    this.memento = options.memento;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.untitledLabel = options.untitledLabel ?? SESSION_UNTITLED_LABEL;
  }

  // -- misc ----------------------------------------------------------------

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private warn(message: string): void {
    this.warnings.push(message);
  }

  /** Drain safe warnings (quarantine + write failures). Never returns secrets. */
  takeWarnings(): readonly string[] {
    return this.warnings.splice(0, this.warnings.length);
  }

  /** Quarantined records observed so far. */
  quarantined(): readonly AiChatQuarantineEntry[] {
    return this.quarantine.slice();
  }

  // -- persistence ---------------------------------------------------------

  private persist(key: string, value: unknown): void {
    try {
      const result = this.memento.update(key, value);
      // `update` returns a Thenable that may reject asynchronously; swallow
      // the rejection so a failing host store never surfaces as a panel crash.
      void Promise.resolve(result).catch(() => {
        this.warn("Saved chat sessions could not be written to host storage.");
      });
    } catch {
      this.warn("Saved chat sessions could not be written to host storage.");
    }
  }

  private readIndex(): AiChatStoredSessionSummary[] {
    if (this.index !== null) return this.index;
    let raw: unknown;
    try {
      raw = this.memento.get<unknown>(SESSION_INDEX_KEY, []);
    } catch {
      raw = [];
    }
    const out: AiChatStoredSessionSummary[] = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!isPlainRecord(entry)) continue;
        const { id, title, createdAt, updatedAt, cwd, messageCount, terminalState } = entry;
        if (!isIsoString(id) || typeof title !== "string") continue;
        if (!isIsoString(createdAt) || !isIsoString(updatedAt)) continue;
        if (typeof cwd !== "string") continue;
        if (typeof messageCount !== "number") continue;
        if (typeof terminalState !== "string" || !TERMINAL_STATES.has(terminalState)) continue;
        out.push({
          id,
          title,
          createdAt,
          updatedAt,
          cwd,
          messageCount,
          terminalState: terminalState as AiChatSessionTerminalState,
        });
      }
    }
    this.index = out;
    return out;
  }

  private writeIndex(): void {
    this.persist(SESSION_INDEX_KEY, this.readIndex());
  }

  /** Load (and validate) one record, quarantining it when unreadable. */
  load(id: string): AiChatSessionRecord | null {
    const cached = this.records.get(id);
    if (cached) return cached;
    if (!this.isIndexed(id)) return null;
    let raw: unknown;
    try {
      raw = this.memento.get<unknown>(`${SESSION_RECORD_KEY_PREFIX}${id}`);
    } catch {
      raw = undefined;
    }
    const record = migrateSessionRecord(raw);
    if (record === null) {
      this.quarantineRecord(id, raw === undefined ? "missing-record" : "unsupported-schema-or-corrupt");
      return null;
    }
    this.records.set(id, record);
    return record;
  }

  private isIndexed(id: string): boolean {
    return this.readIndex().some((s) => s.id === id);
  }

  private quarantineRecord(id: string, reason: string): void {
    const key = `${SESSION_RECORD_KEY_PREFIX}${id}`;
    this.quarantine.push({ key, reason, at: this.timestamp() });
    // Drop the unreadable entry from the index but leave the raw record on
    // disk (never destroy user data on a parse failure).
    const idx = this.readIndex();
    const next = idx.filter((s) => s.id !== id);
    if (next.length !== idx.length) {
      this.index = next;
      this.persist(SESSION_INDEX_KEY, next);
    }
    const prior = this.memento.get<unknown>(SESSION_QUARANTINE_KEY, []);
    const list = Array.isArray(prior) ? prior.slice() : [];
    list.push({ key, reason, at: this.timestamp() });
    this.persist(SESSION_QUARANTINE_KEY, list);
    this.warn("A saved chat could not be opened and was skipped.");
    this.records.delete(id);
  }

  /**
   * Write a record immediately (validated + privacy-scanned). Refuses to
   * persist an unsafe record rather than leaking data to disk.
   */
  private writeRecord(record: AiChatSessionRecord): boolean {
    const safety = scanSessionRecordForForbidden(record);
    if (!safety.ok) {
      this.warn("A chat update was skipped because it contained data that is not saved.");
      return false;
    }
    this.records.set(record.id, record);
    const idx = this.readIndex().filter((s) => s.id !== record.id);
    idx.push(summaryOf(record));
    this.index = idx;
    this.persist(SESSION_INDEX_KEY, idx);
    this.persist(`${SESSION_RECORD_KEY_PREFIX}${record.id}`, record);
    return true;
  }

  // -- session lifecycle ---------------------------------------------------

  /** Create + persist a fresh session immediately. */
  create(input: CreateSessionInput): AiChatSessionRecord {
    const ts = this.timestamp();
    const record: AiChatSessionRecord = {
      schemaVersion: AI_CHAT_SESSION_SCHEMA_VERSION,
      id: input.id ?? this.idFactory(),
      title: input.title ?? "",
      createdAt: ts,
      updatedAt: ts,
      cwd: input.cwd,
      engine: input.engine,
      model: input.model,
      messages: [],
      terminalState: "idle",
      diagnosticIds: [],
    };
    this.writeRecord(record);
    return record;
  }

  /** The live record for `id`, or null when unknown/quarantined. */
  get(id: string): AiChatSessionRecord | null {
    return this.load(id);
  }

  /**
   * Every stored summary for `cwd`, newest-first, UNCAPPED. Retention and
   * diagnostics read this; the UI picker uses {@link listRecent}, whose cap
   * is the task's <=20 contract and must not be relaxed for either caller.
   */
  listSummaries(cwd: string): AiChatStoredSessionSummary[] {
    return this.readIndex()
      .filter((s) => s.cwd === cwd)
      .slice()
      .sort((a, b) => {
        const pa = Date.parse(a.updatedAt);
        const pb = Date.parse(b.updatedAt);
        if (Number.isNaN(pa) && Number.isNaN(pb)) return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
        if (Number.isNaN(pa)) return 1;
        if (Number.isNaN(pb)) return -1;
        return pb - pa;
      });
  }

  /**
   * Resume-picker list: cwd-scoped, newest-first, capped at `SESSION_RECENT_CAP`
   * (the picker contract). Entries with no title fall back to the untitled
   * label — never a provider/native-resume claim.
   */
  listRecent(cwd: string, cap: number = SESSION_RECENT_CAP): AiChatStoredSessionSummary[] {
    const limit = Math.max(0, Math.min(cap, SESSION_RECENT_CAP));
    return this.listSummaries(cwd).slice(0, limit);
  }

  /** Display label for one summary (untitled fallback). */
  labelFor(summary: AiChatStoredSessionSummary): string {
    return summary.title.length > 0 ? summary.title : this.untitledLabel;
  }

  /** Rename by opaque id. Returns the updated record, or null when unknown. */
  rename(id: string, title: string): AiChatSessionRecord | null {
    const record = this.load(id);
    if (record === null) return null;
    const next: AiChatSessionRecord = { ...record, title, updatedAt: this.timestamp() };
    return this.writeRecord(next) ? next : record;
  }

  /** Append a visible user message + its selected context identities. */
  appendUserMessage(
    id: string,
    input: { id: string; text: string; context?: readonly AiChatStoredContextRef[]; turnId?: string },
  ): AiChatSessionRecord | null {
    const record = this.load(id);
    if (record === null) return null;
    const message: AiChatStoredMessage = {
      id: input.id,
      role: "user",
      text: input.text,
      createdAt: this.timestamp(),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    const next: AiChatSessionRecord = {
      ...record,
      messages: [...record.messages, message],
      terminalState: "idle",
      updatedAt: this.timestamp(),
    };
    return this.writeRecord(next) ? next : record;
  }

  /**
   * Streaming checkpoint — coalesced behind `SESSION_CHECKPOINT_DEBOUNCE_MS`.
   * Repeated calls for the same session rewrite ONE pending payload and
   * schedule ONE timer, so N deltas produce one write.
   */
  checkpointAssistant(id: string, input: { messageId: string; text: string; turnId: string }): void {
    this.pendingCheckpoints.set(id, {
      messageId: input.messageId,
      text: input.text,
      turnId: input.turnId,
    });
    if (this.checkpointTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.checkpointTimers.delete(id);
      this.flushCheckpoint(id);
    }, SESSION_CHECKPOINT_DEBOUNCE_MS);
    // A pending checkpoint must never keep the extension host alive.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.checkpointTimers.set(id, timer);
  }

  /** Apply the pending checkpoint payload for one session (if any). */
  private flushCheckpoint(id: string): void {
    const pending = this.pendingCheckpoints.get(id);
    if (pending === undefined) return;
    this.pendingCheckpoints.delete(id);
    const record = this.load(id);
    if (record === null) return;
    const messages = upsertAssistant(record.messages, {
      id: pending.messageId,
      turnId: pending.turnId,
      text: pending.text,
      at: this.timestamp(),
      partial: true,
    });
    this.writeRecord({
      ...record,
      messages,
      terminalState: "idle",
      updatedAt: this.timestamp(),
    });
  }

  /**
   * Terminal turn update — written IMMEDIATELY (cancels any pending
   * checkpoint for this session first, so exactly one final write wins).
   */
  finalizeTurn(id: string, input: FinalizeTurnInput): AiChatSessionRecord | null {
    this.cancelCheckpoint(id);
    const record = this.load(id);
    if (record === null) return null;
    const ts = this.timestamp();
    const messages = upsertAssistant(record.messages, {
      id: input.assistantMessageId,
      turnId: input.turnId,
      text: input.assistantText,
      at: ts,
      partial: input.partial === true,
    });
    const withActivities = attachActivities(messages, input.assistantMessageId, input.activities);
    const diagnostics = mergeDiagnostics(record.diagnosticIds, input.diagnosticIds);
    const next: AiChatSessionRecord = {
      ...record,
      messages: withActivities,
      terminalState: input.terminalState,
      diagnosticIds: diagnostics,
      updatedAt: ts,
    };
    return this.writeRecord(next) ? next : record;
  }

  private cancelCheckpoint(id: string): void {
    const timer = this.checkpointTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.checkpointTimers.delete(id);
    }
    this.pendingCheckpoints.delete(id);
  }

  /** Force every pending checkpoint to disk (panel dispose / test teardown). */
  flush(): void {
    for (const id of Array.from(this.checkpointTimers.keys())) {
      const timer = this.checkpointTimers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.checkpointTimers.delete(id);
      this.flushCheckpoint(id);
    }
  }

  /**
   * Clear the CURRENT transcript (all messages) but never touch any other
   * session. The session shell + title survive so the window keeps them.
   */
  clearTranscript(id: string): AiChatSessionRecord | null {
    const record = this.load(id);
    if (record === null) return null;
    this.cancelCheckpoint(id);
    const next: AiChatSessionRecord = {
      ...record,
      messages: [],
      terminalState: "idle",
      diagnosticIds: [],
      updatedAt: this.timestamp(),
    };
    return this.writeRecord(next) ? next : record;
  }

  // -- envelope sequence head ---------------------------------------------

  /**
   * Highest V2 envelope sequence already assigned to `id` (0 before the first
   * frame). The panel seeds its `lastEnvelope` from this on resume so the
   * re-based session continues the sequence instead of replaying from 1.
   */
  sequenceHead(id: string): number {
    let raw: unknown;
    try {
      raw = this.memento.get<unknown>(`${SESSION_SEQUENCE_KEY_PREFIX}${id}`, 0);
    } catch {
      raw = 0;
    }
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  /** Record the highest sequence assigned to `id` (monotonic; never lowers). */
  noteSequence(id: string, sequence: number): void {
    if (!Number.isFinite(sequence) || sequence <= 0) return;
    const floor = Math.floor(sequence);
    if (floor <= this.sequenceHead(id)) return;
    this.persist(`${SESSION_SEQUENCE_KEY_PREFIX}${id}`, floor);
  }

  /** Remove one session entirely (explicit user action only). */
  remove(id: string): boolean {
    if (!this.isIndexed(id)) return false;
    this.cancelCheckpoint(id);
    this.records.delete(id);
    this.index = this.readIndex().filter((s) => s.id !== id);
    this.writeIndex();
    this.persist(`${SESSION_RECORD_KEY_PREFIX}${id}`, undefined);
    return true;
  }

  // -- paging --------------------------------------------------------------

  /**
   * Hydrate the recent transcript before the ready UI: the last
   * `SESSION_VIEWPORT_CAP` messages plus `hasMore` for the older page.
   */
  hydrate(id: string): AiChatHydrateResult {
    const record = this.load(id);
    if (record === null) return { items: [], total: 0, hasMore: false };
    const total = record.messages.length;
    const start = Math.max(0, total - SESSION_VIEWPORT_CAP);
    return {
      items: record.messages.slice(start),
      total,
      hasMore: start > 0,
    };
  }

  /**
   * Load one older page (<= `SESSION_PAGE_SIZE`) ending just before
   * `beforeIndex`. `beforeIndex` is an index into the FULL ordered transcript.
   * `hasMore` is true while older messages remain.
   */
  loadEarlier(id: string, beforeIndex: number): AiChatLoadEarlierResult {
    const record = this.load(id);
    if (record === null) return { items: [], hasMore: false };
    const end = Math.max(0, Math.min(beforeIndex, record.messages.length));
    const start = Math.max(0, end - SESSION_PAGE_SIZE);
    return {
      items: record.messages.slice(start, end),
      hasMore: start > 0,
    };
  }

  // -- retention -----------------------------------------------------------

  /**
   * Apply the documented retention policy: at most
   * `SESSION_RETENTION_MAX_SESSIONS` per cwd and
   * `SESSION_RETENTION_MAX_AGE_DAYS` since `updatedAt`. Removed sessions are
   * deleted, never silently kept — no hidden indefinite retention.
   */
  enforceRetention(cwd: string): string[] {
    const removed: string[] = [];
    const cutoff = this.now() - SESSION_RETENTION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const scoped = this.readIndex()
      .filter((s) => s.cwd === cwd)
      .slice()
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    for (let i = 0; i < scoped.length; i += 1) {
      const s = scoped[i]!;
      const parsed = Date.parse(s.updatedAt);
      const tooOld = !Number.isNaN(parsed) && parsed < cutoff;
      const tooMany = i >= SESSION_RETENTION_MAX_SESSIONS;
      if (tooOld || tooMany) {
        this.remove(s.id);
        removed.push(s.id);
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function upsertAssistant(
  messages: readonly AiChatStoredMessage[],
  input: { id: string; turnId: string; text: string; at: string; partial: boolean },
): AiChatStoredMessage[] {
  const existingIndex = messages.findIndex((m) => m.id === input.id);
  const base: AiChatStoredMessage = {
    id: input.id,
    role: "assistant",
    text: input.text,
    createdAt: existingIndex >= 0 ? messages[existingIndex]!.createdAt : input.at,
    turnId: input.turnId,
    ...(input.partial ? { partial: true } : {}),
  };
  if (existingIndex < 0) return [...messages, base];
  const previous = messages[existingIndex]!;
  const replacement: AiChatStoredMessage = {
    ...base,
    ...(previous.activities !== undefined ? { activities: previous.activities } : {}),
  };
  const next = messages.slice();
  next[existingIndex] = replacement;
  return next;
}

function attachActivities(
  messages: readonly AiChatStoredMessage[],
  messageId: string,
  activities: readonly AiChatStoredActivity[] | undefined,
): readonly AiChatStoredMessage[] {
  if (activities === undefined) return messages;
  const index = messages.findIndex((m) => m.id === messageId);
  if (index < 0) return messages;
  const next = messages.slice();
  next[index] = { ...messages[index]!, activities };
  return next;
}

function mergeDiagnostics(
  prior: readonly string[],
  incoming: readonly string[] | undefined,
): readonly string[] {
  if (incoming === undefined || incoming.length === 0) return prior;
  const out = prior.slice();
  for (const id of incoming) if (!out.includes(id)) out.push(id);
  return out;
}
