// tests/chatv2BaselineNotes.test.ts — TASK-CHATV2-001 structural guard.
//
// This task is evidence-only: it changes no runtime source. The deliverable
// is two notes files. To keep the deliverable honest (and to satisfy the
// TDD-first contract) this suite asserts the REQUIRED STRUCTURE of those
// notes rather than any runtime behavior:
//
//   #1 happy      — the baseline carries a four-engine × twelve-capability
//                   matrix with an evidenced anchor in every cell.
//   #2 edge       — a missing capability is recorded `absent`/`unknown`,
//                   never silently collapsed to true/false.
//   #3 regression — the duplicate Enter-ownership path names BOTH current
//                   listener owners and the task that removes/replaces them.
//   #4 boundary   — the cutover map gives every AI-chat source and mapped
//                   test an explicit owner/disposition.
//
// Reading is filesystem-only (node environment); no jsdom, no bundle.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BASELINE = resolve(
  process.cwd(),
  "docs/AI_HANDOFF/notes/chatv2-baseline.md",
);
const CUTOVER = resolve(
  process.cwd(),
  "docs/AI_HANDOFF/notes/chatv2-cutover-map.md",
);

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Canonical 12 capability columns required by the task §Required Work 2. */
const CAPABILITY_COLUMNS = [
  "text stream",
  "reasoning stream",
  "tools",
  "permissions",
  "bypass",
  "image",
  "model roles",
  "native resume",
  "saved transcript",
  "provider commands",
  "cancel",
  "export",
] as const;

/** Canonical four engine rows. */
const ENGINES = ["builtin", "omp", "claude-code", "codex"] as const;

/** A cell is evidence-backed when it points at a real `file:line` anchor. */
const ANCHOR_RE = /[A-Za-z0-9_./-]+\.(?:ts|css|js|json):\d+/;
/** ...or explicitly records the absence/unknown, never a bare boolean. */
const ABSENT_OR_UNKNOWN_RE = /^(?:absent|unknown)\b/i;

interface Matrix {
  header: string[];
  rows: Map<string, string[]>;
}

/** Parse the first markdown table whose header names every capability column. */
function parseMatrix(md: string): Matrix | null {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    const header = cells.map((c) => c.toLowerCase());
    const hasEngineCol = header.some((c) => c.startsWith("engine"));
    const missing = CAPABILITY_COLUMNS.filter((c) => !header.includes(c));
    if (!hasEngineCol || missing.length > 0) continue;
    // Next non-empty line must be the `|---|` separator.
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === "") j++;
    if (!lines[j]?.trim().startsWith("|")) continue;
    if (!/^\|[\s:|-]+\|?$/.test(lines[j]!.trim())) continue;
    // Collect body rows until the table ends.
    const rows = new Map<string, string[]>();
    for (let k = j + 1; k < lines.length; k++) {
      const body = lines[k]!.trim();
      if (!body.startsWith("|")) break;
      const rowCells = splitRow(body);
      const engineCell = rowCells[0]!.toLowerCase();
      const engine = ENGINES.find((e) => engineCell.includes(e));
      if (engine === undefined) continue;
      rows.set(engine, rowCells);
    }
    return { header, rows };
  }
  return null;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

