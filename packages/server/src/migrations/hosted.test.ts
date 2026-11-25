import { expect, test } from "vitest";
import { openDb, type Db } from "../db.js";
import { migrate, runSteps, STEPS } from "../migrate.js";
import { createTeamSession } from "../sessions.js";
import { createTeam } from "../teams.js";
import { ensureUser } from "../users.js";
import { legacyWithData } from "./legacy.fixture.js";

const count = (db: Db, table: string) => (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

test("a signed-in browser from before the upgrade still opens its team", () => {
  const db = legacyWithData();              // holds one session, id hash S
  runSteps(db, STEPS.slice(0, 3));
  const before = db.prepare("select id, team_id, created_at from sessions").all();
  runSteps(db, STEPS.slice(0, 4));
  expect(db.prepare("select id, team_id, created_at from sessions").all()).toEqual(before);
  expect(db.prepare("select kind, github_id, github_login from sessions").all()).toEqual([{ kind: "team", github_id: null, github_login: null }]);
  expect(db.prepare("select code_hash, code_sealed from teams").all()).toEqual([{ code_hash: null, code_sealed: null }]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("a team has at most one owner", () => {
  const db = openDb(":memory:");
  const team = createTeam(db, "A");
  const [u1, u2] = [ensureUser(db, { githubId: 1, login: "ann" }), ensureUser(db, { githubId: 2, login: "bob" })];
  const role = db.prepare("insert into team_roles (team_id, user_id, role, created_at) values (?, ?, ?, 't')");
  role.run(team, u1.id, "owner");
  expect(() => role.run(team, u2.id, "owner")).toThrow(/UNIQUE constraint failed: team_roles\.team_id$/);
  expect(() => role.run(team, u2.id, "admin")).not.toThrow();
  expect(() => role.run(team, u2.id, "boss")).toThrow(/CHECK constraint failed: role in/);
});
test("a session is a team's or a user's, never both and never neither", () => {
  const db = openDb(":memory:");
  const team = createTeam(db, "A");
  const row = db.prepare("insert into sessions (id, kind, team_id, github_id, github_login, created_at) values (?, ?, ?, ?, ?, 't')");
  const eitherKind = /CHECK constraint failed: \(kind = 'team'/;
  expect(() => row.run("a", "team", team, 1, "ann")).toThrow(eitherKind);
  expect(() => row.run("b", "user", null, null, null)).toThrow(eitherKind);
  expect(() => row.run("c", "user", team, 1, "ann")).toThrow(eitherKind);
  expect(() => row.run("d", "team", team, null, null)).not.toThrow();
  expect(() => row.run("e", "user", null, 1, "ann")).not.toThrow();
});
test("deleting a team removes its roles and its sessions and leaves the user", () => {
  const db = openDb(":memory:");
  const team = createTeam(db, "A");
  const owner = ensureUser(db, { githubId: 1, login: "ann" });
  db.prepare("insert into team_roles (team_id, user_id, role, created_at) values (?, ?, 'owner', 't')").run(team, owner.id);
  createTeamSession(db, team);
  db.prepare("delete from teams").run();
  expect([count(db, "team_roles"), count(db, "sessions"), count(db, "users")]).toEqual([0, 0, 1]);
});
test("two teams cannot share a code hash, and teams without one are not compared", () => {
  const db = openDb(":memory:");
  const [a, b, c, d] = ["A", "B", "C", "D"].map((name) => createTeam(db, name));
  const setCode = db.prepare("update teams set code_hash = ? where id = ?");
  expect(() => setCode.run(null, a)).not.toThrow();
  expect(() => setCode.run(null, b)).not.toThrow();
  setCode.run("h1", c);
  expect(() => setCode.run("h1", d)).toThrow(/UNIQUE constraint failed: teams\.code_hash$/);
});
test("a new database and an upgraded one end with the same hosted schema", () => {
  const schema = (db: Db) =>
    db
      .prepare(
        `select type, name, sql from sqlite_master
         where tbl_name in ('teams', 'users', 'team_roles', 'sessions') order by type, name`,
      )
      .all();
  const upgraded = legacyWithData();
  migrate(upgraded);
  expect(schema(upgraded)).toEqual(schema(openDb(":memory:")));
});
