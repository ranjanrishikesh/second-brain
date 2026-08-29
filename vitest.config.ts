import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@second-brain/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "adapters/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    maxWorkers: 2,
    testTimeout: 20_000,
  },
});
