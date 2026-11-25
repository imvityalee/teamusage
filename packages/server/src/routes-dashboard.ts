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
import { teamById } from "./hosted-teams.js";
import { bearerToken, fail, setSessionCookie } from "./http.js";
import { createTeamSession } from "./sessions.js";
import { DASHBOARD_LIMITED, statsAccess } from "./stats-access.js";
import { getStats } from "./stats.js";
import { authenticate, forTeam } from "./team-data.js";

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

/** The routes the dashboard uses: signing in with an invite code and reading a team's stats. */
export function dashboardRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, teamOfInvite, session: sessionOf } = ctx;

  app.post("/api/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const entry = await teamOfInvite(c);
    if (entry instanceof Response) return entry;
    if (teamById(db, entry.teamId)?.dashboardAccess === "admins") return fail(c, 403, DASHBOARD_LIMITED);
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

    const { teamId, member: self, teamNumbers } = access;
    const { member } = c.req.query();
    if (member === "me") {
      // `me` is the token's member; a session or the demo has no member of its own.
      if (self === null) return fail(c, 400, "invalid member");
      return c.json(getStats(db, teamId, { ...range, memberId: self.memberId }));
    }
    if (!teamNumbers) return fail(c, 403, DASHBOARD_LIMITED);
    if (member === undefined) return c.json(getStats(db, teamId, range));
    if (!MEMBER_ID.test(member)) return fail(c, 400, "invalid query");
    const memberId = Number(member);
    if (!Number.isSafeInteger(memberId)) return fail(c, 400, "invalid query");
    if (!forTeam(db, teamId).memberExists(memberId)) return fail(c, 404, "member not found");
    return c.json(getStats(db, teamId, { ...range, memberId }));
  });
}
