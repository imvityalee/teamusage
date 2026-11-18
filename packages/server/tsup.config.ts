import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/admin.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: ["@teamusage/shared"],
  external: ["better-sqlite3"],
  clean: true,
});
