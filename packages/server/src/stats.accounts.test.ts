import { describe, expect, test } from "vitest";
import { getStats } from "./stats.js";
import { M1, newTeam, Q, rec, seedAccounts, seedPlans } from "./stats.fixture.js";
import { forTeam } from "./team-data.js";

describe("account filter, available accounts and members byAccount", () => {
  const allAccounts = [
    { key: "team:D", tokens: 100 },
    { key: "personal", tokens: 40 },
    { key: "other", tokens: 10 },
    { key: "unknown", tokens: 5 },
  ];
  const byAccount = (s: ReturnType<typeof getStats>) => s.members.map((m) => [m.name, m.byAccount]);

  test("no filter: each member's tokens by account and every account in range", () => {
    const { db, team } = seedAccounts();
    const s = getStats(db, team, Q);
    expect(byAccount(s)).toEqual([
      ["A", { "team:D": 100, personal: 40, other: 10 }],
      ["B", { unknown: 5 }],
    ]);
    expect(s.available.accounts).toEqual(allAccounts);
  });

  test("a member's tokens by agent add up every account the agent ran on", () => {
    const { db, team } = seedAccounts();
    expect(getStats(db, team, Q).members.map((m) => [m.name, m.byAgent])).toEqual([
      ["A", { claude: 140, codex: 10 }],
      ["B", { claude: 5 }],
    ]);
  });

  test("an account filter applies to totals and members; available accounts ignore it", () => {
    const { db, team } = seedAccounts();
    const s = getStats(db, team, { ...Q, accounts: ["personal"] });
    expect(s.totals.tokens).toBe(40);
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["A", 40], ["B", 0]]);
    expect(byAccount(s)).toEqual([["A", { personal: 40 }], ["B", {}]]);
    expect(s.models.map((m) => [m.agent, m.model, m.total])).toEqual([["claude", "sonnet", 40]]);
    expect(s.available.accounts).toEqual(allAccounts);
    expect(getStats(db, team, { ...Q, accounts: ["team:D", "personal"] }).totals.tokens).toBe(140);
  });

  test("unknown is the null label and combines with the agent filter", () => {
    const { db, team } = seedAccounts();
    expect(getStats(db, team, { ...Q, accounts: ["unknown"] }).totals.tokens).toBe(5);
    expect(getStats(db, team, { ...Q, accounts: ["unknown"], agents: ["claude"] }).totals.tokens).toBe(5);
    expect(getStats(db, team, { ...Q, accounts: ["unknown"], agents: ["codex"] }).totals.tokens).toBe(0);
    expect(getStats(db, team, { ...Q, accounts: ["other"] }).totals.tokens).toBe(10);
  });

  test("available accounts respect the member and ignore agent and model filters", () => {
    const { db, team, a } = seedAccounts();
    const s = getStats(db, team, { ...Q, memberId: a, agents: ["codex"], models: [{ agent: "codex", model: "gpt" }], accounts: ["api"] });
    expect(s.totals.tokens).toBe(0);
    expect(s.available.accounts).toEqual([
      { key: "team:D", tokens: 100 },
      { key: "personal", tokens: 40 },
      { key: "other", tokens: 10 },
    ]);
  });

  test("team: with an empty org matches a team row with no org, not team:D", () => {
    const { db, team, a } = seedAccounts();
    forTeam(db, team).upsertUsage({ memberId: a, machineId: M1 }, [rec("2026-11-03", "claude", "opus", 7, { account: { kind: "team" } })]);
    const s = getStats(db, team, { ...Q, accounts: ["team:"] });
    expect(s.totals.tokens).toBe(7);
    expect(byAccount(s)).toEqual([["A", { "team:": 7 }], ["B", {}]]);
    expect(getStats(db, team, { ...Q, accounts: ["team:D"] }).totals.tokens).toBe(100);
    expect(getStats(db, team, { ...Q, accounts: ["enterprise:D"] }).totals.tokens).toBe(0);
    expect(getStats(db, team, Q).available.accounts).toContainEqual({ key: "team:", tokens: 7 });
  });

  test("an org named __proto__ is an ordinary own property; quotes and percent signs are data", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 5, { account: { kind: "team", org: "__proto__" } }),
      rec("2026-11-02", "claude", "sonnet", 7, { account: { kind: "team", org: "a'b%" } }),
    ]);
    const by = getStats(db, team, Q).members[0]?.byAccount as Record<string, number>;
    expect(Object.keys(by).sort()).toEqual(["team:__proto__", "team:a'b%"]);
    expect(Object.getOwnPropertyDescriptor(by, "team:__proto__")?.value).toBe(5);
    expect(Object.getPrototypeOf(by)).toBe(Object.prototype);
    expect(getStats(db, team, { ...Q, accounts: ["team:__proto__"] }).totals.tokens).toBe(5);
    expect(getStats(db, team, { ...Q, accounts: ["team:a'b%"] }).totals.tokens).toBe(7);
    expect(getStats(db, team, { ...Q, accounts: ["team:%"] }).totals.tokens).toBe(0);
  });

  test("an empty org and a missing org are the same account", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 5, { account: { kind: "team", org: "" } }),
      rec("2026-11-02", "claude", "sonnet", 7, { account: { kind: "team" } }),
    ]);
    const s = getStats(db, team, Q);
    expect(s.members[0]?.byAccount).toEqual({ "team:": 12 });
    expect(s.available.accounts).toEqual([{ key: "team:", tokens: 12 }]);
  });
});

