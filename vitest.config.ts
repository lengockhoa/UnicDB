import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "webview/__tests__/*.test.ts",
      // TASK-CHATV2-005 — V2 webview modules live under webview/aiChat/ and
      // carry their own colocated tests (icons/shell). Same widening already
      // shipped in TASK-CHATV2-004 on the main tree.
      "webview/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", "**/*.integration.test.ts"],
    environment: "node",
  },
});
