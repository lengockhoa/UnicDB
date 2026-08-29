# ROADMAP — DataGrip Parity (durable)

Mục đích: bản đồ multi-cycle đưa VSDB tới feature-parity với JetBrains DataGrip, PostgreSQL-first.
File này **durable** — sống qua các vòng archive; mỗi cycle khi bắt đầu bóc phần của mình ra vào PLAN_XX.md.
| Cycle | Chủ đề | Trạng thái |
|---|---|---|
| AF | Catalog + DDL + Console + Formatter | complete — released |
| AG (roadmap) | Import/Export + advanced grid | planned (AG2026 draft rejected) |
| AH | Admin: users/roles/grants + sessions/locks | in progress — AHL plan/index/4 tasks drafted (use AHL suffix to avoid clashing with shipped PLAN_AH / INDEX_AH) |
| AI | Diff (schema + data) + rename refactor | planned |
| AJ | ER diagrams + SSH tunnel + connection UX | planned |
| AK | MySQL/MSSQL parity + polish | planned |

## Cycle AF — Catalog + DDL + Console + Formatter (released)
## Cycle AG (roadmap-named) — Import/Export + Advanced grid (NOT YET PURSUED)
- Import wizard CSV/JSON (column mapping + dry-run + INSERT batches).
- Numbered pagination alongside Load More.
- Form view + JSON / large-text value editor.
- Copy table between two connections (schema + data, batched).
- Cycle was drafted as AG2026 but rejected on execution; plan files removed.
| AF | Catalog + DDL + Console + Formatter | complete — released |
| AG | Import/Export + Data grid nâng cao | planned |
| AH | Admin: users/roles/grants + sessions/locks | in progress — AHL plan/index/4 tasks drafted (use AHL suffix to avoid clashing with shipped PLAN_AH / INDEX_AH) |
| AI | Diff (schema + data) + rename refactor | planned |
| AJ | ER diagrams + SSH tunnel + connection UX | planned |
| AK | MySQL/MSSQL parity + polish | planned |


## Cycle AH — Admin: users/roles/grants + sessions/locks

(See `docs/AI_HANDOFF/PLAN_AHL.md` + `docs/AI_HANDOFF/INDEX_AHL.md` + `docs/AI_HANDOFF/tasks/TASK-AHL-001..004.md`. Suffix `AHL` was used because `PLAN_AH.md` + `INDEX_AH.md` already document the shipped results-panel cycle.)
- Tree category `Roles` (login/role attributes), per-role grants (tables/sequences/schema), member-of.
- Grant/revoke wizard với preview SQL + confirm (dangerous-statement gate).
- Sessions viewer: active queries (pid, user, state, duration, query), lock waits (blocked → blocking chain), kill/terminate (confirm).
- Rough: 4 tasks. Depends: AF (tree + catalog patterns).

## Cycle AI — Diff + Refactor
- Schema diff: chọn 2 tables/2 schemas (cùng hoặc khác connection) → ALTER plan, copy/run từng bước.
- Data diff: 2 tables cùng shape → row-level diff theo PK (inserted/changed/deleted), sync wizard hướng 2 chiều tùy chọn.
- Rename refactor: rename table/column với usage update qua catalog (FK, views, routines) → preview + confirm.
- Find usages của object từ schema cache.
- Rough: 4-5 tasks. Depends: AF (catalog DDL), cần schema cache mở rộng.

## Cycle AJ — ER diagrams + SSH tunnel + connection UX
- ER diagram webview từ FK introspection (bảng box + cạnh FK, zoom/pan, highlight bảng liên quan, export SVG).
- SSH tunnel cho connection form (jump host, key/password, tunnel tự quản lý lifecycle).
- Connection UX: groups/folders, màu per-connection, read-only flag (grid chặn edit + warning).
- Rough: 5 tasks. Depends: AF (FK catalog), AG (grid read-only surface).

## Cycle AK — MySQL/MSSQL parity + polish
- Nâng catalog cho mysql (SHOW INDEX / information_schema) + mssql (sys.* views); bỏ NotImplementedError còn lại.
- DDL thật cho view/routine trên cả 2 driver (SHOW CREATE / sp_helptext).
- Quick doc (hover thấy column type/comment), go-to-definition từ SQL → tree, find usages mở rộng.
- Full-text search trong data (ILIKE/LIKE panel + tsvector hint), result-set compare, query parameters (:name binding).
- Rough: 5-6 tasks. Depends: tất cả cycle trước đã ổn trên Postgres.

---

## Feature → Cycle map (không orphan)

| DataGrip feature | Cycle |
|---|---|
| Object tree đầy đủ + row counts | AF |
| DDL trong editor (view/routine/trigger) | AF |
| Multi-tab console + history + EXPLAIN + format | AF |
| Import wizard (CSV/JSON disk) | AG |
| Grid row add/delete, pagination, form/value editors | AG |
| Copy table giữa DBs | AG |
| Users/roles/privileges UI | AH |
| Sessions + locks viewer + kill | AH |
| Schema diff | AI |
| Data diff | AI |
| Safe rename + find usages | AI |
| ER diagrams | AJ |
| SSH/SSL tunnels | AJ |
| Connection colors/groups/read-only | AJ |
| Full-text search in data, result compare, query params, quick doc, go-to-def | AK |
| MySQL/MSSQL parity | AK |

## Đã có sẵn (không lên kế hoạch lại)
- AI chat + DB-aware tools + permission cards + omp engine (cycle AA/AD/AE).
- Data grid: server-side sort/filter, keyset paging, inline edit, paste, undo/redo, export 8 formats.
- Connection manager (add/edit/test, SecretStorage, SSL), destructive-SQL confirm, completion + semantic tokens.
