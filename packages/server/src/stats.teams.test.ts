import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { getStats } from "./stats.js";
import { M1, Q, rec } from "./stats.fixture.js";
import { forTeam } from "./team-data.js";
import { createTeam } from "./teams.js";

test("a team's stats hold only its own members and usage", () => {
  const db = openDb(":memory:");
  const A = createTeam(db, "A");
  const B = createTeam(db, "B");
  const ra = forTeam(db, A).registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  const rb = forTeam(db, B).registerMachine({ name: "Bob", email: "bob@x.com", machineId: M1, machineLabel: "box" });
  forTeam(db, A).upsertUsage({ memberId: ra.memberId, machineId: M1 }, [rec("2026-11-02", "claude", "m1", 10)]);
  forTeam(db, B).upsertUsage({ memberId: rb.memberId, machineId: M1 }, [rec("2026-11-02", "codex", "m9", 700)]);
  const s = getStats(db, A, Q);
  expect(s.totals).toMatchObject({ tokens: 10, memberCount: 1, activeMembers: 1 });
  expect(s.members.map((m) => m.email)).toEqual(["ann@x.com"]);
  expect(s.available.agents).toEqual(["claude"]);
  expect(s.models.map((m) => m.model)).toEqual(["m1"]);
  expect(getStats(db, A, { ...Q, memberId: rb.memberId }).members).toEqual([]);
});

/** Every statement getStats runs that reads `usage`, with the index SQLite chose for it. */
function usagePlans(memberId?: number): string[] {
  const seen: string[] = [];
  const db = new Database(":memory:", { verbose: (sql) => seen.push(String(sql)) });
  migrate(db);
  const team = createTeam(db, "A");
  seen.length = 0;
  getStats(db, team, { ...Q, ...(memberId === undefined ? {} : { memberId }) });
  return seen
    .filter((sql) => /from usage u/.test(sql))
    .map((sql) => (db.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | "));
}
test("the team view reads usage through the team and date index", () => {
  const plans = usagePlans();
  expect(plans.length).toBeGreaterThanOrEqual(6);
  for (const p of plans) expect(p).toContain("usage_team_date");
});
test("a member's view reads usage through the team, member and date index", () => {
  const plans = usagePlans(1);
  expect(plans.length).toBeGreaterThanOrEqual(6);
  for (const p of plans) expect(p).toContain("usage_team_member_date");
});
