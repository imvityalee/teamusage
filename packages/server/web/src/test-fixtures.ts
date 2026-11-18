import type { Stats } from "@teamusage/shared";

/** Test data only; never imported by the app. */
export interface FixtureNames {
  name: string;
  email: string;
  agent: string;
  model: string;
}

/** Agent ids a hostile or broken client could report. */
export const HOSTILE_IDS = [
  "../../x",
  "__proto__",
  "constructor",
  `claude"><img src=x onerror=alert(1)>`,
  "a".repeat(64),
  "toString",
  "/agents/claudecode.svg",
  "claude ",
  "Claude",
];

const PLAIN: FixtureNames = { name: "Alice Archer", email: "alice@example.com", agent: "aider", model: "some-model" };

/** Ten days ending 2026-11-18, two members, three agents. `names` replaces the first member and the third agent. */
export function statsFixture(names: FixtureNames = PLAIN): Stats {
  const daily = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-11-${String(9 + i).padStart(2, "0")}`,
    byAgent: Object.fromEntries([
      ["claude", 1000 * (i + 1)],
      ["codex", 500],
      [names.agent, i % 2 === 0 ? 100 : 0],
    ]) as Record<string, number>,
  }));
  const members: Stats["members"] = [
    {
      id: 1, name: names.name, email: names.email, tokens: 40_000, costUsd: 9, machines: 2, lastSyncAt: "2026-11-18T12:00:00.000Z",
      byAgent: Object.fromEntries([["claude", 35_000], ["codex", 4_500], [names.agent, 500]]) as Record<string, number>,
    },
    {
      id: 2, name: "Bao Nguyen", email: "bao@example.com", tokens: 20_500, costUsd: 3.5, machines: 1, lastSyncAt: "2026-11-10T12:00:00.000Z",
      byAgent: { claude: 20_000, codex: 500 },
    },
    { id: 3, name: "Carla Mendes", email: "carla@example.com", tokens: 0, costUsd: 0, machines: 1, lastSyncAt: null, byAgent: {} },
  ];
  return {
    from: "2026-11-09",
    to: "2026-11-18",
    totals: { tokens: 60_500, costUsd: 12.5, activeMembers: 2, memberCount: 3 },
    daily,
    members,
    models: [
      { agent: "claude", model: "claude-sonnet-4-5", input: 100, output: 50, cacheCreate: 200, cacheRead: 29_650, total: 30_000, costUsd: 8, unpriced: false },
      { agent: "codex", model: "gpt-5-codex", input: 100, output: 50, cacheCreate: 100, cacheRead: 4_750, total: 5_000, costUsd: 1.5, unpriced: false },
      { agent: "claude", model: "claude-opus-4-1", input: 10, output: 10, cacheCreate: 10, cacheRead: 24_970, total: 25_000, costUsd: 3, unpriced: false },
      { agent: names.agent, model: names.model, input: 100, output: 100, cacheCreate: 100, cacheRead: 200, total: 500, costUsd: 0, unpriced: true },
    ],
    available: {
      agents: ["claude", "codex", names.agent],
      models: [
        { agent: "claude", model: "claude-sonnet-4-5", tokens: 30_000 },
        { agent: "claude", model: "claude-opus-4-1", tokens: 25_000 },
        { agent: "codex", model: "gpt-5-codex", tokens: 5_000 },
        { agent: names.agent, model: names.model, tokens: 500 },
      ],
    },
  };
}

/** One member's stats, as the API answers `member=1`: only that member, plus their machines. */
export function memberStatsFixture(names: FixtureNames = PLAIN, machine = "alice-mbp"): Stats {
  const s = statsFixture(names);
  return {
    ...s,
    totals: { tokens: 60_500, costUsd: 12.5, activeMembers: 1, memberCount: 1 },
    members: s.members.slice(0, 1),
    machines: [
      { label: machine, lastSyncAt: "2026-11-18T12:00:00.000Z" },
      { label: "alice-linux", lastSyncAt: "2026-11-15T12:00:00.000Z" },
      { label: "old-box", lastSyncAt: null },
    ],
  };
}

/** The same shape with nothing used. */
export function emptyStatsFixture(): Stats {
  const s = statsFixture();
  return {
    ...s,
    totals: { tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 3 },
    daily: s.daily.map((d) => ({ date: d.date, byAgent: {} })),
    members: s.members.map((m) => ({ ...m, tokens: 0, costUsd: 0, byAgent: {} })),
    models: [],
  };
}
