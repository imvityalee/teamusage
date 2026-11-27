import { beforeEach, expect, test } from "vitest";
import { grantRole, PUBLIC } from "./hosted.fixture.js";
import { roleIn } from "./hosted-teams.js";
import {
  asUser,
  everythingOf,
  expectAnswer,
  FAY,
  manageWorld,
  notGithubSessions,
  PEOPLE,
  roleRows,
  send,
  userRow as userRowOf,
  userRows,
  type ManagedTeam,
  type ManageWorld,
  type Who,
} from "./manage.fixture.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
  grantRole(w.db, w.B.id, FAY, "admin");
});

const as = (who: Who, path: string) => asUser(w, who, path);
const del = (who: Who, path: string) => asUser(w, who, path, { method: "DELETE" });
const rolePath = (team: ManagedTeam, who: string) => `/api/teams/${team.publicId}/roles/${who}`;
const userRow = (githubId: number) => userRowOf(w.db, githubId);

test("owner and admins see who has a role; a viewer does not", async () => {
  expect(await (await as("cyd", `/api/teams/${w.B.publicId}/roles`)).json()).toEqual({
    roles: [
      { githubId: 2202, login: "bob", role: "owner", since: expect.any(String) },
      { githubId: 3303, login: "cyd", role: "admin", since: expect.any(String) },
      { githubId: 7707, login: "fay", role: "admin", since: expect.any(String) },
      { githubId: 4404, login: "dee", role: "viewer", since: expect.any(String) },
    ],
  });
  expect((await as("dee", `/api/teams/${w.B.publicId}/roles`)).status).toBe(403);
});
test("the owner removes an admin, who is refused at their next request and keeps their GitHub session", async () => {
  const rolesA = roleRows(w.db, w.A.id);
  expect((await as("cyd", `/api/teams/${w.B.publicId}/members`)).status).toBe(200);
  expect((await del("bob", `/api/teams/${w.B.publicId}/roles/3303`)).status).toBe(204);
  expect((await as("cyd", `/api/teams/${w.B.publicId}/members`)).status).toBe(404);
  expect(await (await as("cyd", "/api/me")).json()).toEqual({ kind: "user", githubId: PEOPLE.cyd.githubId, login: "cyd", teams: [] });
  expect(userRow(3303)).toBeUndefined();                              // no role left anywhere
  expect(roleRows(w.db, w.A.id)).toEqual(rolesA);
});

test("an admin and a viewer leave; the owner cannot", async () => {
  for (const [who, id] of [["cyd", "3303"], ["dee", "4404"]] as const) {
    const res = await del(who, rolePath(w.B, id));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(userRow(Number(id))).toBeUndefined();
  }
  await expectAnswer(await del("bob", rolePath(w.B, "2202")), 409, "the owner cannot leave; hand the team over or delete it");
  expect(roleIn(w.db, w.B.id, 2202)).toBe("owner");
});
test("an admin or a viewer removing someone else gets 403 whether that user has a role or not, and nothing is removed", async () => {
  const before = { b: everythingOf(w.db, w.B.id), users: userRows(w.db) };
  const others: [Who, string[]][] = [
    ["cyd", ["7707", "2202", "4404", "1101", "9909"]],                // another admin, the owner, a viewer, no role, no users row
    ["dee", ["3303", "2202", "1101", "6606", "9909"]],
  ];
  for (const [who, ids] of others) {
    for (const id of ids) await expectAnswer(await del(who, rolePath(w.B, id)), 403, "your role does not allow this");
  }
  expect({ b: everythingOf(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
});
test("the owner removing a user with no role in the team, or a :user that is not a GitHub id, gets 404 role not found", async () => {
  const before = { a: roleRows(w.db, w.A.id), b: roleRows(w.db, w.B.id), users: userRows(w.db) };
  for (const id of ["6606", "1101", "9909", "abc", "1.5", "-3", "3303x", "99999999999999999999"]) {
    await expectAnswer(await del("bob", rolePath(w.B, id)), 404, "role not found");
  }
  expect({ a: roleRows(w.db, w.A.id), b: roleRows(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
});
test("a team the caller has no role in answers as a team that does not exist, before the :user is read", async () => {
  const none = "/api/teams/0123456789abcdef/roles";
  for (const res of [await as("bob", `/api/teams/${w.A.publicId}/roles`), await as("bob", none)]) await expectAnswer(res, 404, "team not found");
  for (const id of ["6606", "abc"]) {
    await expectAnswer(await del("bob", rolePath(w.A, id)), 404, "team not found");
    await expectAnswer(await del("eve", rolePath(w.B, id)), 404, "team not found");
  }
  expect(roleIn(w.db, w.A.id, 6606)).toBe("viewer");
});
test("a user with a role in two teams keeps their users row when one is removed", async () => {
  grantRole(w.db, w.B.id, PEOPLE.zoe, "viewer");
  const row = userRow(6606);
  expect((await del("bob", rolePath(w.B, "6606"))).status).toBe(204);
  expect(userRow(6606)).toEqual(row);
  expect(roleIn(w.db, w.A.id, 6606)).toBe("viewer");
});

test("no credential, a machine token and a member's session get 401 on the three routes; the changing two refuse another Origin", async () => {
  const before = { b: everythingOf(w.db, w.B.id), users: userRows(w.db) };
  const routes: [string, string, unknown][] = [
    ["GET", `/api/teams/${w.B.publicId}/roles`, undefined],
    ["DELETE", rolePath(w.B, "3303"), undefined],
    ["POST", `/api/teams/${w.B.publicId}/owner`, { user: 3303 }],
  ];
  for (const [method, path, body] of routes) {
    for (const headers of notGithubSessions(w)) await expectAnswer(await send(w, method, path, body, { ...headers, Origin: PUBLIC }), 401, "unauthorized");
  }
  for (const [method, path, body] of routes.slice(1)) {
    for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
      await expectAnswer(await send(w, method, path, body, { ...origin, Cookie: w.cookies.bob }), 403, "cross-site request refused");
    }
  }
  expect({ b: everythingOf(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
});
