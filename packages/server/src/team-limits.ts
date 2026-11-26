/** Uploads one machine may send in a minute. */
export const UPLOADS_PER_MINUTE = 30;

/** What a team of a hosted server may hold. A self-hosted server sets none. */
export type TeamLimits = {
  membersPerTeam: number;
  machinesPerMember: number;
  rowsPerMachine: number;
  rowsPerTeam: number;
  rowsAddedPerDay: number;
  /** True while the data volume is nearly full: nothing that adds a row is accepted. */
  storageLow: () => boolean;
};

export type LimitName = "members" | "machines" | "machine-rows" | "team-rows" | "team-rows-per-day" | "storage";

/** A request would add a row beyond a limit; nothing of it was stored. */
export class LimitError extends Error {
  constructor(readonly limit: LimitName) {
    super(`limit reached: ${limit}`);
    this.name = "LimitError";
  }
}

/**
 * The beta's limits. `rowsPerTeam` is lower than the design's 3,000,000: when it was measured, a team view over about
 * 3,000,000 rows held the server's only thread for 14 to 20 seconds.
 */
export const HOSTED_CAPS: Omit<TeamLimits, "storageLow"> = {
  membersPerTeam: 2000,
  machinesPerMember: 10,
  rowsPerMachine: 20_000,
  rowsPerTeam: 1_000_000,
  rowsAddedPerDay: 300_000,
};

/** A cap and what the team, member or machine would hold if the request were stored. */
type Holding = { limit: LimitName; wouldHold: number; cap: number };

/**
 * For a request that adds something: throws `LimitError` for the first limit it would pass, a nearly full disk before
 * the caps and the caps in the order `holdings` lists them. Does nothing when `limits` is undefined.
 */
export function refuseBeyondLimits(limits: TeamLimits | undefined, holdings: (l: TeamLimits) => Holding[]): void {
  if (!limits) return;
  if (limits.storageLow()) throw new LimitError("storage");
  const passed = holdings(limits).find((h) => h.wouldHold > h.cap);
  if (passed) throw new LimitError(passed.limit);
}
