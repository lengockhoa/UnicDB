Command: handoff-fullstack
Goal: Ship ARP-08 Console draft recovery — versioned bounded workspace-scoped tab/buffer/active-tab persistence with debounced flush + exactly-once dispose flush, corrupt→empty-tab fallback, durable clear, and a webview updateBuffer flush that fixes the switch-clobber divergence; restore never runs SQL.
Base: main @ af88e47 (v1.43.0 + plan commit)
Phase: R2
Cursor: I4 done — 7ce8afd; all 4 tasks pending_review. Review range af88e47..HEAD. Suite 3160 | 2 (stale-dist recompile required after copy-back; bundle tests now 18/18).
Next: R2 — two parallel code-reviewer agents (unic-smart) over af88e47..HEAD, split (001+002 codec+host restore / 003+004 webview flush+wiring).

