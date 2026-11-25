import { beforeEach, expect, test } from "vitest";
import { createApp } from "./app.js";
import { openDb, type Db } from "./db.js";
import { createHostedTeam } from "./hosted-teams.js";
import { cookieOf, hostedApp, KEY, PUBLIC, signIn } from "./hosted.fixture.js";
import { createTeamSession } from "./sessions.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
beforeEach(() => {
  ({ db, app } = hostedApp());
});

const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });
const logout = (headers: Record<string, string>) => app.request("/api/logout", { method: "POST", headers });
const acme = () =>
  createHostedTeam(db, { name: "Acme", dashboardAccess: "admins", owner: { githubId: 1, login: "ann" }, codeKey: KEY, maxTeams: 200 }).team;

test("logout needs the server's own origin and ends the session", async () => {
  const cookie = await signIn(app, "code-ann");
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
  expect((await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(403);
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
test("logout ends a team's session too and expires the cookie", async () => {
  const cookie = `tu_session=${createTeamSession(db, acme().id)}`;
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
    login: "ann",
    teams: [{ id: team.publicId, name: "Acme", role: "owner", dashboardAccess: "admins" }],
  });
});
test("me names the team of a team's session by its public id", async () => {
  const team = acme();
  const res = await me(`tu_session=${createTeamSession(db, team.id)}`);
  expect(await res.json()).toEqual({ kind: "team", team: { id: team.publicId, name: "Acme" } });
});
test("a team's session whose team is gone is 401", async () => {
  const cookie = `tu_session=${createTeamSession(db, acme().id)}`;
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
  expect(answers.map((r) => r.status)).toEqual([302, 502, 302, 400, 403, 204, 401, 200]);
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
