import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Every page directly in web/, by its name: a page is added by adding its file. */
const pages = Object.fromEntries(
  readdirSync(root)
    .filter((file) => file.endsWith(".html"))
    .map((file) => [basename(file, ".html"), join(root, file)]),
);

// Builds the pages to web/dist, which the server serves by path (src/pages.ts).
// The output must run under the server's CSP: no inline scripts, nothing from other origins.
export default defineConfig({
  root,
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: { input: pages },
  },
  // `pnpm dev:web` runs against a local server started with `TEAMUSAGE_DEMO=1`.
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
