import Database from "better-sqlite3";
import { addDays } from "@teamusage/shared";
import { beforeEach, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { migrate } from "./migrate.js";
import { getStats } from "./stats.js";
import { forTeam } from "./team-data.js";
import { reg, rec, rows, teamTables } from "./team-data.fixture.js";
import { LimitError } from "./team-limits.js";
import { dropExpiredUsage, EXPIRED_ROWS_PER_UPLOAD, oldestDateKept, USAGE_DAYS_KEPT } from "./team-retention.js";
import { createTeam } from "./teams.js";
import { usageCounts } from "./usage-counts.js";

const TODAY = "2026-11-26";
const EDGE = "2024-11-26";
const PAST = "2024-11-25";
const M1 = "a".repeat(32);
const noonOf = (day: string) => () => `${day}T12:00:00.000Z`;

let db: Db;
let A: number;
let B: number;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
});

const team = (teamId: number, day = TODAY, daysKept = 730) => forTeam(db, teamId, { clock: noonOf(day), daysKept });
/** A team's data that keeps every row, to store rows that have already expired. */
const keepsAll = (teamId: number) => forTeam(db, teamId, { clock: noonOf(TODAY) });
const join = (teamId: number) => ({ memberId: keepsAll(teamId).registerMachine(reg(M1)).memberId, machineId: M1 });
const datesOf = (teamId: number) => db.prepare("select date from usage where team_id = ? order by date").pluck().all(teamId);

test("the agreed values", () => expect([USAGE_DAYS_KEPT, EXPIRED_ROWS_PER_UPLOAD]).toEqual([730, 500]));
test("the oldest date kept is 730 days before the clock's UTC date", () => {
  expect(oldestDateKept("2026-11-26T00:00:00.000Z", 730)).toBe("2024-11-26");
  expect(oldestDateKept("2026-11-26T23:59:59.999Z", 730)).toBe("2024-11-26");
  expect(oldestDateKept("2028-02-29T12:00:00.000Z", 730)).toBe("2026-03-01");
});
test("a batch that mixes old and current records stores the current ones and counts the old as kept", () => {
  const who = { memberId: team(A).registerMachine(reg(M1)).memberId, machineId: M1 };
  expect(team(A).upsertUsage(who, [rec({ date: PAST }), rec({ date: EDGE }), rec({ date: TODAY })])).toEqual({ stored: 2, kept: 1 });
  expect(datesOf(A)).toEqual([EDGE, TODAY]);
  expect(usageCounts(db, A, TODAY)).toEqual({ rows: 2, addedToday: 2 });
});
test("a row at the edge is kept today and dropped tomorrow, and the count follows", () => {
  const [whoA, whoB] = [join(A), join(B)];
  team(A).upsertUsage(whoA, [rec({ date: EDGE }), rec({ date: TODAY })]);
  team(B).upsertUsage(whoB, [rec({ date: EDGE }), rec({ date: TODAY })]);
  const tomorrow = addDays(TODAY, 1);
  expect(team(A, tomorrow).upsertUsage(whoA, [rec({ date: TODAY, input: 11, total: 11 })])).toEqual({ stored: 1, kept: 0 });
  expect(datesOf(A)).toEqual([TODAY]);
  expect(usageCounts(db, A, tomorrow).rows).toBe(1);
  expect(datesOf(B)).toEqual([EDGE, TODAY]);
  expect(usageCounts(db, B, tomorrow).rows).toBe(2);
});

