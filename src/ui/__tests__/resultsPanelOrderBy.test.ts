// src/ui/__tests__/resultsPanelOrderBy.test.ts
//
// TASK-004 — composeRequerySql dispatch through parseOrderBy (cases 7-13b).
//
// Reuses the FakeWebview / FakeWebviewPanel + vi.mock("vscode") harness from
// resultsPanelServerFilter.test.ts. Byte-identity cases (11, 13, 13b) assert
// against a LIVE composeRequery / buildPagedQuery call, per PLAN §7.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryRunner, type RunResult } from "../../core/queryRunner";
import { composeRequery } from "../resultsGridModel";
import { buildPagedQuery } from "../queryComposer";

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

const { showErrorMessage } = vi.hoisted(() => ({
  showErrorMessage: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        path: parts
          .map(
            (p: unknown) =>
              (p as { fsPath?: string; path?: string })?.fsPath ??
              (p as { path?: string })?.path ??
              "",
          )
          .join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: (vt: string, t: string, col: number, opts: unknown) => {
        const p = new FakeWebviewPanel(vt, t, col, opts);
        lastPanel.current = p;
        return p;
      },
      showErrorMessage,
    },
    workspace: { onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

import { ResultsPanel, type SaveContext } from "../resultsPanel";

function stateMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map((c) => c[0] as { type?: string; results?: Array<Record<string, unknown>> })
    .filter((m) => m.type === "state");
}

/** Wait until statement 0's last state is terminal (done | error) AND at
 *  least `minStates` state messages were posted (the initial render posts
 *  one; without the floor this helper returns before the requery handler's
 *  first await resolves — the async PK/column-type lookups add microtasks). */
async function waitForTerminal(fake: FakeWebviewPanel, minStates = 2): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const states = stateMessages(fake);
    const last = states[states.length - 1];
    const r = (last?.results as Array<{ status?: string }> | undefined)?.[0];
    if (states.length >= minStates && r && r.status !== "running") return;
    await Promise.resolve();
  }
}

beforeEach(() => {
  lastPanel.current = null;
  vi.clearAllMocks();
});

interface PanelOpts {
  driver?: string;
  sql?: string;
  columns?: string[];
  pkColumns?: string[];
  columnTypes?: Record<string, string>;
}

/** Build a panel with one done statement and a controllable PK list. */
function makePanel(opts: PanelOpts = {}) {
  const columns = opts.columns ?? ["id"];
  const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
    return {
      results: [
        { columns, rows: [[10]], rowCount: 1, durationMs: 0 },
      ],
    };
  });
  const runner = {
    loadMore: vi.fn(async () => [] as Array<Record<string, unknown>>),
    cancel: vi.fn(async () => undefined),
    runSql,
    adopt: vi.fn(() => undefined),
    isCancelled: () => false,
  } as unknown as QueryRunner;
  const saveContext: SaveContext = {
    getDriver: () => (opts.driver ?? "postgres") as never,
    listPkColumns: async () => opts.pkColumns ?? [],
    ...(opts.columnTypes !== undefined
      ? { listColumnTypes: async () => opts.columnTypes }
      : {}),
  };
  const panel = new ResultsPanel({ runner, saveContext });
  panel.render(
    [
      {
        index: 0,
        sql: opts.sql ?? "SELECT id FROM t",
        status: "done",
        result: {
          columns,
          rows: [[1]],
          rowCount: 1,
          durationMs: 0,
        },
        durationMs: 0,
      },
    ],
    "hdr",
  );
  return { runSql, panel, fake: lastPanel.current!, showErrorMessage };
}

function requeryMsg(overrides: Record<string, unknown> = {}) {
  return { type: "requery", index: 0, where: "", orderBy: "", ...overrides };
}

// =============================================================================
// Case 7 — multi-term ORDER BY via the pinned AS UnicDB_sub wrapper
// =============================================================================

describe("TASK-004 case 7 — multi-term ORDER BY uses the pinned AS UnicDB_sub wrapper", () => {
  it("postgres 'a, b DESC' composes the exact multi-term wrap with no LIMIT/OFFSET", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t", columns: ["id"] });
    fake.webview.dispatch(requeryMsg({ orderBy: "a, b DESC" }));
    await waitForTerminal(fake);
    expect(runSql.mock.calls[0]![0]).toBe(
      'SELECT * FROM (SELECT id FROM t) AS UnicDB_sub ORDER BY "a" ASC, "b" DESC',
    );
  });
});

