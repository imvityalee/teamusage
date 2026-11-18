export interface Stats {
  from: string;
  to: string;
  totals: { tokens: number; costUsd: number; activeMembers: number; memberCount: number };
  daily: { date: string; byAgent: Record<string, number> }[]; // every day in range, zeros included
  members: {
    id: number;
    name: string;
    email: string;
    tokens: number;
    costUsd: number;
    machines: number;
    lastSyncAt: string | null;
    /** Tokens by agent id for this member, with the same range and filters as `tokens`; empty when none. */
    byAgent: Record<string, number>;
    /** Tokens by account key (`accountKey`) for this member, with the same range and filters as `tokens`; empty when none. */
    byAccount: Record<string, number>;
  }[]; // sorted by tokens desc
  /** Present only when a single member was requested: that member's machines, most recently synced first. */
  machines?: { label: string; lastSyncAt: string | null }[];
  /**
   * Everything present in the date range (and for the member, when one is requested), IGNORING the agent,
   * model and account filters, sorted by total tokens descending. It feeds the filter controls. `tokens` is that
   * model's (or account's) total in the range; an agent's total, and the unfiltered total, are sums of these.
   * Account keys are `accountKey` values; `unknown` covers every row without a label, non-Claude rows included.
   */
  available: {
    agents: string[];
    models: { agent: string; model: string; tokens: number }[];
    accounts: { key: string; tokens: number }[];
  };
  models: {
    agent: string;
    model: string;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
    total: number;
    costUsd: number;
    unpriced: boolean;
  }[];
}

/** Inclusive range of exactly `days` days ending at `today` (YYYY-MM-DD). */
export function presetRange(days: 30 | 90 | 180, today: string): { from: string; to: string } {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const from = new Date(Date.UTC(y, m - 1, d - (days - 1)));
  return { from: from.toISOString().slice(0, 10), to: today };
}
