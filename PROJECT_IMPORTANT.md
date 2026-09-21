# Project Important Instructions

## Ship Pipeline (mandatory)

Sau khi update code xong, ship là BẮT BUỘC theo đúng thứ tự:

1. **Git** — commit + push lên remote.
2. **Git release** — tạo git tag/release tương ứng version.
3. **VS Marketplace** — publish bằng `vsce` (vsce publish). PAT nằm trong file `.pat` tại `.secrets/.pats/` — dùng `vsce publish -p "$(cat .secrets/.pats/.pat)"` (hoặc `vsce login` với PAT đó); không commit file PAT.

Không được dừng ở bước code xong; một lần ship chỉ coi là hoàn tất khi cả 3 bước trên đã chạy.
