import { describe, expect, test } from "vitest";
import { openDb, registerMachine, upsertUsage, type Db } from "./db.js";
import { getStats, memberExists } from "./stats.js";

const M1 = "1".repeat(32);
const M2 = "2".repeat(32);
const M3 = "3".repeat(32);

const rec = (date: string, agent: string, model: string, total: number, over: Record<string, unknown> = {}) => ({
  date,
  agent,
  model,
  input: total - 3,
  output: 1,
  cacheCreate: 1,
  cacheRead: 1,
  total,
  costUsd: total / 100,
  unpriced: false,
  ...over,
});

function seed(): { db: Db; ann: number; bob: number } {
  const db = openDb(":memory:");
  const a1 = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  const a2 = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M2, machineLabel: "desk" });
  const b = registerMachine(db, { name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
  // Ann: machine 1 and 2 share (11-02, claude, m1), so they sum to 30.
  upsertUsage(db, { memberId: a1.memberId, machineId: M1 }, [
    rec("2026-11-02", "claude", "m1", 10),
    rec("2026-11-03", "codex", "m2", 20, { unpriced: true }),
    rec("2026-10-01", "claude", "m1", 1000), // outside range
  ]);
  upsertUsage(db, { memberId: a2.memberId, machineId: M2 }, [rec("2026-11-02", "claude", "m1", 20)]);
  upsertUsage(db, { memberId: b.memberId, machineId: M3 }, [
    rec("2026-11-02", "claude", "m1", 100),
    rec("2026-11-10", "claude", "m1", 5),
    rec("2026-11-11", "claude", "m1", 7), // outside range
  ]);
  return { db, ann: a1.memberId, bob: b.memberId };
}

const Q = { from: "2026-11-01", to: "2026-11-10" };

describe("getStats", () => {
  test("totals, members, models and daily match hand-computed sums", () => {
    const { db } = seed();
    const s = getStats(db, Q);
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
    const { db } = seed();
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M2);
    const s = getStats(db, Q);
    expect(s.members.filter((m) => m.email === "ann@x.com")).toHaveLength(1);
    expect(s.members.find((m) => m.email === "ann@x.com")?.lastSyncAt).toBe("2026-11-06T00:00:00.000Z");
  });

  test("lastSyncAt is null for a member whose machines never synced", () => {
    const db = openDb(":memory:");
    registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    expect(getStats(db, Q).members[0]).toMatchObject({ name: "Cy", tokens: 0, lastSyncAt: null, machines: 1 });
  });

  test("machines and lastSyncAt ignore the range", () => {
    const { db } = seed();
    const s = getStats(db, { from: "2026-12-01", to: "2026-12-02" });
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 2 });
    expect(s.members.map((m) => m.machines).sort()).toEqual([1, 2]);
  });

  test("range bounds are inclusive and exclude rows outside", () => {
    const { db } = seed();
    const s = getStats(db, { from: "2026-11-10", to: "2026-11-11" });
    expect(s.totals.tokens).toBe(12);
    expect(s.daily.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11"]);
  });

  test("memberId returns only that member", () => {
    const { db, ann } = seed();
    const s = getStats(db, { ...Q, memberId: ann });
    expect(s.members.map((m) => m.name)).toEqual(["Ann"]);
    expect(s.totals).toEqual({ tokens: 50, costUsd: 0.5, activeMembers: 1, memberCount: 1 });
    expect(s.models.map((m) => [m.agent, m.total])).toEqual([
      ["claude", 30],
      ["codex", 20],
    ]);
    expect(s.daily[1]?.byAgent).toEqual({ claude: 30 });
  });

  test("activeMembers counts only members with tokens in range", () => {
    const { db } = seed();
    const s = getStats(db, { from: "2026-11-03", to: "2026-11-03" });
    expect(s.totals).toMatchObject({ tokens: 20, activeMembers: 1, memberCount: 2 });
  });

  test("costUsd sums are rounded to 6 decimals", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-01", "claude", "a", 1, { costUsd: 0.1 }),
      rec("2026-11-01", "claude", "b", 1, { costUsd: 0.2 }),
    ]);
    expect(getStats(db, Q).totals.costUsd).toBe(0.3);
  });

  test("empty db gives zero totals and a full daily series of empty days", () => {
    const s = getStats(openDb(":memory:"), Q);
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 0 });
    expect(s.members).toEqual([]);
    expect(s.models).toEqual([]);
    expect(s.daily).toHaveLength(10);
    expect(s.daily.every((d) => Object.keys(d.byAgent).length === 0)).toBe(true);
  });

  test("handles month and year boundaries", () => {
    const s = getStats(openDb(":memory:"), { from: "2027-12-30", to: "2028-03-01" });
    expect(s.daily).toHaveLength(63);
    expect(s.daily.map((d) => d.date)).toContain("2028-02-29");
  });

  test("a range ending on the last date a YYYY-MM-DD can hold", () => {
    const s = getStats(openDb(":memory:"), { from: "9999-12-30", to: "9999-12-31" });
    expect(s.daily.map((d) => d.date)).toEqual(["9999-12-30", "9999-12-31"]);
  });

  test("agent ids like __proto__ are ordinary own properties", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "__proto__", "m", 5),
      rec("2026-11-02", "constructor", "m", 7),
    ]);
    const s = getStats(db, Q);
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
    const db = openDb(":memory:");
    const m = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    const ins = db.prepare(
      `insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
       values (1, ?, ?, '2026-11-02', 'claude', ?, ?, ?, ?, ?, ?, 1, 0)`,
    );
    const big = 2 ** 62;
    for (let i = 0; i < 4; i++) ins.run(m.memberId, M1, `m${i}`, big, big, big, big, big);
    const s = getStats(db, Q);
    expect(finiteNumbers(s)).toBe(true);
    expect(s.totals.tokens).toBe(4 * big);
  });

  test("ordinary values give exactly the hand-computed integer totals", () => {
    const db = openDb(":memory:");
    const m = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    upsertUsage(db, { memberId: m.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "m1", 1000),
      rec("2026-11-03", "claude", "m1", 2345),
    ]);
    const s = getStats(db, Q);
    expect(s.totals.tokens).toBe(3345);
    expect(s.members[0]?.tokens).toBe(3345);
    expect(s.models[0]).toMatchObject({ input: 3339, output: 2, cacheCreate: 2, cacheRead: 2, total: 3345 });
    expect(s.daily.find((d) => d.date === "2026-11-03")?.byAgent).toEqual({ claude: 2345 });
    expect(Number.isInteger(s.totals.tokens)).toBe(true);
  });
});

