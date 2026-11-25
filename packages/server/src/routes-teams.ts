import type { Hono } from "hono";
import { isDisplayName, MAX_TEAM_NAME_CHARS } from "@teamusage/shared";
import type { RouteContext } from "./app-context.js";
import { createHostedTeam, MAX_TEAMS_PER_USER, TeamLimitError, type DashboardAccess } from "./hosted-teams.js";
import { crossSite, fail, isObject, readJson } from "./http.js";

const isDashboardAccess = (v: unknown): v is DashboardAccess => v === "code" || v === "admins";

/** A team name is a display name that stays within MAX_TEAM_NAME_CHARS once trimmed. */
const isTeamName = (v: unknown): v is string => isDisplayName(v) && v.trim().length <= MAX_TEAM_NAME_CHARS;

/** Creating a team as the signed-in GitHub user. Mounted only on a hosted server. */
export function teamRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, session: sessionOf } = ctx;
  const hosted = opts.hosted;
  if (hosted === undefined) return;

  app.post("/api/teams", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const session = sessionOf(c);
    if (session?.kind !== "user") return fail(c, 401, "unauthorized");

    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (!isTeamName(body.name)) return fail(c, 400, "invalid name");
    if (!isDashboardAccess(body.dashboardAccess)) return fail(c, 400, "invalid dashboardAccess");

    try {
      const { team, code } = createHostedTeam(db, {
        name: body.name.trim(),
        dashboardAccess: body.dashboardAccess,
        owner: { githubId: session.githubId, login: session.login },
        codeKey: hosted.codeKey,
        maxTeams: hosted.maxTeams,
      });
      return c.json({ team: { id: team.publicId, name: team.name, role: "owner", dashboardAccess: team.dashboardAccess }, code }, 201);
    } catch (err) {
      if (!(err instanceof TeamLimitError)) throw err;
      return err.limit === "user"
        ? fail(c, 409, `you already own ${MAX_TEAMS_PER_USER} teams`)
        : fail(c, 503, "sign-ups are paused");
    }
  });
}
