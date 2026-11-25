import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/server/bench/**/*.bench.ts"], testTimeout: 180000 },
});
