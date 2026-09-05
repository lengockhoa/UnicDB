// src/__tests__/sqlGrammar.test.ts
// TASK-001 — SQL TextMate injection grammar + package.json contribution.
//
// Guards that the new `syntaxes/UnicDB-sql-injection.tmLanguage.json` injection
// grammar is (a) declared in package.json `contributes.grammars`, (b) readable
// and JSON-parseable on disk, (c) actually contains the UnicDB dialect keywords it
// claims to scope, (d) regex-safe (no rule matches the empty string — that hangs
// the TextMate engine), (e) not excluded from the packaged .vsix, and (f) does
// not shadow VS Code's built-in `sql` language by re-declaring `contributes.languages`.
//
// Đọc động từ file on disk (giống releaseHygiene.test.ts) — thay đổi grammar/package.json
// không phải sửa test.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

interface GrammarContribution {
  language?: string;
  scopeName?: string;
  path?: string;
  injectTo?: string[];
}

interface Contributes {
  grammars?: GrammarContribution[];
  languages?: Array<{ id?: string }>;
}

interface GrammarPattern {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
}

interface GrammarFile {
  scopeName?: string;
  patterns?: GrammarPattern[];
}

describe("UnicDB sql injection grammar (TASK-001)", () => {
  it("package.json contributes a grammar injected into source.sql", () => {
    const pkg = readJson<{ contributes?: Contributes }>("package.json");
    const grammars = pkg.contributes?.grammars ?? [];

    expect(grammars.length, "contributes.grammars must have at least one entry")
      .toBeGreaterThanOrEqual(1);

    const entry = grammars[0];
    expect(entry.injectTo, "injection grammar must target source.sql").toContain("source.sql");
    expect(entry.scopeName).toBe("source.sql.UnicDB");
  });

  it("grammar file exists at the contributed path and parses as JSON", () => {
    const pkg = readJson<{ contributes?: Contributes }>("package.json");
    const entry = (pkg.contributes?.grammars ?? [])[0];

    // Path is read out of package.json, not hardcoded.
    expect(entry.path).toBeTruthy();
    const grammarPath = entry.path!;

    const abs = path.join(repoRoot, grammarPath);
    expect(fs.existsSync(abs), `grammar file ${grammarPath} must exist on disk`).toBe(true);

    const grammar = readJson<GrammarFile>(grammarPath);
    expect(grammar.scopeName, "grammar scopeName must match the contributed scopeName")
      .toBe(entry.scopeName);
  });

  it("grammar declares at least the UnicDB dialect keywords", () => {
    const grammar = readJson<GrammarFile>("syntaxes/UnicDB-sql-injection.tmLanguage.json");
    const patterns = grammar.patterns ?? [];

    // Join match/begin/end so a keyword rule stays covered whether it is written
    // as a single match or a begin/end pair.
    const joined = patterns
      .map((p) => [p.match, p.begin, p.end].filter(Boolean).join(" "))
      .join("\n");

    for (const kw of ["ILIKE", "RETURNING", "TOP", "FETCH"]) {
      expect(joined, `grammar patterns must mention ${kw}`).toContain(kw);
    }
  });

  it("no pattern matches the empty string", () => {
    const grammar = readJson<GrammarFile>("syntaxes/UnicDB-sql-injection.tmLanguage.json");
    const patterns = grammar.patterns ?? [];

    const regexes = patterns
      .map((p) => [p.match, p.begin, p.end])
      .flat()
      .filter((r): r is string => typeof r === "string" && r.length > 0);

    expect(regexes.length, "grammar must declare at least one regex").toBeGreaterThan(0);

    // An empty-matching rule makes the TextMate engine spin forever — this is the
    // classic grammar hang (case 4, regex safety).
    for (const r of regexes) {
      const re = new RegExp(r);
      expect(re.exec(""), `pattern ${r} must not match the empty string`).toBeNull();
    }
  });

  it(".vscodeignore does not exclude the syntaxes folder", () => {
    const content = fs.readFileSync(path.join(repoRoot, ".vscodeignore"), "utf-8");
    const lines = content.split(/\r?\n/);

    expect(
      lines.some((l) => /^syntaxes/.test(l.trim())),
      ".vscodeignore must not contain a line matching /^syntaxes/",
    ).toBe(false);
  });

  it("no contributes.languages entry claims languageId sql", () => {
    const pkg = readJson<{ contributes?: Contributes }>("package.json");
    const languages = pkg.contributes?.languages ?? [];

    // Guards against shadowing VS Code's built-in SQL language: re-declaring
    // languageId "sql" can replace the built-in grammar.
    expect(
      languages.some((l) => l.id === "sql"),
      "must not claim languageId sql in contributes.languages",
    ).toBe(false);
  });
});
