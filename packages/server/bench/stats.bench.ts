import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openDb } from "../src/db.js";
import { getStats } from "../src/stats.js";
import { forTeam } from "../src/team-data.js";
import { createTeam } from "../src/teams.js";
import { seedLargeTeam } from "./seed.js";

const RUNS = 20;

function timeRuns(run: () => unknown): { median: number; slowest: number } {
  const ms = Array.from({ length: RUNS }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { median: ms[RUNS / 2]!, slowest: ms[RUNS - 1]! };
}

const line = (label: string, t: { median: number; slowest: number }) =>
  `${label}: median ${t.median.toFixed(1)} ms, slowest ${t.slowest.toFixed(1)} ms`;

test("the seed is sized as asked", () => {
  const db = openDb(":memory:");
  const team = createTeam(db, "Small");
  expect(seedLargeTeam(db, team, { members: 10, days: 3, today: "2026-11-24" })).toEqual({ machines: 12, rows: 72 });
  expect(getStats(db, team, { from: "2026-11-22", to: "2026-11-24" }).totals.memberCount).toBe(10);
});

test("timing: 500 members, 180 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamusage-bench-"));
  try {
    const db = openDb(join(dir, "bench.db"));
    db.pragma("journal_mode = WAL");
    const team = createTeam(db, "Large");
    expect(seedLargeTeam(db, team, { members: 500, days: 180, today: "2026-11-24" })).toEqual({
      machines: 600,
      rows: 216000,
    });
    const memberId = forTeam(db, team).listMembers().find((m) => m.email === "member1@example.com")!.id;
    const range = { from: "2026-05-29", to: "2026-11-24" };

    let memberCount = 0;
    const teamView = timeRuns(() => (memberCount = getStats(db, team, range).totals.memberCount));
    const memberView = timeRuns(() => getStats(db, team, { ...range, memberId }));

    console.log(line("team view", teamView));
    console.log(line("member view", memberView));
    expect(memberCount).toBe(500);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
