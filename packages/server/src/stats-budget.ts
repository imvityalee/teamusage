import { createLimiter } from "./limiter.js";

const MINUTE_MS = 60_000;

/** A team's statistics time in its current minute. */
export interface StatsBudget {
  /** Seconds until the team may ask again when its minute's time is used up, otherwise null. */
  retryAfter(teamId: number): number | null;
  /** Counts `ms` of work for the team (at least one millisecond). */
  spend(teamId: number, ms: number): void;
}

export function createStatsBudget(o: { msPerMinute: number; now: () => number }): StatsBudget {
  const spent = createLimiter({ max: o.msPerMinute, windowMs: MINUTE_MS, now: o.now });
  return {
    retryAfter: (teamId) => spent.retryAfter(String(teamId)),
    spend: (teamId, ms) => spent.count(String(teamId), Math.max(1, ms)),
  };
}
