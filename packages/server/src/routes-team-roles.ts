import type { Context, Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { MAX_TEAMS_PER_USER } from "./hosted-teams.js";
import { crossSite, fail, isObject, readJson } from "./http.js";
import { ANY_ROLE, githubSession, MANAGERS, OWNER_ONLY, ROLE_NOT_ALLOWED, teamAccess } from "./team-access.js";
import { handOver, HandOverError, listRoles, removeRole, type HandOverReason } from "./team-roles.js";

const OWNER_CANNOT_LEAVE = "the owner cannot leave; hand the team over or delete it";
const ROLE_NOT_FOUND = "role not found";

/** The answer to each refused handover. */
const HAND_OVER_REFUSALS: Record<HandOverReason, { status: 403 | 409; error: string }> = {
  "not-owner": { status: 403, error: ROLE_NOT_ALLOWED },
  "not-admin": { status: 409, error: "ownership goes to an admin of this team" },
  "owns-most": { status: 409, error: `that user already owns ${MAX_TEAMS_PER_USER} teams` },
};

const GITHUB_ID_PARAM = /^\d+$/;

/** True for a GitHub id: a positive safe integer. */
const isGithubId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** The GitHub id the `:user` of the URL names; null when it is not digits or not a safe integer. */
function githubIdParam(c: Context): number | null {
  const param = c.req.param("user") ?? "";
  return GITHUB_ID_PARAM.test(param) && Number.isSafeInteger(Number(param)) ? Number(param) : null;
}

/** Listing a team's roles, removing one or leaving, and handing ownership over. Mounted only on a hosted server. */
export function teamRolesRoutes(app: Hono, ctx: RouteContext): void {
  const hosted = ctx.opts.hosted;
  if (hosted === undefined) return;

  app.get("/api/teams/:team/roles", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, MANAGERS);
    if (access instanceof Response) return access;
    return c.json({ roles: listRoles(ctx.db, access.team.id) });
  });

  app.delete("/api/teams/:team/roles/:user", (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, ANY_ROLE);
    if (access instanceof Response) return access;
    const githubId = githubIdParam(c);
    if (githubId === null) return fail(c, 404, ROLE_NOT_FOUND);
    if (githubId === user.githubId && access.role === "owner") return fail(c, 409, OWNER_CANNOT_LEAVE);
    // Only the owner removes someone else; an admin or a viewer is refused before learning whether that user has a role.
    if (githubId !== user.githubId && access.role !== "owner") return fail(c, 403, ROLE_NOT_ALLOWED);
    if (!removeRole(ctx.db, access.team.id, githubId)) return fail(c, 404, ROLE_NOT_FOUND);
    return c.body(null, 204);
  });

  app.post("/api/teams/:team/owner", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (!isGithubId(body.user)) return fail(c, 400, "invalid user");
    // The role is read after the body; handOver reads it again in its own transaction, in the same turn.
    const access = teamAccess(ctx, c, user, OWNER_ONLY);
    if (access instanceof Response) return access;
    try {
      handOver(ctx.db, access.team.id, user.githubId, body.user);
    } catch (err) {
      if (!(err instanceof HandOverError)) throw err;
      const { status, error } = HAND_OVER_REFUSALS[err.reason];
      return fail(c, status, error);
    }
    return c.body(null, 204);
  });
}
