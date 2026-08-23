# Cycle J (queued) — AI Core: Config + Provider + Agent Foundation

Captured 2026-08-23 from user spec (verbatim intent preserved; analyzed for planning).
Supersedes the older vague "AI assist tab" backlog item.

## User requirements (verbatim intent)

1. **AI config storage** — một chỗ config AI; data KHÔNG được public ra ngoài.
   - OpenAI-Compatible connection info: `baseUrl`, `apiKey`, `method`: `responses` hoặc `chat/completions`.
   - 2 model roles:
     - `work` (user gọi "unic-work") — daily tasks, **vision-capable** (đọc được hình).
     - `smart` (user gọi "unic-smart") — deep reasoning, suy nghĩ kỹ.
   - Agent có thể gọi liên tục (multi-turn loop) tới cả 2 models.
2. **Reconfigurable** — user có thể đổi toàn bộ config (kể cả 2 model khác) bất cứ lúc nào; AI Agent luôn đọc config mới nhất lúc chạy, không cache stale.
3. **AI Agent foundation** — lấy thông tin config đó và làm việc; nhiệm vụ tương lai: hỗ trợ làm việc tốt nhất với các DB đã connected. Chuẩn bị lõi (foundation), các năng lực DB-assist là các cycle sau.
4. User nhấn mạnh: phân tích kỹ — đây là LÕI của hệ thống tích hợp AI vào extension.

## Analysis (for cycle J planner)

- **Storage**: apiKey → `context.secrets` (SecretStorage) theo pattern ConnectionManager; baseUrl/method/model ids → workspace/global configuration (vscode.workspace.getConfiguration('vsdb.ai')) hoặc secrets kèm JSON. Config edit UI: mở rộng connectionForm pattern hoặc form riêng `AI Settings` (command palette + tree?). Never log apiKey; never include in telemetry/error messages.
- **Provider client** (pure module, unit-testable): `src/ai/provider.ts` — thin fetch client cho OpenAI-compatible: method switch `chat/completions` vs `responses` (bodies khác nhau), streaming optional (cycle sau nếu cần), timeout, error mapping. Vision: message content parts với image_url (data URL) cho role `work`.
- **Agent loop**: `src/ai/agent.ts` — config-driven model routing (role→model id), tool-calling loop (function calls) với budget cap (max steps), mỗi lần chạy đọc lại config từ storage (reconfigurable requirement). Skeleton + unit tests với fake fetch; chưa cần DB tools — tool registry interface trống, DB tools là cycle K+.
- **Privacy**: all calls go directly user-configured baseUrl; no third-party telemetry; document CSP/egress in README. `Data không được public` = không gửi schema/data đi đâu ngoài endpoint user tự cấu hình.
- **Security**: cycle J planner MUST consult discover-security skill (api key handling). 
- Depends on: nothing from Cycle I (independent subsystem). Consumed later by "Add to AI Prompt" backlog item và AI DB-assist features.

## Out of scope (cycle J)
- DB-aware tools (schema reading, query gen) — cycle K+
- Streaming UI / chat panel — sau khi core ổn
- Anthropic/native non-OpenAI-compatible protocols — user chỉ yêu cầu OpenAI-compatible
