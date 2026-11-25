import { describe, expect, test } from "vitest";
import { getStats } from "./stats.js";
import { M1, M2, newTeam, Q, rec, seed } from "./stats.fixture.js";

describe("getStats", () => {
  test("totals, members, models and daily match hand-computed sums", () => {
    const { db, team } = seed();
    const s = getStats(db, team, Q);
    expect(s.from).toBe("2026-11-01");
    expect(s.to).toBe("2026-11-10");
    // Ann 10+20+20 = 50, Bob 100+5 = 105
    expect(s.totals).toEqual({ tokens: 155, costUsd: 1.55, activeMembers: 2, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.email, m.tokens, m.costUsd, m.machines])).toEqual([
      ["Bob", "bob@x.com", 105, 1.05, 1],
      ["Ann", "ann@x.com", 50, 0.5, 2],
    ]);
    expect(s.models).toEqual([
      { agent: "claude", model: "m1", input: 123, output: 4, cacheCreate: 4, cacheRead: 4, total: 135, costUsd: 1.35, unpriced: false },
      { agent: "codex", model: "m2", input: 17, output: 1, cacheCreate: 1, cacheRead: 1, total: 20, costUsd: 0.2, unpriced: true },
    ]);
    expect(s.daily).toHaveLength(10);
    expect(s.daily[0]).toEqual({ date: "2026-11-01", byAgent: {} });
    expect(s.daily[1]).toEqual({ date: "2026-11-02", byAgent: { claude: 130 } });
    expect(s.daily[2]).toEqual({ date: "2026-11-03", byAgent: { codex: 20 } });
    expect(s.daily[9]).toEqual({ date: "2026-11-10", byAgent: { claude: 5 } });
  });

  test("a member with two machines is one row and lastSyncAt is the latest", () => {
    const { db, team } = seed();
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M2);
    const s = getStats(db, team, Q);
    expect(s.members.filter((m) => m.email === "ann@x.com")).toHaveLength(1);
    expect(s.members.find((m) => m.email === "ann@x.com")?.lastSyncAt).toBe("2026-11-06T00:00:00.000Z");
  });

  test("lastSyncAt is null for a member whose machines never synced", () => {
    const { db, team, data } = newTeam();
    data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    expect(getStats(db, team, Q).members[0]).toMatchObject({ name: "Cy", tokens: 0, lastSyncAt: null, machines: 1 });
  });

  test("machines and lastSyncAt ignore the range", () => {
    const { db, team } = seed();
    const s = getStats(db, team, { from: "2026-12-01", to: "2026-12-02" });
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 2 });
    expect(s.members.map((m) => m.machines).sort()).toEqual([1, 2]);
  });

  test("range bounds are inclusive and exclude rows outside", () => {
    const { db, team } = seed();
    const s = getStats(db, team, { from: "2026-11-10", to: "2026-11-11" });
    expect(s.totals.tokens).toBe(12);
    expect(s.daily.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11"]);
  });

  test("memberId returns only that member", () => {
    const { db, team, ann } = seed();
    const s = getStats(db, team, { ...Q, memberId: ann });
    expect(s.members.map((m) => m.name)).toEqual(["Ann"]);
    expect(s.totals).toEqual({ tokens: 50, costUsd: 0.5, activeMembers: 1, memberCount: 1 });
    expect(s.models.map((m) => [m.agent, m.total])).toEqual([
      ["claude", 30],
      ["codex", 20],
    ]);
    expect(s.daily[1]?.byAgent).toEqual({ claude: 30 });
  });

  test("activeMembers counts only members with tokens in range", () => {
    const { db, team } = seed();
    const s = getStats(db, team, { from: "2026-11-03", to: "2026-11-03" });
    expect(s.totals).toMatchObject({ tokens: 20, activeMembers: 1, memberCount: 2 });
  });

  test("costUsd sums are rounded to 6 decimals", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-01", "claude", "a", 1, { costUsd: 0.1 }),
      rec("2026-11-01", "claude", "b", 1, { costUsd: 0.2 }),
    ]);
    expect(getStats(db, team, Q).totals.costUsd).toBe(0.3);
  });

  test("empty db gives zero totals and a full daily series of empty days", () => {
    const { db, team } = newTeam();
    const s = getStats(db, team, Q);
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 0 });
    expect(s.members).toEqual([]);
    expect(s.models).toEqual([]);
    expect(s.daily).toHaveLength(10);
    expect(s.daily.every((d) => Object.keys(d.byAgent).length === 0)).toBe(true);
  });

  test("handles month and year boundaries", () => {
    const { db, team } = newTeam();
    const s = getStats(db, team, { from: "2027-12-30", to: "2028-03-01" });
    expect(s.daily).toHaveLength(63);
    expect(s.daily.map((d) => d.date)).toContain("2028-02-29");
  });

  test("a range ending on the last date a YYYY-MM-DD can hold", () => {
    const { db, team } = newTeam();
    const s = getStats(db, team, { from: "9999-12-30", to: "9999-12-31" });
    expect(s.daily.map((d) => d.date)).toEqual(["9999-12-30", "9999-12-31"]);
  });

  test("agent ids like __proto__ are ordinary own properties", () => {
    const { db, team, data } = newTeam();
    const r = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    data.upsertUsage({ memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "__proto__", "m", 5),
      rec("2026-11-02", "constructor", "m", 7),
    ]);
    const s = getStats(db, team, Q);
    const day = s.daily[1]?.byAgent as Record<string, number>;
    expect(Object.keys(day).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(day, "__proto__")?.value).toBe(5);
    expect(day.constructor).toBe(7);
    expect(Object.getPrototypeOf(day)).toBe(Object.prototype);
    expect(s.models.map((m) => m.agent).sort()).toEqual(["__proto__", "constructor"]);
  });
});

describe("getStats storage-layer overflow guard", () => {
  const finiteNumbers = (v: unknown): boolean =>
    typeof v === "number" ? Number.isFinite(v)
    : Array.isArray(v) ? v.every(finiteNumbers)
    : typeof v === "object" && v !== null ? Object.values(v).every(finiteNumbers)
    : true;

  test("sums beyond the signed 64-bit range do not throw and stay finite", () => {
    const { db, team, data } = newTeam();
    const m = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    const ins = db.prepare(
      `insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
       values (?, ?, ?, '2026-11-02', 'claude', ?, ?, ?, ?, ?, ?, 1, 0)`,
    );
    const big = 2 ** 62;
    for (let i = 0; i < 4; i++) ins.run(team, m.memberId, M1, `m${i}`, big, big, big, big, big);
    const s = getStats(db, team, Q);
    expect(finiteNumbers(s)).toBe(true);
    expect(s.totals.tokens).toBe(4 * big);
  });

  test("ordinary values give exactly the hand-computed integer totals", () => {
    const { db, team, data } = newTeam();
    const m = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    data.upsertUsage({ memberId: m.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "m1", 1000),
      rec("2026-11-03", "claude", "m1", 2345),
    ]);
    const s = getStats(db, team, Q);
    expect(s.totals.tokens).toBe(3345);
    expect(s.members[0]?.tokens).toBe(3345);
    expect(s.models[0]).toMatchObject({ input: 3339, output: 2, cacheCreate: 2, cacheRead: 2, total: 3345 });
    expect(s.daily.find((d) => d.date === "2026-11-03")?.byAgent).toEqual({ claude: 2345 });
    expect(Number.isInteger(s.totals.tokens)).toBe(true);
  });
});
