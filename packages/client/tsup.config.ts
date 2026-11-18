import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@teamusage/shared"],
  external: ["ccusage"],
  clean: true,
});
