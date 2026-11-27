import { beforeEach, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { teamByPublicId } from "./hosted-teams.js";
import { dashboardLinkToken, grantRole, heldRequest, heldUpload, machineIdOf, postFromPage, PUBLIC, recordsOf, settle, testCaps, testLimits } from "./hosted.fixture.js";
import {
  asUser,
  deleteAs,
  deletePath,
  everythingOf,
  expectAnswer,
  manageWorld,
  newInvite,
  notGithubSessions,
  PEOPLE,
  RANGE,
  send,
  teamRow as teamRowOf,
  usageRowsOf,
  userRow as userRowOf,
  type ManagedTeam,
  type ManageWorld,
  type Who,
} from "./manage.fixture.js";
import { NEWCOMER, pacedWorld, registerAs, registration, statsAs, uploadAs, type PacedWorld } from "./manage.requests.fixture.js";
import { handOver } from "./team-roles.js";

const NAME_DOES_NOT_MATCH = "the name does not match";
const ROLE_NOT_ALLOWED = "your role does not allow this";
/** A team name with letters that Unicode composes, as stored (NFC) and as some keyboards send it (NFD). */
const CAFE = "Café Ёж";
const CAFE_NFD = CAFE.normalize("NFD");

let w: PacedWorld;
beforeEach(async () => {
  w = await pacedWorld();
});

const as = (who: Who, path: string) => asUser(w, who, path);
const post = (who: Who, path: string, body: unknown) => asUser(w, who, path, { method: "POST", body });
const inviteToken = async (who: Who, team: ManagedTeam, role: "admin" | "viewer") => (await newInvite(w, who, team, role)).token;
const linkToken = (token: string) => dashboardLinkToken(w.app, token);
const countOf = (table: string, teamId: number) => (w.db.prepare(`select count(*) as n from ${table} where team_id = ?`).get(teamId) as { n: number }).n;
const teamRow = (teamId: number) => teamRowOf(w.db, teamId);
const userRow = (githubId: number) => userRowOf(w.db, githubId);
const usageRows = (teamId: number) => usageRowsOf(w.db, teamId);
const rowsOfModel = (model: string) => w.db.prepare("select * from usage where model = ?").all(model);
const createAs = (v: ManageWorld, who: Who, name: string) => asUser(v, who, "/api/teams", { method: "POST", body: { name, dashboardAccess: "members" } });
/** The id, public id and code of the team a creation answered with. */
async function created(v: ManageWorld, res: Response): Promise<{ id: number; publicId: string; code: string }> {
  expect(res.status).toBe(201);
  const body = (await res.json()) as { team: { id: string }; code: string };
  return { id: teamByPublicId(v.db, body.team.id)!.id, publicId: body.team.id, code: body.code };
}

test("the owner deletes the team: everything that was the team's is gone at once, and the other team has everything", async () => {
  await inviteToken("bob", w.B, "admin");                             // a pending invite
  await linkToken(w.B.tia.one.token);                                 // a pending link
  const before = everythingOf(w.db, w.A.id);                          // A's rows of every table that carries a team
  expect((await post("bob", deletePath(w.B), { name: w.B.name })).status).toBe(204);
  const { teams, ...held } = everythingOf(w.db, w.B.id);            // B's rows of every table that carries a team, from the schema
  expect(teams).toEqual([undefined]);
  for (const [table, left] of Object.entries(held)) expect(left, table).toEqual([]);
  expect(everythingOf(w.db, w.A.id)).toEqual(before);
  expect(w.db.pragma("foreign_key_check")).toEqual([]);
  expect((await uploadAs(w, w.B.tia.one.token, [record()])).status).toBe(401);
  expect((await statsAs(w, w.B.tia.session)).status).toBe(401);
  expect((await registerAs(w, NEWCOMER, w.B.code)).status).toBe(403);
  expect(await (await as("bob", "/api/me")).json()).toEqual({ kind: "user", login: "bob", teams: [] });
  expect(userRow(2202)).toBeUndefined();
  expect((await as("bob", `/api/teams/${w.B.publicId}`)).status).toBe(404);
  await expectAnswer(await as("cyd", `/api/teams/${w.B.publicId}/members`), 404, "team not found");
});
test("the usage goes in slices, with the count right and uploads answered at each pause", async () => {
  const seen: number[] = [];
  w.pace.atPause = async () => {
    w.countIsRight();
    seen.push((await uploadAs(w, w.A.members[0]!.one.token, [record({ model: `during-${seen.length}` })])).status);
  };
  expect((await post("bob", deletePath(w.B), { name: w.B.name })).status).toBe(204);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen.every((s) => s === 200)).toBe(true);
  expect(w.pace.pauses).toBe(3);                                      // one after each full slice of B's 9 rows, none after the last
});
test("the answer to a deletion is 204 with no body and no-store", async () => {
  const res = await deleteAs(w, "bob", w.B);
  expect(res.status).toBe(204);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe("");
});

