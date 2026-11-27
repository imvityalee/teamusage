import type { Context, Hono } from "hono";
import { acceptInvite, cancelInvite, createInvite, InviteError, listInvites, MAX_PENDING_INVITES, previewInvite, type InviteRefusal, type InviteRole } from "./admin-invites.js";
import type { RouteContext } from "./app-context.js";
import { isPublicId, MAX_TEAMS_PER_USER } from "./hosted-teams.js";
import { crossSite, fail, readObject } from "./http.js";
import { ANY_ROLE, githubSession, MANAGERS, OWNER_ONLY, ROLE_NOT_ALLOWED, teamAccess } from "./team-access.js";
import { handOver, HandOverError, listRoles, MAX_ADMINS_AND_VIEWERS, removeRole, type HandOverReason } from "./team-roles.js";

const OWNER_CANNOT_LEAVE = "the owner cannot leave; hand the team over or delete it";
const ROLE_NOT_FOUND = "role not found";
const INVITE_NOT_FOUND = "invite not found";

/** The answer to each refused handover. */
const HAND_OVER_REFUSALS: Record<HandOverReason, { status: 403 | 409; error: string }> = {
  "not-owner": { status: 403, error: ROLE_NOT_ALLOWED },
  "not-admin": { status: 409, error: "ownership goes to an admin of this team" },
  "owns-most": { status: 409, error: `that user already owns ${MAX_TEAMS_PER_USER} teams` },
};

/** The answer to each refused invite. */
const INVITE_REFUSALS: Record<InviteRefusal, { status: 404 | 409; error: string }> = {
  "too-many-pending": { status: 409, error: `this team has ${MAX_PENDING_INVITES} pending invites; cancel one first` },
  "not-valid": { status: 404, error: "this invite is no longer valid" },
  "has-role": { status: 409, error: "you already have a role in this team" },
  "team-full": { status: 409, error: `this team has reached its limit of ${MAX_ADMINS_AND_VIEWERS} admins and viewers` },
};

const GITHUB_ID_PARAM = /^\d+$/;
const INVITE_TOKEN = /^[a-f0-9]{64}$/;

/** True for a GitHub id: a positive safe integer. */
const isGithubId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** The GitHub id the `:user` of the URL names; null when it is not digits or not a safe integer. */
function githubIdParam(c: Context): number | null {
  const param = c.req.param("user") ?? "";
  return GITHUB_ID_PARAM.test(param) && Number.isSafeInteger(Number(param)) ? Number(param) : null;
}

/** True for a role an invite gives. */
const isInviteRole = (v: unknown): v is InviteRole => v === "admin" || v === "viewer";

/** The refusal's answer when `err` is an InviteError; otherwise `err` is thrown again. */
function inviteRefused(c: Context, err: unknown): Response {
  if (!(err instanceof InviteError)) throw err;
  const { status, error } = INVITE_REFUSALS[err.reason];
  return fail(c, status, error);
}

/**
 * Listing a team's roles, removing one or leaving, handing ownership over, and the owner's invites with which someone
 * becomes an admin or a viewer. Mounted only on a hosted server.
 */
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
    const body = await readObject(c);
    if (body instanceof Response) return body;
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

  app.post("/api/teams/:team/invites", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    if (!isInviteRole(body.role)) return fail(c, 400, "invalid role");
    // The role is read after the body, and the invite made in the same turn.
    const access = teamAccess(ctx, c, user, OWNER_ONLY);
    if (access instanceof Response) return access;
    try {
      return c.json(createInvite(ctx.db, access.team.id, body.role, ctx.now()), 201);
    } catch (err) {
      return inviteRefused(c, err);
    }
  });

  app.get("/api/teams/:team/invites", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, OWNER_ONLY);
    if (access instanceof Response) return access;
    return c.json({ invites: listInvites(ctx.db, access.team.id, ctx.now()) });
  });

  app.delete("/api/teams/:team/invites/:id", (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, OWNER_ONLY);
    if (access instanceof Response) return access;
    const id = c.req.param("id");
    if (!isPublicId(id) || !cancelInvite(ctx.db, access.team.id, id)) return fail(c, 404, INVITE_NOT_FOUND);
    return c.body(null, 204);
  });

  app.post("/api/invites/accept", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    if (typeof body.token !== "string" || !INVITE_TOKEN.test(body.token)) return fail(c, 400, "invalid token");
    // An unknown token is not counted as a failed attempt: an invite's 256 random bits are not guessed.
    try {
      return c.json({ team: acceptInvite(ctx.db, body.token, user, ctx.now()) });
    } catch (err) {
      return inviteRefused(c, err);
    }
  });

  app.post("/api/invites/preview", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    if (typeof body.token !== "string" || !INVITE_TOKEN.test(body.token)) return fail(c, 400, "invalid token");
    // Like an accept, an unknown token is not counted as a failed attempt. Holding the link is what shows the team's name and the role.
    const preview = previewInvite(ctx.db, body.token, ctx.now());
    if (preview === null) return inviteRefused(c, new InviteError("not-valid"));
    return c.json({ team: { name: preview.teamName }, role: preview.role, expiresAt: preview.expiresAt });
  });
}
