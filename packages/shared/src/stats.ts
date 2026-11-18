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
  }[]; // sorted by tokens desc
  /** Present only when a single member was requested: that member's machines, most recently synced first. */
  machines?: { label: string; lastSyncAt: string | null }[];
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
