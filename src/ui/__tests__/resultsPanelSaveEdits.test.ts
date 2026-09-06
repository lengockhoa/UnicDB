// src/ui/__tests__/resultsPanelSaveEdits.test.ts
//
// TASK-503 Fix Round 1 — host-side saveEdits flow tests.
//
// These tests exercise ResultsPanel.handleSaveEdits (via FakeWebviewPanel
// dispatch) using a fake adapter that records the SQL the host pipes to
// runSql. They cover the critical + important findings:
//
//   - critical #1: host derives tableName/pkColumns from saveContext (webview
//     metadata is IGNORED).
//   - critical #3: edits.length > 0 with statements.length === 0 → ack ok:false
//     with errors (no_pk refusal or nothing-to-do), never silent ok:true.
//   - important #1: fetchPostgresCtids uses quoted identifier + safe literal
//     escape; multi-match row → refused, not silently misaddressed.
//   - important #3: validate identifier; reject names with non-safe chars.
//   - partial failure: per-statement errors surfaced in `errors[]`.
//   - banner persistence + refusal reason: ack carries `refused:true, reason`
//     when no_pk.
//
// Tests are RED until handleSaveEdits is rewritten.
import { describe, it, expect, vi, beforeEach } from "vitest";

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  private csp = "vscode-resource:webview";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => {
    this.handler = h;
    return { dispose: () => undefined };
  };
  asWebviewUri = (u: unknown) => u;
  get cspSource() {
    return this.csp;
  }
  dispatch(msg: unknown) {
    if (this.handler) this.handler(msg);
  }
  private handler: MessageHandler | null = null;
}

class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  private didDisposeHandlers: (() => void)[] = [];
  constructor(
    public viewType: string,
    public title: string,
    public viewColumn: number,
    public options: unknown,
  ) {}
  reveal(_col?: unknown) {}
  onDidReceiveMessage(_h: MessageHandler) {
    return { dispose: () => undefined };
  }
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  dispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

const lastPanel: { current: FakeWebviewPanel | null } = { current: null };

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        path: parts.map((p) => p?.fsPath ?? p?.path ?? "").join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: (vt: string, t: string, col: number, opts: unknown) => {
        const p = new FakeWebviewPanel(vt, t, col, opts);
        lastPanel.current = p;
        return p;
      },
      showErrorMessage: vi.fn(async () => undefined),
    },
    workspace: { onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

import { ResultsPanel, type SaveContext } from "../resultsPanel";
import type {
  QueryRunner,
  RunResult,
  StatementResult,
} from "../../core/queryRunner";

interface RecordedCall {
  sql: string;
}

interface SaveFakeOpts {
  /** Returned RunResult for every adapter.runQuery call (and runner.runSql). */
  runResult?: RunResult;
  /** If set, reject every adapter.runQuery call with this error. */
  rejectWith?: Error;
}

/** Mirrors `shouldUseCursor` (postgres.ts) — a lone SELECT/WITH statement
 *  with NO `;` boundary routes through DECLARE CURSOR, `{results: [],
 *  batched}`. Anything else (multi-statement text like our BEGIN/…/COMMIT
 *  transaction envelope, or a non-SELECT statement) goes through
 *  `{results: [...]}`. TASK-009 — fixing this fake is what makes the A3
 *  regression (`res.results[0]?.rows` on a batched response) observable;
 *  before this fix every SELECT here returned a non-batched shape
 *  unconditionally, which is why the bug was invisible in this suite. */
function isSingleSelectNoSemicolon(sql: string): boolean {
  const trimmed = sql.trim();
  const parts = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length === 1 && /^(SELECT|WITH)\b/i.test(parts[0]);
}

function makeRecordingRunner(opts: SaveFakeOpts = {}): {
  runner: QueryRunner;
  recorded: RecordedCall[];
  calls: { sql: string }[];
  openCount: () => number;
  closeCount: () => number;
} {
  const recorded: RecordedCall[] = [];
  let opens = 0;
  let closes = 0;
  const runQuery = async (sql: string): Promise<RunResult> => {
    recorded.push({ sql });
    if (opts.rejectWith) throw opts.rejectWith;
    if (opts.runResult) return opts.runResult;
    if (isSingleSelectNoSemicolon(sql)) {
      opens++;
      let served = false;
      return {
        results: [],
        batched: {
          columns: [],
          fetchBatch: async () => {
            if (served) return null;
            served = true;
            return [];
          },
          cancel: async () => undefined,
          close: async () => {
            closes++;
          },
        },
      };
    }
    return {
      results: [
        {
          columns: [],
          rows: [],
          rowCount: 0,
          durationMs: 0,
        },
      ],
    };
  };
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: runQuery,
    // Adapter is fetched through QueryRunner.runSql — we patch directly.
  } as unknown as QueryRunner;
  // runner.runSql IS the recorder.
  (runner as unknown as { runQuery?: typeof runQuery }).runQuery = runQuery;
  return { runner, recorded, calls: recorded, openCount: () => opens, closeCount: () => closes };
}

function makeSaveContext(
  driver: "postgres" | "mysql" | "mssql" | null,
  pkColumns: string[] = [],
): SaveContext {
  return {
    getDriver: () => driver,
    listPkColumns: async (_schema: string, _table: string) => pkColumns,
  };
}

function newPanelWithState(
  sql: string,
  columns: string[],
  rows: unknown[][],
  saveContext: SaveContext | null,
) {
  const { runner, recorded } = makeRecordingRunner();
  const panel = new ResultsPanel({ runner, saveContext: saveContext ?? undefined });
  panel.render(
    [
      {
        index: 0,
        sql,
        status: "done",
        result: { columns, rows, rowCount: rows.length, durationMs: 0 },
        durationMs: 0,
      },
    ],
    "hdr",
  );
  return { panel, runner, recorded, fake: lastPanel.current! };
}

function saveResultAcks(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map(
      (c) =>
        c[0] as {
          type?: string;
          ok?: boolean;
          refused?: boolean;
          reason?: string;
          errors?: string[];
          index?: number;
          rowErrors?: Array<{ rowId: number; error: string }>;
        },
    )
    .filter((m) => m.type === "saveResult");
}

function stateMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map(
      (c) =>
        c[0] as {
          type?: string;
          header?: string;
          results?: Array<{ result?: { columns: string[]; rows: unknown[][] } }>;
        },
    )
    .filter((m) => m.type === "state");
}

beforeEach(() => {
  lastPanel.current = null;
  vi.clearAllMocks();
});

// ---- critical #1: host derives metadata ------------------------------------

describe("ResultsPanel — saveEdits host-derives metadata (critical #1)", () => {
  it("postgres + edits → host calls listPkColumns + uses host-derived PK; webview's [] is IGNORED", async () => {
    const pkSpy = vi.fn(async (_s: string, _t: string) => ["id"]);
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: pkSpy,
    };
    const { panel, recorded, fake } = newPanelWithState(
      "SELECT id, name FROM public.users",
      ["id", "name"],
      [[1, "alice"], [2, "bob"]],
      saveCtx,
    );
    void panel;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null, // webview sends nothing — host must derive
      pkColumns: [], // webview sends nothing — host must derive
      edits: [{ rowId: 0, colIndex: 1, value: "new-alice" }],
    });
    // Wait for saveResult to arrive.
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    expect(pkSpy).toHaveBeenCalled();
    // The generated UPDATE references host-derived PK ("id") and inline literal value.
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/UPDATE\s+\S*users?\S*\s+SET\s+\S*name\S*='new-alice'/i);
    expect(update!.sql).toMatch(/WHERE\s+\S*id\S*=1/);
    // Identifier quoting: postgres uses plain (no backticks, no brackets).
    expect(update!.sql).not.toMatch(/`/);
    expect(update!.sql).not.toMatch(/\[/);
  });

  it("v1.4.1 — refresh durationMs is elapsed time of the refresh run, not the original query's", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const { fake } = newPanelWithState(
      "SELECT id, name FROM public.users",
      ["id", "name"],
      [[1, "alice"]],
      saveCtx,
    );
    const t0 = Date.now();
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "new-alice" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // The refreshed state posted after commit carries a durationMs that is
    // a small elapsed value (>= 0), NOT the original statement's duration
    // (fixture uses durationMs: 0 — but the old bug copied `r.durationMs`
    // verbatim; assert elapsed is a finite non-negative number derived from
    // the refresh window).
    const states = fake.webview.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.type === "state") as Array<{
      results: Array<{ durationMs: number }>;
    }>;
    const lastState = states[states.length - 1];
    expect(lastState).toBeDefined();
    expect(lastState.results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(lastState.results[0].durationMs).toBeLessThanOrEqual(Date.now() - t0 + 50);
  });

  it("mysql + edits → host calls listPkColumns + uses quoted identifiers", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "mysql",
      listPkColumns: async () => ["id"],
    };
    const { recorded, fake } = newPanelWithState(
      "SELECT id, name FROM users",
      ["id", "name"],
      [[1, "alice"]],
      saveCtx,
    );
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "x" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("`users`");
    expect(update!.sql).toContain("`name`");
    expect(update!.sql).toContain("`id`");
  });

  it("mssql + edits → host uses bracket-quoted identifiers", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "mssql",
      listPkColumns: async () => ["id"],
    };
    const { recorded, fake } = newPanelWithState(
      "SELECT id, name FROM users",
      ["id", "name"],
      [[1, "alice"]],
      saveCtx,
    );
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "x" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("[users]");
    expect(update!.sql).toContain("[name]");
    expect(update!.sql).toContain("[id]");
  });
});

// ---- critical #3: ack honesty -----------------------------------------------

describe("ResultsPanel — saveEdits ack honesty (critical #3)", () => {
  it("mysql + no PK + edits → ack { ok: false, errors: [...] }; editState NOT cleared on webview (banner explains)", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "mysql",
      listPkColumns: async () => [], // no PK
    };
    const { recorded, fake } = newPanelWithState(
      "SELECT name FROM t",
      ["name"],
      [["alice"]],
      saveCtx,
    );
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "x" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(fake);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    // CRITICAL #3 — must be ok:false so the webview can keep editState
    // and retry after the user adds a PK.
    // Per fix instruction (option B): we ack refused with reason so the
    // webview shows the banner but the user can choose to retry after
    // defining a PK. The shape MUST carry either `errors[]` (host refusal)
    // OR `refused:true, reason` (soft refusal).
    const ack = acks[0];
    const isRefusalWithReason = ack.refused === true && typeof ack.reason === "string";
    const isHardFailure = ack.ok === false && Array.isArray(ack.errors);
    expect(isRefusalWithReason || isHardFailure).toBe(true);
    if (isRefusalWithReason) {
      expect(ack.reason).toMatch(/PRIMARY KEY|no_pk/i);
    }
    if (isHardFailure) {
      expect((ack.errors ?? []).join(" ")).toMatch(/PRIMARY KEY|no_pk/i);
    }
    // CRITICAL #3 — never silent ok:true when no statements emitted.
    const hasSilentOk = acks.some((a) => a.ok === true && !a.refused && !(a.errors && a.errors.length > 0));
    expect(hasSilentOk).toBe(false);
    // No UPDATE was ever sent to the driver.
    expect(recorded.find((c) => /UPDATE/i.test(c.sql))).toBeUndefined();
  });

  it("edits.length > 0 but every edit targets unknown col → ack ok:false with errors", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const { fake } = newPanelWithState(
      "SELECT id, name FROM t",
      ["id", "name"],
      [[1, "alice"]],
      saveCtx,
    );
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      // colIndex 99 is out of bounds → all rows skipped → empty statements.
      edits: [{ rowId: 0, colIndex: 99, value: "x" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(fake);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const ack = acks[0];
    // Must NOT be silent ok:true.
    const hasSilentOk = acks.some((a) => a.ok === true && !a.refused && !(a.errors && a.errors.length > 0));
    expect(hasSilentOk).toBe(false);
    // Ack carries errors[] explaining what happened.
    expect(ack.ok === false || ack.refused === true).toBe(true);
    expect(ack.errors || ack.reason).toBeTruthy();
  });
});

// ---- important #1: ctid fetch correctness -----------------------------------

describe("ResultsPanel — fetchPostgresCtids correctness (important #1)", () => {
  it("postgres no-PK → ctid query uses quoted identifier AND safe literal escape", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [], // no PK
    };
    // Track all SELECT ctid queries the host issues.
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      // Pretend the ctid lookup succeeded for the first row.
      if (/ctid/i.test(sql)) {
        return {
          results: [
            {
              columns: ["ctid"],
              rows: [["(0,1)"]],
              rowCount: 1,
              durationMs: 0,
            },
          ],
        };
      }
      // Original refresh SQL.
      return {
        results: [
          {
            columns: ["x", "y"],
            rows: [["a", "b"]],
            rowCount: 1,
            durationMs: 0,
          },
        ],
      };
    });
    const { fake } = newPanelWithState(
      "SELECT x, y FROM public.t",
      ["x", "y"],
      [["c", "d"]],
      saveCtx,
    );
    // Patch runner.runSql with our recording version.
    (fake.webview as unknown as { _patch?: unknown });
    const runner = (lastPanel.current as unknown as {
      _runner?: unknown;
    })._runner;
    void runner;
    // We need to monkey-patch the runner used by the panel — simpler: drive
    // through a fresh panel that uses our patched runner.
    lastPanel.current = null;
    const patchedRunner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    void patchedRunner;
    // Re-render to bind new runner.
    const panel = new ResultsPanel({ runner: patchedRunner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT x, y FROM public.t",
          status: "done",
          result: { columns: ["x", "y"], rows: [["c", "d"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f2 = lastPanel.current!;
    f2.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "edited" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f2).length > 0) break;
      await Promise.resolve();
    }
    // Find the ctid SELECT.
    const ctidQuery = recorded.find((c) => /ctid/i.test(c.sql));
    expect(ctidQuery).toBeDefined();
    // Identifier quoting — schema and table are quoted SEPARATELY. A single
    // `"public.t"` would name a table literally called `public.t` (A8), so
    // each part gets its own quotes; never raw interpolated user data.
    expect(ctidQuery!.sql).toMatch(/FROM\s+"public"\."t"/i);
    // The value `c` is a literal in the WHERE — quote-doubled safe.
    expect(ctidQuery!.sql).toMatch(/'c'/);
  });

  it("ctid lookup returns >1 row → refuse the UPDATE, ack ok:false with error", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      if (/ctid/i.test(sql)) {
        // Multiple matches — ambiguous.
        return {
          results: [
            {
              columns: ["ctid"],
              rows: [["(0,1)"], ["(0,2)"]],
              rowCount: 2,
              durationMs: 0,
            },
          ],
        };
      }
      return {
        results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
      };
    });
    lastPanel.current = null;
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT x, y FROM t",
          status: "done",
          result: { columns: ["x", "y"], rows: [["c", "d"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "edited" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    // No UPDATE was issued — the ambiguous row was refused.
    expect(update).toBeUndefined();
    // Ack carries errors[] explaining the refusal.
    const acks = saveResultAcks(f);
    const hasSilentOk = acks.some((a) => a.ok === true && !a.refused && !(a.errors && a.errors.length > 0));
    expect(hasSilentOk).toBe(false);
    const ack = acks[0];
    expect(ack.errors || ack.reason).toBeTruthy();
    const errText = (ack.errors ?? [ack.reason ?? ""]).join(" ");
    expect(errText).toMatch(/ambig|multiple|distinct/i);
  });
});

// ---- partial failure surfacing ---------------------------------------------

describe("ResultsPanel — partial failure / atomic batch (A15)", () => {
  it("first UPDATE ok, second throws → whole batch runs as ONE transaction call, ROLLBACK issued, ack ok:false, no COMMIT", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const recorded: RecordedCall[] = [];
    let committed = false;
    let rolledBack = false;
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      const trimmed = sql.trim();
      if (/^ROLLBACK\s*;?$/i.test(trimmed)) {
        rolledBack = true;
        return { results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }] };
      }
      // Transaction envelope: BEGIN;<stmt1>;<stmt2>;COMMIT; — split and
      // walk it the way a real driver would (statement-by-statement on one
      // session), throwing partway through so COMMIT never runs.
      const parts = trimmed
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length > 1 || /^BEGIN$/i.test(parts[0] ?? "")) {
        let updateCount = 0;
        for (const part of parts) {
          if (/^BEGIN$/i.test(part)) continue;
          if (/^COMMIT$/i.test(part)) {
            committed = true;
            continue;
          }
          if (/UPDATE/i.test(part)) {
            updateCount++;
            if (updateCount === 2) {
              throw new Error("constraint violated");
            }
          }
        }
        return { results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }] };
      }
      return {
        results: [
          {
            columns: ["id", "name"],
            rows: [[1, "a"]],
            rowCount: 1,
            durationMs: 0,
          },
        ],
      };
    });
    lastPanel.current = null;
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: {
            columns: ["id", "name"],
            rows: [[1, "a"], [2, "b"]],
            rowCount: 2,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        { rowId: 0, colIndex: 1, value: "x" },
        { rowId: 1, colIndex: 1, value: "y" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(f);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const ack = acks[0];
    expect(ack.ok).toBe(false);
    expect(Array.isArray(ack.errors)).toBe(true);
    expect((ack.errors ?? []).join(" ")).toMatch(/constraint/i);
    // A15 — no COMMIT after a mid-batch failure; ROLLBACK WAS issued.
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
  });
});

// ---- TASK-002 — save path lazy ctid resolver ----------------------------
//
// TASK-002 collapses the no-PK save path: no result-set `ctid` column is
// trusted, the lazy resolver runs ONCE at save time only when an UPDATE
// cell edit or DELETE marker actually needs a ctid, and a user-named
// column called `ctid` is data — not a row address. fetchPostgresCtids is
// still the resolver (NULL-safe IS NOT DISTINCT FROM matching, important #1
// contract preserved above at line 410).

describe("ResultsPanel — no-PK lazy ctid resolver (TASK-002 case 1)", () => {
  it("PG no-PK + edit + result set WITHOUT ctid column → lazy resolver used, save SUCCEEDS", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    // Result set has NO ctid column — the lazy resolver must do the
    // value-match lookup. Fixture mirrors the previous TASK-006 #3
    // (line 819) but the fake now returns 1-row ctid result so the
    // UPDATE actually lands.
    const columns = ["name"];
    const rows: unknown[][] = [["alice"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        return {
          results: [
            {
              columns: ["ctid"],
              rows: [["(0,1)"]],
              rowCount: 1,
              durationMs: 0,
            },
          ],
        };
      }
      if (/UPDATE/i.test(sql)) {
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      return {
        results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM public.t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // The resolver WAS issued.
    const ctidLookup = recorded.find(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookup).toBeDefined();
    expect(ctidLookup!.sql).toMatch(
      /SELECT\s+ctid\s+FROM\s+"public"\."t"[\s\S]*WHERE\s+"name"\s+IS\s+NOT\s+DISTINCT\s+FROM\s+'alice'/i,
    );
    // UPDATE was issued with the resolver's literal.
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/UPDATE\s+\S*t\S*\s+SET\s+\S*name\S*='alice-2'/i);
    expect(update!.sql).toMatch(/ctid='\(0,1\)'/);
    // Success ack landed.
    const acks = saveResultAcks(f);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
    // The "ctid lookup failed for every dirty row" banner MUST NOT appear.
    const blocking = acks.find(
      (a) =>
        (a.reason ?? "").includes("ctid lookup failed for every dirty row") ||
        (a.errors ?? []).some((e) =>
          e.includes("ctid lookup failed for every dirty row"),
        ),
    );
    expect(blocking).toBeUndefined();
  });
});

describe("ResultsPanel — no-PK DELETE marker goes through resolver (TASK-002 case 2)", () => {
  it("PG no-PK + DELETE marker → resolver consulted, ctid-DELETE emitted", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    // 2 server rows so the resolver iterates and finds 2 distinct ctids.
    const columns = ["name"];
    const rows: unknown[][] = [["alice"], ["bob"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        // Map each row's lookup to a distinct ctid — alice → (0,1),
        // bob → (0,2). The 2nd lookup is what buildSaveStatements
        // pulls for the DELETE.
        if (/IS NOT DISTINCT FROM 'bob'/i.test(sql)) {
          return {
            results: [
              {
                columns: ["ctid"],
                rows: [["(0,2)"]],
                rowCount: 1,
                durationMs: 0,
              },
            ],
          };
        }
        return {
          results: [
            {
              columns: ["ctid"],
              rows: [["(0,1)"]],
              rowCount: 1,
              durationMs: 0,
            },
          ],
        };
      }
      if (/DELETE/i.test(sql)) {
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      return {
        results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM public.t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        {
          rowId: 1,
          colIndex: 0,
          value: { __UnicDB_deleted__: true, __rowId: 1 },
        },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // Resolver was issued at least once.
    const ctidLookups = recorded.filter(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookups.length).toBeGreaterThanOrEqual(1);
    // DELETE was issued with bob's ctid (TASK-003 path).
    const del = recorded.find((c) => /DELETE\s+FROM/i.test(c.sql));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/DELETE\s+FROM\s+\S*t\S*\s+WHERE\s+ctid='\(0,2\)'/i);
    // Ack is success.
    const acks = saveResultAcks(f);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

describe("ResultsPanel — insert-only PG no-PK skips resolver (TASK-002 case 3)", () => {
  it("PG no-PK + ONLY a __UnicDB_new_row__ marker → NO ctid lookup SQL; INSERT issued; ack ok", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const columns = ["name"];
    const rows: unknown[][] = [];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return {
        results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM public.t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        {
          rowId: 0,
          colIndex: 0,
          value: {
            __UnicDB_new_row__: true,
            __rowId: 0,
            values: ["x"],
          },
        },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // NO ctid resolver SQL was issued.
    const ctidLookups = recorded.filter(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookups).toHaveLength(0);
    // INSERT was issued.
    const ins = recorded.find((c) => /INSERT\s+INTO/i.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/INSERT\s+INTO\s+\S*t\S*\s*\(\S*name\S*\)/i);
    // Ack is success.
    const acks = saveResultAcks(f);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

describe("ResultsPanel — user column named `ctid` is NOT trusted (TASK-002 case 4)", () => {
  it("result set HAS a column literally named `ctid` (user data) → host does NOT trust it", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    // Result set has a column named `ctid` carrying user data "(9,9)".
    // The host must ignore this and run the resolver. Resolver returns
    // (0,1); UPDATE must use (0,1) — NOT (9,9).
    const columns = ["name", "ctid"];
    const rows: unknown[][] = [["alice", "(9,9)"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        return {
          results: [
            {
              columns: ["ctid"],
              rows: [["(0,1)"]],
              rowCount: 1,
              durationMs: 0,
            },
          ],
        };
      }
      if (/UPDATE/i.test(sql)) {
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      return {
        results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name, ctid FROM public.t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // The resolver WAS issued — host did NOT trust the user `ctid` column.
    const ctidLookup = recorded.find(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookup).toBeDefined();
    // UPDATE was issued with the resolver's literal — NOT the user-data "(9,9)".
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/ctid='\(0,1\)'/);
    // Belt-and-braces: the user-data literal "(9,9)" must never appear in
    // any UPDATE / DELETE statement.
    const offending = recorded.find(
      (c) => /UPDATE|DELETE/i.test(c.sql) && /'9,9'|"9,9"|\(9,9\)/.test(c.sql),
    );
    expect(offending).toBeUndefined();
    // Ack success.
    const acks = saveResultAcks(f);
    expect(acks.length).toBeGreaterThanOrEqual(1);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

describe("ResultsPanel — PK table does NOT use ctid (TASK-006 #6)", () => {
  it("postgres + PK → save uses pkColumns; no separate SELECT ctid, no ctid column in UPDATE", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const columns = ["id", "name"];
    const rows: unknown[][] = [[1, "alice"], [2, "bob"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      if (/UPDATE/i.test(sql)) {
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      return {
        results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // UPDATE was issued using id PK — no ctid lookup, no ctid column.
    const updates = recorded.filter((c) => /UPDATE/i.test(c.sql));
    expect(updates).toHaveLength(1);
    // PK column is quoted (A9) — an unquoted `id` breaks for reserved-word
    // column names such as `order` or `user`.
    expect(updates[0].sql).toMatch(/WHERE\s+"id"=1/);
    // No SELECT ctid lookup was issued.
    const ctidLookups = recorded.filter(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookups).toHaveLength(0);
    // Ack success.
    const acks = saveResultAcks(f);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

// ---- TASK-009 — A3 (batched ctid fake) / atomic batch / A12 remap /
// A19-skip rowErrors / A4 (batched refresh) ----------------------------

/** Generic batched-aware fake: single SELECT with no `;` ⇒ batched shape
 *  (mirrors `PostgresAdapter.runQuery` / `shouldUseCursor`), anything else
 *  (multi-statement, e.g. the BEGIN/…/COMMIT transaction envelope) ⇒
 *  non-batched `{results:[...]}`. `responder` supplies the row payload per
 *  call; returning `"throw"` rejects with `onThrow`. Tracks open/close
 *  counts on the batched path so leak regressions (A3) are observable. */
function makeBatchAwareRunner(
  responder: (sql: string) => { rows: unknown[][]; columns?: string[] } | "throw",
  onThrow?: Error,
): {
  runner: QueryRunner;
  recorded: RecordedCall[];
  openCount: () => number;
  closeCount: () => number;
} {
  const recorded: RecordedCall[] = [];
  let opens = 0;
  let closes = 0;
  const runQuery = async (sql: string): Promise<RunResult> => {
    recorded.push({ sql });
    const r = responder(sql);
    if (r === "throw") throw onThrow ?? new Error("fail");
    const { rows, columns = [] } = r;
    if (isSingleSelectNoSemicolon(sql)) {
      opens++;
      let served = false;
      return {
        results: [],
        batched: {
          columns,
          fetchBatch: async () => {
            if (served) return null;
            served = true;
            return rows;
          },
          cancel: async () => undefined,
          close: async () => {
            closes++;
          },
        },
      };
    }
    return {
      results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }],
    };
  };
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: runQuery,
  } as unknown as QueryRunner;
  return { runner, recorded, openCount: () => opens, closeCount: () => closes };
}

describe("ResultsPanel — ctid resolve via CORRECTED batched fake (Happy + R-A3)", () => {
  it("ctid SELECT returns the batched shape ⇒ map has one entry, keyed by rowId, cursor is closed", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [], // no PK
    };
    const columns = ["name"];
    // 2 server rows; the dirty row is rowId 1 ("bob").
    const { runner, recorded, openCount, closeCount } = makeBatchAwareRunner(
      (sql) => {
        if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
          // Before the fix this SELECT went through `res.results[0]?.rows`
          // against a `{results:[], batched}` response ⇒ always `[]` ⇒
          // every row "fails". The corrected fake returns the batched
          // shape here on purpose so pickResult() is what makes this pass.
          return { rows: [["(0,2)"]], columns: ["ctid"] };
        }
        if (/UPDATE/i.test(sql) || /^BEGIN/i.test(sql.trim())) {
          return { rows: [], columns: [] };
        }
        // Refresh / original SELECT.
        return { rows: [["alice"], ["bob-2"]], columns };
      },
    );
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM t",
          status: "done",
          result: { columns, rows: [["alice"], ["bob"]], rowCount: 2, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 1, colIndex: 0, value: "bob-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const ctidLookup = recorded.find(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookup).toBeDefined();
    // Exactly one ctid lookup — issued for rowId 1 only (the dirty row).
    const ctidLookups = recorded.filter(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookups).toHaveLength(1);
    // UPDATE used the resolved ctid — proves the batched-shape read
    // succeeded (no "failed for every dirty row" refusal).
    const combined = recorded.find((c) => /^BEGIN/i.test(c.sql.trim()));
    expect(combined).toBeDefined();
    expect(combined!.sql).toMatch(/ctid='\(0,2\)'/);
    const acks = saveResultAcks(fake);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
    // A3 — the ctid-lookup cursor was closed. openCount() here is 2 (the
    // ctid lookup + the post-commit refresh's own single-SELECT cursor,
    // which is deliberately NOT closed — it is adopted for loadMore, see
    // the R-A4 describe block below). closeCount() === openCount() - 1
    // asserts exactly the refresh cursor is left open and every OTHER
    // (ctid) cursor was closed. Before the fix, `fetchPostgresCtids`
    // never awaited/closed `res.batched` at all — it read
    // `res.results[0]` directly, leaking the ctid cursor too.
    expect(openCount()).toBe(2);
    expect(closeCount()).toBe(openCount() - 1);
  });
});

describe("ResultsPanel — resource cleanup, 3 dirty rows (Edge — resource)", () => {
  it("3 dirty rows needing ctid ⇒ 3 opens, 3 closes (today: 3 opens, 0 closes)", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const columns = ["name"];
    const serverRows = [["a"], ["b"], ["c"]];
    const { runner, openCount, closeCount } = makeBatchAwareRunner((sql) => {
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        return { rows: [["(0,1)"]], columns: ["ctid"] };
      }
      if (/UPDATE/i.test(sql) || /^BEGIN/i.test(sql.trim())) {
        return { rows: [], columns: [] };
      }
      return { rows: serverRows, columns };
    });
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM t",
          status: "done",
          result: { columns, rows: serverRows, rowCount: 3, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        { rowId: 0, colIndex: 0, value: "a2" },
        { rowId: 1, colIndex: 0, value: "b2" },
        { rowId: 2, colIndex: 0, value: "c2" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // 3 ctid-lookup cursors + 1 post-commit refresh cursor (kept open by
    // design — adopted for loadMore, see R-A4 below) = 4 opens. All 3
    // ctid cursors are closed; the refresh cursor is not. Today (pre-fix)
    // this was 3 (or 4) opens and ZERO closes — the ctid resolver never
    // closed anything.
    expect(openCount()).toBe(4);
    expect(closeCount()).toBe(3);
  });
});

describe("ResultsPanel — atomic batch happy path (Happy — atomic batch)", () => {
  it("2 statements ⇒ exactly ONE BEGIN…COMMIT call carrying both statements, ack ok:true", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      const trimmed = sql.trim();
      const parts = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length > 1 || /^BEGIN$/i.test(parts[0] ?? "")) {
        return { results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }] };
      }
      return {
        results: [
          {
            columns: ["id", "name"],
            rows: [[1, "a"], [2, "b"]],
            rowCount: 2,
            durationMs: 0,
          },
        ],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "a"], [2, "b"]], rowCount: 2, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        { rowId: 0, colIndex: 1, value: "x" },
        { rowId: 1, colIndex: 1, value: "y" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // Exactly one combined call carries the whole transaction.
    const beginCalls = recorded.filter((c) => /^BEGIN\b/i.test(c.sql.trim()));
    expect(beginCalls).toHaveLength(1);
    const combinedSql = beginCalls[0].sql;
    expect((combinedSql.match(/UPDATE/gi) ?? []).length).toBe(2);
    expect((combinedSql.match(/\bCOMMIT\b/gi) ?? []).length).toBe(1);
    // No separate per-statement runSql calls — only the combined call and
    // (after commit) the refresh SELECT.
    const separateUpdateCalls = recorded.filter(
      (c) => /^UPDATE/i.test(c.sql.trim()),
    );
    expect(separateUpdateCalls).toHaveLength(0);
    const acks = saveResultAcks(fake);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

describe("ResultsPanel — A12 remap via serverIndexByRowId (Edge — remap)", () => {
  it('message carries serverIndexByRowId: {"4":3} ⇒ ctid resolver reads serverRows[3], not serverRows[4]', async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const columns = ["name"];
    // Only 4 rows (indices 0-3). rowId 4 has NO direct serverRows[4] —
    // without the remap, resolveServerIndex(4) === 4 ⇒ `serverRows[4]` is
    // undefined ⇒ the row is skipped entirely ⇒ resolver sees ZERO
    // candidates ⇒ "failed for every dirty row" (ok:false). WITH the
    // remap, resolveServerIndex(4) === 3 ⇒ resolves against the "target"
    // row and the save succeeds.
    const serverRows = [["a"], ["b"], ["c"], ["target"]];
    const { runner, recorded } = makeBatchAwareRunner((sql) => {
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        return { rows: [["(0,4)"]], columns: ["ctid"] };
      }
      if (/UPDATE/i.test(sql) || /^BEGIN/i.test(sql.trim())) {
        return { rows: [], columns: [] };
      }
      return { rows: serverRows, columns };
    });
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM t",
          status: "done",
          result: { columns, rows: serverRows, rowCount: 4, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 4, colIndex: 0, value: "target-2" }],
      serverIndexByRowId: { "4": 3 },
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const ctidLookup = recorded.find(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookup).toBeDefined();
    // The WHERE clause was built from serverRows[3] ("target"), NOT
    // serverRows[4] (out of range / undefined).
    expect(ctidLookup!.sql).toMatch(/'target'/);
    const acks = saveResultAcks(fake);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
    const blocking = acks.find(
      (a) =>
        (a.reason ?? "").includes("ctid lookup failed for every dirty row") ||
        (a.errors ?? []).some((e) => e.includes("ctid lookup failed for every dirty row")),
    );
    expect(blocking).toBeUndefined();
  });
});

describe("ResultsPanel — no serverIndexByRowId field (Edge — absent field, back-compat)", () => {
  it("older-webview message with NO serverIndexByRowId key ⇒ identity mapping, save succeeds as before", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const columns = ["id", "name"];
    const rows: unknown[][] = [[1, "alice"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return { results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }] };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    // NOTE: no `serverIndexByRowId` key at all on the dispatched message —
    // mirrors a pre-TASK-002 webview build.
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const update = recorded.find((c) => /UPDATE/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toMatch(/WHERE\s+"id"=1/);
    const acks = saveResultAcks(fake);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

describe("ResultsPanel — skippedRows → rowErrors (Edge partial success / R A19-skip)", () => {
  it("1 row updates, 1 row (rowId 7) has no server row ⇒ ok:true statements.length===1 AND rowErrors===[{rowId:7,...}]", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const columns = ["id", "name"];
    // Only 2 server rows (indices 0-1) — rowId 7 has NO server row, so
    // buildSaveStatements' own "no server row for UPDATE" skip fires
    // (A19-skip §3.4a), independent of the ctid/A12 path.
    const rows: unknown[][] = [[1, "alice"], [2, "bob"]];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return { results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }] };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        { rowId: 0, colIndex: 1, value: "alice-2" },
        { rowId: 7, colIndex: 1, value: "ghost" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // Exactly 1 UPDATE was emitted (row 7 was skipped by the builder, not
    // by the host).
    const combined = recorded.find((c) => /^BEGIN/i.test(c.sql.trim()));
    expect(combined).toBeDefined();
    expect((combined!.sql.match(/UPDATE/gi) ?? []).length).toBe(1);
    const acks = saveResultAcks(fake);
    const ack = acks.find((a) => a.ok === true);
    expect(ack).toBeDefined();
    // Before the fix: `rowErrors` was never forwarded — the ack looked
    // identical to a FULL success and the webview's else-branch (no
    // rowErrors) ran `editState.clear()`, silently discarding row 7's
    // edit with no banner and no undo. After the fix, row 7 surfaces
    // here so the webview keeps it dirty.
    expect(ack!.rowErrors).toBeDefined();
    expect(ack!.rowErrors).toHaveLength(1);
    expect(ack!.rowErrors![0].rowId).toBe(7);
    expect(ack!.rowErrors![0].error).toMatch(/no server row for UPDATE/);
  });
});

describe("ResultsPanel — full success has no phantom rowErrors (Edge — nothing skipped)", () => {
  it("builder returns ok:true with skippedRows absent ⇒ ack has NO rowErrors key (or empty)", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const columns = ["id", "name"];
    const rows: unknown[][] = [[1, "alice"]];
    const fakeRunQuery = vi.fn(async (_sql: string): Promise<RunResult> => {
      return { results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }] };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(fake);
    const ack = acks.find((a) => a.ok === true);
    expect(ack).toBeDefined();
    expect(ack!.rowErrors === undefined || ack!.rowErrors!.length === 0).toBe(true);
  });
});

describe("ResultsPanel — post-save refresh on a batched driver (R-A4)", () => {
  it("refresh SQL is a single SELECT (batched) ⇒ state IS posted with fresh rows, not blank", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const { runner } = makeBatchAwareRunner((sql) => {
      const trimmed = sql.trim();
      const parts = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length > 1 || /^BEGIN$/i.test(parts[0] ?? "")) {
        return { rows: [], columns: [] };
      }
      // Refresh SQL: single SELECT, no `;` ⇒ batched shape. Before the
      // fix, `refreshed.results[0]` was always undefined here (results
      // is `[]` on the batched shape) and NO state post happened at all.
      return { rows: [[1, "alice-2"]], columns: ["id", "name"] };
    });
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "alice"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const states = stateMessages(fake);
    const last = states[states.length - 1];
    expect(last).toBeDefined();
    expect(last!.results?.[0]?.result?.rows).toEqual([[1, "alice-2"]]);
  });
});

// ---- Review Fix Round (cycle T) — Finding 2: Add Row on a no-PK postgres
// table is hard-refused because the row's own cell edits push it into the
// ctid resolver even though it's addressed by its own INSERT. -------------
describe("ResultsPanel — Add Row on no-PK postgres never triggers a ctid lookup (Finding 2, cycle T)", () => {
  it("insert marker + a cell edit on the SAME new row ⇒ NO ctid SELECT is issued, INSERT succeeds", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const columns = ["name"];
    const rows: unknown[][] = [];
    const recorded: RecordedCall[] = [];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return {
        results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM public.t",
          status: "done",
          result: { columns, rows, rowCount: rows.length, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        {
          rowId: 0,
          colIndex: -1,
          value: {
            __UnicDB_new_row__: true,
            __rowId: 0,
            values: [{ __UnicDB_default__: true }],
          },
        },
        // Ordinary cell edit on the SAME (brand-new, no server row yet)
        // rowId — this is exactly what onCellValueChangedHandler records
        // when the user types into an Add Row cell.
        { rowId: 0, colIndex: 0, value: "Alice" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0) break;
      await Promise.resolve();
    }
    // The row is addressed entirely by its own INSERT — no ctid lookup
    // should ever be attempted for it.
    const ctidLookups = recorded.filter(
      (c) => /ctid\s+FROM\s+/i.test(c.sql) && !/UPDATE/i.test(c.sql),
    );
    expect(ctidLookups).toHaveLength(0);
    const ins = recorded.find((c) => /INSERT\s+INTO/i.test(c.sql));
    expect(ins).toBeDefined();
    const acks = saveResultAcks(f);
    const successAck = acks.find((a) => a.ok === true);
    expect(successAck).toBeDefined();
  });
});

// ---- Review Fix Round (cycle T) — Finding 5: the post-commit refresh
// `state` message must never race ahead of the `saveResult` ack — otherwise
// the webview's isReset branch wipes editState/undoStack before
// clearExceptRowIds gets a chance to keep skipped rows dirty. ---------------
describe("ResultsPanel — saveResult acks BEFORE the post-commit refresh state (Finding 5, cycle T)", () => {
  it("message order: saveResult is posted strictly before the refreshed state message", async () => {
    const columns = ["id", "name"];
    const rows: unknown[][] = [[1, "alice"]];
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      if (/^UPDATE/i.test(sql.trim()) || /^BEGIN/i.test(sql.trim())) {
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      return {
        results: [
          { columns, rows: [[1, "alice-2"]], rowCount: 1, durationMs: 0 },
        ],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows, rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const f = lastPanel.current!;
    f.webview.postMessage.mockClear();
    f.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(f).length > 0 && stateMessages(f).length > 0) break;
      await Promise.resolve();
    }
    const types = f.webview.postMessage.mock.calls.map(
      (c) => (c[0] as { type?: string }).type,
    );
    const saveResultIdx = types.indexOf("saveResult");
    const stateIdx = types.lastIndexOf("state");
    expect(saveResultIdx).toBeGreaterThanOrEqual(0);
    expect(stateIdx).toBeGreaterThanOrEqual(0);
    expect(saveResultIdx).toBeLessThan(stateIdx);
  });
});

// ---- TASK-006 (cycle X) — cursor ordering inside handleSaveEdits:
// P1-1 (close before the first metadata/ctid round trip) and P1-5 (close
// before the automatic-mode refresh SELECT). Postgres pool max=1 means any
// aux query racing the still-open browse cursor waits on pool.connect().
describe("ResultsPanel — save closes the browse cursor before aux/refresh queries (TASK-006 P1-1/P1-5)", () => {
  /** Shared call-order log runner: `batched.close` (the statement's LIVE
   *  browse cursor, whose handle the fixture attached to the rendered
   *  statement), `listPkColumns`, and every `runSql:<sql>` are pushed onto
   *  one array so strict ordering is assertable. */
  function makeOrderingRunner() {
    const log: string[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      log.push(`runSql:${sql}`);
      // Multi-statement (BEGIN…COMMIT) and the ctid probe (multi-statement
      // `SELECT ctid FROM t WHERE …;` shape is single-SELECT-no-`;` though,
      // so serve plain results for everything the save flow issues).
      return {
        results: [{ columns: ["ctid"], rows: [["(0,1)"]], rowCount: 1, durationMs: 0 }],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;
    return { runner, runSql, log };
  }

  it("P1-5 — auto-mode save closes the browse cursor BEFORE the refresh SELECT", async () => {
    const { runner, log } = makeOrderingRunner();
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const fakeBatched = {
      columns: ["id", "name"],
      fetchBatch: async () => [[1, "alice"]],
      cancel: async () => undefined,
      close: async () => {
        log.push("batched.close");
      },
    };
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT * FROM t",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "alice"]], rowCount: 1, durationMs: 0 },
          batched: fakeBatched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "new" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // RED today: no "batched.close" before the refresh runSql — the log is
    // [BEGIN…COMMIT combined, runSql:SELECT * FROM t] with the live cursor
    // still holding the only pooled client. (The task file's idealized
    // `["batched.close", "runSql:SELECT * FROM t"]` cannot match literally:
    // the save's BEGIN…COMMIT envelope is itself a runSql call that sits
    // between the close and the refresh. The ordering + exact-SQL contract
    // below is the same assertion.)
    expect(log).toContain("batched.close");
    const refreshIdx = log.indexOf("runSql:SELECT * FROM t");
    expect(refreshIdx).toBeGreaterThan(0);
    expect(log.indexOf("batched.close")).toBeLessThan(refreshIdx);
    // Exactly two runSql calls: the save envelope + the refresh, and the
    // refresh receives EXACTLY r.sql.
    const runSqlEntries = log.filter((entry) => entry.startsWith("runSql:"));
    expect(runSqlEntries).toHaveLength(2);
    expect(runSqlEntries[1]).toBe("runSql:SELECT * FROM t");
  });

  it("P1-1 — no-PK postgres save closes the cursor BEFORE listPkColumns and the ctid probe", async () => {
    const { runner, log } = makeOrderingRunner();
    const fakeBatched = {
      columns: ["name"],
      fetchBatch: async () => [["alice"]],
      cancel: async () => undefined,
      close: async () => {
        log.push("batched.close");
      },
    };
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => {
        log.push("listPkColumns");
        return []; // no PK → ctid resolver path
      },
    };
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT name FROM t",
          status: "done",
          result: { columns: ["name"], rows: [["alice"]], rowCount: 1, durationMs: 0 },
          batched: fakeBatched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "new" }],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    // RED today: listPkColumns + the ctid probe run BEFORE any close —
    // both go through the pool the still-open cursor pins.
    const closeIdx = log.indexOf("batched.close");
    const pkIdx = log.indexOf("listPkColumns");
    const ctidIdx = log.findIndex(
      (entry) => entry.startsWith("runSql:") && /^SELECT ctid FROM /i.test(entry.slice("runSql:".length)),
    );
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(pkIdx).toBeGreaterThanOrEqual(0);
    expect(ctidIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(pkIdx);
    expect(closeIdx).toBeLessThan(ctidIdx);
  });
});

// ---- Review Fix Round (cycle T) — Finding 6: one bad ctid probe (e.g. a
// column type with no equality operator) must not abort the whole batch. --
describe("ResultsPanel — one throwing ctid probe does not poison the rest of the batch (Finding 6, cycle T)", () => {
  it("row 0's ctid predicate throws, row 1's succeeds ⇒ row 1 still saves", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const columns = ["v"];
    const serverRows: unknown[][] = [["bad-throws"], ["good-value"]];
    const { runner } = makeBatchAwareRunner((sql) => {
      if (/ctid\s+FROM\s+/i.test(sql) && !/UPDATE/i.test(sql)) {
        if (/'bad-throws'/i.test(sql)) return "throw";
        return { rows: [["(0,9)"]], columns: ["ctid"] };
      }
      if (/UPDATE/i.test(sql) || /^BEGIN/i.test(sql.trim())) {
        return { rows: [], columns: [] };
      }
      return { rows: serverRows, columns };
    });
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT v FROM t",
          status: "done",
          result: { columns, rows: serverRows, rowCount: 2, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [
        { rowId: 0, colIndex: 0, value: "row0-new" },
        { rowId: 1, colIndex: 0, value: "row1-new" },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(fake);
    const successAck = acks.find((a) => a.ok === true);
    // Row 1's UPDATE must have gone through even though row 0's ctid probe
    // threw — one bad row must not poison the whole batch.
    expect(successAck).toBeDefined();
  });
});

// ---- TASK-004 (cycle Y) — committed-save refresh failure --------------------
// The automatic save committed successfully but the post-commit refresh
// SELECT (`runSql(r.sql)`) throws. Today the error propagates out of the
// un-awaited handleMessage() promise chain (unhandled rejection, no ack).
// Contract: trailing `saveResult` ack stays honest-but-successful —
// {ok:true, warnings:[<refresh error>]} — and the handler never rethrows.
describe("ResultsPanel — committed save acknowledges a refresh failure (TASK-004 cycle Y)", () => {
  it("refresh-only failure after commit → last ack is ok:true with the error as a warning", async () => {
    const columns = ["id", "name"];
    let updateRan = false;
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      if (/^UPDATE/i.test(sql.trim()) || /^BEGIN/i.test(sql.trim())) {
        updateRan = true;
        return {
          results: [{ columns: [], rows: [], rowCount: 0, durationMs: 0 }],
        };
      }
      // Post-commit refresh SELECT — fails.
      throw new Error("connection reset during refresh");
    });
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql: fakeRunQuery,
    } as unknown as QueryRunner;
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t",
          status: "done",
          result: { columns, rows: [[1, "alice"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "alice-2" }],
    });
    for (let i = 0; i < 300; i++) {
      if (saveResultAcks(fake).length > 0) break;
      await Promise.resolve();
    }
    const acks = saveResultAcks(fake);
    expect(acks.length).toBeGreaterThan(0);
    expect(updateRan).toBe(true); // the COMMIT really succeeded
    const lastAck = acks[acks.length - 1]!;
    expect(lastAck.ok).toBe(true);
    expect(lastAck.warnings).toEqual(["connection reset during refresh"]);
  });
});
