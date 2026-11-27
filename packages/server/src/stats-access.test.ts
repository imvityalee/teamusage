import { beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import type { Role, TeamInfo } from "./hosted-teams.js";
import { grantRole, hostedTeam } from "./hosted.fixture.js";
import type { Session } from "./sessions.js";
import { statsAccess } from "./stats-access.js";
import { authenticate, forTeam, type MachineIdentity } from "./team-data.js";
import { reg } from "./team-data.fixture.js";
import { createTeam } from "./teams.js";

const ann = { githubId: 1, login: "ann" };
const bob = { githubId: 2, login: "bob" };
const eve: Session = { kind: "user", githubId: 3, login: "eve" };

let db: Db;
/** Team A opens its dashboard with its code; team B only to its admins. */
let a: TeamInfo, b: TeamInfo;
let machineA: { token: string; who: MachineIdentity }, machineB: { token: string; who: MachineIdentity };

const machineOf = (teamId: number) => {
  const { token } = forTeam(db, teamId).registerMachine(reg("a".repeat(32)));
  return { token, who: authenticate(db, token)! };
};
const userSession = (u: { githubId: number; login: string }): Session => ({ kind: "user", ...u });
const teamSession = (teamId: number): Session => ({ kind: "team", teamId });

/** statsAccess with no demo team, no token and no session, unless `over` gives one. */
const access = (over: Partial<Parameters<typeof statsAccess>[1]> = {}) =>
  statsAccess(db, { demoTeamId: undefined, token: undefined, who: null, session: null, teamParam: undefined, ...over });

beforeEach(() => {
  db = openDb(":memory:");
  a = hostedTeam(db, ann, "members").team;
  b = hostedTeam(db, bob, "admins").team;
  machineA = machineOf(a.id);
  machineB = machineOf(b.id);
});

describe("demo mode", () => {
  test("reads the demo team's numbers, whatever is presented", () => {
    const demo = createTeam(db, "Demo");
    const open = { ok: true, teamId: demo, member: null, teamNumbers: true };
    expect(access({ demoTeamId: demo })).toEqual(open);
    expect(access({ demoTeamId: demo, token: "bad" })).toEqual(open);
    expect(access({ demoTeamId: demo, ...machineB, session: userSession(eve), teamParam: b.publicId })).toEqual(open);
  });
});

describe("a presented token", () => {
  test("that is invalid is 401, and no session rescues it", () => {
    const unauthorized = { ok: false, status: 401, error: "unauthorized" };
    expect(access({ token: "bad" })).toEqual(unauthorized);
    expect(access({ token: "bad", session: teamSession(a.id) })).toEqual(unauthorized);
    expect(access({ token: "bad", session: userSession(ann), teamParam: a.publicId })).toEqual(unauthorized);
  });
  test("of a team that opens its dashboard with its code reads that team, as its member, with the team's numbers", () => {
    expect(access(machineA)).toEqual({ ok: true, teamId: a.id, member: machineA.who, teamNumbers: true });
  });
  test("of an admins-only team reads that team as its member, without the team's numbers", () => {
    expect(access(machineB)).toEqual({ ok: true, teamId: b.id, member: machineB.who, teamNumbers: false });
  });
  test("wins over a session of another team and over a team named in the query", () => {
    expect(access({ ...machineA, session: teamSession(b.id) })).toMatchObject({ ok: true, teamId: a.id });
    expect(access({ ...machineA, session: userSession(bob), teamParam: b.publicId })).toMatchObject({ ok: true, teamId: a.id });
  });
});

describe("a team session", () => {
  test("of a team that opens its dashboard with its code reads that team, with no member, and ignores the query's team", () => {
    const open = { ok: true, teamId: a.id, member: null, teamNumbers: true };
    expect(access({ session: teamSession(a.id) })).toEqual(open);
    expect(access({ session: teamSession(a.id), teamParam: b.publicId })).toEqual(open);
  });
  test("of an admins-only team is 401", () => {
    expect(access({ session: teamSession(b.id) })).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
});

describe("a member's session", () => {
  /** A session of team A's second member, whose id (3) is neither team's id. */
  const memberSession = (teamId: number): Session => {
    const { token } = forTeam(db, teamId).registerMachine(reg("c".repeat(32), { email: "cy@example.com" }));
    const who = authenticate(db, token)!;
    return { kind: "member", ...who };
  };
  test("of a team whose members see it reads that team as its member, with the team's numbers, and ignores the query's team", () => {
    const session = memberSession(a.id);
    const reads = { ok: true, teamId: a.id, member: { memberId: 3 }, teamNumbers: true };
    expect(access({ session })).toEqual(reads);
    expect(access({ session, teamParam: b.publicId })).toEqual(reads);
  });
  test("of an admins-only team is 401", () => {
    expect(access({ session: memberSession(b.id) })).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
});

describe("a user session", () => {
  const invalid = { ok: false, status: 400, error: "invalid query" };
  test.each([undefined, "", "0".repeat(15), "0".repeat(17), "A".repeat(16), "g".repeat(16), ` ${"0".repeat(15)}`])(
    "with team %j is 400",
    (teamParam) => {
      expect(access({ session: userSession(ann), teamParam })).toEqual(invalid);
    },
  );
  const reads = (t: TeamInfo) => ({ ok: true, teamId: t.id, member: null, teamNumbers: true });
  test("of the team's owner reads the team's numbers, with no member, whatever the team's dashboard access", () => {
    expect(access({ session: userSession(ann), teamParam: a.publicId })).toEqual(reads(a));
    expect(access({ session: userSession(bob), teamParam: b.publicId })).toEqual(reads(b));
  });
  test.each<Role>(["admin", "viewer"])("of the team's %s reads the team's numbers, whatever its dashboard access", (role) => {
    const cat = { githubId: 4, login: "cat" };
    for (const t of [a, b]) {
      grantRole(db, t.id, cat, role);
      expect(access({ session: userSession(cat), teamParam: t.publicId })).toEqual(reads(t));
    }
  });
  test("with no role in the team gets the answer of a team that does not exist", () => {
    const missing = access({ session: eve, teamParam: "0".repeat(16) });
    expect(missing).toEqual({ ok: false, status: 404, error: "team not found" });
    expect(access({ session: eve, teamParam: a.publicId })).toEqual(missing);
    expect(access({ session: eve, teamParam: b.publicId })).toEqual(missing);
    expect(access({ session: userSession(ann), teamParam: b.publicId })).toEqual(missing);
    expect(access({ session: userSession(bob), teamParam: a.publicId })).toEqual(missing);
  });
});

test("nothing presented is 401", () => {
  expect(access()).toEqual({ ok: false, status: 401, error: "unauthorized" });
  expect(access({ teamParam: a.publicId })).toEqual({ ok: false, status: 401, error: "unauthorized" });
});
