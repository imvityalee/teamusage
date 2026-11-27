import { beforeEach, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import { createApp } from "./app.js";
import { openDb, type Db } from "./db.js";
import { createHostedTeam } from "./hosted-teams.js";
import { hostedApp, KEY, postFromPage, PUBLIC, signIn } from "./hosted.fixture.js";
import { createTeamSession } from "./sessions.js";
import { authenticate } from "./team-data.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
beforeEach(() => {
  ({ db, app } = hostedApp());
});

const create = (cookie: string, body: unknown, origin = PUBLIC, a = app) =>
  a.request("/api/teams", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
  });
const good = { name: "Acme", dashboardAccess: "members" };
const teamCount = () => db.prepare("select count(*) as n from teams").get();

test("a signed-in user creates a team, owns it, and is given its code once", async () => {
  const cookie = await signIn(app, "code-ann");
  const res = await create(cookie, { name: "  Acme  ", dashboardAccess: "members" });
  expect(res.status).toBe(201);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { team: { id: string; name: string; role: string; dashboardAccess: string }; code: string };
  expect(body.team).toMatchObject({ name: "Acme", role: "owner", dashboardAccess: "members" });
  expect(body.code).toMatch(/^[a-f0-9]{24}$/);
  const me = (await (await app.request("/api/me", { headers: { Cookie: cookie } })).json()) as { teams: unknown[] };
  expect(me.teams).toEqual([{ id: body.team.id, name: "Acme", role: "owner", dashboardAccess: "members" }]);
});
test("a team created for its admins only says so in the answer and in /api/me", async () => {
  const cookie = await signIn(app, "code-ann");
  const res = await create(cookie, { name: "Acme", dashboardAccess: "admins" });
  expect(res.status).toBe(201);
  const { team } = (await res.json()) as { team: { id: string; dashboardAccess: string } };
  expect(team.dashboardAccess).toBe("admins");
  const me = (await (await app.request("/api/me", { headers: { Cookie: cookie } })).json()) as { teams: unknown[] };
  expect(me.teams).toEqual([{ id: team.id, name: "Acme", role: "owner", dashboardAccess: "admins" }]);
});
test("the response carries the public id, never the internal one, and the code joins the team", async () => {
  const res = await create(await signIn(app, "code-ann"), good);
  const { team, code } = (await res.json()) as { team: { id: string }; code: string };
  const row = db.prepare("select id, public_id as publicId from teams").get() as { id: number; publicId: string };
  expect(team.id).toBe(row.publicId);
  expect(Object.keys(team).sort()).toEqual(["dashboardAccess", "id", "name", "role"]);
  const joined = await postFromPage(app, "/api/register", goodReg({ inviteCode: code }));
  expect(joined.status).toBe(200);
  expect(authenticate(db, ((await joined.json()) as { token: string }).token)?.teamId).toBe(row.id);
});
test("a name of 60 characters once trimmed is accepted", async () => {
  const res = await create(await signIn(app, "code-ann"), { name: ` ${"x".repeat(60)} `, dashboardAccess: "members" });
  expect(res.status).toBe(201);
});
test.each([
  [{ dashboardAccess: "members" }, "invalid name"],
  [{ name: "", dashboardAccess: "members" }, "invalid name"],
  [{ name: "   ", dashboardAccess: "members" }, "invalid name"],
  [{ name: 7, dashboardAccess: "members" }, "invalid name"],
  [{ name: "x".repeat(61), dashboardAccess: "members" }, "invalid name"],
  [{ name: "A\nB", dashboardAccess: "members" }, "invalid name"],
  [{ name: "Acme" }, "invalid dashboardAccess"],
  [{ name: "Acme", dashboardAccess: "everyone" }, "invalid dashboardAccess"],
  [{ name: "Acme", dashboardAccess: "code" }, "invalid dashboardAccess"],
])("a bad body %j is refused and creates nothing", async (body, error) => {
  const res = await create(await signIn(app, "code-ann"), body);
  expect(res.status).toBe(400);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error });
  expect(teamCount()).toEqual({ n: 0 });
});
test("a body that is not JSON or not an object is refused", async () => {
  const cookie = await signIn(app, "code-ann");
  const raw = (body: string) =>
    app.request("/api/teams", { method: "POST", body, headers: { "Content-Type": "application/json", Cookie: cookie, Origin: PUBLIC } });
  expect(await (await raw("{nope")).json()).toEqual({ error: "invalid JSON body" });
  expect(await (await raw("[1]")).json()).toEqual({ error: "body must be an object" });
  expect(teamCount()).toEqual({ n: 0 });
});
test("it needs a GitHub session and the server's own origin", async () => {
  const cookie = await signIn(app, "code-ann");
  const noSession = await create("", good);
  expect(noSession.status).toBe(401);
  expect(await noSession.json()).toEqual({ error: "unauthorized" });
  const foreign = await create(cookie, good, "https://evil.example");
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toEqual({ error: "cross-site request refused" });
  expect(foreign.headers.get("cache-control")).toBe("no-store");
  expect(teamCount()).toEqual({ n: 0 });
});
test("an expired user session is 401", async () => {
  const cookie = await signIn(app, "code-ann");
  db.prepare("update sessions set created_at = '2000-01-01T00:00:00.000Z'").run();
  expect((await create(cookie, good)).status).toBe(401);
  expect(teamCount()).toEqual({ n: 0 });
});
test("a code session from before this server refused them is 401", async () => {
  const { team } = createHostedTeam(db, { name: "Old", dashboardAccess: "members", owner: { githubId: 9, login: "zed" }, codeKey: KEY, maxTeams: 200 });
  const res = await create(`tu_session=${createTeamSession(db, team.id)}`, good);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(teamCount()).toEqual({ n: 1 });
});
test("where two refusals overlap, the origin comes before the session, and the session before the body", async () => {
  const cookie = await signIn(app, "code-ann");
  expect((await create("", good, "https://evil.example")).status).toBe(403);
  expect((await create(cookie, { name: "" }, "https://evil.example")).status).toBe(403);
  expect((await create("", { name: "" })).status).toBe(401);
});
test("a sixth team is refused with 409, a full server with 503", async () => {
  const cookie = await signIn(app, "code-ann");
  for (let i = 1; i <= 5; i++) expect((await create(cookie, { name: `T${i}`, dashboardAccess: "members" })).status).toBe(201);
  const sixth = await create(cookie, good);
  expect(sixth.status).toBe(409);
  expect(sixth.headers.get("cache-control")).toBe("no-store");
  expect(await sixth.json()).toEqual({ error: "you already own 5 teams" });

  const small = hostedApp({ maxTeams: 1 });
  expect((await create(await signIn(small.app, "code-ann"), good, PUBLIC, small.app)).status).toBe(201);
  const full = await create(await signIn(small.app, "code-bob"), good, PUBLIC, small.app);
  expect(full.status).toBe(503);
  expect(full.headers.get("cache-control")).toBe("no-store");
  expect(await full.json()).toEqual({ error: "sign-ups are paused" });
});
test("an error that is not a limit passes on as a 500 and creates nothing", async () => {
  const logged: string[] = [];
  const broken = hostedApp({ logError: (line) => logged.push(line) });
  broken.db.exec("create trigger boom before insert on teams begin select raise(abort, 'x'); end;");
  const res = await create(await signIn(broken.app, "code-ann"), good, PUBLIC, broken.app);
  expect(res.status).toBe(500);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: "internal error" });
  expect(broken.db.prepare("select count(*) as n from teams").get()).toEqual({ n: 0 });
  expect(logged).toHaveLength(1);
});
test("self-hosted, the route does not exist", async () => {
  const plain = createApp(openDb(":memory:"), { teamForCode: () => null });
  const res = await plain.request("/api/teams", { method: "POST", body: "{}", headers: { Origin: PUBLIC } });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});
