import { randomBytes } from "node:crypto";
import { sha256, type Db } from "./db.js";
import { newPublicId, roleIn, type DashboardAccess, type UserTeam } from "./hosted-teams.js";
import { MAX_ADMINS_AND_VIEWERS } from "./team-roles.js";
import { ensureUser } from "./users.js";

/** Days an invite can be accepted. */
export const INVITE_DAYS = 7;
/** Most invites of one team waiting to be accepted. */
export const MAX_PENDING_INVITES = 20;

const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;

export type InviteRole = "admin" | "viewer";
export type Invite = { id: string; role: InviteRole; createdAt: string; expiresAt: string };

/** The reasons an InviteError gives. */
export type InviteRefusal = "too-many-pending" | "not-valid" | "has-role" | "team-full";

/** Why an invite was not created or not accepted. */
export class InviteError extends Error {
  readonly reason: InviteRefusal;
  constructor(reason: InviteRefusal) {
    super(`the invite was refused: ${reason}`);
    this.name = "InviteError";
    this.reason = reason;
  }
}

/** An invite found by its token, with the team it gives a role in. */
type InviteOfToken = { id: string; role: InviteRole; expiresAt: string; teamId: number; publicId: string; name: string; dashboardAccess: DashboardAccess };

const INVITE_COLUMNS = "id, role, created_at as createdAt, expires_at as expiresAt";

/** The moment `ms` (epoch milliseconds) as the ISO text the table holds; texts of one format compare as their moments do. */
const iso = (ms: number): string => new Date(ms).toISOString();

const countOf = (db: Db, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

/** A new invite of the team and its token, which is stored only as a hash and returned only here. `now` is epoch milliseconds. */
export function createInvite(db: Db, teamId: number, role: InviteRole, now: number): { invite: Invite; token: string } {
  // Immediate, so that of two invites made together the second counts the first.
  return db.transaction(() => {
    db.prepare("delete from admin_invites where team_id = ? and expires_at <= ?").run(teamId, iso(now));
    if (countOf(db, "select count(*) as n from admin_invites where team_id = ?", teamId) >= MAX_PENDING_INVITES) {
      throw new InviteError("too-many-pending");
    }
    const token = randomBytes(32).toString("hex");
    const invite: Invite = { id: newPublicId(), role, createdAt: iso(now), expiresAt: iso(now + INVITE_MS) };
    db.prepare("insert into admin_invites (id, team_id, role, token_hash, created_at, expires_at) values (?, ?, ?, ?, ?, ?)")
      .run(invite.id, teamId, role, sha256(token), invite.createdAt, invite.expiresAt);
    return { invite, token };
  }).immediate();
}

/** The team's invites that can still be accepted, oldest first. */
export function listInvites(db: Db, teamId: number, now: number): Invite[] {
  return db
    .prepare(`select ${INVITE_COLUMNS} from admin_invites where team_id = ? and expires_at > ? order by created_at, rowid`)
    .all(teamId, iso(now)) as Invite[];
}

/** Cancels the team's invite `id`; false when the team has none by that id. */
export function cancelInvite(db: Db, teamId: number, id: string): boolean {
  return db.prepare("delete from admin_invites where team_id = ? and id = ?").run(teamId, id).changes > 0;
}

/** The invite whose token is `token`, with its team; undefined when there is none. */
function inviteOfToken(db: Db, token: string): InviteOfToken | undefined {
  return db
    .prepare(
      `select i.id, i.role, i.expires_at as expiresAt, t.id as teamId, t.public_id as publicId, t.name, t.dashboard_access as dashboardAccess
       from admin_invites i join teams t on t.id = i.team_id
       where i.token_hash = ?`,
    )
    .get(sha256(token)) as InviteOfToken | undefined;
}

/** Gives the user the invite's role in its team and uses the invite up, in one step; returns the team as the user now sees it. */
export function acceptInvite(db: Db, token: string, user: { githubId: number; login: string }, now: number): UserTeam {
  // Immediate, so that of two accepts open together the second reads what the first wrote: the invite gone, a role more.
  return db.transaction(() => {
    const invite = inviteOfToken(db, token);
    if (invite === undefined || iso(now) >= invite.expiresAt) throw new InviteError("not-valid");
    if (roleIn(db, invite.teamId, user.githubId) !== null) throw new InviteError("has-role");
    const adminsAndViewers = countOf(db, "select count(*) as n from team_roles where team_id = ? and role <> 'owner'", invite.teamId);
    if (adminsAndViewers >= MAX_ADMINS_AND_VIEWERS) throw new InviteError("team-full");
    const { id: userId } = ensureUser(db, user);
    db.prepare("insert into team_roles (team_id, user_id, role, created_at) values (?, ?, ?, ?)").run(invite.teamId, userId, invite.role, iso(now));
    db.prepare("delete from admin_invites where id = ?").run(invite.id);
    return { id: invite.publicId, name: invite.name, role: invite.role, dashboardAccess: invite.dashboardAccess };
  }).immediate();
}
