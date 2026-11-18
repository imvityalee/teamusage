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
      `insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
       values (?, ?, '2026-11-02', 'claude', ?, ?, ?, ?, ?, ?, 1, 0)`,
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
    });
    expect(getStats(db, { from: "2026-12-01", to: "2026-12-02", agents: ["claude"] }).available).toEqual({ agents: [], models: [] });
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

  test("a filter run issues a bounded number of queries", () => {
    const { db } = seedFilters();
    let n = 0;
    const orig = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => { n++; return orig(sql); };
    getStats(db, { ...Q, agents: ["claude", "codex"], models: [{ agent: "claude", model: "opus" }] });
    expect(n).toBe(4);
    n = 0;
    getStats(db, { ...Q, memberId: 1, agents: ["claude"] });
    expect(n).toBe(5);
  });
});
