import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { createDashboardLink, DASHBOARD_LINK_SECONDS, takeDashboardLink } from "./dashboard-links.js";
import type { Db } from "./db.js";
import { membersSeeTeam } from "./hosted-teams.js";
import { bearerToken, crossSite, fail, isObject, readJson, setSessionCookie } from "./http.js";
import { createMemberSession } from "./sessions.js";
import { DASHBOARD_ADMINS_ONLY } from "./stats-access.js";
import { authenticate } from "./team-data.js";

const LINK_NOT_VALID = "this link is no longer valid; ask your agent for a new one";

const LINK_TOKEN = /^[a-f0-9]{64}$/;

/**
 * Uses up the link and opens a session of its machine's member, all in one immediate transaction; otherwise the text
 * of the 403 that refuses it. A link of a team whose members no longer see it is used up and opens nothing.
 */
function openWithLink(db: Db, token: string, now: number): { sessionId: string } | { refused: string } {
  return db.transaction(() => {
    const who = takeDashboardLink(db, token, now);
    if (who === null) return { refused: LINK_NOT_VALID };
    if (!membersSeeTeam(db, who.teamId)) return { refused: DASHBOARD_ADMINS_ONLY };
    return { sessionId: createMemberSession(db, who) };
  }).immediate();
}

/** A member opening the dashboard: their machine asks for a one-time link and their browser opens it. Mounted in both modes. */
export function memberSignInRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts } = ctx;

  app.post("/api/dashboard-link", (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c);
    const who = token ? authenticate(db, token) : null;
    if (!who) return fail(c, 401, "unauthorized");
    if (!membersSeeTeam(db, who.teamId)) return fail(c, 403, DASHBOARD_ADMINS_ONLY);
    const link = createDashboardLink(db, who, ctx.now());
    return c.json({ path: `/open#${link}`, expiresIn: DASHBOARD_LINK_SECONDS });
  });

  app.post("/api/dashboard-link/open", async (c) => {
    c.header("Cache-Control", "no-store");
    // A hosted server signs a browser in only from its own pages; a self-hosted one has no public URL to compare.
    const crossSiteRefusal = opts.hosted ? crossSite(c, opts.hosted.publicUrl) : null;
    if (crossSiteRefusal) return crossSiteRefusal;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (typeof body.token !== "string" || !LINK_TOKEN.test(body.token)) return fail(c, 400, "invalid token");
    // An unknown token is not counted as a failed attempt: a link's 256 random bits are not guessed.
    const opened = openWithLink(db, body.token, ctx.now());
    if ("refused" in opened) return fail(c, 403, opened.refused);
    setSessionCookie(c, opened.sessionId);
    return c.body(null, 204);
  });
}
