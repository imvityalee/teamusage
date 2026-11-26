/** The most one stats request reads: groups of each pass over `usage`, and different agents and models in its answer. */
export type StatsBounds = { memberGroups: number; dayGroups: number; agents: number; models: number };
export const STATS_BOUNDS: StatsBounds = { memberGroups: 30_000, dayGroups: 60_000, agents: 50, models: 2_000 };

/** The usage in scope has more groups or names than one answer may hold. */
export class StatsTooLargeError extends Error {}

export const STATS_TOO_LARGE = "this team's usage has too many different agents, models or accounts to show";

/**
 * The rows of a pass read with `read(bound + 1)`, which asks SQLite for at most that many rows; throws
 * `StatsTooLargeError` when the pass returned more than `bound`.
 */
export function readWithin<T>(bound: number, read: (limit: number) => T[]): T[] {
  const rows = read(bound + 1);
  if (rows.length > bound) throw new StatsTooLargeError();
  return rows;
}

/** Throws `StatsTooLargeError` when `rows` hold more different agents, or agent-and-model pairs, than `bounds` allow. */
export function checkNames(rows: { agent: string; model: string }[], bounds: StatsBounds): void {
  const agents = new Set(rows.map((r) => r.agent));
  const models = new Set(rows.map((r) => JSON.stringify([r.agent, r.model])));
  if (agents.size > bounds.agents || models.size > bounds.models) throw new StatsTooLargeError();
}
