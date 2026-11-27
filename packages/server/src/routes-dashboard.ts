import type { Context, Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { bearerToken, fail, setSessionCookie, signInCrossSite } from "./http.js";
import { statsTooLargeAnswer, teamStatsBusyAnswer } from "./limit-answers.js";
import { createTeamSession } from "./sessions.js";
import { CODE_OPENS_NO_DASHBOARD, DASHBOARD_LIMITED, statsAccess, type StatsAccess } from "./stats-access.js";
import { createStatsBudget } from "./stats-budget.js";
import { StatsTooLargeError } from "./stats-bounds.js";
import { parseMemberId, parseRange } from "./stats-query.js";
import { getStats } from "./stats.js";
import { authenticate } from "./team-data.js";

/**
 * The member whose stats the request asks for, or null for the whole team; otherwise the answer that refuses the
 * request. `me` is the member of the token or of a member's session; any other session, or the demo, has no member
 * of its own.
 */
function askedMember(
  c: Context,
  access: Extract<StatsAccess, { ok: true }>,
  team: RouteContext["team"],
): number | null | Response {
  const { member } = c.req.query();
  if (member === "me") return access.member === null ? fail(c, 400, "invalid member") : access.member.memberId;
  if (!access.teamNumbers) return fail(c, 403, DASHBOARD_LIMITED);
  if (member === undefined) return null;
  const memberId = parseMemberId(member);
  if (memberId === null) return fail(c, 400, "invalid query");
  if (!team(access.teamId).memberExists(memberId)) return fail(c, 404, "member not found");
  return memberId;
}

/** The routes the dashboard uses: signing in with an invite code, on a self-hosted server only, and reading a team's stats. */
export function dashboardRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, team, teamOfInvite, session: sessionOf } = ctx;
  const statsBudget = opts.limits && createStatsBudget({ msPerMinute: opts.limits.teamStatsMsPerMinute, now: ctx.now });

  /** The answer when the team's statistics have used up their minute; otherwise null. */
  const statsBusy = (c: Context, teamId: number): Response | null => {
    const wait = statsBudget?.retryAfter(teamId) ?? null;
    return wait === null ? null : teamStatsBusyAnswer(c, wait);
  };

  /** Runs `work` and, on a hosted server, spends the time it took for the team, whether it returns or throws. */
  const timed = <T>(teamId: number, work: () => T): T => {
    if (!statsBudget) return work();
    const start = ctx.stopwatch();
    try {
      return work();
    } finally {
      statsBudget.spend(teamId, ctx.stopwatch() - start);
    }
  };

  app.post("/api/login", async (c) => {
    c.header("Cache-Control", "no-store");
    // On a hosted server the code only joins a team. The refusal reads no body and counts no attempt, so it tests no code.
    if (opts.hosted) return fail(c, 403, CODE_OPENS_NO_DASHBOARD);
    const crossSiteRefusal = signInCrossSite(c, opts.hosted, opts.signInOrigin);
    if (crossSiteRefusal) return crossSiteRefusal;
    const entry = await teamOfInvite(c);
    if (entry instanceof Response) return entry;
    setSessionCookie(c, createTeamSession(db, entry.teamId));
    return c.body(null, 204);
  });

  app.get("/api/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c);
    const teams = c.req.queries("team") ?? [];
    const access = statsAccess(db, {
      demoTeamId: opts.demoTeamId,
      token,
      who: token ? authenticate(db, token) : null,
      session: sessionOf(c),
      // A repeated `team` is ambiguous, so it names no team rather than the first one given.
      teamParam: teams.length === 1 ? teams[0] : undefined,
      codeSessions: !opts.hosted,
    });
    if (!access.ok) return fail(c, access.status, access.error);
    const range = parseRange(c);
    if (typeof range === "string") return fail(c, 400, range);

    const memberId = askedMember(c, access, team);
    if (memberId instanceof Response) return memberId;
    const busy = statsBusy(c, access.teamId);
    if (busy) return busy;
    try {
      return c.json(timed(access.teamId, () => getStats(db, access.teamId, memberId === null ? range : { ...range, memberId })));
    } catch (err) {
      if (err instanceof StatsTooLargeError) return statsTooLargeAnswer(c);
      throw err;
    }
  });
}
