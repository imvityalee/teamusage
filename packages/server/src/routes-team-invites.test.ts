import { beforeEach, expect, test } from "vitest";
import { INVITE_DAYS, MAX_PENDING_INVITES, type Invite, type InviteRole } from "./admin-invites.js";
import { sha256 } from "./db.js";
import { PUBLIC } from "./hosted.fixture.js";
import { roleIn } from "./hosted-teams.js";
import {
  asUser,
  DAY_MS,
  everythingOf,
  expectAnswer,
  manageWorld,
  newInvite,
  notGithubSessions,
  PEOPLE,
  RANGE,
  roleRows,
  send,
  T0,
  T0_PLUS_7_DAYS,
  userRows,
  type ManagedTeam,
  type ManageWorld,
  type Who,
} from "./manage.fixture.js";
import { createUserSession } from "./sessions.js";
import { listRoles } from "./team-roles.js";

const ACCEPT = "/api/invites/accept";
const NOT_VALID = "this invite is no longer valid";
const ROLE_NOT_ALLOWED = "your role does not allow this";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const as = (who: Who, path: string) => asUser(w, who, path);
const post = (who: Who, path: string, body: unknown) => asUser(w, who, path, { method: "POST", body });
const del = (who: Who, path: string) => asUser(w, who, path, { method: "DELETE" });
const invitesPath = (team: ManagedTeam) => `/api/teams/${team.publicId}/invites`;
const invitePath = (team: ManagedTeam, id: string) => `${invitesPath(team)}/${id}`;
const invite = (who: Who, team: ManagedTeam, role: InviteRole) => newInvite(w, who, team, role);
const inviteToken = async (who: Who, team: ManagedTeam, role: InviteRole) => (await invite(who, team, role)).token;
/** Accepts `token` in a browser whose `tu_session` cookie is `cookie`. */
const acceptWith = (cookie: string, token: string) =>
  w.app.request(ACCEPT, { method: "POST", body: JSON.stringify({ token }), headers: { "Content-Type": "application/json", Origin: PUBLIC, Cookie: cookie } });
/** The cookies of seven GitHub users signed in with no role in any team, as the GitHub callback opens their sessions. */
const strangers = () =>
  Array.from({ length: 7 }, (_, i) => `tu_session=${createUserSession(w.db, { githubId: 900_001 + i, login: `stranger-${i}` })}`);

test("the owner invites an admin; the link works once, for whoever of ten people opens it first", async () => {
  const rolesA = roleRows(w.db, w.A.id);
  const made = await post("bob", invitesPath(w.B), { role: "admin" });
  expect(made.status).toBe(201);
  expect(made.headers.get("cache-control")).toBe("no-store");
  const { invite, token } = (await made.json()) as { invite: Invite; token: string };
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(invite).toEqual({ id: expect.stringMatching(/^[a-f0-9]{16}$/), role: "admin", createdAt: T0, expiresAt: T0_PLUS_7_DAYS });
  const everyoneWithoutRoleInB = [w.cookies.ann, w.cookies.eve, w.cookies.zoe, ...strangers()];
  const answers = await Promise.all(everyoneWithoutRoleInB.map((cookie) => acceptWith(cookie, token)));
  expect(answers.map((r) => r.status).sort()).toEqual([200, ...Array<number>(9).fill(404)]);
  expect(listRoles(w.db, w.B.id).filter((r) => r.role === "admin")).toHaveLength(2);   // cyd and the one who got it
  expect(await (await as("bob", invitesPath(w.B))).json()).toEqual({ invites: [] });
  expect(roleRows(w.db, w.A.id)).toEqual(rolesA);
});
test("an invite can be accepted for 7 days", async () => {
  const [early, late] = [await inviteToken("bob", w.B, "viewer"), await inviteToken("bob", w.B, "viewer")];
  w.clock.t += 7 * DAY_MS - 1;
  expect(await (await post("eve", ACCEPT, { token: early })).json()).toEqual({ team: { id: w.B.publicId, name: w.B.name, role: "viewer", dashboardAccess: "members" } });
  w.clock.t += 1;
  const res = await post("zoe", ACCEPT, { token: late });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: NOT_VALID });
});
test("the agreed values", () => expect([INVITE_DAYS, MAX_PENDING_INVITES]).toEqual([7, 20]));

