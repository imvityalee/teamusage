import { describe, expect, test } from "vitest";
import { validateBatch } from "@teamusage/shared";
import { openDb } from "./db.js";
import { seedDemo } from "./demo.js";
import { getStats } from "./stats.js";
import { forTeam } from "./team-data.js";
import { createTeam, ensureSingleTeam } from "./teams.js";

const TODAY = "2026-11-18";
const FROM = "2026-08-21";

describe("seedDemo", () => {
  test("is deterministic", () => {
    const a = openDb(":memory:");
    const b = openDb(":memory:");
    seedDemo(a, ensureSingleTeam(a), TODAY);
    seedDemo(b, ensureSingleTeam(b), TODAY);
    expect(getStats(a, ensureSingleTeam(a), { from: "2026-05-23", to: TODAY })).toEqual(getStats(b, ensureSingleTeam(b), { from: "2026-05-23", to: TODAY }));
  });

  test("seeds 6 members, 4 agents and a cost over 90 days", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const s = getStats(db, ensureSingleTeam(db), { from: FROM, to: TODAY });
    expect(s.members).toHaveLength(6);
    expect(s.members.every((m) => m.email.endsWith("@example.com"))).toBe(true);
    expect(new Set(s.models.map((m) => m.agent))).toEqual(new Set(["claude", "codex", "gemini", "opencode"]));
    expect(s.totals.costUsd).toBeGreaterThan(0);
    expect(s.daily).toHaveLength(90);
  });

  test("covers 180 days ending today and nothing after", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const row = db.prepare("select min(date) as lo, max(date) as hi from usage").get() as { lo: string; hi: string };
    expect(row.hi <= TODAY).toBe(true);
    expect(row.lo >= "2026-05-23").toBe(true);
    expect(row.lo <= "2026-05-30").toBe(true);
  });

  test("weekends are quieter than weekdays", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const s = getStats(db, ensureSingleTeam(db), { from: FROM, to: TODAY });
    const avg = (weekend: boolean) => {
      const days = s.daily.filter((d) => [0, 6].includes(new Date(`${d.date}T00:00:00Z`).getUTCDay()) === weekend);
      return days.reduce((n, d) => n + Object.values(d.byAgent).reduce((x, y) => x + y, 0), 0) / days.length;
    };
    expect(avg(true)).toBeLessThan(avg(false) / 2);
  });

  test("every stored row is a valid usage record", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const rows = db
      .prepare(
        "select date, agent, model, input, output, cache_create as cacheCreate, cache_read as cacheRead, total, cost_usd as costUsd, unpriced from usage",
      )
      .all() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(500);
    const records = rows.map((r) => ({ ...r, unpriced: r.unpriced === 1 }));
    for (let i = 0; i < records.length; i += 1000) {
      const res = validateBatch({ records: records.slice(i, i + 1000) });
      expect(res.ok, `rows ${i}..`).toBe(true);
    }
  });

  test("about 12% of member-days are empty", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const active = (db.prepare("select count(*) as n from (select distinct member_id, date from usage)").get() as { n: number }).n;
    const empty = 6 * 180 - active;
    expect(empty / (6 * 180)).toBeGreaterThan(0.06);
    expect(empty / (6 * 180)).toBeLessThan(0.18);
  });

  test("uses no real time: the seeded sync time follows the given day", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const rows = db.prepare("select distinct last_sync_at as t from machines").all() as { t: string }[];
    expect(rows.every((r) => r.t.startsWith(TODAY))).toBe(true);
  });

  test("includes Codex accounts and plans", () => {
    const db = openDb(":memory:");
    seedDemo(db, ensureSingleTeam(db), TODAY);
    const s = getStats(db, ensureSingleTeam(db), { from: FROM, to: TODAY });
    expect(s.available.accounts.some((a) => a.key.startsWith("chatgpt:"))).toBe(true);
    expect(s.available.accounts.some((a) => a.key === "other")).toBe(true);
    expect(s.available.plans.some((p) => p.key.startsWith("codex:"))).toBe(true);
    expect(s.available.plans.some((p) => p.key.startsWith("claude:"))).toBe(true);
  });
});

test("the demo data goes into the given team only, and leaves other teams' machines alone", () => {
  const db = openDb(":memory:");
  const A = createTeam(db, "A");
  const B = createTeam(db, "B");
  forTeam(db, A).registerMachine({ name: "Ann", email: "ann@x.com", machineId: "a".repeat(32), machineLabel: "mbp" });
  seedDemo(db, B, TODAY);
  expect(forTeam(db, A).listMembers().map((m) => m.machines[0]!.lastSyncAt)).toEqual([null]);
  const demo = forTeam(db, B).listMembers();
  expect(demo.length).toBeGreaterThan(0);
  for (const m of demo) for (const x of m.machines) expect(x.lastSyncAt).toBe(`${TODAY}T12:00:00.000Z`);
});
