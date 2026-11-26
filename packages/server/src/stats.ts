import { accountKey, datesBetween, planKey, type AccountKind, type Stats } from "@teamusage/shared";
import type { Db } from "./db.js";
import { checkNames, readWithin, STATS_BOUNDS, type StatsBounds } from "./stats-bounds.js";
import { usageFilter } from "./stats-filter.js";
import { dayRows, memberList, memberMachines, memberRows, type DayRow, type Filter, type MemberInfo, type MemberRow, type Scope } from "./stats-rows.js";

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

const NO_FILTER = usageFilter([], [], [], []);

type Member = Stats["members"][number];
type Breakdown = Pick<Member, "byAgent" | "byAccount" | "byAccountPlan">;
type AccountPlan = Member["byAccountPlan"][number];
type MemberUsage = Breakdown & { tokens: number; cost: number };

/**
 * Each member's filtered tokens and cost, and their tokens by agent, by account, and by account and plan (tokens desc,
 * then account, then plan). Members without usage in scope are absent.
 */
function memberUsage(rows: MemberRow[]): Map<number, MemberUsage> {
  type Sums = { tokens: number; cost: number; byAgent: Map<string, number>; byAccount: Map<string, number>; byAccountPlan: Map<string, AccountPlan> };
  const sums = new Map<number, Sums>();
  for (const r of rows) {
    const s = getOrCreate(sums, r.memberId, (): Sums => ({ tokens: 0, cost: 0, byAgent: new Map(), byAccount: new Map(), byAccountPlan: new Map() }));
    const tokens = finite(r.tokens);
    s.tokens += r.tokens;
    s.cost += r.cost;
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
        tokens: s.tokens,
        cost: s.cost,
        byAgent: Object.fromEntries(s.byAgent) as Record<string, number>,
        byAccount: Object.fromEntries(s.byAccount) as Record<string, number>,
        byAccountPlan: [...s.byAccountPlan.values()].sort(byTokensThenNames),
      },
    ]),
  );
}

/** A member without usage in scope. A new object each time, so no answer shares one with another. */
const noUsage = (): MemberUsage => ({ tokens: 0, cost: 0, byAgent: {}, byAccount: {}, byAccountPlan: [] });

/** Every member in scope with their usage; tokens desc, then name and id as the list gives them. */
function rankedMembers(list: MemberInfo[], rows: MemberRow[]): (MemberInfo & MemberUsage)[] {
  const usage = memberUsage(rows);
  // The sort is stable, so equal tokens keep the list's order by name then id.
  return list.map((m) => ({ ...m, ...(usage.get(m.id) ?? noUsage()) })).sort((a, b) => b.tokens - a.tokens);
}

/** Filtered tokens per day and agent, with every day of the range present (zeros included). */
function dailyByAgent(rows: DayRow[], scope: Scope): Stats["daily"] {
  const byDate = new Map<string, Map<string, number>>(datesBetween(scope.from, scope.to).map((d) => [d, new Map()]));
  for (const r of rows) {
    const agents = byDate.get(r.date);
    if (agents) add(agents, r.agent, finite(r.total));
  }
  // Agent ids are data: a Map plus fromEntries makes `__proto__` an ordinary own property.
  return [...byDate].map(([date, agents]) => ({ date, byAgent: Object.fromEntries(agents) as Record<string, number> }));
}

/** Filtered totals per agent and model, largest first. */
function modelTotals(rows: DayRow[]): Stats["models"] {
  type Sums = Pick<DayRow, "agent" | "model" | "input" | "output" | "cacheCreate" | "cacheRead" | "total" | "cost" | "unpriced">;
  const sums = new Map<string, Sums>();
  for (const r of rows) {
    const s = getOrCreate(sums, JSON.stringify([r.agent, r.model]), (): Sums => ({
      agent: r.agent, model: r.model, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0, unpriced: 0,
    }));
    s.input += r.input;
    s.output += r.output;
    s.cacheCreate += r.cacheCreate;
    s.cacheRead += r.cacheRead;
    s.total += r.total;
    s.cost += r.cost;
    s.unpriced = Math.max(s.unpriced, r.unpriced);
  }
  return [...sums.values()]
    .sort((a, b) => b.total - a.total || cmp(a.agent, b.agent) || cmp(a.model, b.model))
    .map((m) => ({
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

/** Everything present in scope, from the rows read without the agent, model, account and plan filters: it feeds the filter controls. */
function availableFilters(rows: DayRow[]): Stats["available"] {
  const agents = new Map<string, number>();
  const models = new Map<string, { agent: string; model: string; tokens: number }>();
  const accounts = new Map<string, number>();
  const plans = new Map<string, number>();
  for (const r of rows) {
    const tokens = finite(r.total);
    add(agents, r.agent, tokens);
    const m = getOrCreate(models, JSON.stringify([r.agent, r.model]), () => ({ agent: r.agent, model: r.model, tokens: 0 }));
    m.tokens = finite(m.tokens + tokens);
    add(accounts, labelKey(r.agent, r.kind, r.org), tokens);
    add(plans, planKey(r.agent, r.plan), tokens);
  }
  const ranked = (m: Map<string, number>) => [...m].sort(byTokensDesc).map(([key, tokens]) => ({ key, tokens }));
  return {
    agents: [...agents].sort(byTokensDesc).map(([agent]) => agent),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || cmp(a.agent, b.agent) || cmp(a.model, b.model)),
    accounts: ranked(accounts),
    plans: ranked(plans),
  };
}

/**
 * Aggregates the usage of team `teamId` for the range. Does not validate; every value reaches SQL as a bound parameter.
 * Reads `usage` in two grouped passes, by member and by day, plus an unfiltered by-day pass when a filter is active.
 * Throws `StatsTooLargeError` when a pass has more groups, or the unfiltered by-day rows more names, than `bounds` allow.
 */
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
  bounds: StatsBounds = STATS_BOUNDS,
): Stats {
  const scope: Scope = { teamId, from: q.from, to: q.to, memberId: q.memberId ?? null };
  const filter = usageFilter(q.agents ?? [], q.models ?? [], q.accounts ?? [], q.plans ?? []);
  const daysOf = (f: Filter) => readWithin(bounds.dayGroups, (limit) => dayRows(db, scope, f, limit));
  const days = daysOf(filter);
  const unfilteredDays = filter.sql === NO_FILTER.sql ? days : daysOf(NO_FILTER);
  checkNames(unfilteredDays, bounds);
  const memberGroups = readWithin(bounds.memberGroups, (limit) => memberRows(db, scope, filter, limit));
  const members = rankedMembers(memberList(db, scope), memberGroups);

  return {
    from: q.from,
    to: q.to,
    totals: {
      tokens: finite(members.reduce((s, m) => s + m.tokens, 0)),
      costUsd: round6(members.reduce((s, m) => s + m.cost, 0)),
      activeMembers: members.filter((m) => m.tokens > 0).length,
      memberCount: members.length,
    },
    daily: dailyByAgent(days, scope),
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      tokens: finite(m.tokens),
      costUsd: round6(m.cost),
      machines: m.machines,
      lastSyncAt: m.lastSyncAt,
      byAgent: m.byAgent,
      byAccount: m.byAccount,
      byAccountPlan: m.byAccountPlan,
    })),
    ...(scope.memberId === null ? {} : { machines: memberMachines(db, teamId, scope.memberId) }),
    available: availableFilters(unfilteredDays),
    models: modelTotals(days),
  };
}