test("an unknown token of the right form, a used, a cancelled and an expired one get one answer", async () => {
  const used = await inviteToken("bob", w.B, "viewer");
  expect((await post("eve", ACCEPT, { token: used })).status).toBe(200);
  const cancelled = await invite("bob", w.B, "viewer");
  expect((await del("bob", invitePath(w.B, cancelled.invite.id))).status).toBe(204);
  const expired = await inviteToken("bob", w.B, "admin");
  w.clock.t += 7 * DAY_MS;
  const answers: Response[] = [];
  for (const token of ["f".repeat(64), used, cancelled.token, expired]) answers.push(await post("zoe", ACCEPT, { token }));
  for (const res of answers) {
    expect(res.status).toBe(404);
    expect([...res.headers]).toEqual([...answers[0]!.headers]);
    expect(await res.text()).toBe(JSON.stringify({ error: NOT_VALID }));
  }
  expect(roleIn(w.db, w.B.id, PEOPLE.zoe.githubId)).toBeNull();
});
test("a new viewer reads the team and its statistics and gets 403 on the members, the code and the roles; a new admin reads them", async () => {
  expect((await post("eve", ACCEPT, { token: await inviteToken("bob", w.B, "viewer") })).status).toBe(200);
  expect((await post("zoe", ACCEPT, { token: await inviteToken("bob", w.B, "admin") })).status).toBe(200);
  const team = `/api/teams/${w.B.publicId}`;
  for (const who of ["eve", "zoe"] as const) {
    expect((await as(who, team)).status).toBe(200);
    expect((await as(who, `/api/stats?${RANGE}&team=${w.B.publicId}`)).status).toBe(200);
  }
  for (const path of [`${team}/members`, `${team}/code`, `${team}/roles`]) {
    await expectAnswer(await as("eve", path), 403, ROLE_NOT_ALLOWED);
    expect((await as("zoe", path)).status).toBe(200);
  }
});
test("someone who already has a role in the team gets 409, and the invite stays listed and works for eve", async () => {
  const made = await invite("bob", w.B, "admin");
  for (const who of ["bob", "cyd", "dee"] as const) await expectAnswer(await post(who, ACCEPT, { token: made.token }), 409, "you already have a role in this team");
  expect(await (await as("bob", invitesPath(w.B))).json()).toEqual({ invites: [made.invite] });
  expect((await post("eve", ACCEPT, { token: made.token })).status).toBe(200);
  expect(roleIn(w.db, w.B.id, PEOPLE.dee.githubId)).toBe("viewer");
});
test("the owner cancels an invite and its token is then not valid; B's owner cancelling A's invite gets the answer of an id that does not exist", async () => {
  const ofB = await invite("bob", w.B, "viewer");
  const cancelled = await del("bob", invitePath(w.B, ofB.invite.id));
  expect(cancelled.status).toBe(204);
  expect(cancelled.headers.get("cache-control")).toBe("no-store");
  await expectAnswer(await post("eve", ACCEPT, { token: ofB.token }), 404, NOT_VALID);
  const ofA = await invite("ann", w.A, "viewer");
  const refused = [await del("bob", invitePath(w.B, ofA.invite.id)), await del("bob", invitePath(w.B, "0123456789abcdef")), await del("bob", invitePath(w.B, "xyz"))];
  for (const res of refused) {
    expect([...res.headers]).toEqual([...refused[0]!.headers]);
    await expectAnswer(res, 404, "invite not found");
  }
  expect((await post("eve", ACCEPT, { token: ofA.token })).status).toBe(200);
});

