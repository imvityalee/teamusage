import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { dashboardLinkToken, hostedTeam, machineIdOf } from "./hosted.fixture.js";
import { rowsOf } from "./hosted.two-teams.fixture.js";
import { everythingOf, manageWorld, PEOPLE, T0, type ManageWorld } from "./manage.fixture.js";
import { migrate } from "./migrate.js";
import { createMemberSession, findSession } from "./sessions.js";
import { forTeam, type TeamData } from "./team-data.js";
import { rows } from "./team-data.fixture.js";
import { REMOVAL_SLICE_ROWS } from "./team-removal.js";
import { usageCounts } from "./usage-counts.js";

const TODAY = T0.slice(0, 10);
/** The world's rows: Sam holds 4 on machine `one` and 3 on `two`, Tia 2; here `A`'s first member is given 5. */
const SAM_ROWS = 7;
const TIA_ROWS = 2;
const A_ROWS = 5;

let w: ManageWorld;
let b: TeamData;
beforeEach(async () => {
  w = await manageWorld();
  const first = w.A.members[0]!;
  forTeam(w.db, w.A.id, { clock: () => T0 }).upsertUsage({ memberId: first.memberId, machineId: first.one.id }, rows(A_ROWS));
  b = forTeam(w.db, w.B.id);
});

const counted = (teamId: number) => usageCounts(w.db, teamId, TODAY).rows;
const usageRows = (teamId: number) => rowsOf(w.db, teamId).usage.length;
const usageRowsOfMember = (teamId: number, memberId: number) => rowsOf(w.db, teamId).usage.filter((u) => u.member_id === memberId).length;
const sessionMachines = (teamId: number) => everythingOf(w.db, teamId).sessions!.map((s) => (s as { machine_id: string }).machine_id);
const idsOf = (teamId: number) => ({
  members: rowsOf(w.db, teamId).members.map((m) => m.id),
  machines: rowsOf(w.db, teamId).machines.map((m) => m.id),
});

