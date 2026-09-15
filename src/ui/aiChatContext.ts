// src/ui/aiChatContext.ts — TASK-CHATV2-011
//
// The structured context-identity layer shared by the host and the webview.
// It is deliberately DEPENDENCY-FREE (no `vscode`, no node builtins, no DOM) so
// the exact same code runs in the extension host and inside the webview bundle:
// identity, status and preview can therefore never disagree about shape.
//
// WHAT A `ContextRef` IS
// A ref is an IDENTITY plus METADATA about a piece of context — never the
// context itself. It carries no file content, no row bytes and no base64. That
// is a hard privacy rule (PLAN §4/§6): a ref may be rendered into a chip, put
// in a DOM attribute or put on the wire, so it must never be able to leak the
// thing it points at.
//
//   id            stable, unique per (source, range) — duplicates NEVER collide
//   kind          file | selection | table | view | routine | schema
//   label         short display name (may repeat across connections/folders)
//   detail        the FULL distinguishing identity (workspace path, or
//                 connection.schema.object) — what disambiguates duplicate
//                 labels
//   displayToken  the literal text inserted into the composer, e.g.
//                 `@index.vue` or `@selection(index.vue:22–48)`
//   source        URI, or connection/schema/object signature
//   snapshot      opaque revision + capture time (a fingerprint, never bytes)
//   status        ready | changed | missing | forbidden
//   preview       whether a safe, model-free preview exists (and why not)
//
// STATUS SEMANTICS
// A ref is captured with a `revision` fingerprint of the source at capture
// time. Re-validation compares that fingerprint with the live one:
//   forbidden  policy denies this context class at all
//   missing    the source no longer exists
//   changed    the source exists but its fingerprint moved
//   ready      fingerprints match
// Only `ready` may be sent without the user making an explicit choice. A
// changed/missing/forbidden ref is NEVER auto-dropped — the send is blocked
// until the user chooses Refresh / Keep snapshot / Remove / Send without it.

/** Closed kind vocabulary (matches `AiChatContextRefV2["kind"]`). */
export type ContextRefKind = "file" | "selection" | "table" | "view" | "routine" | "schema";

/** Closed status vocabulary. */
export type ContextRefStatus = "ready" | "changed" | "missing" | "forbidden";

/** Search filter carried on a mention-search intent. */
export type ContextKindFilter = "all" | "file" | "selection" | "database";

/** URI-backed identity (workspace file or editor selection). */
export interface ContextSourceUri {
  readonly type: "uri";
  readonly uri: string;
}

/** Database object identity: connection + schema + object signature. */
export interface ContextSourceObject {
  readonly type: "object";
  readonly connectionId: string;
  readonly schema: string;
  readonly name: string;
  readonly objectKind: "table" | "view" | "routine" | "schema";
}

export type ContextSource = ContextSourceUri | ContextSourceObject;

/**
 * Snapshot metadata. `revision` is an OPAQUE fingerprint produced by the host
 * (mtime+size for files, a DDL/catalog signature for objects). It is never the
 * content itself, so it is safe on the wire and in an attribute.
 */
export interface ContextSnapshot {
  readonly revision: string;
  /** Epoch ms the ref was captured, or null when the host has no clock. */
  readonly capturedAt: number | null;
}

/** Whether a safe (model-free, content-free) preview exists for a ref. */
export interface ContextPreviewCapability {
  readonly supported: boolean;
  /** Safe one-line reason when `supported` is false. */
  readonly reason: string | null;
}

/** A structured context reference. Never carries content. */
export interface ContextRef {
  readonly id: string;
  readonly kind: ContextRefKind;
  readonly label: string;
  readonly detail: string;
  readonly displayToken: string;
  readonly source: ContextSource;
  readonly snapshot: ContextSnapshot;
  readonly status: ContextRefStatus;
  readonly preview: ContextPreviewCapability;
}

