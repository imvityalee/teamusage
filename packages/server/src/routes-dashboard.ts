import type { Context, Hono } from "hono";
import {
  checkRange,
  isName,
  MAX_ACCOUNT_FILTERS,
  MAX_AGENT_CHARS,
  MAX_AGENT_FILTERS,
  MAX_MODEL_CHARS,
  MAX_MODEL_FILTERS,
  MAX_PLAN_FILTERS,
  parseAccountKey,
  parsePlanKey,
} from "@teamusage/shared";
import type { RouteContext } from "./app-context.js";
import { opensWithCode } from "./hosted-teams.js";
import { bearerToken, crossSite, fail, setSessionCookie } from "./http.js";
import { statsTooLargeAnswer, teamStatsBusyAnswer } from "./limit-answers.js";
import { createTeamSession } from "./sessions.js";
import { DASHBOARD_LIMITED, statsAccess, type StatsAccess } from "./stats-access.js";
import { createStatsBudget } from "./stats-budget.js";
import { StatsTooLargeError } from "./stats-bounds.js";
import { getStats } from "./stats.js";
import { authenticate } from "./team-data.js";

const MEMBER_ID = /^[1-9][0-9]{0,9}$/;

/**
 * Parses repeated `agent`, `model` (`<agent>:<model>`, split on the first colon) and `account` (an account key,
 * see parseAccountKey) and `plan` (a plan key, see parsePlanKey). Undefined when malformed.
 */
function parseFilters(
  agentValues: string[] = [],
  modelValues: string[] = [],
  accountValues: string[] = [],
  planValues: string[] = [],
): { agents: string[]; models: { agent: string; model: string }[]; accounts: string[]; plans: string[] } | undefined {
  if (agentValues.length > MAX_AGENT_FILTERS || modelValues.length > MAX_MODEL_FILTERS) return undefined;
  if (accountValues.length > MAX_ACCOUNT_FILTERS) return undefined;
  if (!accountValues.every((k) => parseAccountKey(k) !== undefined)) return undefined;
  if (planValues.length > MAX_PLAN_FILTERS || !planValues.every((k) => parsePlanKey(k) !== undefined)) return undefined;
  if (!agentValues.every((a) => isName(a, MAX_AGENT_CHARS))) return undefined;
  const models = new Map<string, { agent: string; model: string }>();
  for (const v of modelValues) {
    const i = v.indexOf(":");
    if (i < 0) return undefined;
    const agent = v.slice(0, i);
    const model = v.slice(i + 1);
    if (!isName(agent, MAX_AGENT_CHARS) || !isName(model, MAX_MODEL_CHARS)) return undefined;
    models.set(v, { agent, model });
  }
  return {
    agents: [...new Set(agentValues)],
    models: [...models.values()],
    accounts: [...new Set(accountValues)],
    plans: [...new Set(planValues)],
  };
}

type StatsRange = Parameters<typeof getStats>[2];

/**
 * The date range and filters of a stats request; a string is the 400's error. Repeated parameters are ambiguous,
 * so they are rejected rather than resolved by position; only `agent`, `model`, `account` and `plan` may repeat.
 */
function parseRange(c: Context): StatsRange | string {
  if (["from", "to", "member", "team"].some((k) => (c.req.queries(k)?.length ?? 0) > 1)) return "invalid query";
  const { from, to } = c.req.query();
  if (from === undefined || to === undefined || checkRange(from, to) !== "ok") return "invalid date range";
  const filters = parseFilters(c.req.queries("agent"), c.req.queries("model"), c.req.queries("account"), c.req.queries("plan"));
  return filters ? { from, to, ...filters } : "invalid query";
}

/**
 * The member whose stats the request asks for, or null for the whole team; otherwise the answer that refuses the
 * request. `me` is the token's member; a session or the demo has no member of its own.
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
  if (!MEMBER_ID.test(member)) return fail(c, 400, "invalid query");
  const memberId = Number(member);
  if (!Number.isSafeInteger(memberId)) return fail(c, 400, "invalid query");
  if (!team(access.teamId).memberExists(memberId)) return fail(c, 404, "member not found");
  return memberId;
}

/** The routes the dashboard uses: signing in with an invite code and reading a team's stats. */
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
    // A hosted server signs a browser in only from its own pages; a self-hosted one has no public URL to compare.
    const refused = opts.hosted ? crossSite(c, opts.hosted.publicUrl) : null;
    if (refused) return refused;
    const entry = await teamOfInvite(c);
    if (entry instanceof Response) return entry;
    if (!opensWithCode(db, entry.teamId)) return fail(c, 403, DASHBOARD_LIMITED);
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