test("a wrong name, one that differs only in case, an empty one and a missing one are 400 and delete nothing", async () => {
  const before = everythingOf(w.db, w.B.id);
  const refused: [unknown, string][] = [
    [{ name: "Borealis Zephyrine Guil" }, NAME_DOES_NOT_MATCH],
    [{ name: w.A.name }, NAME_DOES_NOT_MATCH],
    [{ name: w.B.name.toUpperCase() }, NAME_DOES_NOT_MATCH],
    [{ name: w.B.name.toLowerCase() }, NAME_DOES_NOT_MATCH],
    [{ name: "" }, NAME_DOES_NOT_MATCH],
    [{ name: "   " }, NAME_DOES_NOT_MATCH],
    [{}, "invalid name"],
    [{ name: 7 }, "invalid name"],
    [{ name: null }, "invalid name"],
    [{ name: [w.B.name] }, "invalid name"],
    ["{not json", "invalid JSON body"],
    ["[]", "body must be an object"],
  ];
  for (const [body, error] of refused) await expectAnswer(await post("bob", deletePath(w.B), body), 400, error);
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
  expect(w.pace.pauses).toBe(0);
});
test(`a team renamed to "${CAFE}" is deleted when the name is sent decomposed (NFD) with spaces around it`, async () => {
  expect((await asUser(w, "bob", `/api/teams/${w.B.publicId}`, { method: "PATCH", body: { name: CAFE } })).status).toBe(200);
  expect(CAFE_NFD).not.toBe(CAFE);
  expect((await post("bob", deletePath(w.B), { name: `  ${CAFE_NFD}  ` })).status).toBe(204);
  expect(teamRow(w.B.id)).toBeUndefined();
});
test("a team whose stored name is decomposed (NFD) is deleted when the name is sent composed (NFC)", async () => {
  expect((await asUser(w, "bob", `/api/teams/${w.B.publicId}`, { method: "PATCH", body: { name: CAFE_NFD } })).status).toBe(200);
  expect((await post("bob", deletePath(w.B), { name: CAFE })).status).toBe(204);
  expect(teamRow(w.B.id)).toBeUndefined();
});