/** Extra creation metadata the caller may know before capture. */
export interface ContextCandidate {
  readonly kind: ContextRefKind;
  readonly label: string;
  /** Full distinguishing identity (path, or connection.schema.object). */
  readonly detail: string;
  readonly source: ContextSource;
  /** Opaque fingerprint; `""` means "unknown/no fingerprint". */
  readonly revision?: string;
  /** Selection line range (1-based, inclusive). Selection refs only. */
  readonly lineRange?: { readonly start: number; readonly end: number };
  readonly status?: ContextRefStatus;
  readonly preview?: ContextPreviewCapability;
}

/** En-dash used in selection display tokens (`22–48`), per the spec. */
export const SELECTION_RANGE_DASH = "–";

const URI_KINDS: ReadonlySet<ContextRefKind> = new Set<ContextRefKind>(["file", "selection"]);

const OBJECT_LABELS: Readonly<Record<"table" | "view" | "routine" | "schema", string>> = {
  table: "table",
  view: "view",
  routine: "routine",
  schema: "schema",
};

/** True when the kind is URI-backed (file/selection) rather than a DB object. */
export function isUriContextKind(kind: ContextRefKind): boolean {
  return URI_KINDS.has(kind);
}

/** Terminate a ref's kind from an object source. */
export function objectKindOf(source: ContextSource): "table" | "view" | "routine" | "schema" | null {
  return source.type === "object" ? source.objectKind : null;
}

/** Build the stable id for a candidate. Two refs collide ONLY when their
 * identity and range collide — duplicate labels never produce duplicate ids. */
export function contextRefId(candidate: ContextCandidate): string {
  const source = candidate.source;
  if (source.type === "uri") {
    if (candidate.kind === "selection" && candidate.lineRange !== undefined) {
      return `selection:${source.uri}:${candidate.lineRange.start}-${candidate.lineRange.end}`;
    }
    return `${candidate.kind}:${source.uri}`;
  }
  return `${candidate.kind}:${source.connectionId}.${source.schema}.${source.name}`;
}

/**
 * The literal token inserted into the composer for a candidate.
 *
 * - file       `@index.vue` (full path when `disambiguate` is set)
 * - selection  `@selection(index.vue:22–48)`
 * - object     `@schema.name` (connection-qualified when `disambiguate`)
 *
 * `disambiguate` is chosen by {@link buildContextRefs} when two refs would
 * otherwise render an identical token — a duplicate filename/object MUST show
 * its full distinguishing path or connection.schema.
 */
export function contextDisplayToken(
  candidate: ContextCandidate,
  disambiguate = false,
): string {
  const source = candidate.source;
  if (candidate.kind === "selection" && source.type === "uri" && candidate.lineRange !== undefined) {
    const path = disambiguate ? candidate.detail : candidate.label;
    return `@selection(${path}:${candidate.lineRange.start}${SELECTION_RANGE_DASH}${candidate.lineRange.end})`;
  }
  if (candidate.kind === "file") {
    return `@${disambiguate ? candidate.detail : candidate.label}`;
  }
  if (source.type === "object") {
    return disambiguate
      ? `@${source.connectionId}.${source.schema}.${source.name}`
      : `@${source.schema}.${source.name}`;
  }
  return `@${candidate.label}`;
}

/** A ref's preview is unsupported only when the caller says so or the ref is
 * not resolvable at all. */
function previewFor(candidate: ContextCandidate): ContextPreviewCapability {
  if (candidate.preview !== undefined) return candidate.preview;
  if (candidate.status === "missing") {
    return { supported: false, reason: "This context no longer exists." };
  }
  if (candidate.status === "forbidden") {
    return { supported: false, reason: "This context is not permitted." };
  }
  return { supported: true, reason: null };
}

/**
 * Turn candidates into refs, disambiguating duplicate display tokens.
 *
 * Disambiguation rule: when two candidates would render the SAME token (two
 * `index.vue` in different folders, two `public.users` on different
 * connections), every member of that token group switches to its full
 * distinguishing form. A user can therefore always tell two rows apart, and a
 * removal always names exactly one id.
 */
