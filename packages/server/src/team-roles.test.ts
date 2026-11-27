import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { grantRole, hostedTeam } from "./hosted.fixture.js";
import { roleIn } from "./hosted-teams.js";
import { FAY, manageWorld, ownedBy, PEOPLE, roleRows, T0, userRows, type ManageWorld } from "./manage.fixture.js";
import { handOver, HandOverError, listRoles, MAX_ADMINS_AND_VIEWERS, removeRole } from "./team-roles.js";

let w: ManageWorld;
/** A third team, owned by bob, where cyd is a viewer: a statement that leaves out its team reaches it. */
let third: number;
beforeEach(async () => {
  w = await manageWorld();
  grantRole(w.db, w.B.id, FAY, "admin");
  grantRole(w.db, w.B.id, PEOPLE.zoe, "viewer");                     // zoe: viewer of A and of B
  grantRole(w.db, w.A.id, PEOPLE.cyd, "viewer");                     // cyd: admin of B, viewer of A
  third = hostedTeam(w.db, PEOPLE.bob, "members", "Third").team.id;
  grantRole(w.db, third, PEOPLE.cyd, "viewer");
});
afterEach(() => {
  vi.useRealTimers();
});

const { bob, cyd, dee, eve, zoe, ann } = PEOPLE;
const otherTeams = () => ({ a: roleRows(w.db, w.A.id), third: roleRows(w.db, third) });
/** Makes `who` the owner of `n` more teams. */
const giveTeams = (who: { githubId: number; login: string }, n: number) => {
  for (let i = 0; i < n; i++) hostedTeam(w.db, who, "members", `${who.login} ${i}`);
};
/** The reason handOver refused; null when it handed over. */
const refusal = (from: number, to: number): string | null => {
  try {
    handOver(w.db, w.B.id, from, to);
    return null;
  } catch (err) {
    if (err instanceof HandOverError) return err.reason;
    throw err;
  }
};

test("the agreed value", () => expect(MAX_ADMINS_AND_VIEWERS).toBe(50));

test("listRoles gives the team's owner, then its admins, then its viewers, each oldest first, and only that team's", () => {
  const entry = (p: { githubId: number; login: string }, role: string) => ({ githubId: p.githubId, login: p.login, role, since: expect.any(String) });
  expect(listRoles(w.db, w.B.id)).toEqual([entry(bob, "owner"), entry(cyd, "admin"), entry(FAY, "admin"), entry(dee, "viewer"), entry(zoe, "viewer")]);
  expect(listRoles(w.db, w.A.id)).toEqual([entry(ann, "owner"), entry(zoe, "viewer"), entry(cyd, "viewer")]);
});
test("roles created in the same millisecond come out in the order they were inserted", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  const team = hostedTeam(w.db, eve, "members", "Same moment").team.id;
  for (const p of [FAY, dee, zoe]) grantRole(w.db, team, p, "admin"); // their users rows were made in the other order
  expect(listRoles(w.db, team).map((r) => r.login)).toEqual(["eve", "fay", "dee", "zoe"]);
});

test("removeRole takes an admin's role in B only and drops the users row with the last role", () => {
  const before = otherTeams();
  expect(removeRole(w.db, w.B.id, FAY.githubId)).toBe(true);
  expect(roleIn(w.db, w.B.id, FAY.githubId)).toBeNull();
  expect(w.db.prepare("select * from users where github_id = ?").get(FAY.githubId)).toBeUndefined();
  expect(removeRole(w.db, w.B.id, cyd.githubId)).toBe(true);
  expect(otherTeams()).toEqual(before);                               // cyd is still a viewer of A and of the third team
});
test("removeRole of a viewer with a role in another team keeps the users row", () => {
  const users = userRows(w.db);
  expect(removeRole(w.db, w.B.id, zoe.githubId)).toBe(true);
  expect(roleIn(w.db, w.A.id, zoe.githubId)).toBe("viewer");
  expect(userRows(w.db)).toEqual(users);
});
test("removeRole is false for the owner, for a user with no role in the team and for an id with no users row; nothing changes", () => {
  const before = { b: roleRows(w.db, w.B.id), others: otherTeams(), users: userRows(w.db) };
  for (const githubId of [bob.githubId, ann.githubId, eve.githubId, 9909]) expect(removeRole(w.db, w.B.id, githubId)).toBe(false);
  expect({ b: roleRows(w.db, w.B.id), others: otherTeams(), users: userRows(w.db) }).toEqual(before);
});

test("handOver makes B's admin its owner and its owner an admin; the other teams' roles stay", () => {
  const before = otherTeams();                                        // bob owns the third team, cyd is a viewer of A
  handOver(w.db, w.B.id, bob.githubId, cyd.githubId);
  expect([roleIn(w.db, w.B.id, cyd.githubId), roleIn(w.db, w.B.id, bob.githubId)]).toEqual(["owner", "admin"]);
  expect(otherTeams()).toEqual(before);
});
test("handOver refuses a caller who is not the owner, also the second of two handovers, and changes nothing", () => {
  const before = roleRows(w.db, w.B.id);
  expect(refusal(cyd.githubId, FAY.githubId)).toBe("not-owner");
  expect(roleRows(w.db, w.B.id)).toEqual(before);
  expect(refusal(bob.githubId, cyd.githubId)).toBeNull();
  const after = roleRows(w.db, w.B.id);
  expect(refusal(bob.githubId, FAY.githubId)).toBe("not-owner");
  expect(roleRows(w.db, w.B.id)).toEqual(after);
});
test("handOver refuses anyone but an admin of the team and changes nothing", () => {
  const before = { b: roleRows(w.db, w.B.id), users: userRows(w.db) };
  for (const to of [dee.githubId, zoe.githubId, ann.githubId, eve.githubId, bob.githubId, 9909]) expect(refusal(bob.githubId, to)).toBe("not-admin");
  expect({ b: roleRows(w.db, w.B.id), users: userRows(w.db) }).toEqual(before);
});
test("handOver refuses an admin who owns 5 teams and accepts one who owns 4; the count is the receiver's", () => {
  giveTeams(bob, 3);                                                  // bob owns 5: B, the third team and 3 more
  giveTeams(FAY, 5);
  giveTeams(cyd, 4);
  const before = roleRows(w.db, w.B.id);
  expect(refusal(bob.githubId, FAY.githubId)).toBe("owns-most");
  expect(roleRows(w.db, w.B.id)).toEqual(before);
  expect(refusal(bob.githubId, cyd.githubId)).toBeNull();
  expect([ownedBy(w.db, cyd.githubId), ownedBy(w.db, bob.githubId)]).toEqual([5, 4]);
});