describe("member ids and machines", () => {
  test("every members entry carries its id, and machines is absent without memberId", () => {
    const { db, ann, bob } = seed();
    const s = getStats(db, Q);
    expect(s.members.map((m) => [m.name, m.id])).toEqual([["Bob", bob], ["Ann", ann]]);
    expect("machines" in s).toBe(false);
  });

  test("memberId returns only that member's machines, most recent sync first, never-synced last", () => {
    const { db, ann, bob } = seed();
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M2);
    registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: "4".repeat(32), machineLabel: "never" });
    const s = getStats(db, { ...Q, memberId: ann });
    expect(s.machines).toEqual([
      { label: "desk", lastSyncAt: "2026-11-06T00:00:00.000Z" },
      { label: "mbp", lastSyncAt: "2026-11-05T00:00:00.000Z" },
      { label: "never", lastSyncAt: null },
    ]);
    expect(JSON.stringify(s)).not.toContain(M1);
    expect(getStats(db, { ...Q, memberId: bob }).machines?.map((m) => m.label)).toEqual(["box"]);
  });

  test("ties on last sync break by label then id", () => {
    const db = openDb(":memory:");
    const at = "2026-11-05T00:00:00.000Z";
    const a = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M3, machineLabel: "b" });
    registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M2, machineLabel: "b" });
    registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "a" });
    db.prepare("update machines set last_sync_at = ?").run(at);
    const s = getStats(db, { ...Q, memberId: a.memberId });
    expect(s.machines?.map((m) => m.label)).toEqual(["a", "b", "b"]);
  });

  test("a member with no usage in range has zero totals, no models and still their machines", () => {
    const { db, ann } = seed();
    const s = getStats(db, { from: "2026-12-01", to: "2026-12-03", memberId: ann });
    expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 1 });
    expect(s.models).toEqual([]);
    expect(s.machines?.map((m) => m.label).sort()).toEqual(["desk", "mbp"]);
  });

  test("memberExists", () => {
    const { db, ann } = seed();
    expect(memberExists(db, ann)).toBe(true);
    expect(memberExists(db, 999999)).toBe(false);
  });
});