export function buildContextRefs(
  candidates: readonly ContextCandidate[],
  options: { readonly now?: () => number } = {},
): readonly ContextRef[] {
  const now = options.now;

  // Group by the token a candidate WOULD render without disambiguation.
  const tokenGroups = new Map<string, number>();
  const plainTokens = candidates.map((c) => contextDisplayToken(c, false));
  for (const token of plainTokens) {
    tokenGroups.set(token, (tokenGroups.get(token) ?? 0) + 1);
  }

  const seenIds = new Set<string>();
  const refs: ContextRef[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const id = contextRefId(candidate);
    if (seenIds.has(id)) continue; // identical identity+range → one ref
    seenIds.add(id);
    const ambiguous = (tokenGroups.get(plainTokens[index]!) ?? 0) > 1;
    const capturedAt = candidate.revision === undefined || now === undefined ? null : now();
    refs.push(
      Object.freeze({
        id,
        kind: candidate.kind,
        label: candidate.label,
        detail: candidate.detail,
        displayToken: contextDisplayToken(candidate, ambiguous),
        source: candidate.source,
        snapshot: Object.freeze({
          revision: candidate.revision ?? "",
          capturedAt,
        }),
        status: candidate.status ?? "ready",
        preview: Object.freeze(previewFor(candidate)),
      }),
    );
  }
  return Object.freeze(refs);
}

// ===========================================================================
// Search
// ===========================================================================

/** A URI-backed search hit from the workspace index. */
export interface ContextFileCandidate {
  readonly kind: "file";
  readonly label: string;
  readonly detail: string;
  readonly uri: string;
  readonly revision?: string;
}

/** An editor-selection hit (at most one; the active editor). */
export interface ContextSelectionCandidate {
  readonly label: string;
  readonly detail: string;
  readonly uri: string;
  readonly lineRange: { readonly start: number; readonly end: number };
  readonly revision?: string;
}

/** A database-object hit from schema introspection (metadata only). */
export interface ContextObjectCandidate {
  readonly kind: "table" | "view" | "routine" | "schema";
  readonly label: string;
  readonly detail: string;
  readonly connectionId: string;
  readonly schema: string;
  readonly name: string;
  readonly revision?: string;
}

/** Search correlation carried by the webview and echoed by the host. */
export interface ContextSearchRequest {
  readonly requestId: string;
  readonly draftRevision: number;
  readonly query: string;
  readonly kindFilter: ContextKindFilter;
}

/** One search answer. `requestId`/`draftRevision` are echoed verbatim so the
 * webview can discard a stale response (PLAN §4). */
export interface ContextSearchResult {
  readonly requestId: string;
  readonly draftRevision: number;
  readonly query: string;
  readonly items: readonly ContextRef[];
}

/** Injected search sources. Pure data in, pure data out — no `vscode`. */
export interface ContextSearchDeps {
  /** Active connection id, or null when none is selected. */
  readonly connectionId: string | null;
  readonly listFiles: (
    query: string,
    limit: number,
  ) => Promise<readonly ContextFileCandidate[]>;
  readonly activeSelection: () => ContextSelectionCandidate | null;
  readonly listObjects: (
    query: string,
    limit: number,
  ) => Promise<readonly ContextObjectCandidate[]>;
  readonly now?: () => number;
  readonly fileLimit?: number;
  readonly objectLimit?: number;
}

/** Default per-source caps for one search answer. */
export const CONTEXT_SEARCH_FILE_LIMIT = 20;
export const CONTEXT_SEARCH_OBJECT_LIMIT = 30;

const EMPTY_QUERY = "";

/**
 * Case-insensitive filter over candidates. An empty query matches everything
 * (the empty `@` state groups Files / Selection / Database, per spec).
 */
export function matchesQuery(value: string, query: string): boolean {
  if (query === EMPTY_QUERY) return true;
  return value.toLowerCase().includes(query.toLowerCase());
}

function objectKindAllowed(kind: ContextRefKind, filter: ContextKindFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "file":
      return kind === "file";
    case "selection":
      return kind === "selection";
    case "database":
      return kind === "table" || kind === "view" || kind === "routine" || kind === "schema";
    default:
      return true;
  }
}

