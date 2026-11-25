import type { Db } from "./db.js";
import { isPublicId, opensWithCode, roleIn, teamByPublicId } from "./hosted-teams.js";
import type { Session } from "./sessions.js";
import type { MachineIdentity } from "./team-data.js";

export const DASHBOARD_LIMITED = "this team's dashboard is limited to its admins; update teamusage to see your own numbers here";

export type StatsAccess =
  | { ok: true; teamId: number; member: MachineIdentity | null; teamNumbers: boolean }
  | { ok: false; status: 400 | 401 | 404; error: string };

const UNAUTHORIZED: StatsAccess = { ok: false, status: 401, error: "unauthorized" };
const INVALID_TEAM: StatsAccess = { ok: false, status: 400, error: "invalid query" };
/** The one answer for a team that does not exist and for a team the caller has no role in. */
const TEAM_NOT_FOUND: StatsAccess = { ok: false, status: 404, error: "team not found" };

/** The team named by public id in which the GitHub user has a role; any other team is not found. */
function userAccess(db: Db, githubId: number, teamParam: string | undefined): StatsAccess {
  if (!isPublicId(teamParam)) return INVALID_TEAM;
  const team = teamByPublicId(db, teamParam);
  if (team === null || roleIn(db, team.id, githubId) === null) return TEAM_NOT_FOUND;
  return { ok: true, teamId: team.id, member: null, teamNumbers: true };
}

/** Which team the request reads and whether it may read more than its own member. */
export function statsAccess(
  db: Db,
  a: {
    demoTeamId: number | undefined;
    token: string | undefined;
    who: MachineIdentity | null;
    session: Session | null;
    teamParam: string | undefined;
  },
): StatsAccess {
  if (a.demoTeamId !== undefined) return { ok: true, teamId: a.demoTeamId, member: null, teamNumbers: true };
  // A presented bearer token must be valid; it wins over a cookie, but a bad one is never rescued by a cookie.
  if (a.token !== undefined) {
    if (a.who === null) return UNAUTHORIZED;
    return { ok: true, teamId: a.who.teamId, member: a.who, teamNumbers: opensWithCode(db, a.who.teamId) };
  }
  const { session } = a;
  if (session?.kind === "team") {
    return opensWithCode(db, session.teamId) ? { ok: true, teamId: session.teamId, member: null, teamNumbers: true } : UNAUTHORIZED;
  }
  if (session?.kind === "user") return userAccess(db, session.githubId, a.teamParam);
  return UNAUTHORIZED;
}
