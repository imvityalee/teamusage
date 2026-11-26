import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountLabel, Stats, UsageRecord } from "@teamusage/shared";
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
const ORG_CHARS = 100;
const ORGS = 100;
const AGENT = "claude";

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

/** A team account whose organisation follows from model `i`, so the labels add no day group of their own. */
const accountOf = (i: number): AccountLabel => ({ kind: "team", org: `org-${i % ORGS}-`.padEnd(ORG_CHARS, "x") });

/**
 * A team holding as many day groups over as many 128-character model names as the bounds allow, each row of one agent
 * and labelled with one of 100 organisations of 100 characters; returns the team and the range that holds its rows.
 */
function seedWidestTeam(db: Db): { team: number; range: { from: string; to: string } } {
  const team = createTeam(db, "Widest");
  const data = forTeam(db, team);
  const machineId = "f".repeat(32);
  const { memberId } = data.registerMachine({ name: "Wide", email: "wide@example.com", machineId, machineLabel: "wide" });
  const machine = { memberId, machineId };
  const days = lastDays(STATS_BOUNDS.dayGroups / STATS_BOUNDS.models);
  const model = (i: number) => `model-${i}-`.padEnd(MODEL_CHARS, "x");
  const records = days.flatMap((date) =>
    Array.from({ length: STATS_BOUNDS.models }, (_, i) => ({ ...usage(date, AGENT, model(i)), account: accountOf(i) })),
  );
  for (let from = 0; from < records.length; from += BATCH_SIZE) data.upsertUsage(machine, records.slice(from, from + BATCH_SIZE));
  return { team, range: { from: days[days.length - 1]!, to: TODAY } };
}

/** A stats request timed, with the size of its answer and, best effort, how much one call grows the heap. */
function measureView(view: () => Stats): { median: string; answerMb: string; heapMb: string } {
  const timing = timeRuns(() => expect(view().models).toHaveLength(STATS_BOUNDS.models));
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const stats = view();
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
  const answerMb = megabytes(Buffer.byteLength(JSON.stringify(stats)));
  return { median: timing.median.toFixed(1), answerMb, heapMb: megabytes(heapGrowth) };
}

/**
 * Times the widest team's view without a filter, and with a filter that matches every row: the worst the bounds allow,
 * since a filtered request also reads the unfiltered by-day pass and holds both.
 */
function timeWidestViews(db: Db): string[] {
  const { team, range } = seedWidestTeam(db);
  const all = measureView(() => getStats(db, team, range));
  const worst = measureView(() => getStats(db, team, { ...range, agents: [AGENT] }));
  return [
    `the same team view without a filter: ${all.median} ms, answer ${all.answerMb} MB`,
    `worst team view the bounds allow: ${worst.median} ms, answer ${worst.answerMb} MB, heap about ${worst.heapMb} MB`,
  ];
}

test("timing: uploads under the hosted caps, and the widest team views the bounds allow", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamusage-bench-"));
  try {
    const db = openDb(join(dir, "bench.db"));
    for (const printed of [...timeUploads(db), ...timeWidestViews(db)]) console.log(printed);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
