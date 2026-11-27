import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { createHostedTeam, isDashboardAccess, isTeamName, MAX_TEAMS_PER_USER, TeamLimitError } from "./hosted-teams.js";
import { crossSite, fail, isObject, readJson } from "./http.js";
import { githubSession } from "./team-access.js";

const SIGN_UPS_PAUSED = "sign-ups are paused";

/** Creating a team as the signed-in GitHub user. Mounted only on a hosted server. */
export function teamRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts } = ctx;
  const hosted = opts.hosted;
  if (hosted === undefined) return;

  app.post("/api/teams", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const session = githubSession(ctx, c);
    if (session instanceof Response) return session;

    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (!isTeamName(body.name)) return fail(c, 400, "invalid name");
    if (!isDashboardAccess(body.dashboardAccess)) return fail(c, 400, "invalid dashboardAccess");

    if (opts.limits?.team.storageLow()) return fail(c, 503, SIGN_UPS_PAUSED);

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
        : fail(c, 503, SIGN_UPS_PAUSED);
    }
  });
}