describe("Other agents, Codex accounts and plans", () => {
  test("keeps unknown, other and chatgpt apart", () => {
    const { db, team } = seedPlans();
    expect(getStats(db, team, Q).available.accounts).toEqual([
      { key: "team:A", tokens: 50 },
      { key: "unknown", tokens: 100 },
      { key: "other", tokens: 20 },
      { key: "chatgpt:personal", tokens: 7 },
    ].sort((a, b) => b.tokens - a.tokens));
    expect(getStats(db, team, { ...Q, accounts: ["unknown"] }).totals.tokens).toBe(100);
    expect(getStats(db, team, { ...Q, accounts: ["other"] }).totals.tokens).toBe(20);
    expect(getStats(db, team, { ...Q, accounts: ["chatgpt:personal"] }).totals.tokens).toBe(7);
    expect(getStats(db, team, { ...Q, accounts: ["team:A"] }).totals.tokens).toBe(50);
    expect(getStats(db, team, Q).members[0]?.byAccount).toEqual({ unknown: 100, "team:A": 50, other: 20, "chatgpt:personal": 7 });
  });

  test("filters by plan", () => {
    const { db, team } = seedPlans();
    expect(getStats(db, team, { ...Q, plans: ["claude:team_premium"] }).totals.tokens).toBe(50);
    expect(getStats(db, team, { ...Q, plans: ["none"] }).totals.tokens).toBe(120);
    expect(getStats(db, team, { ...Q, plans: ["codex:plus", "claude:team_premium"] }).totals.tokens).toBe(57);
    expect(getStats(db, team, { ...Q, plans: ["claude:plus"] }).totals.tokens).toBe(0);
    expect(getStats(db, team, { ...Q, plans: ["codex:plus"], accounts: ["team:A"] }).totals.tokens).toBe(0);
    expect(getStats(db, team, { ...Q, plans: ["codex:plus"], agents: ["codex"] }).totals.tokens).toBe(7);
    expect(getStats(db, team, { ...Q, plans: ["bogus"] }).totals.tokens).toBe(0);
  });

  test("available plans ignore every filter", () => {
    const { db, team } = seedPlans();
    const expected = [
      { key: "none", tokens: 120 },
      { key: "claude:team_premium", tokens: 50 },
      { key: "codex:plus", tokens: 7 },
    ];
    expect(getStats(db, team, Q).available.plans).toEqual(expected);
    expect(getStats(db, team, { ...Q, plans: ["codex:plus"], agents: ["codex"], accounts: ["other"] }).available.plans).toEqual(expected);
  });

  test("byAccountPlan lists account and plan", () => {
    const { db, team } = seedPlans();
    expect(getStats(db, team, Q).members[0]?.byAccountPlan).toEqual([
      { account: "unknown", plan: "none", tokens: 100 },
      { account: "team:A", plan: "claude:team_premium", tokens: 50 },
      { account: "other", plan: "none", tokens: 20 },
      { account: "chatgpt:personal", plan: "codex:plus", tokens: 7 },
    ]);
    expect(getStats(db, team, { ...Q, plans: ["codex:plus"] }).members[0]?.byAccountPlan).toEqual([
      { account: "chatgpt:personal", plan: "codex:plus", tokens: 7 },
    ]);
  });
});
