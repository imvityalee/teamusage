import { beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { openDb, type Db } from "./db.js";
import { cookieOf, hostedApp, hostedTeam, machineClient, memberSignIn, PUBLIC, signIn } from "./hosted.fixture.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
beforeEach(() => {
  ({ db, app } = hostedApp());
});

const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });
const logout = (headers: Record<string, string>) => app.request("/api/logout", { method: "POST", headers });
const acme = () => hostedTeam(db, { githubId: 1, login: "ann" }, "admins", "Acme").team;
/** Signs in the member of a team whose members see it, from the member's machine; returns the session cookie. */
async function memberOfTeam(): Promise<string> {
  const { code } = hostedTeam(db, { githubId: 2, login: "bob" }, "members", "Bobcat");
  return memberSignIn(app, await machineClient(() => app, () => code).join());
}

test("logout needs the server's own origin and ends the session", async () => {
  const cookie = await signIn(app, "code-ann");
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(403);
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: "null" } })).status).toBe(403);
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: PUBLIC } })).status).toBe(204);
  expect((await app.request("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
});
test("a cross-site logout is refused before the session is touched", async () => {
  const cookie = await signIn(app, "code-ann");
  const res = await logout({ Cookie: cookie, Origin: `${PUBLIC}.evil.example` });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "cross-site request refused" });
  expect(res.headers.get("set-cookie")).toBeNull();
  expect((await me(cookie)).status).toBe(200);
});
test("logout ends a member's session too and expires the cookie", async () => {
  const cookie = await memberOfTeam();
  expect((await me(cookie)).status).toBe(200);
  const res = await logout({ Cookie: cookie, Origin: PUBLIC });
  expect(res.status).toBe(204);
  expect(res.headers.get("set-cookie")).toMatch(/^tu_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/);
  expect((await me(cookie)).status).toBe(401);
});
test("logout without a session is still 204", async () => {
  expect((await logout({ Origin: PUBLIC })).status).toBe(204);
  expect((await logout({ Origin: PUBLIC, Cookie: "tu_session=unknown" })).status).toBe(204);
});
test("me without a valid session is 401", async () => {
  for (const cookie of ["", "tu_session=unknown", "tu_session="]) {
    const res = await me(cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }
});
test("me lists the teams a signed-in user has a role in", async () => {
  const team = acme();
  const res = await me(await signIn(app, "code-ann"));
  expect(await res.json()).toEqual({
    kind: "user",
    githubId: 1,
    login: "ann",
    teams: [{ id: team.publicId, name: "Acme", role: "owner", dashboardAccess: "admins" }],
  });
});
test("a member's session whose team is gone is 401", async () => {
  const cookie = await memberOfTeam();
  // Without the cascade the session row outlives its team, as it would if a deletion missed it.
  db.pragma("foreign_keys = OFF");
  db.prepare("delete from teams").run();
  expect((await me(cookie)).status).toBe(401);
});
test("every answer of the sign-in routes is no-store", async () => {
  const start = await app.request("/auth/github/start");
  const callback = (q: string, cookie = cookieOf(start, "tu_oauth")) =>
    app.request(`/auth/github/callback?${q}`, { headers: { Cookie: cookie } });
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const answers = [
    start,
    await callback(`code=unknown&state=${state}`),
    await callback(`code=code-ann&state=${state}`),
    await callback(`code=code-ann&state=${state}`, ""),
    await logout({}),
    await logout({ Origin: PUBLIC }),
    await me(""),
    await me(await signIn(app, "code-ann")),
  ];
  expect(answers.map((r) => r.status)).toEqual([302, 302, 302, 302, 403, 204, 401, 200]);
  for (const r of answers) expect(r.headers.get("cache-control")).toBe("no-store");
});
test("a self-hosted server has none of these routes", async () => {
  const selfHosted = createApp(openDb(":memory:"), { teamForCode: () => null });
  const answers = [
    await selfHosted.request("/auth/github/start"),
    await selfHosted.request("/auth/github/callback?code=code-ann&state=s", { headers: { Cookie: "tu_oauth=s.v" } }),
    await selfHosted.request("/api/me"),
    await selfHosted.request("/api/logout", { method: "POST", headers: { Origin: PUBLIC } }),
  ];
  for (const r of answers) {
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not found" });
  }
});
