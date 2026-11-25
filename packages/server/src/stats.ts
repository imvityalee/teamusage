import { accountKey, datesBetween, planKey, type AccountKind, type Stats } from "@teamusage/shared";
import type { Db } from "./db.js";
import { usageFilter } from "./stats-filter.js";

/** SQLite `total()` returns a float and cannot overflow; anything non-finite is clamped, never emitted as null. */
const finite = (n: number): number => (Number.isFinite(n) ? n : n > 0 ? Number.MAX_VALUE : n < 0 ? -Number.MAX_VALUE : 0);
const round6 = (n: number): number => finite(Math.round(finite(n) * 1e6) / 1e6);

/** The filter key of a stored label. Validation guarantees a non-null kind is an AccountKind. */
function labelKey(agent: string, kind: AccountKind | null, org: string | null): string {
  if (kind === null || (agent !== "claude" && agent !== "codex")) return accountKey(null, agent);
  return accountKey({ kind, ...(org === null ? {} : { org }) }, agent);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byTokensDesc = (a: [string, number], b: [string, number]): number => b[1] - a[1] || cmp(a[0], b[0]);

/** Adds `n` to `key`'s entry, keeping the sum finite. */
function add<K>(map: Map<K, number>, key: K, n: number): void {
  map.set(key, finite((map.get(key) ?? 0) + n));
}

/** The value for `key`, created with `make` on first use. */
function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** The team, the date range and, when one is asked for, the member. */
type Scope = { teamId: number; from: string; to: string; memberId: number | null };
type Filter = ReturnType<typeof usageFilter>;

/**
 * Condition on `usage u` for the rows inside the scope, with its bound values; every query on `usage` uses it, and
 * its leading columns are those of `usage_team_date` (team view) or `usage_team_member_date` (a member's view).
 */
function inScope(scope: Scope): { sql: string; params: Record<string, number | string> } {
  const { teamId, from, to, memberId } = scope;
  return memberId === null
    ? { sql: "u.team_id = @teamId and u.date between @from and @to", params: { teamId, from, to } }
    : { sql: "u.team_id = @teamId and u.member_id = @memberId and u.date between @from and @to", params: { teamId, memberId, from, to } };
}

const select = <T>(db: Db, sql: string, params: object): T[] => db.prepare(sql).all(params) as T[];

type MemberTotal = { id: number; name: string; email: string; tokens: number; cost: number; machines: number; lastSyncAt: string | null };

/** Every member in scope with their filtered tokens and cost, machine count and last sync; tokens desc, then name. */
function memberTotals(db: Db, scope: Scope, filter: Filter): MemberTotal[] {
  const scoped = inScope(scope);
  return select<MemberTotal>(
    db,
    `select m.id as id, m.name as name, m.email as email, coalesce(t.tokens, 0) as tokens, coalesce(t.cost, 0) as cost,
       (select count(*) from machines x where x.team_id = m.team_id and x.member_id = m.id) as machines,
       (select max(x.last_sync_at) from machines x where x.team_id = m.team_id and x.member_id = m.id) as lastSyncAt
     from members m
     left join (
       select u.member_id as memberId, total(u.total) as tokens, sum(u.cost_usd) as cost from usage u
       where ${scoped.sql} and ${filter.sql}
       group by u.member_id
     ) t on t.memberId = m.id
     where m.team_id = @teamId and (@memberId is null or m.id = @memberId)
     order by tokens desc, m.name, m.id`,
    { memberId: null, ...scoped.params, ...filter.params },
  );
}

/** Filtered totals per agent and model, largest first. */
function modelTotals(db: Db, scope: Scope, filter: Filter): Stats["models"] {
  const scoped = inScope(scope);
  const rows = select<{ agent: string; model: string; input: number; output: number; cacheCreate: number; cacheRead: number; total: number; cost: number; unpriced: number }>(
    db,
    `select u.agent as agent, u.model as model, total(u.input) as input, total(u.output) as output,
       total(u.cache_create) as cacheCreate, total(u.cache_read) as cacheRead, total(u.total) as total,
       sum(u.cost_usd) as cost, max(u.unpriced) as unpriced
     from usage u
     where ${scoped.sql} and ${filter.sql}
     group by u.agent, u.model
     order by total desc, u.agent, u.model`,
    { ...scoped.params, ...filter.params },
  );
  return rows.map((m) => ({
    agent: m.agent,
    model: m.model,
    input: finite(m.input),
    output: finite(m.output),
    cacheCreate: finite(m.cacheCreate),
    cacheRead: finite(m.cacheRead),
    total: finite(m.total),
    costUsd: round6(m.cost),
    unpriced: m.unpriced > 0,
  }));
}

/** Filtered tokens per day and agent, with every day of the range present (zeros included). */
function dailyByAgent(db: Db, scope: Scope, filter: Filter): Stats["daily"] {
  const scoped = inScope(scope);
  const rows = select<{ date: string; agent: string; total: number }>(
    db,
    `select u.date as date, u.agent as agent, total(u.total) as total from usage u
     where ${scoped.sql} and ${filter.sql}
     group by u.date, u.agent`,
    { ...scoped.params, ...filter.params },
  );
  const byDate = new Map<string, Map<string, number>>(datesBetween(scope.from, scope.to).map((d) => [d, new Map()]));
  for (const r of rows) byDate.get(r.date)?.set(r.agent, finite(r.total));
  // Agent ids are data: a Map plus fromEntries makes `__proto__` an ordinary own property.
  return [...byDate].map(([date, agents]) => ({ date, byAgent: Object.fromEntries(agents) as Record<string, number> }));
}

type Member = Stats["members"][number];
type Breakdown = Pick<Member, "byAgent" | "byAccount" | "byAccountPlan">;
type AccountPlan = Member["byAccountPlan"][number];

/**
 * Each member's filtered tokens by agent, by account, and by account and plan (tokens desc, then account, then plan),
 * from one grouped query. Members without usage in scope are absent.
 */
function memberBreakdowns(db: Db, scope: Scope, filter: Filter): Map<number, Breakdown> {
  const scoped = inScope(scope);
  const rows = select<{ memberId: number; agent: string; kind: AccountKind | null; org: string | null; plan: string | null; total: number }>(
    db,
    `select u.member_id as memberId, u.agent as agent, u.account_kind as kind, u.account_org as org,
       u.account_plan as plan, total(u.total) as total
     from usage u
     where ${scoped.sql} and ${filter.sql}
     group by u.member_id, u.agent, u.account_kind, u.account_org, u.account_plan`,
    { ...scoped.params, ...filter.params },
  );
  type Sums = { byAgent: Map<string, number>; byAccount: Map<string, number>; byAccountPlan: Map<string, AccountPlan> };
  const sums = new Map<number, Sums>();
  for (const r of rows) {
    const s = getOrCreate(sums, r.memberId, (): Sums => ({ byAgent: new Map(), byAccount: new Map(), byAccountPlan: new Map() }));
    const tokens = finite(r.total);
    // A null and an empty org are the same key, so rows are merged by key.
    const account = labelKey(r.agent, r.kind, r.org);
    const plan = planKey(r.agent, r.plan);
    add(s.byAgent, r.agent, tokens);
    add(s.byAccount, account, tokens);
    const e = getOrCreate(s.byAccountPlan, JSON.stringify([account, plan]), () => ({ account, plan, tokens: 0 }));
    e.tokens = finite(e.tokens + tokens);
  }
  const byTokensThenNames = (x: AccountPlan, y: AccountPlan) => y.tokens - x.tokens || cmp(x.account, y.account) || cmp(x.plan, y.plan);
  // Agent ids and account keys (which hold organisation names) are data: fromEntries makes `__proto__` an ordinary
  // own property.
  return new Map(
    [...sums].map(([id, s]) => [
      id,
      {
        byAgent: Object.fromEntries(s.byAgent) as Record<string, number>,
        byAccount: Object.fromEntries(s.byAccount) as Record<string, number>,
        byAccountPlan: [...s.byAccountPlan.values()].sort(byTokensThenNames),
      },
    ]),
  );
}

/** A member without usage in scope. A new object each time, so no answer shares one with another. */
const noBreakdown = (): Breakdown => ({ byAgent: {}, byAccount: {}, byAccountPlan: [] });

/** Everything present in scope, ignoring the agent, model, account and plan filters: it feeds the filter controls. */
function availableFilters(db: Db, scope: Scope): Stats["available"] {
  const scoped = inScope(scope);
  const models = select<{ agent: string; model: string; total: number }>(
    db,
    `select u.agent as agent, u.model as model, total(u.total) as total from usage u
     where ${scoped.sql}
     group by u.agent, u.model`,
    scoped.params,
  );
  const labels = select<{ agent: string; kind: AccountKind | null; org: string | null; plan: string | null; total: number }>(
    db,
    `select u.agent as agent, u.account_kind as kind, u.account_org as org, u.account_plan as plan, total(u.total) as total
     from usage u
     where ${scoped.sql}
     group by u.agent, u.account_kind, u.account_org, u.account_plan`,
    scoped.params,
  );
  const agents = new Map<string, number>();
  for (const r of models) add(agents, r.agent, finite(r.total));
  const accounts = new Map<string, number>();
  const plans = new Map<string, number>();
  for (const r of labels) {
    const tokens = finite(r.total);
    add(accounts, labelKey(r.agent, r.kind, r.org), tokens);
    add(plans, planKey(r.agent, r.plan), tokens);
  }
  const ranked = (m: Map<string, number>) => [...m].sort(byTokensDesc).map(([key, tokens]) => ({ key, tokens }));
  return {
    agents: [...agents].sort(byTokensDesc).map(([agent]) => agent),
    models: models
      .map((r) => ({ agent: r.agent, model: r.model, tokens: finite(r.total) }))
      .sort((a, b) => b.tokens - a.tokens || cmp(a.agent, b.agent) || cmp(a.model, b.model)),
    accounts: ranked(accounts),
    plans: ranked(plans),
  };
}

/** One member's machines by label and last sync, never by id. Never-synced last; ties by label then id. */
function memberMachines(db: Db, teamId: number, memberId: number): NonNullable<Stats["machines"]> {
  return select<{ label: string; lastSyncAt: string | null }>(
    db,
    `select label, last_sync_at as lastSyncAt from machines
     where team_id = @teamId and member_id = @memberId
     order by (last_sync_at is null), last_sync_at desc, label, id`,
    { teamId, memberId },
  );
}

/** Aggregates the usage of team `teamId` for the range. Does not validate; every value reaches SQL as a bound parameter. */
export function getStats(
  db: Db,
  teamId: number,
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
  const scope: Scope = { teamId, from: q.from, to: q.to, memberId: q.memberId ?? null };
  const filter = usageFilter(q.agents ?? [], q.models ?? [], q.accounts ?? [], q.plans ?? []);
  const members = memberTotals(db, scope, filter);
  const breakdowns = memberBreakdowns(db, scope, filter);

  return {
    from: q.from,
    to: q.to,
    totals: {
      tokens: finite(members.reduce((s, m) => s + m.tokens, 0)),
      costUsd: round6(members.reduce((s, m) => s + m.cost, 0)),
      activeMembers: members.filter((m) => m.tokens > 0).length,
      memberCount: members.length,
    },
    daily: dailyByAgent(db, scope, filter),
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      tokens: finite(m.tokens),
      costUsd: round6(m.cost),
      machines: m.machines,
      lastSyncAt: m.lastSyncAt,
      ...(breakdowns.get(m.id) ?? noBreakdown()),
    })),
    ...(scope.memberId === null ? {} : { machines: memberMachines(db, teamId, scope.memberId) }),
    available: availableFilters(db, scope),
    models: modelTotals(db, scope, filter),
  };
}
