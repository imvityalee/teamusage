import type { Db } from "./db.js";

export type UsageCounts = { rows: number; addedToday: number };

/** The team's counts on UTC date `day`; zeros for a team that has stored nothing, and `addedToday` 0 on a day it added nothing. */
export function usageCounts(db: Db, teamId: number, day: string): UsageCounts {
  const row = db.prepare("select rows, day, added from usage_counts where team_id = ?").get(teamId) as
    | { rows: number; day: string; added: number }
    | undefined;
  return { rows: row?.rows ?? 0, addedToday: row?.day === day ? row.added : 0 };
}

/** Counts `added` new rows on `day`, starting the day's count again when `day` is a new one; returns the counts after. */
export function countAddedRows(db: Db, teamId: number, added: number, day: string): UsageCounts {
  // Every right-hand side of the update reads the row as it was before the update.
  const after = db
    .prepare(
      `insert into usage_counts (team_id, rows, day, added) values (@teamId, @added, @day, @added)
       on conflict (team_id) do update set
         rows = usage_counts.rows + excluded.added,
         added = case when usage_counts.day = excluded.day then usage_counts.added + excluded.added else excluded.added end,
         day = excluded.day
       returning rows, added`,
    )
    .get({ teamId, added, day }) as { rows: number; added: number };
  return { rows: after.rows, addedToday: after.added };
}

/** Takes `removed` rows off the team's total. The rows it added today stay counted. */
export function countRemovedRows(db: Db, teamId: number, removed: number): void {
  db.prepare("update usage_counts set rows = rows - ? where team_id = ?").run(removed, teamId);
}
