import { afterEach, describe, expect, test } from "vitest";
import type { ServerConfig } from "./config.js";
import { conn, github, hosted, roomy, serverConfig, tempDataDir, webWith } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";
import { pagesOf } from "./pages.js";

const HOSTED_PAGES = { "/": "landing.html", "/dashboard": "index.html", "/demo": "index.html", "/open": "open.html", "/teams": "teams.html", "/team": "team.html", "/invite": "invite.html", "/privacy": "privacy.html", "/terms": "terms.html" };
const SELF_HOSTED_PAGES = { "/": "index.html", "/index.html": "index.html", "/open": "open.html" };
/** The Content-Security-Policy of main.ts as it is at 218ff14. */
const CSP_OF_TODAY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
/** Every file of both tables, and one asset. */
const EVERY_FILE = [...new Set([...Object.values(HOSTED_PAGES), ...Object.values(SELF_HOSTED_PAGES)]), "assets/app.js"];

const servers: BuiltServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server of `config` serving a web directory that holds `files`; closed after the test. */
function serverOf(config: ServerConfig, files: string[]): BuiltServer {
  const s = buildServer(config, { github: github(), measureDisk: roomy, webRoot: webWith(files) });
  servers.push(s);
  return s;
}
const hostedServer = (files = EVERY_FILE) => serverOf(hosted(tempDataDir()), files);
const selfHosted = (files = EVERY_FILE) => serverOf(serverConfig(), files);
const demo = (files = EVERY_FILE) => serverOf(serverConfig({ demo: true }), files);

const get = (s: BuiltServer, path: string) => s.app.request(path, {}, conn);

/** The response is the page `file`, as every page is served. */
async function expectPage(res: Response, file: string): Promise<void> {
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(file);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("content-security-policy")).toBe(CSP_OF_TODAY);
}

/** The response is the fixed page a server answers at `/` when its file is not built. */
async function expectNotBuilt(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("dashboard is not built");
}

describe("pages by path and by mode", () => {
  test.each(Object.entries(HOSTED_PAGES))("a hosted server serves %s from %s", async (path, file) => {
    await expectPage(await get(hostedServer(), path), file);
  });

  test.each(Object.entries(SELF_HOSTED_PAGES))("a self-hosted server serves %s from %s", async (path, file) => {
    await expectPage(await get(selfHosted(), path), file);
  });

  test.each(["/teams", "/team", "/invite", "/dashboard", "/demo", "/privacy", "/terms", "/landing.html", "/open.html", "/teams.html", "/Teams.HTML"])(
    "a self-hosted server has no page %s", async (path) => {
      expect((await get(selfHosted(), path)).status).toBe(404);
    });

  test.each(["/index.html", "/INDEX.HTML", "/landing.html", "/open.html", "/open/", "/OPEN", "/team/", "/assets/"])(
    "a hosted server has no page %s", async (path) => {
      expect((await get(hostedServer(), path)).status).toBe(404);
    });

  test("a path that ends in / is never the file before the slash", async () => {
    expect((await get(hostedServer(), "/assets/app.js/")).status).toBe(404);
    expect((await get(selfHosted(), "/assets/app.js/")).status).toBe(404);
  });

  test("a file whose own name ends in .HTML is not served by its name, in either mode", async () => {
    const files = [...EVERY_FILE, "Upper.HTML"];
    expect((await get(hostedServer(files), "/Upper.HTML")).status).toBe(404);
    expect((await get(selfHosted(files), "/Upper.HTML")).status).toBe(404);
  });

  test("a page is matched without its query", async () => {
    const s = hostedServer();
    await expectPage(await get(s, "/team?team=0123456789abcdef"), "team.html");
    await expectPage(await get(s, "/open?x=1"), "open.html");
  });

  test("a page answers only GET: POST /open is the server's 404", async () => {
    const res = await hostedServer().app.request("/open", { method: "POST" }, conn);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("a hosted page whose file is missing answers 404, and / then answers the not-built page", async () => {
    const s = hostedServer(["index.html"]);
    expect((await get(s, "/open")).status).toBe(404);
    expect((await get(s, "/teams")).status).toBe(404);
    await expectNotBuilt(await get(s, "/"));
    await expectPage(await get(s, "/dashboard"), "index.html");
  });

  test("a self-hosted page whose file is missing answers 404, and / then answers the not-built page", async () => {
    const s = selfHosted(["open.html"]);
    expect((await get(s, "/index.html")).status).toBe(404);
    await expectNotBuilt(await get(s, "/"));
    await expectPage(await get(s, "/open"), "open.html");
  });

  test("an asset keeps its long cache", async () => {
    const res = await get(hostedServer(), "/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("assets/app.js");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a demo start has the pages of a self-hosted server", async () => {
    const s = demo();
    await expectPage(await get(s, "/"), "index.html");
    await expectPage(await get(s, "/open"), "open.html");
    expect((await get(s, "/teams")).status).toBe(404);
  });

  test("pagesOf gives each mode exactly its table", () => {
    expect(pagesOf("hosted")).toEqual(HOSTED_PAGES);
    expect(pagesOf("self-hosted")).toEqual(SELF_HOSTED_PAGES);
  });
});
