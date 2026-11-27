import type { Context } from "hono";
import type { RouteContext } from "./app-context.js";
import { isPublicId, roleIn, teamByPublicId, type Role, type TeamInfo, type UserTeam } from "./hosted-teams.js";
import { fail } from "./http.js";
import type { Session } from "./sessions.js";

export type GithubSession = Extract<Session, { kind: "user" }>;
export type TeamAccess = { team: TeamInfo; role: Role };

export const ANY_ROLE: readonly Role[] = ["owner", "admin", "viewer"];
export const MANAGERS: readonly Role[] = ["owner", "admin"];
export const OWNER_ONLY: readonly Role[] = ["owner"];

export const TEAM_NOT_FOUND = "team not found";
export const ROLE_NOT_ALLOWED = "your role does not allow this";

/** The request's GitHub session; otherwise the 401. A machine token, a member's session and a code session are not one. */
export function githubSession(ctx: RouteContext, c: Context): GithubSession | Response {
  const session = ctx.session(c);
  return session?.kind === "user" ? session : fail(c, 401, "unauthorized");
}

/**
 * The team named by `:team` and the user's role in it, read now; otherwise the answer that refuses the request: 404
 * "team not found" for a malformed id, a missing team and a team the user has no role in (one answer for the three),
 * 403 "your role does not allow this" when the role is not one of `allowed`.
 */
export function teamAccess(ctx: RouteContext, c: Context, user: GithubSession, allowed: readonly Role[]): TeamAccess | Response {
  const publicId = c.req.param("team");
  const team = isPublicId(publicId) ? teamByPublicId(ctx.db, publicId) : null;
  const role = team === null ? null : roleIn(ctx.db, team.id, user.githubId);
  if (team === null || role === null) return fail(c, 404, TEAM_NOT_FOUND);
  if (!allowed.includes(role)) return fail(c, 403, ROLE_NOT_ALLOWED);
  return { team, role };
}

/** The team as its user sees it. */
export const userTeam = (a: TeamAccess): UserTeam => ({
  id: a.team.publicId,
  name: a.team.name,
  role: a.role,
  dashboardAccess: a.team.dashboardAccess,
});
