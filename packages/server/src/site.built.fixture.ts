import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { DEFAULT_WEB_ROOT } from "./main.js";

// What the tests of the built site read: whether web/dist is built from the current sources, and a page's parts.

const WEB = fileURLToPath(new URL("../web", import.meta.url));
const SHARED = fileURLToPath(new URL("../../shared/src", import.meta.url));
/** Files a build does not read: tests and their fixtures. */
const NOT_BUILT = /\.(test|fixture)\.ts$/;

/** Every file under `dir`, at any depth. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** The files the web build reads: the pages, styles and config in web/, and the sources of web/src, web/public and shared. */
function buildSources(): string[] {
  const top = readdirSync(WEB).filter((f) => /\.(html|css)$/.test(f) || f === "vite.config.ts").map((f) => join(WEB, f));
  const deep = [join(WEB, "src"), join(WEB, "public"), SHARED].flatMap(filesUnder);
  return [...top, ...deep].filter((f) => !NOT_BUILT.test(f));
}

/**
 * Throws unless web/dist holds a build made after the last change to any file the build reads. The build rewrites every
 * page, so the oldest page in web/dist is when it was built; a source changed after it makes the build stale.
 */
export function assertFreshBuild(): void {
  const run = "run `pnpm --filter @teamusage/server build` first";
  const pages = existsSync(DEFAULT_WEB_ROOT) ? readdirSync(DEFAULT_WEB_ROOT).filter((f) => f.endsWith(".html")) : [];
  if (pages.length === 0) throw new Error(`web/dist holds no built page: ${run}`);
  const builtAt = Math.min(...pages.map((f) => statSync(join(DEFAULT_WEB_ROOT, f)).mtimeMs));
  const newer = buildSources().filter((f) => statSync(f).mtimeMs > builtAt);
  if (newer.length > 0) throw new Error(`web/dist is older than ${newer.length} source file(s), e.g. ${newer[0]}: ${run}`);
}

const win = new Window();

/** The page's HTML as a document, for reading its elements; nothing in it runs or loads. */
export const parsePage = (html: string): Document => new win.DOMParser().parseFromString(html, "text/html") as unknown as Document;

/** Closes the window `parsePage` parses in; after it, `parsePage` is not called again. */
export const closeParser = (): Promise<void> => win.happyDOM.close();

/** The addresses of the page's scripts and stylesheets: script `src`, and `href` of stylesheet and module preload links. */
export function scriptsAndStyles(doc: Document): string[] {
  const scripts = [...doc.querySelectorAll("script[src]")].map((s) => s.getAttribute("src") ?? "");
  const links = [...doc.querySelectorAll('link[rel="stylesheet"], link[rel="modulepreload"]')].map((l) => l.getAttribute("href") ?? "");
  return [...scripts, ...links];
}

/** The scripts the page loads: its module script `src` and its module preloads. */
export function scriptsOf(doc: Document): string[] {
  return scriptsAndStyles(doc).filter((path) => path.endsWith(".js"));
}

/** Every `<a href>` of the page that starts with `/`, with the anchor. */
export const sitePathLinks = (doc: Document): { href: string; anchor: Element }[] =>
  [...doc.querySelectorAll("a[href]")]
    .map((anchor) => ({ href: anchor.getAttribute("href") ?? "", anchor }))
    .filter((link) => link.href.startsWith("/"));

/** The path of a link, its query and fragment set aside. */
export const pathOf = (href: string): string => href.split(/[?#]/)[0] ?? "";
