import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
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
import { bearerToken, fail, isObject, readJson, SESSION_COOKIE, setSessionCookie } from "./http.js";
import { createTeamSession, findSession } from "./sessions.js";
import { getStats } from "./stats.js";
import { authenticate, forTeam, type MachineIdentity } from "./team-data.js";

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

/** The routes the dashboard uses: signing in with an invite code and reading the team's stats. */
export function dashboardRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, throttled, teamOfInvite } = ctx;

  /** The team a stats request reads: the demo team, else a presented token's, else a team session's; null when none. */
  const statsTeam = (token: string | undefined, who: MachineIdentity | null, sessionId: string | undefined): number | null => {
    if (opts.demoTeamId !== undefined) return opts.demoTeamId;
    // A presented bearer token must be valid; it wins over a cookie, but a bad one is never rescued by a cookie.
    if (token !== undefined) return who?.teamId ?? null;
    // A user's session is not a team's: here it counts as no session.
    const session = sessionId ? findSession(db, sessionId) : null;
    return session?.kind === "team" ? session.teamId : null;
  };

  app.post("/api/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const limited = throttled(c);
    if (limited) return limited;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    const teamId = teamOfInvite(c, body.inviteCode);
    if (teamId === null) return fail(c, 403, "invalid invite code");
    setSessionCookie(c, createTeamSession(db, teamId));
    return c.body(null, 204);
  });

  app.get("/api/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c);
    const who = token ? authenticate(db, token) : null;
    const teamId = statsTeam(token, who, getCookie(c, SESSION_COOKIE));
    if (teamId === null) return fail(c, 401, "unauthorized");

    const { from, to, member } = c.req.query();
    // Repeated parameters are ambiguous, so they are rejected rather than resolved by position.
    // Only `agent`, `model`, `account` and `plan` are lists and may repeat.
    const repeated = ["from", "to", "member"].some((k) => (c.req.queries(k)?.length ?? 0) > 1);
    if (repeated) return fail(c, 400, "invalid query");
    if (from === undefined || to === undefined || checkRange(from, to) !== "ok") return fail(c, 400, "invalid date range");
    const filters = parseFilters(c.req.queries("agent"), c.req.queries("model"), c.req.queries("account"), c.req.queries("plan"));
    if (!filters) return fail(c, 400, "invalid query");
    const range = { from, to, ...filters };
    if (member === undefined) return c.json(getStats(db, teamId, range));
    if (member === "me") {
      // `me` is the token's member; a cookie or demo session has no member of its own.
      if (!who || opts.demoTeamId !== undefined) return fail(c, 400, "invalid member");
      return c.json(getStats(db, teamId, { ...range, memberId: who.memberId }));
    }
    if (!MEMBER_ID.test(member)) return fail(c, 400, "invalid query");
    const memberId = Number(member);
    if (!Number.isSafeInteger(memberId)) return fail(c, 400, "invalid query");
    if (!forTeam(db, teamId).memberExists(memberId)) return fail(c, 404, "member not found");
    return c.json(getStats(db, teamId, { ...range, memberId }));
  });
}