/**
 * Run one structured context search.
 *
 * SEARCH IS MODEL-FREE: this function only reads injected candidate lists. It
 * never calls an AI engine, and every failure of one source degrades to an
 * empty list for that source rather than failing the whole search.
 *
 * The active selection is offered first (it is the most specific intent) and
 * only when the query matches it — the empty `@` state groups it with the rest.
 */
export async function searchContext(
  deps: ContextSearchDeps,
  request: ContextSearchRequest,
): Promise<ContextSearchResult> {
  const fileLimit = deps.fileLimit ?? CONTEXT_SEARCH_FILE_LIMIT;
  const objectLimit = deps.objectLimit ?? CONTEXT_SEARCH_OBJECT_LIMIT;
  const candidates: ContextCandidate[] = [];

  // Selection first.
  if (objectKindAllowed("selection", request.kindFilter)) {
    const selection = deps.activeSelection();
    if (
      selection !== null &&
      (matchesQuery(selection.label, request.query) ||
        matchesQuery(selection.detail, request.query))
    ) {
      candidates.push({
        kind: "selection",
        label: selection.label,
        detail: selection.detail,
        source: { type: "uri", uri: selection.uri },
        revision: selection.revision,
        lineRange: selection.lineRange,
      });
    }
  }

  if (objectKindAllowed("file", request.kindFilter)) {
    try {
      for (const file of await deps.listFiles(request.query, fileLimit)) {
        if (!matchesQuery(file.label, request.query) && !matchesQuery(file.detail, request.query)) {
          continue;
        }
        candidates.push({
          kind: "file",
          label: file.label,
          detail: file.detail,
          source: { type: "uri", uri: file.uri },
          revision: file.revision,
        });
      }
    } catch {
      /* best-effort: a failing source contributes nothing */
    }
  }

  if (
    request.kindFilter === "all" ||
    request.kindFilter === "database"
  ) {
    try {
      for (const object of await deps.listObjects(request.query, objectLimit)) {
        if (
          !matchesQuery(object.label, request.query) &&
          !matchesQuery(object.detail, request.query)
        ) {
          continue;
        }
        candidates.push({
          kind: object.kind,
          label: object.label,
          detail: object.detail,
          source: {
            type: "object",
            connectionId: object.connectionId,
            schema: object.schema,
            name: object.name,
            objectKind: object.kind,
          },
          revision: object.revision,
        });
      }
    } catch {
      /* best-effort */
    }
  }

  return Object.freeze({
    requestId: request.requestId,
    draftRevision: request.draftRevision,
    query: request.query,
    items: buildContextRefs(candidates, deps.now !== undefined ? { now: deps.now } : {}),
  });
}

/**
 * A search response may be applied ONLY when the popover is still open on the
 * SAME request, the SAME draft revision and the SAME open generation. A late
 * answer from a previous open (or after Escape/removal) can never reopen it.
 */
export function isContextSearchResponseCurrent(
  open: {
    readonly requestId: string;
    readonly draftRevision: number;
    readonly generation: number;
  } | null,
  response: {
    readonly requestId: string;
    readonly draftRevision: number;
    readonly generation: number;
  },
): boolean {
  if (open === null) return false;
  return (
    open.requestId === response.requestId &&
    open.draftRevision === response.draftRevision &&
    open.generation === response.generation
  );
}

// ===========================================================================
// Resolution
// ===========================================================================

/** One re-validation answer for a single ref id. */
export interface ContextResolutionResult {
  readonly refId: string;
  readonly status: ContextRefStatus;
  readonly snapshot: ContextSnapshot;
  readonly label: string;
  readonly detail: string;
  readonly displayToken: string;
}

/** Injected probe surface. Returns a fingerprint or null — never content. */
export interface ContextProbe {
  /** Live fingerprint for a URI, or null when it no longer exists. */
  fileRevision(uri: string): Promise<string | null>;
  /** Live fingerprint for a DB object, or null when it no longer exists. */
  objectSignature(source: ContextSourceObject): Promise<string | null>;
  /** Permission policy: false makes every ref of this kind `forbidden`. */
  isPermitted(ref: ContextRef): boolean;
  readonly now?: () => number;
}

