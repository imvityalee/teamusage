import { beforeEach, expect, test } from "vitest";
import { dashboardLinkToken, heldRequest, postFromPage, PUBLIC, settle } from "./hosted.fixture.js";
import { asUser, manageWorld, RANGE, removeRoleRow, teamRow, type Machine, type ManagedTeam, type ManageWorld, type Who } from "./manage.fixture.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const as = (who: Who, path: string) => asUser(w, who, path);
const patch = (who: Who, team: ManagedTeam, body: unknown) => asUser(w, who, `/api/teams/${team.publicId}`, { method: "PATCH", body });
const stats = (session: string) => w.app.request(`/api/stats?${RANGE}`, { headers: { Cookie: session } });
const linkToken = (machine: Machine) => dashboardLinkToken(w.app, machine.token);
const open = (token: string) => postFromPage(w.app, "/api/dashboard-link/open", { token });

test("the owner, an admin and a viewer read their team; each sees their own role", async () => {
  for (const [who, role] of [["bob", "owner"], ["cyd", "admin"], ["dee", "viewer"]] as const) {
    const res = await as(who, `/api/teams/${w.B.publicId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ team: { id: w.B.publicId, name: w.B.name, role, dashboardAccess: "members" } });
  }
});
test("a team the caller has no role in, a team that does not exist and a malformed id get one answer", async () => {
  for (const who of ["ann", "zoe", "eve"] as const) {
    const [real, none, bad] = [await as(who, `/api/teams/${w.B.publicId}`), await as(who, "/api/teams/0123456789abcdef"), await as(who, "/api/teams/1")];
    for (const res of [real, none, bad]) expect(res.status).toBe(404);
    expect([...real.headers]).toEqual([...none.headers]);
    expect([...real.headers]).toEqual([...bad.headers]);
    const texts = [await real.text(), await none.text(), await bad.text()];
    expect(texts).toEqual(Array(3).fill('{"error":"team not found"}'));
  }
});
test("an admin renames the team; only the owner sets dashboard access, and an admin's attempt changes nothing", async () => {
  const rowA = teamRow(w.db, w.A.id);
  expect(await (await patch("cyd", w.B, { name: "  Borealis Ёж 🦔  " })).json()).toEqual({ team: { id: w.B.publicId, name: "Borealis Ёж 🦔", role: "admin", dashboardAccess: "members" } });
  const refused = await patch("cyd", w.B, { name: "Mine now", dashboardAccess: "admins" });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "your role does not allow this" });
  expect(teamRow(w.db, w.B.id)).toMatchObject({ name: "Borealis Ёж 🦔", dashboard_access: "members" });
  expect(teamRow(w.db, w.A.id)).toEqual(rowA);
});
test("switching to admins signs the team's members out and drops their links; switching back does not sign them in again", async () => {
  const pending = await linkToken(w.B.sam.one);
  expect((await patch("bob", w.B, { dashboardAccess: "admins" })).status).toBe(200);
  expect((await stats(w.B.sam.session)).status).toBe(401);
  expect((await stats(w.A.memberSession)).status).toBe(200);           // another team's member stays signed in
  expect((await as("dee", `/api/stats?${RANGE}&team=${w.B.publicId}`)).status).toBe(200);
  expect((await patch("bob", w.B, { dashboardAccess: "members" })).status).toBe(200);
  expect((await stats(w.B.sam.session)).status).toBe(401);
  expect((await open(pending)).status).toBe(403);
});

test("the owner changes the name and the access in one request; the answer is the team as GET gives it", async () => {
  const res = await patch("bob", w.B, { name: "Boreal", dashboardAccess: "admins" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const team = { id: w.B.publicId, name: "Boreal", role: "owner", dashboardAccess: "admins" };
  expect(await res.json()).toEqual({ team });
  expect(await (await as("bob", `/api/teams/${w.B.publicId}`)).json()).toEqual({ team });
});
test("setting the access the team already has changes nothing else: its members stay signed in and a pending link still opens", async () => {
  const pending = await linkToken(w.B.tia.one);
  expect((await patch("bob", w.B, { dashboardAccess: "members" })).status).toBe(200);
  expect((await stats(w.B.sam.session)).status).toBe(200);
  expect((await stats(w.B.tia.session)).status).toBe(200);
  expect((await open(pending)).status).toBe(204);
});
test("a name of 60 characters once trimmed is accepted; every other refused body is 400 and changes nothing", async () => {
  const sixty = "N".repeat(60);
  expect((await patch("cyd", w.B, { name: ` ${sixty}  ` })).status).toBe(200);
  expect(teamRow(w.db, w.B.id)).toMatchObject({ name: sixty });
  const before = teamRow(w.db, w.B.id);
  const refused: [unknown, string][] = [
    [{ name: "N".repeat(61) }, "invalid name"],
    [{ name: "" }, "invalid name"],
    [{ name: "Bore\u0007alis" }, "invalid name"],
    [{ name: 42 }, "invalid name"],
    [{ name: "N".repeat(61), dashboardAccess: "admins" }, "invalid name"],
    [{ name: "Fine", dashboardAccess: "everyone" }, "invalid dashboardAccess"],
    [{}, "nothing to change"],
    ["{not json", "invalid JSON body"],
    ["[]", "body must be an object"],
    ['"Borealis"', "body must be an object"],
  ];
  for (const [body, error] of refused) {
    const res = await patch("bob", w.B, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(await res.json()).toEqual({ error });
  }
  expect(teamRow(w.db, w.B.id)).toEqual(before);
});
test("no credential, each machine's token and a member's session are 401 on both routes", async () => {
  const machines = [...w.A.members.map((m) => m.one), w.B.sam.one, w.B.sam.two, w.B.tia.one];
  const credentials = [
    {},
    ...machines.map((m) => ({ Authorization: `Bearer ${m.token}` })),
    ...[w.A.memberSession, w.B.sam.session, w.B.tia.session].map((session) => ({ Cookie: session })),
  ];
  const before = teamRow(w.db, w.B.id);
  for (const headers of credentials) {
    for (const method of ["GET", "PATCH"]) {
      const body = method === "PATCH" ? JSON.stringify({ name: "Taken" }) : undefined;
      const res = await w.app.request(`/api/teams/${w.B.publicId}`, { method, body, headers: { "Content-Type": "application/json", Origin: PUBLIC, ...headers } });
      expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  }
  expect(teamRow(w.db, w.B.id)).toEqual(before);
});
test("a viewer's PATCH is 403 and changes nothing", async () => {
  const before = teamRow(w.db, w.B.id);
  for (const body of [{ name: "Viewed" }, { dashboardAccess: "admins" }]) {
    const res = await patch("dee", w.B, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "your role does not allow this" });
  }
  expect(teamRow(w.db, w.B.id)).toEqual(before);
});
test("a PATCH without the server's Origin is 403 and changes nothing", async () => {
  const before = teamRow(w.db, w.B.id);
  const origins: Record<string, string>[] = [{}, { Origin: "https://elsewhere.example" }];
  for (const origin of origins) {
    const res = await w.app.request(`/api/teams/${w.B.publicId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Elsewhere", dashboardAccess: "admins" }),
      headers: { "Content-Type": "application/json", Cookie: w.cookies.bob, ...origin },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "cross-site request refused" });
  }
  expect(teamRow(w.db, w.B.id)).toEqual(before);
});
test("the role is read after the body: an admin whose role goes while the body is read renames nothing", async () => {
  const held = heldRequest(w.app, `/api/teams/${w.B.publicId}`, {
    method: "PATCH",
    text: JSON.stringify({ name: "Mine now" }),
    headers: { "Content-Type": "application/json", Cookie: w.cookies.cyd, Origin: PUBLIC },
  });
  await settle();                                                     // the handler now waits for the body
  removeRoleRow(w, "cyd");
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "team not found" });
  expect(teamRow(w.db, w.B.id)).toMatchObject({ name: w.B.name });
});
