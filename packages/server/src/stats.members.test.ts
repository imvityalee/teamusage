import { describe, expect, test } from "vitest";
import { getStats } from "./stats.js";
import { M1, M2, M3, M4, newTeam, Q, rec, seed, seedMix } from "./stats.fixture.js";
import { forTeam } from "./team-data.js";

describe("member ids and machines", () => {
  test("every members entry carries its id, and machines is absent without memberId", () => {
    const { db, team, ann, bob } = seed();
    const s = getStats(db, team, Q);
    expect(s.members.map((m) => [m.name, m.id])).toEqual([["Bob", bob], ["Ann", ann]]);
    expect("machines" in s).toBe(false);
  });

  test("memberId returns only that member's machines, most recent sync first, never-synced last", () => {
    const { db, team, ann, bob } = seed();
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M2);
    forTeam(db, team).registerMachine({ name: "Ann", email: "ann@x.com", machineId: M4, machineLabel: "never" });
    const s = getStats(db, team, { ...Q, memberId: ann });
    expect(s.machines).toEqual([
      { label: "desk", lastSyncAt: "2026-11-06T00:00:00.000Z" },
      { label: "mbp", lastSyncAt: "2026-11-05T00:00:00.000Z" },
      { label: "never", lastSyncAt: null },
    ]);
    expect(JSON.stringify(s)).not.toContain(M1);
    expect(getStats(db, team, { ...Q, memberId: bob }).machines?.map((m) => m.label)).toEqual(["box"]);
  });

  test("ties on last sync break by label then id", () => {
    const { db, team, data } = newTeam();
    const at = "2026-11-05T00:00:00.000Z";
    const a = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M3, machineLabel: "b" });
    data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M2, machineLabel: "b" });
    data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "a" });
    db.prepare("update machines set last_sync_at = ?").run(at);
    const s = getStats(db, team, { ...Q, memberId: a.memberId });
    expect(s.machines?.map((m) => m.label)).toEqual(["a", "b", "b"]);
  });

  test("a member with no usage in range has zero totals, no models and still their machines", () => {
    const { db, team, ann } = seed();
    const s = getStats(db, team, { from: "2026-12-01", to: "2026-12-03", memberId: ann });
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 1 });
    expect(s.models).toEqual([]);
    expect(s.machines?.map((m) => m.label).sort()).toEqual(["desk", "mbp"]);
  });
});

describe("members byAgent", () => {
  const mix = (s: ReturnType<typeof getStats>) => s.members.map((m) => [m.name, m.byAgent]);

  test("each member's tokens by agent in the range, summed over machines; a member without usage has an empty object", () => {
    const { db, team } = seedMix();
    expect(mix(getStats(db, team, Q))).toEqual([
      ["Bob", { claude: 100, gemini: 5, codex: 3 }],
      ["Ann", { claude: 30, codex: 40 }],
      ["Cy", {}],
    ]);
    // byAgent always adds up to the member's tokens.
    for (const m of getStats(db, team, Q).members) expect(Object.values(m.byAgent).reduce((a, n) => a + n, 0)).toBe(m.tokens);
  });

  test("respects the agent filter, the model filter and both together", () => {
    const { db, team } = seedMix();
    expect(mix(getStats(db, team, { ...Q, agents: ["codex"] }))).toEqual([["Ann", { codex: 40 }], ["Bob", { codex: 3 }], ["Cy", {}]]);
    expect(mix(getStats(db, team, { ...Q, models: [{ agent: "claude", model: "opus" }, { agent: "gemini", model: "g" }] }))).toEqual([
      ["Bob", { claude: 100, gemini: 5 }],
      ["Ann", { claude: 10 }],
      ["Cy", {}],
    ]);
    expect(mix(getStats(db, team, { ...Q, agents: ["claude"], models: [{ agent: "claude", model: "sonnet" }, { agent: "codex", model: "gpt" }] }))).toEqual([
      ["Ann", { claude: 20 }],
      ["Bob", {}],
      ["Cy", {}],
    ]);
    expect(mix(getStats(db, team, { ...Q, agents: ["nobody"] }))).toEqual([["Ann", {}], ["Bob", {}], ["Cy", {}]]);
  });

  test("respects the range and the member", () => {
    const { db, team, ann, cy } = seedMix();
    expect(mix(getStats(db, team, { from: "2026-11-04", to: "2026-11-05" }))).toEqual([["Ann", { claude: 4 }], ["Bob", { codex: 3 }], ["Cy", {}]]);
    expect(mix(getStats(db, team, { ...Q, memberId: ann, agents: ["claude"] }))).toEqual([["Ann", { claude: 30 }]]);
    expect(mix(getStats(db, team, { ...Q, memberId: cy }))).toEqual([["Cy", {}]]);
  });

  test("agent ids like __proto__ are ordinary own properties", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "__proto__", "m", 5), rec("2026-11-02", "constructor", "m", 7)]);
    const by = getStats(db, team, Q).members[0]?.byAgent as Record<string, number>;
    expect(Object.keys(by).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(by, "__proto__")?.value).toBe(5);
    expect(Object.getPrototypeOf(by)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(by))).toEqual(by);
  });

  test("sums beyond the integer range stay finite", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "a", "m", 1), rec("2026-11-03", "a", "m", 1)]);
    db.prepare("update usage set total = 1e308").run();
    expect(getStats(db, team, Q).members[0]?.byAgent).toEqual({ a: Number.MAX_VALUE });
  });
});
