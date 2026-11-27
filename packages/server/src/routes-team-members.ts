import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { githubSession, MANAGERS, teamAccess } from "./team-access.js";

/** Listing a team's members with their machines. Mounted only on a hosted server. */
export function teamMembersRoutes(app: Hono, ctx: RouteContext): void {
  if (ctx.opts.hosted === undefined) return;

  app.get("/api/teams/:team/members", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, MANAGERS);
    if (access instanceof Response) return access;
    return c.json({ members: ctx.team(access.team.id).listMembers() });
  });
}
