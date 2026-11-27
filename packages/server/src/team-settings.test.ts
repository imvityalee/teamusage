import { beforeEach, expect, test } from "vitest";
import { dashboardLinkToken } from "./hosted.fixture.js";
import { everythingOf, manageWorld, PEOPLE, teamRow, type ManageWorld } from "./manage.fixture.js";
import { findUser } from "./users.js";
import { setDashboardAccess } from "./team-settings.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

const rowsWhere = (table: string, where: string, ...values: unknown[]) =>
  w.db.prepare(`select * from ${table} where ${where} order by rowid`).all(...values);
const githubSessions = () => rowsWhere("sessions", "kind = 'user'");

test("in the world, the ids that could be mistaken for one another differ, and B's id is not 1", () => {
  const userId = (who: "bob" | "cyd" | "dee") => findUser(w.db, PEOPLE[who].githubId)?.id;
  const ids = [w.B.id, w.B.sam.memberId, w.B.tia.memberId, userId("bob"), userId("cyd"), userId("dee"), ...Object.values(PEOPLE).map((p) => p.githubId)];
  expect(ids.every((id) => typeof id === "number")).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(w.B.id).not.toBe(1);
  expect(everythingOf(w.db, w.B.id).usage).toHaveLength(4 + 3 + 2);
});

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
