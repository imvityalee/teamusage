import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Builds the dashboard to web/dist, which the server serves at "/".
// The output must run under the server's CSP: no inline scripts, nothing from other origins.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  // `pnpm dev:web` runs against a local server started with `TEAMUSAGE_DEMO=1`.
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
