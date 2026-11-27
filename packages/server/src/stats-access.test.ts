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
/** Team A's members see its numbers; team B's numbers are for its admins only. */
let a: TeamInfo, b: TeamInfo;
let machineA: { token: string; who: MachineIdentity }, machineB: { token: string; who: MachineIdentity };

const machineOf = (teamId: number) => {
  const { token } = forTeam(db, teamId).registerMachine(reg("a".repeat(32)));
  return { token, who: authenticate(db, token)! };
};
const userSession = (u: { githubId: number; login: string }): Session => ({ kind: "user", ...u });
const teamSession = (teamId: number): Session => ({ kind: "team", teamId });

/** statsAccess on a hosted server (no code sessions) with no demo team, no token and no session, unless `over` gives one. */
const access = (over: Partial<Parameters<typeof statsAccess>[1]> = {}) =>
  statsAccess(db, { demoTeamId: undefined, token: undefined, who: null, session: null, teamParam: undefined, codeSessions: false, ...over });

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
    expect(access({ token: "bad", session: teamSession(a.id), codeSessions: true })).toEqual(unauthorized);
    expect(access({ token: "bad", session: userSession(ann), teamParam: a.publicId })).toEqual(unauthorized);
  });
  test("of a team whose members see it reads that team, as its member, with the team's numbers", () => {
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
  const unauthorized = { ok: false, status: 401, error: "unauthorized" };
  test("where code sessions are honoured, of a team whose members see it reads that team, with no member, and ignores the query's team", () => {
    const open = { ok: true, teamId: a.id, member: null, teamNumbers: true };
    expect(access({ session: teamSession(a.id), codeSessions: true })).toEqual(open);
    expect(access({ session: teamSession(a.id), teamParam: b.publicId, codeSessions: true })).toEqual(open);
  });
  test("where code sessions are honoured, of an admins-only team is 401", () => {
    expect(access({ session: teamSession(b.id), codeSessions: true })).toEqual(unauthorized);
  });
  test("where code sessions are not honoured is 401, whatever its team and the query's team", () => {
    expect(access({ session: teamSession(a.id) })).toEqual(unauthorized);
    expect(access({ session: teamSession(a.id), teamParam: a.publicId })).toEqual(unauthorized);
    expect(access({ session: teamSession(b.id) })).toEqual(unauthorized);
  });
});

describe("a member's session", () => {
  /** A session of team `teamId`'s member cy. */
  const memberSession = (teamId: number): Session => {
    const { token } = forTeam(db, teamId).registerMachine(reg("c".repeat(32), { email: "cy@example.com" }));
    return { kind: "member", ...authenticate(db, token)! };
  };
  test("of a team whose members see it reads that team as its member, with the team's numbers, and ignores the query's team", () => {
    // A team created after A and B, where cy is the second member: the team's id is not 1 and the member's is no team's.
    const c = hostedTeam(db, { githubId: 5, login: "cat" }, "members").team;
    forTeam(db, c.id).registerMachine(reg("d".repeat(32), { email: "dee@example.com" }));
    const session = memberSession(c.id);
    const reads = { ok: true, teamId: 3, member: { memberId: 4 }, teamNumbers: true };
    expect(c.id).toBe(3);
    expect(access({ session })).toEqual(reads);
    expect(access({ session, teamParam: b.publicId })).toEqual(reads);
    expect(access({ session, codeSessions: true })).toEqual(reads);
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
