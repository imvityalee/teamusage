import { beforeEach, expect, test } from "vitest";
import { createDashboardLink, DASHBOARD_LINK_SECONDS, dropDashboardLinks, takeDashboardLink } from "./dashboard-links.js";
import { openDb, sha256, type Db } from "./db.js";
import { hostedTeam, machineIdOf } from "./hosted.fixture.js";
import { authenticate, forTeam, type MachineIdentity } from "./team-data.js";
import { reg } from "./team-data.fixture.js";

const T0 = Date.parse("2026-11-20T09:00:00.000Z");

let db: Db;
let teamA: number, teamB: number;
/** A's machine, and B's member sam's two machines; B's ids differ from A's and from its own team id. */
let ann: MachineIdentity, samOne: MachineIdentity, samTwo: MachineIdentity;

const machineOf = (teamId: number, email: string, n: number): MachineIdentity =>
  authenticate(db, forTeam(db, teamId).registerMachine(reg(machineIdOf(n), { email })).token)!;
const linkCount = () => (db.prepare("select count(*) as n from dashboard_links").get() as { n: number }).n;

beforeEach(() => {
  db = openDb(":memory:");
  teamA = hostedTeam(db, { githubId: 1101, login: "ann" }, "members").team.id;
  teamB = hostedTeam(db, { githubId: 2202, login: "bob" }, "members").team.id;
  ann = machineOf(teamA, "ann@example.com", 1);
  machineOf(teamA, "abe@example.com", 2);
  samOne = machineOf(teamB, "sam@example.com", 11);
  samTwo = machineOf(teamB, "sam@example.com", 12);
  expect([teamB, samOne.memberId]).toEqual([2, 3]);
});

test("a link is 64 hex characters, stored only as its hash, and gives its machine once", () => {
  const token = createDashboardLink(db, samOne, T0);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(db.prepare("select * from dashboard_links").all())).not.toContain(token);
  expect(db.prepare("select token_hash from dashboard_links").all()).toEqual([{ token_hash: sha256(token) }]);
  expect(takeDashboardLink(db, token, T0)).toEqual(samOne);
  expect(takeDashboardLink(db, token, T0)).toBeNull();
  expect(linkCount()).toBe(0);
});

test("an unknown token gives nothing and takes nothing", () => {
  createDashboardLink(db, samOne, T0);
  expect(takeDashboardLink(db, "0".repeat(64), T0)).toBeNull();
  expect(linkCount()).toBe(1);
});

test("a link works until 300 seconds have passed", () => {
  expect(DASHBOARD_LINK_SECONDS).toBe(300);
  const [early, late] = [createDashboardLink(db, samOne, T0), createDashboardLink(db, samTwo, T0)];
  expect(takeDashboardLink(db, early, T0 + 299_999)).toEqual(samOne);
  expect(takeDashboardLink(db, late, T0 + 300_000)).toBeNull();
});

test("a machine holds one pending link: a new one replaces it, and another machine's stays", () => {
  const older = createDashboardLink(db, samOne, T0);
  const other = createDashboardLink(db, samTwo, T0);
  const newer = createDashboardLink(db, samOne, T0 + 1000);
  expect(linkCount()).toBe(2);
  expect(takeDashboardLink(db, older, T0 + 1000)).toBeNull();
  expect(takeDashboardLink(db, newer, T0 + 1000)).toEqual(samOne);
  expect(takeDashboardLink(db, other, T0 + 1000)).toEqual(samTwo);
});

test("the replacing link lives its own 300 seconds", () => {
  createDashboardLink(db, samOne, T0);
  const newer = createDashboardLink(db, samOne, T0 + 200_000);
  expect(takeDashboardLink(db, newer, T0 + 400_000)).toEqual(samOne);
});

test("dropping a team's links leaves another team's", () => {
  const a = createDashboardLink(db, ann, T0);
  const [one, two] = [createDashboardLink(db, samOne, T0), createDashboardLink(db, samTwo, T0)];
  dropDashboardLinks(db, teamB);
  expect(takeDashboardLink(db, one, T0)).toBeNull();
  expect(takeDashboardLink(db, two, T0)).toBeNull();
  expect(takeDashboardLink(db, a, T0)).toEqual(ann);
});

test("a link goes with its machine, and with its member", () => {
  const [one, two] = [createDashboardLink(db, samOne, T0), createDashboardLink(db, samTwo, T0)];
  const a = createDashboardLink(db, ann, T0);
  forTeam(db, teamB).removeMachine(samOne.machineId);
  expect(takeDashboardLink(db, one, T0)).toBeNull();
  forTeam(db, teamB).removeMember("sam@example.com");
  expect(takeDashboardLink(db, two, T0)).toBeNull();
  expect(takeDashboardLink(db, a, T0)).toEqual(ann);
});
