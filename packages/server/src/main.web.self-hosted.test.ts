import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import { cookieOf } from "./hosted.fixture.js";
import { atVersion } from "./migrations/earlier-version.fixture.js";
import { conn, serverConfig, tempDataDir, webWith } from "./main.fixture.js";
import { closedAfterTest, getWith, TODAY } from "./main.web.fixture.js";
import { buildServer } from "./main.js";

// Review Focus 5: a self-hosted server that upgrades keeps its dashboard, its sign-in and its signed-in browsers, and
// gains no hosted page or route.

const RANGE = `from=2026-11-01&to=${TODAY}`;
const PUBLIC_URL = "http://10.0.0.5:8787";

/**
 * A data directory whose database the upgrade steps up to version 8 made, then used by a self-hosted server through its
 * routes: a machine registered and a browser signed in with the code. Returns the directory, the code and that browser's cookie.
 */
async function selfHostedInUseAt8(): Promise<{ dir: string; inviteCode: string; browser: string }> {
  const dir = tempDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atVersion(8, join(dir, "teamusage.sqlite")).close();
  const first = buildServer(serverConfig({ dataDir: dir }));
  try {
    const inviteCode = first.inviteCode!();
    const send = (path: string, body: unknown) => first.app.request(path, { method: "POST", body: JSON.stringify(body) }, conn);
    expect((await send("/api/register", goodReg({ inviteCode }))).status).toBe(200);
    const login = await send("/api/login", { inviteCode });
    expect(login.status).toBe(204);
    return { dir, inviteCode, browser: cookieOf(login, "tu_session") };
  } finally {
    first.close();
  }
}

/** Signs in with the invite code, sending `origin` when it is given. */
const login = (s: ReturnType<typeof buildServer>, inviteCode: string, origin?: string) =>
  s.app.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ inviteCode }),
    headers: origin === undefined ? {} : { Origin: origin },
  }, conn);

describe("a self-hosted server started again on a database of version 8 that holds a browser signed in with the code", () => {
  test("serves the dashboard at /, keeps the browser signed in, has no hosted page or demo route, and signs in with no Origin", async () => {
    const { dir, inviteCode, browser } = await selfHostedInUseAt8();
    const s = closedAfterTest(buildServer(serverConfig({ dataDir: dir }), { webRoot: webWith(["index.html", "open.html", "teams.html"]) }));
    const home = await getWith(s, "/");
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("index.html");
    expect((await getWith(s, `/api/stats?${RANGE}`, browser)).status).toBe(200);
    expect((await getWith(s, "/teams")).status).toBe(404);
    expect((await getWith(s, `/api/demo/stats?${RANGE}`)).status).toBe(404);
    expect((await login(s, inviteCode)).status).toBe(204);
  });

  test("with publicUrl set, the same sign-in needs that Origin, and the browser stays signed in", async () => {
    const { dir, inviteCode, browser } = await selfHostedInUseAt8();
    const s = closedAfterTest(buildServer(serverConfig({ dataDir: dir, publicUrl: PUBLIC_URL })));
    const refused = await login(s, inviteCode);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "cross-site request refused" });
    expect((await login(s, inviteCode, "http://10.0.0.6:8787")).status).toBe(403);
    expect((await login(s, inviteCode, PUBLIC_URL)).status).toBe(204);
    expect((await getWith(s, `/api/stats?${RANGE}`, browser)).status).toBe(200);
  });
});
