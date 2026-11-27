import { beforeEach, expect, test } from "vitest";
import { codeHash } from "./codes.js";
import { openDb } from "./db.js";
import { dashboardLinkToken, KEY } from "./hosted.fixture.js";
import { codeRow, everythingOf, manageWorld, teamRow, type ManageWorld } from "./manage.fixture.js";
import { rotateTeamCode, setDashboardAccess, teamCode } from "./team-settings.js";
import { createTeam } from "./teams.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const rowsWhere = (table: string, where: string, ...values: unknown[]) =>
  w.db.prepare(`select * from ${table} where ${where} order by rowid`).all(...values);
const githubSessions = () => rowsWhere("sessions", "kind = 'user'");

test("setDashboardAccess to admins ends the team's member sessions and drops its links; the other team's rows and GitHub sessions stay", async () => {
  await dashboardLinkToken(w.app, w.A.members[1]!.one.token);
  await dashboardLinkToken(w.app, w.B.tia.one.token);
  const before = { a: everythingOf(w.db, w.A.id), github: githubSessions() };
  expect(before.a.sessions).toHaveLength(1);
  expect(before.a.dashboard_links).toHaveLength(1);
  expect(before.github).toHaveLength(6);
  expect(rowsWhere("sessions", "team_id = ?", w.B.id)).toHaveLength(2);
  expect(rowsWhere("dashboard_links", "team_id = ?", w.B.id)).toHaveLength(1);

  setDashboardAccess(w.db, w.B.id, "admins");

  expect(teamRow(w.db, w.B.id)).toMatchObject({ dashboard_access: "admins" });
  expect(rowsWhere("sessions", "team_id = ?", w.B.id)).toEqual([]);
  expect(rowsWhere("dashboard_links", "team_id = ?", w.B.id)).toEqual([]);
  expect(everythingOf(w.db, w.A.id)).toEqual(before.a);
  expect(githubSessions()).toEqual(before.github);
});

test("setDashboardAccess to members only sets the value: the team's sessions and links stay", async () => {
  await dashboardLinkToken(w.app, w.B.tia.one.token);
  const before = everythingOf(w.db, w.B.id);
  setDashboardAccess(w.db, w.B.id, "members");
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});

test("rotateTeamCode leaves A's row and both teams' sessions as they were", () => {
  const aRows = everythingOf(w.db, w.A.id);
  const bSessions = everythingOf(w.db, w.B.id).sessions;
  const code = rotateTeamCode(w.db, w.B.id, KEY);
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  expect(teamCode(w.db, w.B.id, KEY)).toBe(code);
  expect(codeRow(w.db, w.B.id)).toMatchObject({ code_hash: codeHash(code) });
  expect(everythingOf(w.db, w.A.id)).toEqual(aRows);
  expect(everythingOf(w.db, w.B.id).sessions).toEqual(bSessions);
});
test("teamCode is null for a team without a sealed code", () => {
  const selfHosted = openDb(":memory:");
  expect(teamCode(selfHosted, createTeam(selfHosted, "Solo"), KEY)).toBeNull();
});
