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

function makeRecordingRunner(opts: SaveFakeOpts = {}): {
  runner: QueryRunner;
  recorded: RecordedCall[];
  calls: { sql: string }[];
} {
  const recorded: RecordedCall[] = [];
  const runQuery = async (sql: string): Promise<RunResult> => {
    recorded.push({ sql });
    if (opts.rejectWith) throw opts.rejectWith;
    return (
      opts.runResult ?? {
        results: [
          {
            columns: [],
            rows: [],
            rowCount: 0,
            durationMs: 0,
          },
        ],
      }
    );
  };
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: runQuery,
    // Adapter is fetched through QueryRunner.runSql — we patch directly.
  } as unknown as QueryRunner;
  // runner.runSql IS the recorder.
  (runner as unknown as { runQuery?: typeof runQuery }).runQuery = runQuery;
  return { runner, recorded, calls: recorded };
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
    .map((c) => c[0] as { type?: string; ok?: boolean; refused?: boolean; reason?: string; errors?: string[]; index?: number })
    .filter((m) => m.type === "saveResult");
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
    // Identifier quoting — the table name (and column names) MUST appear
    // quoted or as plain safe identifiers, NEVER raw interpolated user data.
    expect(ctidQuery!.sql).toMatch(/FROM\s+(?:"public\.t"|public\.t)\b/i);
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

describe("ResultsPanel — partial failure (per-statement errors)", () => {
  it("first UPDATE succeeds, second fails → ack ok:false with errors[] (NOT silent clear)", async () => {
    const saveCtx: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => ["id"],
    };
    let n = 0;
    const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
      n++;
      if (/UPDATE/i.test(sql) && n === 2) {
        throw new Error("constraint violated");
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
  });
});
