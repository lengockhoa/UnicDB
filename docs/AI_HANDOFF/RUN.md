Command: handoff-fullstack
Goal: Multi-selection Cmd+Enter for shellscript — run only highlighted lines in reused "UnicDB Script" terminal (mirror SQL multi-selection shipped in v1.53.18 commit 3e33f0a). P0: reused terminal + line-at-cursor + shellscript-only.
Base: main @ 86b034e (release: 1.53.18)
Phase: done
Cursor: Cycle SH shipped — main @ 1187b48 pushed to origin. Plan commit (ca3c86b) + wave-1 implementation (fa89923) + guard fix (d7f79e0) + handoff metadata (1187b48). All 3743 tests green. Both rows reviewed (unic-smart) and marked done.
Next: Patch release — `node scripts/bump-version.mjs` then tag + GitHub release + Marketplace publish.