test("at most `most` rows are dropped at a time, oldest dates first, and the rest at the following drops", () => {
  const who = join(A);
  const expired = Array.from({ length: 7 }, (_, i) => addDays(PAST, -i)); // newest first, so rowids run against dates
  for (const date of [...expired, EDGE]) keepsAll(A).upsertUsage(who, [rec({ date })]);
  expect(dropExpiredUsage(db, A, EDGE, 3)).toBe(3);
  expect(datesOf(A)).toEqual([...expired.slice(0, 4).reverse(), EDGE]);
  expect([3, 3, 3].map((most) => dropExpiredUsage(db, A, EDGE, most))).toEqual([3, 1, 0]);
  expect(datesOf(A)).toEqual([EDGE]);
  expect(usageCounts(db, A, TODAY).rows).toBe(1);
});
test("an old record is skipped and counted as kept even while its row waits to be dropped", () => {
  const who = join(A);
  keepsAll(A).upsertUsage(who, rows(EXPIRED_ROWS_PER_UPLOAD).map((r) => ({ ...r, date: addDays(PAST, -1) })));
  keepsAll(A).upsertUsage(who, [rec({ date: PAST })]);
  const raised = rec({ date: PAST, input: 99, total: 99 });
  expect(team(A).upsertUsage(who, [raised])).toEqual({ stored: 0, kept: 1 });
  expect(db.prepare("select date, total from usage where team_id = ?").all(A)).toEqual([{ date: PAST, total: 10 }]);
  expect(usageCounts(db, A, TODAY).rows).toBe(1);
  expect(team(A).upsertUsage(who, [raised])).toEqual({ stored: 0, kept: 1 });
  expect(datesOf(A)).toEqual([]);
  expect(usageCounts(db, A, TODAY).rows).toBe(0);
});
test("an upload that a cap refuses still drops expired rows and stores nothing else", () => {
  const who = join(A);
  keepsAll(A).upsertUsage(who, [rec({ date: addDays(PAST, -1) }), rec({ date: PAST }), rec({ date: TODAY })]);
  const before = teamTables(db) as Record<string, unknown>[][];
  // The machine holds one row once its two expired rows are dropped; a new row would be its second.
  const limits = { membersPerTeam: 10, machinesPerMember: 11, rowsPerMachine: 1, rowsPerTeam: 12, rowsAddedPerDay: 13, storageLow: () => false };
  const capped = forTeam(db, A, { clock: noonOf(TODAY), limits, daysKept: 730 });
  expect(() => capped.upsertUsage(who, [rec({ date: TODAY, model: "new" })])).toThrow(new LimitError("machine-rows"));
  const [teams, members, machines, usage, counts] = before;
  expect(teamTables(db)).toEqual([
    teams,
    members,
    machines,
    usage!.filter((r) => r.date === TODAY),
    counts!.map((c) => (c.team_id === A ? { ...c, rows: (c.rows as number) - 2 } : c)),
  ]);
});
test("without daysKept nothing is skipped and nothing is dropped, however old", () => {
  const who = join(A);
  expect(keepsAll(A).upsertUsage(who, [rec({ date: "2024-01-01" })])).toEqual({ stored: 1, kept: 0 });
  keepsAll(A).upsertUsage(who, [rec({ date: TODAY })]);
  expect(datesOf(A)).toEqual(["2024-01-01", TODAY]);
});
test("the statement that finds expired rows reads usage_by_day", () => {
  const seen: string[] = [];
  const traced = new Database(":memory:", { verbose: (sql) => seen.push(String(sql)) });
  migrate(traced);
  dropExpiredUsage(traced, createTeam(traced, "A"), EDGE);
  const finds = seen.filter((sql) => /from usage where team_id/.test(sql));
  expect(finds).toHaveLength(1);
  const plan = (traced.prepare(`explain query plan ${finds[0]}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  expect(plan).toContain("usage_by_day (team_id=? AND date<?)");
  expect(plan).not.toContain("TEMP B-TREE");
});
test("a browser one day behind UTC still sees the row at the edge in its widest range", () => {
  const who = join(A);
  team(A).upsertUsage(who, [rec({ date: EDGE, input: 7, total: 7 })]);
  team(A).upsertUsage(who, [rec({ date: TODAY })]);
  expect(getStats(db, A, { from: EDGE, to: addDays(TODAY, -1) }).totals.tokens).toBe(7);
});
