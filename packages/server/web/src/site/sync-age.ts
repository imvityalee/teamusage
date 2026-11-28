import { daysSince as daysBetween } from "../format.js";

/** How long ago a member or machine synced, and when that counts as "not syncing". One source for the dashboard and the team page. */

/** A member or machine with no sync in this many days is "not syncing". */
export const STALE_DAYS = 7;

/** Whole days from the day of `at` to `today` (a local ISO date); null when it never synced or `at` is not a time. */
export function daysSince(at: string | null, today: string): number | null {
  return at === null ? null : daysBetween(at, today);
}

export const isStale = (days: number | null): boolean => days === null || days >= STALE_DAYS;
