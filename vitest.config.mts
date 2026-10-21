import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    globalSetup: ["tests/setup/global.ts"],
    setupFiles: ["tests/setup/env.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
  },
});