describe("agent and model filters", () => {
  const M4 = "4".repeat(32);
  /** Ann (two machines) and Bob; three agents. In range: claude/opus 110, codex/gpt 41, claude/sonnet 20, gemini/g 5, codex/other 2. */
  function seedFilters(): { db: Db; ann: number; bob: number } {
    const db = openDb(":memory:");
    const a1 = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M4, machineLabel: "desk" });
    const b = registerMachine(db, { name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
    upsertUsage(db, { memberId: a1.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 10),
      rec("2026-11-02", "claude", "sonnet", 20),
      rec("2026-11-03", "codex", "gpt", 40),
    ]);
    upsertUsage(db, { memberId: b.memberId, machineId: M3 }, [
      rec("2026-11-02", "claude", "opus", 100),
      rec("2026-11-03", "gemini", "g", 5),
      rec("2026-11-04", "codex", "gpt", 1),
      rec("2026-11-04", "codex", "other", 2),
      rec("2026-10-01", "claude", "opus", 1000), // outside range
    ]);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
    db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M4);
    return { db, ann: a1.memberId, bob: b.memberId };
  }
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
    const { db } = seedFilters();
    const s = getStats(db, Q);
    expect(s.available).toEqual(fullAvailable);
    expect(s.totals.tokens).toBe(178);
  });

  test("an agent filter keeps only that agent in totals, daily, members and models", () => {
    const { db } = seedFilters();
    const s = getStats(db, { ...Q, agents: ["codex"] });
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
    const { db } = seedFilters();
    const s = getStats(db, { ...Q, agents: ["gemini", "claude"] });
    expect(s.totals.tokens).toBe(135);
    expect(s.models.map((m) => m.model)).toEqual(["opus", "sonnet", "g"]);
  });

  test("a model filter matches the exact (agent, model) pair", () => {
    const { db } = seedFilters();
    const s = getStats(db, { ...Q, models: [{ agent: "claude", model: "opus" }, { agent: "gemini", model: "g" }] });
    expect(s.totals).toEqual({ tokens: 115, costUsd: 1.15, activeMembers: 2, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["Bob", 105], ["Ann", 10]]);
    expect(s.models.map((m) => [m.agent, m.model, m.total])).toEqual([["claude", "opus", 110], ["gemini", "g", 5]]);
    expect(s.daily[1]?.byAgent).toEqual({ claude: 110 });
    expect(s.daily[2]?.byAgent).toEqual({ gemini: 5 });
    expect(s.available).toEqual(fullAvailable);
    // the same model name under another agent is not matched
    expect(getStats(db, { ...Q, models: [{ agent: "codex", model: "opus" }] }).totals.tokens).toBe(0);
  });

  test("agent and model filters combine with AND", () => {
    const { db } = seedFilters();
    const s = getStats(db, {
      ...Q,
      agents: ["claude"],
      models: [{ agent: "claude", model: "opus" }, { agent: "codex", model: "gpt" }],
    });
    expect(s.totals.tokens).toBe(110);
    expect(s.models.map((m) => [m.agent, m.model])).toEqual([["claude", "opus"]]);
    expect(s.available).toEqual(fullAvailable);
  });

  test("a filter that matches nothing gives zeros, no models, members with zeros and a full available", () => {
    const { db } = seedFilters();
    for (const f of [{ agents: ["Claude"] }, { agents: ["claude' or '1'='1"] }, { models: [{ agent: "claude", model: "gpt" }] }]) {
      const s = getStats(db, { ...Q, ...f });
      expect(s.totals).toEqual({ tokens: 0, costUsd: 0, activeMembers: 0, memberCount: 2 });
      expect(s.models).toEqual([]);
      expect(s.members.map((m) => [m.name, m.tokens, m.costUsd, m.machines])).toEqual([["Ann", 0, 0, 2], ["Bob", 0, 0, 1]]);
      expect(s.daily.every((d) => Object.keys(d.byAgent).length === 0)).toBe(true);
      expect(s.available).toEqual(fullAvailable);
    }
  });

  test("a member without matching usage stays listed and is not active", () => {
    const { db } = seedFilters();
    const s = getStats(db, { ...Q, agents: ["gemini"] });
    expect(s.totals).toEqual({ tokens: 5, costUsd: 0.05, activeMembers: 1, memberCount: 2 });
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["Bob", 5], ["Ann", 0]]);
  });

  test("filters combine with memberId; machines and lastSyncAt ignore them; available is the member's", () => {
    const { db, ann } = seedFilters();
    const s = getStats(db, { ...Q, memberId: ann, agents: ["claude"] });
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
    const none = getStats(db, { ...Q, memberId: ann, agents: ["gemini"] });
    expect(none.totals.tokens).toBe(0);
    expect(none.machines).toHaveLength(2);
  });

  test("available respects the date range and is empty when nothing is in range", () => {
    const { db } = seedFilters();
    expect(getStats(db, { from: "2026-11-04", to: "2026-11-04" }).available).toEqual({
      agents: ["codex"],
      models: [{ agent: "codex", model: "other", tokens: 2 }, { agent: "codex", model: "gpt", tokens: 1 }],
      accounts: [{ key: "other", tokens: 3 }],
      plans: [{ key: "none", tokens: 3 }],
    });
    expect(getStats(db, { from: "2026-12-01", to: "2026-12-02", agents: ["claude"] }).available).toEqual({ agents: [], models: [], accounts: [], plans: [] });
  });

  test("names with quotes, percent signs and __proto__ are plain data", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "__proto__", "a'b%", 5), rec("2026-11-02", "x", "y", 7)]);
    const s = getStats(db, { ...Q, models: [{ agent: "__proto__", model: "a'b%" }] });
    expect(s.totals.tokens).toBe(5);
    expect(s.available.agents).toEqual(["x", "__proto__"]);
    expect(s.available.models).toEqual([
      { agent: "x", model: "y", tokens: 7 },
      { agent: "__proto__", model: "a'b%", tokens: 5 },
    ]);
    expect(getStats(db, { ...Q, agents: ["%"] }).totals.tokens).toBe(0);
  });

  test("available model totals ignore the filters, sum every machine and clamp non-finite values", () => {
    const { db } = seedFilters();
    const filtered = getStats(db, { ...Q, agents: ["gemini"], models: [{ agent: "gemini", model: "g" }] });
    expect(filtered.totals.tokens).toBe(5);
    // Sum of every model's tokens is the unfiltered total for the range (178), so the page needs no extra request.
    expect(filtered.available.models.reduce((n, m) => n + m.tokens, 0)).toBe(178);
    expect(getStats(db, Q).totals.tokens).toBe(178);
    const huge = openDb(":memory:");
    const r = registerMachine(huge, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(huge, { memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "a", "m", 1)]);
    huge.prepare("update usage set total = 1e308").run();
    upsertUsage(huge, { memberId: r.memberId, machineId: M1 }, [rec("2026-11-03", "a", "m", 1)]);
    huge.prepare("update usage set total = 1e308").run();
    const t = getStats(huge, Q).available.models[0]?.tokens;
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBe(Number.MAX_VALUE);
  });

  test("the number of queries does not grow with members, agents, models or filter values", () => {
    const { db } = seedFilters();
    let n = 0;
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => { n++; return orig(sql); };
    const queriesFor = (q: Parameters<typeof getStats>[1]) => {
      n = 0;
      getStats(db, q);
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
      const r = registerMachine(db, { name: `M${i}`, email: `m${i}@x.com`, machineId: id, machineLabel: "l" });
      upsertUsage(db, { memberId: r.memberId, machineId: id }, [rec("2026-11-02", `agent${i}`, `model${i}`, 3)]);
    }
    expect(asks.map(queriesFor)).toEqual(before);
    expect(queriesFor({ ...Q, accounts: Array.from({ length: 50 }, (_, i) => `team:o${i}`) })).toBe(before[0]);
  });
});

