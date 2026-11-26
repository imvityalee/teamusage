import type { UsageRecord } from "@teamusage/shared";
import { beforeEach, expect, test } from "vitest";
import { MID, MID2 } from "./app.fixture.js";
import { openDb, type Db } from "./db.js";
import { forTeam } from "./team-data.js";
import { rec, reg } from "./team-data.fixture.js";
import { createTeam } from "./teams.js";
import { usageCounts } from "./usage-counts.js";

const D1 = "2026-11-25";
const D2 = "2026-11-26";
const MID3 = "c".repeat(32);
const BOB = "bob@example.com";

let db: Db;
let A: number;
let B: number;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
});

const on = (teamId: number, day: string) => forTeam(db, teamId, () => `${day}T12:00:00.000Z`);
const held = (teamId: number) => (db.prepare("select count(*) as n from usage where team_id = ?").get(teamId) as { n: number }).n;
/** `n` records with models `m<from>` onward. */
const rows = (n: number, from = 0): UsageRecord[] => Array.from({ length: n }, (_, i) => rec({ model: `m${from + i}` }));

/** Registers `machineId` for `email` in team `teamId` and uploads `records` from it on `day`. */
function upload(teamId: number, day: string, machineId: string, records: UsageRecord[], email = "a@example.com"): void {
  const team = on(teamId, day);
  team.upsertUsage({ memberId: team.registerMachine(reg(machineId, { email })).memberId, machineId }, records);
}
/** 3 rows on D1 and 2 new rows on D2 from MID. */
function uploadOnTwoDays(teamId: number): void {
  upload(teamId, D1, MID, rows(3));
  upload(teamId, D2, MID, rows(2, 3));
}
/** Member A with MID (3 rows) and MID2 (2 rows), member Bob with MID3 (4 rows), all on D1. */
function uploadFromThreeMachines(teamId: number): void {
  upload(teamId, D1, MID, rows(3));
  upload(teamId, D1, MID2, rows(2));
  upload(teamId, D1, MID3, rows(4), BOB);
}
/** An upload on D1 from MID3, which is not registered in team `teamId`. */
function uploadFromUnregistered(teamId: number): () => void {
  const team = on(teamId, D1);
  const { memberId } = team.registerMachine(reg(MID2));
  return () => team.upsertUsage({ memberId, machineId: MID3 }, rows(2));
}

test("a team that stored nothing counts zero", () => expect(usageCounts(db, A, "2026-11-25")).toEqual({ rows: 0, addedToday: 0 }));
test("new rows are counted once; sending them again or raising their totals adds nothing", () => {
  const who = { memberId: on(A, D1).registerMachine(reg(MID)).memberId, machineId: MID };
  on(A, D1).upsertUsage(who, rows(3));
  on(A, D1).upsertUsage(who, rows(3));
  on(A, D1).upsertUsage(who, rows(3).map((r) => ({ ...r, input: 99, total: 99 })));
  on(A, D1).upsertUsage(who, [rec({ model: "twice" }), rec({ model: "twice", input: 20, total: 20 })]);
  expect(usageCounts(db, A, D1)).toEqual({ rows: 4, addedToday: 4 });
});
test("a new UTC day starts the day's count again and keeps the total", () => {
  uploadOnTwoDays(A);
  expect(usageCounts(db, A, D2)).toEqual({ rows: 5, addedToday: 2 });
});
test("removing a machine or a member takes exactly its rows off the total and nothing off the day", () => {
  uploadFromThreeMachines(A);
  expect(usageCounts(db, A, D1)).toEqual({ rows: 9, addedToday: 9 });
  on(A, D1).removeMachine(MID2);
  expect(usageCounts(db, A, D1)).toEqual({ rows: 7, addedToday: 9 });
  on(A, D1).removeMember(BOB);
  expect(usageCounts(db, A, D1)).toEqual({ rows: 3, addedToday: 9 });
});
test("the same machine id in two teams is counted in each team", () => {
  upload(A, D1, MID, rows(3));
  upload(B, D1, MID, rows(1));
  expect(usageCounts(db, A, D1)).toEqual({ rows: 3, addedToday: 3 });
  expect(usageCounts(db, B, D1)).toEqual({ rows: 1, addedToday: 1 });
});
test("an upload that fails counts nothing", () => {
  expect(uploadFromUnregistered(A)).toThrow();
  expect(usageCounts(db, A, D1)).toEqual({ rows: 0, addedToday: 0 });
});
test("after any of this the total is the number of rows the team holds", () => {
  upload(A, D1, MID, rows(3));
  upload(A, D1, MID, rows(3).map((r) => ({ ...r, input: 99, total: 99 })));
  uploadOnTwoDays(A);
  uploadFromThreeMachines(A);
  on(A, D2).removeMachine(MID2);
  on(A, D2).removeMember(BOB);
  upload(B, D1, MID, rows(1));
  expect(uploadFromUnregistered(B)).toThrow();
  for (const team of [A, B]) expect(usageCounts(db, team, D2).rows).toBe(held(team));
});
test("deleting a team removes its count row", () => {
  upload(A, D1, MID, rows(3));
  upload(B, D1, MID, rows(1));
  const countRow = (teamId: number) => db.prepare("select * from usage_counts where team_id = ?").get(teamId);
  const before = countRow(B);
  db.prepare("delete from teams where id = ?").run(A);
  expect(countRow(A)).toBeUndefined();
  expect(countRow(B)).toEqual(before);
});
