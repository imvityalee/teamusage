import { afterAll, describe, expect, test } from "vitest";
import { conn, CSP_OF_218FF14, serverConfig } from "./main.fixture.js";
import { closedAfterTest, hostedServer } from "./main.web.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";
import { pagesOf, type Mode } from "./pages.js";
import { assertFreshBuild, closeParser, parsePage, pathOf, scriptsAndStyles, scriptsOf, sitePathLinks } from "./site.built.fixture.js";

// Every page of both modes as `pnpm --filter @teamusage/server build` makes it, served by buildServer from web/dist.

/** Most bytes the landing page's scripts may weigh together. */
const LANDING_SCRIPT_BYTES = 12_000;
/** A message only the dashboard's own table holds (the controller's probe for that table in another page). */
const DASHBOARD_ONLY_MESSAGE = "The start date is after the end date.";
/**
 * Links of a self-hosted server's pages to paths it does not serve, each with the id of the element that hides it there:
 * open.html's GitHub line, which open/main.ts hides when `me()` says `noAccounts`; and index.html's account box, hidden
 * in the HTML and never shown by a self-hosted dashboard's header (`PLAIN` of dashboard/chrome.ts).
 */
const HIDDEN_ON_SELF_HOSTED: Readonly<Record<string, string>> = { "/auth/github/start": "gh-line", "/teams": "account" };

afterAll(closeParser);

/** A server of `mode` on web/dist; every test starts here, so each fails with the reason when web/dist is missing or stale. */
function serverOf(mode: Mode): BuiltServer {
  assertFreshBuild();
  return mode === "hosted" ? hostedServer() : closedAfterTest(buildServer(serverConfig()));
}
const get = (s: BuiltServer, path: string) => s.app.request(path, {}, conn);

/** Every page of `s`'s mode: its path, the answer and its HTML. */
async function pagesFrom(s: BuiltServer, mode: Mode) {
  return Promise.all(Object.keys(pagesOf(mode)).map(async (path) => {
    const res = await get(s, path);
    return { path, res, html: await res.text() };
  }));
}

/** The scripts and stylesheets of every page of `s`'s mode, each once. */
async function assetsFrom(s: BuiltServer, mode: Mode): Promise<string[]> {
  const pages = await pagesFrom(s, mode);
  return [...new Set(pages.flatMap((p) => scriptsAndStyles(parsePage(p.html))))];
}

describe.each(["hosted", "self-hosted"] as const)("the built pages of a %s server", (mode) => {
  test("every page answers 200 with the phone's metas and a title, and holds no inline script, handler or javascript: address", async () => {
    for (const { path, res, html } of await pagesFrom(serverOf(mode), mode)) {
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      const doc = parsePage(html);
      expect(doc.querySelector('meta[name="viewport"]')?.getAttribute("content"), path).toContain("viewport-fit=cover");
      expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content"), path).toBe("light dark");
      expect(doc.querySelector("title")?.textContent?.trim(), path).not.toBe("");
      for (const script of doc.querySelectorAll("script")) {
        expect(script.getAttribute("src"), `${path}: a script without src`).toBeTruthy();
        expect(script.textContent?.trim(), `${path}: an inline script body`).toBe("");
      }
      const handlers = [...doc.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.toLowerCase().startsWith("on")));
      expect(handlers, path).toEqual([]);
      expect(html, path).not.toMatch(/javascript:/i);
    }
  });

  test("every script and stylesheet is a file under /assets/ of this server, answered with a long immutable cache", async () => {
    const s = serverOf(mode);
    const assets = await assetsFrom(s, mode);
    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) {
      expect(path).toMatch(/^\/assets\/[\w.-]+\.(js|css)$/);
      const res = await get(s, path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toContain("immutable");
    }
  });

  test("every answer carries the Content-Security-Policy of 218ff14", async () => {
    const s = serverOf(mode);
    const paths = [...Object.keys(pagesOf(mode)), ...(await assetsFrom(s, mode)), "/api/health", "/no-such-page"];
    for (const path of paths) expect((await get(s, path)).headers.get("content-security-policy"), path).toBe(CSP_OF_218FF14);
  });
});

describe("links between the built pages", () => {
  test("every link of a hosted page to this site is a hosted page, its query and fragment set aside, or the GitHub sign-in", async () => {
    const hostedPages = pagesOf("hosted");
    let seen = 0;
    for (const { path, html } of await pagesFrom(serverOf("hosted"), "hosted")) {
      for (const { href } of sitePathLinks(parsePage(html))) {
        seen += 1;
        const known = Object.hasOwn(hostedPages, pathOf(href)) || href.startsWith("/auth/github/start");
        expect(known, `${path} links to ${href}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("a self-hosted page links only to its own pages, or to a path that is hidden on such a server", async () => {
    const selfHostedPages = pagesOf("self-hosted");
    let seen = 0;
    const hidden: string[] = [];
    for (const { path, html } of await pagesFrom(serverOf("self-hosted"), "self-hosted")) {
      for (const { href, anchor } of sitePathLinks(parsePage(html))) {
        seen += 1;
        if (Object.hasOwn(selfHostedPages, pathOf(href))) continue;
        const hiddenBy = HIDDEN_ON_SELF_HOSTED[pathOf(href)];
        expect(hiddenBy, `${path} links to ${href}`).toBeDefined();
        expect(anchor.closest(`#${hiddenBy}`), `${path}: ${href} is inside #${hiddenBy}`).not.toBeNull();
        hidden.push(`${path} ${href} in #${hiddenBy}`);
      }
    }
    expect(seen).toBeGreaterThan(hidden.length);
    expect(hidden).toEqual(expect.arrayContaining(["/open /auth/github/start in #gh-line", "/ /teams#all in #account"]));
  });
});

describe("the landing page's scripts", () => {
  test(`weigh under ${LANDING_SCRIPT_BYTES} bytes together and hold neither the dashboard's script nor its table`, async () => {
    const s = serverOf("hosted");
    const scriptsAt = async (page: string) => scriptsOf(parsePage(await (await get(s, page)).text()));
    const bodyOf = async (path: string) => (await get(s, path)).text();
    const landing = await scriptsAt("/");
    expect(landing.length).toBeGreaterThan(0);
    const dashboard = await scriptsAt("/dashboard");
    // The dashboard's own script is the one of its scripts that holds its table, whatever the build names it.
    const dashboardBodies = await Promise.all(dashboard.map(bodyOf));
    const dashboardOwn = dashboard.filter((_, i) => dashboardBodies[i]?.includes(DASHBOARD_ONLY_MESSAGE));
    expect(dashboardOwn).toHaveLength(1);
    expect(landing).not.toContain(dashboardOwn[0]);

    const bodies = await Promise.all(landing.map(bodyOf));
    const bytes = bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
    expect(bytes).toBeLessThan(LANDING_SCRIPT_BYTES);
    for (const [i, body] of bodies.entries()) expect(body.includes(DASHBOARD_ONLY_MESSAGE), landing[i]).toBe(false);
  });
});
