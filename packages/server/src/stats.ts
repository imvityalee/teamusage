import { accountKey, parseAccountKey, parsePlanKey, planKey, type AccountKind, type Stats } from "@teamusage/shared";
import type { Db } from "./db.js";

/** SQLite `total()` returns a float and cannot overflow; anything non-finite is clamped, never emitted as null. */
const finite = (n: number): number => (Number.isFinite(n) ? n : n > 0 ? Number.MAX_VALUE : n < 0 ? -Number.MAX_VALUE : 0);
const round6 = (n: number): number => finite(Math.round(finite(n) * 1e6) / 1e6);

/** Every date from `from` to `to` inclusive. Callers validate the range first. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

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
function usageFilter(
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

/** The filter key of a stored label. Validation guarantees a non-null kind is an AccountKind. */
function labelKey(agent: string, kind: AccountKind | null, org: string | null): string {
  if (kind === null || (agent !== "claude" && agent !== "codex")) return accountKey(null, agent);
  return accountKey({ kind, ...(org === null ? {} : { org }) }, agent);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byTokensDesc = (a: [string, number], b: [string, number]): number => b[1] - a[1] || cmp(a[0], b[0]);

/** Every account and every plan in the range (and member), ignoring all filters, tokens desc then key. One grouped query. */
function availableAccountsAndPlans(
  db: Db,
  p: { from: string; to: string; memberId: number | null },
): { accounts: { key: string; tokens: number }[]; plans: { key: string; tokens: number }[] } {
  const rows = db
    .prepare(
      `select agent, account_kind as kind, account_org as org, account_plan as plan, total(total) as total from usage
       where date between @from and @to and (@memberId is null or member_id = @memberId)
       group by agent, account_kind, account_org, account_plan`,
    )
    .all(p) as { agent: string; kind: AccountKind | null; org: string | null; plan: string | null; total: number }[];
  const accounts = new Map<string, number>();
  const plans = new Map<string, number>();
  for (const r of rows) {
    const t = finite(r.total);
    const ak = labelKey(r.agent, r.kind, r.org);
    accounts.set(ak, finite((accounts.get(ak) ?? 0) + t));
    const pk = planKey(r.agent, r.plan);
    plans.set(pk, finite((plans.get(pk) ?? 0) + t));
  }
  const list = (m: Map<string, number>) => [...m].sort(byTokensDesc).map(([key, tokens]) => ({ key, tokens }));
  return { accounts: list(accounts), plans: list(plans) };
}

/** Aggregates usage for the range. Does not validate; every value reaches SQL as a bound parameter. */
export function getStats(
  db: Db,
  q: {
    from: string;
    to: string;
    memberId?: number;
    agents?: string[];
    models?: { agent: string; model: string }[];
    accounts?: string[];
    plans?: string[];
  },
): Stats {
  const memberId = q.memberId ?? null;
  const filter = usageFilter(q.agents ?? [], q.models ?? [], q.accounts ?? [], q.plans ?? []);
  const p = { from: q.from, to: q.to, memberId, ...filter.params };

  const memberRows = db
    .prepare(
      `select m.id as id, m.name as name, m.email as email,
         (select coalesce(total(u.total), 0) from usage u
            where u.member_id = m.id and u.date between @from and @to and ${filter.sql}) as tokens,
         (select coalesce(sum(u.cost_usd), 0) from usage u
            where u.member_id = m.id and u.date between @from and @to and ${filter.sql}) as cost,
         (select count(*) from machines x where x.member_id = m.id) as machines,
         (select max(x.last_sync_at) from machines x where x.member_id = m.id) as lastSyncAt
       from members m
       where (@memberId is null or m.id = @memberId)
       order by tokens desc, m.name, m.id`,
    )
    .all(p) as { id: number; name: string; email: string; tokens: number; cost: number; machines: number; lastSyncAt: string | null }[];

  const modelRows = db
    .prepare(
      `select agent, model, total(input) as input, total(output) as output, total(cache_create) as cacheCreate,
         total(cache_read) as cacheRead, total(total) as total, sum(cost_usd) as cost, max(unpriced) as unpriced
       from usage u
       where date between @from and @to and (@memberId is null or member_id = @memberId) and ${filter.sql}
       group by agent, model
       order by total desc, agent, model`,
    )
    .all(p) as {
    agent: string;
    model: string;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    total: number;
    cost: number;
    unpriced: number;
  }[];

  const dayRows = db
    .prepare(
      `select date, agent, total(total) as total
       from usage u
       where date between @from and @to and (@memberId is null or member_id = @memberId) and ${filter.sql}
       group by date, agent`,
    )
    .all(p) as { date: string; agent: string; total: number }[];

  // Each member's tokens by agent, with the same range, member and filters: one grouped query for every member.
  const mixRows = db
    .prepare(
      `select member_id as memberId, agent, total(total) as total
       from usage u
       where date between @from and @to and (@memberId is null or member_id = @memberId) and ${filter.sql}
       group by member_id, agent`,
    )
    .all(p) as { memberId: number; agent: string; total: number }[];
  const mixes = new Map<number, Map<string, number>>();
  for (const r of mixRows) {
    const mix = mixes.get(r.memberId) ?? new Map<string, number>();
    mix.set(r.agent, finite(r.total));
    mixes.set(r.memberId, mix);
  }

  // Each member's tokens by account and by account and plan, with the same range, member and filters: one grouped
  // query for every member. A null and an empty org are the same key, so rows are merged by key.
  const accountRows = db
    .prepare(
      `select member_id as memberId, agent, account_kind as kind, account_org as org, account_plan as plan, total(total) as total
       from usage u
       where date between @from and @to and (@memberId is null or member_id = @memberId) and ${filter.sql}
       group by member_id, agent, account_kind, account_org, account_plan`,
    )
    .all(p) as { memberId: number; agent: string; kind: AccountKind | null; org: string | null; plan: string | null; total: number }[];
  const accountMixes = new Map<number, Map<string, number>>();
  const planMixes = new Map<number, Map<string, { account: string; plan: string; tokens: number }>>();
  for (const r of accountRows) {
    const t = finite(r.total);
    const account = labelKey(r.agent, r.kind, r.org);
    const mix = accountMixes.get(r.memberId) ?? new Map<string, number>();
    mix.set(account, finite((mix.get(account) ?? 0) + t));
    accountMixes.set(r.memberId, mix);
    const plan = planKey(r.agent, r.plan);
    const pm = planMixes.get(r.memberId) ?? new Map<string, { account: string; plan: string; tokens: number }>();
    const id = JSON.stringify([account, plan]);
    const e = pm.get(id) ?? { account, plan, tokens: 0 };
    e.tokens = finite(e.tokens + t);
    pm.set(id, e);
    planMixes.set(r.memberId, pm);
  }
  const accountPlans = (id: number) =>
    [...(planMixes.get(id)?.values() ?? [])].sort((a, b) => b.tokens - a.tokens || cmp(a.account, b.account) || cmp(a.plan, b.plan));

  // Filter controls: the same range and member, but never the agent/model/account/plan filters.
  const availRows = db
    .prepare(
      `select agent, model, total(total) as total from usage
       where date between @from and @to and (@memberId is null or member_id = @memberId)
       group by agent, model`,
    )
    .all({ from: q.from, to: q.to, memberId }) as { agent: string; model: string; total: number }[];
  const agentTotals = new Map<string, number>();
  for (const r of availRows) agentTotals.set(r.agent, (agentTotals.get(r.agent) ?? 0) + finite(r.total));
  const available = {
    agents: [...agentTotals].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([a]) => a),
    models: [...availRows]
      .sort((a, b) => finite(b.total) - finite(a.total) || cmp(a.agent, b.agent) || cmp(a.model, b.model))
      .map((r) => ({ agent: r.agent, model: r.model, tokens: finite(r.total) })),
    ...availableAccountsAndPlans(db, { from: q.from, to: q.to, memberId }),
  };

  // Agent ids are data: a Map plus fromEntries makes `__proto__` an ordinary own property.
  const byDate = new Map<string, Map<string, number>>(datesBetween(q.from, q.to).map((d) => [d, new Map()]));
  for (const r of dayRows) byDate.get(r.date)?.set(r.agent, finite(r.total));
  const daily = [...byDate].map(([date, agents]) => ({
    date,
    byAgent: Object.fromEntries(agents) as Record<string, number>,
  }));

  // Machines are exposed by label and last sync only, never by id. Never-synced last; ties by label then id.
  const machines =
    memberId === null
      ? undefined
      : (
          db
            .prepare(
              `select label, last_sync_at as lastSyncAt from machines
               where member_id = @memberId
               order by (last_sync_at is null), last_sync_at desc, label, id`,
            )
            .all({ memberId }) as { label: string; lastSyncAt: string | null }[]
        ).map((x) => ({ label: x.label, lastSyncAt: x.lastSyncAt }));

  return {
    from: q.from,
    to: q.to,
    totals: {
      tokens: finite(memberRows.reduce((s, m) => s + m.tokens, 0)),
      costUsd: round6(memberRows.reduce((s, m) => s + m.cost, 0)),
      activeMembers: memberRows.filter((m) => m.tokens > 0).length,
      memberCount: memberRows.length,
    },
    daily,
    members: memberRows.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      tokens: finite(m.tokens),
      costUsd: round6(m.cost),
      machines: m.machines,
      lastSyncAt: m.lastSyncAt,
      // Agent ids are data: fromEntries makes `__proto__` an ordinary own property.
      byAgent: Object.fromEntries(mixes.get(m.id) ?? []) as Record<string, number>,
      // Account keys hold organisation names, which are data: same technique as byAgent.
      byAccount: Object.fromEntries(accountMixes.get(m.id) ?? []) as Record<string, number>,
      byAccountPlan: accountPlans(m.id),
    })),
    ...(machines ? { machines } : {}),
    available,
    models: modelRows.map((m) => ({
      agent: m.agent,
      model: m.model,
      input: finite(m.input),
      output: finite(m.output),
      cacheCreate: finite(m.cacheCreate),
      cacheRead: finite(m.cacheRead),
      total: finite(m.total),
      costUsd: round6(m.cost),
      unpriced: m.unpriced > 0,
    })),
  };
}

export function memberExists(db: Db, memberId: number): boolean {
  return db.prepare("select 1 from members where id = ?").get(memberId) !== undefined;
}
