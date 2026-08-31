# TASK-AIX03-002 — analysisTools composite + diagnose

Cycle: AIX-03 · Wave 3 · Priority: P1
Status: pending
Depends on: AIX03-001
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/ai/tools/analysisTools.ts` — DB-aware agent tools (no vscode;
adapter injected via AdapterFactory like dbAwareTools):

1. `createAnalyzeTableTool(f)`: name `analyze_table`; args {schema, table}.
   ONE call returns a JSON report combining:
   - `schema`: listTableDetail → {columns: [{name, type}]}
     (shape-only, no row bytes)
   - `count`: COUNT(*) result
   - `sample`: first N rows (default SAMPLE_DEFAULT_LIMIT, cap
     SAMPLE_MAX_LIMIT) — the ONLY part allowed to carry row bytes,
     rendered via the same renderTable used by list_table_data_sample.
   - `relationships`: FK list via listTableDetail contype==="f".
   Each part independently degrades: part failure → `"error": <msg>` for
   that part only; whole tool never throws. No connection → the standard
   NO_CONNECTION envelope.
2. `createDiagnoseQueryTool(f)`: name `diagnose_query`; args {sql}.
   guardSql-equivalent FIRST (EXPLAIN ANALYZE + non-SELECT rejected
   unchanged). Then execute; on success return JSON {ok: true, rows: n};
   on failure classify the adapter error message →
   {ok: false, class: "syntax"|"permission"|"connection"|"unknown",
   detail: first 200 chars}:
   - /syntax error|parse|unexpected/i → syntax
   - /permission denied|access denied|privilege/i → permission
   - /connection|ECONNREFUSED|terminat|closed/i → connection
   - else unknown.

## Acceptance

- [ ] Tests with a fake adapter: happy path all parts; per-part failure
      isolation; no-connection envelope; diagnose success + all 4 error
      classes; diagnose re-guards (DELETE → rejected, EXPLAIN ANALYZE →
      rejected); sample row cap enforced.
- [ ] `npx vitest run src/ai/tools/__tests__/analysisTools.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
