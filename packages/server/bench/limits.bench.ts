import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageRecord } from "@teamusage/shared";
import { expect, test } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { STATS_BOUNDS } from "../src/stats-bounds.js";
import { getStats } from "../src/stats.js";
import { forTeam } from "../src/team-data.js";
import { HOSTED_CAPS } from "../src/team-limits.js";
import { createTeam } from "../src/teams.js";
import { seedLargeTeam } from "./seed.js";
import { line, timeRuns } from "./timing.js";

const TODAY = "2026-11-24";
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;
const MODEL_CHARS = 128;

/** The `days` dates ending at TODAY, newest first. */
const lastDays = (days: number) =>
  Array.from({ length: days }, (_, k) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - k * DAY_MS).toISOString().slice(0, 10));

/** A usage record of `date`, `agent` and `model` with a total above any the seed stored, so a known one is updated. */
const usage = (date: string, agent: string, model: string): UsageRecord => ({
  date, agent, model, input: 900_000, output: 100_000, cacheCreate: 0, cacheRead: 0, total: 1_000_000, costUsd: 1, unpriced: false,
});

/** The machine of the large team's member `n`, as the limits see it: its member and its id. */
function machineOf(db: Db, team: number, n: number): { memberId: number; machineId: string } {
  const member = forTeam(db, team).listMembers().find((m) => m.email === `member${n}@example.com`)!;
  return { memberId: member.id, machineId: member.machines[0]!.id };
}

/** Times uploads to the 500-member, 180-day team under the hosted caps; returns the two lines. */
function timeUploads(db: Db): string[] {
  const team = createTeam(db, "Large");
  seedLargeTeam(db, team, { members: 500, days: 180, today: TODAY });
  const data = forTeam(db, team, { clock: () => "2026-11-25T12:00:00.000Z", limits: { ...HOSTED_CAPS, storageLow: () => false } });

  const resender = machineOf(db, team, 1);
  const known = lastDays(24).flatMap((date) => [usage(date, "claude", "claude-model"), usage(date, "codex", "codex-model")]);
  let run = 0;
  const mixed = timeRuns(() => {
    run++;
    const fresh = [usage(TODAY, "claude", `new-${run}-a`), usage(TODAY, "claude", `new-${run}-b`)];
    expect(data.upsertUsage(resender, [...known, ...fresh])).toEqual({ stored: 50, kept: 0 });
  });

  const firstSync = machineOf(db, team, 2);
  const bulk = timeRuns(() => {
    run++;
    const records = Array.from({ length: 500 }, (_, i) => usage(TODAY, "claude", `bulk-${run}-${i}`));
    expect(data.upsertUsage(firstSync, records)).toEqual({ stored: 500, kept: 0 });
  });
  return [line("upload of 50 records (48 known, 2 new)", mixed), line("upload of 500 new records", bulk)];
}

/** Times the team view of a team holding as many day groups over as many 128-character model names as the bounds allow. */
function timeWorstView(db: Db): string {
  const team = createTeam(db, "Widest");
  const data = forTeam(db, team);
  const machineId = "f".repeat(32);
  const { memberId } = data.registerMachine({ name: "Wide", email: "wide@example.com", machineId, machineLabel: "wide" });
  const machine = { memberId, machineId };
  const days = lastDays(STATS_BOUNDS.dayGroups / STATS_BOUNDS.models);
  const model = (i: number) => `model-${i}-`.padEnd(MODEL_CHARS, "x");
  const records = days.flatMap((date) => Array.from({ length: STATS_BOUNDS.models }, (_, i) => usage(date, "claude", model(i))));
  for (let from = 0; from < records.length; from += BATCH_SIZE) data.upsertUsage(machine, records.slice(from, from + BATCH_SIZE));

  const range = { from: days[days.length - 1]!, to: TODAY };
  let bytes = 0;
  const view = timeRuns(() => {
    const stats = getStats(db, team, range);
    expect(stats.models).toHaveLength(STATS_BOUNDS.models);
    bytes = Buffer.byteLength(JSON.stringify(stats));
  });
  return `worst team view the bounds allow: ${view.median.toFixed(1)} ms, answer ${(bytes / 1e6).toFixed(1)} MB`;
}

test("timing: uploads under the hosted caps, and the widest team view the bounds allow", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamusage-bench-"));
  try {
    const db = openDb(join(dir, "bench.db"));
    for (const printed of [...timeUploads(db), timeWorstView(db)]) console.log(printed);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
