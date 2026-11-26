import type { UsageRecord } from "@teamusage/shared";
import { beforeEach, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { authenticate, forTeam } from "./team-data.js";
import { reg, rows } from "./team-data.fixture.js";
import { HOSTED_CAPS, LimitError, type TeamLimits } from "./team-limits.js";
import { createTeam } from "./teams.js";
import { usageCounts } from "./usage-counts.js";

const D1 = "2026-11-25";
const D2 = "2026-11-26";
const [M1, M2, M3, M4, M5] = ["a", "b", "c", "d", "e"].map((c) => c.repeat(32)) as [string, string, string, string, string];

let db: Db;
let A: number;
let B: number;
let low: boolean;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
  low = false;
});

const limits = (over: Partial<TeamLimits> = {}): TeamLimits => ({
  membersPerTeam: 2, machinesPerMember: 2, rowsPerMachine: 5, rowsPerTeam: 100, rowsAddedPerDay: 100, storageLow: () => low, ...over,
});
const team = (teamId: number, l = limits(), day = D1) => forTeam(db, teamId, { clock: () => `${day}T12:00:00.000Z`, limits: l });
const limitOf = (run: () => unknown): string => {
  try {
    run();
    return "accepted";
  } catch (e) {
    return e instanceof LimitError ? e.limit : `threw ${String(e)}`;
  }
};
const everything = () => ["teams", "members", "machines", "usage", "usage_counts"].map((t) => db.prepare(`select * from ${t} order by rowid`).all());
const raised = (r: UsageRecord) => ({ ...r, input: r.input + 1, total: r.total + 1 });

test("the beta's limits are the agreed values", () => {
  expect(HOSTED_CAPS).toEqual({ membersPerTeam: 2000, machinesPerMember: 10, rowsPerMachine: 20000, rowsPerTeam: 1000000, rowsAddedPerDay: 300000 });
});

test("a member beyond the cap is refused and leaves nothing; members already there still add a machine", () => {
  team(A).registerMachine(reg(M1, { email: "a@example.com" }));
  team(A).registerMachine(reg(M2, { email: "b@example.com" }));
  const before = everything();
  expect(limitOf(() => team(A).registerMachine(reg(M3, { email: "c@example.com" })))).toBe("members");
  expect(everything()).toEqual(before);
  expect(limitOf(() => team(A).registerMachine(reg(M3, { email: "a@example.com" })))).toBe("accepted");
});

test("a machine beyond the member's cap is refused and does not rename the member", () => {
  team(A).registerMachine(reg(M1, { name: "Ann" }));
  team(A).registerMachine(reg(M2, { name: "Ann" }));
  const before = everything();
  expect(limitOf(() => team(A).registerMachine(reg(M3, { name: "Renamed" })))).toBe("machines");
  expect(everything()).toEqual(before);
});

test("setting a machine up again works in a full team and on a nearly full disk, and gives a new token", () => {
  const first = team(A).registerMachine(reg(M1));
  team(A).registerMachine(reg(M2, { email: "b@example.com" }));
  low = true;
  const again = team(A).registerMachine(reg(M1, { machineLabel: "new label" }));
  expect(again.token).not.toBe(first.token);
  expect(authenticate(db, again.token)).toEqual({ teamId: A, memberId: first.memberId, machineId: M1 });
  expect(authenticate(db, first.token)).toBeNull();
});

test("a machine holds its cap exactly; one row more refuses the whole request; its rows can still be updated", () => {
  const who = { memberId: team(A).registerMachine(reg(M1)).memberId, machineId: M1 };
  expect(team(A).upsertUsage(who, rows(5))).toEqual({ stored: 5, kept: 0 });
  const before = everything();
  expect(limitOf(() => team(A).upsertUsage(who, [...rows(5).map(raised), ...rows(1, 5)]))).toBe("machine-rows");
  expect(everything()).toEqual(before); // not even the five updates, not last_sync_at
  expect(team(A).upsertUsage(who, rows(5).map(raised))).toEqual({ stored: 5, kept: 0 });
});

test("a team holds its cap exactly; one row more changes nothing; rows of either machine can still be updated", () => {
  const l = limits({ rowsPerTeam: 7 });
  const memberId = team(A, l).registerMachine(reg(M1)).memberId;
  team(A, l).registerMachine(reg(M2));
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M1 }, rows(5)))).toBe("accepted");
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M2 }, rows(2)))).toBe("accepted");
  const before = everything();
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M2 }, rows(1, 2)))).toBe("team-rows");
  expect(everything()).toEqual(before);
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M1 }, rows(5).map(raised)))).toBe("accepted");
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M2 }, rows(2).map(raised)))).toBe("accepted");
});