test("an admin and a viewer get 403, and a user with no role in B the 404 of a team that does not exist, whatever the name; B is whole", async () => {
  const before = everythingOf(w.db, w.B.id);
  for (const name of [w.B.name, "not the name"]) {
    for (const who of ["ann", "zoe", "eve"] as const) await expectAnswer(await post(who, deletePath(w.B), { name }), 404, "team not found");
    for (const who of ["cyd", "dee"] as const) await expectAnswer(await post(who, deletePath(w.B), { name }), 403, ROLE_NOT_ALLOWED);
  }
  for (const path of ["/api/teams/0123456789abcdef/delete", "/api/teams/not-a-team/delete"]) {
    await expectAnswer(await post("bob", path, { name: w.B.name }), 404, "team not found");
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
  expect(w.pace.pauses).toBe(0);
});
test("no credential, a machine token and a member's session get 401; without the server's Origin 403; B is whole", async () => {
  const before = everythingOf(w.db, w.B.id);
  const deleteB = (headers: Record<string, string>) => send(w, "POST", deletePath(w.B), { name: w.B.name }, headers);
  for (const headers of notGithubSessions(w)) await expectAnswer(await deleteB({ ...headers, Origin: PUBLIC }), 401, "unauthorized");
  for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
    await expectAnswer(await deleteB({ ...origin, Cookie: w.cookies.bob }), 403, "cross-site request refused");
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});

test("the owner's role handed over while the deletion pauses: 403, and the team is whole but for the slice removed, its count right", async () => {
  const { usage, usage_counts, team_roles, ...rest } = everythingOf(w.db, w.B.id);
  w.pace.atPause = async () => {
    w.pace.atPause = undefined;
    handOver(w.db, w.B.id, PEOPLE.bob.githubId, PEOPLE.cyd.githubId);
  };
  await expectAnswer(await deleteAs(w, "bob", w.B), 403, ROLE_NOT_ALLOWED);
  const after = everythingOf(w.db, w.B.id);
  expect(after).toMatchObject(rest);                                  // the team's row, members, machines, sessions, links, invites
  expect(usageRows(w.B.id)).toBe(usage!.length - 3);                  // one slice of 3 ran
  w.countIsRight();
});
test("two deletions open together: one answers 204, the other finds no team at its next step and answers 404", async () => {
  const answers = await Promise.all([deleteAs(w, "bob", w.B), deleteAs(w, "bob", w.B)]);
  const sorted = [...answers].sort((x, y) => x.status - y.status);
  expect(sorted.map((r) => r.status)).toEqual([204, 404]);
  expect(await sorted[1]!.json()).toEqual({ error: "team not found" });
  expect(teamRow(w.B.id)).toBeUndefined();
  expect(w.db.pragma("foreign_key_check")).toEqual([]);
});
test("what B's machine uploads at a pause is answered 200 and goes with the team", async () => {
  w.pace.atPause = async () => {
    w.pace.atPause = undefined;
    expect((await uploadAs(w, w.B.tia.one.token, [record({ model: "at-a-pause" })])).status).toBe(200);
    w.countIsRight();
  };
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  expect(rowsOfModel("at-a-pause")).toEqual([]);
  expect(countOf("usage_counts", w.B.id)).toBe(0);
});
test("invites of B accepted while B's deletion pauses: 200, then B goes with those roles and invites, and a user with no other role loses their row", async () => {
  const forEve = await inviteToken("bob", w.B, "admin");
  const forZoe = await inviteToken("bob", w.B, "viewer");
  const a = everythingOf(w.db, w.A.id);
  const accepted: number[] = [];
  w.pace.atPause = async () => {
    w.pace.atPause = undefined;
    accepted.push((await post("eve", "/api/invites/accept", { token: forEve })).status);
    accepted.push((await post("zoe", "/api/invites/accept", { token: forZoe })).status);
    expect(countOf("team_roles", w.B.id)).toBe(5);
  };
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  expect(accepted).toEqual([200, 200]);
  for (const table of ["team_roles", "admin_invites"]) expect(countOf(table, w.B.id), table).toBe(0);
  expect(userRow(PEOPLE.eve.githubId)).toBeUndefined();               // no role anywhere
  expect(userRow(PEOPLE.zoe.githubId)).toBeDefined();                 // A's viewer
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("an upload of B's machine held while B is deleted is refused when its body arrives: 401, nothing stored, nothing logged", async () => {
  const a = everythingOf(w.db, w.A.id);
  const held = await heldUpload(w.app, w.B.sam.one.token, [record({ model: "late" })]);
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(rowsOfModel("late")).toEqual([]);
  expect(countOf("usage_counts", w.B.id)).toBe(0);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
  expect(w.logged).toEqual([]);
});
test("a registration with B's code held while B is deleted is refused as for any unknown code, and nobody joins any team", async () => {
  const a = everythingOf(w.db, w.A.id);
  const text = JSON.stringify(registration(NEWCOMER, w.B.code));
  const held = heldRequest(w.app, "/api/register", { method: "POST", text, headers: { "Content-Type": "application/json", Origin: PUBLIC } });
  await settle();                                                     // the handler now waits for the body
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "invalid invite code" });
  expect(w.db.prepare("select count(*) as n from members").get()).toEqual({ n: w.A.members.length });
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("a user with a role in another team keeps their users row; the GitHub sessions of the deleted team's people still answer /api/me", async () => {
  grantRole(w.db, w.A.id, PEOPLE.cyd, "viewer");
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  expect(userRow(PEOPLE.cyd.githubId)).toBeDefined();
  expect(userRow(PEOPLE.dee.githubId)).toBeUndefined();
  const teamA = { id: w.A.publicId, name: w.A.name, role: "viewer", dashboardAccess: "members" };
  expect(await (await as("cyd", "/api/me")).json()).toEqual({ kind: "user", login: "cyd", teams: [teamA] });
  expect(await (await as("dee", "/api/me")).json()).toEqual({ kind: "user", login: "dee", teams: [] });
});
test("an owner of 5 teams creates one again once one of them is deleted", async () => {
  for (const name of ["Second", "Third", "Fourth", "Fifth"]) await created(w, await createAs(w, "bob", name));
  expect((await createAs(w, "bob", "Sixth")).status).toBe(409);
  expect((await deleteAs(w, "bob", w.B)).status).toBe(204);
  await created(w, await createAs(w, "bob", "Sixth"));
});
test("a server at maxTeams accepts a new team again once one is deleted, and the new team does not take the deleted one's id", async () => {
  const v = await manageWorld({ maxTeams: 2 });
  expect((await createAs(v, "eve", "Third")).status).toBe(503);
  expect((await deleteAs(v, "bob", v.B)).status).toBe(204);         // B has the highest id there is
  const next = await created(v, await createAs(v, "eve", "Third"));
  expect(next.id).toBeGreaterThan(v.B.id);
});
test("a team created right after a deletion is answered 200 at its first upload and its first statistics request", async () => {
  // B's machines sent 9 records at set-up, its whole minute; each statistics request takes 60 ms of B's 100.
  let reading = 0;
  const limits = testLimits(testCaps(), { teamUploadRecordsPerMinute: 9, teamStatsMsPerMinute: 100 });
  const v = await manageWorld({ limits, stopwatch: () => (reading += 60) });
  const statsAsBob = (publicId: string) => asUser(v, "bob", `/api/stats?${RANGE}&team=${publicId}`);
  const uploadOne = (token: string) => uploadAs(v, token, recordsOf(1));
  expect((await uploadOne(v.B.tia.one.token)).status).toBe(429);
  for (const status of [200, 200, 429]) expect((await statsAsBob(v.B.publicId)).status).toBe(status);
  expect((await deleteAs(v, "bob", v.B)).status).toBe(204);
  const next = await created(v, await createAs(v, "bob", "Next"));
  const joined = await postFromPage(v.app, "/api/register", goodReg({ inviteCode: next.code, machineId: machineIdOf(0xd1) }));
  const { token } = (await joined.json()) as { token: string };
  expect((await uploadOne(token)).status).toBe(200);
  expect((await statsAsBob(next.publicId)).status).toBe(200);
});