// =============================================================================
// Case 8 — same wrapper on mssql + bar WHERE
// =============================================================================

describe("TASK-004 case 8 — same wrapper on mssql and with a bar WHERE", () => {
  it("mssql 'a, b DESC' composes bracket-quoted multi-term wrap", async () => {
    const { runSql, fake } = makePanel({ driver: "mssql", sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: "a, b DESC" }));
    await waitForTerminal(fake);
    expect(runSql.mock.calls[0]![0]).toBe(
      "SELECT * FROM (SELECT id FROM t) AS UnicDB_sub ORDER BY [a] ASC, [b] DESC",
    );
  });

  it("with where 'id > 0' the wrapper gains WHERE before ORDER BY", async () => {
    const { runSql, fake } = makePanel({ driver: "mssql", sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ where: "id > 0", orderBy: "a, b DESC" }));
    await waitForTerminal(fake);
    expect(runSql.mock.calls[0]![0]).toBe(
      "SELECT * FROM (SELECT id FROM t) AS UnicDB_sub WHERE id > 0 ORDER BY [a] ASC, [b] DESC",
    );
  });
});

// =============================================================================
// Case 8b — quoted identifier round-trip / mismatched style
// =============================================================================

describe("TASK-004 case 8b — active-dialect quoted colId round-trips; mismatched style rejects", () => {
  it("postgres '\"First Name\" ASC' composes ORDER BY \"First Name\" ASC and runs SQL", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: '"First Name" ASC' }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "First Name" ASC');
    expect(runSql).toHaveBeenCalledTimes(1);
  });

  it("postgres '`First Name` ASC' runs no SQL and surfaces the parse error", async () => {
    const { runSql, fake, showErrorMessage } = makePanel({ sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: "`First Name` ASC" }));
    await waitForTerminal(fake);
    expect(runSql).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalled();
  });
});

// =============================================================================
// Case 8c — NULLS native (postgres) vs emulated (mysql/mssql). TASK-005
// intentionally rewrites the old rejection assertion (cycle W case-16
// precedent): a valid NULLS term under mysql/mssql now parses ok and the
// host runs the emulated ORDER BY instead of posting a synthetic error.
// =============================================================================

