import { parseAccountKey, parsePlanKey } from "@teamusage/shared";

/**
 * SQL condition on `usage` alias `u` for the agent, model, account and plan filters, with its bound values. Only the
 * number of placeholders depends on the input; every value is bound by name, never written into the SQL text.
 * Combination rule: a row is included when (no agent filter OR its agent is listed) AND
 * (no model filter OR its (agent, model) pair is listed) AND (no account filter OR its account key is listed) AND
 * (no plan filter OR its plan key is listed).
 * Account keys: `unknown` is an unlabelled Claude row, `other` an unlabelled row of any other agent,
 * `chatgpt:<kind>` a Codex label; `team:`/`enterprise:` treat a null org as the empty org. Plan keys: `none` is no
 * plan, else `<agent>:<plan>`. A malformed key matches nothing.
 */
export function usageFilter(
  agents: string[],
  models: { agent: string; model: string }[],
  accounts: string[],
  plans: string[],
): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const parts: string[] = [];
  if (agents.length > 0) {
    parts.push(`u.agent in (${agents.map((_, i) => `@fa${i}`).join(", ")})`);
    agents.forEach((a, i) => (params[`fa${i}`] = a));
  }
  if (models.length > 0) {
    parts.push(`(u.agent, u.model) in (values ${models.map((_, i) => `(@fm${i}a, @fm${i}m)`).join(", ")})`);
    models.forEach((m, i) => {
      params[`fm${i}a`] = m.agent;
      params[`fm${i}m`] = m.model;
    });
  }
  if (accounts.length > 0) {
    const alts = accounts.map((key, i) => {
      const a = parseAccountKey(key);
      if (!a) return "0";
      if (a.kind === "unknown") return "(u.account_kind is null and u.agent = 'claude')";
      if (a.kind === "other") return "(u.account_kind is null and u.agent <> 'claude')";
      params[`fk${i}`] = a.kind;
      if (a.agent === "codex") return `(u.agent = 'codex' and u.account_kind = @fk${i})`;
      if (a.org === null) return `(u.agent = 'claude' and u.account_kind = @fk${i})`;
      params[`fo${i}`] = a.org;
      return `(u.agent = 'claude' and u.account_kind = @fk${i} and coalesce(u.account_org, '') = @fo${i})`;
    });
    parts.push(`(${alts.join(" or ")})`);
  }
  if (plans.length > 0) {
    const alts = plans.map((key, i) => {
      const p = parsePlanKey(key);
      if (!p) return "0";
      if (p.agent === null) return "u.account_plan is null";
      params[`pa${i}`] = p.agent;
      params[`pp${i}`] = p.plan;
      return `(u.agent = @pa${i} and u.account_plan = @pp${i})`;
    });
    parts.push(`(${alts.join(" or ")})`);
  }
  return { sql: parts.length > 0 ? parts.join(" and ") : "1", params };
}
