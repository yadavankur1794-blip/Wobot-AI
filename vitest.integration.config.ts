import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    fileParallelism: false
  }
});