describe("TASK-004 case 8c (TASK-005) — NULLS native on postgres, emulated on mysql/mssql", () => {
  it("postgres 'a NULLS LAST' composes ORDER BY \"a\" ASC NULLS LAST", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: "a NULLS LAST" }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "a" ASC NULLS LAST');
  });

  it.each(["mysql", "mssql"])("%s: 'a NULLS LAST' runs the emulated ORDER BY once with no error", async (driver) => {
    const { runSql, fake, showErrorMessage } = makePanel({ driver, sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: "a NULLS LAST" }));
    await waitForTerminal(fake);
    // Runs exactly once — never a synthetic rejection path.
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    if (driver === "mysql") {
      expect(sql).toBe("SELECT * FROM (SELECT id FROM t) AS UnicDB_sub ORDER BY `a` IS NULL ASC, `a` ASC");
    } else {
      expect(sql).toBe("SELECT * FROM (SELECT id FROM t) AS UnicDB_sub ORDER BY CASE WHEN [a] IS NULL THEN 1 ELSE 0 END ASC, [a] ASC");
    }
    expect(sql).not.toContain("NULLS");
    // No synthetic error state was posted and no rejection surfaced.
    const stateResults = stateMessages(fake).flatMap(
      (m) => m.results as Array<{ status?: string }> | undefined,
    ).filter(Boolean) as Array<{ status?: string; error?: string }>;
    for (const r of stateResults) {
      expect(r.status).not.toBe("error");
      if (r.error !== undefined) expect(r.error).not.toMatch(/Invalid ORDER BY/);
    }
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Case 9 — expression is rejected, not passed through
// =============================================================================

describe("TASK-004 case 9 — an expression is REJECTED, not passed through", () => {
  it("orderBy 'lower(name)' runs no SQL and surfaces an error", async () => {
    const { runSql, fake, showErrorMessage } = makePanel({ sql: "SELECT id FROM t" });
    fake.webview.dispatch(requeryMsg({ orderBy: "lower(name)" }));
    await waitForTerminal(fake);
    expect(runSql).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalled();
  });
});

// =============================================================================
// Case 10 — single identifier keeps cycle-V composeSortQuery behaviour
// =============================================================================

describe("TASK-004 case 10 — a single identifier still composes as in cycle V", () => {
  it("postgres 'name DESC' → ORDER BY \"name\" DESC via composeSortQuery", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t", columns: ["id", "name"] });
    fake.webview.dispatch(requeryMsg({ orderBy: "name DESC" }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "name" DESC');
    expect(sql).toContain("UnicDB_sort");
  });

  it("mssql 'name DESC' → ORDER BY [name] DESC via composeSortQuery", async () => {
    const { runSql, fake } = makePanel({ driver: "mssql", sql: "SELECT id FROM t", columns: ["id", "name"] });
    fake.webview.dispatch(requeryMsg({ orderBy: "name DESC" }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("ORDER BY [name] DESC");
  });

  it("postgres quoted single term '\"First Name\" DESC' round-trips via UnicDB_sort", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t", columns: ["id", "First Name"] });
    fake.webview.dispatch(requeryMsg({ orderBy: '"First Name" DESC' }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "First Name" DESC');
    expect(sql).toContain("UnicDB_sort");
  });
});

// =============================================================================
// Case 11 — empty ORDER BY byte-identical to composeRequery
// =============================================================================

describe("TASK-004 case 11 — empty ORDER BY is byte-identical to composeRequery", () => {
  it("orderBy '' composes with no ORDER BY substring, toBe composeRequery", async () => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({ sql });
    fake.webview.dispatch(requeryMsg({ orderBy: "" }));
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).not.toContain("ORDER BY");
    expect(composed).toBe(composeRequery(sql, "", ""));
  });
});

// =============================================================================
// Case 12 — paging appends the full composite PK tiebreaker
// =============================================================================

describe("TASK-004 case 12 — paging appends the full composite PK in declared order", () => {
  it("offset 500, PK [tenant_id, id] → trailing tiebreaker ASC pair", async () => {
    const { runSql, fake } = makePanel({
      sql: "SELECT id FROM t",
      columns: ["name", "tenant_id", "id"],
      pkColumns: ["tenant_id", "id"],
    });
    fake.webview.dispatch(requeryMsg({ orderBy: "name", offset: 500 }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "name" ASC, "tenant_id" ASC, "id" ASC LIMIT 500 OFFSET 500');
    const orderClause = sql.slice(sql.indexOf("ORDER BY"));
    expect(orderClause.match(/"tenant_id"/g)?.length).toBe(1);
    expect(orderClause.match(/"id"/g)?.length ?? 0).toBe(1);
    expect(orderClause.indexOf('"tenant_id"')).toBeLessThan(orderClause.indexOf('"id"'));
  });
});

// =============================================================================
// Case 13 — no PK ⇒ byte-identical to cycle-V buildPagedQuery
// =============================================================================

describe("TASK-004 case 13 — no PK means paging unchanged", () => {
  it("empty PK composes byte-identical to buildPagedQuery", async () => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({ sql, columns: ["name"], pkColumns: [] });
    fake.webview.dispatch(requeryMsg({ orderBy: "name", offset: 500 }));
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).toBe(
      buildPagedQuery(sql, "", '"name" ASC', 500, 500, "postgres"),
    );
  });
});

// =============================================================================
// Case 13b — non-projected PK component disables the whole tiebreaker
// =============================================================================

describe("TASK-004 case 13b — any non-projected PK component disables the whole tiebreaker", () => {
  it("PK [tenant_id, id] with id missing → byte-identical, no appended PK", async () => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({
      sql,
      columns: ["name", "tenant_id"],
      pkColumns: ["tenant_id", "id"],
    });
    fake.webview.dispatch(requeryMsg({ orderBy: "name", offset: 500 }));
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).toBe(
      buildPagedQuery(sql, "", '"name" ASC', 500, 500, "postgres"),
    );
    expect(composed).not.toContain('"tenant_id"');
    expect(composed).not.toContain('"id"');
  });
});