/** Re-validate ONE ref against the live workspace/database. Never throws:
 * a probe failure degrades to `missing` (safe: the user must choose). */
export async function resolveContextRef(
  probe: ContextProbe,
  ref: ContextRef,
): Promise<ContextResolutionResult> {
  const now = probe.now;
  const capturedAt = now !== undefined ? now() : null;

  const result = (status: ContextRefStatus, revision: string): ContextResolutionResult =>
    Object.freeze({
      refId: ref.id,
      status,
      snapshot: Object.freeze({ revision, capturedAt }),
      label: ref.label,
      detail: ref.detail,
      displayToken: ref.displayToken,
    });

  if (!probe.isPermitted(ref)) return result("forbidden", ref.snapshot.revision);

  let live: string | null = null;
  try {
    live =
      ref.source.type === "uri"
        ? await probe.fileRevision(ref.source.uri)
        : await probe.objectSignature(ref.source);
  } catch {
    live = null;
  }
  if (live === null) return result("missing", ref.snapshot.revision);
  if (ref.snapshot.revision.length > 0 && live !== ref.snapshot.revision) {
    return result("changed", live);
  }
  return result("ready", live);
}

/** Re-validate a whole draft, in order. */
export async function resolveContextRefs(
  probe: ContextProbe,
  refs: readonly ContextRef[],
): Promise<readonly ContextResolutionResult[]> {
  const out: ContextResolutionResult[] = [];
  for (const ref of refs) out.push(await resolveContextRef(probe, ref));
  return Object.freeze(out);
}

// ===========================================================================
// Structured turn context
// ===========================================================================

/** One entry the host sends alongside the visible text. Identity + snapshot
 * only — the model-facing body is produced by the normal turn path. */
export interface TurnContextEntry {
  readonly refId: string;
  readonly kind: ContextRefKind;
  readonly displayToken: string;
  readonly snapshotRevision: string;
  readonly status: ContextRefStatus;
  readonly source: ContextSource;
}

/** A blocked ref: its status demands an explicit user choice before sending. */
export interface BlockedContextEntry {
  readonly refId: string;
  readonly status: Exclude<ContextRefStatus, "ready">;
}

export interface StructuredTurnContext {
  readonly entries: readonly TurnContextEntry[];
  readonly blocked: readonly BlockedContextEntry[];
}

/**
 * Fold freshly-resolved statuses into the structured turn payload.
 *
 * - `entries` always carries EVERY ref (id + snapshot separately from the
 *   visible text), so nothing is silently dropped.
 * - `blocked` is non-empty when any ref is changed/missing/forbidden. The
 *   caller MUST NOT send until the user makes an explicit choice; the host
 *   re-validates and returns the same statuses.
 */
export function buildTurnContext(
  refs: readonly ContextRef[],
  resolutions: readonly ContextResolutionResult[],
): StructuredTurnContext {
  const byId = new Map(resolutions.map((r) => [r.refId, r]));
  const entries: TurnContextEntry[] = [];
  const blocked: BlockedContextEntry[] = [];
  for (const ref of refs) {
    const resolved = byId.get(ref.id);
    const status = resolved?.status ?? ref.status;
    entries.push({
      refId: ref.id,
      kind: ref.kind,
      displayToken: ref.displayToken,
      snapshotRevision: resolved?.snapshot.revision ?? ref.snapshot.revision,
      status,
      source: ref.source,
    });
    if (status !== "ready") blocked.push({ refId: ref.id, status });
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    blocked: Object.freeze(blocked),
  });
}

/**
 * Remove exactly ONE ref by id. Duplicate labels are irrelevant here: the id is
 * the identity, so removing `file:a/index.vue` never removes
 * `file:b/index.vue`.
 */
