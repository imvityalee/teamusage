import { beforeEach, expect, test } from "vitest";
import { MAX_TEAM_NAME_CHARS } from "@teamusage/shared";
import { codeHash, openCode } from "./codes.js";
import { openDb, type Db } from "./db.js";
import {
  createHostedTeam,
  deleteTeam,
  hostedTeamCodes,
  MAX_TEAMS_PER_USER,
  membersSeeTeam,
  roleIn,
  TeamLimitError,
  teamById,
  teamByPublicId,
  teamsOf,
} from "./hosted-teams.js";
import { grantRole, KEY, machineIdOf } from "./hosted.fixture.js";
import { everythingOf } from "./manage.fixture.js";
import { forTeam } from "./team-data.js";
import { reg, rows } from "./team-data.fixture.js";
import { createTeam } from "./teams.js";
import { findUser } from "./users.js";

const ann = { githubId: 1, login: "ann" };
const bob = { githubId: 2, login: "bob" };

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const make = (over = {}) =>
  createHostedTeam(db, { name: "Acme", dashboardAccess: "members", owner: ann, codeKey: KEY, maxTeams: 200, ...over });
const count = (table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
const refusal = (act: () => unknown): TeamLimitError => {
  try { act(); } catch (e) { return e as TeamLimitError; }
  throw new Error("expected a refusal");
};

test("a new team has an owner, a code that opens it, and stores the code only hashed and sealed", () => {
  const { team, code } = make();
  expect(team).toMatchObject({ name: "Acme", dashboardAccess: "members" });
  expect(team.publicId).toMatch(/^[a-f0-9]{16}$/);
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  expect(hostedTeamCodes(db)(code)).toBe(team.id);
  expect(roleIn(db, team.id, ann.githubId)).toBe("owner");
  const row = db.prepare("select code_hash, code_sealed from teams where id = ?").get(team.id) as { code_hash: string; code_sealed: string };
  expect(row.code_hash).toBe(codeHash(code));
  expect(openCode(row.code_sealed, KEY)).toBe(code);
  expect(JSON.stringify(db.prepare("select * from teams").all())).not.toContain(code);
});
test("a code opens only its own team", () => {
  const a = make({ name: "A" });
  const b = make({ name: "B", owner: { githubId: 2, login: "bob" } });
  const find = hostedTeamCodes(db);
  expect([find(a.code), find(b.code)]).toEqual([a.team.id, b.team.id]);
  for (const bad of ["", "nope", a.code.toUpperCase(), `${a.code}0`, 42, null, undefined, { code: a.code }]) expect(find(bad)).toBeNull();
});
test("the team of a self-hosted server is not opened by any hosted code", () => {
  createTeam(db, "Team");
  expect(hostedTeamCodes(db)("a".repeat(24))).toBeNull();
});
test("a sixth team for one owner is refused and leaves nothing behind", () => {
  for (let i = 0; i < 5; i++) make({ name: `T${i}` });
  expect(() => make({ name: "T5" })).toThrow(TeamLimitError);
  expect(db.prepare("select count(*) as n from teams").get()).toEqual({ n: 5 });
});
test("a full server refuses a new team and creates no user", () => {
  make({ maxTeams: 1 });
  let caught: unknown;
  try { make({ owner: { githubId: 2, login: "bob" }, maxTeams: 1 }); } catch (e) { caught = e; }
  expect((caught as TeamLimitError).limit).toBe("server");
  expect(findUser(db, 2)).toBeNull();
});
test("roles and teams are seen only by their own user", () => {
  const a = make();
  expect(roleIn(db, a.team.id, 2)).toBeNull();
  expect(teamsOf(db, 2)).toEqual([]);
  expect(teamsOf(db, 1)).toEqual([{ id: a.team.publicId, name: "Acme", role: "owner", dashboardAccess: "members" }]);
  expect(teamByPublicId(db, a.team.publicId)).toEqual(a.team);
  expect(teamByPublicId(db, "0".repeat(16))).toBeNull();
});

test("hostedTeamCodes refuses a 24-character code in upper case or with a non-hex character", () => {
  const { code } = make();
  const find = hostedTeamCodes(db);
  expect(find(code.toUpperCase().replace(/[0-9]/g, "A"))).toBeNull();
  expect(find(`${code.slice(0, 23)}g`)).toBeNull();
  expect(find(` ${code.slice(1)}`)).toBeNull();
});
test("hostedTeamCodes does not query the database for a code that is not 24 lowercase hex characters", () => {
  make();
  const find = hostedTeamCodes(db);
  db.close();
  for (const bad of ["", "A".repeat(24), "a".repeat(23), "a".repeat(25), 42, null, undefined, ["a".repeat(24)]])
    expect(find(bad)).toBeNull();
  expect(() => find("a".repeat(24))).toThrow();
});
test("the server limit counts every team, the self-hosted one included", () => {
  createTeam(db, "Team");
  expect(refusal(() => make({ maxTeams: 1 })).limit).toBe("server");
  expect([count("teams"), count("users"), count("team_roles")]).toEqual([1, 0, 0]);
});
test("a refusal is a TeamLimitError that names its limit and not the owner", () => {
  for (let i = 0; i < MAX_TEAMS_PER_USER; i++) make({ name: `T${i}` });
  const e = refusal(() => make());
  expect(e).toBeInstanceOf(TeamLimitError);
  expect(e.limit).toBe("user");
  expect(e.message).not.toContain("ann");
});
test("a refusal for the user limit leaves no new team, role or user", () => {
  for (let i = 0; i < MAX_TEAMS_PER_USER; i++) make({ name: `T${i}` });
  const before = [count("teams"), count("users"), count("team_roles")];
  expect(refusal(() => make({ owner: { githubId: 1, login: "ann-renamed" } })).limit).toBe("user");
  expect([count("teams"), count("users"), count("team_roles")]).toEqual(before);
  expect(findUser(db, 1)?.login).toBe("ann");
});
test("the per-user limit counts only the teams the user owns, not those they administer", () => {
  for (let i = 0; i < MAX_TEAMS_PER_USER; i++) grantRole(db, make({ name: `B${i}`, owner: bob }).team.id, ann, "admin");
  expect(() => make()).not.toThrow();
});
test("the owner's users row is created with the team", () => {
  const { team } = make();
  expect(findUser(db, ann.githubId)).toMatchObject({ githubId: 1, login: "ann" });
  expect(teamById(db, team.id)).toEqual(team);
  expect(teamById(db, team.id + 1)).toBeNull();
});
test("a team keeps its dashboard access", () => {
  const { team } = make({ dashboardAccess: "admins" });
  expect(team.dashboardAccess).toBe("admins");
  expect(teamByPublicId(db, team.publicId)).toEqual(team);
});
test("membersSeeTeam is true only for a team that exists and whose members see its numbers", () => {
  const open = make({ dashboardAccess: "members" }).team;
  const admins = make({ dashboardAccess: "admins" }).team;
  expect([membersSeeTeam(db, open.id), membersSeeTeam(db, admins.id), membersSeeTeam(db, admins.id + 1)]).toEqual([true, false, false]);
});
test("teamsOf lists the user's teams with each role, by name and then public id", () => {
  const [z, a1, a2] = [make({ name: "Zeta" }), make({ name: "Alpha" }), make({ name: "Alpha" })];
  const bobTeam = make({ name: "Bob's", owner: bob });
  grantRole(db, bobTeam.team.id, ann, "viewer");
  const alphas = [a1, a2].map((t) => t.team.publicId).sort();
  expect(teamsOf(db, ann.githubId).map((t) => [t.name, t.id, t.role])).toEqual([
    ["Alpha", alphas[0], "owner"],
    ["Alpha", alphas[1], "owner"],
    ["Bob's", bobTeam.team.publicId, "viewer"],
    ["Zeta", z.team.publicId, "owner"],
  ]);
  expect(roleIn(db, bobTeam.team.id, ann.githubId)).toBe("viewer");
  expect(roleIn(db, z.team.id, bob.githubId)).toBeNull();
});
test("a team name may be as long as MAX_TEAM_NAME_CHARS", () => {
  expect(MAX_TEAM_NAME_CHARS).toBe(60);
  expect(make({ name: "n".repeat(MAX_TEAM_NAME_CHARS) }).team.name).toHaveLength(MAX_TEAM_NAME_CHARS);
});

test("deleteTeam deletes the team with all it holds and the users left without a role; another team and its people stay", () => {
  // GitHub ids that equal no row id. The deleted team's id (2) is no id of a row the deletion takes (ben's and cyd's
  // users rows, its member); it is eli's users id, so a deletion that took users by the team's id would take eli.
  const amy = { githubId: 1101, login: "amy" };
  const ben = { githubId: 2202, login: "ben" };
  const cyd = { githubId: 3303, login: "cyd" };
  const eli = { githubId: 5505, login: "eli" };
  const other = make({ name: "Other", owner: amy }).team;
  grantRole(db, other.id, eli, "viewer");
  const { team } = make({ name: "Doomed", owner: ben });
  grantRole(db, team.id, cyd, "admin");
  grantRole(db, team.id, amy, "viewer");
  const data = forTeam(db, team.id);
  const { memberId } = data.registerMachine(reg(machineIdOf(0xd1)));
  data.upsertUsage({ memberId, machineId: machineIdOf(0xd1) }, rows(4));
  expect([team.id, findUser(db, eli.githubId)?.id, findUser(db, ben.githubId)?.id, findUser(db, cyd.githubId)?.id, memberId]).toEqual([2, 2, 3, 4, 1]);
  const otherBefore = everythingOf(db, other.id);
  expect(deleteTeam(db, team.id)).toBe(true);
  const { teams, ...held } = everythingOf(db, team.id);
  expect(teams).toEqual([undefined]);
  for (const [table, left] of Object.entries(held)) expect(left, table).toEqual([]);
  expect([findUser(db, ben.githubId), findUser(db, cyd.githubId)]).toEqual([null, null]);
  expect(findUser(db, amy.githubId)).not.toBeNull();                 // she owns the other team
  expect(findUser(db, eli.githubId)).not.toBeNull();                 // a viewer of the other team
  expect(everythingOf(db, other.id)).toEqual(otherBefore);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("deleteTeam is false for an id that does not exist and for a second call", () => {
  const { team } = make();
  expect(deleteTeam(db, team.id + 1)).toBe(false);
  expect(deleteTeam(db, team.id)).toBe(true);
  expect(deleteTeam(db, team.id)).toBe(false);
});