describe("members byAgent", () => {
  const M4 = "4".repeat(32);
  /** The same data as the filter tests: Ann claude/opus 10, claude/sonnet 20, codex/gpt 40; Bob claude/opus 100, gemini/g 5, codex/gpt 1, codex/other 2. */
  function seedMix(): { db: Db; ann: number; bob: number; cy: number } {
    const db = openDb(":memory:");
    const a = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
    const a2 = registerMachine(db, { name: "Ann", email: "ann@x.com", machineId: M4, machineLabel: "desk" });
    const b = registerMachine(db, { name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
    const c = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M2, machineLabel: "idle" });
    upsertUsage(db, { memberId: a.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 6),
      rec("2026-11-02", "claude", "sonnet", 20),
      rec("2026-11-03", "codex", "gpt", 40),
    ]);
    // A second machine of Ann's: summed with the first.
    upsertUsage(db, { memberId: a2.memberId, machineId: M4 }, [rec("2026-11-05", "claude", "opus", 4)]);
    upsertUsage(db, { memberId: b.memberId, machineId: M3 }, [
      rec("2026-11-02", "claude", "opus", 100),
      rec("2026-11-03", "gemini", "g", 5),
      rec("2026-11-04", "codex", "gpt", 1),
      rec("2026-11-04", "codex", "other", 2),
      rec("2026-10-01", "claude", "opus", 1000), // outside range
    ]);
    return { db, ann: a.memberId, bob: b.memberId, cy: c.memberId };
  }
  const mix = (s: ReturnType<typeof getStats>) => s.members.map((m) => [m.name, m.byAgent]);

  test("each member's tokens by agent in the range, summed over machines; a member without usage has an empty object", () => {
    const { db } = seedMix();
    expect(mix(getStats(db, Q))).toEqual([
      ["Bob", { claude: 100, gemini: 5, codex: 3 }],
      ["Ann", { claude: 30, codex: 40 }],
      ["Cy", {}],
    ]);
    // byAgent always adds up to the member's tokens.
    for (const m of getStats(db, Q).members) expect(Object.values(m.byAgent).reduce((a, n) => a + n, 0)).toBe(m.tokens);
  });

  test("respects the agent filter, the model filter and both together", () => {
    const { db } = seedMix();
    expect(mix(getStats(db, { ...Q, agents: ["codex"] }))).toEqual([["Ann", { codex: 40 }], ["Bob", { codex: 3 }], ["Cy", {}]]);
    expect(mix(getStats(db, { ...Q, models: [{ agent: "claude", model: "opus" }, { agent: "gemini", model: "g" }] }))).toEqual([
      ["Bob", { claude: 100, gemini: 5 }],
      ["Ann", { claude: 10 }],
      ["Cy", {}],
    ]);
    expect(mix(getStats(db, { ...Q, agents: ["claude"], models: [{ agent: "claude", model: "sonnet" }, { agent: "codex", model: "gpt" }] }))).toEqual([
      ["Ann", { claude: 20 }],
      ["Bob", {}],
      ["Cy", {}],
    ]);
    expect(mix(getStats(db, { ...Q, agents: ["nobody"] }))).toEqual([["Ann", {}], ["Bob", {}], ["Cy", {}]]);
  });

  test("respects the range and the member", () => {
    const { db, ann, cy } = seedMix();
    expect(mix(getStats(db, { from: "2026-11-04", to: "2026-11-05" }))).toEqual([["Ann", { claude: 4 }], ["Bob", { codex: 3 }], ["Cy", {}]]);
    expect(mix(getStats(db, { ...Q, memberId: ann, agents: ["claude"] }))).toEqual([["Ann", { claude: 30 }]]);
    expect(mix(getStats(db, { ...Q, memberId: cy }))).toEqual([["Cy", {}]]);
  });

  test("agent ids like __proto__ are ordinary own properties", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "__proto__", "m", 5), rec("2026-11-02", "constructor", "m", 7)]);
    const by = getStats(db, Q).members[0]?.byAgent as Record<string, number>;
    expect(Object.keys(by).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getOwnPropertyDescriptor(by, "__proto__")?.value).toBe(5);
    expect(Object.getPrototypeOf(by)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(by))).toEqual(by);
  });

  test("sums beyond the integer range stay finite", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [rec("2026-11-02", "a", "m", 1), rec("2026-11-03", "a", "m", 1)]);
    db.prepare("update usage set total = 1e308").run();
    expect(getStats(db, Q).members[0]?.byAgent).toEqual({ a: Number.MAX_VALUE });
  });
});

