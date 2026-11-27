import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { crossSite, fail, readObject } from "./http.js";
import { removeInSlices } from "./sliced-removal.js";
import { githubSession, MANAGERS, teamAccess } from "./team-access.js";
import { isMachineId } from "./team-data.js";
import type { Removal } from "./team-removal.js";
import { rotateTeamCode } from "./team-settings.js";

/** Most members, and most machines, one removal names. */
export const MAX_REMOVAL_IDS = 500;

/** What a removal asks for: the members and machines, and whether the team gets a new code. */
type RemovalRequest = { what: Removal; rotateCode: boolean };

const isMemberId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** `v` when it is a list of at most MAX_REMOVAL_IDS ids, each of which `isId` accepts; otherwise null. */
function idList<T>(v: unknown, isId: (id: unknown) => id is T): T[] | null {
  return Array.isArray(v) && v.length <= MAX_REMOVAL_IDS && v.every(isId) ? v : null;
}

/** The removal the body asks for; otherwise the text of the 400 that refuses it. */
function parseRemoval(body: Record<string, unknown>): RemovalRequest | string {
  const members = idList(body.members, isMemberId);
  if (members === null) return "invalid members";
  const machines = idList(body.machines, isMachineId);
  if (machines === null) return "invalid machines";
  if (typeof body.rotateCode !== "boolean") return "invalid rotateCode";
  if (members.length === 0 && machines.length === 0) return "nothing to remove";
  return { what: { members, machines }, rotateCode: body.rotateCode };
}

/** Listing a team's members with their machines, and removing members and machines. Mounted only on a hosted server. */
export function teamMembersRoutes(app: Hono, ctx: RouteContext): void {
  const hosted = ctx.opts.hosted;
  if (hosted === undefined) return;

  app.get("/api/teams/:team/members", (c) => {
    c.header("Cache-Control", "no-store");
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const access = teamAccess(ctx, c, user, MANAGERS);
    if (access instanceof Response) return access;
    return c.json({ members: ctx.team(access.team.id).listMembers() });
  });

  /** The last step of a removal, in one transaction: the members and machines, and the new code when it was asked for. */
  const finishRemoval = (teamId: number, asked: RemovalRequest) =>
    ctx.db.transaction(() => {
      const removed = ctx.team(teamId).remove(asked.what);
      return asked.rotateCode ? { removed, code: rotateTeamCode(ctx.db, teamId, hosted.codeKey) } : { removed };
    })();

  app.post("/api/teams/:team/removals", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const user = githubSession(ctx, c);
    if (user instanceof Response) return user;
    const body = await readObject(c);
    if (body instanceof Response) return body;
    const asked = parseRemoval(body);
    if (typeof asked === "string") return fail(c, 400, asked);
    // The usage goes in slices, the role read again before each; the rest goes in the turn of the last slice.
    return removeInSlices(ctx, c, user, MANAGERS, {
      slice: (team, most) => team.removeUsageSlice(asked.what, most),
      finish: (access) => c.json(finishRemoval(access.team.id, asked)),
    });
  });
}
