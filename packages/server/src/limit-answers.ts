import type { Context } from "hono";
import type { LimitName, TeamLimits } from "./team-limits.js";

export type RefusedLimit = LimitName | "uploads";

type Answer = { status: 409 | 429 | 507; error: (l: TeamLimits) => string };

const ANSWERS: Record<RefusedLimit, Answer> = {
  members: { status: 409, error: (l) => `this team has reached its limit of ${l.membersPerTeam} members` },
  machines: { status: 409, error: (l) => `this member has reached the limit of ${l.machinesPerMember} machines` },
  "machine-rows": { status: 409, error: (l) => `this machine has reached its limit of ${l.rowsPerMachine} usage rows` },
  "team-rows": { status: 409, error: (l) => `this team has reached its limit of ${l.rowsPerTeam} usage rows` },
  "team-rows-per-day": { status: 429, error: () => "this team has added too many usage rows today; try again tomorrow" },
  storage: { status: 507, error: () => "the server is not accepting new data right now; try again later" },
  uploads: { status: 429, error: () => "too many uploads; try again in a minute" },
};

/** The answer to a request that a limit refuses: `{ error, limit }`, the limit's status, and Retry-After where waiting helps. */
export function limitAnswer(c: Context, limit: RefusedLimit, team: TeamLimits, retryAfterSeconds?: number): Response {
  const { status, error } = ANSWERS[limit];
  c.header("Cache-Control", "no-store");
  if (retryAfterSeconds !== undefined) c.header("Retry-After", String(retryAfterSeconds));
  return c.json({ error: error(team), limit }, status);
}

const DAY_MS = 86_400_000;

/** Seconds from `now` (epoch milliseconds) to the next UTC midnight, at least 1. */
export function secondsToUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));
}
