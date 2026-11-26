import type { UsageRecord } from "@teamusage/shared";
import type { Db } from "./db.js";
import { refuseBeyondLimits, type TeamLimits } from "./team-limits.js";
import { countAddedRows } from "./usage-counts.js";

/** How a team's rows are written: `clock` gives the time written to them; `limits`, when set, bound what the team may hold. */
export type WriteOptions = { clock: () => string; limits: TeamLimits | undefined };

/** The number of usage rows machine `machineId` of team `teamId` holds. */
function machineRows(db: Db, teamId: number, machineId: string): number {
  const row = db.prepare("select count(*) as n from usage where team_id = ? and machine_id = ?").get(teamId, machineId);
  return (row as { n: number }).n;
}

/**
 * Stores the records of one machine of team `teamId` and counts the rows it added; `o.clock` gives the time written to
 * `last_sync_at` and the UTC date the new rows are counted on. When `o.limits` are set and the records would add a row
 * beyond one, throws `LimitError` and stores nothing of them.
 */
export function upsertUsage(
  db: Db,
  teamId: number,
  o: WriteOptions,
  who: { memberId: number; machineId: string },
  records: UsageRecord[],
): { stored: number; kept: number } {
  // The label changes only when tokens grew (or none is stored yet); a record without a label never clears one.
  // Kind and org share one condition and are set in the same statement, so they change together.
  const TAKE_LABEL =
    "excluded.account_kind is not null and (excluded.total > usage.total or usage.account_kind is null)";
  // The plan follows the label: a different account replaces it (even with none), the same account only gains or
  // updates one, and history (same total) may fill a missing plan but never relabel. Right-hand references see the old row.
  const SAME_ACCOUNT =
    "excluded.account_kind is usage.account_kind and coalesce(excluded.account_org, '') = coalesce(usage.account_org, '')";
  const PLAN = `case
        when ${TAKE_LABEL} and not (${SAME_ACCOUNT}) then excluded.account_plan
        when excluded.account_kind is not null and ${SAME_ACCOUNT} and excluded.account_plan is not null
          and (excluded.total > usage.total or usage.account_plan is null) then excluded.account_plan
        else usage.account_plan end`;
  // A day's usage only grows, so a lower incoming total means local logs were pruned: keep the stored counts. Such a
  // record may still fill an empty label (and the same account's missing plan), so pruned days can be labelled too.
  const GROWS = "excluded.total >= usage.total";
  const keepOr = (col: string) => `${col} = case when ${GROWS} then excluded.${col} else usage.${col} end`;
  const FILLS = `excluded.account_kind is not null and (usage.account_kind is null
        or (${SAME_ACCOUNT} and usage.account_plan is null and excluded.account_plan is not null))`;
  const stmt = db.prepare(`
    insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced, account_kind, account_org, account_plan)
    values (@teamId, @memberId, @machineId, @date, @agent, @model, @input, @output, @cacheCreate, @cacheRead, @total, @costUsd, @unpriced, @accountKind, @accountOrg, @accountPlan)
    on conflict (team_id, machine_id, date, agent, model) do update set
      ${["member_id", "input", "output", "cache_create", "cache_read", "total", "cost_usd", "unpriced"].map(keepOr).join(",\n      ")},
      account_org = case when ${TAKE_LABEL} then excluded.account_org else usage.account_org end,
      account_kind = case when ${TAKE_LABEL} then excluded.account_kind else usage.account_kind end,
      account_plan = ${PLAN}
    where ${GROWS} or (${FILLS})`);
  return db.transaction(() => {
    const rowsBefore = machineRows(db, teamId, who.machineId);
    let stored = 0;
    let kept = 0;
    for (const r of records) {
      const res = stmt.run({
        teamId,
        memberId: who.memberId,
        machineId: who.machineId,
        date: r.date,
        agent: r.agent,
        model: r.model,
        input: r.input,
        output: r.output,
        cacheCreate: r.cacheCreate,
        cacheRead: r.cacheRead,
        total: r.total,
        costUsd: r.costUsd,
        unpriced: r.unpriced ? 1 : 0,
        accountKind: r.account?.kind ?? null,
        accountOrg: r.account?.org ?? null,
        accountPlan: r.account?.plan ?? null,
      });
      if (res.changes > 0) stored++;
      else kept++;
    }
    const at = o.clock();
    const rowsAfter = machineRows(db, teamId, who.machineId);
    const added = rowsAfter - rowsBefore;
    if (added > 0) {
      const counts = countAddedRows(db, teamId, added, at.slice(0, 10));
      refuseBeyondLimits(o.limits, (l) => [
        { limit: "machine-rows", wouldHold: rowsAfter, cap: l.rowsPerMachine },
        { limit: "team-rows", wouldHold: counts.rows, cap: l.rowsPerTeam },
        { limit: "team-rows-per-day", wouldHold: counts.addedToday, cap: l.rowsAddedPerDay },
      ]);
    }
    db.prepare("update machines set last_sync_at = ? where team_id = ? and id = ?").run(at, teamId, who.machineId);
    return { stored, kept };
  })();
}
