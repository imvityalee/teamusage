import { beforeEach, expect, test } from "vitest";
import { grantRole, hostedTeam } from "./hosted.fixture.js";
import { roleIn, type UserTeam } from "./hosted-teams.js";
import { asUser, everythingOf, expectAnswer, FAY, manageWorld, ownedBy, PEOPLE, roleRows, userRows, type ManagedTeam, type ManageWorld, type Who } from "./manage.fixture.js";
import { listRoles } from "./team-roles.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
  grantRole(w.db, w.B.id, FAY, "admin");
});

const post = (who: Who, path: string, body: unknown) => asUser(w, who, path, { method: "POST", body });
const ownerPath = (team: { publicId: string }) => `/api/teams/${team.publicId}/owner`;
const handOver = (who: Who, team: ManagedTeam, body: unknown) => post(who, ownerPath(team), body);
const roleOf = (teamId: number, githubId: number) => roleIn(w.db, teamId, githubId);
const unchanged = () => ({ b: everythingOf(w.db, w.B.id), a: everythingOf(w.db, w.A.id), users: userRows(w.db) });

test("handing over: the admin becomes the owner and the owner an admin, and only one of two handovers sent together goes through", async () => {
  const answers = await Promise.all([post("bob", `/api/teams/${w.B.publicId}/owner`, { user: 3303 }), post("bob", `/api/teams/${w.B.publicId}/owner`, { user: 7707 })]);
  expect(answers.map((r) => r.status).sort()).toEqual([204, 403]);
  expect(listRoles(w.db, w.B.id).filter((r) => r.role === "owner")).toHaveLength(1);
  expect(roleOf(w.B.id, 2202)).toBe("admin");
});
test("after a handover the previous owner can no longer set dashboard access and the new owner can; A's roles stay", async () => {
  const rolesA = roleRows(w.db, w.A.id);
  const res = await handOver("bob", w.B, { user: 3303 });
  expect(res.status).toBe(204);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const access = (who: Who) => asUser(w, who, `/api/teams/${w.B.publicId}`, { method: "PATCH", body: { dashboardAccess: "admins" } });
  await expectAnswer(await access("bob"), 403, "your role does not allow this");
  expect((await access("cyd")).status).toBe(200);
  expect([roleOf(w.B.id, 3303), roleOf(w.B.id, 2202), roleOf(w.B.id, 7707)]).toEqual(["owner", "admin", "admin"]);
  expect(roleRows(w.db, w.A.id)).toEqual(rolesA);
});

test("handing over to a viewer, to someone with no role, to the owner themself or to an id with no users row is 409 and changes nothing", async () => {
  const before = unchanged();
  for (const user of [4404, 6606, 1101, 5505, 2202, 9909]) {
    await expectAnswer(await handOver("bob", w.B, { user }), 409, "ownership goes to an admin of this team");
  }
  expect(unchanged()).toEqual(before);
});
test("handing over to an admin who owns 5 teams is 409 and changes nothing", async () => {
  for (let i = 0; i < 5; i++) hostedTeam(w.db, PEOPLE.cyd, "members", `cyd ${i}`);
  const before = unchanged();
  await expectAnswer(await handOver("bob", w.B, { user: 3303 }), 409, "that user already owns 5 teams");
  expect(unchanged()).toEqual(before);
});
test("an admin or a viewer calling it gets 403, and a user with no role in the team the 404 of a team that does not exist", async () => {
  const before = unchanged();
  await expectAnswer(await handOver("cyd", w.B, { user: 7707 }), 403, "your role does not allow this");
  await expectAnswer(await handOver("dee", w.B, { user: 3303 }), 403, "your role does not allow this");
  for (const who of ["ann", "zoe", "eve"] as const) await expectAnswer(await handOver(who, w.B, { user: 3303 }), 404, "team not found");
  await expectAnswer(await post("bob", ownerPath({ publicId: "0123456789abcdef" }), { user: 3303 }), 404, "team not found");
  expect(unchanged()).toEqual(before);
});
test("every refused body is 400 and changes nothing", async () => {
  const before = unchanged();
  const refused: [unknown, string][] = [
    ...[0, -1, 1.5, "3303", null, true, 2 ** 53].map((user): [unknown, string] => [{ user }, "invalid user"]),
    [{}, "invalid user"],
    ["{not json", "invalid JSON body"],
    ["[]", "body must be an object"],
  ];
  for (const [body, error] of refused) await expectAnswer(await handOver("bob", w.B, body), 400, error);
  expect(unchanged()).toEqual(before);
});
test("two handovers to an admin who owns 4 teams, sent together: one goes through, the other is refused, and they own 5", async () => {
  for (let i = 0; i < 4; i++) hostedTeam(w.db, PEOPLE.cyd, "members", `cyd ${i}`);
  const other = hostedTeam(w.db, PEOPLE.bob, "members", "Bob's second").team;
  grantRole(w.db, other.id, PEOPLE.cyd, "admin");
  const teams = [w.B, other];
  const answers = await Promise.all(teams.map((team) => post("bob", ownerPath(team), { user: 3303 })));
  expect(answers.map((r) => r.status).sort()).toEqual([204, 409]);
  const refused = answers.findIndex((r) => r.status === 409);
  expect(await answers[refused]!.json()).toEqual({ error: "that user already owns 5 teams" });
  expect(ownedBy(w.db, 3303)).toBe(5);
  expect(roleOf(teams[refused]!.id, 2202)).toBe("owner");
  expect(roleOf(teams[1 - refused]!.id, 2202)).toBe("admin");
  const me = (await (await asUser(w, "bob", "/api/me")).json()) as { teams: UserTeam[] };
  expect(me.teams.find((t) => t.id === teams[1 - refused]!.publicId)?.role).toBe("admin");
  await expectAnswer(await post("cyd", "/api/teams", { name: "Sixth", dashboardAccess: "members" }), 409, "you already own 5 teams");
});
