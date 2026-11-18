import type { Stats } from "@teamusage/shared";
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

/** Aggregates usage for the range. Does not validate; every value reaches SQL as a bound parameter. */
export function getStats(db: Db, q: { from: string; to: string; memberId?: number }): Stats {
  const memberId = q.memberId ?? null;
  const p = { from: q.from, to: q.to, memberId };

  const memberRows = db
    .prepare(
      `select m.id as id, m.name as name, m.email as email,
         (select coalesce(total(u.total), 0) from usage u
            where u.member_id = m.id and u.date between @from and @to) as tokens,
         (select coalesce(sum(u.cost_usd), 0) from usage u
            where u.member_id = m.id and u.date between @from and @to) as cost,
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
       from usage
       where date between @from and @to and (@memberId is null or member_id = @memberId)
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
       from usage
       where date between @from and @to and (@memberId is null or member_id = @memberId)
       group by date, agent`,
    )
    .all(p) as { date: string; agent: string; total: number }[];

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
    })),
    ...(machines ? { machines } : {}),
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
