import type { AccountKind, Stats } from "@teamusage/shared";
import type { Db } from "./db.js";
import type { usageFilter } from "./stats-filter.js";

/** The team, the date range and, when one is asked for, the member. */
export type Scope = { teamId: number; from: string; to: string; memberId: number | null };
export type Filter = ReturnType<typeof usageFilter>;

/**
 * Condition on `usage u` for the rows inside the scope, with its bound values; every statement on `usage` uses it.
 * The team view's condition seeks `usage_by_day` by team and date and `usage_by_member` by team; a member's view
 * seeks `usage_by_member` by team and member.
 */
function inScope(scope: Scope): { sql: string; params: Record<string, number | string> } {
  const { teamId, from, to, memberId } = scope;
  return memberId === null
    ? { sql: "u.team_id = @teamId and u.date between @from and @to", params: { teamId, from, to } }
    : { sql: "u.team_id = @teamId and u.member_id = @memberId and u.date between @from and @to", params: { teamId, memberId, from, to } };
}

const select = <T>(db: Db, sql: string, params: object): T[] => db.prepare(sql).all(params) as T[];

/** The account and plan labels of a usage row, with its agent. */
type Labels = { agent: string; kind: AccountKind | null; org: string | null; plan: string | null };

export type MemberRow = Labels & { memberId: number; tokens: number; cost: number };

/**
 * Filtered tokens and cost per member, agent and labels, read through the index whose column order is the grouping's;
 * at most `limit` groups.
 */
export function memberRows(db: Db, scope: Scope, filter: Filter, limit: number): MemberRow[] {
  const scoped = inScope(scope);
  return select<MemberRow>(
    db,
    `select u.member_id as memberId, u.agent as agent, u.account_kind as kind, u.account_org as org,
       u.account_plan as plan, total(u.total) as tokens, sum(u.cost_usd) as cost
     from usage u indexed by usage_by_member
     where ${scoped.sql} and ${filter.sql}
     group by u.member_id, u.agent, u.account_kind, u.account_org, u.account_plan
     limit @limit`,
    { ...scoped.params, ...filter.params, limit },
  );
}

export type DayRow = Labels & {
  date: string;
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
  cost: number;
  unpriced: number;
};

/**
 * Filtered token counts and cost per day, agent, model and labels; at most `limit` groups. The team view reads
 * `usage_by_day`, whose column order is the grouping's; a member's view reads that member's rows from `usage_by_member`.
 */
export function dayRows(db: Db, scope: Scope, filter: Filter, limit: number): DayRow[] {
  const scoped = inScope(scope);
  const index = scope.memberId === null ? "usage_by_day" : "usage_by_member";
  return select<DayRow>(
    db,
    `select u.date as date, u.agent as agent, u.model as model, u.account_kind as kind, u.account_org as org,
       u.account_plan as plan, total(u.input) as input, total(u.output) as output, total(u.cache_create) as cacheCreate,
       total(u.cache_read) as cacheRead, total(u.total) as total, sum(u.cost_usd) as cost, max(u.unpriced) as unpriced
     from usage u indexed by ${index}
     where ${scoped.sql} and ${filter.sql}
     group by u.date, u.agent, u.model, u.account_kind, u.account_org, u.account_plan
     limit @limit`,
    { ...scoped.params, ...filter.params, limit },
  );
}

export type MemberInfo = { id: number; name: string; email: string; machines: number; lastSyncAt: string | null };

/** Every member in scope with their machine count and last sync, by name then id; reads no usage. */
export function memberList(db: Db, scope: Scope): MemberInfo[] {
  return select<MemberInfo>(
    db,
    `select m.id as id, m.name as name, m.email as email,
       (select count(*) from machines x where x.team_id = m.team_id and x.member_id = m.id) as machines,
       (select max(x.last_sync_at) from machines x where x.team_id = m.team_id and x.member_id = m.id) as lastSyncAt
     from members m
     where m.team_id = @teamId and (@memberId is null or m.id = @memberId)
     order by m.name, m.id`,
    { teamId: scope.teamId, memberId: scope.memberId },
  );
}

/** One member's machines by label and last sync, never by id. Never-synced last; ties by label then id. */
export function memberMachines(db: Db, teamId: number, memberId: number): NonNullable<Stats["machines"]> {
  return select<{ label: string; lastSyncAt: string | null }>(
    db,
    `select label, last_sync_at as lastSyncAt from machines
     where team_id = @teamId and member_id = @memberId
     order by (last_sync_at is null), last_sync_at desc, label, id`,
    { teamId, memberId },
  );
}
