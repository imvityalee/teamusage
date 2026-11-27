import { beforeEach, expect, test } from "vitest";
import { MAX_PENDING_INVITES, type Invite, type InviteRole } from "./admin-invites.js";
import { goodReg } from "./app.fixture.js";
import { postFromPage } from "./hosted.fixture.js";
import { roleIn } from "./hosted-teams.js";
import { addViewers, asUser, DAY_MS, expectAnswer, manageWorld, newInvite, PEOPLE, type ManagedTeam, type ManageWorld, type Who } from "./manage.fixture.js";
import { listRoles, MAX_ADMINS_AND_VIEWERS } from "./team-roles.js";

const ACCEPT = "/api/invites/accept";
const TOO_MANY_INVITES = "this team has 20 pending invites; cancel one first";
const TEAM_ROLES_FULL = "this team has reached its limit of 50 admins and viewers";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const post = (who: Who, path: string, body: unknown) => asUser(w, who, path, { method: "POST", body });
const invitesPath = (team: ManagedTeam) => `/api/teams/${team.publicId}/invites`;
const invite = (who: Who, team: ManagedTeam, role: InviteRole = "viewer") => newInvite(w, who, team, role);
const pendingOf = async (team: ManagedTeam, owner: Who) => ((await (await asUser(w, owner, invitesPath(team))).json()) as { invites: Invite[] }).invites;
const adminsAndViewersOfB = () => listRoles(w.db, w.B.id).filter((r) => r.role !== "owner").length;
/** Makes `n` invites of the team as its owner. */
const fill = async (team: ManagedTeam, owner: Who, n: number) => {
  for (let i = 0; i < n; i++) await invite(owner, team);
};

test("the 21st pending invite is 409; once the clock passes 7 days the next is created and is the only one; each team is counted apart", async () => {
  await fill(w.A, "ann", MAX_PENDING_INVITES);
  await fill(w.B, "bob", MAX_PENDING_INVITES);                        // 20 in A do not refuse B's first
  await expectAnswer(await post("bob", invitesPath(w.B), { role: "admin" }), 409, TOO_MANY_INVITES);
  expect(await pendingOf(w.B, "bob")).toHaveLength(MAX_PENDING_INVITES);
  w.clock.t += 7 * DAY_MS;
  const fresh = await invite("bob", w.B);
  expect(await pendingOf(w.B, "bob")).toEqual([fresh.invite]);
});
test("with 19 pending, two invites sent together: one is created, the other is 409, and the team holds 20", async () => {
  await fill(w.B, "bob", MAX_PENDING_INVITES - 1);
  const answers = await Promise.all([post("bob", invitesPath(w.B), { role: "admin" }), post("bob", invitesPath(w.B), { role: "viewer" })]);
  expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
  await expectAnswer(answers.find((r) => r.status === 409)!, 409, TOO_MANY_INVITES);
  expect(await pendingOf(w.B, "bob")).toHaveLength(MAX_PENDING_INVITES);
});

test("with 50 admins and viewers, accepting is 409 and the invite stays; after one role is removed it works", async () => {
  addViewers(w.db, w.B.id, MAX_ADMINS_AND_VIEWERS - 2);               // with cyd and dee: 50
  const pending = await invite("bob", w.B, "admin");
  await expectAnswer(await post("eve", ACCEPT, { token: pending.token }), 409, TEAM_ROLES_FULL);
  expect(await pendingOf(w.B, "bob")).toEqual([pending.invite]);
  expect((await asUser(w, "bob", `/api/teams/${w.B.publicId}/roles/800001`, { method: "DELETE" })).status).toBe(204);
  expect((await post("eve", ACCEPT, { token: pending.token })).status).toBe(200);
  expect(roleIn(w.db, w.B.id, PEOPLE.eve.githubId)).toBe("admin");
});
test("with 49 admins and viewers, two accepts sent together: one gets the role, the other is 409, its invite stays and works later", async () => {
  addViewers(w.db, w.B.id, MAX_ADMINS_AND_VIEWERS - 3);               // with cyd and dee: 49
  const made = { eve: await invite("bob", w.B), zoe: await invite("bob", w.B) };
  const answers = await Promise.all((["eve", "zoe"] as const).map((who) => post(who, ACCEPT, { token: made[who].token })));
  expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
  const refusedWho = answers[0]!.status === 409 ? "eve" : "zoe";
  await expectAnswer(answers.find((r) => r.status === 409)!, 409, TEAM_ROLES_FULL);
  expect(adminsAndViewersOfB()).toBe(MAX_ADMINS_AND_VIEWERS);
  expect(await pendingOf(w.B, "bob")).toEqual([made[refusedWho].invite]);
  expect((await asUser(w, "bob", `/api/teams/${w.B.publicId}/roles/800001`, { method: "DELETE" })).status).toBe(204);
  expect((await post(refusedWho, ACCEPT, { token: made[refusedWho].token })).status).toBe(200);
  expect(adminsAndViewersOfB()).toBe(MAX_ADMINS_AND_VIEWERS);
});

test("a refused accept is not a failed attempt: after 12 wrong tokens, a wrong code from that address is 403, not 429", async () => {
  // Every request of the world comes from one address: the app's default client key.
  for (let i = 0; i < 12; i++) await expectAnswer(await post("eve", ACCEPT, { token: i.toString(16).padStart(64, "0") }), 404, "this invite is no longer valid");
  const res = await postFromPage(w.app, "/api/register", goodReg({ inviteCode: "f".repeat(24) }));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "invalid invite code" });
});