describe("account filter, available accounts and members byAccount", () => {
  const MB = "b".repeat(32);
  /** One day. Member A: claude/team:D 100, claude/personal 40, codex (no label) 10. Member B: claude (no label) 5. */
  function seedAccounts(): { db: Db; a: number; b: number } {
    const db = openDb(":memory:");
    const a = registerMachine(db, { name: "A", email: "a@x.com", machineId: M1, machineLabel: "l" });
    const b = registerMachine(db, { name: "B", email: "b@x.com", machineId: MB, machineLabel: "l" });
    upsertUsage(db, { memberId: a.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 100, { account: { kind: "team", org: "D" } }),
      rec("2026-11-02", "claude", "sonnet", 40, { account: { kind: "personal" } }),
      rec("2026-11-02", "codex", "gpt", 10),
    ]);
    upsertUsage(db, { memberId: b.memberId, machineId: MB }, [rec("2026-11-02", "claude", "opus", 5)]);
    return { db, a: a.memberId, b: b.memberId };
  }
  const allAccounts = [
    { key: "team:D", tokens: 100 },
    { key: "personal", tokens: 40 },
    { key: "other", tokens: 10 },
    { key: "unknown", tokens: 5 },
  ];
  const byAccount = (s: ReturnType<typeof getStats>) => s.members.map((m) => [m.name, m.byAccount]);

  test("no filter: each member's tokens by account and every account in range", () => {
    const { db } = seedAccounts();
    const s = getStats(db, Q);
    expect(byAccount(s)).toEqual([
      ["A", { "team:D": 100, personal: 40, other: 10 }],
      ["B", { unknown: 5 }],
    ]);
    expect(s.available.accounts).toEqual(allAccounts);
  });

  test("a member's tokens by agent add up every account the agent ran on", () => {
    const { db } = seedAccounts();
    expect(getStats(db, Q).members.map((m) => [m.name, m.byAgent])).toEqual([
      ["A", { claude: 140, codex: 10 }],
      ["B", { claude: 5 }],
    ]);
  });

  test("an account filter applies to totals and members; available accounts ignore it", () => {
    const { db } = seedAccounts();
    const s = getStats(db, { ...Q, accounts: ["personal"] });
    expect(s.totals.tokens).toBe(40);
    expect(s.members.map((m) => [m.name, m.tokens])).toEqual([["A", 40], ["B", 0]]);
    expect(byAccount(s)).toEqual([["A", { personal: 40 }], ["B", {}]]);
    expect(s.models.map((m) => [m.agent, m.model, m.total])).toEqual([["claude", "sonnet", 40]]);
    expect(s.available.accounts).toEqual(allAccounts);
    expect(getStats(db, { ...Q, accounts: ["team:D", "personal"] }).totals.tokens).toBe(140);
  });

  test("unknown is the null label and combines with the agent filter", () => {
    const { db } = seedAccounts();
    expect(getStats(db, { ...Q, accounts: ["unknown"] }).totals.tokens).toBe(5);
    expect(getStats(db, { ...Q, accounts: ["unknown"], agents: ["claude"] }).totals.tokens).toBe(5);
    expect(getStats(db, { ...Q, accounts: ["unknown"], agents: ["codex"] }).totals.tokens).toBe(0);
    expect(getStats(db, { ...Q, accounts: ["other"] }).totals.tokens).toBe(10);
  });

  test("available accounts respect the member and ignore agent and model filters", () => {
    const { db, a } = seedAccounts();
    const s = getStats(db, { ...Q, memberId: a, agents: ["codex"], models: [{ agent: "codex", model: "gpt" }], accounts: ["api"] });
    expect(s.totals.tokens).toBe(0);
    expect(s.available.accounts).toEqual([
      { key: "team:D", tokens: 100 },
      { key: "personal", tokens: 40 },
      { key: "other", tokens: 10 },
    ]);
  });

  test("team: with an empty org matches a team row with no org, not team:D", () => {
    const { db, a } = seedAccounts();
    upsertUsage(db, { memberId: a, machineId: M1 }, [rec("2026-11-03", "claude", "opus", 7, { account: { kind: "team" } })]);
    const s = getStats(db, { ...Q, accounts: ["team:"] });
    expect(s.totals.tokens).toBe(7);
    expect(byAccount(s)).toEqual([["A", { "team:": 7 }], ["B", {}]]);
    expect(getStats(db, { ...Q, accounts: ["team:D"] }).totals.tokens).toBe(100);
    expect(getStats(db, { ...Q, accounts: ["enterprise:D"] }).totals.tokens).toBe(0);
    expect(getStats(db, Q).available.accounts).toContainEqual({ key: "team:", tokens: 7 });
  });

  test("an org named __proto__ is an ordinary own property; quotes and percent signs are data", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 5, { account: { kind: "team", org: "__proto__" } }),
      rec("2026-11-02", "claude", "sonnet", 7, { account: { kind: "team", org: "a'b%" } }),
    ]);
    const by = getStats(db, Q).members[0]?.byAccount as Record<string, number>;
    expect(Object.keys(by).sort()).toEqual(["team:__proto__", "team:a'b%"]);
    expect(Object.getOwnPropertyDescriptor(by, "team:__proto__")?.value).toBe(5);
    expect(Object.getPrototypeOf(by)).toBe(Object.prototype);
    expect(getStats(db, { ...Q, accounts: ["team:__proto__"] }).totals.tokens).toBe(5);
    expect(getStats(db, { ...Q, accounts: ["team:a'b%"] }).totals.tokens).toBe(7);
    expect(getStats(db, { ...Q, accounts: ["team:%"] }).totals.tokens).toBe(0);
  });

  test("an empty org and a missing org are the same account", () => {
    const db = openDb(":memory:");
    const r = registerMachine(db, { name: "Cy", email: "cy@x.com", machineId: M1, machineLabel: "l" });
    upsertUsage(db, { memberId: r.memberId, machineId: M1 }, [
      rec("2026-11-02", "claude", "opus", 5, { account: { kind: "team", org: "" } }),
      rec("2026-11-02", "claude", "sonnet", 7, { account: { kind: "team" } }),
    ]);
    const s = getStats(db, Q);
    expect(s.members[0]?.byAccount).toEqual({ "team:": 12 });
    expect(s.available.accounts).toEqual([{ key: "team:", tokens: 12 }]);
  });
});

