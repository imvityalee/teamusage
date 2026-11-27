import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import type { Db } from "./db.js";
import { deleteTeam, isDashboardAccess, isTeamName, type DashboardAccess } from "./hosted-teams.js";
import { crossSite, fail, readObject } from "./http.js";
import { removeInSlices } from "./sliced-removal.js";
import { ANY_ROLE, githubSession, MANAGERS, OWNER_ONLY, teamAccess, userTeam } from "./team-access.js";
import { renameTeam, rotateTeamCode, setDashboardAccess, teamCode } from "./team-settings.js";

export const CODE_NOT_SHOWN = "this code can no longer be shown; rotate it";
export const NAME_DOES_NOT_MATCH = "the name does not match";

/** What a PATCH of a team asks to change; only the fields it names. */
type Changes = { name?: string; dashboardAccess?: DashboardAccess };

/** The changes the body asks for, the name trimmed; otherwise the text of the 400 that refuses it. */
function parseChanges(body: Record<string, unknown>): Changes | string {
  const changes: Changes = {};
  if (body.name !== undefined) {
    if (!isTeamName(body.name)) return "invalid name";
    changes.name = body.name.trim();
  }
  if (body.dashboardAccess !== undefined) {
    if (!isDashboardAccess(body.dashboardAccess)) return "invalid dashboardAccess";
    changes.dashboardAccess = body.dashboardAccess;
  }
  return Object.keys(changes).length === 0 ? "nothing to change" : changes;
}

/** True when `sent`, trimmed, is the stored team name; both are compared in Unicode form NFC. */
const sameName = (sent: string, stored: string): boolean => sent.trim().normalize("NFC") === stored.normalize("NFC");

/** Applies every change of `changes` to team `teamId` in one transaction. */
function applyChanges(db: Db, teamId: number, changes: Changes): void {
  db.transaction(() => {
    if (changes.name !== undefined) renameTeam(db, teamId, changes.name);
    if (changes.dashboardAccess !== undefined) setDashboardAccess(db, teamId, changes.dashboardAccess);
  })();
}

/** Reading a team, changing its name and dashboard access, showing and rotating its code, and deleting it. Mounted only on a hosted server. */
export function teamSettingsRoutes(app: Hono, ctx: RouteContext): void {
  const hosted = ctx.opts.hosted;
  if (hosted === undefined) return;

  app.get("/api/teams/:team", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, ANY_ROLE);
    if (access instanceof Response) return access;
    return c.json({ team: userTeam(access) });
  });

  app.patch("/api/teams/:team", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    const changes = parseChanges(body);
    if (typeof changes === "string") return fail(c, 400, changes);
    // The role is read after the body, which the role's removal may have outrun; nothing is awaited from here to the write.
    const access = teamAccess(ctx, c, user, changes.dashboardAccess === undefined ? MANAGERS : OWNER_ONLY);
    if (access instanceof Response) return access;
    applyChanges(ctx.db, access.team.id, changes);
    return c.json({ team: userTeam({ role: access.role, team: { ...access.team, ...changes } }) });
  });

  app.get("/api/teams/:team/code", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, MANAGERS);
    if (access instanceof Response) return access;
    const code = teamCode(ctx.db, access.team.id, hosted.codeKey);
    return code === null ? fail(c, 409, CODE_NOT_SHOWN) : c.json({ code });
  });

  app.post("/api/teams/:team/code/rotate", (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, MANAGERS);
    if (access instanceof Response) return access;
    return c.json({ code: rotateTeamCode(ctx.db, access.team.id, hosted.codeKey) });
  });

  app.post("/api/teams/:team/delete", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    if (typeof body.name !== "string") return fail(c, 400, "invalid name");
    // The name is compared once the role is read, so that a caller with no role gets the 404 and learns nothing of the
    // team. Nothing is awaited from here to the first slice.
    const access = teamAccess(ctx, c, user, OWNER_ONLY);
    if (access instanceof Response) return access;
    if (!sameName(body.name, access.team.name)) return fail(c, 400, NAME_DOES_NOT_MATCH);
    // The usage goes in slices, the role read again before each; the team and the rest go in the turn of the last slice.
    return removeInSlices(ctx, c, user, OWNER_ONLY, {
      slice: (team, most) => team.removeAnyUsageSlice(most),
      finish: (last) => {
        deleteTeam(ctx.db, last.team.id);
        return c.body(null, 204);
      },
    });
  });
}
