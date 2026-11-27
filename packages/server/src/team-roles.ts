import type { Db } from "./db.js";
import { MAX_TEAMS_PER_USER, roleIn, type Role } from "./hosted-teams.js";
import { dropUsersWithoutRole } from "./users.js";

/** Most admins and viewers one team has; the owner is not counted. */
export const MAX_ADMINS_AND_VIEWERS = 50;

export type RoleEntry = { githubId: number; login: string; role: Role; since: string };

/** The reasons a HandOverError gives. */
export type HandOverReason = "not-owner" | "not-admin" | "owns-most";

/** Why ownership was not handed over. */
export class HandOverError extends Error {
  readonly reason: HandOverReason;
  constructor(reason: HandOverReason) {
    super(`ownership was not handed over: ${reason}`);
    this.name = "HandOverError";
    this.reason = reason;
  }
}

/** The `users` id of the GitHub user, as a subquery of the statements below. */
const USER_ID = "(select id from users where github_id = ?)";

/** The team's owner, then its admins, then its viewers, each group oldest first; roles of one moment in the order they were made. */
export function listRoles(db: Db, teamId: number): RoleEntry[] {
  return db
    .prepare(
      `select u.github_id as githubId, u.login, r.role, r.created_at as since
       from team_roles r join users u on u.id = r.user_id
       where r.team_id = ?
       order by case r.role when 'owner' then 0 when 'admin' then 1 else 2 end, r.created_at, r.rowid`,
    )
    .all(teamId) as RoleEntry[];
}

/**
 * Removes the role of an admin or a viewer; false when the user has none in the team or is its owner. A user left with
 * no role in any team loses their `users` row in the same step.
 */
export function removeRole(db: Db, teamId: number, githubId: number): boolean {
  return db.transaction(() => {
    const { changes } = db.prepare(`delete from team_roles where team_id = ? and role <> 'owner' and user_id = ${USER_ID}`).run(teamId, githubId);
    if (changes > 0) dropUsersWithoutRole(db);
    return changes > 0;
  })();
}

/** How many teams the GitHub user owns. */
function teamsOwnedBy(db: Db, githubId: number): number {
  return (db.prepare(`select count(*) as n from team_roles where role = 'owner' and user_id = ${USER_ID}`).get(githubId) as { n: number }).n;
}

function setRole(db: Db, teamId: number, githubId: number, role: Role): void {
  db.prepare(`update team_roles set role = ? where team_id = ? and user_id = ${USER_ID}`).run(role, teamId, githubId);
}

/** Makes the team's admin `toGithubId` its owner and its owner `fromGithubId` an admin, in one step. */
export function handOver(db: Db, teamId: number, fromGithubId: number, toGithubId: number): void {
  // Immediate, so that of two handovers open together the second reads the first one's roles.
  db.transaction(() => {
    if (roleIn(db, teamId, fromGithubId) !== "owner") throw new HandOverError("not-owner");
    if (roleIn(db, teamId, toGithubId) !== "admin") throw new HandOverError("not-admin");
    if (teamsOwnedBy(db, toGithubId) >= MAX_TEAMS_PER_USER) throw new HandOverError("owns-most");
    // The owner is demoted first: a team has one owner at a time (team_roles_one_owner).
    setRole(db, teamId, fromGithubId, "admin");
    setRole(db, teamId, toGithubId, "owner");
  }).immediate();
}
