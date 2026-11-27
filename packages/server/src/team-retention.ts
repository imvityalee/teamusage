import { addDays } from "@teamusage/shared";
import type { Db } from "./db.js";
import { countRemovedRows } from "./usage-counts.js";

/**
 * Days of usage a hosted team keeps. A row dated more than this many days before today (UTC) is dropped at the team's
 * next uploads, at most `EXPIRED_ROWS_PER_UPLOAD` at each; a team that does not upload keeps it.
 */
export const USAGE_DAYS_KEPT = 730;

/** Most expired rows dropped at one upload. */
export const EXPIRED_ROWS_PER_UPLOAD = 500;

/** The oldest usage date kept at `at` (an ISO time): its UTC date moved back `daysKept` days. */
export function oldestDateKept(at: string, daysKept: number): string {
  return addDays(new Date(at).toISOString().slice(0, 10), -daysKept);
}

/** Drops up to `most` of team `teamId`'s usage rows dated before `oldest` and takes them off its count; returns how many. */
export function dropExpiredUsage(db: Db, teamId: number, oldest: string, most = EXPIRED_ROWS_PER_UPLOAD): number {
  return db.transaction(() => {
    // The oldest dates go first, found through usage_by_day, which starts with (team_id, date).
    const dropped = db
      .prepare(
        "delete from usage where rowid in (select rowid from usage where team_id = ? and date < ? order by date limit ?)",
      )
      .run(teamId, oldest, most).changes;
    if (dropped > 0) countRemovedRows(db, teamId, dropped);
    return dropped;
  })();
}