test("a team adds its day's allowance exactly; the next new row is accepted on the next UTC day", () => {
  const l = limits({ rowsAddedPerDay: 6, rowsPerMachine: 100 });
  const who = { memberId: team(A, l).registerMachine(reg(M1)).memberId, machineId: M1 };
  expect(limitOf(() => team(A, l).upsertUsage(who, rows(5)))).toBe("accepted");
  expect(limitOf(() => team(A, l).upsertUsage(who, rows(1, 5)))).toBe("accepted");
  expect(limitOf(() => team(A, l).upsertUsage(who, rows(1, 6)))).toBe("team-rows-per-day");
  expect(usageCounts(db, A, D1)).toEqual({ rows: 6, addedToday: 6 });
  expect(limitOf(() => team(A, l, D2).upsertUsage(who, rows(1, 6)))).toBe("accepted");
});

test("removing a machine makes room in the team again; the day's allowance is not given back", () => {
  const l = limits({ rowsPerTeam: 7, rowsAddedPerDay: 8 });
  const memberId = team(A, l).registerMachine(reg(M1)).memberId;
  team(A, l).registerMachine(reg(M2));
  team(A, l).upsertUsage({ memberId, machineId: M1 }, rows(5));
  team(A, l).upsertUsage({ memberId, machineId: M2 }, rows(2));
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M2 }, rows(1, 2)))).toBe("team-rows");
  team(A, l).removeMachine(M2);
  team(A, l).registerMachine(reg(M3));
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M3 }, rows(1)))).toBe("accepted");
  expect(usageCounts(db, A, D1)).toEqual({ rows: 6, addedToday: 8 });
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M3 }, rows(1, 1)))).toBe("team-rows-per-day");
});

test("on a nearly full disk nothing that adds is accepted and nothing changes; an upload that only updates is", () => {
  const memberId = team(A).registerMachine(reg(M1)).memberId;
  team(A).upsertUsage({ memberId, machineId: M1 }, rows(2));
  low = true;
  const before = everything();
  expect(limitOf(() => team(A).registerMachine(reg(M2, { email: "b@example.com" })))).toBe("storage");
  expect(limitOf(() => team(A).registerMachine(reg(M2)))).toBe("storage");
  expect(limitOf(() => team(A).upsertUsage({ memberId, machineId: M1 }, rows(1, 2)))).toBe("storage");
  expect(everything()).toEqual(before);
  expect(limitOf(() => team(A).upsertUsage({ memberId, machineId: M1 }, rows(2).map(raised)))).toBe("accepted");
});

test("the limit named is the disk before a cap, the machine's cap before the team's, the member cap before the machine", () => {
  const memberId = team(A).registerMachine(reg(M1)).memberId;
  team(A).upsertUsage({ memberId, machineId: M1 }, rows(5));
  low = true;
  expect(limitOf(() => team(A).upsertUsage({ memberId, machineId: M1 }, rows(1, 5)))).toBe("storage");
  low = false;
  const inB = team(B).registerMachine(reg(M1)).memberId;
  expect(limitOf(() => team(B, limits({ rowsPerTeam: 5 })).upsertUsage({ memberId: inB, machineId: M1 }, rows(6)))).toBe("machine-rows");
  team(A).registerMachine(reg(M2, { email: "b@example.com" }));
  expect(limitOf(() => team(A).registerMachine(reg(M1, { email: "c@example.com" })))).toBe("members");
});

test("limits are per team", () => {
  const l = limits({ rowsAddedPerDay: 5 });
  const memberId = team(A, l).registerMachine(reg(M1)).memberId;
  team(A, l).registerMachine(reg(M2, { email: "b@example.com" }));
  team(A, l).upsertUsage({ memberId, machineId: M1 }, rows(5));
  expect(limitOf(() => team(A, l).registerMachine(reg(M3, { email: "c@example.com" })))).toBe("members");
  expect(limitOf(() => team(A, l).upsertUsage({ memberId, machineId: M1 }, rows(1, 5)))).toBe("machine-rows");
  const inB = team(B, l).registerMachine(reg(M1)).memberId;
  expect(limitOf(() => team(B, l).upsertUsage({ memberId: inB, machineId: M1 }, rows(5)))).toBe("accepted");
});

test("without limits a team takes any number of members, machines and rows, whatever the disk", () => {
  low = true;
  const free = forTeam(db, A);
  const { memberId } = free.registerMachine(reg(M1));
  free.registerMachine(reg(M2));
  free.registerMachine(reg(M3));
  free.registerMachine(reg(M4, { email: "b@example.com" }));
  free.registerMachine(reg(M5, { email: "c@example.com" }));
  expect(free.upsertUsage({ memberId, machineId: M1 }, rows(6))).toEqual({ stored: 6, kept: 0 });
  expect(free.listMembers().map((m) => m.machines.length)).toEqual([3, 1, 1]);
});