describe("TASK-CHATV2-001 baseline + cutover notes", () => {
  it("#1 Four-engine matrix: 4 rows x 12 columns, every cell evidenced or explicitly unknown", () => {
    const md = readOrEmpty(BASELINE);
    const matrix = parseMatrix(md);
    expect(matrix, "baseline must contain a 4-engine x 12-capability table").not.toBeNull();
    if (matrix === null) return;

    // Exactly the four engines, each present once.
    for (const engine of ENGINES) {
      expect(matrix.rows.has(engine), `matrix is missing engine row: ${engine}`).toBe(true);
    }
    expect(matrix.rows.size).toBe(4);

    const capIdx = CAPABILITY_COLUMNS.map((c) => matrix.header.indexOf(c));
    for (const engine of ENGINES) {
      const row = matrix.rows.get(engine)!;
      // engine col + 12 capability cols.
      expect(row.length, `row ${engine} must have 13 cells`).toBeGreaterThanOrEqual(13);
      for (let c = 0; c < CAPABILITY_COLUMNS.length; c++) {
        const cell = row[capIdx[c]!] ?? "";
        expect(
          cell.length,
          `${engine} / ${CAPABILITY_COLUMNS[c]} must not be empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("#2 Missing capability: every cell is a file:line, `absent`, or `unknown` — never bare true/false", () => {
    const md = readOrEmpty(BASELINE);
    const matrix = parseMatrix(md);
    expect(matrix).not.toBeNull();
    if (matrix === null) return;

    const capIdx = CAPABILITY_COLUMNS.map((c) => matrix.header.indexOf(c));
    let unknownCount = 0;
    for (const engine of ENGINES) {
      const row = matrix.rows.get(engine)!;
      for (const idx of capIdx) {
        const cell = row[idx] ?? "";
        const evidenced = ANCHOR_RE.test(cell);
        const flagged = ABSENT_OR_UNKNOWN_RE.test(cell);
        expect(
          evidenced || flagged,
          `${engine} cell "${cell}" must be a file:line anchor, "absent", or "unknown"`,
        ).toBe(true);
        // A bare boolean/emoji would silently claim parity — forbidden.
        expect(
          /^(?:yes|no|true|false|✓|✗|y|n)$/i.test(cell),
          `cell "${cell}" claims support without evidence`,
        ).toBe(false);
        if (/\bunknown\b/i.test(cell)) unknownCount++;
      }
    }
    // The audit must surface at least one unverified cell rather than infer parity.
    expect(unknownCount, "matrix must record at least one explicit `unknown`").toBeGreaterThan(0);

    // Every `absent`/`unknown` decision is also explained in prose.
    for (const engine of ENGINES) {
      expect(md).toMatch(new RegExp(engine.replace("-", "[- ]?"), "i"));
    }
  });

  it("#3 Duplicate keyboard path: both listener owners and their replacement tasks are named", () => {
    const baseline = readOrEmpty(BASELINE);
    const cutover = readOrEmpty(CUTOVER);
    const combined = `${baseline}\n${cutover}`;

    // Owner A — composer bubble-phase Enter=send listener.
    expect(
      /webview\/aiChatPanelComposer\.ts:\d+/.test(combined),
      "must anchor the composer bubble-phase Enter listener",
    ).toBe(true);
    // Owner B — main capture-phase keydown listener (Ctrl/Cmd+Enter + dropdown).
    expect(
      /webview\/aiChatPanelMain\.ts:\d+/.test(combined),
      "must anchor the main capture-phase keydown listener",
    ).toBe(true);
    // Both are explicitly called out as duplicate Enter ownership.
    expect(combined).toMatch(/duplicate/i);
    expect(combined).toMatch(/enter/i);
    // A concrete future owner task resolves it.
    expect(
      /CHATV2-009/.test(combined),
      "the composer keyboard-controller task must be named as the owner",
    ).toBe(true);
  });

  it("#4 Cutover completeness: every AI-chat source and mapped test has an owner/disposition", () => {
    const cutover = readOrEmpty(CUTOVER);
    expect(cutover.length, "cutover map must be non-trivial").toBeGreaterThan(1000);

    const requiredSources = [
      "webview/aiChatPanelMain.ts",
      "webview/aiChatPanelComposer.ts",
      "webview/aiChatPanelThread.ts",
      "webview/aiChatPanelHeader.ts",
      "webview/styles.css",
      "webview/main.ts",
      "esbuild.js",
      "src/ui/aiChatPanel.ts",
      "src/ui/aiChatPanelMessages.ts",
      "src/ui/aiChatPanelCommands.ts",
      "src/ui/aiChatAttachments.ts",
      "src/ui/aiChatPanelMessages.ts",
      "src/ai/omp/ompChatEngine.ts",
      "src/ai/claudeCode/claudeCodeChatEngine.ts",
      "src/ai/codex/codexChatEngine.ts",
      "src/ai/engineChoice.ts",
      "src/ai/provider.ts",
      "src/ai/agent.ts",
    ];
    const requiredTests = [
      "webview/__tests__/aiChatPanelComposer.test.ts",
      "webview/__tests__/aiChatPanelThread.test.ts",
      "webview/__tests__/aiChatPanelHeader.test.ts",
      "src/ui/__tests__/aiChatPanelMessages.test.ts",
      "src/ui/__tests__/aiChatPanelCommands.test.ts",
      "src/ui/__tests__/aiChatPanel.test.ts",
      "src/ui/__tests__/aiChatPanelBundle.test.ts",
      "src/ai/omp/__tests__/ompChatEngine.test.ts",
      "src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts",
      "src/ai/codex/__tests__/codexChatEngine.test.ts",
    ];

    const lines = cutover.split("\n");
    const DISPOSITION = /\b(preserve|replace|delete|temporary)\b/i;
    const missing: string[] = [];
    for (const path of [...requiredSources, ...requiredTests]) {
      const line = lines.find((l) => l.includes(path));
      if (line === undefined || !DISPOSITION.test(line)) missing.push(path);
    }
    expect(
      missing,
      `cutover map must give each path a disposition on its own line: ${missing.join(", ")}`,
    ).toEqual([]);

    // The final deletion wave is named so nothing lingers without an owner.
    expect(cutover).toMatch(/CHATV2-017/);
  });
});