test("a slice removes at most `most` rows, the count follows, and the other team keeps everything", () => {
  const a = everythingOf(w.db, w.A.id);
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(SAM_ROWS);
  const taken = [0, 0, 0, 0].map(() => {
    const n = b.removeUsageSlice({ members: [w.B.sam.memberId], machines: [] }, 3);
    expect(counted(w.B.id)).toBe(usageRows(w.B.id));
    return n;
  });
  expect(taken).toEqual([3, 3, 1, 0]);
  expect(usageRowsOfMember(w.B.id, w.B.tia.memberId)).toBe(TIA_ROWS);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("removing a member takes their machines, their usage and their sign-ins, and nothing of anyone else", async () => {
  const session = createMemberSession(w.db, { teamId: w.B.id, memberId: w.B.sam.memberId, machineId: w.B.sam.two.id });
  const tiaSession = createMemberSession(w.db, { teamId: w.B.id, memberId: w.B.tia.memberId, machineId: w.B.tia.one.id });
  await dashboardLinkToken(w.app, w.B.sam.two.token);
  await dashboardLinkToken(w.app, w.B.tia.one.token);
  const a = everythingOf(w.db, w.A.id);
  expect(b.remove({ members: [w.B.sam.memberId], machines: [] })).toEqual({ members: 1, machines: 2 });
  expect(idsOf(w.B.id)).toEqual({ members: [w.B.tia.memberId], machines: [w.B.tia.one.id] });
  expect(counted(w.B.id)).toBe(TIA_ROWS);
  expect(usageRows(w.B.id)).toBe(TIA_ROWS);
  expect(findSession(w.db, session)).toBeNull();
  expect(findSession(w.db, tiaSession)).not.toBeNull();
  expect(sessionMachines(w.B.id)).toEqual([w.B.tia.one.id, w.B.tia.one.id]); // the world's and this test's
  expect(everythingOf(w.db, w.B.id).dashboard_links).toEqual([expect.objectContaining({ machine_id: w.B.tia.one.id })]);
  expect(everythingOf(w.db, w.A.id)).toEqual(a); // A's machine `one` and its member of Sam's email
});

test("the agreed value", () => expect(REMOVAL_SLICE_ROWS).toBe(5000));

test("a slice of a size that is not a positive whole number is refused and removes nothing", () => {
  const before = everythingOf(w.db, w.B.id);
  for (const most of [-1, 0, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => b.removeUsageSlice({ members: [w.B.sam.memberId], machines: [] }, most), String(most)).toThrow(RangeError);
    expect(() => b.removeAnyUsageSlice(most), String(most)).toThrow(RangeError);
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});

test("a slice over a member and another member's machine removes at most `most` rows in all", () => {
  const what = { members: [w.B.sam.memberId], machines: [w.B.tia.one.id] };
  const taken = [0, 0, 0].map(() => {
    const n = b.removeUsageSlice(what, 8);
    expect(counted(w.B.id)).toBe(usageRows(w.B.id));
    return n;
  });
  expect(taken).toEqual([8, 1, 0]);
  expect(usageRows(w.B.id)).toBe(0);
});

test("a slice over two members removes at most `most` rows in all", () => {
  const taken = [0, 0, 0].map(() => b.removeUsageSlice({ members: [w.B.sam.memberId, w.B.tia.memberId], machines: [] }, 8));
  expect(taken).toEqual([8, 1, 0]);
  expect([usageRows(w.B.id), counted(w.B.id)]).toEqual([0, 0]);
});

test("removing a machine leaves its member with the other machine and that machine's rows", async () => {
  await dashboardLinkToken(w.app, w.B.sam.two.token);
  expect(b.remove({ members: [], machines: [w.B.sam.two.id] })).toEqual({ members: 0, machines: 1 });
  expect(idsOf(w.B.id)).toEqual({ members: [w.B.sam.memberId, w.B.tia.memberId], machines: [w.B.sam.one.id, w.B.tia.one.id] });
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(4);
  expect(counted(w.B.id)).toBe(4 + TIA_ROWS);
  expect(sessionMachines(w.B.id)).toEqual([w.B.sam.one.id, w.B.tia.one.id]); // the world's, signed in from `one`s
  expect(everythingOf(w.db, w.B.id).dashboard_links).toEqual([]);
});

test("ids the team does not have are skipped and count as nothing", () => {
  const [a, before] = [everythingOf(w.db, w.A.id), everythingOf(w.db, w.B.id)];
  const first = w.A.members[0]!;
  const foreign = { members: [first.memberId, first.memberId], machines: [machineIdOf(0xfff), machineIdOf(0xfff)] };
  expect(b.removeUsageSlice(foreign, 10)).toBe(0);
  expect(b.remove(foreign)).toEqual({ members: 0, machines: 0 });
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
  expect(b.remove({ members: [first.memberId], machines: [first.one.id] })).toEqual({ members: 0, machines: 1 });
  expect(idsOf(w.B.id).machines).toEqual([w.B.tia.one.id, w.B.sam.two.id]); // B's `one` has the id of A's first member's machine
  expect(counted(w.B.id)).toBe(3 + TIA_ROWS);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("the same id named twice is removed once", () => {
  const twice = { members: [w.B.sam.memberId, w.B.sam.memberId], machines: [w.B.tia.one.id, w.B.tia.one.id] };
  expect(b.remove(twice)).toEqual({ members: 1, machines: 3 });
  expect(idsOf(w.B.id)).toEqual({ members: [w.B.tia.memberId], machines: [] });
});

test("remove without any slice before it removes every row it names and takes them off the count", () => {
  const a = everythingOf(w.db, w.A.id);
  expect(b.remove({ members: [w.B.sam.memberId], machines: [w.B.tia.one.id] })).toEqual({ members: 1, machines: 3 });
  expect(usageRows(w.B.id)).toBe(0);
  expect(counted(w.B.id)).toBe(0);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("a slice and a removal naming 500 members and 500 machines remove only what the team has", () => {
  const a = everythingOf(w.db, w.A.id);
  const members = [w.B.sam.memberId, ...w.A.members.map((m) => m.memberId), ...Array.from({ length: 494 }, (_, i) => 1000 + i)];
  const machines = [w.B.sam.two.id, ...Array.from({ length: 499 }, (_, i) => machineIdOf(0x1000 + i))];
  expect([members.length, machines.length]).toEqual([500, 500]);
  expect(b.removeUsageSlice({ members, machines }, REMOVAL_SLICE_ROWS)).toBe(SAM_ROWS);
  expect(counted(w.B.id)).toBe(TIA_ROWS);
  expect(b.remove({ members, machines })).toEqual({ members: 1, machines: 2 });
  expect(idsOf(w.B.id)).toEqual({ members: [w.B.tia.memberId], machines: [w.B.tia.one.id] });
  expect([usageRows(w.B.id), counted(w.B.id)]).toEqual([TIA_ROWS, TIA_ROWS]);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("a slice of any rows takes only the team's rows, and the count follows", () => {
  const a = everythingOf(w.db, w.A.id);
  const taken = [0, 0, 0, 0].map(() => {
    const n = b.removeAnyUsageSlice(4);
    expect(counted(w.B.id)).toBe(usageRows(w.B.id));
    return n;
  });
  expect(taken).toEqual([4, 4, 1, 0]);
  expect(idsOf(w.B.id).members).toEqual([w.B.sam.memberId, w.B.tia.memberId]);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("removeMember and removeMachine answer as before, and false for what the team does not have", () => {
  const a = everythingOf(w.db, w.A.id);
  expect(b.removeMember("SAM@example.com ")).toBe(true);
  expect(b.removeMember("sam@example.com")).toBe(false);
  expect(b.removeMachine(w.B.sam.one.id)).toBe(false); // went with Sam; A's machine of that id stays
  expect(b.removeMachine(w.A.members[1]!.one.id)).toBe(false);
  expect(b.removeMachine(w.B.tia.one.id)).toBe(true);
  expect(idsOf(w.B.id)).toEqual({ members: [w.B.tia.memberId], machines: [] });
  expect([usageRows(w.B.id), counted(w.B.id)]).toEqual([0, 0]);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});

test("the statements of a removal find usage by the team, through usage_by_member and the primary key, never by scanning", () => {
  const seen: string[] = [];
  const db = new Database(":memory:", { verbose: (sql) => seen.push(String(sql)) });
  migrate(db);
  hostedTeam(db, PEOPLE.ann, "members");
  const team = forTeam(db, hostedTeam(db, PEOPLE.bob, "members").team.id);
  seen.length = 0;
  team.removeUsageSlice({ members: [6], machines: [machineIdOf(1)] }, REMOVAL_SLICE_ROWS);
  team.removeAnyUsageSlice(REMOVAL_SLICE_ROWS);
  team.remove({ members: [6], machines: [machineIdOf(1)] });
  const ran = [...seen]; // planning a statement runs one more, which verbose also records
  const plan = (sql: string) => (db.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  const onUsage = ran.filter((sql) => /from usage where/.test(sql)).map(plan);
  expect(onUsage).toHaveLength(5);
  for (const p of onUsage) {
    expect(p).toMatch(/SEARCH usage USING .*\(team_id=\?/);
    expect(p).not.toMatch(/SCAN usage/);
  }
  expect(onUsage.filter((p) => p.includes("usage_by_member (team_id=? AND member_id=?)"))).toHaveLength(2);
  const byMachine = onUsage.filter((p) => p.includes("sqlite_autoindex_usage_1 (team_id=? AND machine_id=?)"));
  expect(byMachine).toHaveLength(2);
  for (const p of byMachine) expect(p).toContain("machines_team_member (team_id=? AND member_id=?)");
  for (const p of ran.filter((sql) => /from (machines|members) where/.test(sql)).map(plan)) expect(p).not.toMatch(/SCAN (machines|members)/);
});
