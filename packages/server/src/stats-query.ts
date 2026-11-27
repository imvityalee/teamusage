import type { Context } from "hono";
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
import type { getStats } from "./stats.js";

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

export type StatsRange = Parameters<typeof getStats>[2];

/**
 * The date range and filters of a stats request; a string is the 400's error. Repeated parameters are ambiguous,
 * so they are rejected rather than resolved by position; only `agent`, `model`, `account` and `plan` may repeat.
 */
export function parseRange(c: Context): StatsRange | string {
  if (["from", "to", "member", "team"].some((k) => (c.req.queries(k)?.length ?? 0) > 1)) return "invalid query";
  const { from, to } = c.req.query();
  if (from === undefined || to === undefined || checkRange(from, to) !== "ok") return "invalid date range";
  const filters = parseFilters(c.req.queries("agent"), c.req.queries("model"), c.req.queries("account"), c.req.queries("plan"));
  return filters ? { from, to, ...filters } : "invalid query";
}

/** The member id a `member` parameter names; null when it is not a positive whole number of at most ten digits. */
export function parseMemberId(value: string): number | null {
  return MEMBER_ID.test(value) ? Number(value) : null;
}
