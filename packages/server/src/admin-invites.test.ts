import { beforeEach, expect, test } from "vitest";
import { acceptInvite, cancelInvite, createInvite, InviteError, listInvites, MAX_PENDING_INVITES, type InviteRole } from "./admin-invites.js";
import { sha256 } from "./db.js";
import { grantRole } from "./hosted.fixture.js";
import { roleIn } from "./hosted-teams.js";
import { addViewers, DAY_MS, FAY, manageWorld, PEOPLE, roleRows, T0, type ManageWorld } from "./manage.fixture.js";
import { MAX_ADMINS_AND_VIEWERS } from "./team-roles.js";

const NOW = Date.parse(T0);
const LATER = NOW + 7 * DAY_MS;

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const { bob, cyd, dee, eve, zoe } = PEOPLE;
const invite = (teamId: number, role: InviteRole = "viewer", at = NOW) => createInvite(w.db, teamId, role, at);
const inviteRows = (teamId: number) => w.db.prepare("select * from admin_invites where team_id = ? order by rowid").all(teamId);
/** The reason the call was refused; null when it went through. */
const refusal = (call: () => unknown): string | null => {
  try {
    call();
    return null;
  } catch (err) {
    if (err instanceof InviteError) return err.reason;
    throw err;
  }
};

test("createInvite gives a 16-hex id, the role and 7 days from the clock, and a 64-hex token stored only as its hash", () => {
  const made = invite(w.B.id, "admin");
  expect(made.token).toMatch(/^[a-f0-9]{64}$/);
  expect(made.invite).toEqual({ id: expect.stringMatching(/^[a-f0-9]{16}$/), role: "admin", createdAt: T0, expiresAt: "2026-11-09T09:30:00.000Z" });
  expect(inviteRows(w.B.id)).toEqual([
    { id: made.invite.id, team_id: w.B.id, role: "admin", token_hash: sha256(made.token), created_at: T0, expires_at: "2026-11-09T09:30:00.000Z" },
  ]);
});
test("listInvites gives the team's invites that can still be accepted, oldest first, and only that team's", () => {
  const first = invite(w.B.id, "admin", NOW).invite;
  const second = invite(w.B.id, "viewer", NOW + 1).invite;
  invite(w.A.id);
  expect(listInvites(w.db, w.B.id, NOW + 1)).toEqual([first, second]);
  expect(listInvites(w.db, w.B.id, LATER)).toEqual([second]);         // the first expires as the clock reaches its end
  expect(listInvites(w.db, w.B.id, LATER + 1)).toEqual([]);
});
test("createInvite refuses the team's 21st pending invite, counts each team apart, and deletes the team's expired ones first", () => {
  for (let i = 0; i < MAX_PENDING_INVITES; i++) invite(w.A.id);
  for (let i = 0; i < MAX_PENDING_INVITES; i++) invite(w.B.id);
  expect(refusal(() => invite(w.B.id))).toBe("too-many-pending");
  expect(inviteRows(w.B.id)).toHaveLength(MAX_PENDING_INVITES);
  const fresh = invite(w.B.id, "viewer", LATER).invite;
  expect(inviteRows(w.B.id)).toEqual([expect.objectContaining({ id: fresh.id })]);
  expect(inviteRows(w.A.id)).toHaveLength(MAX_PENDING_INVITES);      // another team's expired invites wait for that team
});
test("cancelInvite cancels the team's invite only; an id of another team or none is false and changes nothing", () => {
  const ofA = invite(w.A.id);
  const ofB = invite(w.B.id);
  expect(cancelInvite(w.db, w.B.id, ofA.invite.id)).toBe(false);
  expect(cancelInvite(w.db, w.B.id, "0123456789abcdef")).toBe(false);
  expect(inviteRows(w.A.id)).toHaveLength(1);
  expect(cancelInvite(w.db, w.B.id, ofB.invite.id)).toBe(true);
  expect(inviteRows(w.B.id)).toEqual([]);
});

test("acceptInvite gives the invite's role in the invite's team, uses the invite up and returns the team as the user sees it", () => {
  const rolesA = roleRows(w.db, w.A.id);
  const { token } = invite(w.B.id, "admin");
  expect(acceptInvite(w.db, token, zoe, NOW)).toEqual({ id: w.B.publicId, name: w.B.name, role: "admin", dashboardAccess: "members" });
  expect(roleIn(w.db, w.B.id, zoe.githubId)).toBe("admin");
  expect(roleRows(w.db, w.A.id)).toEqual(rolesA);                     // zoe stays A's viewer
  expect(inviteRows(w.B.id)).toEqual([]);
  expect(refusal(() => acceptInvite(w.db, token, eve, NOW))).toBe("not-valid");
});
test("acceptInvite refuses an unknown, a used, a cancelled and an expired token alike", () => {
  const used = invite(w.B.id).token;
  acceptInvite(w.db, used, zoe, NOW);
  const cancelled = invite(w.B.id);
  cancelInvite(w.db, w.B.id, cancelled.invite.id);
  const expired = invite(w.B.id).token;
  for (const token of ["f".repeat(64), used, cancelled.token]) expect(refusal(() => acceptInvite(w.db, token, eve, NOW))).toBe("not-valid");
  expect(refusal(() => acceptInvite(w.db, expired, eve, LATER))).toBe("not-valid");
  expect(roleIn(w.db, w.B.id, eve.githubId)).toBeNull();
});
test("acceptInvite refuses a user with any role in the team and the invite stays", () => {
  const { token } = invite(w.B.id, "admin");
  for (const who of [bob, cyd, dee]) expect(refusal(() => acceptInvite(w.db, token, who, NOW))).toBe("has-role");
  expect(inviteRows(w.B.id)).toHaveLength(1);
  expect(roleIn(w.db, w.B.id, dee.githubId)).toBe("viewer");
  expect(acceptInvite(w.db, token, eve, NOW).role).toBe("admin");
});
test("acceptInvite counts the team's admins and viewers, not its owner nor other teams' roles, up to 50; refused, the invite stays", () => {
  addViewers(w.db, w.B.id, MAX_ADMINS_AND_VIEWERS - 3);               // with cyd and dee: 49, besides B's owner and A's roles
  expect(acceptInvite(w.db, invite(w.B.id).token, eve, NOW).role).toBe("viewer");
  const { token } = invite(w.B.id);
  expect(refusal(() => acceptInvite(w.db, token, zoe, NOW))).toBe("team-full");
  expect(inviteRows(w.B.id)).toHaveLength(1);
  expect(roleIn(w.db, w.B.id, zoe.githubId)).toBeNull();
});
test("accepting as a user with no users row leaves the users row and the role that grantRole writes for that person and role", async () => {
  const other = await manageWorld();
  acceptInvite(w.db, invite(w.B.id, "admin").token, FAY, NOW);
  grantRole(other.db, other.B.id, FAY, "admin");
  const rowsOf = (world: ManageWorld) => {
    const user = world.db.prepare("select * from users where github_id = ?").get(FAY.githubId) as Record<string, unknown>;
    const role = world.db.prepare("select * from team_roles where user_id = ?").get(user.id) as Record<string, unknown>;
    const { created_at: _userCreated, ...userRest } = user;
    const { created_at: _roleCreated, ...roleRest } = role;
    return { userColumns: Object.keys(user), roleColumns: Object.keys(role), user: userRest, role: roleRest };
  };
  expect(rowsOf(w)).toEqual(rowsOf(other));
  expect(rowsOf(w).role).toEqual({ team_id: w.B.id, user_id: expect.any(Number), role: "admin" });
});