test("an admin and a viewer get 403 on the three team routes; ann, zoe and eve get the 404 of a team that does not exist", async () => {
  const { invite: pending } = await invite("bob", w.B, "viewer");
  const before = everythingOf(w.db, w.B.id);
  const calls: ((who: Who) => Promise<Response>)[] = [
    (who) => post(who, invitesPath(w.B), { role: "viewer" }),
    (who) => as(who, invitesPath(w.B)),
    (who) => del(who, invitePath(w.B, pending.id)),
  ];
  for (const call of calls) {
    for (const who of ["cyd", "dee"] as const) await expectAnswer(await call(who), 403, ROLE_NOT_ALLOWED);
    for (const who of ["ann", "zoe", "eve"] as const) await expectAnswer(await call(who), 404, "team not found");
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});
test("no credential, a machine token and a member's session get 401 on all four; without the server's Origin the changing three are 403", async () => {
  const pending = await invite("bob", w.B, "viewer");
  const before = { b: everythingOf(w.db, w.B.id), users: userRows(w.db) };
  const routes: [string, string, unknown, string][] = [
    ["POST", invitesPath(w.B), { role: "viewer" }, w.cookies.bob],
    ["GET", invitesPath(w.B), undefined, w.cookies.bob],
    ["DELETE", invitePath(w.B, pending.invite.id), undefined, w.cookies.bob],
    ["POST", ACCEPT, { token: pending.token }, w.cookies.eve],
  ];
  for (const [method, path, body] of routes) {
    for (const headers of notGithubSessions(w)) await expectAnswer(await send(w, method, path, body, { ...headers, Origin: PUBLIC }), 401, "unauthorized");
  }
  for (const [method, path, body, cookie] of routes.filter(([method]) => method !== "GET")) {
    for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
      await expectAnswer(await send(w, method, path, body, { ...origin, Cookie: cookie }), 403, "cross-site request refused");
    }
  }
  expect({ b: everythingOf(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
  expect((await post("eve", ACCEPT, { token: pending.token })).status).toBe(200);   // nothing was used up
});
test("every refused body is 400 and changes nothing", async () => {
  const pending = await invite("bob", w.B, "viewer");
  const before = { b: everythingOf(w.db, w.B.id), users: userRows(w.db) };
  const bodies = (field: string, values: unknown[], error: string): [unknown, string][] => [
    ...values.map((v): [unknown, string] => [{ [field]: v }, error]),
    [{}, error],
    ["{not json", "invalid JSON body"],
    ["[]", "body must be an object"],
  ];
  for (const [body, error] of bodies("role", ["owner", "Admin", "", null, 1], "invalid role")) await expectAnswer(await post("bob", invitesPath(w.B), body), 400, error);
  const tokens = [pending.token.toUpperCase(), pending.token.slice(1), `${pending.token}0`, 7, null];
  for (const [body, error] of bodies("token", tokens, "invalid token")) await expectAnswer(await post("eve", ACCEPT, body), 400, error);
  expect({ b: everythingOf(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
});
test("the table of invites never holds a token, and the list gives exactly id, role, createdAt and expiresAt of the team's invites", async () => {
  const made = [await invite("bob", w.B, "admin"), await invite("bob", w.B, "viewer"), await invite("ann", w.A, "viewer")];
  const table = JSON.stringify(w.db.prepare("select * from admin_invites").all());
  const list = await as("bob", invitesPath(w.B));
  expect(list.headers.get("cache-control")).toBe("no-store");
  const text = await list.text();
  for (const { token } of made) {
    expect(table).not.toContain(token);
    expect(text).not.toContain(token);
    expect(text).not.toContain(sha256(token));
  }
  const { invites } = JSON.parse(text) as { invites: Record<string, unknown>[] };
  expect(invites).toEqual([made[0]!.invite, made[1]!.invite]);
  for (const listed of invites) expect(Object.keys(listed).sort()).toEqual(["createdAt", "expiresAt", "id", "role"]);
});
