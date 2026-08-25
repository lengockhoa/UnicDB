# TASK-001 — SQL TextMate injection grammar + package.json contribution

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Coloring, Layer 1)

## Goal

Ship a TextMate **injection** grammar layered on top of VS Code's built-in `source.sql`
so VSDB adds dialect scopes the built-in grammar misses (`ILIKE`, `RETURNING`, `TOP`,
`OFFSET … FETCH`, `[bracket]` / `` `backtick` `` quoted identifiers) without replacing —
and therefore without regressing — the built-in grammar.

## Target Files

- `syntaxes/vsdb-sql-injection.tmLanguage.json` **(new)** — the injection grammar. Root
  keys: `scopeName: "source.sql.vsdb"`, `injectionSelector: "L:source.sql"`, `patterns: []`.
- `package.json` — add `contributes.grammars` (one entry, `injectTo: ["source.sql"]`,
  `path: "./syntaxes/vsdb-sql-injection.tmLanguage.json"`, `scopeName: "source.sql.vsdb"`).
  Do **not** add `contributes.languages` for `sql` — VS Code already owns that languageId
  and re-declaring it can shadow the built-in grammar. `scripts` / `dependencies` untouched.
- `src/__tests__/sqlGrammar.test.ts` **(new)** — tests below.

`.vscodeignore` is **not** edited: it lists `src/**`, `webview/**`, `tests/**`, `docs/**`,
`scripts/**` but not `syntaxes/**`, so the new folder ships in the `.vsix` by default. The
test below asserts that stays true.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `package.json contributes a grammar injected into source.sql` | `contributes.grammars` has length ≥ 1; entry `.injectTo` contains `"source.sql"`; `.scopeName === "source.sql.vsdb"` | read `package.json` from disk |
| 2 | unit (happy) | `grammar file exists at the contributed path and parses as JSON` | `fs.existsSync(path)` true; `JSON.parse` does not throw; parsed `.scopeName` equals the contributed `scopeName` | path read out of `package.json`, not hardcoded |
| 3 | unit (happy) | `grammar declares at least the VSDB dialect keywords` | joined `match` strings contain `ILIKE`, `RETURNING`, `TOP`, `FETCH` | parsed grammar |
| 4 | edge (regex safety) | `no pattern matches the empty string` | for every `match`/`begin` regex `r`, `new RegExp(r).exec("")` is `null` | an empty-matching rule makes the TextMate engine spin — this is the classic grammar hang |
| 5 | edge (packaging) | `.vscodeignore does not exclude the syntaxes folder` | `.vscodeignore` contents contain no line matching `/^syntaxes/` | read `.vscodeignore` from disk |
| 6 | edge (non-regression) | `no contributes.languages entry claims languageId "sql"` | `contributes.languages` is `undefined`, or no entry has `id === "sql"` | guards against shadowing VS Code's built-in SQL language |

Case 4 and case 5 are different kinds on purpose: 4 is a runtime-hang boundary inside the
artifact, 5 is a packaging/distribution failure outside it.

## Test Files

- `src/__tests__/sqlGrammar.test.ts` — all six cases. Sits beside the existing
  `src/__tests__/releaseHygiene.test.ts`, which already uses the read-from-disk style
  (`repoRoot = path.resolve(__dirname, "..", "..")`, `readJson`) — mirror it.

## Verification Commands

```bash
npm run typecheck
npx vitest run src/__tests__/sqlGrammar.test.ts
npm test
```

`npm run compile` is not required: this task adds no TypeScript to any bundle.

## Acceptance Criteria

- [ ] `syntaxes/vsdb-sql-injection.tmLanguage.json` exists and `JSON.parse` succeeds.
- [ ] `package.json` `contributes.grammars[0].injectTo` includes `"source.sql"`.
- [ ] No `contributes.languages` entry with `id === "sql"` was added.
- [ ] All 6 Test Cases PASS.
- [ ] `npm run typecheck` clean.
- [ ] `npm test` ≥ 1327 passed, 0 failed.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.
- [ ] `CHANGELOG.md` note deferred to the cycle-close docs sync (user-facing feature is
      only complete once TASK-002/003 land).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces:
  - grammar scope name `source.sql.vsdb` — TASK-002's semantic token types layer on top of
    these TextMate scopes; TASK-002 must not assume this grammar exists at runtime.
  - Token scope names TASK-003's webview tokenizer mirrors for visual consistency:
    `keyword.other.vsdb.sql`, `string.quoted.single.sql`, `constant.numeric.sql`,
    `comment.line.double-dash.sql`, `entity.name.function.vsdb.sql`.

---

## Discussion

### 2026-08-25 · planner · bao-opus

Verified before writing: `package.json` `contributes` currently has exactly
`commands, keybindings, menus, views, viewsContainers, viewsWelcome, configuration` — no
`grammars`, no `languages`. So this contribution is genuinely new, not an edit.

`syntaxes/` does not exist yet — create the directory. `.vscodeignore` was read in full;
it has no `syntaxes` line, so no edit is needed there, but test case 5 pins that.

→ @executor: resist the urge to also register `.pgsql` / `.tsql` file extensions. That is
a `contributes.languages` change and case 6 will fail it. Scope is injection only.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
