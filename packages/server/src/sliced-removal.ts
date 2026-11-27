import type { Context } from "hono";
import type { RouteContext } from "./app-context.js";
import type { Role } from "./hosted-teams.js";
import { teamAccess, type GithubSession, type TeamAccess } from "./team-access.js";
import type { TeamData } from "./team-data.js";

/** What a removal in slices does: the slice it repeats and the last step. */
export type SlicedRemoval = {
  /** Removes up to `most` of the team's usage rows and returns how many. */
  slice: (team: TeamData, most: number) => number;
  /** The last step and the answer to the request. */
  finish: (access: TeamAccess) => Response;
};

/**
 * Runs a removal for `user` in slices of `ctx.removal.sliceRows` usage rows. Before each slice it reads the team the URL
 * names and the user's role in it, and a refusal ends the request there. After a full slice it waits for
 * `ctx.removal.pause()`, which lets other requests in; after one that was not full it runs `finish` in the same turn.
 * Nothing else is awaited, so nothing is written on a role read before a pause.
 */
export async function removeInSlices(
  ctx: RouteContext,
  c: Context,
  user: GithubSession,
  allowed: readonly Role[],
  removal: SlicedRemoval,
): Promise<Response> {
  for (;;) {
    const access = teamAccess(ctx, c, user, allowed);
    if (access instanceof Response) return access;
    const most = ctx.removal.sliceRows;
    if (removal.slice(ctx.team(access.team.id), most) < most) return removal.finish(access);
    await ctx.removal.pause();
  }
}
