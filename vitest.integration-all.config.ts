import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/adapters/__tests__/*.integration.test.ts",
      "src/core/__tests__/*.integration.test.ts",
    ],
    exclude: ["node_modules", "dist"],
    environment: "node",
    testTimeout: 30_000,
  },
});
