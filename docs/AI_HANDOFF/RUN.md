Command: handoff-fullstack
Goal: Apply 12 queued minor cleanups from cycles AGT + AGT-UI (stale comments, dead exports, smoke-helper dead-code, renderMarkdown/escapeHtml dedup between main.ts and thread.ts). No patch release — gộp vào cycle lớn tiếp theo.
Base: main @ 77481c1 (cycle AGT-CLEANUP-2 wave 1 batches 1-4 all checkpointed)
Phase: R1-R5
Cursor: 6/7 reviews returned (001/002/003/005 APPROVED, 004/006 APPROVED-MINOR [EOF nit + preId loop var nit]); 1/7 pending (007 retry review in flight after first attempt hit unic-smart 503). Cross-check evidence on main tree for 007: combined vitest run = 33/33 PASS (8 markdownSafe + 25 aiChatPanelThread); fence template byte-identical (`<pre class="UnicDB-md-code" data-raw="${escapeHtml(f.code)}"><code class="UnicDB-md-code-lang-${escapeHtml(f.lang)}">${f.code}</code><button type="button" class="UnicDB-md-copy">Copy</button></pre>`); test imports use both `../aiChatPanelThread` (re-export) and `../markdownSafe` (direct); no orphan local copies.
Next: wait for 005+006 reviews; then R1 for TASK-CLEAN2-007 standalone; then R5 closeout (STATUS/WORKLOG refresh, single push to origin, no version bump, no release).
