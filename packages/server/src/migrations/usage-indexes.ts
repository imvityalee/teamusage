import type { Step } from "../migrate.js";

// Each index holds every column its stats pass reads, in that pass's group order, so SQLite aggregates as it reads.
const ORDERED_USAGE_INDEXES = `
drop index usage_team_date;
drop index usage_team_member_date;
create index usage_by_day on usage (team_id, date, agent, model, account_kind, account_org, account_plan,
  input, output, cache_create, cache_read, total, cost_usd, unpriced, member_id);
create index usage_by_member on usage (team_id, member_id, agent, account_kind, account_org, account_plan,
  date, model, total, cost_usd);
`;

/** Replaces the usage indexes with two that deliver the rows of the stats passes already grouped. */
export const orderedUsageIndexes: Step = (db) => {
  db.exec(ORDERED_USAGE_INDEXES);
};