export function removeContextRef(
  refs: readonly ContextRef[],
  refId: string,
): readonly ContextRef[] {
  const next = refs.filter((ref) => ref.id !== refId);
  return next.length === refs.length ? refs : Object.freeze(next);
}

// ===========================================================================
// Resolution dialog choices
// ===========================================================================

/** One choice offered by the resolve dialog. */
export type ContextResolutionChoice = "refresh" | "keep" | "remove" | "send_without";

/** Which choices a status permits. `keep` is offered only when the policy
 * allows sending a stale snapshot; missing/forbidden never offer it. */
export function contextResolutionChoices(
  status: ContextRefStatus,
  policy: { readonly allowKeepSnapshot: boolean },
): readonly ContextResolutionChoice[] {
  switch (status) {
    case "changed": {
      const choices: ContextResolutionChoice[] = ["refresh"];
      if (policy.allowKeepSnapshot) choices.push("keep");
      choices.push("remove");
      return Object.freeze(choices);
    }
    case "missing":
    case "forbidden":
      // No ambiguous auto-drop and no "keep": the ref is gone or denied.
      return Object.freeze<ContextResolutionChoice[]>(["remove", "send_without"]);
    default:
      return Object.freeze([]);
  }
}

/** Apply a dialog choice to one ref. `null` means the ref is dropped from the
 * draft (remove / send-without). Never touches any other ref. */
export function applyResolutionChoice(
  ref: ContextRef,
  choice: ContextResolutionChoice,
  refreshed: ContextResolutionResult | null,
): ContextRef | null {
  switch (choice) {
    case "remove":
    case "send_without":
      return null;
    case "keep":
      return Object.freeze({ ...ref, status: "ready" });
    case "refresh": {
      if (refreshed === null) return ref;
      return Object.freeze({
        ...ref,
        status: refreshed.status,
        snapshot: refreshed.snapshot,
      });
    }
    default:
      return ref;
  }
}

// ===========================================================================
// Safe preview (model-free, content-free)
// ===========================================================================

/** A preview is METADATA ONLY: title, identity and labeled facts. It never
 * carries file text, row values or image bytes. */
export interface ContextPreview {
  readonly refId: string;
  readonly title: string;
  readonly detail: string;
  readonly status: ContextRefStatus;
  readonly lines: readonly string[];
  /** Always true — a preview has no governed data path. */
  readonly metadataOnly: true;
}

function selectionLabelFromToken(token: string): string {
  return token;
}

/**
 * Build a safe preview for a ref. Returns null when the ref declares no
 * preview capability (missing/forbidden). Pure and synchronous: a preview
 * NEVER triggers a host round trip and NEVER invokes an AI engine.
 */
export function previewContextRef(ref: ContextRef): ContextPreview | null {
  if (!ref.preview.supported) return null;
  const lines: string[] = [];
  const source = ref.source;
  if (source.type === "uri") {
    lines.push(`Path: ${ref.detail}`);
    if (ref.kind === "selection") {
      lines.push(`Range: ${selectionLabelFromToken(ref.displayToken)}`);
      lines.push("Snapshot: selection at capture time");
    } else {
      lines.push("Snapshot: file fingerprint only");
    }
  } else {
    lines.push(`Connection: ${source.connectionId}`);
    lines.push(`Object: ${source.schema}.${source.name}`);
    lines.push(`Type: ${OBJECT_LABELS[source.objectKind]}`);
    lines.push("Schema metadata only — data rows require a governed query.");
  }
  if (ref.snapshot.revision.length > 0) {
    lines.push(`Revision: ${ref.snapshot.revision}`);
  }
  return Object.freeze({
    refId: ref.id,
    title: ref.label,
    detail: ref.detail,
    status: ref.status,
    lines: Object.freeze(lines),
    metadataOnly: true,
  });
}

/** Human label for a status, used by chips and the resolve dialog. */
export function contextStatusLabel(status: ContextRefStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "changed":
      return "Changed since it was added";
    case "missing":
      return "No longer available";
    case "forbidden":
      return "Not permitted";
    default:
      return "Unknown";
  }
}
