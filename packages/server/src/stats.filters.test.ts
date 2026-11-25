import { describe, expect, test } from "vitest";
import { getStats } from "./stats.js";
import { M1, newTeam, Q, rec, seedFilters } from "./stats.fixture.js";
import { forTeam } from "./team-data.js";

describe("agent and model filters", () => {
  const fullAvailable = {
    agents: ["claude", "codex", "gemini"],
    models: [
      { agent: "claude", model: "opus", tokens: 110 },
      { agent: "codex", model: "gpt", tokens: 41 },
      { agent: "claude", model: "sonnet", tokens: 20 },
      { agent: "gemini", model: "g", tokens: 5 },
      { agent: "codex", model: "other", tokens: 2 },
    ],
    accounts: [
      { key: "unknown", tokens: 130 },
      { key: "other", tokens: 48 },
    ],
    plans: [{ key: "none", tokens: 178 }],
  };

  test("no filters: available lists everything in range, sorted by tokens", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, Q);
    expect(s.available).toEqual(fullAvailable);
    expect(s.totals.tokens).toBe(178);
  });

  test("an agent filter keeps only that agent in totals, daily, members and models", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, { ...Q, agents: ["codex"] });
    expect(s.totals).toEqual({ tokens: 43, costUsd: 0.43, activeMembers: 2, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.tokens, m.costUsd])).toEqual([["Ann", 40, 0.4], ["Bob", 3, 0.03]]);
    expect(s.daily.filter((d) => Object.keys(d.byAgent).length > 0)).toEqual([
      { date: "2026-11-03", byAgent: { codex: 40 } },
      { date: "2026-11-04", byAgent: { codex: 3 } },
    ]);
    expect(s.models.map((m) => [m.agent, m.model, m.total, m.costUsd])).toEqual([
      ["codex", "gpt", 41, 0.41],
      ["codex", "other", 2, 0.02],
    ]);
    expect(s.available).toEqual(fullAvailable);
  });

  test("several agents are alternatives", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, { ...Q, agents: ["gemini", "claude"] });
    expect(s.totals.tokens).toBe(135);
    expect(s.models.map((m) => m.model)).toEqual(["opus", "sonnet", "g"]);
  });

  test("a model filter matches the exact (agent, model) pair", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, { ...Q, models: [{ agent: "claude", model: "opus" }, { agent: "gemini", model: "g" }] });
    expect(s.totals).toEqual({ tokens: 115, costUsd: 1.15, activeMembers: 2, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["Bob", 105], ["Ann", 10]]);
    expect(s.models.map((m) => [m.agent, m.model, m.total])).toEqual([["claude", "opus", 110], ["gemini", "g", 5]]);
    expect(s.daily[1]?.byAgent).toEqual({ claude: 110 });
    expect(s.daily[2]?.byAgent).toEqual({ gemini: 5 });
    expect(s.available).toEqual(fullAvailable);
    // the same model name under another agent is not matched
    expect(getStats(db, team, { ...Q, models: [{ agent: "codex", model: "opus" }] }).totals.tokens).toBe(0);
  });

  test("agent and model filters combine with AND", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, {
      ...Q,
      agents: ["claude"],
      models: [{ agent: "claude", model: "opus" }, { agent: "codex", model: "gpt" }],
    });
    expect(s.totals.tokens).toBe(110);
    expect(s.models.map((m) => [m.agent, m.model])).toEqual([["claude", "opus"]]);
    expect(s.available).toEqual(fullAvailable);
  });

  test("a filter that matches nothing gives zeros, no models, members with zeros and a full available", () => {
    const { db, team } = seedFilters();
    for (const f of [{ agents: ["Claude"] }, { agents: ["claude' or '1'='1"] }, { models: [{ agent: "claude", model: "gpt" }] }]) {
      const s = getStats(db, team, { ...Q, ...f });
      expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 2 });
      expect(s.models).toEqual([]);
      expect(s.members.map((m) => [m.name, m.tokens, m.costUsd, m.machines])).toEqual([["Ann", 0, 0, 2], ["Bob", 0, 0, 1]]);
      expect(s.daily.every((d) => Object.keys(d.byAgent).length === 0)).toBe(true);
      expect(s.available).toEqual(fullAvailable);
    }
  });

  test("a member without matching usage stays listed and is not active", () => {
    const { db, team } = seedFilters();
    const s = getStats(db, team, { ...Q, agents: ["gemini"] });
    expect(s.totals).toEqual({ tokens: 5, costUsd: 0.05, activeMembers: 1, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["Bob", 5], ["Ann", 0]]);
  });

  test("filters combine with memberId; machines and lastSyncAt ignore them; available is the member's", () => {
    const { db, team, ann } = seedFilters();
    const s = getStats(db, team, { ...Q, memberId: ann, agents: ["claude"] });
    expect(s.totals).toEqual({ tokens: 30, costUsd: 0.3, activeMembers: 1, memberCount: 1 });
    expect(s.models.map((m) => [m.model, m.total])).toEqual([["sonnet", 20], ["opus", 10]]);
    expect(s.members[0]).toMatchObject({ tokens: 30, machines: 2, lastSyncAt: "2026-11-06T00:00:00.000Z" });
    expect(s.machines).toEqual([
      { label: "desk", lastSyncAt: "2026-11-06T00:00:00.000Z" },
      { label: "mbp", lastSyncAt: "2026-11-05T00:00:00.000Z" },
    ]);
    expect(s.available).toEqual({
      agents: ["codex", "claude"],
      models: [
        { agent: "codex", model: "gpt", tokens: 40 },
        { agent: "claude", model: "sonnet", tokens: 20 },
        { agent: "claude", model: "opus", tokens: 10 },
      ],
      accounts: [
        { key: "other", tokens: 40 },
        { key: "unknown", tokens: 30 },
      ],
      plans: [{ key: "none", tokens: 70 }],
    });
    const none = getStats(db, team, { ...Q, memberId: ann, agents: ["gemini"] });
    expect(none.totals.tokens).toBe(0);
    expect(none.machines).toHaveLength(2);
  });

  test("available respects the date range and is empty when nothing is in range", () => {
    const { db, team } = seedFilters();
    expect(getStats(db, team, { from: "2026-11-04", to: "2026-11-04" }).available).toEqual({
      agents: ["codex"],
      models: [{ agent: "codex", model: "other", tokens: 2 }, { agent: "codex", model: "gpt", tokens: 1 }],
      accounts: [{ key: "other", tokens: 3 }],
      plans: [{ key: "none", tokens: 3 }],
    });
    expect(getStats(db, team, { from: "2026-12-01", to: "2026-12-02", agents: ["claude"] }).available).toEqual({ agents: [], models: [], accounts: [], plans: [] });
  });

  test("names with quotes, percent signs and __proto__ are plain data", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "__proto__", "a'b%", 5), rec("2026-11-02", "x", "y", 7)]);
    const s = getStats(db, team, { ...Q, models: [{ agent: "__proto__", model: "a'b%" }] });
    expect(s.totals.tokens).toBe(5);
    expect(s.available.agents).toEqual(["x", "__proto__"]);
    expect(s.available.models).toEqual([
      { agent: "x", model: "y", tokens: 7 },
      { agent: "__proto__", model: "a'b%", tokens: 5 },
    ]);
    expect(getStats(db, team, { ...Q, agents: ["%"] }).totals.tokens).toBe(0);
  });

  test("available model totals ignore the filters, sum every machine and clamp non-finite values", () => {
    const { db, team } = seedFilters();
    const filtered = getStats(db, team, { ...Q, agents: ["gemini"], models: [{ agent: "gemini", model: "g" }] });
    expect(filtered.totals.tokens).toBe(5);
    // Sum of every model's tokens is the unfiltered total for the range (178), so the page needs no extra request.
    expect(filtered.available.models.reduce((n, m) => n + m.tokens, 0)).toBe(178);
    expect(getStats(db, team, Q).totals.tokens).toBe(178);
    const huge = newTeam();
    const r = huge.data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    huge.data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "a", "m", 1)]);
    huge.db.prepare("update usage set total = 1e308").run();
    huge.data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [rec("2026-11-03", "a", "m", 1)]);
    huge.db.prepare("update usage set total = 1e308").run();
    const t = getStats(huge.db, huge.team, Q).available.models[0]?.tokens;
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBe(Number.MAX_VALUE);
  });

  test("the number of queries does not grow with members, agents, models or filter values", () => {
    const { db, team } = seedFilters();
    let n = 0;
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => { n++; return orig(sql); };
    const queriesFor = (q: Parameters<typeof getStats>[2]) => {
      n = 0;
      getStats(db, team, q);
      return n;
    };
    const asks = [
      Q,
      { ...Q, agents: ["claude", "codex"], models: [{ agent: "claude", model: "opus" }] },
      { ...Q, memberId: 1, agents: ["claude"], accounts: ["personal", "team:D", "unknown"] },
    ];
    const before = asks.map(queriesFor);
    for (let i = 0; i < 5; i++) {
      const id = String(i + 5).repeat(32);
      const r = forTeam(db, team).registerMachine({ name: `M${i}`, email: `m${i}@x.com`, machineId: id, machineLabel: "l" });
      forTeam(db, team).upsertUsage({ memberId: r.memberId, machineId: id }, [rec("2026-11-02", `agent${i}`, `model${i}`, 3)]);
    }
    expect(asks.map(queriesFor)).toEqual(before);
    const accounts = (n: number) => ({ ...Q, accounts: Array.from({ length: n }, (_, i) => `team:o${i}`) });
    expect(queriesFor(accounts(50))).toBe(queriesFor(accounts(1)));
  });
});
