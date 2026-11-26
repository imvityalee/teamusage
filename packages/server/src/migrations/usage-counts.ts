import type { Step } from "../migrate.js";

// `rows` is the number of usage rows the team holds; `added` is the number it added on the UTC date `day` ('' before
// the first).
const USAGE_COUNTS = `
create table usage_counts (
  team_id integer primary key references teams(id) on delete cascade,
  rows integer not null,
  day text not null,
  added integer not null
);
insert into usage_counts (team_id, rows, day, added) select team_id, count(*), '', 0 from usage group by team_id;
`;

/** Adds a count of each team's usage rows, starting from the rows each team already holds. */
export const usageCountsTable: Step = (db) => {
  db.exec(USAGE_COUNTS);
};
