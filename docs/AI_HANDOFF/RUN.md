Command: handoff-fullstack
Goal: Cycle X — "phiên bản hoàn hảo chạy được": deep QA review toàn bộ tính năng đã ship (cycles U/V/W) + fix mọi defect tìm được
Base: main
Phase: P1
Cursor: fresh cycle do user yêu cầu sau khi cycle W xong (v1.6.6, 94331b1, đã push+release); session cũ hết context — persist xong, chờ resume
Next: P1 lite context read, rồi P2 planner: cycle hardening/review — (a) full-code adversarial review của diff v1.6.3..v1.6.6 (cycles S-U-V-W) tìm bug thật, (b) fix known flake resultsGridModelNull test 6 tận gốc, (c) backlog queued: keyset paging, MySQL/MSSQL session-timezone literals, whitespace-only (Blanks), stripTrailingSemicolon hoist, MySQL getTableSortQuery twin; plan review 2 rounds như thường lệ
