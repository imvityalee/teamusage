import type { UsageRecord } from "@teamusage/shared";
import type { Db } from "../src/db.js";
import { forTeam } from "../src/team-data.js";

const BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type SeedOptions = { members: number; days: number; today: string };

/** The `days` dates ending at `today`, oldest first. */
function datesEndingAt(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days }, (_, k) => new Date(end - (days - 1 - k) * DAY_MS).toISOString().slice(0, 10));
}

/** Two rows for one day; the totals depend on the member, the machine and the day, so members differ. */
function dayRecords(date: string, memberIndex: number, machineIndex: number, dayIndex: number): UsageRecord[] {
  const base = 1000 + memberIndex * 37 + machineIndex * 11 + dayIndex * 3;
  const row = (agent: string, model: string, scale: number): UsageRecord => {
    const input = base * scale;
    const output = Math.floor(input / 4);
    return {
      date,
      agent,
      model,
      input,
      output,
      cacheCreate: 0,
      cacheRead: 0,
      total: input + output,
      costUsd: (input + output) / 100000,
      unpriced: false,
    };
  };
  return [row("claude", "claude-model", 3), row("codex", "codex-model", 2)];
}

/** Machine ids are 32 lowercase hex characters; this one encodes the member and the machine's position. */
const machineId = (memberIndex: number, position: number) =>
  `${memberIndex.toString(16).padStart(16, "0")}${position.toString(16).padStart(16, "0")}`;

/** Fills team `teamId` with the same usage data on every run: it is derived from the member and day indexes and from `today`, never from the real clock. */
export function seedLargeTeam(db: Db, teamId: number, o: SeedOptions): { machines: number; rows: number } {
  const dates = datesEndingAt(o.today, o.days);
  const team = forTeam(db, teamId, { clock: () => `${o.today}T00:00:00.000Z` });
  let machines = 0;
  let rows = 0;
  for (let i = 0; i < o.members; i++) {
    const machineCount = i % 5 === 0 ? 2 : 1;
    for (let position = 0; position < machineCount; position++) {
      const id = machineId(i, position);
      const { memberId } = team.registerMachine({
        name: `Member ${i}`,
        email: `member${i}@example.com`,
        machineId: id,
        machineLabel: `machine-${position}`,
      });
      machines++;
      const records = dates.flatMap((date, d) => dayRecords(date, i, position, d));
      for (let from = 0; from < records.length; from += BATCH_SIZE) {
        rows += team.upsertUsage({ memberId, machineId: id }, records.slice(from, from + BATCH_SIZE)).stored;
      }
    }
  }
  return { machines, rows };
}
