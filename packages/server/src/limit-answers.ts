import type { Context } from "hono";
import { STATS_TOO_LARGE } from "./stats-bounds.js";
import type { LimitName, TeamLimits } from "./team-limits.js";

export type RefusedLimit = LimitName | "uploads" | "team-uploads";

type Answer = { status: 409 | 429 | 507; error: (l: TeamLimits) => string };

const ANSWERS: Record<RefusedLimit, Answer> = {
  members: { status: 409, error: (l) => `this team has reached its limit of ${l.membersPerTeam} members` },
  machines: { status: 409, error: (l) => `this member has reached the limit of ${l.machinesPerMember} machines` },
  "machine-rows": { status: 409, error: (l) => `this machine has reached its limit of ${l.rowsPerMachine} usage rows` },
  "team-rows": { status: 409, error: (l) => `this team has reached its limit of ${l.rowsPerTeam} usage rows` },
  "team-rows-per-day": { status: 429, error: () => "this team has added too many usage rows today; try again tomorrow" },
  storage: { status: 507, error: () => "the server is not accepting new data right now; try again later" },
  uploads: { status: 429, error: () => "too many uploads; try again in a minute" },
  "team-uploads": { status: 429, error: () => "this team is sending too much at once; try again in a minute" },
};

/** A limit's refusal: `{ error, limit }` with the limit's status, never stored by a cache. */
function refusal(c: Context, status: 409 | 429 | 507, error: string, limit: RefusedLimit | "stats" | "team-stats"): Response {
  c.header("Cache-Control", "no-store");
  return c.json({ error, limit }, status);
}

/** The answer to a request that a limit refuses: `{ error, limit }`, the limit's status, and Retry-After where waiting helps. */
export function limitAnswer(c: Context, limit: RefusedLimit, team: TeamLimits, retryAfterSeconds?: number): Response {
  const { status, error } = ANSWERS[limit];
  if (retryAfterSeconds !== undefined) c.header("Retry-After", String(retryAfterSeconds));
  return refusal(c, status, error(team), limit);
}

/** The answer to a stats request whose usage in scope is more than one answer may hold; in both modes. */
export const statsTooLargeAnswer = (c: Context): Response => refusal(c, 409, STATS_TOO_LARGE, "stats");

/** The answer to a statistics request of a team whose minute's time is used up: 429, Retry-After, `limit: "team-stats"`. */
export const teamStatsBusyAnswer = (c: Context, retryAfterSeconds: number): Response => {
  c.header("Retry-After", String(retryAfterSeconds));
  return refusal(c, 429, "this team's statistics are busy; try again in a minute", "team-stats");
};

const DAY_MS = 86_400_000;

/** Seconds from `now` (epoch milliseconds) to the next UTC midnight, at least 1. */
export function secondsToUtcMidnight(now: number): number {
  return Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);
}