describe("Other agents, Codex accounts and plans", () => {
  const MC = "c".repeat(32);
  /** One member: claude unlabelled 100, codex unlabelled 20, codex personal/plus 7, claude team:A/team_premium 50. */
  function seedPlans(): Db {
    const db = openDb(":memory:");
    const m = registerMachine(db, { name: "P", email: "p@x.com", machineId: MC, machineLabel: "l" });
    upsertUsage(db, { memberId: m.memberId, machineId: MC }, [
      rec("2026-11-02", "claude", "opus", 100),
      rec("2026-11-02", "codex", "gpt", 20),
      rec("2026-11-02", "codex", "gpt5", 7, { account: { kind: "personal", plan: "plus" } }),
      rec("2026-11-02", "claude", "sonnet", 50, { account: { kind: "team", org: "A", plan: "team_premium" } }),
    ]);
    return db;
  }

  test("keeps unknown, other and chatgpt apart", () => {
    const db = seedPlans();
    expect(getStats(db, Q).available.accounts).toEqual([
      { key: "team:A", tokens: 50 },
      { key: "unknown", tokens: 100 },
      { key: "other", tokens: 20 },
      { key: "chatgpt:personal", tokens: 7 },
    ].sort((a, b) => b.tokens - a.tokens));
    expect(getStats(db, { ...Q, accounts: ["unknown"] }).totals.tokens).toBe(100);
    expect(getStats(db, { ...Q, accounts: ["other"] }).totals.tokens).toBe(20);
    expect(getStats(db, { ...Q, accounts: ["chatgpt:personal"] }).totals.tokens).toBe(7);
    expect(getStats(db, { ...Q, accounts: ["team:A"] }).totals.tokens).toBe(50);
    expect(getStats(db, Q).members[0]?.byAccount).toEqual({ unknown: 100, "team:A": 50, other: 20, "chatgpt:personal": 7 });
  });

  test("filters by plan", () => {
    const db = seedPlans();
    expect(getStats(db, { ...Q, plans: ["claude:team_premium"] }).totals.tokens).toBe(50);
    expect(getStats(db, { ...Q, plans: ["none"] }).totals.tokens).toBe(120);
    expect(getStats(db, { ...Q, plans: ["codex:plus", "claude:team_premium"] }).totals.tokens).toBe(57);
    expect(getStats(db, { ...Q, plans: ["claude:plus"] }).totals.tokens).toBe(0);
    expect(getStats(db, { ...Q, plans: ["codex:plus"], accounts: ["team:A"] }).totals.tokens).toBe(0);
    expect(getStats(db, { ...Q, plans: ["codex:plus"], agents: ["codex"] }).totals.tokens).toBe(7);
    expect(getStats(db, { ...Q, plans: ["bogus"] }).totals.tokens).toBe(0);
  });

  test("available plans ignore every filter", () => {
    const db = seedPlans();
    const expected = [
      { key: "none", tokens: 120 },
      { key: "claude:team_premium", tokens: 50 },
      { key: "codex:plus", tokens: 7 },
    ];
    expect(getStats(db, Q).available.plans).toEqual(expected);
    expect(getStats(db, { ...Q, plans: ["codex:plus"], agents: ["codex"], accounts: ["other"] }).available.plans).toEqual(expected);
  });

  test("byAccountPlan lists account and plan", () => {
    const db = seedPlans();
    expect(getStats(db, Q).members[0]?.byAccountPlan).toEqual([
      { account: "unknown", plan: "none", tokens: 100 },
      { account: "team:A", plan: "claude:team_premium", tokens: 50 },
      { account: "other", plan: "none", tokens: 20 },
      { account: "chatgpt:personal", plan: "codex:plus", tokens: 7 },
    ]);
    expect(getStats(db, { ...Q, plans: ["codex:plus"] }).members[0]?.byAccountPlan).toEqual([
      { account: "chatgpt:personal", plan: "codex:plus", tokens: 7 },
    ]);
  });
});
