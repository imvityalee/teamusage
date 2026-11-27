import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

const HTML = "text/html; charset=utf-8";

const TYPES: Record<string, string> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const NOT_BUILT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>teamusage</title></head>' +
  "<body><h1>teamusage</h1><p>The dashboard is not built. The API is running.</p></body></html>";

/** packages/server/web/dist, from both src/web-files.ts and the built dist/main.js (siblings of web/). */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../web/dist", import.meta.url));

const notFound = (c: Context): Response => c.text("not found", 404);

type Found = { file: string; body: Buffer<ArrayBuffer>; base: string };

/** The file at `rel` inside `root`, or undefined when it is missing or resolves outside (dot segments, symlinks). */
async function readInside(root: string, rel: string): Promise<Found | undefined> {
  try {
    const base = realpathSync(root);
    const file = realpathSync(resolve(base, `.${rel}`));
    if (!file.startsWith(base + sep) || !statSync(file).isFile()) return undefined;
    return { file, body: await readFile(file), base };
  } catch {
    return undefined;
  }
}

/** The page `file` of the web directory; at `/` a fixed page says when it is not built. */
async function servePage(c: Context, root: string, path: string, file: string): Promise<Response> {
  const found = await readInside(root, `/${file}`);
  if (!found) return path === "/" ? c.html(NOT_BUILT) : notFound(c);
  return c.body(found.body, 200, { "Content-Type": HTML, "Cache-Control": "no-cache" });
}

/** Any other file by its own path: never a page by its file name, a directory, a dotfile or a source map. */
async function serveFile(c: Context, root: string, rel: string): Promise<Response> {
  if (rel.includes("\0") || rel.includes("\\")) return notFound(c);
  const lower = rel.toLowerCase();
  if (lower.endsWith(".html") || rel.endsWith("/")) return notFound(c);
  if (rel.split("/").some((seg) => seg.startsWith(".")) || lower.endsWith(".map")) return notFound(c);
  const found = await readInside(root, rel);
  if (!found) return notFound(c);
  const headers: Record<string, string> = {
    "Content-Type": TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream",
  };
  if (found.file.startsWith(join(found.base, "assets") + sep)) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  return c.body(found.body, 200, headers);
}

/** Answers a GET from `root`: a page of `pages` by its path, any other file by its own path, and nothing that resolves outside `root`. */
export async function serveWeb(c: Context, root: string, pages: Readonly<Record<string, string>>): Promise<Response> {
  let path: string;
  try {
    // Decoded exactly once, from the raw path (c.req.path is already partly decoded); the query is not part of it.
    path = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return notFound(c);
  }
  const page = Object.hasOwn(pages, path) ? pages[path] : undefined;
  return page === undefined ? serveFile(c, root, path) : servePage(c, root, path, page);
}
